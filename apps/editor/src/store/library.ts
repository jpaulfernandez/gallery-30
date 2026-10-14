import {
  type Asset,
  type AssetDraft,
  type AssetFlag,
  type Book,
  createDevelop,
  type DevelopSettings,
  emptyLibrary,
  type Library,
  LibraryLoadError,
  type LibraryPhoto,
  libraryBackupAllowed,
  parseLibrary,
  resolveDevelop,
  resolvePhotoDevelop,
  serializeLibrary,
} from '@photobook/shared';
import { current, type Draft, isDraft, original, produce } from 'immer';
import { create } from 'zustand';
import { deepEqual } from '../lib/develop/merge';
import { errorMessage } from '../lib/errors';
import { devError, devLog } from '../lib/log';
import {
  type AssetHashedEvent,
  type AssetKind,
  fileUrl,
  hashFiles,
  type IndexEntry,
  onAssetHashed,
  onHashProgress,
  type PhotoFacts,
  prepareAsset,
  readIndex,
  readLibrary,
  readLibraryBackup,
  type ScannedFile,
  scanFolder,
  writeIndex,
  writeLibrary,
} from '../lib/tauri';

/**
 * The per-folder library in the editor (workflow plan 02): `libraries` holds the parsed
 * `<folder>/.photobook/library.json` of every imported folder the open project draws from, keyed by folder path. It lives inside the book store (see
 * `createLibrarySlice`), so zundo's one `temporal` covers both: a develop edit is one undo step for the book and the
 * library together.
 *
 * Rules:
 * - The library is the source of truth for `rating`, `flag` and `develop`, keyed by the asset's content hash. In
 *   memory the open book keeps a working mirror of them on `book.assets[id]` (undo and the asset metadata merge rely
 *   on it): every write goes to the library entry and to every book asset with that hash (`writePhotoFields`), so
 *   duplicated files share one edit. The mirror is never saved for a hashed asset (`bookForDisk`): book v8 files hold
 *   `rating`, `flag` and `develop` only for photos the scan has not hashed yet, or when the library cannot be written.
 * - Read through the selectors (`assetDevelop`, `assetRating`, `assetFlag`, `resolvedAssets`, `libraryBook`): develop
 *   follows `resolveAssetDevelop` (the project's snapshot, the library entry or the asset's version, the book's own
 *   field); rating and flag are the library entry's when the asset is hashed and has one, else the book's.
 * - An asset that is not hashed yet keeps its fields on the book only; when its hash lands (`fillAssets`) and on open
 *   (`loadFromFolder`) `reconcileAsset` brings them together field by field: a field the entry has wins over the
 *   book's, a field only the book has is lifted into the entry (created when missing).
 * - An entry with no rating, flag, develop or versions is removed, so an undone first edit leaves no trace.
 * - Versions (virtual copies, workflow plan 08) live in the entry's `versions`; a project asset's `version` picks one
 *   (absent: the master). Develop edits the version the photo shows (`editedVersion`), and the mirror only ever holds
 *   the master. Making, renaming and deleting versions are not undo steps; editing one is.
 * - A library whose entries fail the schema is replaced by its `.bak` when that parses (the dev log names the bad
 *   photo). One that still cannot be used (another version, no usable backup) is never written over: edits then live
 *   on the book mirror only, and the dev log says so.
 *
 * Saving is `startLibraryAutosave` in ./autosave.ts (debounced like the book).
 *
 * Photo ids (workflow plan 05): the selectors and `writePhotoFields` take either a project asset id or a library photo
 * key (`photoKey`, `${folderId}/${path}`). A key reads and writes the master edit of its folder's library entry (and
 * mirrors it onto every open-book asset with that hash in that folder); it needs the folder's photos
 * (`useLibraryStore`, bottom of this file) for its hash and the folder's library loaded in `libraries`.
 *
 * Folder photos (bottom of this file): `useLibraryStore` holds every imported folder's photos as scanned, hashed and
 * prepared, keyed by registry id then relative path, with `<folder>/.photobook/index.json` making a re-scan instant.
 * It knows nothing of projects; the assets store (./assets.ts) maps a project's assets onto it.
 */

/**
 * The book store state the library helpers read: the open book, its primary folder (the one the filmstrip scans) and
 * the loaded libraries. An asset's library is the one of its own folder (`assetFolderPath`), which is the primary
 * folder unless a relink found the photo in another imported folder (workflow plan 04).
 */
export interface LibraryView {
  book: Book | null;
  folder: string | null;
  libraries: Record<string, Library>;
  /** The version Develop shows for one photo id, when it is not that photo's own (`DevelopVersionChoice`). */
  developVersion?: DevelopVersionChoice | null;
}

/**
 * Develop's version choice (workflow plan 08): photo `id` shows and edits `version` (null: the master) instead of its
 * own, which is the asset's `version` for a project asset and the master for a library key. One photo at a time (the
 * one Develop shows); the canvas, the filmstrip and publishing never read it (`resolvedAssets` ignores it).
 */
export interface DevelopVersionChoice {
  id: string;
  version: string | null;
}

export interface LibrarySlice {
  /** Parsed libraries by folder path: every imported folder of the open project. */
  libraries: Record<string, Library>;
  /** Read and parse `folder`'s library into `libraries` (empty when it has none); the open book follows it. */
  loadLibrary: (folder: string) => Promise<Library>;
  /**
   * Edit one photo's entry (created when missing, removed when left empty) and mirror it onto the open book's assets
   * with that hash. One undo step, of which undo restores only the develop settings (ratings, flags and versions keep
   * their newest values, see `mergeLibrariesForHistory`).
   */
  patchPhoto: (folder: string, hash: string, fn: (photo: Draft<LibraryPhoto>) => void) => void;
  /**
   * Edit `folder`'s library itself (its top-level fields, such as plan 40's `cull`), never an undo step. Refused
   * (logged) while that library is not loaded: an empty library written now would replace the one on disk.
   */
  patchLibrary: (folder: string, fn: (library: Draft<Library>) => void) => void;
  /** Write `folder`'s library now (autosave does this debounced). Rejects with the command's message. */
  saveLibrary: (folder: string) => Promise<void>;
  /**
   * Plan 42: forget photos that went to the Trash (`trashPhotos`), never an undo step. They leave the library store's
   * folder `folderId` (by relative path) and its `index.json` (written now), and their library entries leave the
   * folder's `library.json` (autosave writes it) when no other photo of the folder has the same hash. A project asset
   * keeps its id and shows Missing, as after any file that went away; a rescan brings a file put back from the Trash
   * in again as a new, undecided photo.
   */
  dropPhotos: (folderId: string, relPaths: readonly string[]) => Promise<void>;
}

/** The cull and edit fields the library owns. A key that is present is written; `undefined` removes the field. */
export type PhotoFields = Partial<Pick<LibraryPhoto, 'rating' | 'flag' | 'develop'>>;

type FieldHolder = Pick<Asset, 'rating' | 'flag' | 'develop'>;

const FIELD_KEYS = ['rating', 'flag', 'develop'] as const;

/** Libraries exactly as `readFolderLibrary` read them: autosave counts them as saved (loading is not a change). */
const readFromDisk = new WeakSet<Library>();

/** True when `library` is the object `readFolderLibrary` returned, unchanged since. */
export const isLibraryFromDisk = (library: Library): boolean => readFromDisk.has(library);

/** Folders whose library file could not be parsed: never written over in this session. */
const unwritable = new Set<string>();

/** False when `folder`'s library file could not be parsed, so saving it would destroy it. */
export const isLibraryWritable = (folder: string): boolean => !unwritable.has(folder);

/** Folders whose last library write failed: the book keeps its mirror on disk until one succeeds. */
const failedWrites = new Set<string>();

/**
 * Record the outcome of a library write (the library autosave and `loadFromFolder` call this). Returns true when this
 * clears an earlier failure: the book file then still holds the mirror it kept meanwhile, and should be saved again.
 */
export function setLibraryWriteFailed(folder: string, failed: boolean): boolean {
  if (failed) {
    failedWrites.add(folder);
    return false;
  }
  return failedWrites.delete(folder);
}

/**
 * True when the saved book may leave out the mirror of `folder`'s photos: the library is loaded, can be written and its
 * last write did not fail, so it (not the book) is where the edits are kept.
 */
export function libraryHoldsEdits(view: Pick<LibraryView, 'libraries'>, folder: string | null): boolean {
  return (
    folder !== null && Object.hasOwn(view.libraries, folder) && !unwritable.has(folder) && !failedWrites.has(folder)
  );
}

function applyFields(target: FieldHolder, fields: PhotoFields): void {
  for (const key of FIELD_KEYS) {
    if (!(key in fields)) continue;
    const value = fields[key];
    if (value === undefined) delete target[key];
    else (target as Record<string, unknown>)[key] = value;
  }
}

/** A plain snapshot of a draft (unmodified parts keep their identity); other values as they are. */
const plain = <T>(value: T): T => (isDraft(value) ? (current(value as Draft<T>) as T) : value);

/** True when the entry holds nothing worth keeping. */
export function isEmptyPhoto(photo: LibraryPhoto | Draft<LibraryPhoto>): boolean {
  return (
    photo.rating === undefined &&
    photo.flag === undefined &&
    photo.develop === undefined &&
    Object.keys(photo.versions).length === 0 &&
    // The photo index (plan 33) is worth keeping on its own.
    photo.ai === undefined &&
    // So is a cull group override (plan 39).
    photo.cull?.group === undefined
  );
}

/**
 * The folder path `asset` lives in. `primary` is the open project's primary folder: an asset in the book's entry for it
 * (`openFolderId`) is there; any other asset is in the path of its own `book.folders` entry (`primary` when unknown).
 */
export function assetFolderPath(
  book: Pick<Book, 'folders'> | Draft<Pick<Book, 'folders'>> | null,
  asset: Pick<Asset, 'folder'> | undefined,
  primary: string | null,
): string | null {
  const id = asset?.folder;
  if (!book || id === undefined || !Object.hasOwn(book.folders, id)) return primary;
  if (primary !== null && id === openFolderId(book as Pick<Book, 'folders'>, primary)) return primary;
  return book.folders[id]?.path ?? primary;
}

/**
 * The folder path of photo id `assetId` (`assetFolderPath` for a project asset, the folder of a library key), for
 * commands that take a folder.
 */
export function assetFolder(view: Pick<LibraryView, 'book' | 'folder'>, assetId: string): string | null {
  if (isPhotoKey(assetId) && !view.book?.assets[assetId]) return libraryPathOfKey(assetId);
  return assetFolderPath(view.book, view.book?.assets[assetId], view.folder);
}

/** The absolute folder path of a library photo key (null when its folder is not known). */
function libraryPathOfKey(key: string): string | null {
  const parsed = parsePhotoKey(key);
  return (parsed && useLibraryStore.getState().folders[parsed.folder]?.path) ?? null;
}

/** What the commands and the crop maths need of a photo id: folder path, path in it, hash and upright size. */
export interface PhotoMeta {
  /** Absolute folder path. */
  folder: string | null;
  path: string;
  hash?: string;
  width?: number;
  height?: number;
  orientation?: number;
}

/**
 * Folder, path, hash and size of a photo id: a project asset's record (the scanned file fills what it lacks), or a
 * library key's file. Undefined for an unknown id.
 */
export function photoMeta(view: Pick<LibraryView, 'book' | 'folder'>, id: string): PhotoMeta | undefined {
  const asset = view.book?.assets[id];
  if (asset) {
    return {
      folder: assetFolderPath(view.book, asset, view.folder),
      path: asset.path,
      hash: asset.hash,
      width: asset.width,
      height: asset.height,
      orientation: asset.orientation,
    };
  }
  const parsed = parsePhotoKey(id);
  if (!parsed) return undefined;
  const folder = useLibraryStore.getState().folders[parsed.folder];
  const photo = folder?.photos[parsed.path];
  if (!folder || !photo) return undefined;
  return {
    folder: folder.path,
    path: photo.relPath,
    hash: photo.hash,
    width: photo.width,
    height: photo.height,
    orientation: photo.orientation,
  };
}

/** True when `id` is an asset of the open book or a library key whose photo is hashed (so it can be edited). */
export function hasPhoto(view: Pick<LibraryView, 'book' | 'folder'>, id: string): boolean {
  if (view.book?.assets[id]) return true;
  return isPhotoKey(id) && photoMeta(view, id)?.hash !== undefined;
}

/** The library entry a library key reads and writes: its folder's library, by the photo's hash. */
function entryOfKey(view: Pick<LibraryView, 'libraries'>, key: string): LibraryPhoto | undefined {
  const parsed = parsePhotoKey(key);
  const folder = parsed ? useLibraryStore.getState().folders[parsed.folder] : undefined;
  const hash = parsed ? folder?.photos[parsed.path]?.hash : undefined;
  const photos = folder ? view.libraries[folder.path]?.photos : undefined;
  return hash && photos && Object.hasOwn(photos, hash) ? photos[hash] : undefined;
}

/**
 * The rating, flag and develop of a photo id as one stable object (for selectors): the resolved asset of the open
 * book (`resolvedAssets`), or a library key's entry (whose `develop` is the master edit). Undefined when it has none.
 */
export function photoFields(
  view: LibraryView,
  id: string,
): Pick<LibraryPhoto, 'rating' | 'flag' | 'develop'> | undefined {
  if (view.book?.assets[id]) return resolvedAssets(view)?.[id];
  return isPhotoKey(id) ? entryOfKey(view, id) : undefined;
}

/** The library entry of `asset` in its folder's library, if it is hashed and has one. */
export function photoOf(view: LibraryView, asset: Asset | undefined): LibraryPhoto | undefined {
  const hash = asset?.hash;
  const folder = assetFolderPath(view.book, asset, view.folder);
  if (!hash || !folder) return undefined;
  const photos = view.libraries[folder]?.photos;
  return photos && Object.hasOwn(photos, hash) ? photos[hash] : undefined;
}

/**
 * The develop settings an asset renders with (`resolveAssetDevelop`): the project's snapshot, else its library entry
 * (the asset's `version` or the master edit), else the book's field. Develop's version choice for this id
 * (`developVersion`) takes the place of the asset's `version`; a library key reads the master or the chosen version.
 */
export function assetDevelop(view: LibraryView, assetId: string): DevelopSettings | undefined {
  const asset = view.book?.assets[assetId];
  const choice = view.developVersion?.id === assetId ? view.developVersion : null;
  if (!asset) {
    return isPhotoKey(assetId) ? resolveDevelop(entryOfKey(view, assetId), choice?.version ?? undefined) : undefined;
  }
  const ref = choice ? { ...asset, version: choice.version ?? undefined } : asset;
  return resolvePhotoDevelop(ref, photoOf(view, asset));
}

/** The library entry of a photo id: a project asset's (`photoOf`), or a library key's. Undefined when it has none. */
export function libraryEntryOf(view: LibraryView, id: string): LibraryPhoto | undefined {
  const asset = view.book?.assets[id];
  if (asset) return photoOf(view, asset);
  return isPhotoKey(id) ? entryOfKey(view, id) : undefined;
}

/**
 * The version Develop shows and edits for photo id `id` (undefined: the master): Develop's choice for it
 * (`developVersion`), else a project asset's own `version`. Only a version the entry still has counts.
 */
export function editedVersion(view: LibraryView, id: string): string | undefined {
  const choice = view.developVersion?.id === id ? view.developVersion : null;
  const version = choice ? (choice.version ?? undefined) : view.book?.assets[id]?.version;
  if (version === undefined) return undefined;
  const entry = libraryEntryOf(view, id);
  return entry && Object.hasOwn(entry.versions, version) ? version : undefined;
}

/** Version ids of an entry in creation order (they are ULIDs). */
export const versionIds = (photo: LibraryPhoto | undefined): string[] => Object.keys(photo?.versions ?? {}).sort();

/** The first free default name: `v2`, `v3`, … (the master counts as v1). */
export function nextVersionName(photo: LibraryPhoto | undefined): string {
  const names = new Set(Object.values(photo?.versions ?? {}).map((v) => v.name));
  let n = 2;
  while (names.has(`v${n}`)) n++;
  return `v${n}`;
}

const versionNamesMemo = new WeakMap<
  object,
  { libraries: Record<string, Library>; folder: string | null; names: Record<string, string> }
>();
const NO_VERSION_NAMES: Record<string, string> = {};

/**
 * The name of the version each asset of the open book uses, by asset id (only assets whose `version` the library still
 * has): the filmstrip's and the Develop strip's `v2` badge. Memoized like `resolvedAssets`, so it is safe in a selector.
 */
export function assetVersionNames(view: LibraryView): Record<string, string> {
  const assets = view.book?.assets;
  if (!assets) return NO_VERSION_NAMES;
  const memo = versionNamesMemo.get(assets);
  if (memo && memo.libraries === view.libraries && memo.folder === view.folder) return memo.names;
  let names = NO_VERSION_NAMES;
  for (const [id, asset] of Object.entries(assets)) {
    if (asset.version === undefined) continue;
    const name = photoOf(view, asset)?.versions[asset.version]?.name;
    if (name === undefined) continue;
    if (names === NO_VERSION_NAMES) names = {};
    names[id] = name;
  }
  versionNamesMemo.set(assets, { libraries: view.libraries, folder: view.folder, names });
  return names;
}

/** The asset's star rating (library first). */
export function assetRating(view: LibraryView, assetId: string): number | undefined {
  const asset = view.book?.assets[assetId];
  if (!asset && isPhotoKey(assetId)) return entryOfKey(view, assetId)?.rating;
  const photo = photoOf(view, asset);
  return photo ? photo.rating : asset?.rating;
}

/** The asset's pick or reject flag (library first). */
export function assetFlag(view: LibraryView, assetId: string): AssetFlag | undefined {
  const asset = view.book?.assets[assetId];
  if (!asset && isPhotoKey(assetId)) return entryOfKey(view, assetId)?.flag;
  const photo = photoOf(view, asset);
  return photo ? photo.flag : asset?.flag;
}

/**
 * `asset` with the library entry's rating and flag and its resolved develop (`resolvePhotoDevelop`); the same object
 * when they already match.
 */
export function overlayAsset(asset: Asset, photo: LibraryPhoto | undefined): Asset {
  if (!photo && !asset.developSnapshot) return asset;
  const develop = resolvePhotoDevelop(asset, photo);
  if (!photo) {
    if (asset.develop === develop) return asset;
    const next: Asset = { ...asset };
    applyFields(next, { develop });
    return next;
  }
  const same =
    asset.rating === photo.rating &&
    asset.flag === photo.flag &&
    (asset.develop === develop || deepEqual(asset.develop, develop));
  if (same) return asset;
  const next: Asset = { ...asset };
  applyFields(next, { rating: photo.rating, flag: photo.flag, develop });
  return next;
}

const resolvedMemo = new WeakMap<
  object,
  { libraries: Record<string, Library>; folder: string | null; assets: Book['assets'] }
>();

/**
 * `book.assets` read through the libraries (`overlayAsset` per asset, each through its folder's library). Memoized per
 * (assets, libraries, folder) and the same object as `book.assets` while the mirror is in sync, so it is safe in a
 * store selector.
 */
export function resolvedAssets(view: LibraryView): Book['assets'] | undefined {
  const assets = view.book?.assets;
  if (!assets) return assets;
  const memo = resolvedMemo.get(assets);
  if (memo && memo.libraries === view.libraries && memo.folder === view.folder) return memo.assets;
  let changed = false;
  const out: Book['assets'] = {};
  for (const [id, asset] of Object.entries(assets)) {
    const next = overlayAsset(asset, photoOf(view, asset));
    if (next !== asset) changed = true;
    out[id] = next;
  }
  const result = changed ? out : assets;
  resolvedMemo.set(assets, { libraries: view.libraries, folder: view.folder, assets: result });
  return result;
}

const bookMemo = new WeakMap<Book, { assets: Book['assets']; book: Book }>();

/** The open book with its assets read through the library (`resolvedAssets`): what publishing renders and fingerprints. */
export function libraryBook(view: LibraryView): Book | null {
  const book = view.book;
  if (!book) return null;
  const assets = resolvedAssets(view) ?? book.assets;
  if (assets === book.assets) return book;
  const memo = bookMemo.get(book);
  if (memo?.assets === assets) return memo.book;
  const next = { ...book, assets };
  bookMemo.set(book, { assets, book: next });
  return next;
}

/**
 * The book as it is written to the project file: the mirror of `rating`, `flag` and `develop` is left out of every
 * hashed asset whose folder's library holds the edits (`libraryHoldsEdits`; `folder` is the open project's primary
 * folder), so the file references photos by hash and folder and the publish CLI resolves them through each folder's
 * `library.json`. An unhashed asset keeps its fields until the scan hashes it and they are lifted. The same object when
 * nothing is left out.
 */
export function bookForDisk(view: Pick<LibraryView, 'libraries'>, book: Book, folder: string | null): Book {
  let changed = false;
  const assets: Book['assets'] = {};
  for (const [id, asset] of Object.entries(book.assets)) {
    if (
      !asset.hash ||
      (asset.rating === undefined && asset.flag === undefined && asset.develop === undefined) ||
      !libraryHoldsEdits(view, assetFolderPath(book, asset, folder))
    ) {
      assets[id] = asset;
      continue;
    }
    const { rating: _rating, flag: _flag, develop: _develop, ...rest } = asset;
    assets[id] = rest;
    changed = true;
  }
  return changed ? { ...book, assets } : book;
}

/**
 * The id of the open folder in `book.folders`: the entry whose path is `folder`, else the book's first folder (one
 * folder per book for now). Undefined for a book without folders.
 */
export function openFolderId(book: Pick<Book, 'folders'> | null, folder: string | null): string | undefined {
  if (!book) return undefined;
  const entries = Object.entries(book.folders);
  return (entries.find(([, f]) => f.path === folder) ?? entries[0])?.[0];
}

/** `asset` with a folder: its own, else the one it replaces (`prev`), else `folderId` (the open folder). */
export function withFolder(asset: AssetDraft, prev: Asset | undefined, folderId: string | undefined): Asset {
  const folder = asset.folder ?? prev?.folder ?? folderId;
  if (folder === undefined) throw new Error('The book has no folder to put the photo in');
  return asset.folder === folder ? (asset as Asset) : { ...asset, folder };
}

// Draft helpers, for Immer recipes of the book store ------------------------------------------------

/** Edit (or create) one entry; an entry left empty is removed. */
export function patchPhotoDraft(
  s: Draft<Pick<LibraryView, 'libraries'>>,
  folder: string,
  hash: string,
  fn: (photo: Draft<LibraryPhoto>) => void,
): void {
  s.libraries[folder] ??= emptyLibrary();
  const library = s.libraries[folder];
  library.photos[hash] ??= { versions: {} };
  const photo = library.photos[hash];
  fn(photo);
  if (isEmptyPhoto(photo)) delete library.photos[hash];
}

/** The plain (non-draft) base of a draft, else the value itself: reading it drafts nothing. */
const base = <T extends object>(value: Draft<T> | T): T =>
  isDraft(value) ? (original(value as Draft<T>) as T) : (value as T);

/**
 * Ids of the assets in folder `folder` with content hash `hash`, plus `include`. Scans the plain base objects of the
 * draft, so a slider frame touches (and drafts) only the matching assets, not every asset of the book.
 */
function idsWithHash(s: Draft<LibraryView>, folder: string, hash: string, include?: string): string[] {
  if (!s.book) return [];
  const assets = base<Book['assets']>(s.book.assets);
  const ids = include === undefined ? [] : [include];
  for (const [id, asset] of Object.entries(assets)) {
    if (asset.hash === hash && id !== include && assetFolderPath(s.book, asset, s.folder) === folder) ids.push(id);
  }
  return ids;
}

/** Apply `fields` to every asset of the book in `folder` whose hash is `hash` (the mirror). */
function mirrorFields(
  s: Draft<LibraryView>,
  folder: string,
  hash: string,
  fields: PhotoFields,
  include?: string,
): void {
  for (const id of idsWithHash(s, folder, hash, include)) {
    const asset = s.book?.assets[id];
    if (asset?.hash === hash) applyFields(asset, fields);
  }
}

/** Copy `folder`'s entry for `hash` (absent: no fields) onto every asset of the open book in that folder with that hash. */
export function mirrorPhoto(s: Draft<LibraryView>, folder: string, hash: string): void {
  if (!s.book) return;
  const entry = s.libraries[folder]?.photos[hash];
  const photo = entry ? plain(entry) : undefined;
  mirrorFields(s, folder, hash, { rating: photo?.rating, flag: photo?.flag, develop: resolveDevelop(photo) });
}

/**
 * The library folder an asset's fields go to: its folder, when that library is loaded (the primary folder's always
 * counts, its library is created on the first edit). Null when there is none: the fields stay on the book.
 */
function writableFolder(s: Draft<LibraryView>, asset: Asset | Draft<Asset>): string | null {
  const folder = assetFolderPath(s.book, asset, s.folder);
  if (!folder) return null;
  return folder === s.folder || Object.hasOwn(s.libraries, folder) ? folder : null;
}

/**
 * Write-through: set `fields` on the asset's library entry (in its folder's library) and on every book asset of that
 * folder with the same hash (the mirror). An asset without a hash (or whose folder's library is not loaded) gets them
 * on the book only, until `reconcileAsset` lifts them. `develop` must be a plain (non-draft) value.
 *
 * While the photo shows a version (`editedVersion`: Develop's choice, or the project asset's `version`), `develop`
 * goes to that version instead of the master (`undefined` stores the defaults: a version always has settings) and is
 * not mirrored, since the mirror holds the master.
 */
export function writePhotoFields(s: Draft<LibraryView>, assetId: string, fields: PhotoFields): void {
  const book = s.book;
  const asset = book?.assets[assetId];
  if (!asset && isPhotoKey(assetId)) {
    writeKeyFields(s, assetId, fields);
    return;
  }
  if (!book || !asset) return;
  const hash = asset.hash;
  const folder = writableFolder(s, asset);
  if (!hash || !folder) {
    applyFields(asset, fields);
    return;
  }
  const { master, version } = splitVersionWrite(s, assetId, fields);
  patchPhotoDraft(s, folder, hash, (photo) => applyPhotoWrite(photo, master, version));
  mirrorFields(s, folder, hash, master, assetId);
}

/** A write split into the fields of the entry itself and, while a version is shown, that version's settings. */
function splitVersionWrite(
  s: Draft<LibraryView>,
  id: string,
  fields: PhotoFields,
): { master: PhotoFields; version: { id: string; develop: DevelopSettings } | null } {
  if (!('develop' in fields)) return { master: fields, version: null };
  const versionId = editedVersion(s as LibraryView, id);
  if (versionId === undefined) return { master: fields, version: null };
  const { develop, ...master } = fields;
  return { master, version: { id: versionId, develop: develop ?? createDevelop() } };
}

function applyPhotoWrite(
  photo: Draft<LibraryPhoto>,
  master: PhotoFields,
  version: { id: string; develop: DevelopSettings } | null,
): void {
  applyFields(photo, master);
  const target = version ? photo.versions[version.id] : undefined;
  if (!version || !target || deepEqual(plain(target.develop), version.develop)) return;
  target.develop = version.develop;
}

/**
 * `writePhotoFields` for a library key: the entry of the photo's hash in its folder's library, then the mirror. Refused
 * (logged) while the photo has no hash or its folder's library is not loaded: an empty library written now would
 * replace the one on disk.
 */
function writeKeyFields(s: Draft<LibraryView>, key: string, fields: PhotoFields): void {
  const parsed = parsePhotoKey(key);
  const folder = parsed ? useLibraryStore.getState().folders[parsed.folder] : undefined;
  const hash = parsed ? folder?.photos[parsed.path]?.hash : undefined;
  if (!folder || !hash || !Object.hasOwn(s.libraries, folder.path)) {
    devLog('library', 'edit not written', { photo: key, reason: hash ? 'library not loaded' : 'not hashed yet' });
    return;
  }
  const { master, version } = splitVersionWrite(s, key, fields);
  patchPhotoDraft(s, folder.path, hash, (photo) => applyPhotoWrite(photo, master, version));
  mirrorFields(s, folder.path, hash, master);
}

/**
 * Where photo id `id`'s library entry is written: its folder path and hash, or null when there is no library to hold
 * it (not hashed yet, or its folder's library is not loaded), as `writePhotoFields` decides.
 */
export function photoEntryPlace(
  s: Draft<LibraryView> | LibraryView,
  id: string,
): { folder: string; hash: string } | null {
  const asset = s.book?.assets[id];
  if (asset) {
    const folder = writableFolder(s as Draft<LibraryView>, asset);
    return asset.hash && folder ? { folder, hash: asset.hash } : null;
  }
  const parsed = parsePhotoKey(id);
  const folder = parsed ? useLibraryStore.getState().folders[parsed.folder] : undefined;
  const hash = parsed ? folder?.photos[parsed.path]?.hash : undefined;
  return folder && hash && Object.hasOwn(s.libraries, folder.path) ? { folder: folder.path, hash } : null;
}

/** True when the book asset's mirror already holds the entry's fields (the master edit: the mirror never holds a version). */
function mirrors(asset: Asset, photo: LibraryPhoto): boolean {
  const develop = resolveDevelop(photo);
  return (
    asset.rating === photo.rating &&
    asset.flag === photo.flag &&
    (asset.develop === develop || deepEqual(asset.develop, develop))
  );
}

/** What `reconcileAsset` did: lifted book fields into the entry, and/or restored entry fields onto the book. */
export interface ReconcileOutcome {
  lifted: boolean;
  restored: boolean;
}

/**
 * Bring a hashed asset and its library entry together, field by field: a field the book has and the entry lacks is
 * lifted into the entry (created when missing), then every field of the entry is copied onto the asset (so a field
 * both have takes the entry's value). A book `rating: 3` is never cleared by an entry that only holds `develop`. Two
 * different edits (entry and book) log a `conflict` line with the hash; the entry's is kept.
 */
export function reconcileAsset(s: Draft<LibraryView>, assetId: string): ReconcileOutcome {
  const outcome: ReconcileOutcome = { lifted: false, restored: false };
  const draft = s.book?.assets[assetId];
  const folder = draft ? writableFolder(s, draft) : null;
  if (!draft?.hash || !folder) return outcome;
  const asset = plain(draft);
  const hash = draft.hash;
  const existing = s.libraries[folder]?.photos[hash];
  const before = existing ? plain(existing) : undefined;
  // Both hold an edit and they differ (a v7 book edited by an older build after its library was written): the entry
  // wins, but say so, naming the photo.
  if (before?.develop && asset.develop && !deepEqual(before.develop, asset.develop)) {
    devLog('library', 'conflict', { hash, folder, assetId, kept: 'library' });
  }
  const lift: PhotoFields = {};
  for (const key of FIELD_KEYS) {
    if (asset[key] !== undefined && before?.[key] === undefined) (lift as Record<string, unknown>)[key] = asset[key];
  }
  if (Object.keys(lift).length > 0) {
    patchPhotoDraft(s, folder, hash, (photo) => applyFields(photo, lift));
    outcome.lifted = true;
  }
  const entry = s.libraries[folder]?.photos[hash];
  const photo = entry ? plain(entry) : undefined;
  if (!photo || mirrors(asset, photo)) return outcome;
  // A value just assigned into the draft (fillAssets) is the caller's object, possibly frozen: write a copy.
  let target = draft;
  if (!isDraft(draft) && s.book) {
    target = { ...draft };
    s.book.assets[assetId] = target;
  }
  applyFields(target, { rating: photo.rating, flag: photo.flag, develop: resolveDevelop(photo) });
  outcome.restored = true;
  return outcome;
}

/**
 * Open: reconcile every hashed asset of `book` with its folder's library in `libraries` (`reconcileAsset`; `folder` is
 * the primary folder). Returns the book and libraries to store (a library that gained lifted fields is a new object and
 * must then be saved), and how many assets lifted fields into a library or had fields restored from one (the book must
 * then be saved: its mirror differs from the file).
 */
export function syncBookWithLibraries(
  folder: string,
  book: Book,
  libraries: Record<string, Library>,
): { book: Book; libraries: Record<string, Library>; lifted: number; restored: number } {
  let lifted = 0;
  let restored = 0;
  const next = produce({ book, folder, libraries } as LibraryView, (s) => {
    for (const id of Object.keys(s.book?.assets ?? {})) {
      const outcome = reconcileAsset(s, id);
      if (outcome.lifted) lifted++;
      if (outcome.restored) restored++;
    }
  });
  return { book: next.book ?? book, libraries: next.libraries, lifted, restored };
}

/** `syncBookWithLibraries` for a book on one folder. */
export function syncBookWithLibrary(
  folder: string,
  book: Book,
  library: Library,
): { book: Book; library: Library; lifted: number; restored: number } {
  const synced = syncBookWithLibraries(folder, book, { [folder]: library });
  return { ...synced, library: synced.libraries[folder] ?? library };
}

/**
 * The newest versions with the settings of the restored state: which versions exist and their names are not history
 * (made, renamed and deleted versions stay); a version's settings are an edit, so undo restores them. The same object
 * when nothing changes.
 */
function restoredVersions(
  newest: LibraryPhoto['versions'],
  restored: LibraryPhoto['versions'] | undefined,
): LibraryPhoto['versions'] {
  if (!restored || newest === restored) return newest;
  let out = newest;
  for (const [id, version] of Object.entries(newest)) {
    const back = Object.hasOwn(restored, id) ? restored[id] : undefined;
    if (!back || back.develop === version.develop) continue;
    if (out === newest) out = { ...newest };
    out[id] = { ...version, develop: back.develop };
  }
  return out;
}

/**
 * Undo / redo across the library. Ratings, flags and the list of versions are never history, so they stay the newest
 * (`before`); develop (the master's and each version's, `restoredVersions`) is the edit being undone or redone, so it
 * comes from the restored state: its library entry,
 * else (the entry did not exist yet) the develop of the merged book's asset with that hash, which is the restored
 * book field, else none. `merged` is the book after the asset metadata merge of `applyHistory` (null in the library,
 * with no project open).
 */
export function mergeLibrariesForHistory(
  before: Record<string, Library>,
  after: Record<string, Library>,
  merged: Book | null,
  folder: string | null,
): Record<string, Library> {
  // The merged book's assets by folder path and hash: a library's restored develop falls back to its own folder's asset.
  const byHash = new Map<string, Asset>();
  for (const asset of Object.values(merged?.assets ?? {})) {
    const key = `${assetFolderPath(merged, asset, folder)}\n${asset.hash}`;
    if (asset.hash && !byHash.has(key)) byHash.set(key, asset);
  }
  const out: Record<string, Library> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const kept = before[name];
    // A library created after the restored state (the first edit made it) restores as an empty one.
    const restored = after[name] ?? emptyLibrary();
    if (!kept) {
      out[name] = restored;
      continue;
    }
    if (kept === restored) {
      out[name] = kept;
      continue;
    }
    const photos: Library['photos'] = {};
    for (const hash of new Set([...Object.keys(kept.photos), ...Object.keys(restored.photos)])) {
      const newest = kept.photos[hash];
      const back = restored.photos[hash];
      const key = `${name}\n${hash}`;
      // No entry in the restored state: the book's asset says what the photo had then. A photo no asset holds (edited
      // through its library key) had nothing then when its library was loaded in the restored state; when it was not
      // loaded yet (read after, untracked) the newest value stays.
      const develop = back
        ? back.develop
        : byHash.has(key)
          ? byHash.get(key)?.develop
          : after[name] !== undefined
            ? undefined
            : newest?.develop;
      const base = newest ?? back;
      if (!base) continue;
      const versions = restoredVersions(base.versions, back?.versions);
      const photo: LibraryPhoto = { ...base, versions };
      applyFields(photo, { develop });
      if (!isEmptyPhoto(photo)) photos[hash] = base.develop === develop && versions === base.versions ? base : photo;
    }
    out[name] = { ...kept, photos };
  }
  return out;
}

// Reading and writing ----------------------------------------------------------------------------

/**
 * Read and parse `folder`'s library. A folder without one gets an empty library. One that does not parse (bad JSON, a
 * bad entry, a missing or unknown version) falls back to `library.json.bak` (logging the first bad photo), by the rule
 * the publish CLI shares (`libraryBackupAllowed`). One written by a newer Photobook, or one with no usable backup,
 * starts empty, logged, and is marked unwritable (`isLibraryWritable`) so the file is never overwritten.
 */
export async function readFolderLibrary(folder: string): Promise<Library> {
  const library = await readLibraryFile(folder);
  readFromDisk.add(library);
  return library;
}

async function readLibraryFile(folder: string): Promise<Library> {
  let text: string | null;
  try {
    text = await readLibrary(folder);
  } catch (err) {
    unwritable.add(folder);
    devLog('library', 'read failed', { folder, error: errorMessage(err) });
    return emptyLibrary();
  }
  if (text === null) {
    unwritable.delete(folder);
    return emptyLibrary();
  }
  try {
    const library = parseLibrary(text);
    unwritable.delete(folder);
    devLog('library', 'loaded', { folder, photos: Object.keys(library.photos).length });
    return library;
  } catch (err) {
    // The shared rule (`libraryBackupAllowed`, the publish CLI uses it too): any problem falls back to the backup except
    // a library written by a newer Photobook, which stays unwritable.
    if (libraryBackupAllowed(err)) {
      if (err instanceof LibraryLoadError && err.kind === 'schema') {
        devLog('library', 'invalid entry', { folder, photo: err.photo ?? null, error: err.message });
      } else {
        devLog('library', 'not parsed', { folder, error: errorMessage(err) });
      }
      const backup = await readBackup(folder);
      if (backup) {
        unwritable.delete(folder);
        devLog('library', 'using the previous version (library.json.bak)', {
          folder,
          photos: Object.keys(backup.photos).length,
        });
        return backup;
      }
    }
    unwritable.add(folder);
    devLog('library', 'not loaded; it will not be written this session', { folder, error: errorMessage(err) });
    return emptyLibrary();
  }
}

/** `library.json.bak`, parsed, or null when there is none or it does not parse either. */
async function readBackup(folder: string): Promise<Library | null> {
  try {
    const text = await readLibraryBackup(folder);
    return text === null ? null : parseLibrary(text);
  } catch (err) {
    devLog('library', 'backup not usable', { folder, error: errorMessage(err) });
    return null;
  }
}

type SliceSet = (recipe: (draft: Draft<LibraryView>) => void) => void;

/** The library actions of the book store. `untracked` runs a change without recording undo history. */
export function createLibrarySlice(
  set: SliceSet,
  get: () => LibraryView,
  untracked: (fn: () => void) => void,
): LibrarySlice {
  return {
    libraries: {},

    loadLibrary: async (folder) => {
      const absent = !Object.hasOwn(get().libraries, folder);
      const library = await readFolderLibrary(folder);
      untracked(() =>
        set((s) => {
          // Absent when this read started but loaded meanwhile (a project opened while it ran): that one is current
          // and may already hold edits, so this older read is dropped. Reloading a loaded library replaces it.
          if (absent && Object.hasOwn(s.libraries, folder)) return;
          s.libraries[folder] = library;
          for (const id of Object.keys(s.book?.assets ?? {})) {
            const asset = s.book?.assets[id];
            if (asset && assetFolderPath(s.book, asset, s.folder) === folder) {
              reconcileAsset(s, id);
            }
          }
        }),
      );
      return get().libraries[folder] ?? library;
    },

    patchPhoto: (folder, hash, fn) =>
      set((s) => {
        patchPhotoDraft(s, folder, hash, fn);
        mirrorPhoto(s, folder, hash);
      }),

    patchLibrary: (folder, fn) => {
      if (!Object.hasOwn(get().libraries, folder)) {
        devLog('library', 'library edit not written', { folder, reason: 'library not loaded' });
        return;
      }
      untracked(() =>
        set((s) => {
          const library = s.libraries[folder];
          if (library) fn(library);
        }),
      );
    },

    saveLibrary: async (folder) => {
      const library = get().libraries[folder];
      if (!library || !isLibraryWritable(folder)) return;
      await writeLibrary(folder, serializeLibrary(library));
      devLog('library', 'written', { folder, photos: Object.keys(library.photos).length });
    },

    dropPhotos: async (folderId, relPaths) => {
      const folder = forgetPhotos(folderId, relPaths);
      if (!folder) return;
      const { path, orphans, left } = folder;
      if (orphans.length > 0 && Object.hasOwn(get().libraries, path)) {
        untracked(() =>
          set((s) => {
            const library = s.libraries[path];
            if (library) for (const hash of orphans) delete library.photos[hash];
          }),
        );
      }
      try {
        await writeIndex(path, indexOf(left));
      } catch (err) {
        devLog('library', 'index not written', { folder: path, error: errorMessage(err) });
      }
      devLog('library', 'dropped', { folder: path, photos: relPaths.length, entries: orphans.length });
    },
  };
}

// Folder photos (workflow plan 05) ----------------------------------------------------------------

/**
 * A photo anywhere in the UI: its imported folder (the registry id), its path in that folder and its content hash.
 * Cull and Develop work on refs; a project asset is a ref plus an id (`{ id: newId(), ...ref }`).
 */
export interface PhotoRef {
  folder: string;
  path: string;
  hash: string;
}

/**
 * The UI key of a photo (selection, sessions, renders): `${folder}/${path}`. A photo id in Review and Develop is
 * either such a key (the library, no project needed) or a project asset id (inside a project, where the asset's
 * version or snapshot applies). Asset ids are ULIDs and never contain a `/`.
 */
export const photoKey = (ref: Pick<PhotoRef, 'folder' | 'path'>): string => `${ref.folder}/${ref.path}`;

/** `photoKey` back into its folder id and path; null for anything else (a project asset id). */
export function parsePhotoKey(id: string): { folder: string; path: string } | null {
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) return null;
  return { folder: id.slice(0, at), path: id.slice(at + 1) };
}

/** True for a library photo key, false for a project asset id. */
export const isPhotoKey = (id: string): boolean => parsePhotoKey(id) !== null;

/** scanned -> hashing -> preparing (thumbnail and proxy) -> ready, or error at any step. */
export type PhotoStatus = 'scanned' | 'hashing' | 'preparing' | 'ready' | 'error';

/** A `render_develop_cached` result as webview URLs. */
export interface DevelopedFile {
  developHash: string;
  /** `developedKey` of the settings and output profile it was rendered for (sync to compare, unlike the SHA-256). */
  input: string;
  thumbUrl: string;
  proxyUrl: string;
  /** Pixel size of the developed proxy. */
  width: number;
  height: number;
  /** Denoise is on for these settings but its intermediate was missing, so the render used the source (step D5.2). */
  denoiseStale?: boolean;
  /** The look's LUT file was missing, so the render left it out; redone when the LUT comes back (plan 18). */
  lutMissing?: boolean;
}

/**
 * The keys of `PhotoFacts` (plan 38), in the order the index compares them. A later index field is added to
 * `PhotoFacts` and here, and every copy between the scan, `prepare_asset`, the store and the index follows.
 */
export const PHOTO_FACT_KEYS = [
  'taken',
  'make',
  'model',
  'lens',
  'focal',
  'phash',
  'stats',
  'shutter',
  'aperture',
  'gps',
  'palette',
] as const satisfies readonly (keyof PhotoFacts)[];

/** The `PhotoFacts` fields `from` has (absent ones left out, so spreading it never clears a known value). */
export function photoFacts(from: PhotoFacts): PhotoFacts {
  const out: Record<string, unknown> = {};
  for (const key of PHOTO_FACT_KEYS) if (from[key] !== undefined && from[key] !== null) out[key] = from[key];
  return out as PhotoFacts;
}

/** When the photo was taken (Exif, plan 38), else its file's modification time: what *capture time* sorts by. */
export function captureTime(photo: Pick<PhotoFile, 'taken' | 'mtime'>): number {
  return photo.taken ?? photo.mtime;
}

/** One photo file of an imported folder, as scanning, hashing and preparing found it. */
export interface PhotoFile extends PhotoFacts {
  /** Relative to its folder, `/`-separated. */
  relPath: string;
  size: number;
  /** Modification time, epoch ms. Stands in for capture time when the Exif has none (`captureTime`). */
  mtime: number;
  kind: AssetKind;
  hash?: string;
  /** Upright pixel size of the original. */
  width?: number;
  height?: number;
  orientation?: number;
  /** ISO speed from the file's Exif (`prepare_asset`, kept in the index; plan 23). */
  iso?: number;
  /**
   * σ at mid-grey of the photo's measured noise profile (plan 23): from `prepare_asset` once `noise_profile` has run,
   * kept in the index. The "Needs denoise" collection prefers it to the ISO.
   */
  noise?: number;
  thumbUrl?: string;
  proxyUrl?: string;
  /** A camera RAW (from the scan's kind; `prepare_asset` confirms it). It always shows and publishes a develop render. */
  isRaw?: boolean;
  /** RAW only: the as-shot white balance `[Kelvin, tint]` (from `prepare_asset`), where Absolute white balance starts. */
  asShot?: [number, number];
  /**
   * The cached develop renders recorded for this file (the last `KEEP_DEVELOPED`, oldest first), by
   * `DevelopedFile.input`. Read it with `currentDeveloped`, which picks the one for the photo's settings.
   */
  developed?: Record<string, DevelopedFile>;
  /** `renderDeveloped` is running for this file. */
  rendering?: boolean;
  status: PhotoStatus;
  error?: string;
}

export interface PhotosProgress {
  /** Files with a hash (from the index, trusted or computed), errors included. */
  hashed: number;
  /** Files whose thumbnail and proxy are ready, errors included. */
  prepared: number;
  total: number;
}

/** One imported folder's photos in this session. */
export interface LibraryFolder {
  /** Registry id (the key of `folders`). */
  id: string;
  /** Absolute path. */
  path: string;
  /** By relative path. */
  photos: Record<string, PhotoFile>;
  progress: PhotosProgress;
  /** From scan start until every file is hashed and prepared. */
  busy: boolean;
  /** Scan-level failure (the folder is unreadable); per-file errors live on the file. */
  error: string | null;
  /** A scan of the folder ran to the end in this session. */
  scanned: boolean;
}

/** What a caller already knows of a file (a project's asset record): trusted while size and mtime match. */
export interface KnownPhoto {
  hash: string;
  size?: number;
  mtime?: number;
  width?: number;
  height?: number;
  orientation?: number;
}

export interface ScanOptions {
  /** Scan even when a scan of this folder already finished in this session. */
  force?: boolean;
  /** Hashes known elsewhere by relative path, trusted like an index entry. */
  known?: Record<string, KnownPhoto>;
}

export interface LibraryState {
  /** Imported folders whose photos are known this session, by registry id. */
  folders: Record<string, LibraryFolder>;
  /** Make sure `folders[id]` exists for `path` (nothing is read). */
  addFolder: (id: string, path: string) => void;
  /**
   * Fill a folder that has no photos yet from its `index.json` (no thumbnails, status `scanned`), so counts and
   * collections are known without scanning. Never rejects.
   */
  loadIndex: (id: string) => Promise<void>;
  /**
   * Scan, hash and prepare the folder (`scan_folder` with the index, `hash_files` for files it does not describe,
   * `prepare_asset` per hash), then write the index back when it learned something. One folder at a time; a call for
   * a folder being scanned joins it, one for a folder already scanned this session does nothing unless `force`.
   */
  scan: (id: string, options?: ScanOptions) => Promise<void>;
  /**
   * Make thumbnails and proxies for these hashed photos of a folder whose index was read but which was not scanned
   * (a collection shows a few photos of many folders; scanning them all would hash and prepare everything). Photos
   * already ready, being prepared or without a hash are skipped. Resolves when they are done.
   */
  prepare: (id: string, relPaths: readonly string[]) => Promise<void>;
  /** Merge `patch` into one photo (no-op when the folder or the photo is unknown). */
  patchPhoto: (id: string, relPath: string, patch: Partial<PhotoFile>) => void;
  /** Stop every scan and forget every folder (tests). */
  reset: () => void;
}

const PREPARE_CONCURRENCY = 4;
const EMPTY_PHOTOS_PROGRESS: PhotosProgress = { hashed: 0, prepared: 0, total: 0 };

/** Listeners told about every photo `prepare_asset` just made ready (the assets store renders RAW bases and edits). */
const preparedListeners = new Set<(folderId: string, relPath: string) => void>();

/** Run `fn(folderId, relPath)` after every photo a scan prepares; returns the unsubscribe. */
export function onPhotoPrepared(fn: (folderId: string, relPath: string) => void): () => void {
  preparedListeners.add(fn);
  return () => preparedListeners.delete(fn);
}

let lastHashJob = 0;

/** Increasing hash job id; time-based so it stays ahead of jobs from before a dev reload. */
function nextHashJob(): number {
  lastHashJob = Math.max(lastHashJob + 1, Date.now());
  return lastHashJob;
}

/** `hash_files` cancels every lower job, so jobs run one at a time, in call order. */
let hashChain: Promise<unknown> = Promise.resolve();

function withHashLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = hashChain.then(fn, fn);
  hashChain = run.catch(() => {});
  return run;
}

/** Folder scans run one at a time (each hashes, and hash jobs cannot overlap). */
let scanChain: Promise<unknown> = Promise.resolve();
const scansInFlight = new Map<string, Promise<void>>();
/** Bumped by `reset`: everything async from before stops. */
let libraryEpoch = 0;

/** A stoppable run: `stopped` turns true on reset, and `onStop` callbacks run then. */
interface HashRun {
  stopped: () => boolean;
  onStop: Set<() => void>;
}

const runs = new Set<HashRun>();

function newRun(): HashRun {
  const epoch = libraryEpoch;
  const run: HashRun = { stopped: () => epoch !== libraryEpoch, onStop: new Set() };
  runs.add(run);
  return run;
}

/**
 * One `hash_files` job over `folder` (under the hash lock): `onResult` runs for every file, `onProgress` after each.
 * Resolves once every file has been reported or the run stopped.
 */
function hashJob(
  run: HashRun,
  folder: string,
  relPaths: string[],
  onResult: (event: AssetHashedEvent) => void,
  onProgress?: (done: number) => void,
): Promise<void> {
  if (relPaths.length === 0) return Promise.resolve();
  return withHashLock(async () => {
    if (run.stopped()) return;
    const job = nextHashJob();
    let received = 0;
    let finish = () => {};
    const allReceived = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unlisten = await Promise.all([
      onAssetHashed((event) => {
        if (event.job !== job || run.stopped()) return;
        onResult(event);
        received += 1;
        if (received === relPaths.length) finish();
      }),
      onHashProgress((event) => {
        if (event.job === job && !run.stopped()) onProgress?.(event.done);
      }),
    ]);
    const cancel = () => {
      finish();
      // A higher job id cancels the Rust workers; an empty list returns immediately.
      void hashFiles(folder, [], nextHashJob()).catch(() => {});
    };
    run.onStop.add(cancel);
    try {
      if (run.stopped()) return;
      await hashFiles(folder, relPaths, job);
      // Events can land after the command resolves; wait until every file has been reported.
      await allReceived;
    } finally {
      run.onStop.delete(cancel);
      for (const fn of unlisten) fn();
    }
  });
}

/**
 * Hash `relPaths` of `folder` without touching the store (relink candidates). Unreadable files map to null. Shares
 * the hash lock with the scans.
 */
export async function hashPaths(folder: string, relPaths: string[]): Promise<Map<string, string | null>> {
  const run = newRun();
  const out = new Map<string, string | null>();
  try {
    await hashJob(run, folder, relPaths, (event) => out.set(event.relPath, event.hash));
  } finally {
    runs.delete(run);
  }
  return out;
}

function setFolder(id: string, fn: (folder: LibraryFolder) => Partial<LibraryFolder>): void {
  useLibraryStore.setState((s) => {
    const folder = s.folders[id];
    return folder ? { folders: { ...s.folders, [id]: { ...folder, ...fn(folder) } } } : {};
  });
}

/**
 * Photo patches and progress from scans, applied together every `PATCH_FLUSH_MS` (one store update for many hash and
 * prepare results, instead of copying the folder's photo map per photo). `flushPhotoPatches` applies them now; the
 * prepared listeners run after the patches they follow are in the store.
 */
const PATCH_FLUSH_MS = 50;
const pendingPatches = new Map<string, Map<string, Partial<PhotoFile>>>();
const pendingProgress = new Map<string, PhotosProgress>();
const pendingPrepared: Array<[string, string]> = [];
let patchTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePatches(): void {
  patchTimer ??= setTimeout(flushPhotoPatches, PATCH_FLUSH_MS);
}

function queuePatch(id: string, relPath: string, patch: Partial<PhotoFile>): void {
  let folder = pendingPatches.get(id);
  if (!folder) {
    folder = new Map();
    pendingPatches.set(id, folder);
  }
  folder.set(relPath, { ...folder.get(relPath), ...patch });
  schedulePatches();
}

function queueProgress(id: string, progress: PhotosProgress): void {
  pendingProgress.set(id, progress);
  schedulePatches();
}

/** Apply every queued photo patch and progress in one store update, then tell the prepared listeners. */
export function flushPhotoPatches(): void {
  if (patchTimer) clearTimeout(patchTimer);
  patchTimer = null;
  if (pendingPatches.size === 0 && pendingProgress.size === 0 && pendingPrepared.length === 0) return;
  const patches = new Map(pendingPatches);
  const progress = new Map(pendingProgress);
  const prepared = pendingPrepared.splice(0);
  pendingPatches.clear();
  pendingProgress.clear();
  useLibraryStore.setState((s) => {
    const folders = { ...s.folders };
    for (const id of new Set([...patches.keys(), ...progress.keys()])) {
      const folder = folders[id];
      if (!folder) continue;
      let photos = folder.photos;
      const byPath = patches.get(id);
      if (byPath) {
        photos = { ...photos };
        for (const [relPath, patch] of byPath) {
          const photo = photos[relPath];
          if (photo) photos[relPath] = { ...photo, ...patch };
        }
      }
      folders[id] = { ...folder, photos, progress: progress.get(id) ?? folder.progress };
    }
    return { folders };
  });
  for (const [id, relPath] of prepared) for (const fn of preparedListeners) fn(id, relPath);
}

/**
 * Record a photo's measured noise σ (plan 23, after `noise_profile`) on its file in every folder at `folderPath`, so
 * the "Needs denoise" collection sees it now; the next index write keeps it.
 */
export function recordPhotoNoise(folderPath: string, relPath: string, noise: number): void {
  for (const folder of Object.values(useLibraryStore.getState().folders)) {
    if (folder.path !== folderPath || folder.photos[relPath]?.noise === noise) continue;
    patchPhotoFile(folder.id, relPath, { noise });
  }
}

/** Merge `patch` into one photo now (the renders and the public `patchPhoto`; scans queue theirs). */
function patchPhotoFile(id: string, relPath: string, patch: Partial<PhotoFile>): void {
  useLibraryStore.setState((s) => {
    const folder = s.folders[id];
    const photo = folder?.photos[relPath];
    if (!folder || !photo) return {};
    const photos = { ...folder.photos, [relPath]: { ...photo, ...patch } };
    return { folders: { ...s.folders, [id]: { ...folder, photos } } };
  });
}

/**
 * Take `relPaths` out of folder `id` in the library store (`dropPhotos`): the folder as it is left, its path and the
 * hashes no photo left in it has. Undefined when the folder is unknown or none of the paths is in it.
 */
function forgetPhotos(
  id: string,
  relPaths: readonly string[],
): { path: string; orphans: string[]; left: LibraryFolder } | undefined {
  flushPhotoPatches();
  const folder = useLibraryStore.getState().folders[id];
  const gone = new Set(relPaths.filter((p) => folder && Object.hasOwn(folder.photos, p)));
  if (!folder || gone.size === 0) return undefined;
  const photos: Record<string, PhotoFile> = {};
  const removed: PhotoFile[] = [];
  for (const [relPath, photo] of Object.entries(folder.photos)) {
    if (gone.has(relPath)) removed.push(photo);
    else photos[relPath] = photo;
  }
  const staying = new Set(Object.values(photos).map((p) => p.hash));
  const orphans = [...new Set(removed.flatMap((p) => (p.hash && !staying.has(p.hash) ? [p.hash] : [])))];
  const { hashed, prepared, total } = folder.progress;
  const progress: PhotosProgress = {
    hashed: Math.max(0, hashed - removed.filter((p) => p.hash !== undefined).length),
    prepared: Math.max(0, prepared - removed.filter((p) => p.status === 'ready' || p.status === 'error').length),
    total: Math.max(0, total - removed.length),
  };
  const left = { ...folder, photos, progress };
  useLibraryStore.setState((s) => ({ folders: { ...s.folders, [id]: left } }));
  return { path: folder.path, orphans, left };
}

/** The index entries of a folder's photos that have a hash. */
function indexOf(folder: LibraryFolder): Record<string, IndexEntry> {
  const out: Record<string, IndexEntry> = {};
  for (const photo of Object.values(folder.photos)) {
    if (!photo.hash) continue;
    out[photo.relPath] = {
      hash: photo.hash,
      size: photo.size,
      mtime: photo.mtime,
      kind: photo.kind,
      ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}),
      ...(photo.orientation ? { orientation: photo.orientation } : {}),
      ...(photo.iso ? { iso: photo.iso } : {}),
      ...(photo.noise !== undefined ? { noise: photo.noise } : {}),
      ...photoFacts(photo),
    };
  }
  return out;
}

/** An index as a comparable string: entries by path, fields in one order. */
function indexText(entries: Record<string, IndexEntry>): string {
  return JSON.stringify(
    Object.keys(entries)
      .sort()
      .map((relPath) => {
        const e = entries[relPath];
        const facts = PHOTO_FACT_KEYS.map((k) => e?.[k]);
        return [
          relPath,
          e?.hash,
          e?.size,
          e?.mtime,
          e?.kind,
          e?.width,
          e?.height,
          e?.orientation,
          e?.iso,
          e?.noise,
          facts,
        ];
      }),
  );
}

/** A store entry for scanned file `f`: the index's (or a known) hash, and what an earlier scan prepared. */
function photoEntry(f: ScannedFile, prev: PhotoFile | undefined, known: KnownPhoto | undefined): PhotoFile {
  // A known hash counts only when its size and mtime are recorded and still those of the file.
  const trusted = known !== undefined && known.size === f.size && known.mtime === f.mtimeMs;
  const hash = f.hash ?? (trusted ? known.hash : undefined);
  // The same bytes as last time in this session: keep the thumbnails and renders, nothing to prepare again.
  if (prev?.status === 'ready' && prev.hash !== undefined && prev.hash === hash && prev.size === f.size) {
    return {
      ...prev,
      mtime: f.mtimeMs,
      ...(f.iso !== undefined ? { iso: f.iso } : {}),
      ...(f.noise !== undefined ? { noise: f.noise } : {}),
      ...photoFacts(f),
    };
  }
  const size =
    f.width && f.height
      ? { width: f.width, height: f.height }
      : trusted && known.width && known.height
        ? { width: known.width, height: known.height }
        : {};
  const orientation = f.orientation ?? (trusted ? known.orientation : undefined);
  return {
    relPath: f.relPath,
    size: f.size,
    mtime: f.mtimeMs,
    kind: f.kind,
    ...(f.kind === 'raw' ? { isRaw: true } : {}),
    ...(hash ? { hash } : {}),
    ...size,
    ...(orientation ? { orientation } : {}),
    ...(f.iso !== undefined ? { iso: f.iso } : {}),
    ...(f.noise !== undefined ? { noise: f.noise } : {}),
    ...photoFacts(f),
    status: hash ? 'preparing' : 'hashing',
  };
}

async function runFolderScan(id: string, options: ScanOptions): Promise<void> {
  const run = newRun();
  const live = () => !run.stopped();
  const start = useLibraryStore.getState().folders[id];
  if (!start) return;
  const path = start.path;
  setFolder(id, () => ({ busy: true, error: null, scanned: false, progress: EMPTY_PHOTOS_PROGRESS }));
  const unhashed = new Set<string>();
  /** Photos still hashing go back to `scanned` when the scan stops or fails: they never stay `hashing`. */
  const releaseUnhashed = () => {
    flushPhotoPatches();
    for (const relPath of unhashed) {
      if (useLibraryStore.getState().folders[id]?.photos[relPath]?.status === 'hashing') {
        patchPhotoFile(id, relPath, { status: 'scanned' });
      }
    }
    unhashed.clear();
  };
  run.onStop.add(releaseUnhashed);
  try {
    // What the index holds now (to know when it must be written: new hashes, sizes, or files gone).
    const [scanned, onDisk] = await Promise.all([scanFolder(path), readIndex(path).catch(() => ({}))]);
    if (!live()) return;
    let written = indexText(onDisk);
    let wrote = false;
    const writeIfChanged = async () => {
      flushPhotoPatches();
      const folder = useLibraryStore.getState().folders[id];
      if (!folder || !live()) return;
      const entries = indexOf(folder);
      const text = indexText(entries);
      if (text === written) return;
      try {
        await writeIndex(path, entries);
        written = text;
        wrote = true;
        devLog('library', 'index written', { folder: path, photos: Object.keys(entries).length });
      } catch (err) {
        devLog('library', 'index not written', { folder: path, error: errorMessage(err) });
      }
    };

    const before = useLibraryStore.getState().folders[id]?.photos ?? {};
    const photos: Record<string, PhotoFile> = {};
    const toPrepare: string[] = [];
    let fromIndex = 0;
    for (const f of scanned) {
      if (f.hash) fromIndex += 1;
      const photo = photoEntry(f, before[f.relPath], options.known?.[f.relPath]);
      photos[f.relPath] = photo;
      if (photo.status === 'hashing') unhashed.add(f.relPath);
      else if (photo.status === 'preparing') toPrepare.push(f.relPath);
    }
    const toHash = [...unhashed];
    const counts: PhotosProgress = {
      hashed: scanned.length - toHash.length,
      prepared: scanned.length - toHash.length - toPrepare.length,
      total: scanned.length,
    };
    setFolder(id, () => ({ photos, progress: { ...counts } }));
    devLog('library', 'index used', { folder: path, photos: scanned.length, fromIndex });

    const queue = createPrepareQueue(run, id, path, () => {
      counts.prepared += 1;
      queueProgress(id, { ...counts });
    });
    for (const relPath of toPrepare) {
      const hash = photos[relPath]?.hash;
      if (hash) queue.push(relPath, hash);
    }
    const hashedBefore = counts.hashed;
    await hashJob(
      run,
      path,
      toHash,
      (event) => {
        unhashed.delete(event.relPath);
        if (event.hash) {
          queuePatch(id, event.relPath, { hash: event.hash, status: 'preparing' });
          queue.push(event.relPath, event.hash);
        } else {
          queuePatch(id, event.relPath, { status: 'error', error: event.error ?? 'Could not read the file' });
          counts.prepared += 1;
          queueProgress(id, { ...counts });
        }
      },
      (done) => {
        counts.hashed = hashedBefore + done;
        queueProgress(id, { ...counts });
      },
    );
    if (!live()) return;
    // Hashing is the slow part: keep it on disk before waiting for the thumbnails.
    if (toHash.length > 0) await writeIfChanged();
    await queue.drained();
    if (!live()) return;
    await writeIfChanged();
    if (!live()) return;
    if (!wrote) devLog('library', 'index reused', { folder: path, photos: fromIndex });
    setFolder(id, () => ({ scanned: true }));
    const all = Object.values(useLibraryStore.getState().folders[id]?.photos ?? {});
    devLog('library', 'scan finished', {
      folder: path,
      files: all.length,
      ready: all.filter((p) => p.status === 'ready').length,
      errors: all.filter((p) => p.status === 'error').length,
    });
  } catch (err) {
    if (live()) {
      releaseUnhashed();
      setFolder(id, () => ({ error: errorMessage(err) }));
      devError('library', `scan of ${path} failed`, err);
    }
  } finally {
    run.onStop.delete(releaseUnhashed);
    runs.delete(run);
    if (live()) {
      flushPhotoPatches();
      setFolder(id, () => ({ busy: false }));
    }
  }
}

/**
 * `prepare_asset` with at most `PREPARE_CONCURRENCY` calls in flight, in push order, for one folder. `onDone` runs
 * after each photo (prepared or failed).
 */
function createPrepareQueue(run: HashRun, id: string, path: string, onDone?: () => void) {
  const live = () => !run.stopped();
  const pending: Array<[string, string]> = [];
  let active = 0;
  let waiters: Array<() => void> = [];
  const settle = () => {
    if (active === 0 && pending.length === 0) {
      for (const fn of waiters) fn();
      waiters = [];
    }
  };
  run.onStop.add(() => {
    pending.length = 0;
    for (const fn of waiters) fn();
    waiters = [];
  });
  const pump = () => {
    while (live() && active < PREPARE_CONCURRENCY && pending.length > 0) {
      const next = pending.shift();
      if (!next) break;
      const [relPath, hash] = next;
      active += 1;
      prepareAsset(path, relPath, hash)
        .then(
          (info) => {
            if (!live()) return;
            queuePatch(id, relPath, {
              width: info.width,
              height: info.height,
              orientation: info.orientation,
              thumbUrl: fileUrl(info.thumbPath),
              proxyUrl: fileUrl(info.proxyPath),
              isRaw: info.isRaw,
              asShot: info.asShot,
              // Plan 23: the camera's ISO, and the measured noise (null clears a stale index value).
              ...(info.iso !== undefined ? { iso: info.iso } : {}),
              ...(info.noise !== undefined ? { noise: info.noise ?? undefined } : {}),
              // Plan 38: capture time, camera, lens, hash and stats (a cache from before is backfilled by Rust).
              ...photoFacts(info),
              status: 'ready',
              error: undefined,
            });
            pendingPrepared.push([id, relPath]);
          },
          (err) => {
            if (!live()) return;
            queuePatch(id, relPath, { status: 'error', error: errorMessage(err) });
            devLog('library', 'prepare failed', { relPath, error: errorMessage(err) });
          },
        )
        .finally(() => {
          active -= 1;
          if (!live()) return;
          onDone?.();
          pump();
          settle();
        });
    }
    settle();
  };
  return {
    push: (relPath: string, hash: string) => {
      pending.push([relPath, hash]);
      pump();
    },
    /** Resolves once nothing is queued or running (or the run stopped). */
    drained: () =>
      new Promise<void>((resolve) => {
        if (!live() || (active === 0 && pending.length === 0)) resolve();
        else waiters.push(resolve);
      }),
  };
}

/** Photos being prepared outside a scan (`prepare`), by `${folderId}\n${relPath}`. */
const preparing = new Set<string>();

const emptyFolder = (id: string, path: string): LibraryFolder => ({
  id,
  path,
  photos: {},
  progress: EMPTY_PHOTOS_PROGRESS,
  busy: false,
  error: null,
  scanned: false,
});

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  folders: {},

  addFolder: (id, path) => {
    const known = get().folders[id];
    if (known?.path === path) return;
    set((s) => ({ folders: { ...s.folders, [id]: known ? { ...known, path } : emptyFolder(id, path) } }));
  },

  loadIndex: async (id) => {
    const folder = get().folders[id];
    if (!folder || Object.keys(folder.photos).length > 0 || folder.busy) return;
    const epoch = libraryEpoch;
    try {
      const entries = await readIndex(folder.path);
      const now = get().folders[id];
      if (epoch !== libraryEpoch || !now || Object.keys(now.photos).length > 0 || now.busy) return;
      const photos: Record<string, PhotoFile> = {};
      for (const [relPath, e] of Object.entries(entries)) {
        photos[relPath] = {
          relPath,
          size: e.size,
          mtime: e.mtime,
          kind: e.kind,
          hash: e.hash,
          ...(e.width && e.height ? { width: e.width, height: e.height } : {}),
          ...(e.orientation ? { orientation: e.orientation } : {}),
          ...(e.iso !== undefined ? { iso: e.iso } : {}),
          ...(e.noise !== undefined ? { noise: e.noise } : {}),
          ...photoFacts(e),
          ...(e.kind === 'raw' ? { isRaw: true } : {}),
          status: 'scanned',
        };
      }
      setFolder(id, () => ({ photos }));
    } catch (err) {
      devLog('library', 'index not read', { folder: folder.path, error: errorMessage(err) });
    }
  },

  scan: (id, options = {}) => {
    const inflight = scansInFlight.get(id);
    if (inflight) return inflight;
    const folder = get().folders[id];
    if (!folder) return Promise.reject(new Error('That folder is not imported'));
    if (!options.force && folder.scanned && !folder.error) return Promise.resolve();
    const epoch = libraryEpoch;
    const promise = scanChain
      .then(() => (epoch === libraryEpoch ? runFolderScan(id, options) : undefined))
      .finally(() => {
        if (scansInFlight.get(id) === promise) scansInFlight.delete(id);
      });
    scanChain = promise.catch(() => {});
    scansInFlight.set(id, promise);
    return promise;
  },

  prepare: async (id, relPaths) => {
    const folder = get().folders[id];
    if (!folder) return;
    const todo: Array<[string, string]> = [];
    for (const relPath of relPaths) {
      const photo = folder.photos[relPath];
      const key = `${id}\n${relPath}`;
      if (!photo?.hash || photo.status !== 'scanned' || preparing.has(key)) continue;
      preparing.add(key);
      todo.push([relPath, photo.hash]);
      queuePatch(id, relPath, { status: 'preparing' });
    }
    if (todo.length === 0) return;
    const run = newRun();
    const queue = createPrepareQueue(run, id, folder.path);
    try {
      for (const [relPath, hash] of todo) queue.push(relPath, hash);
      await queue.drained();
    } finally {
      runs.delete(run);
      for (const [relPath] of todo) preparing.delete(`${id}\n${relPath}`);
      flushPhotoPatches();
    }
  },

  patchPhoto: (id, relPath, patch) => {
    flushPhotoPatches();
    patchPhotoFile(id, relPath, patch);
  },

  reset: () => {
    libraryEpoch += 1;
    if (patchTimer) clearTimeout(patchTimer);
    patchTimer = null;
    pendingPatches.clear();
    pendingProgress.clear();
    pendingPrepared.length = 0;
    preparing.clear();
    for (const run of runs) for (const fn of run.onStop) fn();
    runs.clear();
    scansInFlight.clear();
    scanChain = Promise.resolve();
    hashChain = Promise.resolve();
    set({ folders: {} });
  },
}));

/** The library folder at absolute `path` (an imported folder's registry entry may not be known to the caller). */
export function libraryFolderAt(
  state: Pick<LibraryState, 'folders'>,
  path: string | null | undefined,
): LibraryFolder | undefined {
  if (!path) return undefined;
  for (const folder of Object.values(state.folders)) if (folder.path === path) return folder;
  return undefined;
}

/** The file of a library photo key (`photoKey`), if its folder has been read. */
export function photoOfKey(state: Pick<LibraryState, 'folders'>, key: string): PhotoFile | undefined {
  const parsed = parsePhotoKey(key);
  if (!parsed) return undefined;
  const photos = state.folders[parsed.folder]?.photos;
  return photos && Object.hasOwn(photos, parsed.path) ? photos[parsed.path] : undefined;
}

/** The photo's ref when its folder is known and it is hashed. */
export function refOfKey(state: Pick<LibraryState, 'folders'>, key: string): PhotoRef | undefined {
  const parsed = parsePhotoKey(key);
  const hash = parsed ? photoOfKey(state, key)?.hash : undefined;
  return parsed && hash ? { folder: parsed.folder, path: parsed.path, hash } : undefined;
}

/**
 * Resolve once `folders[id].photos[relPath]` has a hash (resolves it) or cannot get one: resolves null for an
 * unreadable photo, a folder that failed to scan, and a photo without a hash (or not listed) while no scan of the folder
 * runs. Used to add a photo to a project only once hashed: scan the folder first.
 */
export function waitForHash(id: string, relPath: string): Promise<string | null> {
  const now = (): string | null | undefined => {
    const folder = useLibraryStore.getState().folders[id];
    const photo = folder?.photos[relPath];
    if (photo?.hash) return photo.hash;
    if (!folder || folder.error || photo?.status === 'error') return null;
    // A running scan may still list or hash it.
    return folder.busy ? undefined : null;
  };
  const first = now();
  if (first !== undefined) return Promise.resolve(first);
  return new Promise((resolve) => {
    const stop = useLibraryStore.subscribe(() => {
      const value = now();
      if (value === undefined) return;
      stop();
      resolve(value);
    });
  });
}
