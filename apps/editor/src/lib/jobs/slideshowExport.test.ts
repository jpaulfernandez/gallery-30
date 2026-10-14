import type { Book } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJobs, useJobsStore } from '../../store/jobs';

type Line = { job: number; stream: 'stdout' | 'stderr'; line: string };
type Exit = { job: number; code: number | null; signal: number | null; cancelled: boolean };
type Progress = { job: number; frame: number; total: number };

const mocks = vi.hoisted(() => ({
  framesCode: 0 as number | null,
  /** The signal that ends the frames CLI (with `framesCode` null). */
  framesSignal: null as number | null,
  /** Keep the frames CLI running until `cancelVideo`. */
  hold: false,
  runs: [] as string[],
  preflight: [] as Array<Record<string, unknown>>,
  /** What `encodeSlideshow` resolves to (null: cancelled), or an error it throws. */
  encode: '/photos/Exports/Videos/trip.mp4' as string | null | Error,
  calls: [] as string[],
  encodeRequests: [] as Array<Record<string, unknown>>,
  lines: new Set<(e: Line) => void>(),
  exits: new Set<(e: Exit) => void>(),
  progress: new Set<(e: Progress) => void>(),
  gates: [] as string[],
  held: null as number | null,
  revealExport: vi.fn(async () => {}),
  discard: vi.fn(async () => {}),
}));

vi.mock('../tauri', () => ({
  runSlideshowFrames: async (job: number, project: string, output: string, run: string) => {
    mocks.calls.push(`frames:${project}:${output}`);
    mocks.runs.push(run);
    if (mocks.hold) {
      mocks.held = job;
      return;
    }
    queueMicrotask(() => {
      for (const h of mocks.lines) {
        h({
          job,
          stream: 'stdout',
          line: JSON.stringify({ type: 'progress', step: 'slideshow', done: 90, total: 90, t: 0 }),
        });
        if (mocks.framesCode)
          h({ job, stream: 'stdout', line: JSON.stringify({ type: 'error', message: 'no Chromium', t: 0 }) });
      }
      for (const h of mocks.exits) h({ job, code: mocks.framesCode, signal: mocks.framesSignal, cancelled: false });
    });
  },
  slideshowPreflight: async (request: Record<string, unknown>) => {
    mocks.preflight.push(request);
    return { ffmpeg: '/x/ffmpeg', targetExists: true, neededBytes: 1, freeBytes: 2 };
  },
  encodeSlideshow: async (job: number, request: Record<string, unknown>) => {
    mocks.calls.push('encode');
    mocks.encodeRequests.push(request);
    for (const h of mocks.progress) h({ job, frame: 45, total: 90 });
    if (mocks.encode instanceof Error) throw mocks.encode;
    return mocks.encode;
  },
  cancelVideo: vi.fn(async (job: number) => {
    // Like Rust: the held CLI is killed with its group, then `video:exit` says a cancel did it.
    if (mocks.held === job) for (const h of mocks.exits) h({ job, code: null, signal: 9, cancelled: true });
  }),
  discardSlideshowFrames: mocks.discard,
  onVideoLine: async (h: (e: Line) => void) => {
    mocks.lines.add(h);
    return () => mocks.lines.delete(h);
  },
  onVideoExit: async (h: (e: Exit) => void) => {
    mocks.exits.add(h);
    return () => mocks.exits.delete(h);
  },
  onVideoProgress: async (h: (e: Progress) => void) => {
    mocks.progress.add(h);
    return () => mocks.progress.delete(h);
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

const { activeSlideshowExport, enqueueSlideshowExport, planSlideshowExport, preflightSlideshowExport } = await import(
  './slideshowExport'
);

function bookWithSlideshow(settings: Record<string, unknown> = {}): Book {
  const book = structuredClone(fixtureBook);
  book.outputs = [
    {
      id: 'SHOW',
      name: 'Summer trip',
      createdAt: 1,
      kind: 'slideshow',
      source: 'book',
      order: 'document',
      secondsPerSlide: 2,
      transition: 'crossfade',
      motion: 'ken-burns',
      size: '1080p',
      ...settings,
    } as Book['outputs'][number],
  ];
  return book;
}

const noPicks = { isPick: () => false };

beforeEach(() => {
  resetJobs();
  mocks.framesCode = 0;
  mocks.framesSignal = null;
  mocks.hold = false;
  mocks.held = null;
  mocks.runs = [];
  mocks.preflight = [];
  mocks.encode = '/photos/Exports/Videos/summer-trip.mp4';
  mocks.calls = [];
  mocks.encodeRequests = [];
  mocks.gates = [];
  mocks.revealExport.mockClear();
  mocks.discard.mockClear();
});

describe('planSlideshowExport', () => {
  it('counts slides × seconds × fps frames and names the video after the slideshow', () => {
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/photos/Exports/Videos/', ...noPicks });
    const slides = book.pages.length;
    expect(plan).toMatchObject({
      dest: '/photos/Exports/Videos',
      fileName: 'summer-trip.mp4',
      path: '/photos/Exports/Videos/summer-trip.mp4',
      slides,
      size: { width: 1920, height: 1080 },
    });
    expect(plan.timing.totalFrames).toBe(slides * 2 * 30);
    expect(plan.timing.seconds).toBe(slides * 2);
  });

  it('shows the picks, and refuses a slideshow with none', () => {
    const book = bookWithSlideshow({ source: 'picks' });
    expect(() => planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks })).toThrow(/No photo/);
    const [first] = Object.keys(book.assets);
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', isPick: (id) => id === first });
    expect(plan.slides).toBe(1);
    expect(plan.timing.totalFrames).toBe(60);
  });

  it('refuses the book and other outputs', () => {
    expect(() => planSlideshowExport(bookWithSlideshow(), 'PROJ', 'book', { dest: '/d', ...noPicks })).toThrow(
      /Only a slideshow/,
    );
  });
});

describe('enqueueSlideshowExport', () => {
  it('renders the frames after the gates, encodes them, deletes the frames and reveals the video', async () => {
    const book = bookWithSlideshow({ audioPath: '/appdata/audio/abc.m4a' });
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/photos/Exports/Videos', ...noPicks });
    const run = enqueueSlideshowExport({ plan, book, folder: '/photos', reveal: true, replace: true });
    // One job: the gates, the frames, then the encode (no export slot held while waiting).
    expect(run.jobs.map((id) => useJobsStore.getState().jobs[id]?.label)).toEqual(['Summer trip · summer-trip.mp4']);
    // A second export of the same slideshow while this one runs is this one.
    expect(enqueueSlideshowExport({ plan, book, folder: '/photos' })).toBe(run);
    expect(activeSlideshowExport('PROJ', 'SHOW')).toBe(run);
    expect(await run.done).toEqual({ state: 'done', path: '/photos/Exports/Videos/summer-trip.mp4' });
    expect(activeSlideshowExport('PROJ', 'SHOW')).toBeUndefined();
    const [runId] = mocks.runs;
    expect(runId).toMatch(/^[a-z0-9]+$/);
    expect(mocks.gates).toEqual([`denoise:${plan.slides}`, `render:${plan.slides}`]);
    expect(mocks.calls).toEqual(['frames:PROJ:SHOW', 'encode']);
    expect(mocks.encodeRequests[0]).toEqual({
      project: 'PROJ',
      output: 'SHOW',
      run: runId,
      dest: '/photos/Exports/Videos',
      fileName: 'summer-trip.mp4',
      audioPath: '/appdata/audio/abc.m4a',
      bitrate: 12_000_000,
      replace: true,
    });
    // Only this run's frames are deleted.
    expect(mocks.discard).toHaveBeenCalledWith('PROJ', 'SHOW', runId);
    expect(mocks.revealExport).toHaveBeenCalledWith('/photos/Exports/Videos/summer-trip.mp4');
  });

  it('does not encode when the frames fail, and still deletes them', async () => {
    mocks.framesCode = 1;
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    const outcome = await enqueueSlideshowExport({ plan, book, folder: '/photos', reveal: true }).done;
    expect(outcome).toEqual({ state: 'failed', error: 'no Chromium' });
    expect(mocks.calls).toEqual(['frames:PROJ:SHOW']);
    expect(mocks.discard).toHaveBeenCalled();
    expect(mocks.revealExport).not.toHaveBeenCalled();
  });

  it('ends cancelled when the encode was cancelled, and reports an encoder error', async () => {
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    mocks.encode = null;
    expect(await enqueueSlideshowExport({ plan, book, folder: '/photos' }).done).toEqual({ state: 'cancelled' });
    mocks.encode = new Error('FFmpeg failed: Unknown encoder');
    expect(await enqueueSlideshowExport({ plan, book, folder: '/photos' }).done).toEqual({
      state: 'failed',
      error: 'FFmpeg failed: Unknown encoder',
    });
    expect(mocks.discard).toHaveBeenCalledTimes(2);
  });

  it('gives each run its own frame folder', async () => {
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    await enqueueSlideshowExport({ plan, book, folder: '/photos' }).done;
    await enqueueSlideshowExport({ plan, book, folder: '/photos' }).done;
    expect(new Set(mocks.runs).size).toBe(2);
  });

  it('cancelling while the frames render kills the CLI, never encodes, and deletes the frames', async () => {
    mocks.hold = true;
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    const run = enqueueSlideshowExport({ plan, book, folder: '/photos' });
    await vi.waitFor(() => expect(mocks.held).not.toBeNull());
    useJobsStore.getState().cancel(run.jobs[0] ?? '');
    expect(await run.done).toEqual({ state: 'cancelled' });
    expect(mocks.calls).toEqual(['frames:PROJ:SHOW']);
    expect(mocks.discard).toHaveBeenCalledWith('PROJ', 'SHOW', mocks.runs[0]);
  });

  it('a CLI killed by a signal no cancel sent fails the export', async () => {
    mocks.framesCode = null;
    mocks.framesSignal = 9;
    const book = bookWithSlideshow();
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    expect(await enqueueSlideshowExport({ plan, book, folder: '/photos' }).done).toEqual({
      state: 'failed',
      error: 'render-slideshow was killed (signal 9)',
    });
    expect(mocks.calls).toEqual(['frames:PROJ:SHOW']);
  });

  it('preflights FFmpeg, audio, destination and disk with the frame count and size', async () => {
    const book = bookWithSlideshow({ audioPath: '/appdata/audio/abc.m4a', size: '4k' });
    const plan = planSlideshowExport(book, 'PROJ', 'SHOW', { dest: '/d', ...noPicks });
    expect(await preflightSlideshowExport(plan)).toEqual({ targetExists: true });
    expect(mocks.preflight[0]).toEqual({
      project: 'PROJ',
      output: 'SHOW',
      dest: '/d',
      fileName: 'summer-trip.mp4',
      audioPath: '/appdata/audio/abc.m4a',
      frames: plan.timing.totalFrames,
      width: 3840,
      height: 2160,
    });
  });
});
