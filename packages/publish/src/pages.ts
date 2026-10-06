import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Book,
  canonicalJson,
  PAGE_IMAGE_SIZES,
  type PageProps,
  type PageSize,
  Page as PageView,
  pageAssetIds,
  pageImageKey,
  type ResolveImage,
} from '@photobook/shared';
import type { Browser, Page as BrowserPage } from 'playwright';
import sharp from 'sharp';
import type { FrozenBook } from './freeze.js';
import { hashText } from './hash.js';
import { outDir } from './images.js';
import { mapLimit } from './limit.js';
import type { Reporter } from './log.js';
import type { ImageObject, ProcessedAsset } from './manifest.js';
import { workDir } from './paths.js';
import { CONTENT_TYPES } from './store.js';

/**
 * Step 3 of the PRD pipeline: every page rendered headless with the shared `<Page>` to the two
 * Instagram PNGs (feed 1080 x 1350, story 1080 x 1920) and a 320 px WebP thumbnail for the jump
 * grid. Files are cached under `.photobook-publish/pages/<pageHash>/` and keyed on R2 by the same
 * hash, so a page whose look did not change is never rendered or uploaded again.
 */

/** Bump whenever the rendered output changes (renderer, harness CSS, frame sizes, thumb encoding). */
export const RENDER_VERSION = 1;
export const THUMB_QUALITY = 80;
/** Browser contexts rendering at once. */
export const PAGE_CONCURRENCY = 4;
/** Run from anywhere inside the repo. */
export const CHROMIUM_INSTALL_COMMAND = 'pnpm --filter @photobook/publish exec playwright install chromium';

type Frame = 'feed' | 'story';
const FRAMES: readonly Frame[] = ['feed', 'story'];

interface FileMeta {
  file: string;
  bytes: number;
  width: number;
  height: number;
}

/** `pages/<pageHash>/meta.json`. */
export interface PageImageMeta {
  version: 1;
  render: number;
  hash: string;
  feed: FileMeta;
  story: FileMeta;
  thumb: FileMeta;
}

/** A page whose images exist locally. */
export interface RenderedPage {
  pageId: string;
  hash: string;
  dir: string;
  meta: PageImageMeta;
}

export interface RenderPagesResult {
  pages: Map<string, RenderedPage>;
  rendered: number;
  cached: number;
  /** Set when Chromium could not start; pages without cached images were left out. */
  skipped?: string;
}

const FILES = { feed: 'feed.png', story: 'story.png', thumb: 'thumb.webp' } as const;
const META_FILE = 'meta.json';

export function pagesDir(projectPath: string, hash: string): string {
  return join(workDir(projectPath), 'pages', hash);
}

/**
 * The render hash of a page: renderer version, template, theme, the page without its notes and the
 * content hash of every photo it shows. Ids of unchanged pages and photos keep their hash.
 */
export function pageHash(
  book: Book,
  page: Book['pages'][number],
  assetHash: (id: string) => string | undefined,
): string {
  const { notes: _notes, ...rest } = page;
  const assets: Record<string, string | null> = {};
  for (const id of pageAssetIds(rest)) assets[id] = assetHash(id) ?? null;
  return hashText(
    canonicalJson({ render: RENDER_VERSION, template: book.template, theme: book.theme, page: rest, assets }),
  );
}

/**
 * Pixel width of the page inside a frame: the frame's width when the ratios match, else the
 * largest width whose height still fits. The height follows from the page's aspect ratio.
 */
export function fitPageWidth(template: PageSize, frame: { width: number; height: number }): number {
  return Math.max(1, Math.min(frame.width, Math.floor((frame.height * template.width) / template.height + 1e-6)));
}

/** Letterbox colour: the page's own colour, or the theme's for a photo background. */
export function letterboxColor(book: Book, page: Book['pages'][number]): string {
  return typeof page.background === 'string' ? page.background : book.theme.background;
}

/** The cached meta when every file exists, else null. */
export async function readPageMeta(dir: string, hash: string): Promise<PageImageMeta | null> {
  let meta: PageImageMeta;
  try {
    meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8')) as PageImageMeta;
  } catch {
    return null;
  }
  if (meta.version !== 1 || meta.render !== RENDER_VERSION || meta.hash !== hash) return null;
  for (const f of [meta.feed, meta.story, meta.thumb]) {
    try {
      await stat(join(dir, f.file));
    } catch {
      return null;
    }
  }
  return meta;
}

/** The three objects of a rendered page, relative to its `pages/<hash>/` dir. */
export function pageImageObjects(book: Book, { hash, meta }: RenderedPage): ImageObject[] {
  const { slug, r2Prefix } = book.publish;
  return [
    {
      key: pageImageKey(slug, r2Prefix, hash, 'feed', 'png'),
      file: meta.feed.file,
      contentType: CONTENT_TYPES.png,
      bytes: meta.feed.bytes,
    },
    {
      key: pageImageKey(slug, r2Prefix, hash, 'story', 'png'),
      file: meta.story.file,
      contentType: CONTENT_TYPES.png,
      bytes: meta.story.bytes,
    },
    {
      key: pageImageKey(slug, r2Prefix, hash, 'thumb', 'webp'),
      file: meta.thumb.file,
      contentType: CONTENT_TYPES.webp,
      bytes: meta.thumb.bytes,
    },
  ];
}

// --- HTML ---------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/**
 * React and react-dom/server, loaded only when a page is rendered. Required untyped on purpose:
 * this package does not carry `@types/react`, and the shared renderer brings its own JSX types.
 */
function reactServer(): {
  createElement: (type: unknown, props: unknown) => unknown;
  renderToStaticMarkup: (element: unknown) => string;
} {
  const { createElement } = require('react') as { createElement: (type: unknown, props: unknown) => unknown };
  const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
  return { createElement, renderToStaticMarkup };
}

let cssCache: Promise<string> | null = null;

/** Renderer CSS plus the fonts CSS with its `url(./x.woff2)` rewritten to absolute file URLs. */
export function rendererCss(): Promise<string> {
  cssCache ??= (async () => {
    const fontsPath = require.resolve('@photobook/shared/fonts.css');
    const rendererPath = require.resolve('@photobook/shared/renderer.css');
    const fonts = (await readFile(fontsPath, 'utf8')).replace(
      /url\((["']?)\.\/([^"')]+)\1\)/g,
      (_m, _q, file: string) => `url("${pathToFileURL(join(dirname(fontsPath), file)).href}")`,
    );
    return `${fonts}\n${await readFile(rendererPath, 'utf8')}`;
  })();
  return cssCache;
}

/** Best local version of a processed photo: the largest WebP of the ladder, else the share JPEG. */
export function localImage({ asset, meta }: ProcessedAsset, projectPath: string) {
  const dir = outDir(projectPath, asset.hash);
  const top = meta.ladder.at(-1);
  return top
    ? { path: join(dir, `w${top.w}.webp`), width: top.width, height: top.height }
    : { path: join(dir, meta.share.file), width: meta.share.width, height: meta.share.height };
}

/**
 * A standalone page: the shared `<Page>` in a flex-centred frame on the letterbox colour. The body
 * class picks the frame (`feed` / `story`), which sets the page width for that frame.
 */
export async function pageHtml(
  book: Book,
  page: Book['pages'][number],
  processed: Map<string, ProcessedAsset>,
  projectPath: string,
): Promise<string> {
  const { createElement, renderToStaticMarkup } = reactServer();
  const resolve: ResolveImage = (id) => {
    const p = processed.get(id);
    if (!p) return null;
    const img = localImage(p, projectPath);
    return { src: pathToFileURL(img.path).href, width: img.width, height: img.height, loading: 'eager' };
  };
  const widths = Object.fromEntries(FRAMES.map((f) => [f, fitPageWidth(book.template, PAGE_IMAGE_SIZES[f])])) as Record<
    Frame,
    number
  >;
  const props: PageProps = {
    page,
    template: book.template,
    theme: book.theme,
    resolve,
    pageWidthPx: widths.feed,
    style: { width: 'var(--pb-page-w)', flex: 'none' },
  };
  const markup = renderToStaticMarkup(createElement(PageView, props));
  const bg = letterboxColor(book, page);
  const harness = [
    `html,body{margin:0;padding:0;overflow:hidden;background:${bg}}`,
    `.pb-frame{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;background:${bg}}`,
    ...FRAMES.map((f) => `body.${f}{--pb-page-w:${widths[f]}px}`),
  ].join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${await rendererCss()}\n${harness}</style></head><body class="feed"><div class="pb-frame">${markup}</div></body></html>`;
}

// --- Browser ------------------------------------------------------------------------------------

/** Waits for every font face and image, then two frames. Evaluated in the page (no DOM lib here). */
const WAIT_READY = `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => null)));
  await document.fonts.ready;
  const imgs = [...document.images];
  await Promise.all(imgs.map((img) => img.decode().catch(() => null)));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return {
    broken: imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.getAttribute('src')),
    fonts: [...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family + ' ' + f.style),
  };
})()`;

async function waitReady(tab: BrowserPage, label: string): Promise<void> {
  const { broken, fonts } = (await tab.evaluate(WAIT_READY)) as { broken: string[]; fonts: string[] };
  if (broken.length) throw new Error(`${label}: ${broken.length} photo(s) did not load: ${broken.join(', ')}`);
  if (fonts.length) throw new Error(`${label}: font(s) did not load: ${fonts.join(', ')}`);
}

/** Headless Chromium, or a reason it could not start. */
export async function launchChromium(): Promise<{ browser: Browser } | { error: string }> {
  try {
    const { chromium } = await import('playwright');
    return { browser: await chromium.launch({ headless: true }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install|Cannot find (module|package) 'playwright'/i.test(message)) {
      return { error: `Chromium for Playwright is not installed. Install it with: ${CHROMIUM_INSTALL_COMMAND}` };
    }
    const first = message.split('\n').find((l) => l.trim()) ?? message;
    return { error: `could not start Chromium (${first.trim()}). If it is missing: ${CHROMIUM_INSTALL_COMMAND}` };
  }
}

async function writeAtomic(dir: string, name: string, body: Uint8Array | string): Promise<void> {
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, body);
  await rename(tmp, join(dir, name));
}

/** Render one page into `dir` with a ready browser tab; returns its meta. */
async function renderOne(
  tab: BrowserPage,
  job: { hash: string; dir: string; label: string; html: string },
  template: PageSize,
  projectPath: string,
): Promise<PageImageMeta> {
  const renderDir = join(workDir(projectPath), 'render');
  await mkdir(renderDir, { recursive: true });
  // Chromium blocks file:// subresources on an about:blank page (setContent), so load it as a file.
  const htmlPath = join(renderDir, `${job.hash}.html`);
  await writeFile(htmlPath, job.html);

  await tab.setViewportSize(PAGE_IMAGE_SIZES.feed);
  await tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await waitReady(tab, job.label);
  const shot = { type: 'png' as const, animations: 'disabled' as const, caret: 'hide' as const };
  const feed = await tab.screenshot(shot);
  const pageShot = await tab.locator('.pb-page').screenshot(shot);
  await tab.evaluate(`document.body.className = 'story'`);
  await tab.setViewportSize(PAGE_IMAGE_SIZES.story);
  await waitReady(tab, job.label);
  const story = await tab.screenshot(shot);

  const thumbWidth = PAGE_IMAGE_SIZES.thumb.width;
  const thumbHeight = Math.max(1, Math.round((thumbWidth * template.height) / template.width));
  const thumb = await sharp(pageShot)
    .resize(thumbWidth, thumbHeight, { fit: 'fill' })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  await rm(job.dir, { recursive: true, force: true });
  await mkdir(job.dir, { recursive: true });
  await writeAtomic(job.dir, FILES.feed, feed);
  await writeAtomic(job.dir, FILES.story, story);
  await writeAtomic(job.dir, FILES.thumb, thumb);
  const meta: PageImageMeta = {
    version: 1,
    render: RENDER_VERSION,
    hash: job.hash,
    feed: { file: FILES.feed, bytes: feed.length, ...PAGE_IMAGE_SIZES.feed },
    story: { file: FILES.story, bytes: story.length, ...PAGE_IMAGE_SIZES.story },
    thumb: { file: FILES.thumb, bytes: thumb.length, width: thumbWidth, height: thumbHeight },
  };
  await writeAtomic(job.dir, META_FILE, JSON.stringify(meta));
  await rm(htmlPath, { force: true });
  return meta;
}

/**
 * Render every page that has no cached images. Chromium only starts when something needs
 * rendering; when it cannot start, the step warns and the pages without images are left out.
 */
export async function renderPages(
  frozen: FrozenBook,
  processed: Map<string, ProcessedAsset>,
  reporter: Reporter,
): Promise<RenderPagesResult> {
  const { book, projectPath } = frozen;
  const total = book.pages.length;
  const jobs = book.pages.map((page, index) => {
    const hash = pageHash(book, page, (id) => frozen.assets.get(id)?.hash);
    return { page, index, hash, dir: pagesDir(projectPath, hash), label: `page ${index + 1}` };
  });
  const pages = new Map<string, RenderedPage>();
  let done = 0;
  const progress = (detail: string) => reporter.emit({ type: 'progress', step: 'pages', done: ++done, total, detail });

  // Cached pages first; pages sharing a hash (identical look) are rendered once.
  const todo = new Map<string, typeof jobs>();
  let cached = 0;
  for (const job of jobs) {
    const meta = todo.has(job.hash) ? null : await readPageMeta(job.dir, job.hash);
    if (meta) {
      pages.set(job.page.id, { pageId: job.page.id, hash: job.hash, dir: job.dir, meta });
      cached++;
      progress(`${job.label} cached`);
    } else {
      todo.set(job.hash, [...(todo.get(job.hash) ?? []), job]);
    }
  }
  if (todo.size === 0) return { pages, rendered: 0, cached };

  const launched = await launchChromium();
  if ('error' in launched) {
    reporter.warn(`Page images skipped: ${launched.error}`);
    return { pages, rendered: 0, cached, skipped: launched.error };
  }
  const { browser } = launched;
  let rendered = 0;
  try {
    const groups = [...todo.values()];
    const tabs: BrowserPage[] = [];
    for (let i = 0; i < Math.min(PAGE_CONCURRENCY, groups.length); i++) {
      const context = await browser.newContext({ viewport: PAGE_IMAGE_SIZES.feed, deviceScaleFactor: 1 });
      tabs.push(await context.newPage());
    }
    await mapLimit(groups, tabs.length, async (group) => {
      const tab = tabs.pop() as BrowserPage;
      try {
        const first = group[0] as (typeof jobs)[number];
        const t0 = performance.now();
        const html = await pageHtml(book, first.page, processed, projectPath);
        const meta = await renderOne(tab, { ...first, html }, book.template, projectPath);
        const secs = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
        for (const job of group) {
          pages.set(job.page.id, { pageId: job.page.id, hash: job.hash, dir: job.dir, meta });
          rendered++;
          progress(`${job.label} ${secs}`);
        }
      } finally {
        tabs.push(tab);
      }
    });
  } finally {
    await browser.close();
  }
  return { pages, rendered, cached };
}
