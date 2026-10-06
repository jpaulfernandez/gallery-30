import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { type Book, loadBook } from '@photobook/shared';
import { hashFile } from './hash.js';
import { mapLimit } from './limit.js';

export interface FrozenAsset {
  id: string;
  /** Relative to the source folder, as in the project file. */
  relPath: string;
  absPath: string;
  filename: string;
  hash: string;
  size: number;
  mtime: number;
  kind: 'jpeg' | 'png' | 'heic';
}

export interface FrozenBook {
  projectPath: string;
  /** Folder the asset paths are relative to. */
  root: string;
  book: Book;
  /** Every asset a page uses, by id. */
  assets: Map<string, FrozenAsset>;
  /** Hashes computed this run (the rest were trusted from the project file). */
  rehashed: number;
}

/** Asset ids referenced by any page (slots and backgrounds), in first-use order. */
export function usedAssetIds(book: Book): string[] {
  const seen = new Set<string>();
  for (const page of book.pages) {
    if (typeof page.background === 'object') seen.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset) seen.add(el.asset);
  }
  return [...seen];
}

export function assetKind(path: string): FrozenAsset['kind'] {
  const ext = path.toLowerCase().replace(/^.*\./, '');
  if (ext === 'png') return 'png';
  if (ext === 'heic' || ext === 'heif') return 'heic';
  return 'jpeg';
}

export class MissingAssetsError extends Error {
  constructor(public readonly paths: string[]) {
    super(`${paths.length} photo(s) used by the book are missing on disk:\n${paths.map((p) => `  ${p}`).join('\n')}`);
  }
}

/**
 * Step 2.1: load and validate the project file, resolve every referenced asset on disk and compute
 * or reuse its SHA-256. The editor's hash is trusted when size and mtime are unchanged.
 */
export async function freeze(
  projectPath: string,
  options: { root?: string; concurrency?: number } = {},
): Promise<FrozenBook> {
  const abs = resolve(projectPath);
  const book = loadBook(JSON.parse(await readFile(abs, 'utf8')));
  // The project file sits in the source folder; prefer its real location over the recorded path
  // so a moved folder still publishes.
  const root =
    options.root ??
    (isAbsolute(book.sourceFolder) && (await isDir(book.sourceFolder)) ? book.sourceFolder : join(abs, '..'));

  const ids = usedAssetIds(book);
  const missing: string[] = [];
  let rehashed = 0;
  const frozen = await mapLimit(ids, options.concurrency ?? 4, async (id): Promise<FrozenAsset | null> => {
    const asset = book.assets[id];
    if (!asset) return null; // the schema already rejects this
    const absPath = join(root, asset.path);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(absPath);
    } catch {
      missing.push(asset.path);
      return null;
    }
    const mtime = Math.round(s.mtimeMs);
    const trusted =
      asset.hash !== undefined &&
      asset.size === s.size &&
      asset.mtime !== undefined &&
      Math.abs(asset.mtime - mtime) < 1000;
    let hash = trusted ? (asset.hash as string) : await hashFile(absPath);
    if (!trusted) rehashed++;
    hash = hash.toLowerCase();
    return {
      id,
      relPath: asset.path,
      absPath,
      filename: basename(asset.path),
      hash,
      size: s.size,
      mtime,
      kind: assetKind(asset.path),
    };
  });
  if (missing.length) throw new MissingAssetsError(missing);

  const assets = new Map<string, FrozenAsset>();
  for (const a of frozen) if (a) assets.set(a.id, a);
  return { projectPath: abs, root, book, assets, rehashed };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
