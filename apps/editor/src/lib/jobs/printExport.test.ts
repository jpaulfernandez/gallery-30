import { type Book, DEFAULT_PRINT_SETTINGS } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJobs, useJobsStore } from '../../store/jobs';

type Line = { job: number; stream: 'stdout' | 'stderr'; line: string };
type Exit = { job: number; code: number | null };

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{ job: number; request: Record<string, unknown> }>,
  lines: new Set<(e: Line) => void>(),
  exits: new Set<(e: Exit) => void>(),
  code: 0 as number | null,
  revealExport: vi.fn(async () => {}),
  cancelPrint: vi.fn(async () => {}),
  gates: [] as string[],
}));

vi.mock('../tauri', () => ({
  runPrint: async (job: number, request: Record<string, unknown>) => {
    mocks.requests.push({ job, request });
    // Like the CLI: a progress line, then the exit.
    queueMicrotask(() => {
      const line = (text: string) => {
        for (const h of mocks.lines) h({ job, stream: 'stdout', line: text });
      };
      line(JSON.stringify({ type: 'progress', step: 'print', done: 1, total: 1, detail: 'x', t: 0 }));
      if (mocks.code) line(JSON.stringify({ type: 'error', message: 'Chromium is missing', t: 0 }));
      for (const h of mocks.exits) h({ job, code: mocks.code });
    });
  },
  cancelPrint: mocks.cancelPrint,
  onPrintLine: async (handler: (e: Line) => void) => {
    mocks.lines.add(handler);
    return () => mocks.lines.delete(handler);
  },
  onPrintExit: async (handler: (e: Exit) => void) => {
    mocks.exits.add(handler);
    return () => mocks.exits.delete(handler);
  },
  revealExport: mocks.revealExport,
}));

vi.mock('../developPublish', () => ({
  denoiseBeforePublish: async ({ book }: { book: Book }) => {
    mocks.gates.push(`denoise:${book.pages.length}`);
    return 'done';
  },
  renderBeforePublish: async ({ book }: { book: Book }) => {
    mocks.gates.push(`render:${book.pages.length}`);
    return 'done';
  },
}));

const { enqueuePrintExport, planPrintExport } = await import('./printExport');

/** The fixture book with a print of its pages (A5 spreads). */
function bookWithPrint(): Book {
  const book = structuredClone(fixtureBook);
  book.outputs = [
    {
      id: 'PRINT',
      name: 'Summer Zine',
      createdAt: 1,
      kind: 'print',
      ...DEFAULT_PRINT_SETTINGS,
      paper: 'a5',
      imposition: 'spreads',
    },
  ];
  return book;
}

beforeEach(() => {
  resetJobs();
  mocks.requests = [];
  mocks.code = 0;
  mocks.gates = [];
  mocks.revealExport.mockClear();
});

describe('planPrintExport', () => {
  it('names the PDF after the print, counts its sheets and summarises the paper', () => {
    const book = bookWithPrint();
    const plan = planPrintExport(book, 'PROJ', 'PRINT', { dest: '/photos/Exports/Print/' });
    expect(plan).toMatchObject({
      dest: '/photos/Exports/Print',
      file: 'summer-zine.pdf',
      path: '/photos/Exports/Print/summer-zine.pdf',
      pages: book.pages.length,
      sheets: 1 + Math.ceil((book.pages.length - 1) / 2),
    });
    expect(plan.summary).toMatch(/^A5 portrait spreads/);
  });

  it('refuses the book, posts and unknown outputs', () => {
    expect(() => planPrintExport(bookWithPrint(), 'PROJ', 'book', { dest: '/d' })).toThrow(/Only a print/);
    expect(() => planPrintExport(bookWithPrint(), 'PROJ', 'nope', { dest: '/d' })).toThrow(/Only a print/);
  });
});

describe('enqueuePrintExport', () => {
  it('runs the gates on the printed pages, then the CLI, as one export job; reveals the PDF', async () => {
    const book = bookWithPrint();
    const plan = planPrintExport(book, 'PROJ', 'PRINT', { dest: '/photos/Exports/Print' });
    const run = enqueuePrintExport({ plan, book, folder: '/photos', reveal: true });
    const job = useJobsStore.getState().jobs[run.job];
    expect(job).toMatchObject({
      kind: 'export',
      label: 'Summer Zine · summer-zine.pdf',
      ref: 'PRINT',
      project: 'PROJ',
    });

    expect(await run.done).toEqual({ state: 'done', path: '/photos/Exports/Print/summer-zine.pdf' });
    expect(mocks.gates).toEqual([`denoise:${book.pages.length}`, `render:${book.pages.length}`]);
    expect(mocks.requests.map((r) => r.request)).toEqual([
      { project: 'PROJ', output: 'PRINT', dest: '/photos/Exports/Print', file: 'summer-zine.pdf', replace: false },
    ]);
    expect(mocks.revealExport).toHaveBeenCalledWith('/photos/Exports/Print/summer-zine.pdf');
    expect(useJobsStore.getState().jobs[run.job]?.state).toBe('done');
  });

  it('a failed CLI fails the job with its error and reveals nothing', async () => {
    mocks.code = 1;
    const book = bookWithPrint();
    const plan = planPrintExport(book, 'PROJ', 'PRINT', { dest: '/d' });
    const outcome = await enqueuePrintExport({ plan, book, folder: '/photos', reveal: true }).done;
    expect(outcome).toEqual({ state: 'failed', error: 'Chromium is missing' });
    expect(mocks.revealExport).not.toHaveBeenCalled();
  });

  it('a killed CLI is a cancelled job', async () => {
    mocks.code = null;
    const book = bookWithPrint();
    const plan = planPrintExport(book, 'PROJ', 'PRINT', { dest: '/d' });
    expect(await enqueuePrintExport({ plan, book, folder: '/photos' }).done).toEqual({ state: 'cancelled' });
  });
});
