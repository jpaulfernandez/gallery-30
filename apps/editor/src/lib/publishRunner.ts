import type { Book } from '@photobook/shared';
import { useBookStore } from '../store/book';
import { cancelJob, enqueue, JobCancelled, type JobContext } from '../store/jobs';
import { denoiseBeforePublish, pruneAfterPublish, renderBeforePublish } from './developPublish';
import { errorMessage } from './errors';
import { devLog } from './log';
import { cancelPublish, onPublishExit, onPublishLine, type PublishCommand, runPublish } from './tauri';

/**
 * The CLI's `--json` events (packages/publish/src/log.ts), as the editor reads them, plus the editor's own
 * `denoise` (AI denoise of photos whose intermediate is missing) and `develop` (rendering edited photos) steps that
 * run before the CLI starts (lib/developPublish.ts).
 */
export type PublishStep =
  | 'denoise'
  | 'develop'
  | 'freeze'
  | 'plan'
  | 'images'
  | 'pages'
  | 'upload'
  | 'manifest'
  | 'site'
  | 'prune'
  | 'record';

export type PublishEvent =
  | { type: 'step'; step: PublishStep; status: 'start' | 'done' | 'skipped'; ms?: number; detail?: string; t: number }
  | { type: 'progress'; step: PublishStep; done: number; total: number; detail?: string; t: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string; t: number }
  | {
      type: 'result';
      url: string;
      link?: string;
      publishedAt: string;
      fingerprint: string;
      uploaded: number;
      skipped: number;
      bytes: number;
      dryRun: boolean;
      t: number;
    }
  | { type: 'error'; message: string; keys?: string[]; t: number }
  /** A line that was not JSON (stderr, a crash). */
  | { type: 'raw'; stream: 'stdout' | 'stderr'; line: string; t: number };

export interface PublishRun {
  /** Resolves with the exit code (null when cancelled) once the process has ended. */
  done: Promise<number | null>;
  cancel: () => Promise<void>;
  /** The `publish` job in the queue (`store/jobs.ts`). */
  jobId: string;
}

let nextJob = Date.now();

/** What the jobs bar calls a CLI run. */
function jobLabel(command: PublishCommand, dryRun: boolean | undefined, book: Book | null | undefined): string {
  if (command === 'publish') return `${dryRun ? 'Dry run' : 'Publish'}${book?.title ? ` “${book.title}”` : ''}`;
  if (command === 'unpublish') return 'Unpublish';
  if (command === 'doctor') return 'Check publish settings';
  return 'Clear the reader password';
}

/**
 * Start a CLI command as a `publish` job (plan 09: one at a time, in the jobs bar with its warnings and errors as the
 * line log) and feed its events to `onEvent`. Listeners are attached before the process starts and removed after it
 * exits.
 *
 * For `publish` with a `book`, photos with AI denoise on and no intermediate are denoised first (`denoise` step
 * events), then the edited photos that have no full render yet are rendered (`develop` step events): both are jobs
 * of their own that this one waits for (`lib/developPublish.ts`). Then the CLI starts. `cancel()` (or Cancel in the
 * bar) cancels the jobs it queued or stops the CLI, and the CLI never starts after a cancel. A denoise or render error
 * ends the run with exit code 1 and an `error` event. After a real (not dry-run) publish that exits 0, renders the book
 * no longer uses are deleted.
 */
export async function startPublish(
  options: {
    command: PublishCommand;
    /** The open project's id: the CLI runs on its file (`photobook publish <project file>`). */
    project?: string | null;
    /** The open project's primary folder; edited photos are rendered into each photo's own folder. */
    folder?: string | null;
    dryRun?: boolean;
    prune?: boolean;
    /** The saved book (flush autosave first): its edited photos are rendered before a `publish`. */
    book?: Book | null;
    /** Told the ids of the denoise and render jobs the publish waits for. */
    onJobs?: (ids: string[]) => void;
  },
  onEvent: (event: PublishEvent) => void,
): Promise<PublishRun> {
  let code: number | null = null;
  let lastError: string | null = null;
  const handle = enqueue({
    kind: 'publish',
    label: jobLabel(options.command, options.dryRun, options.book),
    ref: options.project ?? undefined,
    project: options.project,
    run: async (ctx) => {
      code = await runCli(options, ctx, (e) => {
        report(ctx, e);
        if (e.type === 'error') lastError = e.message;
        onEvent(e);
      });
      if (code === null) throw new JobCancelled();
      if (code !== 0) throw new Error(lastError ?? `The ${options.command} command exited with code ${code}`);
    },
  });
  const done = handle.result.then((outcome) => (outcome.state === 'cancelled' ? null : (code ?? 1)));
  return {
    done,
    cancel: async () => cancelJob(handle.id),
    jobId: handle.id,
  };
}

/** The job's progress and line log for an event: the step on screen, warnings and errors. */
function report(ctx: JobContext, e: PublishEvent): void {
  if (e.type === 'step' && e.status === 'start') ctx.progress(0, 0, e.step);
  else if (e.type === 'progress') ctx.progress(e.done, e.total, `${e.step}${e.detail ? ` · ${e.detail}` : ''}`);
  else if (e.type === 'log' && e.level === 'warn') ctx.log(e.message);
  else if (e.type === 'error') ctx.log(`Error: ${e.message}`);
  else if (e.type === 'raw' && e.stream === 'stderr' && e.line.trim()) ctx.log(e.line);
}

/** The work of a `startPublish` job: the gate, then the CLI. Resolves with the exit code, null when cancelled. */
async function runCli(
  options: Parameters<typeof startPublish>[0],
  ctx: JobContext,
  onEvent: (event: PublishEvent) => void,
): Promise<number | null> {
  const { book, folder, onJobs, ...cli } = options;
  const job = ++nextJob;
  let settle: (code: number | null) => void = () => {};
  const done = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const unlistenLine = await onPublishLine((e) => {
    if (e.job !== job) return;
    onEvent(parseLine(e.stream, e.line));
  });
  const unlistenExit = await onPublishExit((e) => {
    if (e.job !== job) return;
    void (async () => {
      if (e.code === 0 && cli.command === 'publish' && !cli.dryRun && book && folder) {
        // Every edit the folder libraries hold stays (another project may use a version this one does not).
        await pruneAfterPublish(folder, book, useBookStore.getState().libraries);
      }
      settle(e.code);
    })();
  });
  const finish = () => {
    unlistenLine();
    unlistenExit();
  };
  void done.then(finish);
  devLog('publish', 'start', { job, ...cli, ...(folder ? { folder } : {}) });

  const controller = new AbortController();
  const { signal } = controller;
  let gating = false;
  ctx.onCancel(async () => {
    controller.abort();
    // The gate cancels the jobs it queued; once past it, the CLI is the thing to stop.
    if (!gating) await cancelPublish(job);
  });
  // Cancelled while the listeners were being attached: nothing has started.
  if (ctx.cancelled) controller.abort();
  const launch = async () => {
    // A dry run publishes nothing, so it does not render full-size files: the CLI reports the missing ones as warnings.
    if (cli.command === 'publish' && !cli.dryRun && book && folder) {
      gating = true;
      try {
        // The full renders start from the denoise intermediates, so those come first.
        for (const gate of [denoiseBeforePublish, renderBeforePublish]) {
          const outcome = await gate({ folder, book, onEvent, signal, project: cli.project, onJobs });
          if (outcome === 'cancelled' || signal.aborted) return settle(null);
        }
      } catch (err) {
        onEvent({ type: 'error', message: errorMessage(err), t: 0 });
        return settle(signal.aborted ? null : 1);
      } finally {
        gating = false;
      }
    }
    if (signal.aborted) return settle(null);
    // The CLI could not start: a failure with the reason, not a cancel.
    runPublish({ job, ...cli }).catch((err) => {
      onEvent({ type: 'error', message: `The publish command could not start: ${errorMessage(err)}`, t: 0 });
      settle(1);
    });
  };
  void launch();
  return done;
}

export function parseLine(stream: 'stdout' | 'stderr', line: string): PublishEvent {
  if (stream === 'stdout' && line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line) as PublishEvent;
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) return parsed;
    } catch {
      // fall through
    }
  }
  return { type: 'raw', stream, line, t: 0 };
}
