import { type Asset, newId } from '@photobook/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors';
import { devError, devLog } from '../lib/log';
import {
  type AssetHashedEvent,
  type AssetKind,
  fileUrl,
  hashFiles,
  onAssetHashed,
  onHashProgress,
  prepareAsset,
  type ScannedFile,
  scanFolder,
} from '../lib/tauri';
import { useBookStore } from './book';
import { type HashMany, type MissingAsset, planRelinks, referencedAssetIds } from './relink';

/**
 * The photos of the open book's folder as the filmstrip shows them: scan, hash, thumbnail.
 *
 * `scan(folder)`: scan_folder -> hash_files (only for files whose size or mtime changed since the
 * book last recorded them; the recorded hash is trusted otherwise) -> prepare_asset per hash with a
 * small JS-side queue. Every hashed file is written into `book.assets` under a stable id: the
 * existing id for a known path, a new ULID otherwise. Those writes go through `fillAssets`, which
 * is not an undo step; autosave persists them.
 *
 * Moved or renamed files: a book asset whose path is no longer scanned is matched by hash (see
 * `planRelinks`). A match keeps the asset id and gets the new path in `book.assets`. Unmatched assets
 * that a page uses land in `missing` (keyed by asset id) for the filmstrip's Locate action, which
 * calls `relink`; unmatched unused ones are dropped from `book.assets`.
 *
 * Coming back to the editor (e.g. from preview) does not scan again when the last scan of the same
 * folder finished cleanly; `scan(folder, { force: true })` (the filmstrip's Rescan) always does.
 */

export type AssetStatus = 'scanned' | 'hashing' | 'preparing' | 'ready' | 'error';

export interface AssetFile {
  /** Relative to the source folder, `/`-separated. Key of `files`. */
  relPath: string;
  /** Id of this file's `book.assets` entry: existing for known paths, new (and stable) otherwise. */
  assetId: string;
  size: number;
  /** Modification time, epoch ms. Stands in for capture time until EXIF dates are read. */
  mtime: number;
  kind: AssetKind;
  hash?: string;
  /** Upright pixel size of the original. */
  width?: number;
  height?: number;
  orientation?: number;
  thumbUrl?: string;
  proxyUrl?: string;
  /** scanned -> hashing -> preparing (thumbnail and proxy) -> ready, or error at any step. */
  status: AssetStatus;
  error?: string;
}

export interface AssetsProgress {
  /** Files with a hash (trusted from the book or computed), errors included. */
  hashed: number;
  /** Files whose thumbnail and proxy are ready, errors included. */
  prepared: number;
  total: number;
}

export interface AssetsState {
  folder: string | null;
  files: Record<string, AssetFile>;
  /** Book assets whose file is gone from the folder and was not found by hash, by asset id. */
  missing: Record<string, MissingAsset>;
  progress: AssetsProgress;
  /** True from scan start until every file is hashed and prepared. */
  busy: boolean;
  /** Scan-level failure (e.g. the folder is unreadable); per-file errors live on the file. */
  error: string | null;
  /**
   * Scan `folder` and fill the store. A second call for a folder already being scanned joins it; a
   * call for the folder whose last scan finished without error does nothing unless `force`.
   */
  scan: (folder: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Point a missing asset at `relPath` (relative to the folder; the file must exist and must not be
   * used on a page under another asset id), then hash and prepare it. A scanned file held by an
   * unused asset id hands its entry over (that id is removed from the book). Clears the missing flag.
   * Rejects with a user-presentable message. Not available while a scan or another relink runs.
   */
  relink: (assetId: string, relPath: string) => Promise<void>;
  /** Stop all work and clear the store. */
  reset: () => void;
}

const PREPARE_CONCURRENCY = 4;
const BOOK_FLUSH_MS = 200;
const EMPTY_PROGRESS: AssetsProgress = { hashed: 0, prepared: 0, total: 0 };

/** One scan run. Everything async checks `live()` so a newer run or a reset wins. */
interface Run {
  folder: string;
  stopped: boolean;
  onStop: Set<() => void>;
  /** Paths whose book asset entry needs writing. */
  dirtyPaths: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

let current: Run | null = null;
let lastJob = 0;

/** Increasing hash job id; time-based so it stays ahead of jobs from before a dev reload. */
function nextJobId(): number {
  lastJob = Math.max(lastJob + 1, Date.now());
  return lastJob;
}
let inflight: { folder: string; promise: Promise<void> } | null = null;
/** Folder whose last scan ran to the end without a scan-level error (cleared when a scan starts). */
let scannedFolder: string | null = null;

export const useAssetsStore = create<AssetsState>()((set) => ({
  folder: null,
  files: {},
  missing: {},
  progress: EMPTY_PROGRESS,
  busy: false,
  error: null,
  relink: (assetId, relPath) => relinkMissing(assetId, relPath),
  scan: (folder, { force = false } = {}) => {
    if (inflight?.folder === folder) return inflight.promise;
    const s = useAssetsStore.getState();
    if (!force && scannedFolder === folder && s.folder === folder && !s.error) return Promise.resolve();
    const promise = runScan(folder).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
    inflight = { folder, promise };
    return promise;
  },
  reset: () => {
    stopCurrent();
    inflight = null;
    scannedFolder = null;
    set({ folder: null, files: {}, missing: {}, progress: EMPTY_PROGRESS, busy: false, error: null });
  },
}));

// Closing the book (folder -> null) stops the work; opening another one is handled by its scan.
useBookStore.subscribe((state, prev) => {
  if (prev.folder !== null && state.folder === null) useAssetsStore.getState().reset();
});

function stopCurrent() {
  if (!current) return;
  const run = current;
  current = null;
  run.stopped = true;
  if (run.flushTimer) clearTimeout(run.flushTimer);
  for (const fn of run.onStop) fn();
  run.onStop.clear();
}

function patchFile(relPath: string, patch: Partial<AssetFile>) {
  useAssetsStore.setState((s) => {
    const file = s.files[relPath];
    return file ? { files: { ...s.files, [relPath]: { ...file, ...patch } } } : {};
  });
}

function bumpProgress(patch: (p: AssetsProgress) => Partial<AssetsProgress>) {
  useAssetsStore.setState((s) => ({ progress: { ...s.progress, ...patch(s.progress) } }));
}

async function runScan(folder: string): Promise<void> {
  stopCurrent();
  const run: Run = {
    folder,
    stopped: false,
    onStop: new Set(),
    dirtyPaths: new Set(),
    flushTimer: null,
  };
  current = run;
  scannedFolder = null;
  const live = () => !run.stopped;
  useAssetsStore.setState({ folder, files: {}, missing: {}, progress: EMPTY_PROGRESS, busy: true, error: null });

  try {
    const scanned = await scanFolder(folder);
    if (!live()) return;

    // Relink moved or renamed files first (keeps asset ids), so they reconcile below like any known path.
    const { missing, hashes } = await reconcileMoved(run, scanned);
    if (!live()) return;

    // Reconcile with the book: same path + size + mtime means the recorded hash still holds.
    const byPath = new Map<string, [string, Asset]>();
    for (const [id, asset] of Object.entries(useBookStore.getState().book?.assets ?? {})) {
      if (!byPath.has(asset.path)) byPath.set(asset.path, [id, asset]);
    }
    const files: Record<string, AssetFile> = {};
    const trusted: AssetFile[] = [];
    const toHash: string[] = [];
    for (const f of scanned) {
      const [id, known] = byPath.get(f.relPath) ?? [];
      const hashOk = known?.hash !== undefined && known.size === f.size && known.mtime === f.mtimeMs;
      // A hash computed while looking for moved files is as good as one from the book.
      const fresh = hashOk ? undefined : hashes.get(f.relPath);
      const file: AssetFile = {
        relPath: f.relPath,
        assetId: id ?? newId(),
        size: f.size,
        mtime: f.mtimeMs,
        kind: f.kind,
        status: hashOk || fresh ? 'preparing' : 'hashing',
        ...(hashOk && known
          ? { hash: known.hash, width: known.width, height: known.height, orientation: known.orientation }
          : fresh
            ? { hash: fresh }
            : {}),
      };
      files[f.relPath] = file;
      if (hashOk || fresh) trusted.push(file);
      else toHash.push(f.relPath);
      if (fresh) markBookDirty(run, f.relPath);
    }
    useAssetsStore.setState({
      files,
      missing,
      progress: { hashed: trusted.length, prepared: 0, total: scanned.length },
    });

    const queue = createPrepareQueue(run);
    for (const file of trusted) if (file.hash) queue.push(file.relPath, file.hash);
    if (toHash.length > 0) await hashAll(run, toHash, trusted.length, queue.push);
    await queue.drained();
    if (!live()) return;

    // Autosave persists the filled `assets` so the next open trusts these hashes.
    flushBookAssets(run);
    scannedFolder = folder;
    const all = Object.values(useAssetsStore.getState().files);
    devLog('assets', 'scan finished', {
      files: all.length,
      ready: all.filter((f) => f.status === 'ready').length,
      errors: all.filter((f) => f.status === 'error').length,
      missing: Object.keys(missing).length,
    });
  } catch (err) {
    if (live()) {
      useAssetsStore.setState({ error: errorMessage(err) });
      devError('assets', 'scan failed', err);
    }
  } finally {
    if (live()) useAssetsStore.setState({ busy: false });
  }
}

/** Hash `relPaths` in Rust; each result updates the store and feeds the prepare queue. */
async function hashAll(
  run: Run,
  relPaths: string[],
  alreadyHashed: number,
  prepare: (relPath: string, hash: string) => void,
) {
  // A stopped job reports nothing more: put its unhashed files back to `scanned`, never stuck in `hashing`.
  const unhashed = new Set(relPaths);
  const onStop = () => {
    const files = useAssetsStore.getState().files;
    for (const relPath of unhashed) if (files[relPath]?.status === 'hashing') patchFile(relPath, { status: 'scanned' });
  };
  run.onStop.add(onStop);
  try {
    await hashJob(
      run,
      relPaths,
      (event) => {
        unhashed.delete(event.relPath);
        if (event.hash) {
          patchFile(event.relPath, { hash: event.hash, status: 'preparing' });
          markBookDirty(run, event.relPath);
          prepare(event.relPath, event.hash);
        } else {
          patchFile(event.relPath, { status: 'error', error: event.error ?? 'Could not read the file' });
          bumpProgress((p) => ({ prepared: p.prepared + 1 }));
        }
      },
      (done) => bumpProgress(() => ({ hashed: alreadyHashed + done })),
    );
  } finally {
    run.onStop.delete(onStop);
  }
}

/** Hash `relPaths` without touching the store (candidates for relinking). Unreadable files map to null. */
function hashOnly(run: Run): HashMany {
  return async (relPaths) => {
    const out = new Map<string, string | null>();
    await hashJob(run, relPaths, (event) => out.set(event.relPath, event.hash));
    return out;
  };
}

/**
 * One `hash_files` job: `onResult` runs for every file, `onProgress` after each. Resolves once every
 * file has been reported, the run stopped, or the job was cancelled.
 */
async function hashJob(
  run: Run,
  relPaths: string[],
  onResult: (event: AssetHashedEvent) => void,
  onProgress?: (done: number) => void,
) {
  const live = () => !run.stopped;
  const job = nextJobId();
  let received = 0;
  let finish = () => {};
  const allReceived = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const unlisten = await Promise.all([
    onAssetHashed((event) => {
      if (event.job !== job || !live()) return;
      onResult(event);
      received += 1;
      if (received === relPaths.length) finish();
    }),
    onHashProgress((event) => {
      if (event.job === job && live()) onProgress?.(event.done);
    }),
  ]);
  const cancel = () => {
    finish();
    // A higher job id cancels the Rust workers; an empty list returns immediately.
    void hashFiles(run.folder, [], nextJobId()).catch(() => {});
  };
  run.onStop.add(cancel);
  try {
    if (!live()) return;
    await hashFiles(run.folder, relPaths, job);
    // Events can land after the command resolves; wait until every file has been reported.
    await allReceived;
  } finally {
    run.onStop.delete(cancel);
    for (const fn of unlisten) fn();
  }
}

/**
 * Match book assets whose path vanished against the scan (see `planRelinks`). Relinks are written to
 * `book.assets` right away (new path, mtime and size; same id and hash), so element references keep
 * working and the files are not mistaken for new assets. Returns the missing assets and the hashes
 * computed on the way.
 */
async function reconcileMoved(run: Run, scanned: ScannedFile[]) {
  const { book, fillAssets, removeAssets } = useBookStore.getState();
  const referenced = book ? referencedAssetIds(book) : new Set<string>();
  const plan = await planRelinks(book?.assets ?? {}, scanned, hashOnly(run), referenced);
  const missing: Record<string, MissingAsset> = {};
  if (run.stopped || !book) return { missing, hashes: new Map<string, string>() };

  const byPath = new Map(scanned.map((f) => [f.relPath, f]));
  const moved: Record<string, Asset> = {};
  for (const { assetId, from, to } of plan.relinks) {
    const file = byPath.get(to);
    const prev = useBookStore.getState().book?.assets[assetId];
    if (!file || !prev) continue;
    moved[assetId] = { ...prev, path: to, size: file.size, mtime: file.mtimeMs };
    devLog('assets', 'relinked', { assetId, from, to });
  }
  if (Object.keys(moved).length > 0) fillAssets(moved);
  if (plan.pruned.length > 0) {
    removeAssets(plan.pruned);
    devLog('assets', 'pruned unused vanished assets', { ids: plan.pruned });
  }
  for (const m of plan.missing) {
    missing[m.assetId] = m;
    devLog('assets', 'missing', { assetId: m.assetId, path: m.path });
  }
  return { missing, hashes: plan.hashes };
}

/**
 * Locate: attach the file at `relPath` to a missing asset. The asset keeps its id (so every element
 * that uses it still resolves); its path, hash and metadata come from the new file. When the scan
 * already gave that file an id nobody uses, that id is folded into this one and removed.
 */
async function relinkMissing(assetId: string, relPath: string): Promise<void> {
  const check = () => {
    const state = useAssetsStore.getState();
    if (!state.folder || !state.missing[assetId]) throw new Error('That photo is no longer missing');
    if (state.busy) throw new Error('Wait for the scan to finish');
    const owner = state.files[relPath];
    const book = useBookStore.getState().book;
    if (owner && owner.assetId !== assetId && book && referencedAssetIds(book).has(owner.assetId)) {
      throw new Error('That photo is already on a page; choose another file');
    }
    return { folder: state.folder, gone: state.missing[assetId], owner };
  };
  const { folder } = check();

  const file = (await scanFolder(folder)).find((f) => f.relPath === relPath);
  if (!file) throw new Error('Choose a JPEG, PNG or HEIC photo inside the book folder');
  if (useAssetsStore.getState().folder !== folder) return;
  const { gone, owner } = check();

  stopCurrent();
  const run: Run = { folder, stopped: false, onStop: new Set(), dirtyPaths: new Set(), flushTimer: null };
  current = run;
  devLog('assets', 'relinked', { assetId, from: gone?.path, to: relPath, replaces: owner?.assetId });
  useAssetsStore.setState((s) => {
    const { [assetId]: _cleared, ...missing } = s.missing;
    const entry: AssetFile = {
      relPath,
      assetId,
      size: file.size,
      mtime: file.mtimeMs,
      kind: file.kind,
      status: 'hashing',
    };
    // A file the scan already counted is hashed and prepared again; a new one adds to the total.
    const progress = owner
      ? { ...s.progress, hashed: Math.max(0, s.progress.hashed - 1), prepared: Math.max(0, s.progress.prepared - 1) }
      : { ...s.progress, total: s.progress.total + 1 };
    return { missing, files: { ...s.files, [relPath]: entry }, progress, busy: true };
  });
  try {
    const { replaceAssetId, fillAssets } = useBookStore.getState();
    if (owner && owner.assetId !== assetId) replaceAssetId(owner.assetId, assetId);
    // Point the book at the new path first, so even a failed hash leaves the asset findable. The old
    // file's hash and size do not describe this one; the pipeline below fills them in.
    fillAssets({ [assetId]: { path: relPath, size: file.size, mtime: file.mtimeMs } });

    const queue = createPrepareQueue(run);
    await hashAll(run, [relPath], useAssetsStore.getState().progress.hashed, queue.push);
    await queue.drained();
    if (run.stopped) return;
    flushBookAssets(run);
  } catch (err) {
    if (!run.stopped) patchFile(relPath, { status: 'error', error: errorMessage(err) });
    throw err;
  } finally {
    if (!run.stopped) useAssetsStore.setState({ busy: false });
  }
}

/** prepare_asset with at most PREPARE_CONCURRENCY calls in flight, in push order. */
function createPrepareQueue(run: Run) {
  const live = () => !run.stopped;
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
      prepareAsset(run.folder, relPath, hash)
        .then(
          (info) => {
            if (!live()) return;
            patchFile(relPath, {
              width: info.width,
              height: info.height,
              orientation: info.orientation,
              thumbUrl: fileUrl(info.thumbPath),
              proxyUrl: fileUrl(info.proxyPath),
              status: 'ready',
              error: undefined,
            });
            markBookDirty(run, relPath);
          },
          (err) => {
            if (!live()) return;
            patchFile(relPath, { status: 'error', error: errorMessage(err) });
            devLog('assets', 'prepare failed', { relPath, error: errorMessage(err) });
          },
        )
        .finally(() => {
          active -= 1;
          if (!live()) return;
          bumpProgress((p) => ({ prepared: p.prepared + 1 }));
          pump();
          settle();
        });
    }
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

function markBookDirty(run: Run, relPath: string) {
  run.dirtyPaths.add(relPath);
  run.flushTimer ??= setTimeout(() => {
    run.flushTimer = null;
    if (!run.stopped) flushBookAssets(run);
  }, BOOK_FLUSH_MS);
}

/** Write the dirty files into `book.assets` in one `fillAssets` (not an undo step), keeping existing ids. */
function flushBookAssets(run: Run) {
  const paths = [...run.dirtyPaths];
  run.dirtyPaths.clear();
  const { book, folder, fillAssets } = useBookStore.getState();
  if (!book || folder !== run.folder || paths.length === 0) return;
  const files = useAssetsStore.getState().files;
  const assets: Record<string, Asset> = {};
  for (const relPath of paths) {
    const file = files[relPath];
    if (!file?.hash) continue;
    const prev = book.assets[file.assetId];
    const next: Asset = {
      ...prev,
      path: file.relPath,
      hash: file.hash,
      size: file.size,
      mtime: file.mtime,
      ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
      ...(file.orientation ? { orientation: file.orientation } : {}),
    };
    if (prev && sameAsset(prev, next)) continue;
    assets[file.assetId] = next;
  }
  if (Object.keys(assets).length > 0) fillAssets(assets);
}

function sameAsset(a: Asset, b: Asset): boolean {
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
