import {
  type Asset,
  type Book,
  type DevelopSettings,
  developHash,
  developRenderName,
  type Library,
  renderedDevelop,
  resolveAssetDevelop,
} from '@photobook/shared';
import { usedAssetIds } from '../components/filmstrip/visible';
import { cancelJob, type Job, type JobHandle, useJobsStore, watchJob } from '../store/jobs';
import { openFolderId } from '../store/library';
import { isModelMissing, modelSizeLabel } from './denoise';
import { errorMessage } from './errors';
import { enqueueDenoise, MissingModelError } from './jobs/denoise';
import { enqueueRender } from './jobs/developRender';
import { devLog } from './log';
import { missingLutMessage } from './lutPreflight';
import { basename } from './path';
import type { PublishEvent } from './publishRunner';
import {
  type AiModelInfo,
  type DenoiseStatus,
  denoiseStatus,
  developRendersPresent,
  pruneDevelopRenders,
} from './tauri';

/**
 * Step D1.5: the editor half of publishing edited photos. The CLI publishes
 * `<folder>/.photobook-cache/develop/<hash>-<developHash>[-p3].jpg` in place of the original of every used photo with
 * non-default develop settings, and of every camera RAW (with the default settings when it has none; D6.1,
 * `renderedDevelop`), and refuses to run when one is missing, so the editor renders the missing ones first
 * (`renderBeforePublish`) and removes the stale ones afterwards (`pruneAfterPublish`). The file name carries the
 * book's output profile (`developRenderName`), so switching sRGB / Display P3 renders everything once more.
 *
 * The `book` every function here takes is the open book read through its folders' libraries (`libraryBook` in
 * store/library.ts, which PublishPanel passes), so the develop settings rendered are the library's; each asset's
 * settings are read with `resolveAssetDevelop` (a project's develop snapshot first), as the CLI resolves them.
 *
 * Renders live in the folder of each photo (`<folder>/.photobook-cache/develop/`), which is where the CLI looks
 * (`folders[asset.folder]`): `folder` is the open project's primary folder, the others come from `book.folders`.
 */

/** The folder path of `asset`: `primary` for the book's primary folder entry (`openFolderId`), else its own entry. */
function folderOf(book: Book, asset: Asset, primary: string): string {
  if (asset.folder === openFolderId(book, primary)) return primary;
  return Object.hasOwn(book.folders, asset.folder) ? (book.folders[asset.folder]?.path ?? primary) : primary;
}

/** `items` grouped by their `folder`, in first-seen order. */
function byFolder<T extends { folder: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.folder, [...(groups.get(item.folder) ?? []), item]);
  return groups;
}

/** The settings a used asset is published with (`renderedDevelop` of its resolved edit), or undefined. */
function publishedDevelop(asset: Asset): DevelopSettings | undefined {
  return renderedDevelop({ path: asset.path, develop: resolveAssetDevelop(asset) });
}

/** A used photo with non-default develop settings (or a RAW) and the render file the CLI will look for. */
export interface DevelopTarget {
  assetId: string;
  /** The photo's folder (absolute). */
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  /** `<hash>-<developHash>[-p3].jpg`, per the book's `outputProfile`. */
  name: string;
}

/**
 * Used assets with non-default develop settings and used RAW files, in first-use order. Throws for one that was
 * never hashed. `folder` is the primary folder (see `folderOf`).
 */
export async function developedTargets(book: Book, folder = ''): Promise<DevelopTarget[]> {
  const targets: DevelopTarget[] = [];
  for (const assetId of usedAssetIds(book.pages)) {
    const asset = book.assets[assetId];
    const settings = asset && publishedDevelop(asset);
    if (!asset || !settings) continue;
    if (!asset.hash) throw new Error(`${basename(asset.path)} has not been hashed yet; wait for the scan to finish`);
    const name = developRenderName(asset.hash, await developHash(settings), book.outputProfile);
    targets.push({
      assetId,
      folder: folderOf(book, asset, folder),
      relPath: asset.path,
      hash: asset.hash,
      settings,
      name,
    });
  }
  return targets;
}

/**
 * Per folder, what `pruneAfterPublish` may touch and must keep: the content hashes of the book's photos there (only
 * their renders are this book's to prune; the folder's cache is shared with every other project on it) and the render
 * names their settings need, used or not, in both output profiles (so switching the profile back, or another project
 * in the other profile, finds its render). Besides this book's own settings, every edit the folder's library holds for
 * those hashes is kept, the master and each version (workflow plan 08): another project on the folder may publish any
 * of them. `libraries` are the loaded folder libraries by path.
 */
async function currentRenderNames(
  book: Book,
  primary: string,
  libraries: Record<string, Library>,
): Promise<Map<string, { hashes: Set<string>; keep: string[] }>> {
  const out = new Map<string, { hashes: Set<string>; keep: Set<string> }>([
    [primary, { hashes: new Set(), keep: new Set() }],
  ]);
  const keepAll = async (into: Set<string>, hash: string, settings: DevelopSettings | undefined) => {
    if (!settings) return;
    const dh = await developHash(settings);
    for (const profile of ['srgb', 'display-p3'] as const) into.add(developRenderName(hash, dh, profile));
  };
  for (const asset of Object.values(book.assets)) {
    if (!asset.hash) continue;
    const folder = folderOf(book, asset, primary);
    const entry = out.get(folder) ?? { hashes: new Set<string>(), keep: new Set<string>() };
    out.set(folder, entry);
    entry.hashes.add(asset.hash);
    await keepAll(entry.keep, asset.hash, publishedDevelop(asset));
    const photo = libraries[folder]?.photos[asset.hash];
    const edits = [photo?.develop, ...Object.values(photo?.versions ?? {}).map((v) => v.develop)];
    for (const develop of edits) {
      await keepAll(entry.keep, asset.hash, develop && renderedDevelop({ path: asset.path, develop }));
    }
  }
  return new Map([...out].map(([folder, { hashes, keep }]) => [folder, { hashes, keep: [...keep] }]));
}

export type RenderOutcome = 'done' | 'cancelled';

/** What the publish gate needs to run its denoise and render jobs. */
interface GateOptions {
  folder: string;
  book: Book;
  onEvent: (event: PublishEvent) => void;
  /** Aborted when the publish is cancelled: the jobs this gate queued are cancelled (ones it joined are left alone). */
  signal?: AbortSignal;
  /** The project publishing: its jobs are cancelled when it is closed. */
  project?: string | null;
  /** Told the ids of the jobs the gate waits for (queued or joined), so the dialog can count those still pending. */
  onJobs?: (ids: string[]) => void;
}

/**
 * Wait for `handles` in order, cancelling the ones this gate created once the publish is aborted or one of them did
 * not finish (the rest would be thrown away). An abort ends the wait at once, also on a joined job (left running for
 * whoever queued it). `onDone(i)` follows each finished job; `onWatch(i, job)` each change of
 * the one being waited for. Resolves `cancelled` or the index and outcome of the first failure, else `done`.
 */
async function waitAll<T>(
  handles: JobHandle<T>[],
  signal: AbortSignal | undefined,
  onWatch: (i: number, job: Job) => void,
  onDone: (i: number, value: T) => void,
): Promise<
  { state: 'done' } | { state: 'cancelled' } | { state: 'failed'; index: number; error: string; cause: unknown }
> {
  const cancelRest = () => {
    for (const h of handles) if (h.created) cancelJob(h.id);
  };
  signal?.addEventListener('abort', cancelRest, { once: true });
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal?.aborted) resolve('aborted');
    signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  try {
    for (const [i, handle] of handles.entries()) {
      if (signal?.aborted) return { state: 'cancelled' };
      const current = useJobsStore.getState().jobs[handle.id];
      if (current) onWatch(i, current);
      const unwatch = watchJob(handle.id, (job) => onWatch(i, job));
      const outcome = await Promise.race([handle.result, aborted]).finally(unwatch);
      if (outcome === 'aborted') return { state: 'cancelled' };
      if (outcome.state === 'cancelled') {
        cancelRest();
        return { state: 'cancelled' };
      }
      if (outcome.state === 'failed') {
        cancelRest();
        return { state: 'failed', index: i, error: outcome.error, cause: outcome.cause };
      }
      onDone(i, outcome.value);
    }
    return signal?.aborted ? { state: 'cancelled' } : { state: 'done' };
  } finally {
    signal?.removeEventListener('abort', cancelRest);
  }
}

const missingModelText = (model: AiModelInfo) =>
  `Denoise needs the ${model.title} model (${modelSizeLabel(model.bytes)}). Download it from Denoise in the Develop view, then publish again.`;

/**
 * Step D5.2 and plan 09: denoise every used photo whose `detail.denoise` intermediate is not on disk yet before
 * `renderBeforePublish` (the full renders start from the intermediate, so they must find it). Each one is a `denoise`
 * job in the queue (`lib/jobs/denoise.ts`; a run already queued or running for the same bytes and settings, an Apply in
 * Develop, is joined) and the gate waits for them in turn. Reports a `denoise` step with one progress line per tile
 * (`done` / `total` are the photo's place in the queue, `detail` is `DSCF1001.jpg · tile 40/117`). Photos whose full
 * render is already cached are skipped: it was made from the intermediate. Photos sharing bytes and denoise settings
 * share one run. Rejects, before queueing anything, when a needed model is not installed (the message names it and its
 * size) and with the first failure. Resolves `cancelled` when `signal` aborted or a job was cancelled (from the bar).
 */
export async function denoiseBeforePublish(options: GateOptions): Promise<RenderOutcome> {
  const { folder, book, onEvent, signal, project, onJobs } = options;
  const started = performance.now();
  const items: Array<{
    assetId: string;
    folder: string;
    relPath: string;
    hash: string;
    settings: DevelopSettings;
    label: string;
  }> = [];
  for (const assetId of usedAssetIds(book.pages)) {
    const asset = book.assets[assetId];
    const settings = asset && resolveAssetDevelop(asset);
    if (!asset || !settings?.detail.denoise) continue;
    if (!asset.hash) throw new Error(`${basename(asset.path)} has not been hashed yet; wait for the scan to finish`);
    items.push({
      assetId,
      folder: folderOf(book, asset, folder),
      relPath: asset.path,
      hash: asset.hash,
      settings,
      label: basename(asset.path),
    });
  }
  if (items.length === 0) return 'done';

  const targets = await developedTargets(book, folder);
  const names = new Map(targets.map((t) => [t.assetId, t.name]));
  // Render file names present, per folder: `<folder>\n<name>`.
  const present = new Set<string>();
  for (const [dir, group] of byFolder(targets)) {
    for (const name of await developRendersPresent(dir, [...new Set(group.map((t) => t.name))])) {
      present.add(`${dir}\n${name}`);
    }
  }
  const queue: Array<(typeof items)[number] & { status: DenoiseStatus }> = [];
  const keys = new Set<string>();
  for (const item of items) {
    const status = await denoiseStatus(item.hash, item.settings);
    const model = item.settings.detail.denoise?.model ?? '';
    if (!status.key) throw new Error(`${item.label}: the ${model} denoise model is not available`);
    if (status.ready || keys.has(status.key) || present.has(`${item.folder}\n${names.get(item.assetId) ?? ''}`)) {
      continue;
    }
    keys.add(status.key);
    queue.push({ ...item, status });
  }
  const missing = queue.find((q) => isModelMissing(q.status.model))?.status.model;
  if (missing) throw new Error(missingModelText(missing));
  if (queue.length === 0) {
    devLog('publish', `denoise 0 stale, ${items.length} ok`);
    onEvent({ type: 'step', step: 'denoise', status: 'done', ms: 0, detail: `${items.length} up to date`, t: 0 });
    return 'done';
  }
  if (signal?.aborted) return 'cancelled';

  onEvent({ type: 'step', step: 'denoise', status: 'start', t: 0 });
  const handles = queue.map((item) =>
    enqueueDenoise({
      folder: item.folder,
      relPath: item.relPath,
      hash: item.hash,
      settings: item.settings,
      label: item.label,
      ref: item.assetId,
      project,
    }),
  );
  onJobs?.(handles.map((h) => h.id));
  const result = await waitAll(
    handles,
    signal,
    (i, job) => {
      const item = queue[i];
      if (!item) return;
      const detail = job.state === 'queued' ? 'waiting' : job.total > 0 ? `tile ${job.done}/${job.total}` : 'preparing';
      if (job.state === 'running' && job.total > 0) {
        devLog('publish', `denoising ${i + 1}/${queue.length} ${item.label} tile ${job.done}/${job.total}`);
      }
      onEvent({
        type: 'progress',
        step: 'denoise',
        done: i + 1,
        total: queue.length,
        detail: `${item.label} · ${detail}`,
        t: 0,
      });
    },
    () => {},
  );
  if (result.state === 'failed') {
    if (result.cause instanceof MissingModelError) throw new Error(missingModelText(result.cause.model));
    throw new Error(`${queue[result.index]?.label}: ${result.error}`);
  }
  if (result.state === 'cancelled') return 'cancelled';
  const ms = Math.round(performance.now() - started);
  devLog('publish', `denoise ${queue.length} run, ${ms}ms`);
  onEvent({ type: 'step', step: 'denoise', status: 'done', ms, detail: `${queue.length} denoised`, t: 0 });
  return 'done';
}

/**
 * Render every used developed photo whose full render is missing, as one `render` job per photo
 * (`lib/jobs/developRender.ts`; an equal render already queued or running is joined), and wait for them, reporting a
 * `develop` step and per-photo progress through `onEvent`. Resolves `cancelled` when `signal` aborted (the jobs it
 * queued are cancelled) or a job was cancelled from the bar, and rejects with the first photo's error, which cancels
 * the rest.
 */
export async function renderBeforePublish(options: GateOptions): Promise<RenderOutcome> {
  const { folder, book, onEvent, signal, project, onJobs } = options;
  const started = performance.now();
  const targets = await developedTargets(book, folder);
  if (targets.length === 0) return 'done';
  // Per folder (the render cache is the photo's folder's). Two photos there with the same bytes and settings share one
  // render file.
  const missing: DevelopTarget[] = [];
  for (const [dir, group] of byFolder(targets)) {
    const present = new Set(await developRendersPresent(dir, [...new Set(group.map((t) => t.name))]));
    const seen = new Set<string>();
    for (const t of group) {
      if (present.has(t.name) || seen.has(t.name)) continue;
      seen.add(t.name);
      missing.push(t);
    }
  }
  // Workflow plan 18: one readable error listing the photos whose LUT file is gone, before any render starts.
  const lutError = await missingLutMessage(missing.map((t) => ({ label: basename(t.relPath), settings: t.settings })));
  if (lutError) throw new Error(lutError);
  if (missing.length === 0) {
    devLog('publish', `develop renders 0 missing, ${targets.length} ok, ${Math.round(performance.now() - started)}ms`);
    onEvent({ type: 'step', step: 'develop', status: 'done', ms: 0, detail: `${targets.length} up to date`, t: 0 });
    return 'done';
  }
  if (signal?.aborted) return 'cancelled';

  onEvent({ type: 'step', step: 'develop', status: 'start', t: 0 });
  const handles = missing.map(({ folder: dir, name, assetId, relPath, hash, settings }) =>
    enqueueRender({
      folder: dir,
      items: [{ assetId, relPath, hash, settings }],
      label: basename(relPath),
      outputProfile: book.outputProfile,
      ref: assetId,
      project,
      dedupe: `${dir}\n${name}`,
    }),
  );
  onJobs?.(handles.map((h) => h.id));
  let ok = 0;
  const result = await waitAll(
    handles,
    signal,
    () => {},
    (i) => {
      ok += 1;
      const label = basename(missing[i]?.relPath ?? '');
      devLog('publish', `rendering edited photos ${ok}/${missing.length} ${label}`);
      onEvent({ type: 'progress', step: 'develop', done: ok, total: missing.length, detail: label, t: 0 });
    },
  );
  const ms = Math.round(performance.now() - started);
  devLog('publish', `develop renders ${missing.length} missing, ${ok} ok, ${ms}ms`);
  if (result.state === 'failed') throw new Error(`${basename(missing[result.index]?.relPath ?? '')}: ${result.error}`);
  if (result.state === 'cancelled') return 'cancelled';
  onEvent({ type: 'step', step: 'develop', status: 'done', ms, detail: `${ok} rendered`, t: 0 });
  return 'done';
}

/**
 * After a successful publish: delete full renders of the book's own photos that neither their current settings nor any
 * edit of their folder library (`libraries`: the master and every version, which other projects may use) needs, in
 * either output profile, in each of its folders (`folder` is the primary one). Renders of photos the book does not
 * have are left alone: another project on the folder may use them. Never throws.
 */
export async function pruneAfterPublish(
  folder: string,
  book: Book,
  libraries: Record<string, Library> = {},
): Promise<void> {
  try {
    let removed = 0;
    for (const [dir, { hashes, keep }] of await currentRenderNames(book, folder, libraries)) {
      if (hashes.size > 0) removed += await pruneDevelopRenders(dir, keep, [...hashes]);
    }
    devLog('publish', 'pruned stale develop renders', { removed });
  } catch (err) {
    devLog('publish', 'prune develop renders failed', { error: errorMessage(err) });
  }
}
