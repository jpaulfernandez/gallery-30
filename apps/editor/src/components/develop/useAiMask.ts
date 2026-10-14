import {
  type AiMaskTarget,
  DEVELOP_DEFAULTS,
  type DevelopGeometry,
  type DevelopMask,
  type DevelopMaskComponent,
  type DevelopPoint,
  type MaskPrompt,
  newId,
} from '@photobook/shared';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import {
  type AiComponent,
  type ComponentMode,
  isAiOutdated,
  newAi,
  newMask,
  nextMaskName,
  stampAi,
} from '../../lib/develop/masks';
import { deepEqual } from '../../lib/develop/merge';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import {
  type AiMaskResult,
  type AiMaskStage,
  type AiModelInfo,
  aiMaskStatus,
  generateAiMask,
  listModels,
  type ModelInfo,
  onAiMaskProgress,
  releaseAiMasks,
  samRefineMask,
} from '../../lib/tauri';
import { photoFileOf, usePhotoHash } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetDevelop, assetFolder, photoMeta } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { nextPreviewJob } from './usePreview';

/**
 * AI mask components in the Develop view (step D4.3, UI half): the generation flow and its state.
 *
 * A component is only committed into the settings once its raster exists (a render made while it was missing would
 * stay cached without it): picking a target looks a raster up (`aiMaskStatus` with the component stamped from the
 * registry) and adds the component at once when there is one, else runs `generateAiMask` under a busy state and adds
 * the stamped component it returns. Missing models open the first-use download prompt, which retries the job once
 * they are installed. Refine (SAM click and box prompts), Regenerate and the People split replace a component the
 * same way. One job runs at a time; a newer one, Cancel or closing the view abandons the older result (the Rust side
 * finishes and caches its raster anyway).
 */

export type AiJobKind = 'generate' | 'refine' | 'regenerate' | 'people';

export interface AiJob {
  job: number;
  assetId: string;
  kind: AiJobKind;
  target: AiMaskTarget;
  /** The mask written into (null: a new mask). */
  maskId: string | null;
  /** The component replaced (refine, regenerate, people). */
  componentId: string | null;
  /** Latest `develop:ai-progress` stage; null until the first event. */
  stage: AiMaskStage | null;
  /** Refine: the prompts being applied (drawn over the picture until the result arrives). */
  prompts?: MaskPrompt[];
  /** People split: person being generated (1-based) of how many. */
  step?: [number, number];
}

export interface AiDownloadRequest {
  assetId: string;
  target: AiMaskTarget;
  models: AiModelInfo[];
  /** Runs the job again (after the downloads). */
  retry: () => void;
}

export interface AiPeopleOffer {
  assetId: string;
  maskId: string;
  componentId: string;
  boxes: [DevelopPoint, DevelopPoint][];
}

interface AiMaskState {
  job: AiJob | null;
  error: { assetId: string; message: string } | null;
  download: AiDownloadRequest | null;
  people: AiPeopleOffer | null;
  /** The model registry (`listModels`), loaded on first use; refreshed after downloads. */
  models: ModelInfo[] | null;
  /** Bumped whenever a job ends, so component statuses are checked again. */
  generation: number;
}

const INITIAL: AiMaskState = { job: null, error: null, download: null, people: null, models: null, generation: 0 };

export const useAiMaskStore = create<AiMaskState>(() => ({ ...INITIAL }));

/** Back to the initial state (tests). */
export function resetAiMasks(): void {
  stopListening();
  useAiMaskStore.setState({ ...INITIAL });
}

// ---------- source ----------

export interface AiSource {
  folder: string;
  relPath: string;
  hash: string;
  geometry: DevelopGeometry;
}

/** What the commands need for a photo: its folder, its path, content hash and current geometry. */
export function aiSource(assetId: string): AiSource | null {
  const state = useBookStore.getState();
  const folder = assetFolder(state, assetId);
  const asset = photoMeta(state, assetId);
  const file = photoFileOf(assetId);
  const relPath = file?.relPath ?? asset?.path;
  const hash = asset?.hash ?? file?.hash;
  if (!folder || !relPath || !hash) return null;
  return { folder, relPath, hash, geometry: assetDevelop(state, assetId)?.geometry ?? DEVELOP_DEFAULTS.geometry };
}

const masksOf = (assetId: string): DevelopMask[] => assetDevelop(useBookStore.getState(), assetId)?.masks ?? [];

function findAi(assetId: string, maskId: string, componentId: string): AiComponent | null {
  const c = masksOf(assetId)
    .find((m) => m.id === maskId)
    ?.components.find((x) => x.id === componentId);
  return c?.kind === 'ai' ? c : null;
}

/** The model registry, listed once and kept (pass `force` after a download). */
export async function registryModels(force = false): Promise<ModelInfo[]> {
  const have = useAiMaskStore.getState().models;
  if (have && !force) return have;
  const models = await listModels();
  useAiMaskStore.setState({ models });
  return models;
}

// ---------- jobs ----------

let unlistenProgress: UnlistenFn | null = null;
let listening: Promise<void> | null = null;

function stopListening(): void {
  unlistenProgress?.();
  unlistenProgress = null;
  listening = null;
}

/** Listen to `develop:ai-progress` once (before the first call) and keep the current job's stage. */
function listenProgress(): Promise<void> {
  if (!listening) {
    listening = (async () => {
      try {
        const u = await onAiMaskProgress((e) => {
          const job = useAiMaskStore.getState().job;
          if (job && job.job === e.job) useAiMaskStore.setState({ job: { ...job, stage: e.stage } });
        });
        if (listening) unlistenProgress = u;
        else u();
      } catch {
        // No events outside Tauri: the busy row stays at "starting".
      }
    })();
  }
  return listening;
}

const isCurrent = (n: number): boolean => useAiMaskStore.getState().job?.job === n;

async function beginJob(job: Omit<AiJob, 'job' | 'stage'>): Promise<number> {
  const n = nextPreviewJob();
  useAiMaskStore.setState({ job: { ...job, job: n, stage: null }, error: null, people: null });
  await listenProgress();
  return n;
}

function endJob(n: number): void {
  if (isCurrent(n)) useAiMaskStore.setState((s) => ({ job: null, generation: s.generation + 1 }));
}

function setError(assetId: string, message: string): void {
  useAiMaskStore.setState({ error: { assetId, message } });
}

/**
 * One command call of job `n`: its result, or null when the job was abandoned meanwhile, failed (the error is shown)
 * or needs models (the download prompt opens with `retry`).
 */
async function callModel(
  n: number,
  assetId: string,
  target: AiMaskTarget,
  call: (job: number) => Promise<AiMaskResult>,
  retry: () => void,
): Promise<AiMaskResult | null> {
  try {
    const result = await call(n);
    if (!isCurrent(n)) return null;
    if (result.missingModels.length > 0) {
      useAiMaskStore.setState({ download: { assetId, target, models: result.missingModels, retry } });
      return null;
    }
    devLog('develop', 'ai mask generated', {
      assetId,
      target,
      componentHash: result.componentHash,
      coverage: Math.round(result.coverage * 1000) / 1000,
      people: result.people.length,
      elapsedMs: result.elapsedMs,
    });
    return result;
  } catch (err) {
    if (isCurrent(n)) setError(assetId, errorMessage(err));
    return null;
  }
}

/** Abandon the running job (its result is dropped when it arrives). */
export function cancelAiJob(): void {
  const job = useAiMaskStore.getState().job;
  if (job) devLog('develop', 'ai mask cancelled', { job: job.job, kind: job.kind });
  useAiMaskStore.setState((s) => ({ job: null, generation: s.generation + (job ? 1 : 0) }));
}

/** Select a component when its photo is the one shown. */
function selectIfShown(assetId: string, maskId: string, componentId: string): void {
  const ui = useUiStore.getState();
  if (ui.develop?.ids[ui.develop.index] !== assetId) return;
  ui.setDevelopMaskTool({ maskId, componentId, tool: null });
}

/** Where a new AI component goes: a new mask (no `maskId`), or into mask `maskId` with `mode`. */
export interface AiPlacement {
  maskId?: string;
  mode?: ComponentMode;
}

/** Add a generated component: into the placement's mask when it still exists, else as a new mask. */
function place(assetId: string, c: DevelopMaskComponent, placement: AiPlacement): string {
  const store = useBookStore.getState();
  const masks = masksOf(assetId);
  let maskId: string;
  if (placement.maskId && masks.some((m) => m.id === placement.maskId)) {
    maskId = placement.maskId;
    store.addMaskComponent(assetId, maskId, { ...c, mode: placement.mode ?? c.mode });
  } else {
    const m = newMask(nextMaskName(masks), { ...c, mode: 'add' });
    store.addMask(assetId, m);
    maskId = m.id;
  }
  selectIfShown(assetId, maskId, c.id);
  return maskId;
}

/**
 * Create menu / Add-Subtract-Intersect pick of an AI target: add the component at once when its raster is cached
 * for this photo, else generate it first (busy state, download prompt when a model is missing).
 */
export async function createAiMask(assetId: string, target: AiMaskTarget, placement: AiPlacement = {}): Promise<void> {
  const src = aiSource(assetId);
  if (!src) {
    setError(assetId, 'The photo is not ready yet (still scanning).');
    return;
  }
  const c = newAi(target, placement.maskId ? placement.mode : undefined);
  try {
    const stamped = stampAi(c, await registryModels());
    if (stamped) {
      const [exists] = await aiMaskStatus(src.hash, [stamped]);
      if (exists) {
        place(assetId, stamped, placement);
        devLog('develop', 'ai mask from cache', { assetId, target });
        return;
      }
    }
  } catch (err) {
    devLog('develop', 'ai mask status unavailable', { error: errorMessage(err) });
  }
  const retry = () => void createAiMask(assetId, target, placement);
  const n = await beginJob({ assetId, kind: 'generate', target, maskId: placement.maskId ?? null, componentId: null });
  const result = await callModel(
    n,
    assetId,
    target,
    (job) => generateAiMask(src.folder, src.relPath, src.hash, src.geometry, c, job),
    retry,
  );
  endJob(n);
  if (!result) return;
  const maskId = place(assetId, result.component, placement);
  if (target === 'people' && result.people.length > 1) {
    useAiMaskStore.setState({ people: { assetId, maskId, componentId: result.component.id, boxes: result.people } });
  }
}

/** The prompts Refine builds on: those of a refine in flight for the component, else the stored ones. */
export function refinePrompts(assetId: string, maskId: string, componentId: string): MaskPrompt[] {
  const job = useAiMaskStore.getState().job;
  if (job?.kind === 'refine' && job.assetId === assetId && job.componentId === componentId && job.prompts) {
    return job.prompts;
  }
  return findAi(assetId, maskId, componentId)?.prompts ?? [];
}

/**
 * Click-to-refine: run the component with `prompts` through SAM (`samRefineMask`; with no prompt left, back to the
 * plain model through `generateAiMask`) and replace it with the stamped result.
 */
export async function refineAiComponent(
  assetId: string,
  maskId: string,
  componentId: string,
  prompts: MaskPrompt[],
): Promise<void> {
  const src = aiSource(assetId);
  const c = findAi(assetId, maskId, componentId);
  if (!src || !c) return;
  const next: AiComponent = { ...c, prompts };
  const retry = () => void refineAiComponent(assetId, maskId, componentId, prompts);
  const n = await beginJob({ assetId, kind: 'refine', target: c.target, maskId, componentId, prompts });
  const call = prompts.length > 0 ? samRefineMask : generateAiMask;
  const result = await callModel(
    n,
    assetId,
    c.target,
    (job) => call(src.folder, src.relPath, src.hash, src.geometry, next, job),
    retry,
  );
  endJob(n);
  if (!result || !findAi(assetId, maskId, componentId)) return;
  useBookStore.getState().replaceMaskComponent(assetId, maskId, componentId, [result.component]);
}

/** Add a prompt to the selected component (Refine tool). */
export function addRefinePrompt(assetId: string, maskId: string, componentId: string, prompt: MaskPrompt): void {
  void refineAiComponent(assetId, maskId, componentId, [...refinePrompts(assetId, maskId, componentId), prompt]);
}

/**
 * Remove the last prompt (Delete with the Refine tool). A per-person component keeps its box. False when there is
 * nothing to remove.
 */
export function removeLastPrompt(assetId: string, maskId: string, componentId: string): boolean {
  const c = findAi(assetId, maskId, componentId);
  const prompts = refinePrompts(assetId, maskId, componentId);
  const keep = c?.target === 'people' && prompts[0]?.kind === 'box' ? 1 : 0;
  if (!c || prompts.length <= keep) return false;
  void refineAiComponent(assetId, maskId, componentId, prompts.slice(0, -1));
  return true;
}

/**
 * Regenerate a component whose raster is missing on this computer or whose model has a newer version: run it again
 * with its stored prompts and replace it. When the result is the same component (only the raster was missing) it
 * gets a new id, so the settings change and the preview and the cached renders made without the raster are redone.
 */
export async function regenerateAiComponent(assetId: string, maskId: string, componentId: string): Promise<void> {
  const src = aiSource(assetId);
  const c = findAi(assetId, maskId, componentId);
  if (!src || !c) return;
  const retry = () => void regenerateAiComponent(assetId, maskId, componentId);
  const n = await beginJob({ assetId, kind: 'regenerate', target: c.target, maskId, componentId });
  const result = await callModel(
    n,
    assetId,
    c.target,
    (job) => generateAiMask(src.folder, src.relPath, src.hash, src.geometry, c, job),
    retry,
  );
  endJob(n);
  const now = findAi(assetId, maskId, componentId);
  if (!result || !now) return;
  const same = deepEqual(result.component, now);
  const next = same ? { ...result.component, id: newId() } : result.component;
  // Replacing the component deselects it (the UI store drops a selection that disappears): select the new one.
  const tool = useUiStore.getState().developMaskTool;
  const selected = tool?.maskId === maskId && tool.componentId === componentId;
  useBookStore.getState().replaceMaskComponent(assetId, maskId, componentId, [next]);
  if (selected && next.id !== componentId) selectIfShown(assetId, maskId, next.id);
}

/**
 * "One per person": replace an All-people component with one People component per box (a positive box prompt each,
 * generated through `samRefineMask`), in one undo step.
 */
export async function splitPeople(offer: AiPeopleOffer): Promise<void> {
  const { assetId, maskId, componentId, boxes } = offer;
  const src = aiSource(assetId);
  const c = findAi(assetId, maskId, componentId);
  useAiMaskStore.setState({ people: null });
  if (!src || !c || boxes.length === 0) return;
  const retry = () => void splitPeople(offer);
  const n = await beginJob({ assetId, kind: 'people', target: 'people', maskId, componentId, step: [1, boxes.length] });
  const parts: DevelopMaskComponent[] = [];
  for (const [i, box] of boxes.entries()) {
    const job = useAiMaskStore.getState().job;
    if (!isCurrent(n) || !job) return;
    useAiMaskStore.setState({ job: { ...job, step: [i + 1, boxes.length] } });
    const person: AiComponent = {
      ...newAi('people', c.mode, [{ kind: 'box', box, positive: true }]),
      invert: c.invert,
    };
    const result = await callModel(
      n,
      assetId,
      'people',
      (j) => samRefineMask(src.folder, src.relPath, src.hash, src.geometry, person, j),
      retry,
    );
    if (!result) {
      endJob(n);
      return;
    }
    parts.push(result.component);
  }
  endJob(n);
  if (!findAi(assetId, maskId, componentId) || parts.length === 0) return;
  useBookStore.getState().replaceMaskComponent(assetId, maskId, componentId, parts);
  const first = parts[0];
  if (first) selectIfShown(assetId, maskId, first.id);
}

/** Closing the Develop view: abandon the job, drop the prompts and free the models and the SAM encoding. */
export function releaseAiMasksOnClose(): void {
  cancelAiJob();
  stopListening();
  useAiMaskStore.setState({ error: null, download: null, people: null });
  try {
    releaseAiMasks().catch((err: unknown) =>
      devLog('develop', 'releasing the AI mask models failed', { error: errorMessage(err) }),
    );
  } catch {
    // Not available (tests without the command).
  }
}

// ---------- component status ----------

export interface AiComponentStatus {
  /** No raster for this photo on this computer (another machine made it, or the cache was cleared). */
  missing: boolean;
  /** The registry would now use another model or version. */
  outdated: boolean;
}

/**
 * Status of the AI components of `mask` (by component id): whether their raster is cached for the photo
 * (`aiMaskStatus`) and whether the registry has moved on (`listModels`). Checked again when the components change
 * and after every job; unknown components are absent.
 */
export function useAiComponentStatus(
  assetId: string,
  mask: DevelopMask | undefined,
): Record<string, AiComponentStatus> {
  const generation = useAiMaskStore((s) => s.generation);
  const models = useAiMaskStore((s) => s.models);
  const hash = usePhotoHash(assetId);
  const ai = useMemo(() => mask?.components.filter((c): c is AiComponent => c.kind === 'ai') ?? [], [mask]);
  const key = JSON.stringify(ai);
  const [exists, setExists] = useState<Record<string, boolean>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `ai`; `generation` re-checks after a job
  useEffect(() => {
    if (!hash || ai.length === 0) return;
    let alive = true;
    registryModels().catch(() => null);
    (async () => {
      try {
        const values = await aiMaskStatus(hash, ai);
        if (!alive) return;
        setExists((prev) => {
          const next = { ...prev };
          ai.forEach((c, i) => {
            next[`${hash}\n${JSON.stringify(c)}`] = values[i] === true;
          });
          return next;
        });
      } catch {
        // Unknown: no Regenerate offered.
      }
    })();
    return () => {
      alive = false;
    };
  }, [hash, key, generation]);

  const out: Record<string, AiComponentStatus> = {};
  for (const c of ai) {
    const known = hash ? exists[`${hash}\n${JSON.stringify(c)}`] : undefined;
    out[c.id] = { missing: known === false, outdated: models ? isAiOutdated(c, models) : false };
  }
  return out;
}
