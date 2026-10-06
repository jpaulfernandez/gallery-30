/**
 * Regenerates `fixtures/six/`: six small photos (three landscape, three portrait, one of them with
 * an EXIF orientation) and a three-page book that uses all of them. Run with `pnpm fixtures:make`.
 * The outputs are checked in so tests and the smoke script need no setup.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Book, BookSchema, type Page, THEME_DEFAULTS } from '@photobook/shared';
import sharp from 'sharp';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'six');

/** Fixed ids so the manifest and keys are stable across regenerations. */
const PHOTOS = [
  { id: '01FIXTUREASSET0000000000A1', name: 'DSCF2001.jpg', w: 1200, h: 800, hue: 10 },
  { id: '01FIXTUREASSET0000000000A2', name: 'DSCF2002.jpg', w: 800, h: 1200, hue: 70 },
  { id: '01FIXTUREASSET0000000000A3', name: 'DSCF2003.jpg', w: 1200, h: 800, hue: 130 },
  { id: '01FIXTUREASSET0000000000A4', name: 'DSCF2004.jpg', w: 800, h: 1200, hue: 190 },
  { id: '01FIXTUREASSET0000000000A5', name: 'DSCF2005.jpg', w: 1200, h: 800, hue: 250, orientation: 6 },
  { id: '01FIXTUREASSET0000000000A6', name: 'DSCF2006.jpg', w: 900, h: 900, hue: 310 },
] as const;

function hsl(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

async function makePhoto(p: (typeof PHOTOS)[number]): Promise<void> {
  // A diagonal gradient with a bright corner, so crops and orientation are visibly different.
  const raw = Buffer.alloc(p.w * p.h * 3);
  const a = hsl(p.hue, 0.6, 0.45);
  const b = hsl((p.hue + 40) % 360, 0.7, 0.75);
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const t = (x / p.w + y / p.h) / 2;
      const i = (y * p.w + x) * 3;
      raw[i] = Math.round(a.r + (b.r - a.r) * t);
      raw[i + 1] = Math.round(a.g + (b.g - a.g) * t);
      raw[i + 2] = Math.round(a.b + (b.b - a.b) * t);
    }
  }
  let img = sharp(raw, { raw: { width: p.w, height: p.h, channels: 3 } }).jpeg({ quality: 80 });
  if ('orientation' in p && p.orientation) img = img.withMetadata({ orientation: p.orientation });
  await img.toFile(join(dir, p.name));
}

function photo(
  id: string,
  asset: string,
  frame: { x: number; y: number; w: number; h: number },
  scale = 1,
): Page['elements'][number] {
  return { type: 'photo', id, asset, frame, crop: { x: 0, y: 0, scale }, rotate: 0, filter: 'none' };
}

async function main(): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const p of PHOTOS) await makePhoto(p);

  const assets: Book['assets'] = {};
  for (const p of PHOTOS) {
    const file = join(dir, p.name);
    const bytes = await readFile(file);
    const s = await stat(file);
    const meta = await sharp(bytes).metadata();
    const upright = meta.autoOrient;
    assets[p.id] = {
      path: p.name,
      hash: createHash('sha256').update(bytes).digest('hex'),
      width: upright.width,
      height: upright.height,
      size: s.size,
      mtime: Math.round(s.mtimeMs),
      orientation: meta.orientation ?? 1,
    };
  }
  const [a1, a2, a3, a4, a5, a6] = PHOTOS.map((p) => p.id) as [string, string, string, string, string, string];
  const book: Book = {
    version: 3,
    id: '01FIXTUREBOOK00000000000001',
    title: 'Six photos',
    // A placeholder rather than this machine's path: publish falls back to the project file's folder.
    sourceFolder: '/fixtures/six',
    template: { name: 'phone-portrait', width: 1080, height: 1350 },
    theme: THEME_DEFAULTS,
    assets,
    pages: [
      {
        id: '01FIXTUREPAGE00000000000001',
        layout: 'custom',
        background: '#ffffff',
        elements: [
          photo('01FIXTUREEL000000000000001', a1, { x: 0.08, y: 0.08, w: 0.84, h: 0.5 }, 1.2),
          {
            type: 'text',
            id: '01FIXTUREEL000000000000002',
            text: 'Day one',
            style: 'title',
            frame: { x: 0.08, y: 0.62, w: 0.84, h: 0.08 },
            align: 'left',
          },
        ],
        notes: 'designer only, stripped by publish',
      },
      {
        id: '01FIXTUREPAGE00000000000002',
        layout: 'custom',
        background: { asset: a5 },
        elements: [
          photo('01FIXTUREEL000000000000003', a2, { x: 0.08, y: 0.1, w: 0.4, h: 0.5 }),
          photo('01FIXTUREEL000000000000004', a3, { x: 0.52, y: 0.4, w: 0.4, h: 0.5 }),
        ],
      },
      {
        id: '01FIXTUREPAGE00000000000003',
        layout: 'custom',
        background: '#111111',
        elements: [
          photo('01FIXTUREEL000000000000005', a4, { x: 0.08, y: 0.06, w: 0.84, h: 0.42 }),
          photo('01FIXTUREEL000000000000006', a6, { x: 0.3, y: 0.52, w: 0.4, h: 0.32 }, 1.5),
        ],
      },
    ],
    publish: { slug: 'fixture-six', visibility: 'listed', lastPublishedAt: null, r2Prefix: 'fx6pre' },
    customLayouts: [],
  };
  BookSchema.parse(book);
  await writeFile(join(dir, 'book.photobook.json'), `${JSON.stringify(book, null, 2)}\n`);
  console.log(`wrote ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
