import {
  type Book,
  findOutput,
  SLIDESHOW_SIZES,
  type SlideshowSizeInfo,
  type SlideshowTiming,
  slideshowSlides,
  slideshowTiming,
  videoFileName,
} from '@photobook/shared';
import { enqueue, JobCancelled, type JobContext, type JobHandle, type JobOutcome } from '../../store/jobs';
import { denoiseBeforePublish, renderBeforePublish } from '../developPublish';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { parseLine } from '../publishRunner';
import {
  cancelVideo,
  discardSlideshowFrames,
  encodeSlideshow,
  onVideoExit,
  onVideoLine,
  onVideoProgress,
  revealExport,
  runSlideshowFrames,
  slideshowPreflight,
} from '../tauri';

/**
 * Slideshow video export (workflow plan 16). The sheet runs `preflightSlideshowExport` first (FFmpeg, audio,
 * destination, disk space, an existing file), then one job in the export lane does, in turn:
 *
 * 1. the publish gates (`lib/developPublish.ts`: denoise and full renders of the slides' edited photos, in the GPU
 *    lane);
 * 2. the CLI's `render-slideshow` (`run_slideshow_frames`): every video frame as a JPEG, Ken Burns and transitions
 *    included, in this run's own folder `.photobook-publish/slideshow/<id>/frames-<run>/`;
 * 3. FFmpeg (`encode_slideshow`): `<dest>/<slug>.mp4` through a temp file.
 *
 * When the job is over this run's frames are deleted (they are large: about 0.3 MB a frame at 1080p) and the video is
 * revealed in the Finder when asked. Cancel kills whichever process runs; a cancelled encode leaves no partial video.
 * One export per slideshow at a time (`activeSlideshowExport`).
 */

export interface SlideshowExportPlan {
  project: string;
  outputId: string;
  /** The slideshow's name, for the job labels. */
  name: string;
  dest: string;
  fileName: string;
  /** `<dest>/<fileName>`. */
  path: string;
  slides: number;
  timing: SlideshowTiming;
  size: SlideshowSizeInfo;
  audioPath?: string;
  /** The slides as pages, for the publish gates (they look at the photos the pages use). */
  pages: Book['pages'];
}

/** What one export does, without doing it. Throws when `outputId` is not a slideshow with slides. */
export function planSlideshowExport(
  book: Book,
  project: string,
  outputId: string,
  options: { dest: string; isPick: (assetId: string) => boolean },
): SlideshowExportPlan {
  const output = findOutput(book, outputId);
  if (output?.kind !== 'slideshow') throw new Error('Only a slideshow can be exported as a video');
  const { pages } = slideshowSlides(book, output, { isPick: options.isPick });
  if (pages.length === 0) {
    throw new Error(
      output.source === 'picks' ? 'No photo of the project is picked yet' : `“${output.name}” has no slides`,
    );
  }
  const dest = options.dest.replace(/[\\/]+$/, '');
  const fileName = videoFileName(output.name);
  return {
    project,
    outputId,
    name: output.name,
    dest,
    fileName,
    path: `${dest}/${fileName}`,
    slides: pages.length,
    timing: slideshowTiming({
      slides: pages.length,
      secondsPerSlide: output.secondsPerSlide,
      transition: output.transition,
    }),
    size: SLIDESHOW_SIZES[output.size],
    ...(output.audioPath ? { audioPath: output.audioPath } : {}),
    pages,
  };
}

export interface SlideshowExportOutcome {
  state: 'done' | 'failed' | 'cancelled';
  /** The video, when written. */
  path?: string;
  error?: string;
}

export interface SlideshowExportRun {
  plan: SlideshowExportPlan;
  /** The export's job id (one job: gates, frames, encode). */
  jobs: string[];
  done: Promise<SlideshowExportOutcome>;
}

let nextJob = Date.now();

/** Runs in progress, by `<project>/<slideshow id>`: one export per slideshow at a time (they would share a file). */
const active = new Map<string, SlideshowExportRun>();
const activeKey = (project: string, outputId: string) => `${project}/${outputId}`;

/** The export of slideshow `outputId` in progress, if any (the sheet disables Export while there is one). */
export function activeSlideshowExport(project: string, outputId: string): SlideshowExportRun | undefined {
  return active.get(activeKey(project, outputId));
}

/** A run id: the name of this export's frame folder (`frames-<run>`), so two runs never share or delete frames. */
function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check what the export needs before any frame is rendered (`slideshow_preflight`): FFmpeg and its H.264 encoder, the
 * audio file, the destination and the disk space for the frames. Resolves with whether the video file exists already.
 */
export async function preflightSlideshowExport(plan: SlideshowExportPlan): Promise<{ targetExists: boolean }> {
  const result = await slideshowPreflight({
    project: plan.project,
    output: plan.outputId,
    dest: plan.dest,
    fileName: plan.fileName,
    ...(plan.audioPath ? { audioPath: plan.audioPath } : {}),
    frames: plan.timing.totalFrames,
    width: plan.size.width,
    height: plan.size.height,
  });
  return { targetExists: result.targetExists };
}

/**
 * Run `render-slideshow` into run `run`'s folder for `ctx`: progress from its `--json` events, Cancel kills it (and
 * the Node and Chromium it started). A CLI ended by a signal no cancel sent is a failure.
 */
async function runFramesCli(project: string, output: string, run: string, ctx: JobContext): Promise<void> {
  const job = ++nextJob;
  let lastError: string | null = null;
  let settle: (exit: { code: number | null; signal: number | null; cancelled: boolean }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: number | null; cancelled: boolean }>((resolve) => {
    settle = resolve;
  });
  const unlistenLine = await onVideoLine((e) => {
    if (e.job !== job) return;
    const event = parseLine(e.stream, e.line);
    if (event.type === 'progress') {
      // `render-slideshow` reports its frames as the `slideshow` step (not one of the publish steps).
      const step: string = event.step;
      const what = step === 'slideshow' ? 'frames' : step;
      ctx.progress(event.done, event.total, `${what} · ${event.detail ?? ''}`);
    } else if (event.type === 'step' && event.status === 'start') ctx.progress(0, 0, event.step);
    else if (event.type === 'log' && event.level === 'warn') ctx.log(event.message);
    else if (event.type === 'error') {
      lastError = event.message;
      ctx.log(`Error: ${event.message}`);
    } else if (event.type === 'raw' && event.stream === 'stderr' && event.line.trim()) ctx.log(event.line);
  });
  const unlistenExit = await onVideoExit((e) => {
    if (e.job === job) settle(e);
  });
  try {
    ctx.onCancel(() => cancelVideo(job));
    if (ctx.cancelled) throw new JobCancelled();
    runSlideshowFrames(job, project, output, run).catch((err) => {
      lastError = `The frames could not be rendered: ${errorMessage(err)}`;
      settle({ code: 1, signal: null, cancelled: false });
    });
    const exit = await exited;
    if (exit.cancelled) throw new JobCancelled();
    if (exit.code === null) {
      throw new Error(
        lastError ?? `render-slideshow was killed${exit.signal !== null ? ` (signal ${exit.signal})` : ''}`,
      );
    }
    if (exit.code !== 0) throw new Error(lastError ?? `render-slideshow exited with code ${exit.code}`);
  } finally {
    unlistenLine();
    unlistenExit();
  }
}

/** Encode run `run`'s frames with FFmpeg for `ctx`; the video's path. */
async function runEncode(plan: SlideshowExportPlan, run: string, replace: boolean, ctx: JobContext): Promise<string> {
  const job = ++nextJob;
  const unlisten = await onVideoProgress((e) => {
    if (e.job === job) ctx.progress(e.frame, e.total, 'encoding');
  });
  try {
    ctx.onCancel(() => cancelVideo(job));
    if (ctx.cancelled) throw new JobCancelled();
    ctx.progress(0, plan.timing.totalFrames, 'encoding');
    const path = await encodeSlideshow(job, {
      project: plan.project,
      output: plan.outputId,
      run,
      dest: plan.dest,
      fileName: plan.fileName,
      ...(plan.audioPath ? { audioPath: plan.audioPath } : {}),
      bitrate: plan.size.bitrate,
      replace,
    });
    if (path === null) throw new JobCancelled();
    return path;
  } finally {
    unlisten();
  }
}

/**
 * Queue the export of slideshow `plan.outputId` as one job (see the module comment); while it runs, another export of
 * the same slideshow returns this run. `book` is the saved book read through the folders' libraries (`libraryBook`),
 * `folder` the project's primary folder: the gates render the slides' edited photos into their folders' caches as
 * publishing does. `replace` lets the video replace an existing file (the sheet asked).
 */
export function enqueueSlideshowExport(options: {
  plan: SlideshowExportPlan;
  book: Book;
  folder: string;
  /** Show the video in the Finder once it is written. */
  reveal?: boolean;
  replace?: boolean;
}): SlideshowExportRun {
  const { plan, book, folder } = options;
  const key = activeKey(plan.project, plan.outputId);
  const running = active.get(key);
  if (running) return running;
  const run = newRunId();

  const job: JobHandle<string> = enqueue<string>({
    kind: 'export',
    label: `${plan.name} · ${plan.fileName}`,
    ref: plan.outputId,
    project: plan.project,
    dedupe: `slideshow:${key}`,
    run: async (ctx) => {
      // The slides stand in for the book's pages: the gates look at `pages`.
      const view: Book = { ...book, pages: plan.pages };
      const controller = new AbortController();
      ctx.onCancel(() => controller.abort());
      for (const gate of [denoiseBeforePublish, renderBeforePublish]) {
        const outcome = await gate({
          folder,
          book: view,
          project: plan.project,
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'progress') ctx.progress(e.done, e.total, `${e.step} · ${e.detail ?? ''}`);
          },
        });
        if (outcome === 'cancelled' || controller.signal.aborted) throw new JobCancelled();
      }
      await runFramesCli(plan.project, plan.outputId, run, ctx);
      // The encode follows in the same job, so it never holds an export slot while it waits for the frames.
      return runEncode(plan, run, options.replace ?? false, ctx);
    },
  });

  const done = (async (): Promise<SlideshowExportOutcome> => {
    const result: JobOutcome<string> = await job.result;
    // The frames are only an intermediate: this run's are gone whatever happened.
    await discardSlideshowFrames(plan.project, plan.outputId, run).catch((err) =>
      devLog('export', 'discard slideshow frames failed', { error: errorMessage(err) }),
    );
    active.delete(key);
    const outcome: SlideshowExportOutcome =
      result.state === 'done'
        ? { state: 'done', path: result.value }
        : result.state === 'failed'
          ? { state: 'failed', error: result.error }
          : { state: 'cancelled' };
    devLog('export', 'slideshow exported', { slideshow: plan.name, ...outcome });
    if (options.reveal && outcome.path) {
      revealExport(outcome.path).catch((err) => devLog('export', 'reveal failed', { error: errorMessage(err) }));
    }
    return outcome;
  })();

  const handle: SlideshowExportRun = { plan, jobs: [job.id], done };
  active.set(key, handle);
  return handle;
}
