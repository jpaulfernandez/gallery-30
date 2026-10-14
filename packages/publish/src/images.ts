import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  AVIF_QUALITY,
  BROWSE_WIDTHS,
  type BrowseWidth,
  PLACEHOLDER_WIDTH,
  SHARE_MAX_EDGE,
  SHARE_QUALITY,
  WEBP_QUALITY,
} from '@photobook/shared';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import { type FrozenAsset, outName } from './freeze.js';
import { workDir } from './paths.js';

const execFileAsync = promisify(execFile);

/** Everything the manifest needs about one processed asset; `out/<name>/meta.json` (see `outName`). */
export interface ImageMeta {
  version: 1;
  /** Upright size of the original. */
  width: number;
  height: number;
  download: { file: 'download.jpg'; bytes: number; maxEdge: number; quality: number };
  share: { file: 'share.jpg'; bytes: number; width: number; height: number };
  /** Browse ladder actually produced (sizes wider than the original are dropped). */
  ladder: Array<{ w: BrowseWidth; width: number; height: number; avif: number; webp: number }>;
  placeholder: string;
  /**
   * Colour space of share.jpg and the ladder (`outputColour`): untagged sRGB, or Display P3 with its profile
   * attached. Absent in metas written before it existed, which were all sRGB.
   */
  colour?: OutputColour;
}

/** `srgb`: converted to sRGB, no profile (what browsers assume). `display-p3`: converted to Display P3, tagged. */
export type OutputColour = 'srgb' | 'display-p3';

export interface ImageOptions {
  downloadMaxEdge: number;
  downloadQuality: number;
}

export const META_FILE = 'meta.json';

/** `name` is `outName(asset)`: the content hash, or `<hash>-<developHash>` for an edited photo. */
export function outDir(projectPath: string, name: string): string {
  return join(workDir(projectPath), 'out', name);
}

export const variantFile = (variant: 'download' | 'share' | `w${BrowseWidth}`, ext: 'jpg' | 'avif' | 'webp'): string =>
  `${variant}.${ext}`;

/**
 * A cached meta whose files all exist and were made with the same download settings (and, when given, in the
 * same colour space), or null.
 */
export async function readMeta(dir: string, options: ImageOptions, colour?: OutputColour): Promise<ImageMeta | null> {
  let meta: ImageMeta;
  try {
    meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8')) as ImageMeta;
  } catch {
    return null;
  }
  if (meta.version !== 1) return null;
  if (meta.download.maxEdge !== options.downloadMaxEdge || meta.download.quality !== options.downloadQuality)
    return null;
  if (colour && (meta.colour ?? 'srgb') !== colour) return null;
  const files = [
    meta.download.file,
    meta.share.file,
    ...meta.ladder.flatMap((l) => [variantFile(`w${l.w}`, 'avif'), variantFile(`w${l.w}`, 'webp')]),
  ];
  for (const f of files) {
    try {
      await stat(join(dir, f));
    } catch {
      return null;
    }
  }
  return meta;
}

/**
 * HEIC is decoded by `sips` into a cached JPEG first (macOS only); sharp reads the rest directly. A camera RAW only
 * gets here without its develop render (a dry run's provisional asset), and goes through `sips` the same way.
 */
export async function decodableSource(asset: FrozenAsset, projectPath: string): Promise<string> {
  if (asset.kind !== 'heic' && asset.kind !== 'raw') return asset.absPath;
  const dir = join(workDir(projectPath), asset.kind);
  const target = join(dir, `${asset.hash}.jpg`);
  try {
    await stat(target);
    return target;
  } catch {
    // convert below
  }
  if (process.platform !== 'darwin') {
    throw new Error(
      `${asset.relPath}: ${asset.kind === 'raw' ? 'RAW' : 'HEIC'} input needs macOS (sips) in this version`,
    );
  }
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp.jpg`;
  await execFileAsync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', asset.absPath, '--out', tmp]);
  await rename(tmp, target);
  return target;
}

/** D50 colorants of sRGB as ICC profiles store them (rXYZ, gXYZ, bXYZ). */
const SRGB_COLORANTS = [
  [0.4361, 0.2225, 0.0139],
  [0.3851, 0.7169, 0.0971],
  [0.1431, 0.0606, 0.7141],
];

/**
 * Which colour space the published variants of an image with this embedded ICC profile use. No profile, a
 * non-RGB one (grey, CMYK) or an RGB matrix profile with sRGB's colorants: `srgb`, as before. Any other RGB
 * profile (Display P3 from an iPhone or a P3 develop render, Adobe RGB, a LUT profile): `display-p3`, so colours
 * outside sRGB survive on wide-gamut screens instead of being clipped.
 */
export function outputColour(icc: Buffer | undefined): OutputColour {
  if (!icc || icc.length < 132 || icc.toString('latin1', 16, 20) !== 'RGB ') return 'srgb';
  const count = icc.readUInt32BE(128);
  const colorant = (sig: string): number[] | null => {
    for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
      const at = 132 + i * 12;
      if (icc.toString('latin1', at, at + 4) !== sig) continue;
      const offset = icc.readUInt32BE(at + 4);
      if (offset + 20 > icc.length || icc.toString('latin1', offset, offset + 4) !== 'XYZ ') return null;
      return [0, 1, 2].map((k) => icc.readInt32BE(offset + 8 + k * 4) / 65536);
    }
    return null;
  };
  const colorants = ['rXYZ', 'gXYZ', 'bXYZ'].map(colorant);
  const srgb = colorants.every((c, i) => c?.every((v, k) => Math.abs(v - (SRGB_COLORANTS[i]?.[k] ?? 0)) < 0.003));
  return srgb ? 'srgb' : 'display-p3';
}

/**
 * Convert to the variant colour space: sRGB without a profile, or Display P3 with sharp's compact (480 byte) profile
 * attached, for JPEG, WebP and AVIF alike. The P3 path runs a 16-bit pipeline: in sharp's default 8-bit one the
 * embedded profile is first imported into sRGB, which clips exactly the colours P3 is there to keep.
 */
function inColour(pipeline: Sharp, colour: OutputColour): Sharp {
  return colour === 'display-p3'
    ? pipeline.pipelineColourspace('rgb16').withIccProfile('p3')
    : pipeline.withIccProfile('srgb', { attach: false });
}

const fitInside = (maxEdge: number) => ({
  width: maxEdge,
  height: maxEdge,
  fit: 'inside' as const,
  withoutEnlargement: true,
});

/** Size after `fit: inside` into a square of `maxEdge`, never enlarging. */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/**
 * Step 2.2: derive every published version of one asset into `out/<name>/`. Idempotent: a complete
 * output folder is reused as-is. The folder is built under a temp name unique to the call and renamed when complete,
 * so a crash leaves no half-written variant that `readMeta` would accept, and two processes (a publish and a post
 * export) on the same photo do not race.
 */
export async function processAsset(
  asset: FrozenAsset,
  projectPath: string,
  options: ImageOptions,
): Promise<{ meta: ImageMeta; cached: boolean }> {
  const dir = outDir(projectPath, outName(asset));
  const source = await decodableSource(asset, projectPath);
  // `rotate()` with no angle applies the EXIF orientation; later outputs carry orientation 1.
  const base = sharp(source, { failOn: 'none', limitInputPixels: false }).rotate();
  const info = await base.metadata();
  const colour = outputColour(info.icc);
  const cached = await readMeta(dir, options, colour);
  if (cached) return { meta: cached, cached: true };

  // Built in a directory of its own and renamed into place when complete (workflow plan 14): a publish and a post
  // export (or two exports) processing the same photo at once never write into, or delete, each other's files.
  const final = dir;
  const work = join(dirname(final), `.${basename(final)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  await mkdir(work, { recursive: true });
  try {
    const meta = await processInto(work, base, colour, asset, options);
    return { meta: await moveIntoPlace(work, final, meta, options, colour), cached: false };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Rename the complete `work` directory to `final`. When another process got there first with a usable result, that one
 * is kept (and returned); a stale or partial `final` is replaced.
 */
async function moveIntoPlace(
  work: string,
  final: string,
  meta: ImageMeta,
  options: ImageOptions,
  colour: OutputColour,
): Promise<ImageMeta> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rename(work, final);
      return meta;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') throw err;
      const theirs = await readMeta(final, options, colour);
      if (theirs) return theirs;
      await rm(final, { recursive: true, force: true });
    }
  }
  throw new Error(`could not move ${work} to ${final}`);
}

/** Write every variant of one photo and its `meta.json` into `dir`; returns the meta. */
async function processInto(
  dir: string,
  base: Sharp,
  colour: OutputColour,
  asset: FrozenAsset,
  options: ImageOptions,
): Promise<ImageMeta> {
  const info = await base.metadata();
  const upright = info.autoOrient ?? { width: info.width ?? 0, height: info.height ?? 0 };
  const width = upright.width;
  const height = upright.height;
  if (!width || !height) throw new Error(`${asset.relPath}: could not read the image size`);

  // `dir` is this call's own directory (see `processAsset`), so files are written in place.
  const write = (name: string, pipeline: Sharp): Promise<OutputInfo> => pipeline.toFile(join(dir, name));

  // Download: EXIF (and the ICC profile) kept, orientation already applied.
  const download = await write(
    variantFile('download', 'jpg'),
    base
      .clone()
      .resize(fitInside(options.downloadMaxEdge))
      .keepMetadata()
      .jpeg({ quality: options.downloadQuality, mozjpeg: true }),
  );
  // Share and the ladder: no metadata; sRGB untagged, or Display P3 tagged for a wide-gamut source (`outputColour`).
  const share = await write(
    variantFile('share', 'jpg'),
    inColour(base.clone().resize(fitInside(SHARE_MAX_EDGE)), colour).jpeg({ quality: SHARE_QUALITY, mozjpeg: true }),
  );
  const ladder: ImageMeta['ladder'] = [];
  let lastWidth = 0;
  for (const w of BROWSE_WIDTHS) {
    const size = fitSize(width, height, w);
    // Drop sizes that would repeat the previous one (source smaller than the step).
    if (size.width === lastWidth) break;
    lastWidth = size.width;
    const [avif, webp] = await Promise.all([
      write(
        variantFile(`w${w}`, 'avif'),
        inColour(base.clone().resize(fitInside(w)), colour).avif({ quality: AVIF_QUALITY, effort: 4 }),
      ),
      write(
        variantFile(`w${w}`, 'webp'),
        inColour(base.clone().resize(fitInside(w)), colour).webp({ quality: WEBP_QUALITY }),
      ),
    ]);
    ladder.push({ w, width: size.width, height: size.height, avif: avif.size, webp: webp.size });
  }
  const placeholderBuf = await base.clone().resize(fitInside(PLACEHOLDER_WIDTH)).webp({ quality: 50 }).toBuffer();
  const placeholder = `data:image/webp;base64,${placeholderBuf.toString('base64')}`;

  const meta: ImageMeta = {
    version: 1,
    width,
    height,
    download: {
      file: 'download.jpg',
      bytes: download.size,
      maxEdge: options.downloadMaxEdge,
      quality: options.downloadQuality,
    },
    share: { file: 'share.jpg', bytes: share.size, width: share.width, height: share.height },
    ladder,
    placeholder,
    colour,
  };
  await writeFile(join(dir, META_FILE), JSON.stringify(meta));
  return meta;
}
