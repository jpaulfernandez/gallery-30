import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Book,
  CAPTION_FILE,
  findOutput,
  frameFileName,
  loadBook,
  pagesOf,
  type SocialFormat,
  type SocialOutput,
  socialTemplate,
  templateOf,
} from '@photobook/shared';
import type { Page as BrowserPage } from 'playwright';
import sharp from 'sharp';
import type { PublishConfig } from './config.js';
import { freeze } from './freeze.js';
import { processAsset } from './images.js';
import { mapLimit } from './limit.js';
import type { Reporter } from './log.js';
import type { ProcessedAsset } from './manifest.js';
import { launchChromium, pageDocumentHtml, waitReady } from './pages.js';
import { workDir } from './paths.js';

/**
 * `photobook render-frames` (workflow plan 14): a social post's frames rendered headless with the shared `<Page>` at
 * the network's pixel size, exactly as the publish step renders a book page (`pages.ts`: same document, same photo
 * files, same Chromium screenshot), then encoded to `<out>/01.jpg … NN.jpg` (or PNG), plus `<out>/caption.txt`.
 *
 * The editor runs it in three kinds of jobs: `--prepare` once (resolve and process the post's photos into the shared
 * `.photobook-publish/out/` cache, so frame jobs running side by side only read it), one `--frames N` per frame, and
 * `--caption` for the caption file. Without `--frames` every frame is rendered. Every file is written to a temp name and
 * renamed, so a killed run leaves no partial frame.
 */

/** JPEG quality of an exported frame (networks recompress; this keeps text and edges clean). */
export const FRAME_JPEG_QUALITY = 92;

export interface RenderFramesOptions {
  projectPath: string;
  /** The social post's id in `book.outputs`. */
  outputId: string;
  /** Folder the files go to (created when missing). */
  outDir?: string;
  /** 1-based frame numbers to render; undefined renders every frame, an empty list none. */
  frames?: number[];
  format?: SocialFormat;
  quality?: number;
  /** Also write `caption.txt`. */
  caption?: boolean;
  /** Only resolve and process the photos (no Chromium, no files in `outDir`). */
  prepare?: boolean;
  /** Remove earlier frames this run does not write and stale temp files first (`cleanPostFolder`). */
  clean?: boolean;
  config: PublishConfig;
  reporter: Reporter;
}

export interface RenderFramesResult {
  /** The frame files written, in order. */
  files: string[];
  /** The caption file, when written. */
  caption?: string;
}

/** The social output `outputId` of `book`, or an error naming what is wrong. */
export function socialOutput(book: Book, outputId: string): SocialOutput {
  const output = findOutput(book, outputId);
  if (!output) throw new Error(`The project has no output "${outputId}"`);
  if (output.kind !== 'social') throw new Error(`"${output.name}" is not a social post`);
  return output;
}

/** Parse `--frames 1,3,5` (1-based); throws on anything else. */
export function parseFrameList(text: string): number[] {
  if (text.trim() === '') return [];
  return text.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1) throw new Error(`--frames takes frame numbers from 1, got "${part}"`);
    return n;
  });
}

async function writeAtomic(dir: string, name: string, body: Uint8Array | string): Promise<string> {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  await writeFile(tmp, body);
  const target = join(dir, name);
  await rename(tmp, target);
  return target;
}

/** The caption file's text: the caption with a final newline (an empty caption is an empty file). */
export const captionText = (caption: string): string => (caption && !caption.endsWith('\n') ? `${caption}\n` : caption);

/** Encode a viewport screenshot (PNG) as the frame file: sRGB-tagged JPEG, or the PNG as it is. */
export async function encodeFrame(png: Buffer, format: SocialFormat, quality = FRAME_JPEG_QUALITY): Promise<Buffer> {
  if (format === 'png') return png;
  return sharp(png).withIccProfile('srgb').jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
}

/** Lowest JPEG quality `encodeFrameWithin` goes to before giving up on a size limit. */
export const FRAME_MIN_QUALITY = 60;

/**
 * `encodeFrame`, kept under `maxBytes` when given (a network's file limit, `SocialTemplate.maxBytes`): a JPEG is
 * re-encoded at lower quality in steps of 6 down to `FRAME_MIN_QUALITY`. Says the quality used and whether it is still
 * over (a PNG is never re-encoded).
 */
export async function encodeFrameWithin(
  png: Buffer,
  format: SocialFormat,
  quality = FRAME_JPEG_QUALITY,
  maxBytes?: number,
): Promise<{ body: Buffer; quality: number; over: boolean }> {
  let q = quality;
  let body = await encodeFrame(png, format, q);
  if (maxBytes === undefined || format === 'png')
    return { body, quality: q, over: maxBytes !== undefined && body.length > maxBytes };
  while (body.length > maxBytes && q > FRAME_MIN_QUALITY) {
    q = Math.max(FRAME_MIN_QUALITY, q - 6);
    body = await encodeFrame(png, format, q);
  }
  return { body, quality: q, over: body.length > maxBytes };
}

/** A frame file name (`01.jpg`, `12.png`, …) as `render-frames` writes them. */
const FRAME_FILE = /^\d{2,}\.(jpg|png)$/;

/**
 * `--clean`: before a post is written again, remove what an earlier export left in its folder and this one will not
 * write: frame files beyond the new count or in the other format, and temp files of a killed run (`.*.tmp`). Other
 * files are left alone. Returns the names removed.
 */
export async function cleanPostFolder(dir: string, keep: ReadonlySet<string>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const stale = (FRAME_FILE.test(name) && !keep.has(name)) || (name.startsWith('.') && name.endsWith('.tmp'));
    if (!stale) continue;
    await rm(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed.sort();
}

export async function renderFrames(options: RenderFramesOptions): Promise<RenderFramesResult> {
  const { projectPath, outputId, reporter, config } = options;
  const format = options.format ?? 'jpeg';
  const outDir = options.outDir ? resolve(options.outDir) : undefined;
  const result: RenderFramesResult = { files: [] };

  if (options.caption) {
    if (!outDir) throw new Error('--caption needs --out');
    const book = loadBook(JSON.parse(await readFile(resolve(projectPath), 'utf8')));
    const output = socialOutput(book, outputId);
    await mkdir(outDir, { recursive: true });
    result.caption = await reporter.step(
      'caption',
      () => writeAtomic(outDir, CAPTION_FILE, captionText(output.caption)),
      () => `${CAPTION_FILE}, ${output.caption.length} characters`,
    );
  }
  if (options.frames?.length === 0 && !options.prepare) return result;

  const frozen = await reporter.step(
    'freeze',
    () => freeze(projectPath, { pages: (book) => pagesOf(book, outputId) }),
    (f) => `${f.assets.size} photos used`,
  );
  for (const warning of frozen.warnings) reporter.warn(warning);
  const { book } = frozen;
  const output = socialOutput(book, outputId);
  const template = templateOf(book, outputId);
  const all = pagesOf(book, outputId);
  const wanted = options.frames ?? all.map((_, i) => i + 1);
  for (const n of wanted) {
    if (n > all.length) throw new Error(`"${output.name}" has ${all.length} frame(s); there is no frame ${n}`);
  }

  // Photos: the publish image cache (`.photobook-publish/out/`), so a published book and its posts share it.
  const imageOptions = { downloadMaxEdge: config.download.maxEdge, downloadQuality: config.download.quality };
  const assets = [...frozen.assets.values()];
  const processed = new Map<string, ProcessedAsset>();
  await reporter.step(
    'images',
    async () => {
      let done = 0;
      await mapLimit(assets, config.concurrency ?? Math.max(1, cpus().length - 1), async (asset) => {
        const { meta, cached } = await processAsset(asset, frozen.projectPath, imageOptions);
        processed.set(asset.id, { asset, meta });
        done += 1;
        reporter.emit({
          type: 'progress',
          step: 'images',
          done,
          total: assets.length,
          detail: `${asset.relPath}${cached ? ' cached' : ''}`,
        });
      });
    },
    () => `${assets.length} photos`,
  );
  if (options.prepare) return result;
  if (!outDir) throw new Error('render-frames needs --out');

  const launched = await launchChromium();
  if ('error' in launched) throw new Error(launched.error);
  const { browser } = launched;
  const renderDir = join(workDir(frozen.projectPath), 'render');
  await mkdir(renderDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  if (options.clean) {
    const keep = new Set(all.map((_, i) => frameFileName(i, format)));
    if (options.caption) keep.add(CAPTION_FILE);
    const removed = await cleanPostFolder(outDir, keep);
    if (removed.length) reporter.info(`Removed ${removed.length} earlier file(s): ${removed.join(', ')}`);
  }
  const maxBytes = socialTemplate(output.network).maxBytes;
  const viewport = { width: template.width, height: template.height };
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const tab: BrowserPage = await context.newPage();
    await reporter.step(
      'frames',
      async () => {
        let done = 0;
        for (const n of wanted) {
          const page = all[n - 1] as Book['pages'][number];
          const name = frameFileName(n - 1, format);
          const html = await pageDocumentHtml(
            book,
            page,
            processed,
            frozen.projectPath,
            template,
            { frame: template.width },
            'frame',
            { forFrame: true },
          );
          // Chromium blocks file:// subresources on about:blank (setContent), so the document is loaded as a file.
          const htmlPath = join(renderDir, `frame-${page.id}-${process.pid}.html`);
          await writeFile(htmlPath, html);
          try {
            await tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
            await waitReady(tab, `frame ${n}`);
            const png = await tab.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
            const encoded = await encodeFrameWithin(png, format, options.quality, maxBytes);
            if (encoded.over) {
              reporter.warn(
                `${name} is ${Math.round(encoded.body.length / 1000)} kB, over the network's limit of ${Math.round((maxBytes ?? 0) / 1000)} kB`,
              );
            } else if (encoded.quality !== (options.quality ?? FRAME_JPEG_QUALITY)) {
              reporter.info(
                `${name} saved at JPEG quality ${encoded.quality} to stay under the network's file size limit`,
              );
            }
            result.files.push(await writeAtomic(outDir, name, encoded.body));
          } finally {
            await rm(htmlPath, { force: true });
          }
          done += 1;
          reporter.emit({ type: 'progress', step: 'frames', done, total: wanted.length, detail: name });
        }
      },
      () => `${wanted.length} frame(s) at ${template.width}x${template.height}`,
    );
  } finally {
    await browser.close();
  }
  return result;
}
