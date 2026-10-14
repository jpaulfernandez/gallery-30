import {
  type Book,
  findOutput,
  frameFileName,
  pagesOf,
  type SocialFormat,
  socialTemplate,
  uniquePostSlug,
} from '@photobook/shared';
import { enqueue, JobCancelled, type JobContext } from '../../store/jobs';
import { denoiseBeforePublish, renderBeforePublish } from '../developPublish';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { type PublishEvent, parseLine } from '../publishRunner';
import {
  cancelRenderFrames,
  onSocialExit,
  onSocialLine,
  type RenderFramesRequest,
  revealExport,
  runRenderFrames,
} from '../tauri';

/**
 * Social post export (workflow plan 14). The frames are rendered by the publish CLI's `render-frames` (headless
 * Chromium, exactly as the book's page images; see `packages/publish/src/frames.ts` for why not in the webview).
 *
 * One `export` job per post: the denoise and render gates of publishing (`lib/developPublish.ts`, their jobs run in the
 * GPU lane) for the post's photos, then one CLI process (`run_render_frames`, task `post`) that removes the frames an
 * earlier export left and this one does not write, writes `caption.txt` and renders every frame, reporting each one
 * (the job's progress is the frame count). One process per post, not per frame: Node, the project file and Chromium
 * start once, and photos are processed into the publish cache by one process only.
 *
 * Files land in `<dest>/<slug>/` (`slug` unique among the project's posts). When the job is over the run's outcome
 * resolves, listing the frames written (also those before a failure), and the folder is revealed when asked.
 */

/** One frame of an export. */
export interface PlannedFrame {
  /** 1-based frame number. */
  n: number;
  pageId: string;
  /** `01.jpg`, … */
  file: string;
}

export interface SocialExportPlan {
  project: string;
  outputId: string;
  /** The post's name, for the job labels. */
  name: string;
  /** Destination folder chosen in the sheet. */
  dest: string;
  /** The post's own folder under it. */
  slug: string;
  /** `<dest>/<slug>`. */
  dir: string;
  format: SocialFormat;
  frames: PlannedFrame[];
  caption: string;
}

/** What one export does, without doing it. Throws when `outputId` is not a post with frames. */
export function planSocialExport(
  book: Book,
  project: string,
  outputId: string,
  options: { dest: string; format?: SocialFormat },
): SocialExportPlan {
  const output = findOutput(book, outputId);
  if (output?.kind !== 'social') throw new Error('Only a post can be exported here');
  const frames = pagesOf(book, outputId);
  if (frames.length === 0) throw new Error(`“${output.name}” has no frames`);
  const format = options.format ?? socialTemplate(output.network).format;
  const dest = options.dest.replace(/[\\/]+$/, '');
  const slug = uniquePostSlug(book.outputs, outputId);
  return {
    project,
    outputId,
    name: output.name,
    dest,
    slug,
    dir: `${dest}/${slug}`,
    format,
    frames: frames.map((page, i) => ({ n: i + 1, pageId: page.id, file: frameFileName(i, format) })),
    caption: output.caption,
  };
}

/** How a run ended, once every job is over. */
export interface SocialExportOutcome {
  /** Frame files written, in order (also when the run failed or was cancelled part way). */
  written: string[];
  /** 1 when the job failed, else 0. */
  failed: number;
  /** 1 when the job was cancelled, else 0. */
  cancelled: number;
  /** The error, when the job failed. */
  error?: string;
}

export interface SocialExportRun {
  plan: SocialExportPlan;
  /** The export's job id (one job per post). */
  jobs: string[];
  done: Promise<SocialExportOutcome>;
}

let nextJob = Date.now();

/**
 * Run one `render-frames` job of the CLI for `ctx`: progress from its `--json` events, Cancel kills it. Resolves when
 * it exits 0; throws `JobCancelled` when it was killed by a cancel, and an error otherwise (also when it was killed by
 * something else).
 */
async function runFramesCli(request: RenderFramesRequest, ctx: JobContext, onEvent?: (e: PublishEvent) => void) {
  const job = ++nextJob;
  let lastError: string | null = null;
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const unlistenLine = await onSocialLine((e) => {
    if (e.job !== job) return;
    const event = parseLine(e.stream, e.line);
    onEvent?.(event);
    if (event.type === 'progress') ctx.progress(event.done, event.total, `${event.step} · ${event.detail ?? ''}`);
    else if (event.type === 'step' && event.status === 'start') ctx.progress(0, 0, event.step);
    else if (event.type === 'log' && event.level === 'warn') ctx.log(event.message);
    else if (event.type === 'error') {
      lastError = event.message;
      ctx.log(`Error: ${event.message}`);
    } else if (event.type === 'raw' && event.stream === 'stderr' && event.line.trim()) ctx.log(event.line);
  });
  const unlistenExit = await onSocialExit((e) => {
    if (e.job === job) settle(e.code);
  });
  try {
    ctx.onCancel(() => cancelRenderFrames(job));
    if (ctx.cancelled) throw new JobCancelled();
    runRenderFrames(job, request).catch((err) => {
      lastError = `The export could not start: ${errorMessage(err)}`;
      settle(1);
    });
    const code = await exited;
    if (code === null && ctx.cancelled) throw new JobCancelled();
    if (code === null) throw new Error(lastError ?? 'render-frames stopped unexpectedly');
    if (code !== 0) throw new Error(lastError ?? `render-frames exited with code ${code}`);
  } finally {
    unlistenLine();
    unlistenExit();
  }
}

/**
 * Queue the export of post `plan.outputId` as one job (see the module comment). `book` is the saved book read through
 * the folders' libraries (`libraryBook`), `folder` the project's primary folder: the gates render the post's edited
 * photos into their folders' caches as publishing does.
 */
export function enqueueSocialExport(options: {
  plan: SocialExportPlan;
  book: Book;
  folder: string;
  quality?: number;
  /** Show the post's folder in the Finder once frames are written. */
  reveal?: boolean;
}): SocialExportRun {
  const { plan, book, folder, quality } = options;
  const written: string[] = [];
  const handle = enqueue<void>({
    kind: 'export',
    label: `${plan.name} · ${plan.frames.length === 1 ? '1 frame' : `${plan.frames.length} frames`}`,
    ref: plan.outputId,
    project: plan.project,
    run: async (ctx) => {
      // The post's frames stand in for the book's pages: the gates look at `pages`.
      const view: Book = { ...book, pages: pagesOf(book, plan.outputId) };
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
      const request: RenderFramesRequest = {
        project: plan.project,
        output: plan.outputId,
        dest: plan.dest,
        slug: plan.slug,
        task: 'post',
        format: plan.format,
        ...(quality ? { quality } : {}),
      };
      await runFramesCli(request, ctx, (e) => {
        // `render-frames` reports a `frames` step the publish event type does not list.
        if (e.type === 'progress' && (e.step as string) === 'frames' && e.detail)
          written.push(`${plan.dir}/${e.detail}`);
      });
    },
  });

  const done = handle.result.then((outcome): SocialExportOutcome => {
    const result: SocialExportOutcome = {
      written: [...written],
      failed: outcome.state === 'failed' ? 1 : 0,
      cancelled: outcome.state === 'cancelled' ? 1 : 0,
      ...(outcome.state === 'failed' ? { error: outcome.error } : {}),
    };
    devLog('export', 'post exported', { post: plan.name, dir: plan.dir, ...result });
    if (options.reveal && result.written.length > 0) {
      // `reveal_export` selects the path in its folder: the post's folder, inside the destination.
      revealExport(plan.dir).catch((err) => devLog('export', 'reveal failed', { error: errorMessage(err) }));
    }
    return result;
  });

  return { plan, jobs: [handle.id], done };
}
