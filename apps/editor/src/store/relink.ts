import { type Asset, type Book, usedAssetIdsOf } from '@photobook/shared';

/**
 * Pure matchers for assets whose file moved or was renamed. `planRelinks`: given one folder's assets and the files a
 * scan of it found, decide which assets relink to which scanned file, which are missing, which are dropped, and which
 * scanned files are new. `planCrossFolderRelinks` (workflow plan 04): search the assets still missing across the scans
 * of every imported folder, by size then hash. No I/O; hashing comes in through `hashMany` / `hashIn`.
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
  /** Where the book last saw the file (relative to its folder). */
  path: string;
  /** Absolute path of that folder when it is not the open project's primary folder. */
  folder?: string;
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

/** Ids of the assets a page uses, as a photo element or as the page background: the book's pages and outputs' frames. */
export function referencedAssetIds(book: Pick<Book, 'pages'> & Partial<Pick<Book, 'outputs'>>): Set<string> {
  return usedAssetIdsOf({ pages: book.pages, outputs: book.outputs ?? [] });
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

/** One imported folder for `planCrossFolderRelinks`: its scan and the paths in it that assets already own. */
export interface FolderScan {
  /** Registry id. */
  id: string;
  path: string;
  scanned: ScannedLike[];
  claimed: ReadonlySet<string>;
}

/** An asset found in another place: `folderPath` / `to`, from `fromFolder` / `from`. */
export interface CrossRelink {
  assetId: string;
  fromFolder: string | undefined;
  from: string;
  folderId: string;
  folderPath: string;
  to: string;
}

/** SHA-256 hex per relPath inside `folderPath`; unreadable files are absent or null. */
export type HashIn = (folderPath: string, relPaths: string[]) => Promise<Map<string, string | null>>;

/**
 * Search `missing` assets (those with a recorded hash and size) across `folders`, in order: in each folder the files
 * nobody claims with a wanted size are hashed (one `hashIn` call per folder, only while something is still unmatched),
 * and an asset takes the first file with its hash (same file name preferred). Each file relinks at most one asset.
 * Returns the relinks (with the hashes computed, by folder path and relPath, for reuse) and the assets still missing.
 */
export async function planCrossFolderRelinks(
  missing: MissingAsset[],
  folders: FolderScan[],
  hashIn: HashIn,
): Promise<{ relinks: CrossRelink[]; missing: MissingAsset[]; hashes: Map<string, Map<string, string>> }> {
  const relinks: CrossRelink[] = [];
  const hashes = new Map<string, Map<string, string>>();
  let open = missing.filter((m) => m.hash !== undefined && m.size !== undefined);
  const unsearchable = missing.filter((m) => m.hash === undefined || m.size === undefined);
  for (const folder of folders) {
    if (open.length === 0) break;
    const sizes = new Set(open.map((m) => m.size));
    const free = folder.scanned.filter((f) => !folder.claimed.has(f.relPath) && sizes.has(f.size));
    if (free.length === 0) continue;
    const found = new Map<string, string>();
    for (const [relPath, hash] of await hashIn(
      folder.path,
      free.map((f) => f.relPath),
    ))
      if (hash) found.set(relPath, hash);
    hashes.set(folder.path, found);
    const taken = new Set<string>();
    const still: MissingAsset[] = [];
    for (const m of open) {
      const match = pickMatch(
        free.filter((f) => f.size === m.size && !taken.has(f.relPath) && found.get(f.relPath) === m.hash),
        m.path,
      );
      if (match === undefined) {
        still.push(m);
        continue;
      }
      taken.add(match);
      relinks.push({
        assetId: m.assetId,
        fromFolder: m.folder,
        from: m.path,
        folderId: folder.id,
        folderPath: folder.path,
        to: match,
      });
    }
    open = still;
  }
  return { relinks, missing: [...open, ...unsearchable], hashes };
}
