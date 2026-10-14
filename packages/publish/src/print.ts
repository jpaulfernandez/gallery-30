import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Book,
  coverSize,
  cropMarks,
  findOutput,
  imposePages,
  MARK_STROKE_PT,
  mmToPx,
  type PageProps,
  Page as PageView,
  type PlacedPage,
  type PrintBox,
  type PrintOutput,
  type PrintSettings,
  type PrintSheet,
  pagesOf,
  printContentBox,
  type ResolveImage,
  sheetSize,
  templateOf,
} from '@photobook/shared';
import type { Page as BrowserPage } from 'playwright';
import sharp from 'sharp';
import type { PublishConfig } from './config.js';
import { type FrozenAsset, freeze, outName } from './freeze.js';
import { decodableSource, processAsset } from './images.js';
import { mapLimit } from './limit.js';
import type { Reporter } from './log.js';
import type { ProcessedAsset } from './manifest.js';
import { launchChromium, letterboxColor, localImage, rendererCss, waitReady } from './pages.js';
import { workDir } from './paths.js';

/**
 * `photobook print` (workflow plan 15): a print output as a print-ready PDF through the same headless Chromium and
 * shared `<Page>` as the book's page images (`pages.ts`), printed with `page.pdf` at the sheet size (`sheetSize`: the
 * trim plus the bleed, plus a slug for the crop marks when they are on), one sheet per PDF page.
 *
 * - Imposition (`imposePages`): one page per sheet, or reader spreads (the first page alone on the right).
 * - Bleed: under each page lies a copy of it stretched over its bleed box, so whatever touches a trim edge (a
 *   full-bleed photo, a background colour) runs on past the cut; the page itself is drawn untouched on top, so the
 *   trim area is exactly the web render. The spine side of a spread page does not bleed. A page whose ratio is not the
 *   paper's is centred in its trim on its own background colour instead (no stretched copy).
 * - Marks: crop marks (and fold marks on spreads) as SVG lines in the slug, outside the bleed.
 * - Photos: from the full-resolution sources the publish step uses (the developed render for an edited photo or a
 *   RAW; `freeze` stops when one is missing), resized to what the largest use of each photo needs at the print's dpi
 *   (never enlarged), as sRGB JPEGs in `.photobook-publish/print/`. CMYK is out of scope.
 *
 * `--png` writes proof images (one PNG per sheet at the print's dpi) instead of the PDF; the tests use it to compare a
 * page with `pages.ts`.
 */

/** JPEG quality of the print-size photos embedded in the PDF. */
export const PRINT_JPEG_QUALITY = 92;
/** Print-size photos are rounded up to a multiple of this many pixels, so small edits reuse the cached file. */
const EDGE_STEP = 128;
/** CSS pixels per millimetre: Chromium lays out a printed page at 96 px per inch. */
const CSS_DPI = 96;

export interface PrintOptions {
  projectPath: string;
  /** The print output's id in `book.outputs`. */
  outputId: string;
  /** The PDF file to write; with `png`, the folder the sheet PNGs go to. */
  out: string;
  /** Write one PNG per sheet (proofs) instead of the PDF. */
  png?: boolean;
  /** Overrides the print's dpi (photo size, and the PNG size with `png`). */
  dpi?: number;
  /**
   * Draw the photos from the publish image cache (the web ladder `pages.ts` uses) instead of print-size files. Only
   * for comparing a page with its web render.
   */
  webImages?: boolean;
  config: PublishConfig;
  reporter: Reporter;
}

export interface PrintResult {
  /** The PDF written, or the PNGs in sheet order. */
  files: string[];
  sheets: number;
  /** One sheet's size in millimetres. */
  sheet: { w: number; h: number };
  /** Where each page went, in px of the PNGs (or CSS px of the PDF): the sheet index and the page's box. */
  placements: Array<{ page: number; sheet: number; box: PrintBox }>;
}

/** The print output `outputId` of `book`, or an error naming what is wrong. */
export function printOutput(book: Book, outputId: string): PrintOutput {
  const output = findOutput(book, outputId);
  if (!output) throw new Error(`The project has no output "${outputId}"`);
  if (output.kind !== 'print') throw new Error(`"${output.name}" is not a print`);
  return output;
}

/** A box in px: millimetres scaled, and with `snap` rounded to whole pixels edge by edge (proof PNGs). */
function toPx(box: PrintBox, scale: number, snap: boolean): PrintBox {
  if (!snap) return { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale };
  const x = Math.round(box.x * scale);
  const y = Math.round(box.y * scale);
  return { x, y, w: Math.round((box.x + box.w) * scale) - x, h: Math.round((box.y + box.h) * scale) - y };
}

/** One page laid out on its sheet, in millimetres. */
export interface PageLayout {
  placed: PlacedPage;
  /** Where the page itself is drawn (its trim, or centred in it when the ratios differ). */
  content: PrintBox & { fills: boolean };
  /** The trim grown by the bleed on the page's outside edges: its background, and its stretched copy. */
  bleed: PrintBox;
}

/** The layout of each page on a sheet (pure; `print/print.ts` has the sheet maths). */
export function layoutSheet(
  sheet: PrintSheet,
  settings: Pick<PrintSettings, 'bleedMm'>,
  template: Book['template'],
): PageLayout[] {
  const b = settings.bleedMm;
  return sheet.pages.map((placed) => {
    const { trim, bleeds } = placed;
    const left = bleeds.left ? b : 0;
    const top = bleeds.top ? b : 0;
    const bleed = {
      x: trim.x - left,
      y: trim.y - top,
      w: trim.w + left + (bleeds.right ? b : 0),
      h: trim.h + top + (bleeds.bottom ? b : 0),
    };
    return { placed, content: printContentBox(trim, template), bleed };
  });
}

const require = createRequire(import.meta.url);

function reactServer(): {
  createElement: (type: unknown, props: unknown) => unknown;
  renderToStaticMarkup: (element: unknown) => string;
} {
  const { createElement } = require('react') as { createElement: (type: unknown, props: unknown) => unknown };
  const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
  return { createElement, renderToStaticMarkup };
}

const css = (box: PrintBox) => `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px`;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * The print document: one `.sheet` per sheet (in CSS px, `scale` px per millimetre), each with the pages' bleed
 * backgrounds and stretched copies, the pages on top, and the marks. `snap` rounds every box to whole pixels.
 */
export async function printDocumentHtml(options: {
  book: Book;
  pages: Book['pages'];
  template: Book['template'];
  settings: PrintSettings;
  sheets: PrintSheet[];
  resolve: ResolveImage;
  scale: number;
  snap: boolean;
  title: string;
}): Promise<{ html: string; placements: PrintResult['placements']; size: { w: number; h: number } }> {
  const { book, pages, template, settings, sheets, resolve, scale, snap } = options;
  const { createElement, renderToStaticMarkup } = reactServer();
  const sizeMm = sheetSize(settings);
  const size = snap
    ? { w: Math.round(sizeMm.w * scale), h: Math.round(sizeMm.h * scale) }
    : { w: sizeMm.w * scale, h: sizeMm.h * scale };
  const placements: PrintResult['placements'] = [];

  const pageMarkup = (page: Book['pages'][number], box: PrintBox, fills: boolean) => {
    const props: PageProps = {
      page,
      template,
      theme: book.theme,
      resolve,
      pageWidthPx: Math.round(box.w),
      // A page that fills its trim takes the trim's exact height (ratios within 1%); else its own aspect ratio.
      style: fills ? { width: `${box.w}px`, height: `${box.h}px` } : { width: `${box.w}px` },
    };
    return renderToStaticMarkup(createElement(PageView, props));
  };

  const markLines = cropMarks(settings);
  const stroke = snap ? Math.max(1, Math.round((MARK_STROKE_PT / 72) * 25.4 * scale)) : (MARK_STROKE_PT / 72) * CSS_DPI;

  const body = sheets.map((sheet, s) => {
    const layouts = layoutSheet(sheet, settings, template);
    const layers: string[] = [];
    // Backgrounds, then the stretched copies, then the pages: a page always covers its neighbour's copy at the spine.
    for (const l of layouts) {
      const page = pages[l.placed.page];
      if (!page) continue;
      const bleed = toPx(l.bleed, scale, snap);
      layers.push(`<div class="pb-print-bg" style="${css(bleed)};background:${letterboxColor(book, page)}"></div>`);
    }
    for (const l of layouts) {
      const page = pages[l.placed.page];
      if (!page || !l.content.fills) continue;
      const content = toPx(l.content, scale, snap);
      const bleed = toPx(l.bleed, scale, snap);
      if (bleed.w === content.w && bleed.h === content.h) continue;
      const sx = bleed.w / content.w;
      const sy = bleed.h / content.h;
      layers.push(
        `<div class="pb-print-copy" aria-hidden="true" style="${css(bleed)}"><div style="width:${content.w}px;transform:scale(${sx},${sy});transform-origin:0 0">${pageMarkup(page, content, true)}</div></div>`,
      );
    }
    for (const l of layouts) {
      const page = pages[l.placed.page];
      if (!page) continue;
      const content = toPx(l.content, scale, snap);
      placements.push({ page: l.placed.page, sheet: s, box: content });
      layers.push(
        `<div class="pb-print-page" style="${css(content)}">${pageMarkup(page, content, l.content.fills)}</div>`,
      );
    }
    if (markLines.length) {
      const lines = markLines
        .map((m) => {
          const p = (v: number) => (snap ? Math.round(v * scale) + 0.5 : v * scale);
          return `<line x1="${p(m.x1)}" y1="${p(m.y1)}" x2="${p(m.x2)}" y2="${p(m.y2)}"/>`;
        })
        .join('');
      layers.push(
        `<svg class="pb-print-marks" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}" stroke="#000" stroke-width="${stroke}" fill="none" shape-rendering="crispEdges">${lines}</svg>`,
      );
    }
    return `<div class="pb-sheet">${layers.join('')}</div>`;
  });

  const harness = [
    `@page{size:${size.w}px ${size.h}px;margin:0}`,
    'html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    `.pb-sheet{position:relative;overflow:hidden;width:${size.w}px;height:${size.h}px;background:#fff;break-after:page}`,
    '.pb-sheet:last-child{break-after:auto}',
    '.pb-print-bg,.pb-print-copy,.pb-print-page{position:absolute;overflow:hidden}',
    '.pb-print-page>.pb-page{flex:none}',
    '.pb-print-marks{position:absolute;left:0;top:0}',
  ].join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title><style>${await rendererCss()}\n${harness}</style></head><body>${body.join('')}</body></html>`;
  return { html, placements, size };
}

/**
 * The longest edge, in pixels, each photo needs at `dpi`: over every use on the printed pages, the photo's displayed
 * size (its cover size in the slot, times the crop's zoom) in inches, times `dpi`.
 */
export function neededEdges(
  pages: Book['pages'],
  content: { w: number; h: number },
  dpi: number,
  aspectOf: (assetId: string) => number | undefined,
): Map<string, number> {
  const needed = new Map<string, number>();
  const use = (assetId: string, frame: { w: number; h: number }, scale: number, rotate: number) => {
    const slotW = frame.w * content.w;
    const slotH = frame.h * content.h;
    if (slotW <= 0 || slotH <= 0) return;
    const cover = coverSize(aspectOf(assetId), slotW / slotH, rotate);
    const longMm = Math.max(cover.w * slotW, cover.h * slotH) * scale;
    const px = Math.ceil(mmToPx(longMm, dpi));
    needed.set(assetId, Math.max(needed.get(assetId) ?? 0, px));
  };
  for (const page of pages) {
    if (typeof page.background === 'object') use(page.background.asset, { w: 1, h: 1 }, 1, 0);
    for (const el of page.elements) {
      if (el.type === 'photo' && el.asset) use(el.asset, el.frame, el.crop.scale, el.rotate);
    }
  }
  return needed;
}

/** A print-size, sRGB JPEG of `asset` whose long edge is `edge` (never larger than the source), cached by name. */
async function printImage(
  asset: FrozenAsset,
  projectPath: string,
  edge: number,
): Promise<{ path: string; width: number; height: number; cached: boolean }> {
  const dir = join(workDir(projectPath), 'print');
  const path = join(dir, `${outName(asset)}-${edge}.jpg`);
  try {
    await stat(path);
    const meta = await sharp(path).metadata();
    if (meta.width && meta.height) {
      // Mark it used now: `prunePrintCache` keeps the most recently used files of each photo.
      const now = new Date();
      await utimes(path, now, now);
      return { path, width: meta.width, height: meta.height, cached: true };
    }
  } catch {
    // write it below
  }
  await mkdir(dir, { recursive: true });
  const source = await decodableSource(asset, projectPath);
  const tmp = `${path}.${process.pid}.tmp`;
  const info = await sharp(source, { failOn: 'none', limitInputPixels: false })
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .withIccProfile('srgb')
    .jpeg({ quality: PRINT_JPEG_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(tmp);
  await rename(tmp, path);
  return { path, width: info.width, height: info.height, cached: false };
}

/** Print-size files kept per photo (content hash) in `.photobook-publish/print/`, like the develop cache's three. */
export const PRINT_CACHE_KEEP = 3;

/**
 * Prune the print-size photo cache of the photos in `hashes` (content hashes): per photo, the files this run used
 * (`used`) and the most recently used others up to `PRINT_CACHE_KEEP` stay; older edits and sizes go. Returns the
 * names removed.
 */
export async function prunePrintCache(
  projectPath: string,
  hashes: Iterable<string>,
  used: Set<string>,
): Promise<string[]> {
  const dir = join(workDir(projectPath), 'print');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const hash of new Set(hashes)) {
    const mine = names.filter((n) => n.startsWith(`${hash}-`) && n.endsWith('.jpg'));
    const dated = await Promise.all(
      mine.map(async (name) => ({ name, mtime: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    dated.sort((a, b) => b.mtime - a.mtime);
    let kept = dated.filter((d) => used.has(d.name)).length;
    for (const { name } of dated) {
      if (used.has(name)) continue;
      if (kept < PRINT_CACHE_KEEP) {
        kept += 1;
        continue;
      }
      await rm(join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export async function renderPrint(options: PrintOptions): Promise<PrintResult> {
  const { projectPath, outputId, reporter, config } = options;
  const out = resolve(options.out);

  const frozen = await reporter.step(
    'freeze',
    () => freeze(projectPath, { pages: (book) => pagesOf(book, outputId) }),
    (f) => `${f.assets.size} photos used`,
  );
  for (const warning of frozen.warnings) reporter.warn(warning);
  const { book } = frozen;
  const output = printOutput(book, outputId);
  const settings: PrintSettings = { ...output, dpi: options.dpi ?? output.dpi };
  const template = templateOf(book, outputId);
  const pages = pagesOf(book, outputId);
  if (pages.length === 0) throw new Error(`"${output.name}" has no pages to print`);
  const sheets = imposePages(pages.length, settings);
  const firstTrim = sheets[0]?.pages[0]?.trim;
  const content = firstTrim ? printContentBox(firstTrim, template) : { w: 1, h: 1 };

  // Photos: print-size files from the full-resolution sources, or (for comparisons) the publish cache.
  const assets = [...frozen.assets.values()];
  const sources = new Map<string, { path: string; width: number; height: number }>();
  const concurrency = config.concurrency ?? Math.max(1, cpus().length - 1);
  await reporter.step(
    'images',
    async () => {
      let done = 0;
      const progress = (detail: string) =>
        reporter.emit({ type: 'progress', step: 'images', done: ++done, total: assets.length, detail });
      if (options.webImages) {
        const imageOptions = { downloadMaxEdge: config.download.maxEdge, downloadQuality: config.download.quality };
        await mapLimit(assets, concurrency, async (asset) => {
          const { meta, cached } = await processAsset(asset, frozen.projectPath, imageOptions);
          const processed: ProcessedAsset = { asset, meta };
          sources.set(asset.id, localImage(processed, frozen.projectPath));
          progress(`${asset.relPath}${cached ? ' cached' : ''}`);
        });
        return;
      }
      const aspects = new Map<string, number>();
      await mapLimit(assets, concurrency, async (asset) => {
        const meta = await sharp(await decodableSource(asset, frozen.projectPath)).metadata();
        const upright = meta.autoOrient ?? { width: meta.width ?? 0, height: meta.height ?? 0 };
        if (upright.width && upright.height) aspects.set(asset.id, upright.width / upright.height);
      });
      const needed = neededEdges(pages, content, settings.dpi, (id) => aspects.get(id));
      await mapLimit(assets, concurrency, async (asset) => {
        const want = needed.get(asset.id) ?? 0;
        const edge = Math.max(EDGE_STEP, Math.ceil(want / EDGE_STEP) * EDGE_STEP);
        const image = await printImage(asset, frozen.projectPath, edge);
        sources.set(asset.id, image);
        progress(`${asset.relPath} ${image.width}x${image.height}${image.cached ? ' cached' : ''}`);
      });
      const used = new Set([...sources.values()].map((image) => basename(image.path)));
      await prunePrintCache(
        frozen.projectPath,
        assets.map((a) => a.hash),
        used,
      );
    },
    () => `${assets.length} photos at ${settings.dpi} dpi`,
  );

  const resolveImage: ResolveImage = (id) => {
    const image = sources.get(id);
    return image
      ? { src: pathToFileURL(image.path).href, width: image.width, height: image.height, loading: 'eager' }
      : null;
  };
  const sizeMm = sheetSize(settings);
  const result: PrintResult = { files: [], sheets: sheets.length, sheet: sizeMm, placements: [] };

  const launched = await launchChromium();
  if ('error' in launched) throw new Error(launched.error);
  const { browser } = launched;
  const renderDir = join(workDir(frozen.projectPath), 'render');
  await mkdir(renderDir, { recursive: true });
  const docOptions = { book, pages, template, settings, resolve: resolveImage, title: output.name || book.title };
  try {
    await reporter.step(
      'print',
      async () => {
        if (options.png) {
          // Proofs: one document per sheet at the dpi, whole pixels, screenshotted.
          await mkdir(out, { recursive: true });
          const scale = settings.dpi / 25.4;
          const tab: BrowserPage = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
          for (const [s, sheet] of sheets.entries()) {
            const doc = await printDocumentHtml({ ...docOptions, sheets: [sheet], scale, snap: true });
            for (const p of doc.placements) result.placements.push({ ...p, sheet: s });
            await tab.setViewportSize({ width: doc.size.w, height: doc.size.h });
            const png = await loadAndShoot(tab, renderDir, doc.html, `sheet ${s + 1}`);
            const name = `${String(s + 1).padStart(2, '0')}.png`;
            const tmp = join(out, `.${name}.${process.pid}.tmp`);
            await writeFile(tmp, png);
            await rename(tmp, join(out, name));
            result.files.push(join(out, name));
            reporter.emit({ type: 'progress', step: 'print', done: s + 1, total: sheets.length, detail: name });
          }
          return;
        }
        const doc = await printDocumentHtml({ ...docOptions, sheets, scale: CSS_DPI / 25.4, snap: false });
        result.placements = doc.placements;
        const tab: BrowserPage = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
        const htmlPath = join(renderDir, `print-${outputId}-${process.pid}.html`);
        await writeFile(htmlPath, doc.html);
        try {
          await tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
          await waitReady(tab, 'print');
          reporter.emit({ type: 'progress', step: 'print', done: 0, total: 1, detail: `${sheets.length} sheet(s)` });
          await mkdir(dirname(out), { recursive: true });
          await sweepStaleTemps(out);
          const tmp = printTempPath(out, process.pid);
          await tab.pdf({
            path: tmp,
            width: `${doc.size.w}px`,
            height: `${doc.size.h}px`,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            printBackground: true,
            preferCSSPageSize: true,
            tagged: false,
          });
          try {
            await rename(tmp, out);
          } catch (err) {
            await rm(tmp, { force: true });
            throw err;
          }
          result.files.push(out);
          reporter.emit({ type: 'progress', step: 'print', done: 1, total: 1, detail: out });
        } catch (err) {
          // A PDF that failed half-way never stays next to the real one (a killed run is swept by the next one).
          await rm(printTempPath(out, process.pid), { force: true });
          throw err;
        } finally {
          await rm(htmlPath, { force: true });
        }
      },
      () =>
        `${sheets.length} sheet(s) of ${Math.round(sizeMm.w * 10) / 10} × ${Math.round(sizeMm.h * 10) / 10} mm, ${settings.imposition}`,
    );
  } finally {
    await browser.close();
  }
  return result;
}

/** The temp file a run writes the PDF `out` to before renaming it: `.<name>.<pid>.print.tmp.pdf` next to it. */
export function printTempPath(out: string, pid: number): string {
  return join(dirname(out), `.${basename(out)}.${pid}.print.tmp.pdf`);
}

/** Remove temp PDFs of `out` left by runs that were killed (their process is gone). */
export async function sweepStaleTemps(out: string): Promise<string[]> {
  const prefix = `.${basename(out)}.`;
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dirname(out));
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.print.tmp.pdf')) continue;
    const pid = Number(name.slice(prefix.length, -'.print.tmp.pdf'.length));
    if (!Number.isInteger(pid) || pid === process.pid || processAlive(pid)) continue;
    await rm(join(dirname(out), name), { force: true });
    removed.push(name);
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Load `html` as a file (Chromium blocks file:// photos on about:blank), wait for photos and fonts, screenshot. */
async function loadAndShoot(tab: BrowserPage, dir: string, html: string, label: string): Promise<Buffer> {
  const htmlPath = join(dir, `print-${process.pid}-${Date.now()}.html`);
  await writeFile(htmlPath, html);
  try {
    await tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await waitReady(tab, label);
    return await tab.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  } finally {
    await rm(htmlPath, { force: true });
  }
}
