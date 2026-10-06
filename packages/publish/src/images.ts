import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { FrozenAsset } from './freeze.js';
import { workDir } from './paths.js';

const execFileAsync = promisify(execFile);

/** Everything the manifest needs about one processed asset; `out/<hash>/meta.json`. */
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
}

export interface ImageOptions {
  downloadMaxEdge: number;
  downloadQuality: number;
}

export const META_FILE = 'meta.json';

export function outDir(projectPath: string, hash: string): string {
  return join(workDir(projectPath), 'out', hash);
}

export const variantFile = (variant: 'download' | 'share' | `w${BrowseWidth}`, ext: 'jpg' | 'avif' | 'webp'): string =>
  `${variant}.${ext}`;

/** A cached meta whose files all exist and were made with the same download settings, or null. */
export async function readMeta(dir: string, options: ImageOptions): Promise<ImageMeta | null> {
  let meta: ImageMeta;
  try {
    meta = JSON.parse(await readFile(join(dir, META_FILE), 'utf8')) as ImageMeta;
  } catch {
    return null;
  }
  if (meta.version !== 1) return null;
  if (meta.download.maxEdge !== options.downloadMaxEdge || meta.download.quality !== options.downloadQuality)
    return null;
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

/** HEIC is decoded by `sips` into a cached JPEG first (macOS only); sharp reads the rest directly. */
async function decodableSource(asset: FrozenAsset, projectPath: string): Promise<string> {
  if (asset.kind !== 'heic') return asset.absPath;
  const dir = join(workDir(projectPath), 'heic');
  const target = join(dir, `${asset.hash}.jpg`);
  try {
    await stat(target);
    return target;
  } catch {
    // convert below
  }
  if (process.platform !== 'darwin') throw new Error(`${asset.relPath}: HEIC input needs macOS (sips) in this version`);
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp.jpg`;
  await execFileAsync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', asset.absPath, '--out', tmp]);
  await rename(tmp, target);
  return target;
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
 * Step 2.2: derive every published version of one asset into `out/<hash>/`. Idempotent: a complete
 * output folder is reused as-is. Everything is written to temp names and renamed, so a crash leaves
 * no half-written variant that `readMeta` would accept.
 */
export async function processAsset(
  asset: FrozenAsset,
  projectPath: string,
  options: ImageOptions,
): Promise<{ meta: ImageMeta; cached: boolean }> {
  const dir = outDir(projectPath, asset.hash);
  const cached = await readMeta(dir, options);
  if (cached) return { meta: cached, cached: true };

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const source = await decodableSource(asset, projectPath);
  // `rotate()` with no angle applies the EXIF orientation; later outputs carry orientation 1.
  const base = sharp(source, { failOn: 'none', limitInputPixels: false }).rotate();
  const info = await base.metadata();
  const upright = info.autoOrient ?? { width: info.width ?? 0, height: info.height ?? 0 };
  const width = upright.width;
  const height = upright.height;
  if (!width || !height) throw new Error(`${asset.relPath}: could not read the image size`);

  const write = async (name: string, pipeline: Sharp): Promise<OutputInfo> => {
    const tmp = join(dir, `.${name}.tmp`);
    const out = await pipeline.toFile(tmp);
    await rename(tmp, join(dir, name));
    return out;
  };

  // Download: EXIF (and the ICC profile) kept, orientation already applied.
  const download = await write(
    variantFile('download', 'jpg'),
    base
      .clone()
      .resize(fitInside(options.downloadMaxEdge))
      .keepMetadata()
      .jpeg({ quality: options.downloadQuality, mozjpeg: true }),
  );
  // Share and the ladder: converted to sRGB, no metadata.
  const share = await write(
    variantFile('share', 'jpg'),
    base
      .clone()
      .resize(fitInside(SHARE_MAX_EDGE))
      .withIccProfile('srgb', { attach: false })
      .jpeg({ quality: SHARE_QUALITY, mozjpeg: true }),
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
        base
          .clone()
          .resize(fitInside(w))
          .withIccProfile('srgb', { attach: false })
          .avif({ quality: AVIF_QUALITY, effort: 4 }),
      ),
      write(
        variantFile(`w${w}`, 'webp'),
        base.clone().resize(fitInside(w)).withIccProfile('srgb', { attach: false }).webp({ quality: WEBP_QUALITY }),
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
  };
  const tmp = join(dir, `.${META_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(meta));
  await rename(tmp, join(dir, META_FILE));
  return { meta, cached: false };
}
