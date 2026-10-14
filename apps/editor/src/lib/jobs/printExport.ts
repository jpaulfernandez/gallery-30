import { type Book, findOutput, imposePages, pagesOf, postSlug, printFileName, printSummary } from '@photobook/shared';
import { enqueue, JobCancelled, type JobContext, type JobOutcome } from '../../store/jobs';
import { denoiseBeforePublish, renderBeforePublish } from '../developPublish';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { parseLine } from '../publishRunner';
import { cancelPrint, onPrintExit, onPrintLine, type PrintRequest, revealExport, runPrint } from '../tauri';

/**
 * Print PDF export (workflow plan 15). The PDF is made by the publish CLI's `print` (headless Chromium `page.pdf`,
 * exactly the renderer of the book's page images; see `packages/publish/src/print.ts`), run as one job in the export
 * lane through `run_print`:
 *
 * 1. the denoise and render gates of publishing (`lib/developPublish.ts`, their jobs run in the GPU lane) for the
 *    pages the print prints, since the PDF takes its photos from the full-resolution renders;
 * 2. `print <project> --output <id> --out <dest>/<slug>.pdf`, its `--json` progress shown on the job.
 *
 * When the job is over the outcome resolves, and the PDF is revealed in the Finder when asked.
 */

export interface PrintExportPlan {
  project: string;
  outputId: string;
  /** The print's name, for the job label. */
  name: string;
  /** Destination folder chosen in the sheet. */
  dest: string;
  /** `<slug>.pdf`. */
  file: string;
  /** `<dest>/<file>`. */
  path: string;
  /** Pages printed and PDF pages (sheets) made. */
  pages: number;
  sheets: number;
  /** "A5 portrait spreads, 154 × 216 mm with bleed". */
  summary: string;
  /** Overwrite an existing PDF at `path` (confirmed in the sheet). */
  replace: boolean;
}

/** What one export does, without doing it. Throws when `outputId` is not a print with pages. */
export function planPrintExport(
  book: Book,
  project: string,
  outputId: string,
  options: { dest: string; replace?: boolean },
): PrintExportPlan {
  const output = findOutput(book, outputId);
  if (output?.kind !== 'print') throw new Error('Only a print can be exported as a PDF');
  const pages = pagesOf(book, outputId).length;
  if (pages === 0) throw new Error(`“${output.name}” has no pages to print`);
  const dest = options.dest.replace(/[\\/]+$/, '');
  const file = printFileName(postSlug(output.name));
  return {
    project,
    outputId,
    name: output.name,
    dest,
    file,
    path: `${dest}/${file}`,
    pages,
    sheets: imposePages(pages, output).length,
    summary: printSummary(output),
    replace: options.replace ?? false,
  };
}

/** How a run ended. */
export type PrintExportOutcome =
  | { state: 'done'; path: string }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' };

export interface PrintExportRun {
  plan: PrintExportPlan;
  job: string;
  done: Promise<PrintExportOutcome>;
}

let nextJob = Date.now();

/**
 * Run the CLI's `print` for `ctx`: progress from its `--json` events, Cancel kills it. Resolves when it exits 0;
 * throws `JobCancelled` when killed and the last error line otherwise.
 */
async function runPrintCli(request: PrintRequest, ctx: JobContext): Promise<void> {
  const job = ++nextJob;
  let lastError: string | null = null;
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const unlistenLine = await onPrintLine((e) => {
    if (e.job !== job) return;
    const event = parseLine(e.stream, e.line);
    if (event.type === 'progress') ctx.progress(event.done, event.total, `${event.step} · ${event.detail ?? ''}`);
    else if (event.type === 'step' && event.status === 'start') ctx.progress(0, 0, event.step);
    else if (event.type === 'log' && event.level === 'warn') ctx.log(event.message);
    else if (event.type === 'error') {
      lastError = event.message;
      ctx.log(`Error: ${event.message}`);
    } else if (event.type === 'raw' && event.stream === 'stderr' && event.line.trim()) ctx.log(event.line);
  });
  const unlistenExit = await onPrintExit((e) => {
    if (e.job === job) settle(e.code);
  });
  try {
    ctx.onCancel(() => cancelPrint(job));
    if (ctx.cancelled) throw new JobCancelled();
    runPrint(job, request).catch((err) => {
      lastError = `The PDF could not start: ${errorMessage(err)}`;
      settle(1);
    });
    const code = await exited;
    if (code === null) throw new JobCancelled();
    if (code !== 0) throw new Error(lastError ?? `print exited with code ${code}`);
  } finally {
    unlistenLine();
    unlistenExit();
  }
}

/**
 * Queue the PDF of print `plan.outputId` (see the module comment). `book` is the saved book read through the folders'
 * libraries (`libraryBook`), `folder` the project's primary folder: the gates render the printed pages' edited photos
 * into their folders' caches as publishing does.
 */
export function enqueuePrintExport(options: {
  plan: PrintExportPlan;
  book: Book;
  folder: string;
  /** Show the PDF in the Finder once it is written. */
  reveal?: boolean;
}): PrintExportRun {
  const { plan, book, folder } = options;
  const handle = enqueue<string>({
    kind: 'export',
    label: `${plan.name} · ${plan.file}`,
    ref: plan.outputId,
    project: plan.project,
    run: async (ctx) => {
      // The printed pages (the book's, or a post's frames) stand in for the book's pages: the gates look at `pages`.
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
      await runPrintCli(
        { project: plan.project, output: plan.outputId, dest: plan.dest, file: plan.file, replace: plan.replace },
        ctx,
      );
      return plan.path;
    },
  });

  const done = handle.result.then((result: JobOutcome<string>): PrintExportOutcome => {
    const outcome: PrintExportOutcome =
      result.state === 'done'
        ? { state: 'done', path: result.value }
        : result.state === 'failed'
          ? { state: 'failed', error: result.error }
          : { state: 'cancelled' };
    devLog('export', 'print exported', { print: plan.name, path: plan.path, state: outcome.state });
    if (options.reveal && outcome.state === 'done') {
      revealExport(outcome.path).catch((err) => devLog('export', 'reveal failed', { error: errorMessage(err) }));
    }
    return outcome;
  });

  return { plan, job: handle.id, done };
}
