import { create } from 'zustand';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';

/**
 * Plan 09: the job queue. One place for long work (full renders, AI denoise, publish; exports and captions later) with
 * progress, cancel and the status-bar list (`components/shell/JobsBar.tsx`). Not part of any project file and never
 * undone. The queue drains in the background whatever the screen: jobs belong to this module, not to a component.
 *
 * A job is started through `enqueue(spec)`, whose `run(ctx)` does the work and reports through `ctx` (progress, log
 * lines, the cancel handler); the adapters in `lib/jobs/` wrap the Tauri commands. Jobs wait in their lane
 * (`JOB_KINDS`, `LANES`) and start in the order they were queued, as many at a time as the lane allows. A job may wait
 * on jobs of another lane (publish waits on its renders), never on one of its own lane: that would never start.
 *
 * Adding a kind (an export, a caption run): add it to `JobKind` and `JOB_KINDS` (its lane and the noun the bar uses),
 * and a lane to `LANES` if it needs its own concurrency; then write an adapter that calls `enqueue`.
 */

export type JobKind = 'render' | 'denoise' | 'publish' | 'export' | 'ai' | 'trash';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** How many jobs of a lane run at once. Renders and denoise share the GPU (and every core), so they take turns. */
export const LANES = { gpu: 1, publish: 1, export: 2, ai: 1, files: 1 } as const;
export type Lane = keyof typeof LANES;

export const JOB_KINDS: Record<JobKind, { lane: Lane; noun: string }> = {
  render: { lane: 'gpu', noun: 'render' },
  denoise: { lane: 'gpu', noun: 'denoise' },
  publish: { lane: 'publish', noun: 'publish' },
  export: { lane: 'export', noun: 'export' },
  // Plans 33–35: AI requests (the photo index, captions), one at a time (rate limits, and the cost shown first).
  ai: { lane: 'ai', noun: 'AI' },
  // Plan 42: a big reject pile moved to the Trash, in chunks so a cancel stops between files.
  trash: { lane: 'files', noun: 'move to Trash' },
};

export interface Job {
  id: string;
  kind: JobKind;
  /** What the list shows, e.g. `DSCF1001.jpg` or `Publish Lisbon`. */
  label: string;
  /** What the job is about: a photo id (project asset id or library key) for renders and denoise, a project id for publish. */
  ref?: string;
  /** The project it was started for: closing that project cancels it. */
  project?: string;
  done: number;
  total: number;
  /** The current step, e.g. `tile 40/117`. */
  detail?: string;
  state: JobState;
  error?: string;
  queuedAt: number;
  /** When it started running; null while queued. */
  startedAt: number | null;
  endedAt?: number;
  /** Cancel was asked while it ran; it ends at its next checkpoint. */
  cancelling?: boolean;
  /** Stops the running job (its `ctx.onCancel` handler); absent while queued and once over. */
  cancel?: () => void;
  /** Line log (a publish attaches its CLI warnings and errors), last `LOG_LINES` lines. */
  log?: readonly string[];
}

/** What a job's `run` gets to report through. */
export interface JobContext {
  readonly id: string;
  progress: (done: number, total: number, detail?: string) => void;
  log: (line: string) => void;
  /** What stops the work when the job is cancelled while running (replaces any earlier handler). */
  onCancel: (handler: () => unknown) => void;
  /** Cancel was asked. */
  readonly cancelled: boolean;
}

export interface JobSpec<T> {
  kind: JobKind;
  label: string;
  ref?: string;
  project?: string | null;
  /**
   * Work that is already queued or running under the same kind and key is not queued twice: `enqueue` hands back the
   * existing job (`created: false`). E.g. a denoise of the same bytes and settings, a render of the same file.
   */
  dedupe?: string;
  run: (ctx: JobContext) => Promise<T>;
}

export type JobOutcome<T> =
  | { state: 'done'; value: T }
  | { state: 'failed'; error: string; cause: unknown }
  | { state: 'cancelled' };

export interface JobHandle<T> {
  id: string;
  /** False when an equal job (`dedupe`) was already queued or running and this is it. */
  created: boolean;
  /** Settles once the job is over; never rejects. */
  result: Promise<JobOutcome<T>>;
}

/** Thrown by a job's `run` to end as cancelled (e.g. the command reported that it stopped). */
export class JobCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelled';
  }
}

/** Finished jobs (done or cancelled) kept for the list; failed ones stay until dismissed. */
const KEEP_FINISHED = 20;
const LOG_LINES = 200;

export interface JobsState {
  jobs: Readonly<Record<string, Job>>;
  /** A message for the bar (e.g. closing a project cancelled its jobs), until dismissed. */
  notice: string | null;
  /** Mark `id` running (the runner calls it). */
  start: (id: string) => void;
  progress: (id: string, done: number, total: number, detail?: string) => void;
  finish: (id: string) => void;
  fail: (id: string, error: string) => void;
  /**
   * Cancel `id`: a queued job is over at once and never starts; a running one is asked to stop (its handler runs) and
   * ends as cancelled when its `run` rejects (or throws `JobCancelled`). A run that completes anyway (the cancel came
   * too late) ends done with its value: its work is on disk and its waiters must see it.
   */
  cancel: (id: string) => void;
  /** Drop the finished jobs that are not failures. */
  clearDone: () => void;
  /** Drop one finished job (a failure stays until this). */
  dismiss: (id: string) => void;
  dismissNotice: () => void;
}

const ACTIVE: ReadonlySet<JobState> = new Set(['queued', 'running']);

export const isActive = (job: Job): boolean => ACTIVE.has(job.state);

interface Entry {
  spec: JobSpec<unknown>;
  settle: (outcome: JobOutcome<unknown>) => void;
  result: Promise<JobOutcome<unknown>>;
  cancelled: boolean;
  onCancel?: () => unknown;
  /** The projects of whoever queued or joined it (`''` for none): closing one of them cancels it only if it is the last. */
  owners: Set<string>;
}

/** Specs and settle functions of the jobs that are not over yet (functions stay out of the state). */
const entries = new Map<string, Entry>();
let seq = 0;

function patch(id: string, change: (job: Job) => Partial<Job>): void {
  useJobsStore.setState((s) => {
    const job = s.jobs[id];
    return job ? { jobs: { ...s.jobs, [id]: { ...job, ...change(job) } } } : {};
  });
}

/** The jobs with finished ones beyond `KEEP_FINISHED` (oldest first) dropped; failures are kept. */
function trimmed(jobs: Readonly<Record<string, Job>>): Record<string, Job> {
  const finished = Object.values(jobs)
    .filter((j) => j.state === 'done' || j.state === 'cancelled')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map((j) => j.id));
  return Object.fromEntries(Object.entries(jobs).filter(([id]) => !drop.has(id)));
}

/** End `id` in `state` and settle its promise (once). */
function end(id: string, outcome: JobOutcome<unknown>): void {
  const entry = entries.get(id);
  entries.delete(id);
  useJobsStore.setState((s) => {
    const job = s.jobs[id];
    if (!job) return {};
    const over: Job = {
      ...job,
      state: outcome.state,
      error: outcome.state === 'failed' ? outcome.error : undefined,
      cancelling: undefined,
      cancel: undefined,
      endedAt: Date.now(),
    };
    return { jobs: trimmed({ ...s.jobs, [id]: over }) };
  });
  entry?.settle(outcome);
  // The next job starts once whoever waits on this one has run (a publish cancels the rest of its jobs on a failure).
  setTimeout(pump, 0);
}

export const useJobsStore = create<JobsState>()((set, get) => ({
  jobs: {},
  notice: null,

  start: (id) => patch(id, () => ({ state: 'running', startedAt: Date.now() })),

  progress: (id, done, total, detail) =>
    patch(id, (job) => (job.state === 'running' ? { done, total, ...(detail !== undefined ? { detail } : {}) } : {})),

  finish: (id) => end(id, { state: 'done', value: undefined }),

  fail: (id, error) => end(id, { state: 'failed', error, cause: new Error(error) }),

  cancel: (id) => {
    const job = get().jobs[id];
    const entry = entries.get(id);
    if (!job || !entry || !isActive(job) || entry.cancelled) return;
    entry.cancelled = true;
    if (job.state === 'queued') {
      devLog('jobs', 'cancelled while queued', { id, kind: job.kind, label: job.label });
      end(id, { state: 'cancelled' });
      return;
    }
    devLog('jobs', 'cancelling', { id, kind: job.kind, label: job.label });
    patch(id, () => ({ cancelling: true }));
    try {
      void Promise.resolve(entry.onCancel?.()).catch((err) =>
        devLog('jobs', 'cancel handler failed', { id, error: errorMessage(err) }),
      );
    } catch (err) {
      devLog('jobs', 'cancel handler failed', { id, error: errorMessage(err) });
    }
  },

  clearDone: () =>
    set((s) => ({
      jobs: Object.fromEntries(Object.entries(s.jobs).filter(([, j]) => j.state !== 'done' && j.state !== 'cancelled')),
    })),

  dismiss: (id) =>
    set((s) => {
      const job = s.jobs[id];
      if (!job || isActive(job)) return {};
      const { [id]: _gone, ...rest } = s.jobs;
      return { jobs: rest };
    }),

  dismissNotice: () => set({ notice: null }),
}));

/** Start queued jobs, oldest first, while their lane has room. */
function pump(): void {
  const jobs = Object.values(useJobsStore.getState().jobs);
  const running: Record<Lane, number> = { gpu: 0, publish: 0, export: 0, ai: 0, files: 0 };
  for (const job of jobs) if (job.state === 'running') running[JOB_KINDS[job.kind].lane] += 1;
  const queued = jobs
    .filter((j) => j.state === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt || seqOf(a) - seqOf(b));
  for (const job of queued) {
    const lane = JOB_KINDS[job.kind].lane;
    if (running[lane] >= LANES[lane]) continue;
    running[lane] += 1;
    launch(job.id);
  }
}

const seqOf = (job: Job) => Number(job.id.slice(1));

function launch(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  const store = useJobsStore.getState();
  store.start(id);
  const job = store.jobs[id];
  devLog('jobs', 'start', { id, kind: job?.kind, label: job?.label });
  const ctx: JobContext = {
    id,
    progress: (done, total, detail) => useJobsStore.getState().progress(id, done, total, detail),
    log: (line) => patch(id, (j) => ({ log: [...(j.log ?? []), line].slice(-LOG_LINES) })),
    onCancel: (handler) => {
      entry.onCancel = handler;
      patch(id, () => ({ cancel: () => useJobsStore.getState().cancel(id) }));
    },
    get cancelled() {
      return entry.cancelled;
    },
  };
  let promise: Promise<unknown>;
  try {
    promise = entry.spec.run(ctx);
  } catch (err) {
    promise = Promise.reject(err);
  }
  promise.then(
    (value) => {
      if (!entries.has(id)) return;
      // Done even after a cancel: the work finished before the cancel reached it.
      end(id, { state: 'done', value });
    },
    (err) => {
      if (!entries.has(id)) return;
      if (entry.cancelled || err instanceof JobCancelled) {
        end(id, { state: 'cancelled' });
        return;
      }
      const error = errorMessage(err);
      devLog('jobs', 'failed', { id, kind: job?.kind, label: job?.label, error });
      end(id, { state: 'failed', error, cause: err });
    },
  );
}

/**
 * Queue `spec` and start it when its lane has room (at once when it is free). With `dedupe`, an equal job already
 * queued or running is returned instead (`created: false`) and `spec.run` is dropped.
 */
export function enqueue<T>(spec: JobSpec<T>): JobHandle<T> {
  if (spec.dedupe !== undefined) {
    for (const [id, entry] of entries) {
      if (entry.spec.kind === spec.kind && entry.spec.dedupe === spec.dedupe && !entry.cancelled) {
        entry.owners.add(spec.project ?? '');
        return { id, created: false, result: entry.result as Promise<JobOutcome<T>> };
      }
    }
  }
  const id = `j${++seq}`;
  let settle: (outcome: JobOutcome<unknown>) => void = () => {};
  const result = new Promise<JobOutcome<unknown>>((resolve) => {
    settle = resolve;
  });
  entries.set(id, {
    spec: spec as JobSpec<unknown>,
    settle,
    result,
    cancelled: false,
    owners: new Set([spec.project ?? '']),
  });
  const job: Job = {
    id,
    kind: spec.kind,
    label: spec.label,
    ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
    ...(spec.project ? { project: spec.project } : {}),
    done: 0,
    total: 0,
    state: 'queued',
    queuedAt: Date.now(),
    startedAt: null,
  };
  useJobsStore.setState((s) => ({ jobs: { ...s.jobs, [id]: job } }));
  pump();
  return { id, created: true, result: result as Promise<JobOutcome<T>> };
}

/** Cancel job `id` (see `JobsState.cancel`). */
export function cancelJob(id: string): void {
  useJobsStore.getState().cancel(id);
}

/** The settled outcome of job `id`, or null when it is not queued or running (it may be over already). */
export function jobResult<T = unknown>(id: string): Promise<JobOutcome<T>> | null {
  return (entries.get(id)?.result as Promise<JobOutcome<T>> | undefined) ?? null;
}

/** Call `listener` with job `id` whenever it changes (also when it is over), until the returned function is called. */
export function watchJob(id: string, listener: (job: Job) => void): () => void {
  return useJobsStore.subscribe((s, prev) => {
    const job = s.jobs[id];
    if (job && job !== prev.jobs[id]) listener(job);
  });
}

/**
 * Cancel every queued and running job of `project` (it was closed) and say so in the bar; a job that another project
 * or a library Apply also waits on (joined through `dedupe`) goes on for them. Returns how many were cancelled.
 */
export function cancelProjectJobs(project: string, title?: string): number {
  const mine: Job[] = [];
  for (const [id, entry] of entries) {
    const job = useJobsStore.getState().jobs[id];
    if (!job || !isActive(job) || !entry.owners.delete(project)) continue;
    if (entry.owners.size === 0) {
      mine.push(job);
      continue;
    }
    // Another project (or a library Apply) joined it: it goes on for them.
    const next = [...entry.owners][0];
    patch(id, () => ({ project: next || undefined }));
  }
  for (const job of mine) cancelJob(job.id);
  if (mine.length > 0) {
    const what = mine.length === 1 ? '1 job' : `${mine.length} jobs`;
    useJobsStore.setState({ notice: `Closing ${title ? `“${title}”` : 'the project'} cancelled ${what}.` });
    devLog('jobs', 'project closed: cancelled its jobs', { project, count: mine.length });
  }
  return mine.length;
}

// Selectors (`useJobs` is the store hook with a selector).

export const useJobs = useJobsStore;

/** Queued and running jobs. */
export const activeJobCount = (s: JobsState): number => Object.values(s.jobs).filter(isActive).length;

/** Every job about `ref`, oldest first. */
export const jobsByRef = (s: JobsState, ref: string): Job[] =>
  Object.values(s.jobs)
    .filter((j) => j.ref === ref)
    .sort((a, b) => a.queuedAt - b.queuedAt || seqOf(a) - seqOf(b));

/** The queued or running job of `kind` about `ref`, if any. */
export const activeJobFor = (s: JobsState, kind: JobKind, ref: string): Job | undefined =>
  Object.values(s.jobs).find((j) => j.kind === kind && j.ref === ref && isActive(j));

/**
 * The queued or running job of `kind` whose `dedupe` key is `dedupe` (the job an equal `enqueue` would join), e.g. a
 * library photo's denoise for the project asset of the same file and settings (workflow plan 28).
 */
export function activeJobByDedupe(s: JobsState, kind: JobKind, dedupe: string): Job | undefined {
  for (const [id, entry] of entries) {
    if (entry.spec.kind !== kind || entry.spec.dedupe !== dedupe || entry.cancelled) continue;
    const job = s.jobs[id];
    if (job && isActive(job)) return job;
  }
  return undefined;
}

/** Queued and running jobs of `kinds` started for `project` (the publish dialog's "N photos still rendering"). */
export const activeProjectJobs = (s: JobsState, project: string, kinds: readonly JobKind[]): Job[] =>
  Object.values(s.jobs).filter((j) => j.project === project && kinds.includes(j.kind) && isActive(j));

/** Every job, newest first (the bar's list). */
export const jobList = (s: JobsState): Job[] =>
  Object.values(s.jobs).sort((a, b) => b.queuedAt - a.queuedAt || seqOf(b) - seqOf(a));

/** Tests: forget every job (running `run`s are left to finish on their own). */
export function resetJobs(): void {
  entries.clear();
  useJobsStore.setState({ jobs: {}, notice: null });
}
