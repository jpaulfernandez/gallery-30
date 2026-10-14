import {
  AI_DESCRIPTION_MAX,
  AI_PRICING,
  type AiAttempt,
  type AiModel,
  type AiUsage,
  addUsage,
  attemptsCost,
  DEFAULT_AI_INDEX_MODEL,
  EMPTY_AI_USAGE,
  isAiModel,
  type LibraryPhotoAi,
  LibraryPhotoAiSchema,
} from '@photobook/shared';
import { describePhotos, nextAiJob, useAiStore } from '../../store/ai';
import { flush as flushSaves } from '../../store/autosave';
import { useBookStore, withoutHistory } from '../../store/book';
import { enqueue, JobCancelled, type JobHandle, type JobOutcome } from '../../store/jobs';
import { isLibraryWritable, isPhotoKey, photoEntryPlace, photoMeta } from '../../store/library';
import { type CostEstimate, estimate } from '../ai/cost';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { basename } from '../path';
import { type AiDescribeEntry, type AiImageRef, aiCancel } from '../tauri';

/**
 * Workflow plan 33: the photo index. Each photo gets a two-line description (plus people, setting, time of day and a
 * mood word) from `ai_describe`, written to `photos[hash].ai` in its folder's library, so it is shared by every
 * project on the folder and computed once. Caption requests (plans 34 and 35) then send `indexText(book, library)`
 * instead of the photos.
 *
 * `planIndex(ids)` sorts photo ids (project asset ids or library keys) into what to send (one request per
 * `INDEX_BATCH` photos, deduplicated by content hash), what is described already and what cannot be written;
 * `estimateIndex(plan)` prices it; `runIndex(plan)` runs it as one `ai` job whose progress counts photos, a batch at a
 * time (cancel stops the request in flight through `ai_cancel`; batches already answered stay written). The Describe
 * photos action (`components/ai/DescribePhotos.tsx`) and the Book captions dialog (plan 35) call these.
 */

/** Photos per request (`ai_describe` takes up to 20). */
export const INDEX_BATCH = 8;
/** Above this many photos to send, the action shows the cost first. */
export const INDEX_CONFIRM_ABOVE = 20;
/** Uncached text of one request: the describe system prompt, the output schema, `Photo N` labels and the ask. */
export const INDEX_TEXT_TOKENS_PER_REQUEST = 400;
/** Output of one request of 8 photos: the JSON (about 80 tokens a photo) plus `low`-effort thinking. */
export const INDEX_OUTPUT_TOKENS_PER_REQUEST = 1500;
/** Size assumed for a photo whose size is not known yet (a 3:2 proxy). */
const DEFAULT_SIZE = { width: 1600, height: 1067 };
/** The `ref` of index jobs (find them with `activeIndexJob`). */
export const INDEX_JOB_REF = 'photo-index';

/** One photo to describe: its bytes (by hash) and every library entry that receives the answer. */
export interface IndexPhoto {
  /** The first photo id given for these bytes. */
  id: string;
  /** File name, for the log. */
  label: string;
  hash: string;
  /** Library folders (absolute paths) whose entry for `hash` is written. */
  folders: string[];
  width: number;
  height: number;
}

/** A description another folder's library already has for the same bytes: copied, not requested. */
export interface IndexCopy {
  folder: string;
  hash: string;
  ai: LibraryPhotoAi;
}

export interface IndexPlan {
  model: AiModel;
  refresh: boolean;
  /** Photos to send, deduplicated by hash, in the order given. */
  todo: IndexPhoto[];
  /** Entries filled from another folder's description of the same bytes (no request). */
  copies: IndexCopy[];
  /** Photo ids already described (skipped). */
  described: number;
  /** Of `described`, how many Refresh would describe again (written by a cheaper model than `model`). */
  refreshable: number;
  /** Photo ids that cannot be indexed: unknown, not hashed yet, or their folder's library cannot be written. */
  unavailable: number;
  /** Photo ids given. */
  total: number;
  /** The open project, when a photo is one of its assets (closing it cancels the job). */
  project: string | null;
}

export interface IndexResult {
  /** Photos (by hash) that got a description. */
  described: number;
  /** Library entries written (a hash in two folders counts twice), copies included. */
  written: number;
  /** Photos with no cached preview yet (not sent). */
  missing: number;
  /** Photos in batches the model declined. */
  refused: number;
  /** Photos the answer left out, or described in a shape the library cannot hold (see the job log). */
  failed: number;
  /** Photos another run described while this one waited (not sent; a copy is written where needed). */
  skipped: number;
  /** Requests made. */
  requests: number;
  usage: AiUsage;
  attempts: AiAttempt[];
  /** Estimated dollars of the priced attempts. */
  usd: number;
}

/** The index model of Settings → AI (read once when not loaded yet), else Haiku. */
export async function indexModel(): Promise<AiModel> {
  const store = useAiStore.getState();
  if (!store.settings) await store.load();
  return useAiStore.getState().settings?.indexModel ?? DEFAULT_AI_INDEX_MODEL;
}

/** Reads the libraries of `folders` that are not loaded yet, so entries are checked and written in the right file. */
async function loadLibraries(folders: Iterable<string>): Promise<void> {
  for (const folder of new Set(folders)) {
    if (Object.hasOwn(useBookStore.getState().libraries, folder)) continue;
    try {
      await useBookStore.getState().loadLibrary(folder);
    } catch (err) {
      devLog('ai', 'library not read', { folder, error: errorMessage(err) });
    }
  }
}

/**
 * True when `ai` counts as indexed for a run on `model`. Without Refresh any entry does. With Refresh, an entry asked
 * of `model` does, and so does one asked of a pricier offered model (Refresh never downgrades); the rest are redone.
 * The requested model is compared, not `servedBy`, so a fallback answer is not redone on every Refresh.
 */
export function upToDate(ai: LibraryPhotoAi | undefined, model: AiModel, refresh: boolean): ai is LibraryPhotoAi {
  if (ai === undefined) return false;
  if (!refresh || ai.model === model) return true;
  return isAiModel(ai.model) && AI_PRICING[ai.model].input > AI_PRICING[model].input;
}

/**
 * What indexing `ids` would do. Each id resolves to its library entry (its folder's library, by hash); an id whose
 * entry is up to date is skipped (`described`), and photos with the same bytes are sent once. With `refresh`, entries
 * written by another model than `model` are described again.
 */
export async function planIndex(
  ids: readonly string[],
  options: { refresh?: boolean; model?: AiModel } = {},
): Promise<IndexPlan> {
  const refresh = options.refresh ?? false;
  const model = options.model ?? (await indexModel());
  const metas = ids.map((id) => ({ id, meta: photoMeta(useBookStore.getState(), id) }));
  await loadLibraries(metas.flatMap(({ meta }) => (meta?.folder && meta.hash ? [meta.folder] : [])));
  const view = useBookStore.getState();
  const byHash = new Map<string, { photo: IndexPhoto; places: Set<string>; known?: LibraryPhotoAi }>();
  const stale = new Set<string>();
  let described = 0;
  let refreshable = 0;
  let unavailable = 0;
  let project: string | null = null;
  for (const { id, meta } of metas) {
    const place = photoEntryPlace(view, id);
    if (!meta?.hash || !place || !isLibraryWritable(place.folder)) {
      unavailable += 1;
      continue;
    }
    const ai = view.libraries[place.folder]?.photos[place.hash]?.ai;
    let group = byHash.get(place.hash);
    if (!group) {
      group = {
        photo: {
          id,
          label: basename(meta.path),
          hash: place.hash,
          folders: [],
          width: meta.width ?? DEFAULT_SIZE.width,
          height: meta.height ?? DEFAULT_SIZE.height,
        },
        places: new Set(),
      };
      byHash.set(place.hash, group);
    }
    if (upToDate(ai, model, refresh)) {
      described += 1;
      if (!upToDate(ai, model, true)) refreshable += 1;
      group.known ??= ai;
      continue;
    }
    if (!isPhotoKey(id) && view.book?.assets[id]) project ??= view.projectId;
    group.places.add(place.folder);
    stale.add(place.hash);
  }
  const todo: IndexPhoto[] = [];
  const copies: IndexCopy[] = [];
  for (const [hash, group] of byHash) {
    if (!stale.has(hash)) continue;
    const folders = [...group.places];
    if (group.known) {
      for (const folder of folders) copies.push({ folder, hash, ai: group.known });
    } else {
      todo.push({ ...group.photo, folders });
    }
  }
  return { model, refresh, todo, copies, described, refreshable, unavailable, total: ids.length, project };
}

/** Requests a plan makes. */
export const indexRequests = (plan: Pick<IndexPlan, 'todo'>): number => Math.ceil(plan.todo.length / INDEX_BATCH);

/** What running `plan` costs, before it runs (images at 768 px, the text and output per request). */
export function estimateIndex(plan: Pick<IndexPlan, 'todo' | 'model'>): CostEstimate {
  const requests = indexRequests(plan);
  return estimate(plan.todo, INDEX_TEXT_TOKENS_PER_REQUEST * requests, plan.model, {
    requests: Math.max(1, requests),
    outputTokens: INDEX_OUTPUT_TOKENS_PER_REQUEST * requests,
  });
}

/**
 * An answer as a library entry (`model` the requested model, `servedBy` the one that answered, kept only when they
 * differ; a long description is cut), or null when it does not fit the schema.
 */
export function toLibraryAi(
  entry: AiDescribeEntry,
  model: string,
  servedBy: string,
  at: string,
): LibraryPhotoAi | null {
  const parsed = LibraryPhotoAiSchema.safeParse({
    model,
    ...(servedBy && servedBy !== model ? { servedBy } : {}),
    at,
    description: entry.description.trim().slice(0, AI_DESCRIPTION_MAX),
    people: Math.max(0, Math.round(entry.people)),
    setting: entry.setting.trim(),
    timeOfDay: entry.timeOfDay,
    mood: entry.mood.trim(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Write `ai` on `folder`'s entry for `hash` through the library store (so the in-memory libraries and `library.json`
 * stay in step; autosave writes the file). Not an undo step: a description is not an edit. A library that was closed
 * meanwhile is read again first; one that cannot be written is left alone. Returns whether it was written.
 */
async function writeAi(folder: string, hash: string, ai: LibraryPhotoAi): Promise<boolean> {
  if (!Object.hasOwn(useBookStore.getState().libraries, folder)) {
    // The library was closed (or never loaded): let pending writes land first, so the read below is what is on disk.
    await flushSaves();
    await loadLibraries([folder]);
  }
  if (!Object.hasOwn(useBookStore.getState().libraries, folder) || !isLibraryWritable(folder)) {
    devLog('ai', 'index entry not written', { folder, reason: 'library not writable' });
    return false;
  }
  withoutHistory(() =>
    useBookStore.getState().patchPhoto(folder, hash, (photo) => {
      photo.ai = ai;
    }),
  );
  return true;
}

/**
 * The folders of `photo` whose entry is still not up to date for `plan`, and an up-to-date entry another of its
 * folders has now (another run wrote it while this one waited), which is copied instead of sending the photo.
 */
function pendingFolders(photo: IndexPhoto, plan: IndexPlan): { folders: string[]; known?: LibraryPhotoAi } {
  const libraries = useBookStore.getState().libraries;
  const folders: string[] = [];
  let known: LibraryPhotoAi | undefined;
  for (const folder of photo.folders) {
    const ai = libraries[folder]?.photos[photo.hash]?.ai;
    if (upToDate(ai, plan.model, plan.refresh)) known ??= ai;
    else folders.push(folder);
  }
  return known ? { folders, known } : { folders };
}

/** FNV-1a of `text`, hex: a short `dedupe` key for a run. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Equal runs (same model, Refresh, photos and folders) join one job instead of billing the photos twice. */
export function indexDedupeKey(plan: IndexPlan): string {
  const parts = [
    ...plan.todo.map((p) => `${p.hash}@${[...p.folders].sort().join('|')}`),
    ...plan.copies.map((c) => `copy:${c.hash}@${c.folder}`),
  ].sort();
  return `index:${plan.model}:${plan.refresh ? 'refresh' : 'new'}:${parts.length}:${fnv(parts.join('\n'))}`;
}

/** Message `ai_describe` rejects with when no photo of a request has a cached preview. */
const NO_PREVIEW = /has a preview yet/i;

/**
 * Queue `plan` as one `ai` job (see the module doc). Copies are written first, without a request. An equal run already
 * queued or running is joined (`created: false`); a different one waits in the `ai` lane, and its photos are checked
 * against the libraries again as its batches are formed, so photos the earlier run described are not sent twice.
 */
export function runIndex(plan: IndexPlan): JobHandle<IndexResult> {
  const count = plan.todo.length + plan.copies.length;
  return enqueue<IndexResult>({
    kind: 'ai',
    label: `Describe ${count} photo${count === 1 ? '' : 's'}`,
    ref: INDEX_JOB_REF,
    project: plan.project,
    dedupe: indexDedupeKey(plan),
    run: async (ctx) => {
      const result: IndexResult = {
        described: 0,
        written: 0,
        missing: 0,
        refused: 0,
        failed: 0,
        skipped: 0,
        requests: 0,
        usage: { ...EMPTY_AI_USAGE },
        attempts: [],
        usd: 0,
      };
      for (const copy of plan.copies) {
        if (await writeAi(copy.folder, copy.hash, copy.ai)) result.written += 1;
      }
      // Batches are formed as the run goes: a photo another run described meanwhile (or a copy can serve) is not sent.
      const total = plan.todo.length;
      const requests = indexRequests(plan);
      let next = 0;
      while (next < total) {
        if (ctx.cancelled) throw new JobCancelled();
        const batch: IndexPhoto[] = [];
        while (batch.length < INDEX_BATCH && next < total) {
          const photo = plan.todo[next++] as IndexPhoto;
          const { folders, known } = pendingFolders(photo, plan);
          if (folders.length === 0 || known) {
            result.skipped += 1;
            for (const folder of known ? folders : []) {
              if (await writeAi(folder, photo.hash, known as LibraryPhotoAi)) result.written += 1;
            }
            continue;
          }
          batch.push({ ...photo, folders });
        }
        if (batch.length === 0) continue;
        const n = result.requests + 1;
        ctx.progress(next - batch.length, total, `request ${n}/${Math.max(n, requests)}`);
        const job = nextAiJob();
        ctx.onCancel(() => aiCancel(job));
        // The hash is the ref id: unique in a plan, echoed back and never sent.
        const refs: AiImageRef[] = batch.map((p) => ({ id: p.hash, kind: 'photo', hash: p.hash }));
        devLog('ai', 'index request', { request: n, photos: batch.length, model: plan.model });
        let outcome: Awaited<ReturnType<typeof describePhotos>>;
        try {
          outcome = await describePhotos(refs, { model: plan.model, effort: 'low' }, job);
        } catch (err) {
          if (ctx.cancelled) throw new JobCancelled();
          const message = errorMessage(err);
          if (!NO_PREVIEW.test(message)) throw err;
          // None of these photos has a preview yet: nothing was sent. The rest of the run goes on.
          result.missing += batch.length;
          ctx.log(`No previews yet: ${batch.map((p) => p.label).join(', ')}`);
          continue;
        }
        if (outcome.status === 'cancelled') throw new JobCancelled();
        result.requests += 1;
        result.usage = addUsage(result.usage, outcome.usage);
        result.attempts.push(...outcome.attempts);
        if (outcome.status === 'refused') {
          result.refused += batch.length;
          ctx.log(`${batch.map((p) => p.label).join(', ')}: ${outcome.message}`);
          devLog('ai', 'index batch refused', { request: n, reason: outcome.reason });
          continue;
        }
        const at = new Date().toISOString();
        const byHash = new Map(batch.map((p) => [p.hash, p]));
        const answered = new Set<string>();
        for (const entry of outcome.entries) {
          const photo = byHash.get(entry.id);
          const ai = photo && !answered.has(entry.id) ? toLibraryAi(entry, plan.model, outcome.servedBy, at) : null;
          if (!photo || !ai) {
            ctx.log(
              photo
                ? `${photo.label}: the description did not fit the library`
                : 'An answer for no photo of the request',
            );
            devLog('ai', 'index entry dropped', { request: n, known: Boolean(photo) });
            continue;
          }
          answered.add(entry.id);
          result.described += 1;
          for (const folder of photo.folders) if (await writeAi(folder, photo.hash, ai)) result.written += 1;
        }
        const missing = new Set(outcome.missing);
        result.missing += missing.size;
        if (missing.size > 0) ctx.log(`${missing.size} without a preview yet`);
        const left = batch.filter((p) => !answered.has(p.hash) && !missing.has(p.hash));
        result.failed += left.length;
        if (left.length > 0) ctx.log(`Not described: ${left.map((p) => p.label).join(', ')}`);
      }
      ctx.progress(plan.todo.length, plan.todo.length);
      result.usd = attemptsCost(result.attempts).usd;
      devLog('ai', 'index done', {
        described: result.described,
        written: result.written,
        missing: result.missing,
        refused: result.refused,
        failed: result.failed,
        skipped: result.skipped,
        requests: result.requests,
        usd: Number(result.usd.toFixed(4)),
      });
      return result;
    },
  });
}

/** An empty run's result (nothing to send). */
const EMPTY_RESULT: IndexResult = {
  described: 0,
  written: 0,
  missing: 0,
  refused: 0,
  failed: 0,
  skipped: 0,
  requests: 0,
  usage: EMPTY_AI_USAGE,
  attempts: [],
  usd: 0,
};

/**
 * Plan and run the index of `ids` without asking (the Book captions dialog, plan 35, shows its own estimate first):
 * resolves with the plan and the job's outcome; a plan with nothing to send or copy makes no request and queues no job.
 */
export async function indexPhotos(
  ids: readonly string[],
  options: { refresh?: boolean; model?: AiModel } = {},
): Promise<{ plan: IndexPlan; outcome: JobOutcome<IndexResult> }> {
  const plan = await planIndex(ids, options);
  if (plan.todo.length === 0 && plan.copies.length === 0) {
    devLog('ai', 'index up to date', { photos: plan.total, described: plan.described });
    return { plan, outcome: { state: 'done', value: { ...EMPTY_RESULT, usage: { ...EMPTY_AI_USAGE } } } };
  }
  return { plan, outcome: await runIndex(plan).result };
}
