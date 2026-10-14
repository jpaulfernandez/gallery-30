import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type Book,
  developHash,
  isRawPath,
  LIBRARY_FILE,
  type Library,
  libraryBackupAllowed,
  loadBook,
  type OutputProfile,
  outputProfileSuffix,
  parseLibrary,
  renderedDevelop,
  resolveAssetDevelop,
  withResolvedDevelop,
} from '@photobook/shared';
import { hashFile } from './hash.js';
import { mapLimit } from './limit.js';
import { developRenderPath } from './paths.js';

export interface FrozenAsset {
  id: string;
  /** Relative to the asset's folder, as in the project file. */
  relPath: string;
  /** The asset's folder id (`Book.folders`). */
  folder: string;
  /** Absolute path of that folder on this machine (`FrozenBook.folders`). */
  root: string;
  /** The file the image pipeline reads: the original, or the developed render when `developHash` is set. */
  absPath: string;
  filename: string;
  /** Content hash of the original file (manifest keys and likes depend on it). */
  hash: string;
  size: number;
  mtime: number;
  /**
   * Format of `absPath`: always `jpeg` for a developed render, whatever the original was. `raw` only for a camera
   * RAW whose render is missing (dry runs); the image step converts it with `sips`.
   */
  kind: 'jpeg' | 'png' | 'heic' | 'raw';
  /**
   * Set when the asset is published through its develop render: `developHash(develop)` for non-default settings, and
   * for every camera RAW `developHash(develop ?? DEVELOP_DEFAULTS)` (`renderedDevelop`), where `develop` is the
   * asset's resolved edit (`resolveAssetDevelop`: snapshot, the folder's library, the legacy field).
   */
  developHash?: string;
  /**
   * The book's output profile the render was made in (`Book.outputProfile`); set together with `developHash`. It is
   * part of the render's file name and of `imageId`, so a P3 and an sRGB render of the same edit never share keys.
   */
  outputProfile?: OutputProfile;
  /** The original file, when `absPath` is a developed render. */
  sourcePath?: string;
  /**
   * True when the render does not exist yet and `absPath` points at the original instead. Only possible with
   * `allowMissingRenders` (dry runs); such an asset must never populate caches shared with a real publish.
   */
  renderMissing?: boolean;
}

/**
 * The id an asset's published image files and local caches are keyed by: the content hash, or
 * `<hash>-<developHash>[-p3]` once edited (`-p3` for a Display P3 book, like the render's file name), so re-editing a
 * photo, or switching the book's output profile, publishes new image keys instead of reusing (and CDN-caching) the
 * old pixels.
 */
export function imageId(asset: Pick<FrozenAsset, 'hash' | 'developHash' | 'outputProfile'>): string {
  return asset.developHash
    ? `${asset.hash}-${asset.developHash}${outputProfileSuffix(asset.outputProfile)}`
    : asset.hash;
}

/** Folder name under `.photobook-publish/out/`. Differs from `imageId` for provisional (render missing) assets. */
export function outName(asset: Pick<FrozenAsset, 'hash' | 'developHash' | 'outputProfile' | 'renderMissing'>): string {
  return asset.renderMissing ? `${imageId(asset)}.unrendered` : imageId(asset);
}

export interface FrozenBook {
  projectPath: string;
  /** The first folder's absolute path (books have one folder for now; see `folders`). */
  root: string;
  /** Absolute path of every folder of the book, by folder id. */
  folders: Map<string, string>;
  /**
   * The project file read through the folders' libraries (`withResolvedDevelop`): every asset's `develop` is the edit
   * it publishes with, so the manifest, the renders and the fingerprint agree with the editor.
   */
  book: Book;
  /** Every asset a page uses, by id. */
  assets: Map<string, FrozenAsset>;
  /** Hashes computed this run (the rest were trusted from the project file). */
  rehashed: number;
  /** Problems that did not stop the run (a library that could not be read). */
  warnings: string[];
}

/**
 * Absolute folder paths by id. A relative path is relative to the project file's folder. An absolute path that does not
 * exist on this machine falls back to the project file's folder, so a moved or copied folder with its project file in
 * it still publishes (the editor keeps that path current when it opens the book). `override` replaces every folder.
 */
export async function resolveFolders(book: Book, projectPath: string, override?: string): Promise<Map<string, string>> {
  const here = dirname(resolve(projectPath));
  const roots = new Map<string, string>();
  for (const [id, { path }] of Object.entries(book.folders)) {
    if (override) roots.set(id, resolve(override));
    else if (!isAbsolute(path)) roots.set(id, resolve(here, path));
    else roots.set(id, (await isDir(path)) ? path : here);
  }
  return roots;
}

/**
 * A folder's `library.json` exists but cannot be used (and neither can its `.bak`): publishing would silently drop the
 * edits it holds, so the run stops unless `--ignore-library` was passed.
 */
export class LibraryUnreadableError extends Error {
  constructor(
    public readonly file: string,
    reason: string,
  ) {
    super(
      `${file} cannot be read: ${reason}\n` +
        'Its ratings and edits would not be published. Open the folder in the editor (it restores library.json.bak), ' +
        'or rerun with --ignore-library to publish without them.',
    );
    this.name = 'LibraryUnreadableError';
  }
}

/** What `readLibrary` found: the library (undefined: none to use), whether the file exists, and a warning. */
export interface LibraryRead {
  library?: Library;
  /** False when the folder has no `library.json` at all. */
  exists: boolean;
  warning?: string;
}

/**
 * The folder's `.photobook/library.json`, parsed: undefined when it has none. One that `parseLibrary` rejects falls back
 * to `library.json.bak` (the editor's previous version) by the shared rule (`libraryBackupAllowed`: any problem except a
 * library written by a newer Photobook). One that still cannot be used, or cannot be read at all, throws
 * `LibraryUnreadableError` (fail closed), unless `ignore` is set: then the photos publish without its edits (with the
 * edits the project file itself still holds, a book from before v8, or unedited) and a warning says so.
 */
export async function readLibrary(root: string, ignore = false): Promise<LibraryRead> {
  const file = join(root, LIBRARY_FILE);
  const unusable = (reason: string): LibraryRead => {
    if (!ignore) throw new LibraryUnreadableError(file, reason);
    return { exists: true, warning: `${file}: ${reason}; publishing without the library's edits (--ignore-library)` };
  };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    return unusable((err as Error).message);
  }
  try {
    return { library: parseLibrary(text), exists: true };
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0] ?? String(err);
    if (!libraryBackupAllowed(err)) return unusable(`${reason}; update Photobook to publish this folder`);
    let backup: string;
    try {
      backup = await readFile(`${file}.bak`, 'utf8');
    } catch {
      return unusable(`${reason}; no library.json.bak to fall back to`);
    }
    try {
      return { library: parseLibrary(backup), exists: true, warning: `${file}: ${reason}; using library.json.bak` };
    } catch (bakErr) {
      return unusable(`${reason}; library.json.bak is not usable either (${(bakErr as Error).message.split('\n')[0]})`);
    }
  }
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
  if (isRawPath(path)) return 'raw';
  return 'jpeg';
}

/** Developed photos (edited, or camera RAW) whose rendered JPEG has not been written yet (the editor renders before publishing). */
export class MissingRendersError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `${paths.length} developed photo(s) have no rendered file yet:\n${paths.map((p) => `  ${p}`).join('\n')}\n` +
        'Open the book in the editor and let it render the edited and RAW photos before publishing.',
    );
    this.name = 'MissingRendersError';
  }
}

export class MissingAssetsError extends Error {
  constructor(public readonly paths: string[]) {
    super(`${paths.length} photo(s) used by the book are missing on disk:\n${paths.map((p) => `  ${p}`).join('\n')}`);
  }
}

/**
 * Step 2.1: load and validate the project file (migrating older versions), resolve every referenced asset on disk
 * (`folders[asset.folder]` joined with `asset.path`) and compute or reuse its SHA-256, and read each folder's library
 * once to resolve every asset's develop settings (`resolveAssetDevelop`). The editor's hash is trusted when size and
 * mtime are unchanged.
 */
export async function freeze(
  projectPath: string,
  options: {
    root?: string;
    concurrency?: number;
    allowMissingRenders?: boolean;
    /** Publish without the edits of a library that cannot be read (`--ignore-library`) instead of failing. */
    ignoreLibrary?: boolean;
    /**
     * The pages whose photos are resolved (default: the book's own pages). `render-frames` passes a social post's
     * frames (workflow plan 14), so only the photos it shows are hashed, checked for renders and processed.
     */
    pages?: (book: Book) => Book['pages'];
  } = {},
): Promise<FrozenBook> {
  const abs = resolve(projectPath);
  const json = JSON.parse(await readFile(abs, 'utf8')) as { version?: unknown };
  const book = loadBook(json);
  const folders = await resolveFolders(book, abs, options.root);
  const warnings: string[] = [];
  const libraries = new Map<string, Library | undefined>();
  const used = usedAssetIds(options.pages ? { ...book, pages: options.pages(book) } : book);
  for (const [id, root] of folders) {
    const { library, exists, warning } = await readLibrary(root, options.ignoreLibrary);
    libraries.set(id, library);
    if (warning) warnings.push(warning);
    // A v8 file keeps no edits of its own for hashed photos: without the library they publish unedited.
    const hashed = used.filter((assetId) => book.assets[assetId]?.folder === id && book.assets[assetId]?.hash).length;
    if (!exists && typeof json.version === 'number' && json.version >= 8 && hashed > 0) {
      warnings.push(
        `${join(root, LIBRARY_FILE)} does not exist: ${hashed} photo(s) of this folder publish without ratings or edits`,
      );
    }
  }
  const libraryOf = (folder: string) => libraries.get(folder);
  const resolvedBook = withResolvedDevelop(book, (asset) => libraryOf(asset.folder));
  const resolvedAssets: Book['assets'] = { ...resolvedBook.assets };

  const ids = used;
  const missing: string[] = [];
  const missingRenders: string[] = [];
  let rehashed = 0;
  const frozen = await mapLimit(ids, options.concurrency ?? 4, async (id): Promise<FrozenAsset | null> => {
    const asset = book.assets[id];
    if (!asset) return null; // the schema already rejects this
    const root = folders.get(asset.folder) as string; // the schema rejects unknown folders
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
    const frozenAsset: FrozenAsset = {
      id,
      relPath: asset.path,
      folder: asset.folder,
      root,
      absPath,
      filename: basename(asset.path),
      hash,
      size: s.size,
      mtime,
      kind: assetKind(asset.path),
    };
    // The library is keyed by the file's current bytes: a file changed since the editor saw it resolves by its new hash.
    let settings = resolvedAssets[id]?.develop;
    if (hash !== asset.hash?.toLowerCase()) {
      settings = resolveAssetDevelop({ ...asset, hash }, libraryOf(asset.folder));
      const { develop: _old, ...rest } = resolvedAssets[id] ?? asset;
      resolvedAssets[id] = settings ? { ...rest, develop: settings } : rest;
    }
    const develop = renderedDevelop({ path: asset.path, develop: settings });
    if (develop) {
      // Edited photo or camera RAW: the editor's full-resolution render (always a JPEG) stands in for the original.
      const dh = await developHash(develop);
      const renderPath = developRenderPath(root, hash, dh, book.outputProfile);
      frozenAsset.developHash = dh;
      frozenAsset.outputProfile = book.outputProfile;
      frozenAsset.sourcePath = absPath;
      if (await isFile(renderPath)) {
        frozenAsset.absPath = renderPath;
        frozenAsset.kind = 'jpeg';
      } else {
        missingRenders.push(asset.path);
        frozenAsset.renderMissing = true;
      }
    }
    return frozenAsset;
  });
  if (missing.length) throw new MissingAssetsError(missing);
  if (missingRenders.length && !options.allowMissingRenders) throw new MissingRendersError(missingRenders.sort());

  const assets = new Map<string, FrozenAsset>();
  for (const a of frozen) if (a) assets.set(a.id, a);
  const [root = dirname(abs)] = folders.values();
  return {
    projectPath: abs,
    root,
    folders,
    book: { ...resolvedBook, assets: resolvedAssets },
    assets,
    rehashed,
    warnings,
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
