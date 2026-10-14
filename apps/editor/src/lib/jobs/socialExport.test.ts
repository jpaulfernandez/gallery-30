import type { Book } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, resetJobs, useJobsStore } from '../../store/jobs';

type Line = { job: number; stream: 'stdout' | 'stderr'; line: string };
type Exit = { job: number; code: number | null };

const mocks = vi.hoisted(() => ({
  requests: [] as Array<{ job: number; request: Record<string, unknown> }>,
  lines: new Set<(e: Line) => void>(),
  exits: new Set<(e: Exit) => void>(),
  /** Frame files the fake CLI reports, then its exit code (`'hang'`: wait for a cancel). */
  frames: ['01.jpg', '02.jpg', '03.jpg'],
  code: 0 as number | null | 'hang',
  revealExport: vi.fn(async () => {}),
  cancelRenderFrames: vi.fn(async (_job: number) => {}),
  gates: [] as string[],
}));

function emit(job: number, text: string): void {
  for (const h of mocks.lines) h({ job, stream: 'stdout', line: text });
}
function exit(job: number, code: number | null): void {
  for (const h of mocks.exits) h({ job, code });
}

vi.mock('../tauri', () => ({
  runRenderFrames: async (job: number, request: Record<string, unknown>) => {
    mocks.requests.push({ job, request });
    queueMicrotask(() => {
      for (const [i, file] of mocks.frames.entries()) {
        emit(job, JSON.stringify({ type: 'progress', step: 'frames', done: i + 1, total: 3, detail: file, t: 0 }));
      }
      if (mocks.code === 'hang') return;
      if (mocks.code) emit(job, JSON.stringify({ type: 'error', message: 'boom', t: 0 }));
      exit(job, mocks.code);
    });
  },
  cancelRenderFrames: async (job: number) => {
    await mocks.cancelRenderFrames(job);
    queueMicrotask(() => exit(job, null));
  },
  onSocialLine: async (handler: (e: Line) => void) => {
    mocks.lines.add(handler);
    return () => mocks.lines.delete(handler);
  },
  onSocialExit: async (handler: (e: Exit) => void) => {
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

const { enqueueSocialExport, planSocialExport } = await import('./socialExport');

/** The fixture book with a three-frame post (the book's pages, new ids), and a second post whose name slugs alike. */
function bookWithPost(): Book {
  const book = structuredClone(fixtureBook);
  const post = (id: string, name: string, prefix: string) => ({
    id,
    name,
    createdAt: 1,
    kind: 'social' as const,
    network: 'instagram-carousel' as const,
    frames: book.pages.map((p, i) => ({ ...structuredClone(p), id: `${prefix}${i}` })),
    caption: 'Hello',
  });
  book.outputs = [post('POST', 'Summer carousel', 'F'), post('POST2', 'Summer-carousel', 'G')];
  return book;
}

beforeEach(() => {
  resetJobs();
  mocks.requests = [];
  mocks.frames = ['01.jpg', '02.jpg', '03.jpg'];
  mocks.code = 0;
  mocks.gates = [];
  mocks.revealExport.mockClear();
  mocks.cancelRenderFrames.mockClear();
});

describe('planSocialExport', () => {
  it('names the frames 01 … NN under the post’s slug, in the network’s format unless chosen', () => {
    const plan = planSocialExport(bookWithPost(), 'PROJ', 'POST', { dest: '/photos/Exports/Posts/' });
    expect(plan).toMatchObject({
      dest: '/photos/Exports/Posts',
      slug: 'summer-carousel',
      dir: '/photos/Exports/Posts/summer-carousel',
      format: 'jpeg',
      caption: 'Hello',
    });
    expect(plan.frames).toEqual([
      { n: 1, pageId: 'F0', file: '01.jpg' },
      { n: 2, pageId: 'F1', file: '02.jpg' },
      { n: 3, pageId: 'F2', file: '03.jpg' },
    ]);
    expect(planSocialExport(bookWithPost(), 'PROJ', 'POST', { dest: '/d', format: 'png' }).frames[0]?.file).toBe(
      '01.png',
    );
  });

  it('gives a post whose name slugs like an earlier one its own folder', () => {
    expect(planSocialExport(bookWithPost(), 'PROJ', 'POST2', { dest: '/d' }).dir).toBe('/d/summer-carousel-2');
  });

  it('refuses the book and unknown outputs', () => {
    expect(() => planSocialExport(bookWithPost(), 'PROJ', 'book', { dest: '/d' })).toThrow(/Only a post/);
    expect(() => planSocialExport(bookWithPost(), 'PROJ', 'nope', { dest: '/d' })).toThrow(/Only a post/);
  });
});

describe('enqueueSocialExport', () => {
  const start = (reveal = false) => {
    const book = bookWithPost();
    const plan = planSocialExport(book, 'PROJ', 'POST', { dest: '/photos/Exports/Posts' });
    return enqueueSocialExport({ plan, book, folder: '/photos', reveal, quality: 90 });
  };

  it('queues one job that gates the post’s photos and runs the CLI once for the whole post', async () => {
    const run = start(true);
    expect(run.jobs).toHaveLength(1);
    const job = useJobsStore.getState().jobs[run.jobs[0] ?? ''];
    expect([job?.kind, job?.label]).toEqual(['export', 'Summer carousel · 3 frames']);

    const outcome = await run.done;
    expect(outcome).toEqual({
      written: [1, 2, 3].map((n) => `/photos/Exports/Posts/summer-carousel/0${n}.jpg`),
      failed: 0,
      cancelled: 0,
    });
    // The gates saw the post's three frames, not the book's pages.
    expect(mocks.gates).toEqual(['denoise:3', 'render:3']);
    expect(mocks.requests.map((r) => r.request)).toEqual([
      {
        project: 'PROJ',
        output: 'POST',
        dest: '/photos/Exports/Posts',
        slug: 'summer-carousel',
        task: 'post',
        format: 'jpeg',
        quality: 90,
      },
    ]);
    expect(useJobsStore.getState().jobs[run.jobs[0] ?? '']).toMatchObject({ state: 'done', done: 3, total: 3 });
    expect(mocks.revealExport).toHaveBeenCalledWith('/photos/Exports/Posts/summer-carousel');
  });

  it('a failure part way keeps the frames written so far and reports the error', async () => {
    mocks.frames = ['01.jpg'];
    mocks.code = 1;
    const outcome = await start().done;
    expect(outcome).toEqual({
      written: ['/photos/Exports/Posts/summer-carousel/01.jpg'],
      failed: 1,
      cancelled: 0,
      error: 'boom',
    });
    expect(mocks.revealExport).not.toHaveBeenCalled();
  });

  it('a CLI killed without a cancel is a failure, not a cancel', async () => {
    mocks.frames = [];
    mocks.code = null;
    const outcome = await start(true).done;
    expect(outcome).toMatchObject({ failed: 1, cancelled: 0, error: 'render-frames stopped unexpectedly' });
    expect(mocks.revealExport).not.toHaveBeenCalled();
  });

  it('Cancel kills the CLI and ends the job cancelled', async () => {
    mocks.frames = ['01.jpg'];
    mocks.code = 'hang';
    const run = start();
    await vi.waitFor(() => expect(mocks.requests).toHaveLength(1));
    await vi.waitFor(() => expect(useJobsStore.getState().jobs[run.jobs[0] ?? '']?.done).toBe(1));
    cancelJob(run.jobs[0] ?? '');
    const outcome = await run.done;
    expect(outcome).toMatchObject({
      cancelled: 1,
      failed: 0,
      written: ['/photos/Exports/Posts/summer-carousel/01.jpg'],
    });
    expect(mocks.cancelRenderFrames).toHaveBeenCalledWith(mocks.requests[0]?.job);
  });
});
