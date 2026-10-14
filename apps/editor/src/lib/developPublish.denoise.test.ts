import { type Book, createDevelop, type DevelopSettings, resolveAssetDevelop } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usedAssetIds } from '../components/filmstrip/visible';
import { activeProjectJobs, resetJobs, useJobsStore } from '../store/jobs';
import type { PublishEvent } from './publishRunner';
import type { AiModelInfo, DenoiseStatus } from './tauri';

const mocks = vi.hoisted(() => ({
  denoiseStatus: vi.fn(),
  runDenoise: vi.fn(),
  cancelDenoise: vi.fn(async () => true),
  developRendersPresent: vi.fn(),
  progress: null as null | ((e: { job: number; done: number; total: number }) => void),
  unlisten: vi.fn(),
}));
vi.mock('./tauri', () => ({
  denoiseStatus: mocks.denoiseStatus,
  runDenoise: mocks.runDenoise,
  cancelDenoise: mocks.cancelDenoise,
  developRendersPresent: mocks.developRendersPresent,
  onDenoiseProgress: async (handler: (e: { job: number; done: number; total: number }) => void) => {
    mocks.progress = handler;
    return mocks.unlisten;
  },
}));

const { denoiseBeforePublish } = await import('./developPublish');

const model = (state: 'installed' | 'missing' | 'partial' = 'installed'): AiModelInfo => ({
  name: 'nafnet-sidd-width32',
  title: 'NAFNet (w32)',
  version: '1',
  bytes: 117_115_760,
  licence: 'MIT',
  licenceUrl: 'https://example.test/licence',
  status: state === 'partial' ? { state, bytes: 10 } : { state },
});
const status = (key: string, ready: boolean, state: 'installed' | 'missing' = 'installed'): DenoiseStatus => ({
  key,
  ready,
  bytes: ready ? 1 : 0,
  model: model(state),
});

/** The fixture book with its first `n` used photos denoised (hash `hash-<index>`, path `p<index>.jpg`). */
function denoisedBook(n: number): { book: Book; ids: string[] } {
  const book = structuredClone(fixtureBook);
  const ids = [...usedAssetIds(book.pages)].slice(0, n);
  ids.forEach((id, i) => {
    const asset = book.assets[id] as Book['assets'][string];
    asset.hash = `hash-${i}`;
    asset.path = `p${i}.jpg`;
    const develop = createDevelop();
    develop.detail.denoise = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' };
    asset.develop = develop;
  });
  return { book, ids };
}

const run = (book: Book, over: Partial<Parameters<typeof denoiseBeforePublish>[0]> = {}) => {
  const events: PublishEvent[] = [];
  const result = denoiseBeforePublish({
    folder: '/photos',
    book,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { result, events };
};

const done = (key: string) => ({
  status: 'done',
  key,
  path: '/x.png',
  width: 1,
  height: 1,
  elapsedMs: 5,
  engine: 'CoreML',
  tiles: 4,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.progress = null;
  mocks.developRendersPresent.mockResolvedValue([]);
});

describe('denoiseBeforePublish', () => {
  it('does nothing for a book without denoised photos', async () => {
    const book = structuredClone(fixtureBook);
    const { result, events } = run(book);
    await expect(result).resolves.toBe('done');
    expect(events).toEqual([]);
    expect(mocks.denoiseStatus).not.toHaveBeenCalled();
  });

  it('runs only the photos whose intermediate is missing, one at a time, with tile progress', async () => {
    const { book } = denoisedBook(3);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, hash === 'hash-0'));
    const order: string[] = [];
    mocks.runDenoise.mockImplementation(async (_f: string, rel: string, hash: string, _s: unknown, job: number) => {
      order.push(rel);
      mocks.progress?.({ job: job + 999, done: 1, total: 9 }); // another job's event is ignored
      mocks.progress?.({ job, done: 40, total: 117 });
      return done(`key-${hash}`);
    });
    const { result, events } = run(book);
    await expect(result).resolves.toBe('done');
    expect(order).toEqual(['p1.jpg', 'p2.jpg']);
    expect(events[0]).toMatchObject({ type: 'step', step: 'denoise', status: 'start' });
    const lines = events.filter((e) => e.type === 'progress');
    expect(lines).toContainEqual(
      expect.objectContaining({ step: 'denoise', done: 1, total: 2, detail: 'p1.jpg · tile 40/117' }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ step: 'denoise', done: 2, total: 2, detail: 'p2.jpg · tile 40/117' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'step', step: 'denoise', status: 'done', detail: '2 denoised' });
    expect(mocks.unlisten).toHaveBeenCalledTimes(2);
  });

  it('reports up to date and runs nothing when every intermediate exists', async () => {
    const { book } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, true));
    const { result, events } = run(book);
    await expect(result).resolves.toBe('done');
    expect(mocks.runDenoise).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({ step: 'denoise', status: 'done', detail: '2 up to date' })]);
  });

  it('aborts before running anything when the model is not installed, naming it and its size', async () => {
    const { book } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false, 'missing'));
    const { result } = run(book);
    await expect(result).rejects.toThrow(/NAFNet \(w32\).*117 MB/);
    expect(mocks.runDenoise).not.toHaveBeenCalled();
  });

  it('aborts when the run itself reports a missing model', async () => {
    const { book } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    mocks.runDenoise.mockResolvedValue({ status: 'missingModel', model: model('missing') });
    const { result } = run(book);
    await expect(result).rejects.toThrow(/NAFNet \(w32\).*117 MB/);
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
  });

  it('prefixes a failure with the photo and stops the queue', async () => {
    const { book } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    mocks.runDenoise.mockRejectedValue('out of memory');
    const { result } = run(book);
    await expect(result).rejects.toThrow('p0.jpg: out of memory');
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
  });

  it('resolves cancelled and never starts the rest when a run is cancelled', async () => {
    const { book } = denoisedBook(3);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    mocks.runDenoise.mockResolvedValue({ status: 'cancelled' });
    const { result, events } = run(book);
    await expect(result).resolves.toBe('cancelled');
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'step' && e.status === 'done')).toBe(false);
    // The queued ones were cancelled, not left behind.
    expect(Object.values(useJobsStore.getState().jobs).map((j) => j.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('a cancelled publish cancels the running run and the queued ones never start', async () => {
    const { book } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    const controller = new AbortController();
    let finish: (outcome: unknown) => void = () => {};
    mocks.runDenoise.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { result } = run(book, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.runDenoise).toHaveBeenCalledTimes(1));
    const job = mocks.runDenoise.mock.calls[0]?.[4] as number;
    controller.abort();
    expect(mocks.cancelDenoise).toHaveBeenCalledWith(job);
    finish({ status: 'cancelled' });
    await expect(result).resolves.toBe('cancelled');
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
  });

  it('runs as denoise jobs of the project, one at a time, and joins an Apply already running', async () => {
    const { book, ids } = denoisedBook(2);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    const finishes: Array<() => void> = [];
    mocks.runDenoise.mockImplementation(
      (_f: string, _r: string, hash: string) =>
        new Promise((resolve) => finishes.push(() => resolve(done(`key-${hash}`)))),
    );
    // An Apply of the first photo is running already (from Develop, outside the project).
    const { enqueueDenoise } = await import('./jobs/denoise');
    const settings = resolveAssetDevelop(book.assets[ids[0] as string] as Book['assets'][string]) as DevelopSettings;
    const apply = enqueueDenoise({ folder: '/photos', relPath: 'p0.jpg', hash: 'hash-0', settings, label: 'p0.jpg' });
    await vi.waitFor(() => expect(mocks.runDenoise).toHaveBeenCalledTimes(1));
    const { result } = run(book, { project: 'P' });
    // The publish queued only the second photo, behind the Apply (one denoise at a time).
    await vi.waitFor(() => expect(activeProjectJobs(useJobsStore.getState(), 'P', ['denoise'])).toHaveLength(1));
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
    finishes[0]?.();
    await expect(apply.result).resolves.toMatchObject({ state: 'done' });
    await vi.waitFor(() => expect(mocks.runDenoise).toHaveBeenCalledTimes(2));
    finishes[1]?.();
    await expect(result).resolves.toBe('done');
    expect(activeProjectJobs(useJobsStore.getState(), 'P', ['denoise'])).toHaveLength(0);
  });

  it('a cancelled publish stops waiting on a joined run at once and leaves it running', async () => {
    const { book, ids } = denoisedBook(1);
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    let finish: (outcome: unknown) => void = () => {};
    mocks.runDenoise.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { enqueueDenoise } = await import('./jobs/denoise');
    const settings = resolveAssetDevelop(book.assets[ids[0] as string] as Book['assets'][string]) as DevelopSettings;
    const apply = enqueueDenoise({ folder: '/photos', relPath: 'p0.jpg', hash: 'hash-0', settings, label: 'p0.jpg' });
    const controller = new AbortController();
    const joined: string[] = [];
    const { result } = run(book, { signal: controller.signal, onJobs: (j) => joined.push(...j) });
    await vi.waitFor(() => expect(joined).toEqual([apply.id]));
    controller.abort();
    await expect(result).resolves.toBe('cancelled');
    expect(mocks.cancelDenoise).not.toHaveBeenCalled();
    expect(useJobsStore.getState().jobs[apply.id]?.state).toBe('running');
    finish(done('key-hash-0'));
    await expect(apply.result).resolves.toMatchObject({ state: 'done' });
  });

  it('skips photos whose full render is cached and photos that share an intermediate', async () => {
    const { book, ids } = denoisedBook(3);
    // The first two share bytes and settings, so one run serves both; the third has its render already.
    (book.assets[ids[1] as string] as Book['assets'][string]).hash = 'hash-0';
    mocks.denoiseStatus.mockImplementation(async (hash: string) => status(`key-${hash}`, false));
    mocks.developRendersPresent.mockImplementation(async (_f: string, names: string[]) =>
      names.filter((n) => n.startsWith('hash-2-')),
    );
    mocks.runDenoise.mockImplementation(async (_f: string, _r: string, hash: string) => done(`key-${hash}`));
    const { result } = run(book);
    await expect(result).resolves.toBe('done');
    expect(mocks.runDenoise).toHaveBeenCalledTimes(1);
    expect(mocks.runDenoise).toHaveBeenCalledWith('/photos', 'p0.jpg', 'hash-0', expect.anything(), expect.any(Number));
  });

  it('refuses a denoised photo that has no hash yet', async () => {
    const { book, ids } = denoisedBook(1);
    delete (book.assets[ids[0] as string] as Book['assets'][string]).hash;
    const { result } = run(book);
    await expect(result).rejects.toThrow(/has not been hashed/);
  });
});
