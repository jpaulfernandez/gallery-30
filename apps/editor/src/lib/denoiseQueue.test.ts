// @vitest-environment jsdom
import { type Book, createDevelop, createEmptyBook, emptyLibrary } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usedAssetIds } from '../components/filmstrip/visible';
import { useBookStore } from '../store/book';
import { DEFAULT_DENOISE_PREFS, estimateDenoiseMs, useDenoisePrefs } from '../store/denoisePrefs';
import { cancelJob, cancelProjectJobs, enqueue, type JobState, resetJobs, useJobsStore } from '../store/jobs';
import { assetDevelop, useLibraryStore } from '../store/library';
import { seedFiles } from '../store/testing';
import { useUiStore } from '../store/ui';
import type { AiModelInfo, DenoiseStatus, NoiseProfile } from './tauri';

const mocks = vi.hoisted(() => ({
  denoiseStatus: vi.fn(),
  runDenoise: vi.fn(),
  cancelDenoise: vi.fn(async (_job: number) => true),
  noiseProfile: vi.fn(),
  /** Hashes whose intermediate is on disk. */
  ready: new Set<string>(),
  /** Pending runs by job number, resolved by the test. */
  runs: new Map<number, (outcome: unknown) => void>(),
}));
vi.mock('./tauri', () => ({
  denoiseStatus: mocks.denoiseStatus,
  runDenoise: mocks.runDenoise,
  cancelDenoise: mocks.cancelDenoise,
  noiseProfile: mocks.noiseProfile,
  developRendersPresent: async () => [],
  onDenoiseProgress: async () => () => {},
  renderDevelopCached: vi.fn(),
  fileUrl: (path: string) => `asset://localhost${path}`,
}));
vi.mock('../store/assets', async (original) => ({
  ...(await original<typeof import('../store/assets')>()),
  refreshDeveloped: vi.fn(async () => {}),
}));

const {
  enqueueDenoiseBatch,
  forgetBatchNoiseProfiles,
  planDenoiseBatch,
  queueDenoiseIfStale,
  denoiseSignature,
  useQueueDenoiseOnLeave,
  markNeedsApply,
  dismissNeedsApply,
  shownNeedsApply,
  PlanAborted,
  startDenoiseBatch,
} = await import('./denoiseQueue');
const { enqueueDenoise } = await import('./jobs/denoise');
const { pendingDenoiseCount } = await import('./denoiseQueue');
const { denoiseBeforePublish } = await import('./developPublish');

const FOLDER = '/photos';
const IDS = Array.from({ length: 10 }, (_, i) => `A${i}`);

const model: AiModelInfo = {
  name: 'nafnet-sidd-width32',
  title: 'NAFNet (w32)',
  version: '1',
  bytes: 117_115_760,
  licence: 'MIT',
  licenceUrl: 'https://example.test/licence',
  status: { state: 'installed' },
};

const profile = (sigma: number): NoiseProfile =>
  ({
    source: 'processed',
    iso: 6400,
    measured: { sigma, confidence: 0.9 },
    learned: null,
    learn: null,
    photos: 1,
    channels: [],
    sigma,
    confidence: 0.9,
  }) as unknown as NoiseProfile;

const denoiseOn = () => {
  const develop = createDevelop();
  develop.detail.denoise = { model: 'scunet', luminance: 30, chroma: 55, sharpen: 25, chromaMode: 'filter' };
  return develop;
};

function seedBook(withDenoise: readonly string[] = []): void {
  const doc = createEmptyBook({ title: 'Trip', folders: { F: { path: FOLDER } } });
  doc.assets = Object.fromEntries(
    IDS.map((id, i) => [
      id,
      {
        path: `p${i}.jpg`,
        folder: 'F',
        hash: `h${i}`,
        size: 7,
        mtime: 1,
        width: 6000,
        height: 4000,
        ...(withDenoise.includes(id) ? { develop: denoiseOn() } : {}),
      },
    ]),
  );
  useBookStore.setState({ book: doc, folder: FOLDER, projectId: 'P', libraries: { [FOLDER]: emptyLibrary() } });
  useBookStore.temporal.getState().clear();
  seedFiles(
    Object.fromEntries(
      IDS.map((id, i) => [
        `p${i}.jpg`,
        {
          relPath: `p${i}.jpg`,
          assetId: id,
          size: 7,
          mtime: 1,
          kind: 'jpeg',
          hash: `h${i}`,
          iso: 6400,
          status: 'ready',
        },
      ]),
    ) as Parameters<typeof seedFiles>[0],
  );
}

const states = (): JobState[] => Object.values(useJobsStore.getState().jobs).map((j) => j.state);
const count = (state: JobState) => states().filter((s) => s === state).length;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  forgetBatchNoiseProfiles();
  mocks.ready.clear();
  mocks.runs.clear();
  useDenoisePrefs.setState({ ...DEFAULT_DENOISE_PREFS, timing: {} });
  mocks.denoiseStatus.mockImplementation(
    async (hash: string, settings: ReturnType<typeof createDevelop>): Promise<DenoiseStatus> => {
      const d = settings.detail.denoise;
      return { key: d ? `${hash}-${d.model}-${d.luminance}` : null, ready: mocks.ready.has(hash), bytes: 0, model };
    },
  );
  mocks.runDenoise.mockImplementation(
    (_f: string, _p: string, hash: string, _s: unknown, job: number) =>
      new Promise((resolve) => {
        mocks.runs.set(job, (outcome) =>
          resolve(
            outcome ?? {
              status: 'done',
              key: `k-${hash}`,
              path: '/x.png',
              width: 6000,
              height: 4000,
              elapsedMs: 9600,
              engine: 'CPU',
              tiles: 96,
            },
          ),
        );
      }),
  );
  mocks.cancelDenoise.mockImplementation(async (job: number) => {
    mocks.runs.get(job)?.({ status: 'cancelled' });
    mocks.runs.delete(job);
    return true;
  });
  mocks.noiseProfile.mockImplementation(async () => profile(0.18 * 0.02));
  seedBook();
});

afterEach(async () => {
  for (const id of Object.keys(useJobsStore.getState().jobs)) cancelJob(id);
  await useBookStore.getState().close();
});

describe('Denoise selected (enqueueDenoiseBatch)', () => {
  it('queues one job per photo, runs them one at a time, and cancelling one leaves the others', async () => {
    const { plan, handles } = await enqueueDenoiseBatch(IDS);
    expect(plan.todo).toHaveLength(10);
    expect(handles).toHaveLength(10);
    expect(new Set(handles.map((h) => h.id)).size).toBe(10);
    await tick();
    expect(count('running')).toBe(1);
    expect(count('queued')).toBe(9);

    // Cancel a queued one: it never starts; the others are untouched.
    const victim = handles[4]?.id as string;
    cancelJob(victim);
    expect(useJobsStore.getState().jobs[victim]?.state).toBe('cancelled');
    expect(count('queued')).toBe(8);

    // Finish the rest one by one: only one runs at any time.
    for (let i = 0; i < 9; i++) {
      await tick();
      expect(count('running')).toBe(1);
      const [job, finish] = [...mocks.runs.entries()].at(-1) ?? [];
      mocks.runs.delete(job as number);
      finish?.(undefined);
      await tick();
    }
    await tick();
    expect(count('done')).toBe(9);
    expect(count('cancelled')).toBe(1);
    expect(mocks.runDenoise).toHaveBeenCalledTimes(9);
  });

  it('switches denoise on with the Settings model and the suggested amount, as one undo step, measuring first', async () => {
    useDenoisePrefs.getState().set({ model: 'scunet' });
    const { handles } = await enqueueDenoiseBatch(['A0', 'A1']);
    expect(handles).toHaveLength(2);
    expect(mocks.noiseProfile).toHaveBeenCalledTimes(2);
    const d = assetDevelop(useBookStore.getState(), 'A0')?.detail.denoise;
    expect(d?.model).toBe('scunet');
    // σ 2 % of mid-grey (processed) suggests about 46: Luminance at the suggestion, Chroma 25 above.
    expect(d?.luminance).toBeGreaterThan(30);
    expect(d?.chroma).toBe((d?.luminance ?? 0) + 25);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    // The run uses the settings as written.
    expect(mocks.runDenoise.mock.calls[0]?.[3].detail.denoise).toEqual(d);
  });

  it('keeps the settings of photos that already have denoise on and does not measure them', async () => {
    seedBook(['A0']);
    await enqueueDenoiseBatch(['A0']);
    expect(mocks.noiseProfile).not.toHaveBeenCalled();
    expect(assetDevelop(useBookStore.getState(), 'A0')?.detail.denoise?.model).toBe('scunet');
  });

  it('skips photos already denoised; Shift (force) runs them again', async () => {
    mocks.ready.add('h0');
    mocks.ready.add('h1');
    const plain = await enqueueDenoiseBatch(IDS.slice(0, 4));
    expect(plain.plan.skipped).toBe(2);
    expect(plain.handles).toHaveLength(2);
    for (const h of plain.handles) cancelJob(h.id);
    await tick();

    const forced = await enqueueDenoiseBatch(IDS.slice(0, 4), { force: true });
    expect(forced.plan.skipped).toBe(0);
    expect(forced.handles).toHaveLength(4);
    await tick();
    // The forced run asks Rust to replace the intermediate.
    expect(mocks.runDenoise.mock.calls.at(-1)?.[5]).toBe(true);
  });

  it('counts photos already queued apart; photos whose model is missing are left out, the others queued', async () => {
    await enqueueDenoiseBatch(['A0']);
    const again = await planDenoiseBatch(['A0', 'A1']);
    expect(again.queued).toBe(1);
    expect(again.todo.map((i) => i.id)).toEqual(['A1']);

    // A2 already uses SCUNet (not downloaded); A3 is switched on with NAFNet (installed).
    seedBook(['A2']);
    resetJobs();
    mocks.denoiseStatus.mockImplementation(async (hash: string, settings: ReturnType<typeof createDevelop>) => ({
      key: `${hash}-k`,
      ready: mocks.ready.has(hash),
      bytes: 0,
      model: settings.detail.denoise?.model === 'scunet' ? { ...model, status: { state: 'missing' } } : model,
    }));
    const mixed = await enqueueDenoiseBatch(['A2', 'A3']);
    expect(mixed.plan.missingModel?.title).toBe('NAFNet (w32)');
    expect(mixed.plan.blocked).toBe(1);
    expect(mixed.plan.todo.map((i) => i.id)).toEqual(['A3']);
    expect(mixed.handles).toHaveLength(1);
    // A model missing only for a photo already denoised blocks nothing.
    mocks.ready.add('h2');
    expect((await planDenoiseBatch(['A2'])).missingModel).toBeNull();
  });

  it('closing the confirm aborts the plan: no further photos are measured', async () => {
    const controller = new AbortController();
    let calls = 0;
    mocks.noiseProfile.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return profile(0.18 * 0.02);
    });
    await expect(planDenoiseBatch(IDS, { signal: controller.signal })).rejects.toBeInstanceOf(PlanAborted);
    // Two measurements run at once; none starts after the abort.
    expect(mocks.noiseProfile.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mocks.denoiseStatus).not.toHaveBeenCalled();
  });

  it('a stale plan never overwrites settings the user switched on meanwhile', async () => {
    const plan = await planDenoiseBatch(['A0', 'A1']);
    useBookStore.getState().setDenoise('A0', { model: 'scunet', luminance: 12 });
    startDenoiseBatch(plan);
    expect(assetDevelop(useBookStore.getState(), 'A0')?.detail.denoise).toMatchObject({
      model: 'scunet',
      luminance: 12,
    });
    expect(assetDevelop(useBookStore.getState(), 'A1')?.detail.denoise?.model).toBe('nafnet-w32');
    await tick();
    // A0 runs with the user's settings.
    const a0 = mocks.runDenoise.mock.calls.find((c) => c[2] === 'h0');
    expect(a0?.[3].detail.denoise).toMatchObject({ model: 'scunet', luminance: 12 });
  });

  it('closing the project cancels its batch', async () => {
    const { handles } = await enqueueDenoiseBatch(IDS.slice(0, 3));
    await tick();
    expect(cancelProjectJobs('P')).toBe(3);
    await tick();
    for (const h of handles) expect(useJobsStore.getState().jobs[h.id]?.state).toBe('cancelled');
  });

  it('a forced run is not joined to a plain run of the same settings', async () => {
    const first = await enqueueDenoiseBatch(['A0']);
    const forced = await enqueueDenoiseBatch(['A1', 'A0'], { force: true });
    // A0 is already queued (counted apart), A1 queued with force.
    expect(forced.plan.queued).toBe(1);
    const settings = assetDevelop(useBookStore.getState(), 'A0');
    const plain = enqueueDenoise({
      folder: FOLDER,
      relPath: 'p0.jpg',
      hash: 'h0',
      settings: settings as never,
      label: 'x',
    });
    expect(plain.id).toBe(first.handles[0]?.id);
    const again = enqueueDenoise({
      folder: FOLDER,
      relPath: 'p0.jpg',
      hash: 'h0',
      settings: settings as never,
      label: 'x',
      force: true,
    });
    expect(again.created).toBe(true);
  });

  it('estimates from the last run: per-tile timing × tiles', async () => {
    expect((await planDenoiseBatch(['A0'])).estimateMs).toBeNull();
    useDenoisePrefs.getState().recordTiming('nafnet-w32', { elapsedMs: 9600, tiles: 96, width: 6000, height: 4000 });
    const plan = await planDenoiseBatch(['A0', 'A1']);
    // 96 tiles of 100 ms for each 24 MP photo.
    expect(plan.estimateMs).toBeCloseTo(2 * 9600);
    expect(estimateDenoiseMs({ msPerTile: 100, tilesPerMp: 4 }, 3000, 2000)).toBe(2400);
  });

  it('a finished run records its per-tile timing', async () => {
    const { handles } = await enqueueDenoiseBatch(['A0']);
    await tick();
    for (const finish of mocks.runs.values()) finish(undefined);
    await handles[0]?.result;
    expect(useDenoisePrefs.getState().timing['nafnet-w32']).toEqual({ msPerTile: 100, tilesPerMp: 4 });
  });
});

describe('queueDenoiseIfStale (leaving a photo in Develop)', () => {
  it('queues the run when the denoise settings changed since arriving, and not otherwise', async () => {
    seedBook(['A0']);
    const since = denoiseSignature('A0');
    expect(await queueDenoiseIfStale('A0', { since })).toBeNull();
    useBookStore.getState().setDenoise('A0', { luminance: 70 });
    const handle = await queueDenoiseIfStale('A0', { since });
    expect(handle?.created).toBe(true);
    expect(useJobsStore.getState().jobs[handle?.id as string]).toMatchObject({ kind: 'denoise', ref: 'A0' });
  });

  it('useQueueDenoiseOnLeave: stepping to another photo after changing denoise queues the one left', async () => {
    seedBook(['A0', 'A1']);
    const { rerender, unmount } = renderHook(({ id }) => useQueueDenoiseOnLeave(id), { initialProps: { id: 'A0' } });
    useBookStore.getState().setDenoise('A0', { luminance: 80 });
    rerender({ id: 'A1' });
    await vi.waitFor(() => expect(Object.values(useJobsStore.getState().jobs).map((j) => j.ref)).toEqual(['A0']));
    // Leaving A1 untouched (closing the view) queues nothing more.
    unmount();
    await tick();
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(1);
  });

  it('useQueueDenoiseOnLeave: a library loading after the photo is shown is not an edit', async () => {
    seedBook(['A0']);
    const loaded = useBookStore.getState().libraries;
    useBookStore.setState({ libraries: {} });
    const { unmount } = renderHook(() => useQueueDenoiseOnLeave('A0'));
    // The library arrives with other settings for the photo (as `loadLibrary` reconciles them).
    const book = structuredClone(useBookStore.getState().book) as Book;
    const develop = denoiseOn();
    if (develop.detail.denoise) develop.detail.denoise.luminance = 90;
    (book.assets.A0 as Book['assets'][string]).develop = develop;
    useBookStore.setState({ libraries: loaded, book });
    unmount();
    await tick();
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(0);
  });

  it('useQueueDenoiseOnLeave: leaving a photo that read "Needs apply" queues it without any edit (plan 28)', async () => {
    seedBook(['A0', 'A1']);
    const { rerender, unmount } = renderHook(({ id }) => useQueueDenoiseOnLeave(id), { initialProps: { id: 'A0' } });
    markNeedsApply('A0', true);
    rerender({ id: 'A1' });
    await vi.waitFor(() => expect(Object.values(useJobsStore.getState().jobs).map((j) => j.ref)).toEqual(['A0']));
    expect(shownNeedsApply('A0')).toBe(false);
    // A1 was never shown as needing apply, nor edited: leaving it queues nothing.
    markNeedsApply('A1', false);
    unmount();
    await tick();
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(1);
  });

  it('useQueueDenoiseOnLeave: a cancelled run is not queued again on leave until its settings change', async () => {
    seedBook(['A0', 'A1']);
    const { rerender } = renderHook(({ id }) => useQueueDenoiseOnLeave(id), { initialProps: { id: 'A0' } });
    useBookStore.getState().setDenoise('A0', { luminance: 80 });
    markNeedsApply('A0', true);
    dismissNeedsApply('A0');
    markNeedsApply('A0', true);
    expect(shownNeedsApply('A0')).toBe(false);
    rerender({ id: 'A1' });
    await tick();
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(0);
    // Changed settings count again.
    rerender({ id: 'A0' });
    useBookStore.getState().setDenoise('A0', { luminance: 60 });
    markNeedsApply('A0', true);
    expect(shownNeedsApply('A0')).toBe(true);
    rerender({ id: 'A1' });
    await vi.waitFor(() => expect(Object.values(useJobsStore.getState().jobs).map((j) => j.ref)).toEqual(['A0']));
  });

  it('useQueueDenoiseOnLeave: a photo whose run failed is not retried on leave', async () => {
    seedBook(['A0', 'A1']);
    const { rerender } = renderHook(({ id }) => useQueueDenoiseOnLeave(id), { initialProps: { id: 'A0' } });
    useBookStore.getState().setDenoise('A0', { luminance: 80 });
    markNeedsApply('A0', true);
    useUiStore.getState().updateDenoise((d) => ({ errors: { ...d.errors, A0: 'decode failed' } }));
    rerender({ id: 'A1' });
    await tick();
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(0);
    useUiStore.getState().updateDenoise(() => ({ errors: {} }));
  });

  it('does nothing when denoise is off, the intermediate is there, or a run is queued', async () => {
    expect(await queueDenoiseIfStale('A1')).toBeNull();
    seedBook(['A0', 'A1']);
    mocks.ready.add('h1');
    expect(await queueDenoiseIfStale('A1')).toBeNull();
    expect(await queueDenoiseIfStale('A0')).not.toBeNull();
    expect(await queueDenoiseIfStale('A0')).toBeNull();
  });
});

describe('publish and the queue', () => {
  function bookWithDenoise(): { book: Book; ids: string[] } {
    const book = structuredClone(fixtureBook);
    const ids = [...usedAssetIds(book.pages)].slice(0, 2);
    ids.forEach((id, i) => {
      const asset = book.assets[id] as Book['assets'][string];
      asset.hash = `pub-${i}`;
      asset.develop = denoiseOn();
    });
    return { book, ids };
  }

  it('counts the denoise jobs of the book’s used photos for the dialog line', () => {
    const { book, ids } = bookWithDenoise();
    const never = () => new Promise<never>(() => {});
    enqueue({ kind: 'denoise', label: 'a', ref: ids[0], run: never });
    enqueue({ kind: 'denoise', label: 'b', ref: ids[1], run: never });
    enqueue({ kind: 'denoise', label: 'c', ref: 'not-in-the-book', run: never });
    enqueue({ kind: 'render', label: 'd', ref: ids[0], run: never });
    expect(pendingDenoiseCount(useJobsStore.getState(), book)).toBe(2);
    expect(pendingDenoiseCount(useJobsStore.getState(), null)).toBe(0);
  });

  it('a library photo’s job (library key) counts for, and is joined by, the project asset of the same file', async () => {
    const { book, ids } = bookWithDenoise();
    const asset = book.assets[ids[0] as string] as Book['assets'][string];
    useBookStore.setState({ book, folder: '/fixture', projectId: 'P' });
    useLibraryStore.setState({
      folders: {
        lib: {
          id: 'lib',
          path: '/fixture',
          progress: { hashed: 0, prepared: 0, total: 0 },
          busy: false,
          error: null,
          scanned: true,
          photos: {
            [asset.path]: { relPath: asset.path, size: 1, mtime: 1, kind: 'jpeg', hash: 'pub-0', status: 'ready' },
          },
        },
      },
    });
    const key = `lib/${asset.path}`;
    const libraryJob = enqueueDenoise({
      folder: '/fixture',
      relPath: asset.path,
      hash: 'pub-0',
      settings: asset.develop as never,
      label: 'library',
      ref: key,
    });
    expect(pendingDenoiseCount(useJobsStore.getState(), book)).toBe(1);
    // The project's Apply (asset id) of the same bytes and settings joins it.
    const fromProject = enqueueDenoise({
      folder: '/fixture',
      relPath: asset.path,
      hash: 'pub-0',
      settings: asset.develop as never,
      label: 'project',
      ref: ids[0],
      project: 'P',
    });
    expect(fromProject).toMatchObject({ id: libraryJob.id, created: false });
  });

  it('a publish joins the jobs Denoise selected queued instead of queueing its own', async () => {
    const { book, ids } = bookWithDenoise();
    useBookStore.setState({ book, folder: '/fixture', projectId: 'P' });
    const { handles } = await enqueueDenoiseBatch(ids);
    expect(handles).toHaveLength(2);
    const before = Object.keys(useJobsStore.getState().jobs).length;
    const seen: string[][] = [];
    const gate = denoiseBeforePublish({
      folder: '/fixture',
      book,
      onEvent: () => {},
      project: 'P',
      onJobs: (jobIds) => seen.push(jobIds),
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(Object.keys(useJobsStore.getState().jobs)).toHaveLength(before);
    expect(seen[0]).toEqual(handles.map((h) => h.id));
    for (let i = 0; i < 2; i++) {
      await tick();
      for (const [job, finish] of [...mocks.runs.entries()]) {
        mocks.runs.delete(job);
        finish(undefined);
      }
      await tick();
    }
    await expect(gate).resolves.toBe('done');
  });
});
