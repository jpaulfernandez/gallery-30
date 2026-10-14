#!/usr/bin/env node
/**
 * Dev fixtures for the viewer: a fake R2 bucket under `dev-fixtures/` with a `site.json`, two books
 * (`demo`, phone-portrait, 13 pages; `postcards`, square, 3 pages) and generated numbered images in
 * every published version (download/share JPEG, AVIF + WebP ladders, placeholder data URL), plus
 * stand-in page images per page (Instagram feed 1080 x 1350 and story 1080 x 1920 PNGs, a 320 px
 * WebP thumbnail). The Vite dev server serves the folder at /dev-r2 and mocks the social Worker at
 * /dev-api (see vite.config.ts); `site.json` points `api` there and `.env.development` points
 * `VITE_R2_PUBLIC_URL` at /dev-r2, so the shell runs against it without a bucket or a Worker.
 *
 * Images are made with `sharp`, borrowed from packages/publish (no viewer dependency). Without it
 * the script writes SVG stand-ins with empty ladders so the shell still runs.
 *
 *   node scripts/make-dev-fixtures.mjs            # no-op when dev-fixtures/site.json exists
 *   node scripts/make-dev-fixtures.mjs --force    # regenerate
 *     --password=<word>   protect the first book with that word (SHA-256 over salt + word, version 1)
 *     --one-book          list only `demo` in site.json (root redirects instead of showing the grid)
 *     --skip-avif         WebP ladder only (faster)
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'dev-fixtures');
const BASE = 'http://localhost:5173/dev-r2';
const API = 'http://localhost:5173/dev-api';
const BROWSE_WIDTHS = [480, 960, 1440, 2048];

const args = new Map(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v ?? true]),
);

if (existsSync(join(OUT, 'site.json')) && !args.has('force')) {
  process.exit(0);
}

let sharp = null;
try {
  sharp = createRequire(join(here, '..', '..', '..', 'packages', 'publish', 'package.json'))('sharp');
} catch {
  console.warn('[fixtures] sharp not found in packages/publish; writing SVG stand-ins without ladders.');
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// --- photos --------------------------------------------------------------------------------------

const PALETTE = [
  ['#e8734a', '#f2a65a'],
  ['#3f7cac', '#95c8d8'],
  ['#5b8c5a', '#a3c585'],
  ['#8e5572', '#d6a2ad'],
  ['#c9a227', '#f1d06b'],
  ['#4b4e6d', '#84a9c0'],
  ['#b5533c', '#e38b6f'],
  ['#2f6f73', '#7fb7be'],
  ['#9b6b43', '#d9b382'],
  ['#6a4c93', '#b298dc'],
  ['#1b998b', '#8fd5c2'],
  ['#d7263d', '#f49cbb'],
];

/** id -> upright size. A mix of landscape, portrait, square and one panorama. */
const PHOTOS = [
  ['p01', 1800, 1200],
  ['p02', 1200, 1800],
  ['p03', 1500, 1500],
  ['p04', 1800, 1200],
  ['p05', 1200, 1800],
  ['p06', 1800, 1200],
  ['p07', 1200, 1600],
  ['p08', 2400, 1000],
  ['p09', 1800, 1200],
  ['p10', 1200, 1800],
  ['p11', 1500, 1500],
  ['p12', 1800, 1200],
].map(([id, width, height], i) => ({ id, width, height, n: i + 1, colors: PALETTE[i % PALETTE.length] }));

function svgFor({ width, height, n, colors }) {
  const fs = Math.round(Math.min(width, height) * 0.45);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${width * 0.78}" cy="${height * 0.26}" r="${Math.min(width, height) * 0.09}" fill="rgba(255,255,255,0.35)"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="rgba(255,255,255,0.92)">${n}</text>
  <text x="${width * 0.04}" y="${height * 0.95}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fs * 0.12)}" fill="rgba(255,255,255,0.7)">${width} x ${height}</text>
</svg>`;
}

const SLUG = 'demo';
const PREFIX = 'k7x2m9q4';
const imageDir = join(OUT, 'books', SLUG, PREFIX);
const imageUrl = (hash, variant, ext) => `${BASE}/books/${SLUG}/${PREFIX}/${hash}-${variant}.${ext}`;

async function makeImage(photo) {
  const hash = sha(`fixture:${photo.id}`).slice(0, 40);
  const svg = svgFor(photo);
  const filename = `IMG_${String(photo.n).padStart(4, '0')}.jpg`;

  if (!sharp) {
    writeFileSync(join(imageDir, `${hash}-share.svg`), svg);
    const url = imageUrl(hash, 'share', 'svg');
    const tiny = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="${photo.colors[0]}"/></svg>`;
    return {
      width: photo.width,
      height: photo.height,
      download: { url, bytes: Buffer.byteLength(svg), filename },
      share: url,
      avif: [],
      webp: [],
      placeholder: `data:image/svg+xml;base64,${Buffer.from(tiny).toString('base64')}`,
    };
  }

  const original = sharp(Buffer.from(svg), { density: 72 });
  const download = await original.clone().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  writeFileSync(join(imageDir, `${hash}-download.jpg`), download);
  const share = await original
    .clone()
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  writeFileSync(join(imageDir, `${hash}-share.jpg`), share);

  const long = Math.max(photo.width, photo.height);
  const widths = BROWSE_WIDTHS.filter((w) => w <= long);
  if (widths.length === 0) widths.push(long);
  const avif = [];
  const webp = [];
  for (const w of widths) {
    const resized = original.clone().resize(w, w, { fit: 'inside', withoutEnlargement: true });
    const { data: wd, info: wi } = await resized.clone().webp({ quality: 76 }).toBuffer({ resolveWithObject: true });
    writeFileSync(join(imageDir, `${hash}-w${w}.webp`), wd);
    webp.push({ w: wi.width, url: imageUrl(hash, `w${w}`, 'webp') });
    if (!args.has('skip-avif')) {
      const { data: ad, info: ai } = await resized
        .clone()
        .avif({ quality: 52, effort: 1 })
        .toBuffer({ resolveWithObject: true });
      writeFileSync(join(imageDir, `${hash}-w${w}.avif`), ad);
      avif.push({ w: ai.width, url: imageUrl(hash, `w${w}`, 'avif') });
    }
  }
  const placeholder = await original.clone().resize(24, 24, { fit: 'inside' }).webp({ quality: 40 }).toBuffer();

  return {
    width: photo.width,
    height: photo.height,
    download: { url: imageUrl(hash, 'download', 'jpg'), bytes: download.length, filename },
    share: imageUrl(hash, 'share', 'jpg'),
    avif,
    webp,
    placeholder: `data:image/webp;base64,${placeholder.toString('base64')}`,
  };
}

// --- pages ---------------------------------------------------------------------------------------

let counter = 0;
const id = (prefix) => `${prefix}${String(++counter).padStart(3, '0')}`;

const photo = (asset, frame, extra = {}) => ({
  type: 'photo',
  id: id('e'),
  asset,
  frame,
  crop: { x: 0, y: 0, scale: 1 },
  rotate: 0,
  filter: 'none',
  ...extra,
});

const text = (value, style, frame, extra = {}) => ({
  type: 'text',
  id: id('t'),
  text: value,
  style,
  frame,
  align: 'left',
  ...extra,
});

const page = (layout, background, elements) => ({ id: id('pg'), layout, background, elements });

/** Phone-portrait (1080 x 1350) pages. Spacing: margin 8 % of the width, gutter 2.5 %. */
function demoPages() {
  const m = 0.08;
  const g = 0.025;
  const my = m * 0.8;
  const gy = g * 0.8;
  const full = 1 - 2 * m;
  const half = (full - g) / 2;
  return [
    page('cover', { asset: 'p01' }, [
      text('Summer in Lisbon', 'title', { x: m, y: 0.7, w: full, h: 0.12 }, { color: '#ffffff', overlay: true }),
      text('AUGUST 2026', 'date', { x: m, y: 0.84, w: full, h: 0.04 }, { color: '#ffffff' }),
    ]),
    page('one-caption', '#f6f3ee', [
      photo('p02', { x: m, y: my, w: full, h: 0.72 }),
      text('The tram climbs Alfama before anyone is awake.', 'caption', {
        x: m,
        y: my + 0.72 + 0.015,
        w: full,
        h: 0.05,
      }),
    ]),
    page('two-stack', '#ffffff', [
      photo('p03', { x: m, y: my, w: full, h: 0.41 }),
      photo('p04', { x: m, y: my + 0.41 + gy, w: full, h: 0.41 }),
    ]),
    page('three-hero-two', '#ffffff', [
      photo('p05', { x: m, y: my, w: full, h: 0.5 }, { crop: { x: 0.04, y: 0, scale: 1.1 } }),
      photo('p06', { x: m, y: my + 0.5 + gy, w: half, h: 0.3 }),
      photo('p07', { x: m + half + g, y: my + 0.5 + gy, w: half, h: 0.3 }, { filter: 'bw' }),
    ]),
    page('four-grid', '#ffffff', [
      photo('p08', { x: m, y: my, w: half, h: 0.4 }),
      photo('p09', { x: m + half + g, y: my, w: half, h: 0.4 }),
      photo('p10', { x: m, y: my + 0.4 + gy, w: half, h: 0.4 }),
      photo('p11', { x: m + half + g, y: my + 0.4 + gy, w: half, h: 0.4 }),
    ]),
    page('text', '#f6f3ee', [
      text('Three days by the river', 'title', { x: m, y: 0.3, w: full, h: 0.1 }, { align: 'center' }),
      text(
        'We never made it to the museum. Every morning started with a pastel de nata and ended wherever the last tram stopped.',
        'body',
        { x: m, y: 0.43, w: full, h: 0.3 },
        { align: 'center' },
      ),
    ]),
    page('circle', '#ffffff', [
      photo('p12', { x: 0.2, y: 0.2, w: 0.6, h: 0.48 }, { shape: { kind: 'circle' } }),
      text('Belém, late afternoon', 'caption', { x: m, y: 0.72, w: full, h: 0.05 }, { align: 'center' }),
    ]),
    page('six-grid', '#ffffff', [
      ...[0, 1, 2].flatMap((row) => [
        photo(PHOTOS[(row * 2) % 12].id, { x: m, y: my + row * (0.277 + gy), w: half, h: 0.277 }),
        photo(PHOTOS[(row * 2 + 1) % 12].id, { x: m + half + g, y: my + row * (0.277 + gy), w: half, h: 0.277 }),
      ]),
    ]),
    page('rotated', '#111111', [
      photo('p01', { x: m, y: my, w: full, h: 0.6 }, { rotate: 90, filter: 'bw', crop: { x: 0, y: 0, scale: 1.3 } }),
      text('AUG 14 · 17:42', 'date', { x: m, y: my + 0.62, w: full, h: 0.04 }, { color: '#ffffff' }),
    ]),
    page('letterbox', '#1c1c1c', [
      photo('p08', { x: 0, y: 0.3, w: 1, h: 0.33 }),
      text(
        'The 25 de Abril bridge from Cacilhas',
        'caption',
        { x: m, y: 0.66, w: full, h: 0.05 },
        { color: '#ffffff' },
      ),
    ]),
    page('bleed', '#ffffff', [
      photo('p10', { x: 0, y: 0, w: 1, h: 1 }),
      text('last light', 'caption', { x: m, y: 0.88, w: 0.5, h: 0.05 }, { pill: true }),
    ]),
    page('shapes', '#f6f3ee', [
      photo('p04', { x: m, y: my, w: half, h: 0.33 }, { shape: { kind: 'rounded', radius: 0.15 } }),
      photo('p05', { x: m + half + g, y: my, w: half, h: 0.33 }, { shape: { kind: 'arch' } }),
      photo(
        'p06',
        { x: m, y: my + 0.33 + gy, w: full, h: 0.42 },
        { shape: { kind: 'polygon', sides: 6, rotation: 0 } },
      ),
    ]),
    page('end', '#ffffff', [
      text('Até à próxima', 'title', { x: m, y: 0.4, w: full, h: 0.1 }, { align: 'center' }),
      photo('p11', { x: 0.4, y: 0.55, w: 0.2, h: 0.16 }),
    ]),
  ];
}

/** Square (1080 x 1080) pages for the second listed book. */
function postcardPages() {
  const m = 0.08;
  const full = 1 - 2 * m;
  return [
    page('cover', { asset: 'p09' }, [
      text('Postcards', 'title', { x: m, y: 0.72, w: full, h: 0.14 }, { color: '#ffffff', overlay: true }),
    ]),
    page('two-side', '#ffffff', [
      photo('p02', { x: m, y: m, w: (full - 0.025) / 2, h: full }),
      photo('p05', { x: m + (full - 0.025) / 2 + 0.025, y: m, w: (full - 0.025) / 2, h: full }),
    ]),
    page('one', '#f6f3ee', [photo('p03', { x: m, y: m, w: full, h: full })]),
  ];
}

const usedAssets = (pages) => {
  const ids = new Set();
  for (const p of pages) {
    if (typeof p.background === 'object') ids.add(p.background.asset);
    for (const el of p.elements) if (el.type === 'photo' && el.asset) ids.add(el.asset);
  }
  return ids;
};

const firstThumb = (pages, images) => {
  for (const p of pages) {
    const assetId =
      typeof p.background === 'object'
        ? p.background.asset
        : p.elements.find((el) => el.type === 'photo' && el.asset)?.asset;
    if (!assetId) continue;
    const img = images[assetId];
    return img.webp[0]?.url ?? img.avif[0]?.url ?? img.share;
  }
  return null;
};

const THEME = {
  background: '#0d0d0d',
  defaultPageBackground: '#ffffff',
  fonts: ['Inter', 'Fraunces'],
  margin: 0.08,
  gutter: 0.025,
  wideGutter: 0.05,
  bleed: 0.0156,
  hardMargin: 0.0625,
  captionOffset: 0.015,
  captionClearance: 0.0375,
  grid: 0.0139,
};

// --- page images ---------------------------------------------------------------------------------

const PAGE_PREFIX = { demo: PREFIX, postcards: 'p3n8w1c6' };

function isDark(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const v = Number.parseInt(m[1], 16);
  return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) < 140;
}

/** A stand-in for a rendered page: the page background, its number and the book title, centred. */
function pageSvg({ width, height, n, title, background, frame }) {
  const fg = isDark(background) ? '#ffffff' : '#222222';
  const fs = Math.round(width * 0.22);
  const inner = frame
    ? `<rect x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" fill="${background}" stroke="${fg}" stroke-opacity="0.25" stroke-width="${Math.max(1, width / 270)}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${frame ? '#1a1a1a' : background}"/>${inner}
  <text x="50%" y="48%" dominant-baseline="central" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="${fg}">${n}</text>
  <text x="50%" y="${height * 0.48 + fs * 0.75}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(fs * 0.16)}" fill="${fg}" fill-opacity="0.7">${title}</text>
</svg>`;
}

/** Feed (4:5), story (9:16) and a 320 px thumbnail per page; the page sits centred at its own ratio. */
async function makePageImages(slug, title, template, pages) {
  if (!sharp) return pages.map(() => ({ thumbnail: null, shareFeed: null, shareStory: null }));
  const dir = join(OUT, 'books', slug, PAGE_PREFIX[slug], 'pages');
  mkdirSync(dir, { recursive: true });
  const url = (hash, variant, ext) => `${BASE}/books/${slug}/${PAGE_PREFIX[slug]}/pages/${hash}-${variant}.${ext}`;
  const ratio = template.width / template.height;
  const out = [];
  for (const [i, p] of pages.entries()) {
    const n = i + 1;
    const hash = sha(`fixture-page:${slug}:${p.id}`).slice(0, 40);
    const background = typeof p.background === 'string' ? p.background : '#3f7cac';
    const fit = (w, h) => {
      const fw = Math.min(w, h * ratio);
      const fh = fw / ratio;
      return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
    };
    const feed = { width: 1080, height: 1350 };
    const story = { width: 1080, height: 1920 };
    const feedFrame = Math.abs(ratio - 0.8) < 0.01 ? null : fit(feed.width, feed.height);
    await sharp(Buffer.from(pageSvg({ ...feed, n, title, background, frame: feedFrame })))
      .png()
      .toFile(join(dir, `${hash}-feed.png`));
    await sharp(Buffer.from(pageSvg({ ...story, n, title, background, frame: fit(story.width, story.height) })))
      .png()
      .toFile(join(dir, `${hash}-story.png`));
    const thumbH = Math.round(320 / ratio);
    await sharp(Buffer.from(pageSvg({ width: 320, height: thumbH, n, title, background, frame: null })))
      .webp({ quality: 76 })
      .toFile(join(dir, `${hash}-thumb.webp`));
    out.push({
      thumbnail: url(hash, 'thumb', 'webp'),
      shareFeed: url(hash, 'feed', 'png'),
      shareStory: url(hash, 'story', 'png'),
    });
  }
  return out;
}

async function manifest({ slug, title, template, pages, images }) {
  const used = usedAssets(pages);
  const own = Object.fromEntries(Object.entries(images).filter(([k]) => used.has(k)));
  const pageImages = await makePageImages(slug, title, template, pages);
  return {
    version: 1,
    id: `book-${slug}`,
    slug,
    title,
    listed: true,
    template,
    theme: THEME,
    publishedAt: new Date().toISOString(),
    images: own,
    pages: pages.map((p, i) => ({
      ...p,
      thumbnail: pageImages[i].thumbnail ?? firstThumb([p], own),
      shareFeed: pageImages[i].shareFeed,
      shareStory: pageImages[i].shareStory,
    })),
  };
}

// --- write ---------------------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(imageDir, { recursive: true });
mkdirSync(join(OUT, 'books', 'postcards'), { recursive: true });

const started = Date.now();
const images = {};
for (const p of PHOTOS) images[p.id] = await makeImage(p);

const books = [
  await manifest({
    slug: 'demo',
    title: 'Summer in Lisbon',
    template: { name: 'phone-portrait', width: 1080, height: 1350 },
    pages: demoPages(),
    images,
  }),
  await manifest({
    slug: 'postcards',
    title: 'Postcards',
    template: { name: 'square', width: 1080, height: 1080 },
    pages: postcardPages(),
    images,
  }),
];
const word = args.get('password');
const salt = randomBytes(16).toString('hex');
const password =
  typeof word === 'string' && word.length > 0
    ? { hash: sha(`${salt}${word}`), salt, version: 1, expiresAt: null }
    : null;
// The password goes on the first book only, so the list shows one locked and the rest open.
books.forEach((b, i) => {
  b.password = i === 0 ? password : null;
});
for (const b of books) {
  writeFileSync(join(OUT, 'books', b.slug, 'manifest.json'), JSON.stringify(b, null, 2));
}

const site = {
  password: null,
  books: (args.has('one-book') ? books.slice(0, 1) : books).map((b) => ({
    slug: b.slug,
    title: b.title,
    cover: firstThumb(b.pages, b.images),
    pages: b.pages.length,
    publishedAt: b.publishedAt,
    locked: b.password !== null,
  })),
  api: API,
};
writeFileSync(join(OUT, 'site.json'), JSON.stringify(site, null, 2));

console.log(
  `[fixtures] wrote ${books.length} books, ${PHOTOS.length} images${sharp ? '' : ' (svg)'} to dev-fixtures/ in ${Date.now() - started} ms${password ? ` (password on ${books[0].slug})` : ''}`,
);
