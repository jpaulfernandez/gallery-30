import type { DevelopGeometry, DevelopSettings } from '@photobook/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isModelMissing, nextDenoiseJob } from '../../lib/denoise';
import { dismissNeedsApply, markNeedsApply } from '../../lib/denoiseQueue';
import { errorMessage } from '../../lib/errors';
import { denoiseJobKey, enqueueDenoise, MissingModelError } from '../../lib/jobs/denoise';
import { devError, devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import {
  type AiModelInfo,
  cancelModelDownload,
  type DenoiseStatus,
  denoiseStatus,
  downloadModel,
  onModelProgress,
  previewDenoiseCrop,
} from '../../lib/tauri';
import { photoFileOf, refreshDeveloped, usePhotoFile, usePhotoHash } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { estimateDenoiseMs, useDenoisePrefs } from '../../store/denoisePrefs';
import { activeJobByDedupe, activeJobFor, cancelJob, type Job, type JobsState, useJobsStore } from '../../store/jobs';
import { assetDevelop, assetFolder, photoMeta } from '../../store/library';
import { type DenoiseUi, useUiStore } from '../../store/ui';

/** Where the Denoise group's settings come from: the open book and the scan. */
export interface DenoiseTarget {
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
}

/** The folder, path, content hash and settings of `assetId` now, or null while the scan has no hash for it. */
export function denoiseTarget(assetId: string): DenoiseTarget | null {
  const state = useBookStore.getState();
  const folder = assetFolder(state, assetId);
  const asset = photoMeta(state, assetId);
  const settings = assetDevelop(state, assetId);
  if (!folder || !asset || !settings) return null;
  const hash = asset.hash ?? photoFileOf(assetId)?.hash;
  return hash ? { folder, relPath: asset.path, hash, settings } : null;
}

const update = (patch: (prev: DenoiseUi) => Partial<DenoiseUi>) => useUiStore.getState().updateDenoise(patch);

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

const setError = (key: string, message: string | null) =>
  update((d) => ({ errors: message === null ? without(d.errors, key) : { ...d.errors, [key]: message } }));

/**
 * Apply: queue the full-resolution denoise for the photo's current settings (a `denoise` job, `lib/jobs/denoise.ts`;
 * one already queued or running for the same bytes and settings is joined), with its tile progress in the jobs store,
 * then re-render the photo (`refreshDeveloped`: the cached render predates the intermediate) and bump the epoch so the
 * live preview renders from it. One run per photo at a time. Never throws; failures land in `errors`.
 */
export async function applyDenoise(assetId: string): Promise<void> {
  if (activeJobFor(useJobsStore.getState(), 'denoise', assetId)) return;
  const target = denoiseTarget(assetId);
  if (!target?.settings.detail.denoise) return;
  setError(assetId, null);
  const { book, projectId } = useBookStore.getState();
  const handle = enqueueDenoise({
    ...target,
    label: basename(target.relPath),
    ref: assetId,
    // A project's photo: closing the project cancels it. A library photo's run belongs to no project.
    project: book && Object.hasOwn(book.assets, assetId) ? projectId : null,
  });
  const outcome = await handle.result;
  if (outcome.state === 'done') {
    const result = outcome.value;
    devLog('develop', `denoised ${target.relPath} in ${result.elapsedMs}ms (${result.tiles} tiles, ${result.engine})`);
    update((d) => ({
      runs: { ...d.runs, [assetId]: { key: result.key, elapsedMs: result.elapsedMs, engine: result.engine } },
      epoch: d.epoch + 1,
    }));
    await refreshDeveloped(assetId).catch((err) => setError(assetId, errorMessage(err)));
  } else if (outcome.state === 'failed') {
    if (!(outcome.cause instanceof MissingModelError)) {
      devError('develop', `denoise failed for ${target.relPath}`, outcome.cause);
    }
    setError(assetId, outcome.error);
  } else {
    // Cancelled: leaving the photo does not queue it again until its settings change (plan 28).
    dismissNeedsApply(assetId);
  }
}

/**
 * The photo's queued or running denoise: its own (by photo id), or an equal one (same bytes and settings, the job an
 * Apply would join through `denoiseJobKey`) started for another id of the same file, such as its library key.
 */
export function denoiseJobOf(
  s: JobsState,
  assetId: string,
  hash: string | undefined,
  settings: DevelopSettings | undefined,
): Job | undefined {
  const own = activeJobFor(s, 'denoise', assetId);
  if (own || !hash || !settings?.detail.denoise) return own;
  return activeJobByDedupe(s, 'denoise', denoiseJobKey(hash, settings));
}

/** Stop the Apply of `assetId` (its queued or running denoise job) before its next tile. */
export async function cancelDenoiseJob(assetId: string): Promise<void> {
  const target = denoiseTarget(assetId);
  const job = denoiseJobOf(useJobsStore.getState(), assetId, target?.hash, target?.settings);
  if (job) {
    dismissNeedsApply(assetId);
    cancelJob(job.id);
  }
}

/** The key under which a model download's failure is kept in `DenoiseUi.errors`. */
export const downloadErrorKey = (modelName: string) => `model:${modelName}`;

/** Download (or resume) a model, with `models:progress` in the UI store. Never throws; `cancelled` is not an error. */
export async function downloadDenoiseModel(model: AiModelInfo): Promise<void> {
  if (useUiStore.getState().denoise.downloads[model.name]) return;
  const job = nextDenoiseJob();
  const start = model.status.state === 'partial' ? model.status.bytes : 0;
  update((d) => ({
    downloads: { ...d.downloads, [model.name]: { job, received: start, total: model.bytes } },
    errors: without(d.errors, downloadErrorKey(model.name)),
  }));
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await onModelProgress((e) => {
      if (e.job !== job) return;
      update((d) => ({ downloads: { ...d.downloads, [model.name]: { job, received: e.received, total: e.total } } }));
    });
    await downloadModel(model.name, job);
  } catch (err) {
    const message = errorMessage(err);
    if (message !== 'cancelled') setError(downloadErrorKey(model.name), message);
  } finally {
    unlisten?.();
    update((d) => ({ downloads: without(d.downloads, model.name) }));
  }
}

/** Stop a model download between chunks (the partial file is kept). */
export async function cancelDenoiseDownload(modelName: string): Promise<void> {
  const download = useUiStore.getState().denoise.downloads[modelName];
  if (download) await cancelModelDownload(download.job).catch(() => false);
}

/** What the status line says. */
export type DenoiseView =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'missingModel'; model: AiModelInfo }
  | { kind: 'applied'; elapsedMs: number | null }
  | { kind: 'stale' }
  | { kind: 'idle' };

/**
 * The state behind the status line, from `denoiseStatus` and what this session knows. An intermediate that is not
 * there yet is "stale" (settings changed) when this session applied the photo with other settings, else "idle" (never
 * applied). A missing model matters only while there is nothing to use.
 */
export function denoiseView(input: {
  on: boolean;
  status: DenoiseStatus | null;
  running: boolean;
  lastRun: { key: string; elapsedMs: number } | undefined;
}): DenoiseView {
  const { on, status, running, lastRun } = input;
  if (!on) return { kind: 'off' };
  if (running) return { kind: 'running' };
  if (!status) return { kind: 'loading' };
  if (status.ready) {
    const elapsed = lastRun && lastRun.key === status.key && lastRun.elapsedMs > 0 ? lastRun.elapsedMs : null;
    return { kind: 'applied', elapsedMs: elapsed };
  }
  if (isModelMissing(status.model)) return { kind: 'missingModel', model: status.model };
  return lastRun && lastRun.key !== status.key ? { kind: 'stale' } : { kind: 'idle' };
}

/**
 * The group row's state (workflow plan 28), the state machine on top of `denoiseView` and the photo's job:
 * off → checking → *Needs apply* (or *Needs model* until the model is downloaded) → *Queued* → *Running 37 %* →
 * *Applied*; any change that alters the run (Amount, Sharpen, the model, Colour with the model colour) goes back to
 * *Needs apply*. Colour with the chroma filter is applied at render time and keeps *Applied*.
 */
export type DenoisePhase =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'needsModel' }
  | { kind: 'needsApply' }
  | { kind: 'queued' }
  | { kind: 'running'; percent: number; cancelling: boolean }
  | { kind: 'applied' };

export function denoisePhase(
  view: DenoiseView,
  job?: Pick<Job, 'state' | 'done' | 'total' | 'cancelling'> | undefined,
): DenoisePhase {
  switch (view.kind) {
    case 'off':
      return { kind: 'off' };
    case 'loading':
      return { kind: 'checking' };
    case 'missingModel':
      return { kind: 'needsModel' };
    case 'applied':
      return { kind: 'applied' };
    case 'running': {
      if (!job || job.state === 'queued') return { kind: 'queued' };
      const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : 0;
      return { kind: 'running', percent, cancelling: job.cancelling === true };
    }
    default:
      return { kind: 'needsApply' };
  }
}

/** The pill's text for a phase; null when there is no pill (off). */
export function phaseLabel(phase: DenoisePhase): string | null {
  switch (phase.kind) {
    case 'checking':
      return 'Checking…';
    case 'needsModel':
      return 'Needs model';
    case 'needsApply':
      return 'Needs apply';
    case 'queued':
      return 'Queued';
    case 'running':
      return phase.cancelling ? 'Cancelling' : `Running ${phase.percent} %`;
    case 'applied':
      return 'Applied';
    default:
      return null;
  }
}

/** `denoiseStatus` calls in flight by photo, settings and run state: the group and the loupe share one. */
const statusRequests = new Map<string, Promise<DenoiseStatus>>();

/** Forget the `denoiseStatus` calls in flight (tests). */
export const forgetDenoiseStatusRequests = () => statusRequests.clear();

function sharedStatus(requestKey: string, hash: string, settings: DevelopSettings): Promise<DenoiseStatus> {
  const pending = statusRequests.get(requestKey);
  if (pending) return pending;
  const request = denoiseStatus(hash, settings).finally(() => statusRequests.delete(requestKey));
  statusRequests.set(requestKey, request);
  return request;
}

/** `denoiseStatus` for the photo while denoise is on; refetched when the settings, a job or a download changes. */
export function useDenoise(assetId: string, settings: DevelopSettings) {
  const denoise = settings.detail.denoise;
  const fileHash = usePhotoHash(assetId);
  const job = useJobsStore((s) => denoiseJobOf(s, assetId, fileHash, settings));
  const lastRun = useUiStore((s) => s.denoise.runs[assetId]);
  const error = useUiStore((s) => s.denoise.errors[assetId]);
  const [status, setStatus] = useState<{
    assetId: string;
    source: string;
    /** `denoiseJobKey` of the settings asked about: equal keys share one intermediate. */
    run: string;
    /** A run or a download was going on when it was asked. */
    busy: boolean;
    value: DenoiseStatus;
  } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const live = useRef(settings);
  live.current = settings;
  const key = useMemo(() => JSON.stringify(denoise), [denoise]);
  const running = job !== undefined;
  const modelName = status?.value.model?.name;
  const downloading = useUiStore((s) => (modelName ? s.denoise.downloads[modelName] : undefined));
  const downloadError = useUiStore((s) => (modelName ? s.denoise.errors[downloadErrorKey(modelName)] : undefined));
  const busy = running || downloading !== undefined;
  const source = fileHash ? `${assetId}\n${fileHash}\n${key}` : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` stands for the hash and the denoise settings; `busy` refetches when a run or a download ends
  useEffect(() => {
    if (!source || !fileHash || !live.current.detail.denoise) return;
    let alive = true;
    const run = denoiseJobKey(fileHash, live.current);
    sharedStatus(`${source}\n${busy}`, fileHash, live.current).then(
      (value) => {
        if (!alive) return;
        setStatus({ assetId, source, run, busy, value });
        setStatusError(null);
      },
      (err) => alive && setStatusError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [source, busy]);

  const current = denoise && status && status.source === source && status.busy === busy ? status.value : null;
  // A run (or a download) just ended and the status after it is on its way: hold what the row said, so the pill does
  // not flash *Needs apply* between *Running 100 %* and *Applied*.
  const settling = !!denoise && !!status && status.source === source && status.busy && !busy;
  // While the status for new settings is on its way, the photo's previous answer stands in with no intermediate (the
  // key just changed), so the line and the preview do not flicker through "Checking…" on every slider tick.
  // A change that keeps the run (Colour with the chroma filter, plan 24) keeps the previous answer whole.
  const sameRun = !!fileHash && !!status && status.run === denoiseJobKey(fileHash, settings);
  const effective =
    current ??
    (denoise && status && status.assetId === assetId
      ? sameRun
        ? status.value
        : { ...status.value, key: null, ready: false }
      : null);
  const shown = useRef<{ assetId: string; view: DenoiseView; phase: DenoisePhase } | null>(null);
  const held = settling && shown.current?.assetId === assetId ? shown.current : null;
  const view = held ? held.view : denoiseView({ on: denoise !== null, status: effective, running, lastRun });
  const phase = held ? held.phase : denoisePhase(view, job);
  shown.current = { assetId, view, phase };
  // Leaving the photo while it reads *Needs apply* queues its full run (`useQueueDenoiseOnLeave`, plan 27).
  const needsApply = phase.kind === 'needsApply';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` (the settings) re-marks a photo whose cancelled run's settings changed
  useEffect(() => {
    markNeedsApply(assetId, needsApply);
  }, [assetId, needsApply, key]);
  const file = usePhotoFile(assetId);
  const width = useBookStore((s) => photoMeta(s, assetId)?.width) ?? file?.width;
  const height = useBookStore((s) => photoMeta(s, assetId)?.height) ?? file?.height;
  const timing = useDenoisePrefs((s) => (denoise ? s.timing[denoise.model] : undefined));
  const estimateMs = estimateDenoiseMs(timing, width, height);

  const apply = useCallback(() => applyDenoise(assetId), [assetId]);
  const cancel = useCallback(() => cancelDenoiseJob(assetId), [assetId]);
  const fetchModel = useCallback(() => {
    const model = effective?.model;
    return model ? downloadDenoiseModel(model) : Promise.resolve();
  }, [effective]);
  const cancelDownload = useCallback(
    () => (effective?.model ? cancelDenoiseDownload(effective.model.name) : Promise.resolve()),
    [effective],
  );

  return {
    /** Denoise is on for the photo. */
    on: denoise !== null,
    /** The latest `denoiseStatus` for the current settings (the previous answer, without an intermediate, while it loads). */
    status: effective,
    view,
    /** The pill's state (`denoisePhase`). */
    phase,
    /** A full run's estimate from the model's last per-tile timing (plan 27), null before any timed run. */
    estimateMs,
    /** Apply is queued or running (the jobs store's job): tiles done of total (`total` 0 while the model loads). */
    job,
    download: downloading,
    /** The Apply failed, the model download failed, or the status could not be read. */
    error: error ?? downloadError ?? statusError ?? null,
    canApply:
      !!fileHash && !running && !held && effective !== null && !effective.ready && !isModelMissing(effective.model),
    apply,
    cancel,
    fetchModel,
    cancelDownload,
  };
}

/**
 * The crop preview's fraction of the upright source for a click at fraction `(fx, fy)` of the picture shown. The
 * picture shown is the source until a crop is set; an axis-aligned crop (no straighten, no perspective, no rotation)
 * maps through its rectangle. Other geometry is approximated by the click's position in the picture shown.
 */
export function previewCenter(fx: number, fy: number, geometry: DevelopGeometry): [number, number] {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp(fx);
  const y = clamp(fy);
  const { crop, rotate, flipH, flipV, upright, transform } = geometry;
  const plain =
    crop &&
    crop.angle === 0 &&
    rotate === 0 &&
    !flipH &&
    !flipV &&
    upright.mode === 'off' &&
    transform.vertical === 0 &&
    transform.horizontal === 0 &&
    transform.rotate === 0 &&
    transform.aspect === 0 &&
    transform.scale === 100 &&
    transform.offsetX === 0 &&
    transform.offsetY === 0;
  if (!plain) return [x, y];
  return [clamp(crop.rect.x + x * crop.rect.w), clamp(crop.rect.y + y * crop.rect.h)];
}

/** `previewCenter`'s inverse: where a source-frame centre sits in the picture shown (fractions). */
export function shownPosition(center: readonly [number, number], geometry: DevelopGeometry): [number, number] {
  const at = previewCenter(0, 0, geometry);
  const to = previewCenter(1, 1, geometry);
  const w = to[0] - at[0];
  const h = to[1] - at[1];
  const x = w > 0 ? (center[0] - at[0]) / w : center[0];
  const y = h > 0 ? (center[1] - at[1]) / h : center[1];
  return [x, y];
}

/** Where a picture of aspect `ar` (width / height; null: fills the box) sits in a `width` x `height` box, `object-contain`. */
export function containRect(
  width: number,
  height: number,
  ar: number | null,
): { x: number; y: number; w: number; h: number } {
  if (!ar || width <= 0 || height <= 0) return { x: 0, y: 0, w: width, h: height };
  const w = Math.min(width, height * ar);
  const h = w / ar;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/**
 * The sliders have settled this long after the last change before the crop preview renders again (workflow plan 28):
 * never while a slider is held, and on release only once this long has passed since the last move.
 */
export const CROP_PREVIEW_DEBOUNCE_MS = 600;
/**
 * A new photo (stepping with the loupe open), the loupe opening or a new point waits this long before its crops are
 * asked for, so stepping through photos decodes only the one you stop on. Switching denoise on does not wait.
 */
export const CROP_PREVIEW_SETTLE_MS = 200;
/** A switch-on older than this no longer counts for the gate log (nor renders the first crop at once). */
const SWITCH_ON_WINDOW_MS = 10_000;

/**
 * Switch-on times by content hash (`Date.now()`, which fake timers follow), for the plan 28 gate: the first denoised
 * crop after switching denoise on renders at once and logs how long it took
 * (`[photobook:denoise] first crop preview {"ms":…}`). Dropped when the loupe closes or moves to another photo.
 */
const switchedOnAt = new Map<string, number>();

const clock = () => Date.now();

/** Denoise was just switched on for the photo with content hash `hash` (logged, and timed to its first crop). */
export function noteSwitchOn(hash: string | undefined, relPath?: string): void {
  if (!hash) return;
  switchedOnAt.set(hash, clock());
  devLog('denoise', 'switched on', { relPath, at: Math.round(clock()) });
}

/** When denoise was switched on for `hash`, if within `SWITCH_ON_WINDOW_MS`. */
function switchOnOf(hash: string): number | undefined {
  const at = switchedOnAt.get(hash);
  if (at !== undefined && clock() - at > SWITCH_ON_WINDOW_MS) {
    switchedOnAt.delete(hash);
    return undefined;
  }
  return at;
}

/** A pointer press on a slider holds the crop back, except the loupe's own before / after split. */
const holdsCrop = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[role="slider"]:not([data-testid="denoise-loupe-split"])') !== null;

export interface CropPreview {
  before: string | null;
  after: string | null;
  /** The denoised crop is being made. */
  loading: boolean;
  error: string | null;
}

/**
 * The 512 x 512 tuning crop the loupe shows: the denoised crop (`after`) for the current Denoise settings and the
 * untouched one (`before`) for the current point. One schedule drives both: the denoised crop is asked for first and the
 * untouched one only once it is back (Rust caches the full decode per photo, but two first requests at once would
 * decode a 24 MP RAW twice), and only when its point changed. Timing: at once right after denoise was switched on
 * (`noteSwitchOn`); `CROP_PREVIEW_SETTLE_MS` after the loupe opens, the photo changes or the point moves;
 * `CROP_PREVIEW_DEBOUNCE_MS` after the last settings change, never while a slider is held (then the rest of that
 * wait after release). Requests are numbered so a superseded result is dropped, and blob URLs are freed on
 * replacement and unmount.
 */
export function useCropPreview(options: {
  enabled: boolean;
  folder: string | null;
  relPath: string | undefined;
  hash: string | undefined;
  settings: DevelopSettings;
  center: readonly [number, number];
}): CropPreview {
  const { enabled, folder, relPath, hash, settings, center } = options;
  const denoiseKey = useMemo(() => JSON.stringify(settings.detail.denoise), [settings]);
  const source =
    enabled && folder && relPath && hash && settings.detail.denoise ? `${folder}\n${relPath}\n${hash}` : null;
  const [state, setState] = useState<{
    before: string | null;
    after: string | null;
    loading: boolean;
    error: string | null;
  }>({ before: null, after: null, loading: false, error: null });
  const urls = useRef<{ before: string | null; after: string | null }>({ before: null, after: null });
  const latest = useRef({ before: 0, after: 0 });
  /** The source and point the untouched crop on screen (or on its way) was cut at. */
  const beforeFor = useRef<string | null>(null);
  const live = useRef({ folder, relPath, hash, settings, center });
  live.current = { folder, relPath, hash, settings, center };
  const centerKey = `${center[0].toFixed(4)},${center[1].toFixed(4)}`;
  const pointKey = source ? `${source}\n${centerKey}` : null;
  const livePoint = useRef(pointKey);
  livePoint.current = pointKey;

  const setUrl = (which: 'before' | 'after', bytes: ArrayBuffer | null) => {
    const old = urls.current[which];
    if (old) URL.revokeObjectURL(old);
    const url = bytes ? URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) : null;
    urls.current[which] = url;
    setState((s) => ({ ...s, [which]: url }));
  };

  // Free everything when the loupe closes, the photo changes or the view goes away; a switch-on of that photo no
  // longer counts for the gate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `source` is the trigger (and holds the hash); the cleanup reads refs
  useEffect(() => {
    const forHash = source ? hash : undefined;
    return () => {
      latest.current = { before: nextDenoiseJob(), after: nextDenoiseJob() };
      beforeFor.current = null;
      if (forHash) switchedOnAt.delete(forHash);
      for (const which of ['before', 'after'] as const) {
        const url = urls.current[which];
        if (url) URL.revokeObjectURL(url);
        urls.current[which] = null;
      }
      setState({ before: null, after: null, loading: false, error: null });
    };
  }, [source]);

  /** The untouched crop at the current point, unless it is the one already there. */
  const runBefore = () => {
    const point = livePoint.current;
    const now = live.current;
    if (!point || point === beforeFor.current || !now.folder || !now.relPath || !now.hash) return;
    beforeFor.current = point;
    const id = nextDenoiseJob();
    latest.current.before = id;
    previewDenoiseCrop(now.folder, now.relPath, now.hash, now.settings, [...now.center], true).then(
      (bytes) => id === latest.current.before && setUrl('before', bytes),
      () => {
        if (id === latest.current.before) beforeFor.current = null;
      },
    );
  };

  const held = useRef(false);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef<() => void>(() => {});
  run.current = () => {
    timer.current = null;
    pending.current = false;
    const now = live.current;
    if (!now.folder || !now.relPath || !now.hash || !now.settings.detail.denoise) return;
    const id = nextDenoiseJob();
    latest.current.after = id;
    setState((s) => ({ ...s, loading: true, error: null }));
    const hash = now.hash;
    const asked = clock();
    previewDenoiseCrop(now.folder, now.relPath, now.hash, now.settings, [...now.center]).then(
      (bytes) => {
        if (id !== latest.current.after) return;
        const done = clock();
        const since = switchOnOf(hash);
        if (since !== undefined) {
          switchedOnAt.delete(hash);
          devLog('denoise', 'first crop preview', { ms: Math.round(done - since), request: Math.round(done - asked) });
        } else devLog('denoise', 'crop preview', { ms: Math.round(done - asked) });
        setUrl('after', bytes);
        setState((s) => ({ ...s, loading: false }));
        runBefore();
      },
      (err) => {
        if (id !== latest.current.after) return;
        devLog('develop', 'denoise crop preview failed', { error: errorMessage(err) });
        setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
        runBefore();
      },
    );
  };

  /** What the last schedule was for: the next change's kind picks its wait. */
  const seen = useRef<{ source: string; denoiseKey: string; centerKey: string } | null>(null);
  const lastChange = useRef(0);
  const wait = useRef(0);

  useEffect(() => {
    if (!source) {
      seen.current = null;
      return;
    }
    const prev = seen.current;
    seen.current = { source, denoiseKey, centerKey };
    let delay: number;
    if (!prev || prev.source !== source) {
      delay = live.current.hash && switchOnOf(live.current.hash) !== undefined ? 0 : CROP_PREVIEW_SETTLE_MS;
    } else if (prev.denoiseKey !== denoiseKey) delay = CROP_PREVIEW_DEBOUNCE_MS;
    else delay = CROP_PREVIEW_SETTLE_MS;
    pending.current = true;
    lastChange.current = clock();
    wait.current = delay;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (held.current) return;
      run.current();
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [source, denoiseKey, centerKey]);

  // A slider drag only renders after release.
  useEffect(() => {
    if (!source) return;
    const down = (e: PointerEvent) => {
      if (holdsCrop(e.target)) held.current = true;
    };
    const up = () => {
      if (!held.current) return;
      held.current = false;
      if (!pending.current) return;
      if (timer.current) clearTimeout(timer.current);
      // The rest of the wait since the last change (and at least a frame, so React applies that move first).
      const rest = Math.max(32, lastChange.current + wait.current - clock());
      timer.current = setTimeout(() => run.current(), rest);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      held.current = false;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [source]);

  return state;
}
