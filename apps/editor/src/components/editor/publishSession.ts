import { create } from 'zustand';
import { type PublishEvent, type PublishStep, startPublish } from '../../lib/publishRunner';
import { flush } from '../../store/autosave';
import { useBookStore } from '../../store/book';
import { cancelJob } from '../../store/jobs';
import { libraryBook } from '../../store/library';

export type StepState = {
  status: 'pending' | 'running' | 'done' | 'skipped';
  ms?: number;
  detail?: string;
  progress?: { done: number; total: number; detail?: string };
};

/**
 * The last publish of the session, outside the dialog (plan 09): the run is a job that goes on when the dialog is
 * closed or the stage changes, so its steps, log and result live here and the dialog shows them again when reopened.
 */
export interface PublishSession {
  /** The project published; the dialog of another project starts idle. */
  project: string | null;
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** The `publish` job while it is queued or running. */
  jobId: string | null;
  /** The denoise and render jobs the run waits for (queued by it or joined), for "N photos still rendering". */
  gateJobs: string[];
  steps: Partial<Record<PublishStep, StepState>>;
  log: string[];
  result: Extract<PublishEvent, { type: 'result' }> | null;
  error: { message: string; keys?: string[] } | null;
}

const IDLE: PublishSession = {
  project: null,
  phase: 'idle',
  jobId: null,
  gateJobs: [],
  steps: {},
  log: [],
  result: null,
  error: null,
};

export const usePublishSession = create<PublishSession>()(() => IDLE);

/** Cancel was pressed before the job was queued (while pending edits were written). */
let cancelAsked = false;

/** `session` after `e`. */
export function applyPublishEvent(session: PublishSession, e: PublishEvent): Partial<PublishSession> {
  switch (e.type) {
    case 'step': {
      const prev = session.steps[e.step];
      const step: StepState = {
        ...prev,
        status: e.status === 'start' ? 'running' : e.status,
        ms: e.ms,
        detail: e.detail ?? prev?.detail,
      };
      return { steps: { ...session.steps, [e.step]: step } };
    }
    case 'progress': {
      const step: StepState = {
        ...(session.steps[e.step] ?? { status: 'running' }),
        progress: { done: e.done, total: e.total, detail: e.detail },
      };
      return { steps: { ...session.steps, [e.step]: step } };
    }
    case 'log':
      return e.level === 'warn' ? { log: [...session.log, e.message] } : {};
    case 'result':
      return { result: e };
    case 'error':
      return { error: { message: e.message, keys: e.keys } };
    case 'raw':
      return e.stream === 'stderr' && e.line.trim() ? { log: [...session.log, e.line] } : {};
  }
}

/**
 * Publish the open project: write pending edits, queue the `publish` job and follow it. Once it succeeds (not a dry
 * run) the publish is recorded in the project, when that project is still the open one. Resolves when it is over.
 */
export async function startPublishSession(options: { dryRun: boolean; prune: boolean }): Promise<void> {
  const { folder, projectId: project } = useBookStore.getState();
  if (!folder || !project) return;
  const current = usePublishSession.getState();
  if (current.phase === 'running') return;
  usePublishSession.setState({ ...IDLE, project, phase: 'running' });
  cancelAsked = false;
  // The CLI reads the project file from disk: write pending edits first.
  await flush();
  // Develop settings read through the folders' libraries, as the CLI resolves them.
  const book = libraryBook(useBookStore.getState());
  const onEvent = (e: PublishEvent) => usePublishSession.setState((s) => applyPublishEvent(s, e));
  const run = await startPublish(
    {
      command: 'publish',
      project,
      folder,
      dryRun: options.dryRun,
      prune: options.prune,
      book,
      onJobs: (ids) => usePublishSession.setState((s) => ({ gateJobs: [...s.gateJobs, ...ids] })),
    },
    onEvent,
  );
  usePublishSession.setState({ jobId: run.jobId ?? null });
  if (cancelAsked) void run.cancel();
  const code = await run.done;
  const { result } = usePublishSession.getState();
  usePublishSession.setState((s) => ({
    jobId: null,
    phase: code === 0 ? 'done' : 'failed',
    error:
      s.error ??
      (code === null
        ? { message: 'Cancelled' }
        : code !== 0
          ? { message: `The publish command exited with code ${code}` }
          : null),
  }));
  // Record the publish in the document once the CLI reports success (not for dry runs).
  if (code === 0 && result && !result.dryRun && useBookStore.getState().projectId === project) {
    useBookStore
      .getState()
      .setPublish({ lastPublishedAt: result.publishedAt, publishedFingerprint: result.fingerprint });
  }
}

/** Cancel the running publish (its job, and through it the renders and denoise it queued). */
export function cancelPublishSession(): void {
  const { jobId, phase } = usePublishSession.getState();
  if (jobId) cancelJob(jobId);
  else if (phase === 'running') cancelAsked = true;
}

/** Tests: forget the last publish. */
export function resetPublishSession(): void {
  usePublishSession.setState(IDLE);
}
