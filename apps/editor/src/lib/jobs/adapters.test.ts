import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelJob, resetJobs, useJobsStore } from '../../store/jobs';
import type { AiModelInfo } from '../tauri';

const mocks = vi.hoisted(() => ({
  renderDevelopFull: vi.fn(),
  cancelDevelop: vi.fn(async () => {}),
  runDenoise: vi.fn(),
  cancelDenoise: vi.fn(async () => true),
  developProgress: null as null | ((e: Record<string, unknown>) => void),
  denoiseProgress: null as null | ((e: { job: number; done: number; total: number }) => void),
  unlistenDevelop: vi.fn(),
  unlistenDenoise: vi.fn(),
  /** Resolves the pending listener attach (null: attach at once). */
  attach: null as null | Promise<void>,
}));
vi.mock('../tauri', () => ({
  renderDevelopFull: mocks.renderDevelopFull,
  cancelDevelop: mocks.cancelDevelop,
  runDenoise: mocks.runDenoise,
  cancelDenoise: mocks.cancelDenoise,
  onDevelopProgress: async (handler: (e: Record<string, unknown>) => void) => {
    await mocks.attach;
    mocks.developProgress = handler;
    return mocks.unlistenDevelop;
  },
  onDenoiseProgress: async (handler: (e: { job: number; done: number; total: number }) => void) => {
    await mocks.attach;
    mocks.denoiseProgress = handler;
    return mocks.unlistenDenoise;
  },
}));

const { enqueueRender } = await import('./developRender');
const { denoiseJobKey, enqueueDenoise, MissingModelError } = await import('./denoise');

const settings = (): DevelopSettings => {
  const s = createDevelop();
  s.detail.denoise = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' };
  return s;
};
const item = { assetId: 'a1', relPath: 'IMG_1.jpg', hash: 'h1', settings: createDevelop() };
const job = (id: string) => useJobsStore.getState().jobs[id];

/** A listener attach the test releases with the returned function. */
function holdAttach(): () => void {
  let release: () => void = () => {};
  mocks.attach = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.attach = null;
  mocks.developProgress = null;
  mocks.denoiseProgress = null;
});

describe('enqueueRender', () => {
  it('renders with its own job number, reports progress and stops listening', async () => {
    mocks.renderDevelopFull.mockImplementation(async (_f: string, items: (typeof item)[], n: number) => {
      mocks.developProgress?.({ job: n + 1, assetId: 'other', done: 5, total: 9 }); // another job: ignored
      mocks.developProgress?.({ job: n, assetId: items[0]?.assetId, done: 1, total: 1, path: '/x.jpg' });
      expect(job(handle.id)).toMatchObject({ done: 1, total: 1 });
      return [{ assetId: items[0]?.assetId, path: '/x.jpg' }];
    });
    const handle = enqueueRender({ folder: '/photos', items: [item], label: 'IMG_1.jpg', outputProfile: 'srgb' });
    await expect(handle.result).resolves.toEqual({ state: 'done', value: [{ assetId: 'a1', path: '/x.jpg' }] });
    expect(mocks.renderDevelopFull).toHaveBeenCalledWith('/photos', [item], expect.any(Number), 'srgb');
    expect(mocks.unlistenDevelop).toHaveBeenCalledTimes(1);
  });

  it('cancelled while its listener attaches: never renders, and stops listening', async () => {
    const release = holdAttach();
    const handle = enqueueRender({ folder: '/photos', items: [item], label: 'IMG_1.jpg' });
    cancelJob(handle.id);
    release();
    await expect(handle.result).resolves.toEqual({ state: 'cancelled' });
    expect(mocks.renderDevelopFull).not.toHaveBeenCalled();
    expect(mocks.unlistenDevelop).toHaveBeenCalledTimes(1);
  });

  it('Cancel goes to cancelDevelop; an item reported Cancelled ends the job cancelled', async () => {
    let finish: (r: unknown) => void = () => {};
    mocks.renderDevelopFull.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const handle = enqueueRender({ folder: '/photos', items: [item], label: 'IMG_1.jpg' });
    await vi.waitFor(() => expect(mocks.renderDevelopFull).toHaveBeenCalled());
    cancelJob(handle.id);
    expect(mocks.cancelDevelop).toHaveBeenCalledWith(mocks.renderDevelopFull.mock.calls[0]?.[2]);
    finish([{ assetId: 'a1', error: 'Cancelled' }]);
    await expect(handle.result).resolves.toEqual({ state: 'cancelled' });
  });

  it('fails with the first item error, stopping the batch', async () => {
    mocks.renderDevelopFull.mockImplementation(async (_f: string, items: (typeof item)[], n: number) => {
      mocks.developProgress?.({ job: n, assetId: 'a1', done: 1, total: 2, error: 'cannot decode' });
      return [
        { assetId: 'a1', error: 'cannot decode' },
        { assetId: items[1]?.assetId, error: 'Cancelled' },
      ];
    });
    const handle = enqueueRender({ folder: '/photos', items: [item, { ...item, assetId: 'a2' }], label: 'two' });
    await expect(handle.result).resolves.toMatchObject({ state: 'failed', error: 'cannot decode' });
    expect(mocks.cancelDevelop).toHaveBeenCalledTimes(1);
    expect(mocks.unlistenDevelop).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueDenoise', () => {
  const options = () => ({
    folder: '/photos',
    relPath: 'IMG_1.jpg',
    hash: 'h1',
    settings: settings(),
    label: 'IMG_1.jpg',
  });

  it('reports tiles, resolves the result and stops listening', async () => {
    mocks.runDenoise.mockImplementation(async (_f, _r, _h, _s, n: number) => {
      mocks.denoiseProgress?.({ job: n, done: 40, total: 117 });
      expect(job(handle.id)).toMatchObject({ done: 40, total: 117, detail: 'tile 40/117' });
      return { status: 'done', key: 'k', path: '/d.png', width: 1, height: 1, elapsedMs: 5, engine: 'CPU', tiles: 117 };
    });
    const handle = enqueueDenoise(options());
    await expect(handle.result).resolves.toMatchObject({ state: 'done', value: { key: 'k', tiles: 117 } });
    expect(mocks.unlistenDenoise).toHaveBeenCalledTimes(1);
  });

  it('cancelled while its listener attaches: never runs, and stops listening', async () => {
    const release = holdAttach();
    const handle = enqueueDenoise(options());
    cancelJob(handle.id);
    release();
    await expect(handle.result).resolves.toEqual({ state: 'cancelled' });
    expect(mocks.runDenoise).not.toHaveBeenCalled();
    expect(mocks.unlistenDenoise).toHaveBeenCalledTimes(1);
  });

  it('Cancel goes to cancelDenoise and a cancelled run ends the job cancelled', async () => {
    let finish: (r: unknown) => void = () => {};
    mocks.runDenoise.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const handle = enqueueDenoise(options());
    await vi.waitFor(() => expect(mocks.runDenoise).toHaveBeenCalled());
    cancelJob(handle.id);
    expect(mocks.cancelDenoise).toHaveBeenCalledWith(mocks.runDenoise.mock.calls[0]?.[4]);
    finish({ status: 'cancelled' });
    await expect(handle.result).resolves.toEqual({ state: 'cancelled' });
    expect(mocks.unlistenDenoise).toHaveBeenCalledTimes(1);
  });

  it('fails with MissingModelError when the model is not downloaded', async () => {
    const model: AiModelInfo = {
      name: 'nafnet-sidd-width32',
      title: 'NAFNet (w32)',
      version: '1',
      bytes: 117_115_760,
      licence: 'MIT',
      licenceUrl: 'https://example.test',
      status: { state: 'missing' },
    };
    mocks.runDenoise.mockResolvedValue({ status: 'missingModel', model });
    const outcome = await enqueueDenoise(options()).result;
    expect(outcome).toMatchObject({ state: 'failed', error: expect.stringMatching(/NAFNet \(w32\).*117 MB/) });
    expect(outcome.state === 'failed' && outcome.cause instanceof MissingModelError).toBe(true);
  });

  it('joins a run of the same bytes and settings, not of other settings', () => {
    mocks.runDenoise.mockImplementation(() => new Promise(() => {}));
    const first = enqueueDenoise(options());
    expect(enqueueDenoise(options())).toMatchObject({ id: first.id, created: false });
    const other = settings();
    if (other.detail.denoise) other.detail.denoise.luminance = 60;
    expect(denoiseJobKey('h1', other)).not.toBe(denoiseJobKey('h1', settings()));
    expect(enqueueDenoise({ ...options(), settings: other }).created).toBe(true);
  });

  it('keys on the colour mode, and on Colour only with the model colour (plan 28)', () => {
    const keyWith = (patch: Partial<NonNullable<DevelopSettings['detail']['denoise']>>) => {
      const s = settings();
      if (s.detail.denoise) Object.assign(s.detail.denoise, patch);
      return denoiseJobKey('h1', s);
    };
    // The filter's colour is applied at render time: Colour is not part of the run.
    expect(keyWith({ chroma: 10 })).toBe(denoiseJobKey('h1', settings()));
    expect(keyWith({ chromaMode: 'model' })).not.toBe(denoiseJobKey('h1', settings()));
    expect(keyWith({ chromaMode: 'model', chroma: 10 })).not.toBe(keyWith({ chromaMode: 'model' }));
    expect(keyWith({ sharpen: 30 })).not.toBe(denoiseJobKey('h1', settings()));
  });
});
