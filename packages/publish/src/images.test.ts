import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenAsset } from './freeze.js';
import { outDir, outputColour, processAsset, variantFile } from './images.js';

const OPTIONS = { downloadMaxEdge: 1600, downloadQuality: 90 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photobook-images-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** sharp's built-in profile for `name`, read back from a tiny tagged JPEG. */
async function builtinProfile(name: 'p3' | 'srgb'): Promise<Buffer> {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } })
    .withIccProfile(name)
    .jpeg()
    .toBuffer();
  const icc = (await sharp(jpeg).metadata()).icc;
  if (!icc) throw new Error('no profile');
  return icc;
}

/**
 * A 600 × 400 JPEG whose stored values are `rgb` (left half) and mid grey, tagged with `icc` as is (an APP2
 * segment spliced in, so the values are not converted): `[255, 0, 0]` under Display P3 is a red outside sRGB.
 */
async function taggedJpeg(rgb: [number, number, number], icc: Buffer | null): Promise<Buffer> {
  const w = 600;
  const h = 400;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) raw.set(i % w < w / 2 ? rgb : [128, 128, 128], i * 3);
  const plain = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
  if (!icc) return plain;
  const head = Buffer.concat([
    Buffer.from([0xff, 0xe2, 0, 0]),
    Buffer.from('ICC_PROFILE\0', 'latin1'),
    Buffer.from([1, 1]),
  ]);
  const segment = Buffer.concat([head, icc]);
  segment.writeUInt16BE(segment.length - 2, 2);
  return Buffer.concat([plain.subarray(0, 2), segment, plain.subarray(2)]);
}

function asset(path: string, hash: string): FrozenAsset {
  return {
    id: hash,
    relPath: 'p.jpg',
    folder: 'f',
    root: '/',
    absPath: path,
    filename: 'p.jpg',
    hash,
    size: 1,
    mtime: 0,
    kind: 'jpeg',
  };
}

/** Stored (unconverted) values of the left half's centre, and the embedded profile size. */
async function stored(file: string): Promise<{ rgb: number[]; icc: number }> {
  const img = sharp(await readFile(file));
  const { data, info } = await img.clone().keepIccProfile().raw().toBuffer({ resolveWithObject: true });
  const o = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 4)) * info.channels;
  return { rgb: [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0], icc: (await img.metadata()).icc?.length ?? 0 };
}

const VARIANTS = [variantFile('share', 'jpg'), variantFile('w480', 'avif'), variantFile('w480', 'webp')];

describe('outputColour', () => {
  it('keeps sRGB, untagged and non-RGB sources in sRGB and sends other RGB profiles to Display P3', async () => {
    expect(outputColour(undefined)).toBe('srgb');
    expect(outputColour(await builtinProfile('srgb'))).toBe('srgb');
    expect(outputColour(await builtinProfile('p3'))).toBe('display-p3');
    expect(outputColour(Buffer.from('not a profile'))).toBe('srgb');
  });
});

describe('processAsset colour', () => {
  it('publishes a Display P3 source as Display P3 in every format, keeping colours outside sRGB', async () => {
    const src = join(dir, 'p3.jpg');
    await writeFile(src, await taggedJpeg([255, 0, 0], await builtinProfile('p3')));
    const project = join(dir, 'book.photobook.json');
    const { meta } = await processAsset(asset(src, 'a'.repeat(64)), project, OPTIONS);
    expect(meta.colour).toBe('display-p3');
    const out = outDir(project, 'a'.repeat(64));
    for (const file of [...VARIANTS, variantFile('download', 'jpg')]) {
      const { rgb, icc } = await stored(join(out, file));
      expect(icc, file).toBeGreaterThan(0);
      // Still the P3 primary: an sRGB detour would have clipped it to sRGB red, (234, 51, 35) in P3.
      expect(rgb[0], file).toBeGreaterThan(245);
      expect(rgb[1], file).toBeLessThan(12);
      expect(rgb[2], file).toBeLessThan(12);
    }
  });

  it('publishes sRGB and untagged sources as untagged sRGB, as before', async () => {
    const project = join(dir, 'book.photobook.json');
    for (const [name, icc] of [
      ['b', await builtinProfile('srgb')],
      ['c', null],
    ] as const) {
      const src = join(dir, `${name}.jpg`);
      await writeFile(src, await taggedJpeg([200, 60, 30], icc));
      const { meta } = await processAsset(asset(src, name.repeat(64)), project, OPTIONS);
      expect(meta.colour).toBe('srgb');
      for (const file of VARIANTS) {
        const { rgb, icc: size } = await stored(join(outDir(project, name.repeat(64)), file));
        expect(size, file).toBe(0);
        expect(Math.abs((rgb[0] ?? 0) - 200), file).toBeLessThan(6);
      }
    }
  });

  it('reprocesses a cached sRGB output once the source turns out to be wide gamut', async () => {
    const src = join(dir, 'p3.jpg');
    const project = join(dir, 'book.photobook.json');
    const hash = 'd'.repeat(64);
    await writeFile(src, await taggedJpeg([255, 0, 0], null));
    expect((await processAsset(asset(src, hash), project, OPTIONS)).meta.colour).toBe('srgb');
    expect((await processAsset(asset(src, hash), project, OPTIONS)).cached).toBe(true);
    // A meta from before `colour` existed reads as sRGB.
    const metaPath = join(outDir(project, hash), 'meta.json');
    const { colour: _c, ...legacy } = JSON.parse(await readFile(metaPath, 'utf8'));
    await writeFile(metaPath, JSON.stringify(legacy));
    expect((await processAsset(asset(src, hash), project, OPTIONS)).cached).toBe(true);
    await writeFile(src, await taggedJpeg([255, 0, 0], await builtinProfile('p3')));
    const again = await processAsset(asset(src, hash), project, OPTIONS);
    expect(again.cached).toBe(false);
    expect(again.meta.colour).toBe('display-p3');
  });
});
