import {
  type Asset,
  type AssetDraft,
  type Book,
  DEVELOP_DEFAULTS,
  type DevelopSettings,
  developHash,
  developHashInput,
  isDefaultDevelop,
  type OutputProfile,
  outputProfileSuffix,
  resolveDevelop,
} from '@photobook/shared';
import { useMemo } from 'react';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors';
import { devError, devLog } from '../lib/log';
import { type Folder, fileUrl, listFolders, renderDevelopCached, type ScannedFile, scanFolder } from '../lib/tauri';
import { type AssetMove, isGestureActive, useBookStore } from './book';
import {
  assetDevelop,
  assetFolderPath,
  type DevelopedFile,
  hashPaths,
  isPhotoKey,
  type KnownPhoto,
  type LibraryFolder,
  libraryFolderAt,
  onPhotoPrepared,
  type PhotoFile,
  type PhotoRef,
  type PhotoStatus,
  type PhotosProgress,
  parsePhotoKey,
  photoKey,
  photoOfKey,
  resolvedAssets,
  useLibraryStore,
  waitForHash,
} from './library';
import {
  type FolderScan,
  type HashMany,
  type MissingAsset,
  planCrossFolderRelinks,
  planRelinks,
  referencedAssetIds,
} from './relink';

export type { DevelopedFile } from './library';

/**
 * The open project's photos (workflow plan 05). Scanning, hashing and thumbnails belong to the folders now
 * (`useLibraryStore` in ./library.ts, with `<folder>/.photobook/index.json`); this store maps the project's assets onto
 * them and keeps the project's side in order:
 *
 * - `files` is derived, never written by hand: every `book.assets` entry whose file the library store knows (in the
 *   asset's own folder), as an `AssetFile` (the folder's `PhotoFile` plus `assetId`), keyed by `fileKey`. It follows
 *   the library store and the book's asset list. Look a project asset's file up by id with `fileOfAsset`, and any
 *   photo id (asset id or library key) with `photoFileOf` / `usePhotoFile`.
 * - `scan(folder)` attaches the open project: it scans each folder the project draws from through the library store
 *   (the primary one first, with the project's recorded hashes as hints), then relinks moved or renamed files (by hash
 *   in their folder, `planRelinks`, then across every imported folder, `planCrossFolderRelinks`), drops unused assets
 *   whose file is gone, marks used ones `missing` (the filmstrip's Locate calls `relink`), and copies each photo's
 *   hash and size into `book.assets` (`fillAssets`, not an undo step; autosave persists it). A new photo of the folder
 *   no longer joins the project by itself: it is added from the Library tab or the New project dialog (`addPhotos`).
 *   Coming back to the editor does not attach again for the same folder unless `force` (the filmstrip's Rescan).
 *
 * Develop: `renderDeveloped(id)` renders (or finds, Rust returns early when they exist) the cached
 * `proxy-<developHash>.jpg` / `thumb-<developHash>.jpg` for photo id `id` (a project asset, through its folder's library,
 * `assetDevelop`; or a library key, its master edit) and records them on the folder's photo as `developed`, shared by
 * every project and the library. It runs after `prepare_asset` for every edited photo (so reopening finds its renders),
 * when the Develop view commits, and 400 ms after a `develop` changes any other way (undo, paste); the 400 ms timer
 * waits for a running Develop drag to end. `developed` keeps the last `KEEP_DEVELOPED` renders per file keyed by
 * `developedKey` (`developHashInput` plus the output profile suffix), so undo and redo show the earlier render at once;
 * `currentDeveloped` looks the photo's current settings and profile up in it. The renders are made in the open book's
 * `outputProfile` (sRGB with no project), so switching it re-renders every edited project photo and RAW base.
 *
 * Camera RAW (D6.1): `prepare_asset` makes the thumb and proxy from the camera's embedded JPEG (fast, but the camera's
 * look). Right after, `renderRawBase` renders the default develop settings (what an unedited RAW publishes as) and
 * swaps that render in as the photo's `thumbUrl` / `proxyUrl`, so the canvas, the filmstrip, Review and the Develop
 * view's Before all show what will be published. Its develop hash is kept from pruning like an edit's.
 */

export type AssetStatus = PhotoStatus;

/** A project asset's file: the folder's photo plus the asset id (or, from `photoFileOf`, the library key). */
export interface AssetFile extends PhotoFile {
  /** Id of this file's `book.assets` entry, or the library key for a photo outside the project. */
  assetId: string;
  /** Absolute path of the file's folder when it is not the primary folder (a project asset in another folder). */
  folder?: string;
}

export type AssetsProgress = PhotosProgress;

export interface AssetsState {
  /** The open project's primary folder this store is attached to (the last `scan`), else null. */
  folder: string | null;
  /** The open project's photos with a known file, by `fileKey` (derived; see the module doc). */
  files: Record<string, AssetFile>;
  /** Book assets whose file is gone from the folder and was not found by hash, by asset id. */
  missing: Record<string, MissingAsset>;
  /** The primary folder's scan progress. */
  progress: AssetsProgress;
  /** True while attaching (scans, relinks) runs. */
  busy: boolean;
  /** Scan-level failure (e.g. the folder is unreadable); per-file errors live on the file. */
  error: string | null;
  /**
   * Attach the open project (see the module doc). A second call for a folder being attached joins it; a call for the
   * folder whose last attach finished without error does nothing unless `force`, which also rescans the folders.
   */
  scan: (folder: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Point a missing asset at `relPath` (relative to its folder; the file must exist and must not be used on a page
   * under another asset id), then hash and prepare it. An unused project asset on that file hands its place over
   * (that id is removed from the book). Clears the missing flag. Rejects with a user-presentable message. Not
   * available while attaching or another relink runs.
   */
  relink: (assetId: string, relPath: string) => Promise<void>;
  /**
   * Render the cached developed proxy and thumbnail for photo id `id`'s develop settings and record them on its file
   * (`developed`). Calls for one photo run one at a time and a call made while one runs queues a single rerun with the
   * newest settings (the returned promise covers it). Never rejects: failures are logged and leave the source showing.
   */
  renderDeveloped: (id: string) => Promise<void>;
  /** Stop all work and clear the store. */
  reset: () => void;
}

/** Key of `files`: the relPath for the primary folder, `<folder>/<relPath>` (absolute) for a file in another folder. */
export function fileKey(file: Pick<AssetFile, 'relPath' | 'folder'>): string {
  return file.folder === undefined ? file.relPath : `${file.folder}/${file.relPath}`;
}

const byAssetMemo = new WeakMap<object, Map<string, unknown>>();

/** The file of `assetId` in `files` (memoized per `files` object, so it is safe in a store selector). */
export function fileOfAsset<F extends Pick<AssetFile, 'assetId'>>(
  files: Record<string, F>,
  assetId: string | null | undefined,
): F | undefined {
  if (!assetId) return undefined;
  let index = byAssetMemo.get(files) as Map<string, F> | undefined;
  if (!index) {
    index = new Map();
    for (const file of Object.values(files)) if (!index.has(file.assetId)) index.set(file.assetId, file);
    byAssetMemo.set(files, index);
  }
  return index.get(assetId);
}

/** A library photo as an `AssetFile` under its key (one stable object per photo object, safe in selectors). */
const keyFileMemo = new WeakMap<PhotoFile, AssetFile>();
function keyFile(photo: PhotoFile, key: string): AssetFile {
  const known = keyFileMemo.get(photo);
  if (known?.assetId === key) return known;
  const file: AssetFile = { ...photo, assetId: key };
  keyFileMemo.set(photo, file);
  return file;
}

/** True when `id` names a library photo rather than an asset of the open book (an asset id always wins). */
const isLibraryId = (id: string, assets = useBookStore.getState().book?.assets): boolean =>
  isPhotoKey(id) && !assets?.[id];

/** The file of a photo id: a project asset's (`fileOfAsset`) or a library key's (`photoOfKey`). */
export function photoFileOf(id: string | null | undefined): AssetFile | undefined {
  if (!id) return undefined;
  if (isLibraryId(id)) {
    const photo = photoOfKey(useLibraryStore.getState(), id);
    return photo ? keyFile(photo, id) : undefined;
  }
  return fileOfAsset(useAssetsStore.getState().files, id);
}

/** `photoFileOf` as a hook: re-renders when the project's files or the library photo change. */
export function usePhotoFile(id: string | null | undefined): AssetFile | undefined {
  const isAsset = useBookStore((s) => (id ? Object.hasOwn(s.book?.assets ?? {}, id) : false));
  const library = id !== null && id !== undefined && isPhotoKey(id) && !isAsset;
  const project = useAssetsStore((s) => (library ? undefined : fileOfAsset(s.files, id)));
  const fromLibrary = useLibraryStore((s) => {
    if (!library || !id) return undefined;
    const photo = photoOfKey(s, id);
    return photo ? keyFile(photo, id) : undefined;
  });
  return project ?? fromLibrary;
}

/** The hash of a photo id: the project asset's record, else its file's. */
export function usePhotoHash(id: string): string | undefined {
  const recorded = useBookStore((s) => s.book?.assets[id]?.hash);
  const file = usePhotoFile(id);
  return recorded ?? file?.hash;
}

/** What a list of photo ids (a Review or Develop strip) shows of each: its file, rating, flag and edit, and name. */
export interface PhotoLookup {
  file: (id: string) => AssetFile | undefined;
  fields: (id: string) => Pick<Asset, 'rating' | 'flag' | 'develop'> | undefined;
  /** Path relative to its folder (the file's, else the project's record), '' when unknown. */
  path: (id: string) => string;
}

/**
 * `PhotoLookup` over the project's files, the library store and the book store: re-renders when any of them changes.
 * Project asset ids read the resolved asset (`resolvedAssets`); library keys read their folder's library entry.
 */
export function usePhotoLookup(): PhotoLookup {
  const files = useAssetsStore((s) => s.files);
  const folders = useLibraryStore((s) => s.folders);
  const assets = useBookStore(resolvedAssets);
  const libraries = useBookStore((s) => s.libraries);
  return useMemo(() => {
    const keyed = (id: string): { folder: LibraryFolder; photo: PhotoFile } | undefined => {
      const parsed = parsePhotoKey(id);
      const folder = parsed ? folders[parsed.folder] : undefined;
      const photo =
        parsed && folder && Object.hasOwn(folder.photos, parsed.path) ? folder.photos[parsed.path] : undefined;
      return folder && photo ? { folder, photo } : undefined;
    };
    const file = (id: string): AssetFile | undefined => {
      if (!isLibraryId(id, assets)) return fileOfAsset(files, id);
      const found = keyed(id);
      return found ? keyFile(found.photo, id) : undefined;
    };
    return {
      file,
      fields: (id) => {
        if (!isLibraryId(id, assets)) return assets?.[id];
        const found = keyed(id);
        const hash = found?.photo.hash;
        const photos = found ? libraries[found.folder.path]?.photos : undefined;
        return hash && photos && Object.hasOwn(photos, hash) ? photos[hash] : undefined;
      },
      path: (id) => file(id)?.relPath ?? assets?.[id]?.path ?? parsePhotoKey(id)?.path ?? '',
    };
  }, [files, folders, assets, libraries]);
}

const BOOK_FLUSH_MS = 200;
const EMPTY_PROGRESS: AssetsProgress = { hashed: 0, prepared: 0, total: 0 };

/** One attach run. Everything async checks `live()` so a newer run or a reset wins. */
interface Run {
  folder: string;
  stopped: boolean;
}

let current: Run | null = null;
let inflight: { folder: string; promise: Promise<void> } | null = null;
/** Folder whose last attach ran to the end without a scan-level error (cleared when one starts). */
let attachedFolder: string | null = null;

export const useAssetsStore = create<AssetsState>()((set) => ({
  folder: null,
  files: {},
  missing: {},
  progress: EMPTY_PROGRESS,
  busy: false,
  error: null,
  relink: (assetId, relPath) => relinkMissing(assetId, relPath),
  renderDeveloped: (id) => renderDevelopedSerial(id),
  scan: (folder, { force = false } = {}) => {
    if (inflight?.folder === folder) return inflight.promise;
    const s = useAssetsStore.getState();
    if (!force && attachedFolder === folder && s.folder === folder && !s.error) return Promise.resolve();
    const promise = runAttach(folder, force).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { folder, promise };
    return promise;
  },
  reset: () => {
    stopCurrent();
    clearDevelopTimers();
    inflight = null;
    attachedFolder = null;
    set({ folder: null, files: {}, missing: {}, progress: EMPTY_PROGRESS, busy: false, error: null });
  },
}));

// Closing the project (folder -> null) stops the work, and so does switching to another project (its assets have other
// ids, even on the same folder); the editor then attaches the new one.
useBookStore.subscribe((state, prev) => {
  const closed = prev.folder !== null && state.folder === null;
  const switched = prev.projectId !== null && state.projectId !== null && prev.projectId !== state.projectId;
  if (closed || switched) useAssetsStore.getState().reset();
});

// ---------------------------------------------------------------------------------------------
// The derived `files`

const projectFileMemo = new WeakMap<PhotoFile, Map<string, AssetFile>>();

/** `photo` as the file of asset `assetId` (in `folder` when not the primary one), one stable object per combination. */
function projectFile(photo: PhotoFile, assetId: string, folder: string | undefined): AssetFile {
  let byAsset = projectFileMemo.get(photo);
  if (!byAsset) {
    byAsset = new Map();
    projectFileMemo.set(photo, byAsset);
  }
  const memoKey = `${assetId}\n${folder ?? ''}`;
  let file = byAsset.get(memoKey);
  if (!file) {
    file = { ...photo, assetId, ...(folder !== undefined ? { folder } : {}) };
    byAsset.set(memoKey, file);
  }
  return file;
}

/** The open project's assets that have a file in the library store, by `fileKey` (the first asset of a file wins). */
export function projectFiles(
  book: Pick<Book, 'assets' | 'folders'> | null,
  primary: string | null,
  folders: Record<string, LibraryFolder>,
): Record<string, AssetFile> {
  const files: Record<string, AssetFile> = {};
  if (!book) return files;
  const byPath = new Map<string, LibraryFolder>();
  for (const folder of Object.values(folders)) if (!byPath.has(folder.path)) byPath.set(folder.path, folder);
  for (const [id, asset] of Object.entries(book.assets)) {
    const path = assetFolderPath(book, asset, primary);
    const photos = path ? byPath.get(path)?.photos : undefined;
    const photo = photos && Object.hasOwn(photos, asset.path) ? photos[asset.path] : undefined;
    if (!photo || !path) continue;
    const file = projectFile(photo, id, path === primary ? undefined : path);
    const key = fileKey(file);
    if (!Object.hasOwn(files, key)) files[key] = file;
  }
  return files;
}

/** True when `a` and `b` hold the same keys with the same objects. */
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** Recompute `files` (and the primary folder's progress) from the book and the library store. */
function refreshFiles(): void {
  const { book, folder: primary } = useBookStore.getState();
  const library = useLibraryStore.getState();
  const state = useAssetsStore.getState();
  const files = projectFiles(book, primary, library.folders);
  const patch: Partial<AssetsState> = {};
  if (!sameRecord(files, state.files)) patch.files = files;
  const attached = state.folder !== null ? libraryFolderAt(library, state.folder) : undefined;
  if (attached && attached.progress !== state.progress) patch.progress = attached.progress;
  if (Object.keys(patch).length > 0) useAssetsStore.setState(patch);
}

useLibraryStore.subscribe((state, prev) => {
  if (state.folders === prev.folders) return;
  refreshFiles();
  if (useAssetsStore.getState().folder !== null) scheduleMetadataSync();
});

/** True when the book's assets moved, appeared or vanished (what `files` depends on), not just their edits. */
function assetsMoved(state: Pick<Book, 'assets' | 'folders'> | null, prev: Pick<Book, 'assets' | 'folders'> | null) {
  if (state === prev) return false;
  if (!state || !prev || state.folders !== prev.folders) return true;
  if (state.assets === prev.assets) return false;
  const ids = Object.keys(state.assets);
  if (ids.length !== Object.keys(prev.assets).length) return true;
  return ids.some((id) => {
    const a = state.assets[id];
    const b = prev.assets[id];
    return a !== b && (!a || !b || a.path !== b.path || a.folder !== b.folder);
  });
}

useBookStore.subscribe((state, prev) => {
  if (state.folder !== prev.folder || assetsMoved(state.book, prev.book)) refreshFiles();
});

// ---------------------------------------------------------------------------------------------
// Develop renders

/** After a `develop` changes outside a Develop commit (undo, paste, sync), render once it settles. */
const DEVELOP_SETTLE_MS = 400;
/** Renders remembered per file; the Rust side keeps the same number of develop hashes on disk per photo. */
export const KEEP_DEVELOPED = 3;

const inputMemo = new WeakMap<object, string>();
const DEFAULT_INPUT = developHashInput(DEVELOP_DEFAULTS);
let defaultHash: Promise<string> | null = null;
/** `developHash(DEVELOP_DEFAULTS)`, computed once: the develop hash of every unedited RAW's base render. */
function defaultDevelopHash(): Promise<string> {
  defaultHash ??= developHash(DEVELOP_DEFAULTS);
  return defaultHash;
}

/** `developHashInput(develop)`, memoized per settings object (store objects are immutable). */
export function developInputOf(develop: DevelopSettings): string {
  let input = inputMemo.get(develop);
  if (input === undefined) {
    input = developHashInput(develop);
    inputMemo.set(develop, input);
  }
  return input;
}

/**
 * Key of `AssetFile.developed`: the settings' `developHashInput` plus the output profile's file suffix (`-p3` for
 * Display P3, nothing for sRGB), so an sRGB and a P3 render of the same edit are different entries.
 */
export function developedKey(develop: DevelopSettings, profile: OutputProfile): string {
  return developInputOf(develop) + outputProfileSuffix(profile);
}

/**
 * The file's developed render when one was made for exactly `develop` (non-default) in the output `profile`, else
 * undefined.
 */
export function currentDeveloped(
  file: PhotoFile | undefined,
  develop: DevelopSettings | undefined,
  profile: OutputProfile,
): DevelopedFile | undefined {
  const developed = file?.developed;
  if (!developed || !develop || developInputOf(develop) === DEFAULT_INPUT) return undefined;
  const key = developedKey(develop, profile);
  return Object.hasOwn(developed, key) ? developed[key] : undefined;
}

/**
 * `developed` with `entry` added as the newest and only the last `KEEP_DEVELOPED` entries kept, plus every entry in
 * `pinned` (`pinnedDevelopedKeys`: the edits in use), so editing one version many times never evicts the render the
 * filmstrip, the grid and the canvas show for the photo's own edit (workflow plan 08).
 */
function withDeveloped(
  developed: PhotoFile['developed'],
  entry: DevelopedFile,
  pinned: ReadonlySet<string> = new Set(),
): Record<string, DevelopedFile> {
  const { [entry.input]: _replaced, ...rest } = developed ?? {};
  const entries = Object.entries({ ...rest, [entry.input]: entry });
  const from = entries.length - KEEP_DEVELOPED;
  return Object.fromEntries(entries.filter(([key], i) => i >= from || pinned.has(key)));
}

/**
 * `developedKey`s (in `profile`) of every edit of content hash `hash` in use: each folder library's master and versions
 * for it, and what each open-book asset with it resolves to. The Rust side keeps their files likewise
 * (`developHashesInUse`).
 */
function pinnedDevelopedKeys(hash: string, profile: OutputProfile): Set<string> {
  const state = useBookStore.getState();
  const keys = new Set<string>();
  const add = (develop: DevelopSettings | undefined) => {
    if (develop && !isDefaultDevelop(develop)) keys.add(developedKey(develop, profile));
  };
  for (const folder of Object.values(useLibraryStore.getState().folders)) {
    if (!pathsByHash(folder).has(hash)) continue;
    const entry = state.libraries[folder.path]?.photos[hash];
    add(entry?.develop);
    for (const version of Object.values(entry?.versions ?? {})) add(version.develop);
  }
  for (const asset of Object.values(resolvedAssets(state) ?? {})) if (asset.hash === hash) add(asset.develop);
  return keys;
}

/**
 * Develop hashes the cache folder of content hash `hash` must keep: every file sharing those bytes (in any folder, any
 * project) can have its own settings, and the folder is shared, so pruning for one must not delete another's render.
 */
async function developHashesInUse(hash: string): Promise<string[]> {
  const state = useBookStore.getState();
  const keep = new Set<string>();
  const settings: DevelopSettings[] = [];
  let raw = false;
  // Through the per-folder hash indexes (rebuilt only when a folder's photos change), not every photo of every folder.
  for (const folder of Object.values(useLibraryStore.getState().folders)) {
    const paths = pathsByHash(folder).get(hash);
    if (!paths) continue;
    for (const relPath of paths) {
      const photo = folder.photos[relPath];
      for (const entry of Object.values(photo?.developed ?? {})) keep.add(entry.developHash);
      if (photo?.isRaw) raw = true;
    }
    const entry = state.libraries[folder.path]?.photos[hash];
    if (entry) {
      const master = resolveDevelop(entry);
      if (master) settings.push(master);
      for (const version of Object.values(entry.versions)) if (version.develop) settings.push(version.develop);
    }
  }
  for (const id of assetIdsByHash(state.book?.assets).get(hash) ?? []) {
    const develop = assetDevelop(state, id);
    if (develop) settings.push(develop);
  }
  for (const develop of settings) if (!isDefaultDevelop(develop)) keep.add(await developHash(develop));
  if (raw) keep.add(await defaultDevelopHash());
  return [...keep];
}

const assetsByHashMemo = new WeakMap<object, Map<string, string[]>>();

/** Asset ids of the open book by hash (memoized per `assets` object). */
function assetIdsByHash(assets: Book['assets'] | undefined): Map<string, string[]> {
  if (!assets) return new Map();
  let index = assetsByHashMemo.get(assets);
  if (!index) {
    index = new Map();
    for (const [id, asset] of Object.entries(assets)) {
      if (asset.hash) index.set(asset.hash, [...(index.get(asset.hash) ?? []), id]);
    }
    assetsByHashMemo.set(assets, index);
  }
  return index;
}

/** The open book's output profile (what every developed render is made in); sRGB with no project open. */
function bookProfile(): OutputProfile {
  return useBookStore.getState().book?.outputProfile ?? 'srgb';
}

/** Where a photo id's file is and what it renders with. */
interface RenderTarget {
  folderId: string;
  folderPath: string;
  relPath: string;
  photo: PhotoFile;
  develop: DevelopSettings | undefined;
}

/** The library photo of a photo id (a project asset through its folder, a key directly) and its develop settings. */
function renderTarget(id: string): RenderTarget | undefined {
  const bookState = useBookStore.getState();
  const library = useLibraryStore.getState();
  const asset = bookState.book?.assets[id];
  let folder: LibraryFolder | undefined;
  let relPath: string | undefined;
  if (asset) {
    folder = libraryFolderAt(library, assetFolderPath(bookState.book, asset, bookState.folder));
    relPath = asset.path;
  } else {
    const parsed = parsePhotoKey(id);
    folder = parsed ? library.folders[parsed.folder] : undefined;
    relPath = parsed?.path;
  }
  const photo = folder && relPath && Object.hasOwn(folder.photos, relPath) ? folder.photos[relPath] : undefined;
  if (!folder || !relPath || !photo) return undefined;
  return { folderId: folder.id, folderPath: folder.path, relPath, photo, develop: assetDevelop(bookState, id) };
}

const photoNow = (folderId: string, relPath: string): PhotoFile | undefined =>
  useLibraryStore.getState().folders[folderId]?.photos[relPath];

/**
 * Swap a RAW photo's thumb and proxy (the camera's embedded JPEG from `prepare_asset`) for the render of the default
 * develop settings, rendering it first when it is not cached. Never rejects; on failure the embedded JPEG stays.
 */
async function renderRawBase(folderId: string, relPath: string): Promise<void> {
  const folder = useLibraryStore.getState().folders[folderId];
  const photo = folder?.photos[relPath];
  const hash = photo?.hash;
  if (!folder || !photo?.isRaw || !hash) return;
  // The output profile now; a render for another profile is not recorded (a switch re-renders).
  const profile = bookProfile();
  const same = () => photoNow(folderId, relPath)?.hash === hash && bookProfile() === profile;
  const started = performance.now();
  try {
    const meta = await renderDevelopCached(
      folder.path,
      relPath,
      hash,
      DEVELOP_DEFAULTS,
      await developHashesInUse(hash),
      profile,
    );
    if (!same()) return;
    useLibraryStore
      .getState()
      .patchPhoto(folderId, relPath, { thumbUrl: fileUrl(meta.thumbPath), proxyUrl: fileUrl(meta.proxyPath) });
    devLog('develop', `raw base ${meta.developHash} ${Math.round(performance.now() - started)}ms`, { relPath });
  } catch (err) {
    devError('develop', `raw base render failed for ${relPath}`, err);
  }
}

const developRuns = new Map<string, { again: boolean; promise: Promise<void> }>();
const developTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Renders in flight by file and settings: a project asset and its library key with one edit render once. */
const rendersInFlight = new Map<string, Promise<void>>();

function clearDevelopTimers() {
  for (const timer of developTimers.values()) clearTimeout(timer);
  developTimers.clear();
}

function renderDevelopedSerial(id: string): Promise<void> {
  const running = developRuns.get(id);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const run = { again: false, promise: Promise.resolve() };
  developRuns.set(id, run);
  run.promise = (async () => {
    try {
      do {
        run.again = false;
        await renderDevelopedOnce(id);
      } while (run.again);
    } finally {
      developRuns.delete(id);
    }
  })();
  return run.promise;
}

async function renderDevelopedOnce(id: string): Promise<void> {
  const target = renderTarget(id);
  if (!target) return;
  const { folderId, folderPath, relPath, photo, develop } = target;
  // Default settings need no render; the earlier ones stay so that undoing the reset shows them at once.
  if (!develop || isDefaultDevelop(develop)) return;
  const hash = photo.hash;
  if (!hash) return;
  const profile = bookProfile();
  const input = developedKey(develop, profile);
  if (photo.developed && Object.hasOwn(photo.developed, input)) return;
  const flight = `${folderId}/${relPath}\n${input}`;
  const pending = rendersInFlight.get(flight);
  if (pending) return pending;

  const library = useLibraryStore.getState();
  library.patchPhoto(folderId, relPath, { rendering: true });
  const started = performance.now();
  // Only record the result if the folder still holds the same bytes at that path.
  const same = () => photoNow(folderId, relPath)?.hash === hash;
  const promise = (async () => {
    try {
      const meta = await renderDevelopCached(
        folderPath,
        relPath,
        hash,
        develop,
        await developHashesInUse(hash),
        profile,
      );
      if (!same()) return;
      const entry: DevelopedFile = {
        developHash: meta.developHash,
        input,
        thumbUrl: fileUrl(meta.thumbPath),
        proxyUrl: fileUrl(meta.proxyPath),
        width: meta.width,
        height: meta.height,
        ...(meta.denoiseStale ? { denoiseStale: true } : {}),
        ...(meta.lutMissing ? { lutMissing: true } : {}),
      };
      useLibraryStore.getState().patchPhoto(folderId, relPath, {
        rendering: false,
        developed: withDeveloped(photoNow(folderId, relPath)?.developed, entry, pinnedDevelopedKeys(hash, profile)),
      });
      devLog('develop', `cached ${meta.developHash} ${Math.round(performance.now() - started)}ms`, {
        assetId: id,
        relPath,
      });
    } catch (err) {
      if (same()) useLibraryStore.getState().patchPhoto(folderId, relPath, { rendering: false });
      devError('develop', `cached render failed for ${relPath}`, err);
    } finally {
      rendersInFlight.delete(flight);
    }
  })();
  rendersInFlight.set(flight, promise);
  return promise;
}

/**
 * Render the developed files of photo id `id` again even though the settings did not change: the denoise intermediate
 * they start from was just made (step D5.2). Forgets the recorded render for the current settings, then
 * `renderDeveloped` finds the cache entry older than the intermediate and redoes it.
 */
export function refreshDeveloped(id: string): Promise<void> {
  const target = renderTarget(id);
  if (target?.develop && target.photo.developed) {
    const key = developedKey(target.develop, bookProfile());
    if (Object.hasOwn(target.photo.developed, key)) {
      const { [key]: _stale, ...rest } = target.photo.developed;
      useLibraryStore.getState().patchPhoto(target.folderId, target.relPath, { developed: rest });
    }
  }
  return useAssetsStore.getState().renderDeveloped(id);
}

/**
 * Workflow plan 18: a LUT file came back (imported or located). Forget every developed render made while a LUT was
 * missing and render those photos again (Rust redoes a cached render whose LUT is now present).
 */
export function refreshLutMissing(): void {
  const library = useLibraryStore.getState();
  for (const [folderId, folder] of Object.entries(library.folders)) {
    for (const [relPath, photo] of Object.entries(folder.photos)) {
      const developed = photo.developed;
      if (!developed || !Object.values(developed).some((d) => d.lutMissing)) continue;
      const kept = Object.fromEntries(Object.entries(developed).filter(([, d]) => !d.lutMissing));
      library.patchPhoto(folderId, relPath, { developed: kept });
      for (const id of idsOfFile(folderId, relPath)) renderIfDeveloped(id);
    }
  }
}

/** Render (or find) the developed files of photo id `id` if it has edits. */
function renderIfDeveloped(id: string) {
  const develop = assetDevelop(useBookStore.getState(), id);
  if (develop && !isDefaultDevelop(develop)) void useAssetsStore.getState().renderDeveloped(id);
}

/** Photo ids that show the file `relPath` of library folder `folderId`: its key, and every project asset on it. */
function idsOfFile(folderId: string, relPath: string): string[] {
  const ids = [photoKey({ folder: folderId, path: relPath })];
  const { book, folder: primary } = useBookStore.getState();
  const path = useLibraryStore.getState().folders[folderId]?.path;
  for (const [id, asset] of Object.entries(book?.assets ?? {})) {
    if (asset.path === relPath && assetFolderPath(book, asset, primary) === path) ids.push(id);
  }
  return ids;
}

// A photo was just prepared: a RAW's base render first (one RAW decode at a time per file), then its edits.
onPhotoPrepared((folderId, relPath) => {
  const base = photoNow(folderId, relPath)?.isRaw ? renderRawBase(folderId, relPath) : Promise.resolve();
  void base.then(() => {
    for (const id of idsOfFile(folderId, relPath)) renderIfDeveloped(id);
  });
});

const keysByHashMemo = new WeakMap<object, Map<string, string[]>>();

/** Relative paths of a folder's photos by hash (memoized per `photos` object). */
function pathsByHash(folder: LibraryFolder): Map<string, string[]> {
  let index = keysByHashMemo.get(folder.photos);
  if (!index) {
    index = new Map();
    for (const photo of Object.values(folder.photos)) {
      if (!photo.hash) continue;
      index.set(photo.hash, [...(index.get(photo.hash) ?? []), photo.relPath]);
    }
    keysByHashMemo.set(folder.photos, index);
  }
  return index;
}

// A `develop` changed (undo, paste, a hand edit, a library edit): render once it settles. Drags in the Develop view
// also land here; their commit usually got there first and this finds the render current. A change of the book's
// output profile re-renders the same photos: the edited ones and, first, each RAW's base.
useBookStore.subscribe((state, prev) => {
  // Library photos (keys): every entry whose master edit changed, in every folder whose photos are known.
  if (state.libraries !== prev.libraries) {
    const folders = Object.values(useLibraryStore.getState().folders);
    for (const [path, library] of Object.entries(state.libraries)) {
      const before = prev.libraries[path];
      if (library === before) continue;
      const folder = folders.find((f) => f.path === path);
      if (!folder) continue;
      const byHash = pathsByHash(folder);
      for (const [hash, entry] of Object.entries(library.photos)) {
        if (entry.develop === before?.photos[hash]?.develop) continue;
        for (const relPath of byHash.get(hash) ?? [])
          scheduleSettledRender(photoKey({ folder: folder.id, path: relPath }));
      }
    }
  }
  // Project assets: read through the library (an edit lands there and on the book mirror alike).
  const assets = resolvedAssets(state);
  const before = resolvedAssets(prev);
  if (!assets || !before || state.folder !== prev.folder) return;
  if (state.book?.outputProfile !== prev.book?.outputProfile) {
    rerenderForProfile(assets);
    return;
  }
  if (assets === before) return;
  for (const [id, asset] of Object.entries(assets)) {
    if (asset.develop === before[id]?.develop) continue;
    scheduleSettledRender(id);
  }
});

/**
 * The output profile changed: render the edited photos again in the new space (cached renders of that space are
 * found on disk). A RAW renders its base first, then its edit, one decode at a time like after `prepare_asset`.
 */
function rerenderForProfile(assets: Book['assets']) {
  for (const [id, asset] of Object.entries(assets)) {
    const target = renderTarget(id);
    if (target?.photo.isRaw) {
      void renderRawBase(target.folderId, target.relPath).then(() => renderIfDeveloped(id));
    } else if (asset.develop && !isDefaultDevelop(asset.develop)) scheduleSettledRender(id);
  }
}

/**
 * Render photo id `id` once its settings have been quiet for `DEVELOP_SETTLE_MS`. While a Develop drag is running
 * the render waits (it would compete with the live preview and render a value the drag is about to replace);
 * it runs once, shortly after the drag ends.
 */
function scheduleSettledRender(id: string) {
  const pending = developTimers.get(id);
  if (pending) clearTimeout(pending);
  developTimers.set(
    id,
    setTimeout(() => {
      developTimers.delete(id);
      if (isGestureActive()) scheduleSettledRender(id);
      else void useAssetsStore.getState().renderDeveloped(id);
    }, DEVELOP_SETTLE_MS),
  );
}

// ---------------------------------------------------------------------------------------------
// Attaching the open project

function stopCurrent() {
  if (!current) return;
  current.stopped = true;
  current = null;
  if (metadataTimer) clearTimeout(metadataTimer);
  metadataTimer = null;
}

/** The registry id of each folder path (the project's own folder id when the registry does not list it). */
function folderIdOf(book: Pick<Book, 'folders'>, registry: Folder[], path: string): string {
  return (
    registry.find((f) => f.path === path)?.id ??
    Object.entries(book.folders).find(([, f]) => f.path === path)?.[0] ??
    path
  );
}

/** What the open book already knows of the files in `path`: hashes to trust while size and mtime match. */
function knownIn(book: Book, primary: string, path: string): Record<string, KnownPhoto> {
  const known: Record<string, KnownPhoto> = {};
  for (const asset of Object.values(book.assets)) {
    if (!asset.hash || assetFolderPath(book, asset, primary) !== path) continue;
    known[asset.path] = {
      hash: asset.hash,
      size: asset.size,
      mtime: asset.mtime,
      width: asset.width,
      height: asset.height,
      orientation: asset.orientation,
    };
  }
  return known;
}

/** The scanned files of a library folder, for the relink planners. */
const scannedOf = (folder: LibraryFolder | undefined): ScannedFile[] =>
  Object.values(folder?.photos ?? {}).map((p) => ({
    relPath: p.relPath,
    size: p.size,
    mtimeMs: p.mtime,
    kind: p.kind,
  }));

/** Hashes for relink candidates in `path`: the library store's where it has them, else hashed now. */
function hashIn(path: string): HashMany {
  return async (relPaths) => {
    const folder = libraryFolderAt(useLibraryStore.getState(), path);
    const out = new Map<string, string | null>();
    const rest: string[] = [];
    for (const relPath of relPaths) {
      const hash = folder?.photos[relPath]?.hash;
      if (hash) out.set(relPath, hash);
      else rest.push(relPath);
    }
    if (rest.length > 0) for (const [relPath, hash] of await hashPaths(path, rest)) out.set(relPath, hash);
    return out;
  };
}

/** Scan a folder other than the attached ones (listing only); an unreadable folder scans as empty. */
async function scanOther(path: string): Promise<ScannedFile[]> {
  try {
    return await scanFolder(path);
  } catch (err) {
    devLog('assets', 'folder not readable', { folder: path, error: errorMessage(err) });
    return [];
  }
}

async function runAttach(primary: string, force: boolean): Promise<void> {
  stopCurrent();
  const run: Run = { folder: primary, stopped: false };
  current = run;
  attachedFolder = null;
  const live = () => !run.stopped && useBookStore.getState().folder === primary;
  useAssetsStore.setState({ folder: primary, missing: {}, busy: true, error: null, progress: EMPTY_PROGRESS });
  refreshFiles();
  try {
    const book = useBookStore.getState().book;
    if (!book) return;
    let registry: Folder[] = [];
    try {
      registry = (await listFolders()).filter((f) => !f.missing);
    } catch (err) {
      devLog('assets', 'folders not listed', { error: errorMessage(err) });
    }
    if (!live()) return;
    // Every folder the project draws from, the primary one first.
    const paths = [primary];
    for (const asset of Object.values(book.assets)) {
      const path = assetFolderPath(book, asset, primary);
      if (path && !paths.includes(path)) paths.push(path);
    }
    const ids = new Map(paths.map((path) => [path, folderIdOf(book, registry, path)]));
    for (const [path, id] of ids) useLibraryStore.getState().addFolder(id, path);
    refreshFiles();

    for (const path of paths) {
      const id = ids.get(path) ?? path;
      await useLibraryStore.getState().scan(id, { force, known: knownIn(book, primary, path) });
      if (!live()) return;
    }
    const primaryFolder = libraryFolderAt(useLibraryStore.getState(), primary);
    if (primaryFolder?.error) {
      useAssetsStore.setState({ error: primaryFolder.error });
      return;
    }

    // Relink moved or renamed files (keeps asset ids): in each folder, then across every imported folder.
    const missingList: MissingAsset[] = [];
    for (const path of paths) {
      const outcome = await reconcileMoved(path, primary);
      if (!live()) return;
      missingList.push(...outcome.map((m) => (path === primary ? m : { ...m, folder: path })));
    }
    const still = await relinkAcrossFolders(run, primary, registry, missingList);
    if (!live()) return;
    const missing: Record<string, MissingAsset> = {};
    for (const m of still) {
      missing[m.assetId] = m;
      devLog('assets', 'missing', { assetId: m.assetId, path: m.path, ...(m.folder ? { folder: m.folder } : {}) });
    }
    useAssetsStore.setState({ missing });
    syncAssetMetadata();
    attachedFolder = primary;
    const files = Object.values(useAssetsStore.getState().files);
    devLog('assets', 'scan finished', {
      files: files.length,
      ready: files.filter((f) => f.status === 'ready').length,
      errors: files.filter((f) => f.status === 'error').length,
      missing: Object.keys(missing).length,
      ...(paths.length > 1 ? { folders: paths.length } : {}),
    });
  } catch (err) {
    if (live()) {
      useAssetsStore.setState({ error: errorMessage(err) });
      devError('assets', 'scan failed', err);
    }
  } finally {
    if (!run.stopped) useAssetsStore.setState({ busy: false });
    if (current === run) refreshFiles();
  }
}

/**
 * Match the book assets of folder `path` whose file vanished against the folder's photos (see `planRelinks`).
 * Relinks are written to `book.assets` right away (new path, mtime and size; same id, folder and hash), so element
 * references keep working; unused vanished assets are dropped. Returns the missing ones.
 */
async function reconcileMoved(path: string, primary: string): Promise<MissingAsset[]> {
  const { book, fillAssets, removeAssets } = useBookStore.getState();
  const folder = libraryFolderAt(useLibraryStore.getState(), path);
  if (!book || !folder) return [];
  const assets: Record<string, Asset> = {};
  for (const [id, asset] of Object.entries(book.assets)) {
    if (assetFolderPath(book, asset, primary) === path) assets[id] = asset;
  }
  // A folder that cannot be read (unplugged, no longer imported) has none of its files: they are searched elsewhere.
  const scanned = folder.error ? [] : scannedOf(folder);
  const plan = await planRelinks(assets, scanned, hashIn(path), referencedAssetIds(book));
  const byPath = new Map(scanned.map((f) => [f.relPath, f]));
  const moved: Record<string, Asset> = {};
  for (const { assetId, from, to } of plan.relinks) {
    const file = byPath.get(to);
    const prev = useBookStore.getState().book?.assets[assetId];
    if (!file || !prev) continue;
    moved[assetId] = { ...prev, path: to, size: file.size, mtime: file.mtimeMs };
    devLog('assets', 'relinked', { assetId, from, to, ...(path !== primary ? { folder: path } : {}) });
  }
  if (Object.keys(moved).length > 0) fillAssets(moved);
  if (plan.pruned.length > 0) {
    removeAssets(plan.pruned);
    devLog('assets', 'pruned unused vanished assets', { ids: plan.pruned });
  }
  return plan.missing;
}

/**
 * Search the missing assets a page uses across every imported folder (`planCrossFolderRelinks`): the primary folder
 * first, then the registry in order, reusing the library store's photos and listing the rest only when something is
 * missing. Each hit is applied with `relinkAssets` after the target folder's library is loaded, and logged. Returns the
 * assets still missing.
 */
async function relinkAcrossFolders(
  run: Run,
  primary: string,
  registry: Folder[],
  missing: MissingAsset[],
): Promise<MissingAsset[]> {
  const searchable = missing.filter((m) => m.hash !== undefined && m.size !== undefined);
  if (searchable.length === 0) return missing;
  const primaryEntry = registry.find((f) => f.path === primary);
  const ordered = [...(primaryEntry ? [primaryEntry] : []), ...registry.filter((f) => f.path !== primary)];
  const book = useBookStore.getState().book;
  const claimedIn = (path: string): Set<string> => {
    const claimed = new Set<string>();
    for (const asset of Object.values(book?.assets ?? {})) {
      if (assetFolderPath(book, asset, primary) === path) claimed.add(asset.path);
    }
    return claimed;
  };
  const folders: FolderScan[] = [];
  const scans = new Map<string, ScannedFile[]>();
  for (const entry of ordered) {
    const known = libraryFolderAt(useLibraryStore.getState(), entry.path);
    const scanned = known && Object.keys(known.photos).length > 0 ? scannedOf(known) : await scanOther(entry.path);
    if (run.stopped) return missing;
    scans.set(entry.path, scanned);
    folders.push({ id: entry.id, path: entry.path, scanned, claimed: claimedIn(entry.path) });
  }
  const plan = await planCrossFolderRelinks(missing, folders, (path, relPaths) => hashIn(path)(relPaths));
  if (run.stopped || plan.relinks.length === 0) return plan.missing;

  // The library of every folder a photo moved into is loaded first, so its entry (or the one carried over) applies.
  const store = useBookStore.getState();
  for (const path of new Set(plan.relinks.map((r) => r.folderPath))) {
    if (!Object.hasOwn(useBookStore.getState().libraries, path)) await store.loadLibrary(path);
  }
  if (run.stopped) return plan.missing;
  const moves: AssetMove[] = [];
  for (const r of plan.relinks) {
    const file = scans.get(r.folderPath)?.find((f) => f.relPath === r.to);
    if (!file) continue;
    useLibraryStore.getState().addFolder(r.folderId, r.folderPath);
    moves.push({
      assetId: r.assetId,
      folderId: r.folderId,
      folderPath: r.folderPath,
      path: r.to,
      size: file.size,
      mtime: file.mtimeMs,
    });
    devLog('assets', 'relinked across folders', {
      assetId: r.assetId,
      from: `${r.fromFolder ?? primary}/${r.from}`,
      to: `${r.folderPath}/${r.to}`,
    });
  }
  useBookStore.getState().relinkAssets(moves);
  // The folders photos moved into are scanned like the project's own, so their files show.
  for (const move of moves) void useLibraryStore.getState().scan(move.folderId);
  return plan.missing;
}

let metadataTimer: ReturnType<typeof setTimeout> | null = null;

/** Sync the project's asset records with their photos shortly after the library store changes. */
function scheduleMetadataSync() {
  metadataTimer ??= setTimeout(() => {
    metadataTimer = null;
    if (!useAssetsStore.getState().busy) syncAssetMetadata();
  }, BOOK_FLUSH_MS);
}

/**
 * Copy each project photo's hash, size, mtime, pixel size and orientation from its file into `book.assets` in one
 * `fillAssets` (not an undo step), so the project file references photos by hash and the next open trusts them. A
 * hash that lands this way lifts the asset's book fields into the library (`reconcileAsset`).
 */
function syncAssetMetadata(): void {
  const { book, folder, fillAssets } = useBookStore.getState();
  if (!book || folder === null || folder !== useAssetsStore.getState().folder) return;
  const updates: Record<string, AssetDraft> = {};
  for (const file of Object.values(useAssetsStore.getState().files)) {
    if (!file.hash) continue;
    const prev = book.assets[file.assetId];
    if (!prev) continue;
    const next: AssetDraft = {
      ...prev,
      path: file.relPath,
      hash: file.hash,
      size: file.size,
      mtime: file.mtime,
      ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
      ...(file.orientation ? { orientation: file.orientation } : {}),
    };
    if (!sameAsset(prev, next)) updates[file.assetId] = next;
  }
  if (Object.keys(updates).length > 0) fillAssets(updates);
}

function sameAsset(a: Asset, b: AssetDraft): boolean {
  return (
    a.path === b.path &&
    a.hash === b.hash &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation
  );
}

/**
 * Locate: attach the file at `relPath` (inside the missing asset's folder) to a missing asset. The asset keeps its id
 * (so every element that uses it still resolves); its path comes from the new file and its hash and metadata follow
 * once the folder's scan knows it. An unused project asset already on that file is folded into this one and removed.
 */
async function relinkMissing(assetId: string, relPath: string): Promise<void> {
  const check = () => {
    const state = useAssetsStore.getState();
    if (!state.folder || !state.missing[assetId]) throw new Error('That photo is no longer missing');
    if (state.busy) throw new Error('Wait for the scan to finish');
    const gone = state.missing[assetId];
    const key = fileKey({ relPath, folder: gone?.folder });
    const owner = state.files[key];
    const book = useBookStore.getState().book;
    if (owner && owner.assetId !== assetId && book && referencedAssetIds(book).has(owner.assetId)) {
      throw new Error('That photo is already on a page; choose another file');
    }
    return { primary: state.folder, gone, owner };
  };
  const { primary, gone: first } = check();
  const folder = first?.folder ?? primary;

  const file = (await scanFolder(folder)).find((f) => f.relPath === relPath);
  if (!file) throw new Error('Choose a JPEG, PNG, HEIC or camera RAW photo inside the photo folder');
  if (useAssetsStore.getState().folder !== primary) return;
  const { gone, owner } = check();

  devLog('assets', 'relinked', { assetId, from: gone?.path, to: relPath, replaces: owner?.assetId });
  useAssetsStore.setState((s) => {
    const { [assetId]: _cleared, ...missing } = s.missing;
    return { missing, busy: true };
  });
  try {
    const { replaceAssetId, fillAssets } = useBookStore.getState();
    if (owner && owner.assetId !== assetId) replaceAssetId(owner.assetId, assetId);
    // Point the book at the new path first, so even a failed hash leaves the asset findable. The old file's hash and
    // size do not describe this one; the folder's scan fills them in. The review rating and flag stay with the asset,
    // and so do the project's choices about it (folder, version, snapshot, alt).
    const {
      rating,
      flag,
      folder: folderId,
      version,
      developSnapshot,
      alt,
    } = useBookStore.getState().book?.assets[assetId] ?? {};
    fillAssets({
      [assetId]: {
        path: relPath,
        size: file.size,
        mtime: file.mtimeMs,
        rating,
        flag,
        ...(folderId !== undefined ? { folder: folderId } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(developSnapshot !== undefined ? { developSnapshot } : {}),
        ...(alt !== undefined ? { alt } : {}),
      },
    });
    const library = libraryFolderAt(useLibraryStore.getState(), folder);
    const known = library?.photos[relPath];
    if (library && (!known || known.size !== file.size || known.mtime !== file.mtimeMs)) {
      await useLibraryStore.getState().scan(library.id, { force: true });
    }
    if (useAssetsStore.getState().folder !== primary) return;
    syncAssetMetadata();
  } finally {
    if (useAssetsStore.getState().folder === primary) useAssetsStore.setState({ busy: false });
  }
}

// ---------------------------------------------------------------------------------------------
// Adding library photos to the project

/**
 * Add library photos (keys) to the open project: each becomes an asset `{ id: newId(), ...ref }` once its hash is known
 * (it waits for a photo still hashing), or keeps the id of the asset already on that file. Resolves the asset ids in
 * order (null for a photo that could not be hashed or added).
 */
export async function addToProject(keys: readonly string[]): Promise<(string | null)[]> {
  // Waiting for hashes takes time: a project opened or closed meanwhile gets nothing.
  const projectId = useBookStore.getState().projectId;
  const refs: Array<PhotoRef & { folderPath: string; photo: PhotoFile }> = [];
  const order: (number | null)[] = [];
  for (const key of keys) {
    const parsed = parsePhotoKey(key);
    const folder = parsed ? useLibraryStore.getState().folders[parsed.folder] : undefined;
    const hash = parsed && folder ? await waitForHash(folder.id, parsed.path) : null;
    const photo = parsed ? photoOfKey(useLibraryStore.getState(), key) : undefined;
    if (!parsed || !folder || !hash || !photo) {
      order.push(null);
      continue;
    }
    order.push(refs.length);
    refs.push({ folder: folder.id, path: parsed.path, hash, folderPath: folder.path, photo });
  }
  if (refs.length === 0 || projectId === null || useBookStore.getState().projectId !== projectId) {
    return order.map(() => null);
  }
  const ids = useBookStore.getState().addPhotos(
    refs.map((r) => ({
      folder: r.folder,
      folderPath: r.folderPath,
      path: r.path,
      hash: r.hash,
      size: r.photo.size,
      mtime: r.photo.mtime,
      width: r.photo.width,
      height: r.photo.height,
      orientation: r.photo.orientation,
    })),
  );
  devLog('assets', 'added to project', { photos: refs.length });
  return order.map((i) => (i === null ? null : (ids[i] ?? null)));
}

/** What the New project dialog adds from its folder. */
export type AddChoice = 'all' | 'picks' | 'none';

/**
 * Add a folder's photos to the open project once the folder is scanned: every hashed photo (`all`) or those flagged
 * pick in the folder's library (`picks`). Resolves how many were added.
 */
export async function addFolderPhotos(folderId: string, choice: AddChoice): Promise<number> {
  if (choice === 'none') return 0;
  const projectId = useBookStore.getState().projectId;
  // Home creates projects before any library view has met the folder: find it in the registry.
  if (!useLibraryStore.getState().folders[folderId]) {
    const entry = (await listFolders()).find((f) => f.id === folderId && !f.missing);
    if (!entry) throw new Error('That folder is no longer imported');
    useLibraryStore.getState().addFolder(entry.id, entry.path);
  }
  await useLibraryStore.getState().scan(folderId);
  const state = useBookStore.getState();
  const folder = useLibraryStore.getState().folders[folderId];
  if (!folder || state.projectId !== projectId || !state.book) return 0;
  if (!Object.hasOwn(state.libraries, folder.path)) await state.loadLibrary(folder.path);
  const library = useBookStore.getState().libraries[folder.path];
  const keys = Object.values(folder.photos)
    .filter((p) => p.hash && p.status !== 'error')
    .filter((p) => choice === 'all' || (p.hash && library?.photos[p.hash]?.flag === 'pick'))
    .sort((a, b) => a.mtime - b.mtime || a.relPath.localeCompare(b.relPath))
    .map((p) => photoKey({ folder: folderId, path: p.relPath }));
  const ids = await addToProject(keys);
  const added = ids.filter((id) => id !== null).length;
  devLog('assets', 'folder added to project', { folder: folder.path, choice, photos: added });
  return added;
}
