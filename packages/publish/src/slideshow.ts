import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Book,
  type CropRect,
  findOutput,
  frameKey,
  KEN_BURNS_ZOOM,
  loadBook,
  type Page,
  type PageSize,
  planSlideshowFrames,
  SLIDESHOW_FPS,
  SLIDESHOW_SIZES,
  SLIDESHOW_SOURCE_PICKS,
  type SlideshowMotion,
  type SlideshowOutput,
  type SlideshowSlides,
  slideshowFrameName,
  slideshowSlides,
  slideshowTiming,
} from '@photobook/shared';
import type { Page as BrowserPage } from 'playwright';
import sharp from 'sharp';
import type { PublishConfig } from './config.js';
import { freeze, readLibrary, resolveFolders } from './freeze.js';
import { processAsset } from './images.js';
import { mapLimit } from './limit.js';
import type { Reporter } from './log.js';
import type { ProcessedAsset } from './manifest.js';
import { fitPageWidth, launchChromium, localImage, pageDocumentHtml, waitReady } from './pages.js';
import { workDir } from './paths.js';

/**
 * `photobook render-slideshow` (workflow plan 16): every frame of a slideshow video as a still JPEG, for the editor to
 * encode with FFmpeg (`commands/video.rs`). The frame plan is the shared `planSlideshowFrames` (Ken Burns crops,
 * crossfades, dips); each slide is the shared `<Page>` in the same headless Chromium document the book's page images
 * use (`pageDocumentHtml`), letterboxed to the video size. Ken Burns is a CSS transform of that document per frame (so
 * text and photos are drawn at the zoomed size, never upscaled pixels); a transition frame is its slides' screenshots
 * blended over black here. No video compositor.
 *
 * The frames go to `<project dir>/.photobook-publish/slideshow/<outputId>/000001.jpg …`, cleared first; a frame equal
 * to the one before (a held slide without motion) is a hard link to it. `frames.json` (`SlideshowFramesManifest`) is
 * written last, so its presence means every frame is there. Each file is written to a temp name and renamed.
 */

/** JPEG quality of a frame (an intermediate: FFmpeg re-encodes it). */
export const SLIDESHOW_FRAME_QUALITY = 92;
export const SLIDESHOW_MANIFEST = 'frames.json';
/** Progress is reported every this many frames (and on the last). */
const PROGRESS_EVERY = 10;

/** `frames.json`: what the encoder needs to know about the frames on disk. */
export interface SlideshowFramesManifest {
  version: 1;
  output: string;
  fps: number;
  width: number;
  height: number;
  /** Number of frames, `000001.jpg` to `frames` (zero-padded to six digits). */
  frames: number;
  slides: number;
  /** `frames / fps`. */
  seconds: number;
}

export interface RenderSlideshowOptions {
  projectPath: string;
  /** The slideshow's id in `book.outputs`. */
  outputId: string;
  /** Where the frames go (default `slideshowFramesDir`). */
  outDir?: string;
  config: PublishConfig;
  reporter: Reporter;
}

/** Files `render-slideshow` writes in its folder, and the only ones it clears: frames, the manifest, temp files. */
export function isFramesFolderFile(name: string): boolean {
  return /^\d{6}\.jpg$/.test(name) || name === SLIDESHOW_MANIFEST || /^\..*\.tmp$/.test(name);
}

/**
 * Make `dir` ready for a run: created if missing, and the frames, manifest and temp files of an earlier run removed.
 * Never a recursive delete: a folder holding anything else is refused (an `--out` pointed at the wrong place).
 */
export async function prepareFramesDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const others = entries.filter((e) => !e.isFile() || !isFramesFolderFile(e.name)).map((e) => e.name);
  if (others.length > 0) {
    throw new Error(
      `${dir} holds other files (${others.slice(0, 3).join(', ')}${others.length > 3 ? ', …' : ''}); give --out an empty folder`,
    );
  }
  await Promise.all(entries.map((e) => rm(join(dir, e.name), { force: true })));
}

/**
 * The pixel size a slide's page is drawn at in a `viewport` video: fitted inside it, times the Ken Burns zoom. What
 * `localImage` sizes the photos for, so a 4K or zoomed slide gets the download JPEG rather than the browse WebP.
 */
export function slideFrameSize(template: PageSize, viewport: PageSize, motion: SlideshowMotion): PageSize {
  const width = fitPageWidth(template, viewport);
  const height = (width * template.height) / template.width;
  const zoom = motion === 'ken-burns' ? KEN_BURNS_ZOOM : 1;
  return { width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) };
}

/** `<project dir>/.photobook-publish/slideshow/<outputId>`. */
export function slideshowFramesDir(projectPath: string, outputId: string): string {
  return join(workDir(resolve(projectPath)), 'slideshow', outputId);
}

/** The slideshow output `outputId` of `book`, or an error naming what is wrong. */
export function slideshowOutput(book: Book, outputId: string): SlideshowOutput {
  const output = findOutput(book, outputId);
  if (!output) throw new Error(`The project has no output "${outputId}"`);
  if (output.kind !== 'slideshow') throw new Error(`"${output.name}" is not a slideshow`);
  return output;
}

/**
 * Which assets of `book` are picks: the flag in each folder's library (by the photo's hash), else the legacy flag of
 * the project file. A library that cannot be read counts as no picks for its folder (with a warning).
 */
export async function readPicks(book: Book, projectPath: string, warn: (m: string) => void): Promise<Set<string>> {
  const folders = await resolveFolders(book, resolve(projectPath));
  const libraries = new Map<string, Awaited<ReturnType<typeof readLibrary>>['library']>();
  for (const [id, root] of folders) {
    const read = await readLibrary(root, true);
    if (read.warning) warn(read.warning);
    libraries.set(id, read.library);
  }
  const picks = new Set<string>();
  for (const [id, asset] of Object.entries(book.assets)) {
    const photo = asset.hash ? libraries.get(asset.folder)?.photos[asset.hash.toLowerCase()] : undefined;
    if ((photo?.flag ?? asset.flag) === 'pick') picks.add(id);
  }
  return picks;
}

async function writeAtomic(dir: string, name: string, body: Uint8Array | string): Promise<string> {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  await writeFile(tmp, body);
  const target = join(dir, name);
  await rename(tmp, target);
  return target;
}

/** A frame equal to the one before: a hard link to it (a copy where links are not possible). */
async function linkFrame(dir: string, from: string, name: string): Promise<void> {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  await link(join(dir, from), tmp).catch(() => copyFile(join(dir, from), tmp));
  await rename(tmp, join(dir, name));
}

/** The JS that sets the Ken Burns crop on a slide's document: scale the frame so `crop` fills the viewport. */
export function cropScript(crop: CropRect): string {
  const scale = 1 / crop.w;
  return `(() => {
    const el = document.querySelector('.pb-frame');
    el.style.transformOrigin = '0 0';
    el.style.transform = 'scale(${scale}) translate(${-crop.x * 100}vw, ${-crop.y * 100}vh)';
  })()`;
}

/** Blend `layer` (RGB bytes) into `acc` at `opacity`: `acc = acc × (1 − opacity) + layer × opacity`. */
export function blendInto(acc: Uint8Array, layer: Uint8Array, opacity: number): void {
  if (opacity >= 1) {
    acc.set(layer);
    return;
  }
  const a = Math.max(0, opacity);
  for (let i = 0; i < acc.length; i++) {
    const base = acc[i] as number;
    acc[i] = Math.round(base + ((layer[i] as number) - base) * a);
  }
}

export interface RenderSlideshowResult {
  dir: string;
  manifest: SlideshowFramesManifest;
  /** Frames rendered (the rest are links to an equal frame). */
  rendered: number;
}

export async function renderSlideshow(options: RenderSlideshowOptions): Promise<RenderSlideshowResult> {
  const { projectPath, outputId, reporter, config } = options;
  const book0 = loadBook(JSON.parse(await readFile(resolve(projectPath), 'utf8')));
  const settings = slideshowOutput(book0, outputId);
  const picks =
    settings.source === SLIDESHOW_SOURCE_PICKS
      ? await readPicks(book0, projectPath, (m) => reporter.warn(m))
      : new Set<string>();
  const isPick = (id: string) => picks.has(id);
  const first = slideshowSlides(book0, settings, { isPick });
  if (first.pages.length === 0) {
    throw new Error(
      settings.source === SLIDESHOW_SOURCE_PICKS
        ? `"${settings.name}" shows the picks, and no photo of the project is picked`
        : `"${settings.name}" has no slides`,
    );
  }

  const frozen = await reporter.step(
    'freeze',
    () => freeze(projectPath, { pages: () => first.pages }),
    (f) => `${f.assets.size} photos used`,
  );
  for (const warning of frozen.warnings) reporter.warn(warning);

  // Photos: the publish image cache (`.photobook-publish/out/`), shared with the book and its posts.
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

  // The slides again from the frozen book (its develop resolved), a pick laid out at its processed photo's aspect.
  const { book } = frozen;
  const slides: SlideshowSlides = slideshowSlides(book, settings, {
    isPick,
    aspectOf: (id) => {
      const p = processed.get(id);
      if (!p) return null;
      const img = localImage(p, frozen.projectPath);
      return img.width / img.height;
    },
  });
  const size = SLIDESHOW_SIZES[settings.size];
  const plan = planSlideshowFrames({
    slides: slides.pages.length,
    secondsPerSlide: settings.secondsPerSlide,
    transition: settings.transition,
    motion: settings.motion,
  });
  const timing = slideshowTiming({
    slides: slides.pages.length,
    secondsPerSlide: settings.secondsPerSlide,
    transition: settings.transition,
  });

  const dir = options.outDir ? resolve(options.outDir) : slideshowFramesDir(frozen.projectPath, outputId);
  await prepareFramesDir(dir);
  const renderDir = join(workDir(frozen.projectPath), 'render');
  await mkdir(renderDir, { recursive: true });

  const launched = await launchChromium();
  if ('error' in launched) throw new Error(launched.error);
  const { browser } = launched;
  const viewport = { width: size.width, height: size.height };
  let rendered = 0;
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    // At most two slides are live at once (a transition's old and new), each in its own tab.
    const tabs: Array<{ tab: BrowserPage; slide: number }> = [];
    const tabFor = async (slide: number): Promise<BrowserPage> => {
      const live = tabs.find((t) => t.slide === slide);
      if (live) return live.tab;
      let entry = tabs.length < 2 ? undefined : tabs.reduce((a, b) => (a.slide < b.slide ? a : b));
      if (!entry) {
        entry = { tab: await context.newPage(), slide: -1 };
        tabs.push(entry);
      }
      const page = slides.pages[slide] as Page;
      const html = await pageDocumentHtml(
        book,
        page,
        processed,
        frozen.projectPath,
        slides.template,
        { frame: fitPageWidth(slides.template, viewport) },
        'frame',
        // Photos at the size the page is shown, Ken Burns zoom included: 4K takes the download JPEG, not the WebP.
        { forFrame: true, frameSize: slideFrameSize(slides.template, viewport, settings.motion) },
      );
      // Chromium blocks file:// subresources on about:blank (setContent), so the document is loaded as a file.
      const htmlPath = join(renderDir, `slide-${outputId}-${slide}-${process.pid}.html`);
      await writeFile(htmlPath, html);
      try {
        await entry.tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
        await waitReady(entry.tab, `slide ${slide + 1}`);
      } finally {
        await rm(htmlPath, { force: true });
      }
      entry.slide = slide;
      return entry.tab;
    };
    const shoot = async (slide: number, crop: CropRect, type: 'jpeg' | 'png'): Promise<Buffer> => {
      const tab = await tabFor(slide);
      await tab.evaluate(cropScript(crop));
      return tab.screenshot({
        type,
        ...(type === 'jpeg' ? { quality: SLIDESHOW_FRAME_QUALITY } : {}),
        animations: 'disabled',
        caret: 'hide',
      });
    };

    await reporter.step(
      'slideshow',
      async () => {
        let previous = null as { key: string; name: string } | null;
        for (let f = 0; f < plan.length; f++) {
          const frame = plan[f] as (typeof plan)[number];
          const name = slideshowFrameName(f);
          const key = frameKey(frame);
          if (previous?.key === key) {
            await linkFrame(dir, previous.name, name);
          } else {
            const [only] = frame.layers;
            if (frame.layers.length === 1 && only && only.opacity >= 1) {
              await writeAtomic(dir, name, await shoot(only.slide, only.crop, 'jpeg'));
            } else {
              const acc = new Uint8Array(size.width * size.height * 3);
              for (const layer of frame.layers) {
                if (layer.opacity <= 0) continue;
                const png = await shoot(layer.slide, layer.crop, 'png');
                const raw = await sharp(png).removeAlpha().raw().toBuffer();
                blendInto(acc, raw, layer.opacity);
              }
              const jpeg = await sharp(acc, { raw: { width: size.width, height: size.height, channels: 3 } })
                .jpeg({ quality: SLIDESHOW_FRAME_QUALITY })
                .toBuffer();
              await writeAtomic(dir, name, jpeg);
            }
            rendered += 1;
          }
          previous = { key, name };
          if ((f + 1) % PROGRESS_EVERY === 0 || f === plan.length - 1) {
            reporter.emit({ type: 'progress', step: 'slideshow', done: f + 1, total: plan.length, detail: name });
          }
        }
      },
      () => `${plan.length} frames (${rendered} drawn) at ${size.width}x${size.height}, ${SLIDESHOW_FPS} fps`,
    );
  } finally {
    await browser.close();
  }

  const manifest: SlideshowFramesManifest = {
    version: 1,
    output: outputId,
    fps: timing.fps,
    width: size.width,
    height: size.height,
    frames: plan.length,
    slides: slides.pages.length,
    seconds: timing.seconds,
  };
  await writeAtomic(dir, SLIDESHOW_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, rendered };
}
