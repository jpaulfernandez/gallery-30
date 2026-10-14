import { type Book, createDevelop, DEFAULT_DENOISE, type Denoise, type DevelopSettings } from '@photobook/shared';
import { useEffect } from 'react';
import { usedAssetIds } from '../components/filmstrip/visible';
import { photoFileOf, refreshDeveloped } from '../store/assets';
import { beginGesture, endGesture, useBookStore } from '../store/book';
import { estimateDenoiseMs, useDenoisePrefs } from '../store/denoisePrefs';
import { activeJobFor, isActive, type JobHandle, type JobsState, useJobsStore } from '../store/jobs';
import { assetDevelop, assetFolder, hasPhoto, photoMeta, recordPhotoNoise } from '../store/library';
import { useUiStore } from '../store/ui';
import { isModelMissing, profileEvidence, suggestedAmount, switchOnDenoise } from './denoise';
import { errorMessage } from './errors';
import { enqueueDenoise, MissingModelError } from './jobs/denoise';
import { devError, devLog } from './log';
import { basename } from './path';
import { type AiModelInfo, type DenoiseResult, denoiseStatus, type NoiseProfile, noiseProfile } from './tauri';

/**
 * Workflow plan 27: denoise ahead of time. *Denoise selected* (the Develop batch bar, the Cull menu) plans a batch
 * (`planDenoiseBatch`: which photos run, which are already denoised, the estimate) and queues one `denoise` job per
 * photo (`startDenoiseBatch`); the render/denoise lane runs them one at a time and each can be cancelled alone. Photos
 * with denoise off are switched on first (one undo step) with the model from Settings → Models and the amount their
 * noise profile suggests (`switchOnDenoise`; a photo never measured is measured first through `noiseProfile`).
 * Leaving a photo in Develop whose denoise settings changed queues its full run (`queueDenoiseIfStale`, wired by
 * `useQueueDenoiseOnLeave`); plan 28 adds the "Needs apply" pill on top.
 */

/** A measured profile this confident stands for the photo in the library (as the Denoise group records it). */
const RECORD_CONFIDENCE = 0.3;
/** Noise measurements at once (Rust allows 2 `noise_profile` calls at a time). */
const MEASURE_AT_ONCE = 2;

const profiles = new Map<string, NoiseProfile>();
const measuring = new Map<string, Promise<NoiseProfile>>();

/** Forget the measured profiles (tests). */
export function forgetBatchNoiseProfiles(): void {
  profiles.clear();
  measuring.clear();
}

/** The photo's noise profile (`noise_profile`, once per hash this session); its σ is recorded on the library. */
export function measureNoise(folder: string, relPath: string, hash: string): Promise<NoiseProfile> {
  const known = profiles.get(hash);
  if (known) return Promise.resolve(known);
  const pending = measuring.get(hash);
  if (pending) return pending;
  const request = noiseProfile(folder, relPath, hash)
    .then((profile) => {
      profiles.set(hash, profile);
      if (profile.measured.confidence >= RECORD_CONFIDENCE) recordPhotoNoise(folder, relPath, profile.measured.sigma);
      return profile;
    })
    .finally(() => measuring.delete(hash));
  measuring.set(hash, request);
  return request;
}

/** A plan stopped through its `AbortSignal` (the confirm closed, or "Run again" changed). */
export class PlanAborted extends Error {
  constructor() {
    super('Aborted');
    this.name = 'PlanAborted';
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PlanAborted();
}

/** Run `work` over `items`, `limit` at a time, in order of start; stops starting new ones once `signal` aborts. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      checkAborted(signal);
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export interface DenoiseBatchItem {
  /** Photo id: a project asset id or a library key. */
  id: string;
  label: string;
  folder: string;
  relPath: string;
  hash: string;
  /** The settings the run uses (denoise switched on when `switchOn`). */
  settings: DevelopSettings;
  /** Denoise is off for the photo: these values switch it on before the run. */
  switchOn: Partial<Denoise> | null;
  /** Its intermediate is on disk already. */
  ready: boolean;
  /** Estimated run time (the model's last per-tile timing × this photo's tiles), null before any timed run. */
  estimateMs: number | null;
  /** Its model is not downloaded: it cannot run until it is. */
  modelMissing: boolean;
}

export interface DenoiseBatchPlan {
  force: boolean;
  /** Every photo the batch can act on. */
  items: DenoiseBatchItem[];
  /** The photos it queues: not denoised yet (all of them with `force`) and whose model is installed. */
  todo: DenoiseBatchItem[];
  /** Photos that would run but whose model is not downloaded (`missingModel`); not queued. */
  blocked: number;
  /** Already denoised for their settings, left alone (re-run with `force`). */
  skipped: number;
  /** A denoise of theirs is queued or running already. */
  queued: number;
  /** Not hashed yet, not readable, or a model the app does not know. */
  unreadable: number;
  /** The model the `blocked` photos need, not downloaded; null when every photo to run can. */
  missingModel: AiModelInfo | null;
  /** Sum of the `todo` estimates that are known; null when no run of their models was ever timed. */
  estimateMs: number | null;
  /** `todo` photos without an estimate (no size known, or a model never timed) while others have one. */
  unestimated: number;
}

/** What a photo id stands for now: folder, path, hash and settings; null when it cannot be denoised. */
function targetOf(id: string) {
  const state = useBookStore.getState();
  if (!hasPhoto(state, id)) return null;
  const folder = assetFolder(state, id);
  const meta = photoMeta(state, id);
  const file = photoFileOf(id);
  const hash = meta?.hash ?? file?.hash;
  if (!folder || !meta || !hash) return null;
  return {
    folder,
    relPath: meta.path,
    hash,
    settings: assetDevelop(state, id) ?? createDevelop(),
    width: meta.width ?? file?.width,
    height: meta.height ?? file?.height,
    iso: file?.iso,
  };
}

/** The denoise values switching a photo on in a batch: the Settings model, the amount its noise suggests. */
async function switchOnFor(target: NonNullable<ReturnType<typeof targetOf>>): Promise<Partial<Denoise>> {
  let profile: NoiseProfile | null = null;
  try {
    profile = await measureNoise(target.folder, target.relPath, target.hash);
  } catch (err) {
    devLog('denoise', 'batch: noise not measured, using the ISO', {
      relPath: target.relPath,
      error: errorMessage(err),
    });
  }
  const suggestion = suggestedAmount(profileEvidence(profile, target.iso));
  return { model: useDenoisePrefs.getState().model, ...switchOnDenoise(suggestion) };
}

/**
 * Plan *Denoise selected* for `ids`: measure the photos with denoise off that have no profile yet (`onMeasure`
 * follows), read each photo's denoise status for the settings it will run with, and estimate the time. Nothing is
 * written or queued.
 */
export async function planDenoiseBatch(
  ids: readonly string[],
  options: { force?: boolean; onMeasure?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<DenoiseBatchPlan> {
  const force = options.force ?? false;
  const { signal } = options;
  const { timing } = useDenoisePrefs.getState();
  const unique = [...new Set(ids)];
  let unreadable = 0;
  let queued = 0;
  const targets: Array<{ id: string; target: NonNullable<ReturnType<typeof targetOf>> }> = [];
  for (const id of unique) {
    const target = targetOf(id);
    if (!target) unreadable += 1;
    else if (activeJobFor(useJobsStore.getState(), 'denoise', id)) queued += 1;
    else targets.push({ id, target });
  }
  const off = targets.filter((t) => !t.target.settings.detail.denoise);
  let measured = 0;
  if (off.length > 0) options.onMeasure?.(0, off.length);
  const switchOn = new Map<string, Partial<Denoise>>();
  await pool(
    off,
    MEASURE_AT_ONCE,
    async ({ id, target }) => {
      switchOn.set(id, await switchOnFor(target));
      if (signal?.aborted) return;
      measured += 1;
      options.onMeasure?.(measured, off.length);
    },
    signal,
  );

  const items: DenoiseBatchItem[] = [];
  let missingModel: AiModelInfo | null = null;
  for (const { id, target } of targets) {
    checkAborted(signal);
    const patch = switchOn.get(id) ?? null;
    const settings: DevelopSettings = patch
      ? { ...target.settings, detail: { ...target.settings.detail, denoise: { ...DEFAULT_DENOISE, ...patch } } }
      : target.settings;
    const status = await denoiseStatus(target.hash, settings);
    if (!status.key) {
      unreadable += 1;
      continue;
    }
    const modelMissing = isModelMissing(status.model);
    if (modelMissing && (force || !status.ready)) missingModel ??= status.model;
    const model = settings.detail.denoise?.model;
    items.push({
      id,
      label: basename(target.relPath),
      folder: target.folder,
      relPath: target.relPath,
      hash: target.hash,
      settings,
      switchOn: patch,
      ready: status.ready,
      estimateMs: model ? estimateDenoiseMs(timing[model], target.width, target.height) : null,
      modelMissing,
    });
  }
  checkAborted(signal);
  const wanted = items.filter((i) => force || !i.ready);
  const todo = wanted.filter((i) => !i.modelMissing);
  const known = todo.flatMap((i) => (i.estimateMs === null ? [] : [i.estimateMs]));
  const timed = todo.some((i) => {
    const model = i.settings.detail.denoise?.model;
    return model !== undefined && timing[model] !== undefined;
  });
  return {
    force,
    items,
    todo,
    blocked: wanted.length - todo.length,
    skipped: items.length - wanted.length,
    queued,
    unreadable,
    missingModel,
    estimateMs: timed ? known.reduce((a, b) => a + b, 0) : null,
    unestimated: timed ? todo.length - known.length : 0,
  };
}

/** Record a finished run as Apply does (the session's last run, the preview epoch, a fresh render) or its error. */
function follow(id: string, relPath: string, handle: JobHandle<DenoiseResult>): void {
  void handle.result.then(async (outcome) => {
    const ui = useUiStore.getState();
    if (outcome.state === 'done') {
      const result = outcome.value;
      devLog('denoise', `queued denoise of ${relPath} done in ${result.elapsedMs}ms (${result.tiles} tiles)`);
      ui.updateDenoise((d) => ({
        runs: { ...d.runs, [id]: { key: result.key, elapsedMs: result.elapsedMs, engine: result.engine } },
        epoch: d.epoch + 1,
      }));
      await refreshDeveloped(id).catch((err) => devLog('denoise', 'refresh failed', { id, error: errorMessage(err) }));
    } else if (outcome.state === 'failed') {
      if (!(outcome.cause instanceof MissingModelError))
        devError('denoise', `denoise failed for ${relPath}`, outcome.cause);
      ui.updateDenoise((d) => ({ errors: { ...d.errors, [id]: outcome.error } }));
    } else if (outcome.state === 'cancelled') {
      // Plan 28: a cancelled run is not queued again on leaving until the settings change.
      dismissNeedsApply(id);
    }
  });
}

/** The project a job for `id` belongs to: the open project's for its assets, none for a library photo. */
function projectOf(id: string): string | null {
  const { book, projectId } = useBookStore.getState();
  return book && Object.hasOwn(book.assets, id) ? projectId : null;
}

/**
 * Carry out a plan: switch denoise on for the photos that had it off (one undo step for all), then queue one `denoise`
 * job per photo of `todo` (an equal job already queued is joined). Photos whose model is missing are neither switched
 * on nor queued. A photo whose denoise was switched on since the plan was made keeps the user's settings (and runs
 * with them).
 */
export function startDenoiseBatch(plan: DenoiseBatchPlan): JobHandle<DenoiseResult>[] {
  const book = useBookStore.getState();
  const switching = plan.items.filter(
    (i) => i.switchOn && !i.modelMissing && !assetDevelop(useBookStore.getState(), i.id)?.detail.denoise,
  );
  if (switching.length > 0) {
    beginGesture();
    try {
      for (const item of switching) book.setDenoise(item.id, item.switchOn);
    } finally {
      endGesture();
    }
  }
  const handles = plan.todo.map((item) => {
    // The settings as written (the store may normalise them), so the run's key is the one renders look for.
    const settings = assetDevelop(useBookStore.getState(), item.id) ?? item.settings;
    const handle = enqueueDenoise({
      folder: item.folder,
      relPath: item.relPath,
      hash: item.hash,
      settings: settings.detail.denoise ? settings : item.settings,
      label: item.label,
      ref: item.id,
      project: projectOf(item.id),
      ...(plan.force ? { force: true } : {}),
    });
    if (handle.created) follow(item.id, item.relPath, handle);
    return handle;
  });
  devLog('denoise', 'denoise selected', {
    blocked: plan.blocked,
    queued: handles.length,
    switchedOn: switching.length,
    skipped: plan.skipped,
    force: plan.force,
  });
  return handles;
}

/** Plan and start a batch at once (no confirm): the plan and the jobs queued. */
export async function enqueueDenoiseBatch(
  ids: readonly string[],
  options: { force?: boolean } = {},
): Promise<{ plan: DenoiseBatchPlan; handles: JobHandle<DenoiseResult>[] }> {
  const plan = await planDenoiseBatch(ids, options);
  return { plan, handles: startDenoiseBatch(plan) };
}

/** The photo's denoise settings as a string, to tell whether they changed. */
export function denoiseSignature(id: string): string {
  return JSON.stringify(assetDevelop(useBookStore.getState(), id)?.detail.denoise ?? null);
}

/**
 * Queue the full denoise of `id` when its intermediate is stale: denoise is on, nothing for the current settings is on
 * disk or queued, and the model is installed. With `since` (a `denoiseSignature` from earlier), only when the settings
 * changed since. Resolves the job queued, or null. Never throws.
 */
export async function queueDenoiseIfStale(
  id: string,
  options: { since?: string } = {},
): Promise<JobHandle<DenoiseResult> | null> {
  try {
    if (options.since !== undefined && options.since === denoiseSignature(id)) return null;
    const target = targetOf(id);
    if (!target?.settings.detail.denoise) return null;
    if (activeJobFor(useJobsStore.getState(), 'denoise', id)) return null;
    const status = await denoiseStatus(target.hash, target.settings);
    if (!status.key || status.ready || isModelMissing(status.model)) return null;
    // The settings may have moved on while the status was read: queue what the photo has now.
    const now = targetOf(id);
    if (!now?.settings.detail.denoise || denoiseSignature(id) !== JSON.stringify(target.settings.detail.denoise)) {
      return null;
    }
    const handle = enqueueDenoise({
      folder: now.folder,
      relPath: now.relPath,
      hash: now.hash,
      settings: now.settings,
      label: basename(now.relPath),
      ref: id,
      project: projectOf(id),
    });
    if (handle.created) follow(id, now.relPath, handle);
    devLog('denoise', 'left a photo with changed denoise settings: queued its run', { relPath: now.relPath });
    return handle;
  } catch (err) {
    devLog('denoise', 'queue on leave failed', { id, error: errorMessage(err) });
    return null;
  }
}

/**
 * Photos whose Denoise group last showed *Needs apply* (workflow plan 28): the group marks them (`markNeedsApply`) and
 * leaving such a photo queues its run even when its settings did not change while it was shown.
 */
const needsApply = new Set<string>();
/** Photos whose run was cancelled, with their denoise settings then: not marked again until the settings change. */
const dismissed = new Map<string, string>();

/**
 * The Denoise group shows *Needs apply* for `id` (true), or something else (false). Ignored (true) while the photo's
 * run was cancelled with the settings it has now (`dismissNeedsApply`).
 */
export function markNeedsApply(id: string, on: boolean): void {
  if (!on) {
    needsApply.delete(id);
    return;
  }
  const cancelledWith = dismissed.get(id);
  if (cancelledWith !== undefined) {
    if (cancelledWith === denoiseSignature(id)) return;
    dismissed.delete(id);
  }
  needsApply.add(id);
}

/** The user cancelled the photo's run (or it was cancelled): leaving it does not queue it again until its settings change. */
export function dismissNeedsApply(id: string): void {
  needsApply.delete(id);
  dismissed.set(id, denoiseSignature(id));
}

/** The group last showed *Needs apply* for `id`. */
export const shownNeedsApply = (id: string): boolean => needsApply.has(id);

/**
 * Develop: when the view steps away from `id` (or closes) after its denoise settings changed, or while its Denoise
 * group showed *Needs apply* (plan 28), queue the full run (`queueDenoiseIfStale`).
 */
export function useQueueDenoiseOnLeave(id: string): void {
  useEffect(() => {
    if (!id) return;
    // The settings at arrival, taken once the photo's folder library is loaded: a library arriving late (and with it
    // the photo's own denoise settings) is not a change the user made.
    let since = libraryLoaded(id) ? denoiseSignature(id) : undefined;
    const unsubscribe =
      since === undefined
        ? useBookStore.subscribe(() => {
            if (since === undefined && libraryLoaded(id)) since = denoiseSignature(id);
          })
        : () => {};
    return () => {
      unsubscribe();
      const marked = needsApply.delete(id);
      // A run that failed for this photo is not retried behind the user's back: Apply retries it (plan 28).
      if (useUiStore.getState().denoise.errors[id] !== undefined) return;
      if (dismissed.get(id) === denoiseSignature(id)) return;
      if (marked) void queueDenoiseIfStale(id);
      else if (since !== undefined) void queueDenoiseIfStale(id, { since });
    };
  }, [id]);
}

/** The library of the folder `id` lives in is loaded (its develop settings are known). */
function libraryLoaded(id: string): boolean {
  const state = useBookStore.getState();
  const folder = assetFolder(state, id);
  return folder !== null && Object.hasOwn(state.libraries, folder);
}

/**
 * How many of the book's used photos have a denoise queued or running (any origin: Denoise selected, Apply, leaving a
 * photo, a publish), matched by content hash so a library key's job counts for the project asset of the same file.
 */
export function pendingDenoiseCount(jobs: JobsState, book: Book | null | undefined): number {
  if (!book) return 0;
  const hashes = usedHashes(book);
  if (hashes.size === 0) return 0;
  const state = useBookStore.getState();
  let n = 0;
  for (const job of Object.values(jobs.jobs)) {
    if (job.kind !== 'denoise' || !isActive(job) || !job.ref) continue;
    const hash = book.assets[job.ref]?.hash ?? photoMeta(state, job.ref)?.hash ?? photoFileOf(job.ref)?.hash;
    if (hash && hashes.has(hash)) n += 1;
  }
  return n;
}

const usedHashCache = new WeakMap<Book, Set<string>>();

/** The content hashes of the book's used photos, once per book object. */
function usedHashes(book: Book): Set<string> {
  const known = usedHashCache.get(book);
  if (known) return known;
  const hashes = new Set<string>();
  for (const id of usedAssetIds(book.pages)) {
    const hash = book.assets[id]?.hash;
    if (hash) hashes.add(hash);
  }
  usedHashCache.set(book, hashes);
  return hashes;
}
