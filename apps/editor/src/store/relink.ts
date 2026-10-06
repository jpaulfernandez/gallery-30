import type { Asset, Book } from '@photobook/shared';

/**
 * Pure matcher for assets whose file moved or was renamed: given the book's assets and the files a
 * scan found, decide which assets relink to which scanned file, which are missing, which are
 * dropped, and which scanned files are new. No I/O; hashing comes in through `hashMany`.
 */

export interface ScannedLike {
  relPath: string;
  size: number;
}

export interface Relink {
  assetId: string;
  from: string;
  to: string;
}

export interface MissingAsset {
  assetId: string;
  /** Where the book last saw the file (relative to the source folder). */
  path: string;
  hash?: string;
  size?: number;
}

export interface RelinkPlan {
  relinks: Relink[];
  /** Vanished, unmatched assets that a page uses (shown as Missing with Locate). */
  missing: MissingAsset[];
  /** Vanished, unmatched assets nothing uses: delete them from `book.assets`. */
  pruned: string[];
  /** Scanned files no asset claims by path or by relink. */
  added: string[];
  /** Hashes computed along the way, keyed by relPath (reusable instead of hashing those files again). */
  hashes: Map<string, string>;
}

/** SHA-256 hex per relPath; a path that could not be read is absent or null. */
export type HashMany = (relPaths: string[]) => Promise<Map<string, string | null>>;

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Ids of the assets a page uses, as a photo element or as the page background. */
export function referencedAssetIds(book: Pick<Book, 'pages'>): Set<string> {
  const ids = new Set<string>();
  for (const page of book.pages) {
    if (typeof page.background === 'object') ids.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset !== null) ids.add(el.asset);
  }
  return ids;
}

/**
 * - An asset whose `path` is in the scan is untouched.
 * - Otherwise, with a known `hash` and `size`, the scanned files nobody claims by path and with the
 *   same size are hashed (one `hashMany` call) and the first whose hash matches wins (same file
 *   name preferred, then path order). Each file relinks at most one asset; assets in `referenced`
 *   pick first.
 * - No match, or no recorded hash or size to match on: missing when `referenced` has the id,
 *   pruned otherwise (an unused photo that left the folder is simply gone).
 */
export async function planRelinks(
  assets: Record<string, Asset>,
  scanned: ScannedLike[],
  hashMany: HashMany,
  referenced: ReadonlySet<string>,
): Promise<RelinkPlan> {
  const scannedPaths = new Set(scanned.map((f) => f.relPath));
  const claimed = new Set<string>();
  const gone: Array<[string, Asset]> = [];
  for (const [id, asset] of Object.entries(assets)) {
    if (scannedPaths.has(asset.path)) claimed.add(asset.path);
    else gone.push([id, asset]);
  }
  // Stable: used assets first, each group in book order.
  gone.sort(([a], [b]) => Number(referenced.has(b)) - Number(referenced.has(a)));

  const free = scanned.filter((f) => !claimed.has(f.relPath));
  const sizes = new Set(gone.flatMap(([, a]) => (a.hash !== undefined && a.size !== undefined ? [a.size] : [])));
  const candidates = free.filter((f) => sizes.has(f.size)).map((f) => f.relPath);
  const hashes = new Map<string, string>();
  if (candidates.length > 0) {
    for (const [relPath, hash] of await hashMany(candidates)) if (hash) hashes.set(relPath, hash);
  }

  const taken = new Set<string>();
  const relinks: Relink[] = [];
  const missing: MissingAsset[] = [];
  const pruned: string[] = [];
  for (const [assetId, asset] of gone) {
    const match =
      asset.hash === undefined || asset.size === undefined
        ? undefined
        : pickMatch(
            free.filter((f) => f.size === asset.size && !taken.has(f.relPath) && hashes.get(f.relPath) === asset.hash),
            asset.path,
          );
    if (match) {
      taken.add(match);
      relinks.push({ assetId, from: asset.path, to: match });
    } else if (!referenced.has(assetId)) {
      pruned.push(assetId);
    } else {
      missing.push({
        assetId,
        path: asset.path,
        ...(asset.hash !== undefined ? { hash: asset.hash } : {}),
        ...(asset.size !== undefined ? { size: asset.size } : {}),
      });
    }
  }

  const added = free.filter((f) => !taken.has(f.relPath)).map((f) => f.relPath);
  return { relinks, missing, pruned, added, hashes };
}

/** Among equally good candidates (already in path order) prefer the one with the old file name. */
function pickMatch(matches: ScannedLike[], oldPath: string): string | undefined {
  const name = basename(oldPath).toLowerCase();
  return (matches.find((f) => basename(f.relPath).toLowerCase() === name) ?? matches[0])?.relPath;
}

/**
 * `picked` (an absolute path from the native dialog) relative to `folder`, `/`-separated, or null
 * when it is not inside the folder. Handles both separators and a trailing slash on `folder`.
 */
export function relativeInside(folder: string, picked: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(folder);
  const file = norm(picked);
  if (!file.startsWith(`${root}/`)) return null;
  const rel = file.slice(root.length + 1);
  return rel === '' || rel.split('/').includes('..') ? null : rel;
}
