// @vitest-environment jsdom
import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelInfo, DenoiseOutcome, DenoiseStatus, NoiseProfile } from '../../lib/tauri';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { useDenoisePrefs } from '../../store/denoisePrefs';
import { activeJobFor, resetJobs, useJobsStore } from '../../store/jobs';
import { DENOISE_UI_INITIAL, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  crop: vi.fn(),
  download: vi.fn(),
  cancelDownload: vi.fn(),
  denoiseProgress: null as null | ((e: { job: number; done: number; total: number }) => void),
  modelProgress: null as null | ((e: { job: number; name: string; received: number; total: number }) => void),
  render: vi.fn(),
  noise: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  denoiseStatus: mocks.status,
  runDenoise: mocks.run,
  cancelDenoise: mocks.cancel,
  previewDenoiseCrop: mocks.crop,
  downloadModel: mocks.download,
  cancelModelDownload: mocks.cancelDownload,
  onDenoiseProgress: async (handler: typeof mocks.denoiseProgress) => {
    mocks.denoiseProgress = handler;
    return () => {};
  },
  onModelProgress: async (handler: typeof mocks.modelProgress) => {
    mocks.modelProgress = handler;
    return () => {};
  },
  renderDevelopCached: vi.fn(),
  noiseProfile: mocks.noise,
}));

import { shownNeedsApply } from '../../lib/denoiseQueue';
import { enqueueDenoise } from '../../lib/jobs/denoise';
import { DenoiseGroup, forgetNoiseProfiles } from './DenoiseGroup';
import { forgetDenoiseStatusRequests } from './useDenoise';

const model = (state: 'installed' | 'missing' | 'partial' = 'installed'): AiModelInfo => ({
  name: 'nafnet-sidd-width32',
  title: 'NAFNet (w32)',
  version: '1',
  bytes: 117_115_760,
  licence: 'MIT',
  licenceUrl: 'https://example.test/licence',
  status: state === 'partial' ? { state, bytes: 1_000_000 } : { state },
});
const status = (over: Partial<DenoiseStatus> = {}): DenoiseStatus => ({
  key: 'key-1',
  ready: false,
  bytes: 0,
  model: model(),
  ...over,
});

const book = () => useBookStore.getState();
const denoise = () => book().book?.assets.f1?.develop?.detail.denoise ?? null;
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const slider = (name: string) => screen.getByRole('slider', { name });
const rect = (el: HTMLElement) => {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 16, right: 200, bottom: 16 }) as DOMRect;
};

function Harness() {
  const settings = useBookStore((s) => s.book?.assets.f1?.develop) ?? createDevelop();
  return <DenoiseGroup assetId="f1" settings={settings} />;
}

function turnOn(patch: Partial<NonNullable<ReturnType<typeof denoise>>> = {}) {
  act(() => book().setDenoise('f1', patch));
}

const file: AssetFile = {
  relPath: 'fixture/f1.jpg',
  assetId: 'f1',
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: 'hash-f1',
  status: 'ready',
  proxyUrl: 'asset://proxy/f1.jpg',
  thumbUrl: 'asset://thumb/f1.jpg',
};

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:crop-${++n}`);
  URL.revokeObjectURL = vi.fn();
  for (const m of [
    mocks.status,
    mocks.run,
    mocks.cancel,
    mocks.crop,
    mocks.download,
    mocks.cancelDownload,
    mocks.render,
    mocks.noise,
  ]) {
    m.mockReset();
  }
  forgetNoiseProfiles();
  forgetDenoiseStatusRequests();
  mocks.noise.mockRejectedValue('no profile');
  mocks.denoiseProgress = null;
  mocks.modelProgress = null;
  resetJobs();
  mocks.status.mockResolvedValue(status());
  mocks.cancel.mockResolvedValue(true);
  mocks.cancelDownload.mockResolvedValue(true);
  mocks.crop.mockImplementation(async () => jpeg());
  mocks.render.mockResolvedValue(undefined);
  const doc = structuredClone(fixtureBook);
  const f1 = doc.assets.f1;
  if (f1) f1.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file }, renderDeveloped: mocks.render });
  useUiStore.setState({ denoise: DENOISE_UI_INITIAL });
  useDenoisePrefs.setState({ model: 'nafnet-w32', timing: {} });
});

afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

const pill = () => screen.queryByTestId('denoise-pill')?.textContent ?? null;
const statusText = () => screen.getByTestId('denoise-status').textContent;
const advanced = () => within(screen.getByTestId('denoise-advanced'));

describe('DenoiseGroup switch and Amount (plan 28)', () => {
  it('is off by default: only the switch and the badge, no Amount, no pill, no status call', () => {
    render(<Harness />);
    expect(screen.getByRole('switch', { name: 'Denoise' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('slider', { name: 'Amount' })).toBeNull();
    expect(pill()).toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("turns on with the mapping, Settings → Models' model and the loupe open, and off again, one undo step each", () => {
    act(() => useDenoisePrefs.setState({ model: 'scunet' }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('switch', { name: 'Denoise' }));
    expect(denoise()).toEqual({ model: 'scunet', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' });
    expect(useUiStore.getState().denoise.previewOpen).toBe(true);
    expect(slider('Amount').getAttribute('aria-valuenow')).toBe('50');

    fireEvent.click(screen.getByRole('switch', { name: 'Denoise' }));
    expect(denoise()).toBeNull();
    // Off with nothing else edited is the untouched photo again.
    expect(book().book?.assets.f1?.develop).toBeUndefined();

    act(() => undo());
    expect(denoise()).not.toBeNull();
    act(() => undo());
    expect(book().book?.assets.f1?.develop).toBeUndefined();
  });

  it('Amount sets Luminance and Colour follows it (min(100, amount + 25)); Sharpen stays; a drag is one undo step', () => {
    turnOn();
    useBookStore.temporal.getState().clear();
    render(<Harness />);
    const track = slider('Amount');
    rect(track);
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0 });
    for (const x of [120, 160, 180]) fireEvent.pointerMove(track, { pointerId: 1, clientX: x });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 180 });
    expect(denoise()).toMatchObject({ luminance: 90, chroma: 100, sharpen: 25 });
    act(() => undo());
    expect(denoise()).toMatchObject({ luminance: 50, chroma: 75 });

    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight', shiftKey: true });
    expect(denoise()).toMatchObject({ luminance: 60, chroma: 85, sharpen: 25 });
    // Advanced shows the same values; its Luminance is the Amount itself.
    expect(screen.getByTestId('denoise-advanced-summary').textContent).toBe(
      'Luminance 60 · Colour 85 · Sharpen 25 · NAFNet · Colour: filter',
    );
    fireEvent.keyDown(advanced().getByRole('slider', { name: 'Luminance' }), { key: 'ArrowLeft', shiftKey: true });
    expect(denoise()).toMatchObject({ luminance: 50, chroma: 75 });
    expect(slider('Amount').getAttribute('aria-valuenow')).toBe('50');
  });

  it('keeps Advanced values once touched when Amount moves, and Reset returns to the mapping', () => {
    act(() => useDenoisePrefs.setState({ model: 'nafnet-w32' }));
    turnOn();
    render(<Harness />);
    const reset = () => advanced().getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset().disabled).toBe(true);

    fireEvent.keyDown(advanced().getByRole('slider', { name: 'Colour' }), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(advanced().getByRole('slider', { name: 'Sharpen' }), { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(within(screen.getByRole('group', { name: 'Colour source' })).getByRole('radio', { name: 'Model' }));
    fireEvent.change(advanced().getByRole('combobox', { name: 'Denoise model' }), { target: { value: 'scunet' } });
    expect(denoise()).toEqual({ model: 'scunet', luminance: 50, chroma: 65, sharpen: 35, chromaMode: 'model' });
    expect(reset().disabled).toBe(false);

    // Amount moves Luminance only now.
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight', shiftKey: true });
    expect(denoise()).toEqual({ model: 'scunet', luminance: 70, chroma: 65, sharpen: 35, chromaMode: 'model' });

    fireEvent.click(reset());
    expect(denoise()).toEqual({ model: 'nafnet-w32', luminance: 70, chroma: 95, sharpen: 25, chromaMode: 'filter' });
    expect(reset().disabled).toBe(true);
    // Following again.
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowLeft', shiftKey: true });
    expect(denoise()).toMatchObject({ luminance: 60, chroma: 85 });
  });

  it("marks Settings → Models' model as the default and lists a hand-edited w64 as unavailable", () => {
    act(() => useDenoisePrefs.setState({ model: 'nafnet-w32' }));
    turnOn({ model: 'nafnet-w64' });
    render(<Harness />);
    const select = advanced().getByRole('combobox', { name: 'Denoise model' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'NAFNet (default)',
      'SCUNet',
      'nafnet-w64 (not available yet)',
    ]);
    expect(select.value).toBe('nafnet-w64');
  });

  it('double-clicking Amount returns it to the suggestion (the defaults when nothing is known)', () => {
    turnOn({ luminance: 80, chroma: 100 });
    render(<Harness />);
    fireEvent.doubleClick(slider('Amount'));
    expect(denoise()).toMatchObject({ luminance: 50, chroma: 75 });
  });
});

describe('DenoiseGroup pill and Apply (plan 28)', () => {
  it('reads "Needs apply" with no intermediate, says the run happens on leaving, and marks the photo', async () => {
    turnOn();
    render(<Harness />);
    await waitFor(() => expect(pill()).toBe('Needs apply'));
    expect(statusText()).toMatch(/Runs in the background when you move on to another photo/);
    expect(mocks.status).toHaveBeenCalledWith('hash-f1', expect.objectContaining({}));
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
    expect(shownNeedsApply('f1')).toBe(true);
  });

  it("shows the estimate from the model's last run on Apply", async () => {
    act(() => useDenoisePrefs.setState({ timing: { 'nafnet-w32': { msPerTile: 1000, tilesPerMp: 10 } } }));
    turnOn();
    render(<Harness />);
    // 1200 × 800 = 0.96 MP → 10 tiles → 10 s.
    expect(await screen.findByRole('button', { name: 'Apply · ~10 s' })).toBeTruthy();
  });

  it('reads "Applied" with this session\'s time, disables Apply and unmarks the photo', async () => {
    turnOn();
    mocks.status.mockResolvedValue(status({ ready: true, bytes: 10 }));
    act(() =>
      useUiStore
        .getState()
        .updateDenoise((d) => ({ runs: { ...d.runs, f1: { key: 'key-1', elapsedMs: 13_800, engine: 'CoreML' } } })),
    );
    render(<Harness />);
    await waitFor(() => expect(pill()).toBe('Applied'));
    expect(statusText()).toBe('Denoised at full size in 13.8 s.');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    expect(shownNeedsApply('f1')).toBe(false);
  });

  it('stays "Applied" while Colour moves with the chroma filter, and needs apply again when Amount moves', async () => {
    turnOn();
    mocks.status.mockResolvedValue(status({ ready: true }));
    render(<Harness />);
    await waitFor(() => expect(pill()).toBe('Applied'));
    // The next answers never come: the pill rests on what the photo's last answer says about the same run.
    mocks.status.mockImplementation(() => new Promise(() => {}));
    fireEvent.keyDown(advanced().getByRole('slider', { name: 'Colour' }), { key: 'ArrowLeft' });
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(pill()).toBe('Applied');
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight' });
    await waitFor(() => expect(pill()).toBe('Needs apply'));
  });

  it('refetches the status when a setting changes', async () => {
    turnOn();
    render(<Harness />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(advanced().getByRole('slider', { name: 'Sharpen' }), { key: 'ArrowRight' });
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(mocks.status.mock.calls[1]?.[1].detail.denoise.sharpen).toBe(26);
  });
});

describe('DenoiseGroup model download', () => {
  it('shows the first-run card with the size and licence and one Download button instead of Apply', async () => {
    turnOn();
    mocks.status.mockResolvedValue(status({ model: model('missing') }));
    render(<Harness />);
    await waitFor(() => expect(pill()).toBe('Needs model'));
    const card = within(screen.getByTestId('denoise-download'));
    expect(card.getByText('NAFNet (w32) · 117 MB · MIT')).toBeTruthy();
    expect(card.getAllByRole('button')).toHaveLength(1);
    expect(card.getByRole('button', { name: 'Download · 117 MB' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('downloads with a progress bar, then shows the normal state', async () => {
    turnOn();
    mocks.status.mockResolvedValue(status({ model: model('missing') }));
    let finish: (info: unknown) => void = () => {};
    mocks.download.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /^Download/ }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    const [name, job] = mocks.download.mock.calls[0] as [string, number];
    expect(name).toBe('nafnet-sidd-width32');

    await waitFor(() => expect(mocks.modelProgress).not.toBeNull());
    act(() => mocks.modelProgress?.({ job, name, received: 58_557_880, total: 117_115_760 }));
    const bar = screen.getByRole('progressbar', { name: 'NAFNet (w32) download' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');

    mocks.status.mockResolvedValue(status({ model: model('installed') }));
    await act(async () => finish(model('installed')));
    await waitFor(() => expect(pill()).toBe('Needs apply'));
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('cancels the download by its job and keeps a failure visible', async () => {
    turnOn();
    mocks.status.mockResolvedValue(status({ model: model('partial') }));
    let fail: (reason: unknown) => void = () => {};
    mocks.download.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /^Resume download/ }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalled());
    const job = (mocks.download.mock.calls[0] as [string, number])[1];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancelDownload).toHaveBeenCalledWith(job);
    await act(async () => fail('offline: no route to host'));
    expect((await screen.findByRole('alert')).textContent).toBe('offline: no route to host');
  });
});

describe('DenoiseGroup Apply', () => {
  const done = (over = {}): DenoiseOutcome => ({
    status: 'done',
    key: 'key-1',
    path: '/cache/denoise-key-1.png',
    width: 6000,
    height: 4000,
    elapsedMs: 13_800,
    engine: 'CoreML (1 partition)',
    tiles: 117,
    ...over,
  });

  it('runs the full denoise, reads "Running 34 %" with tile progress, then "Applied" and re-renders the photo', async () => {
    turnOn();
    let finish: (outcome: DenoiseOutcome) => void = () => {};
    mocks.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    const [folder, relPath, hash, settings, job] = mocks.run.mock.calls[0] as [
      string,
      string,
      string,
      DevelopSettings,
      number,
    ];
    expect([folder, relPath, hash]).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1']);
    expect(settings.detail.denoise?.model).toBe('nafnet-w32');
    expect(typeof job).toBe('number');

    // 0 / 0 while the model loads.
    expect(screen.getByText('Preparing…')).toBeTruthy();
    expect(pill()).toBe('Running 0 %');
    await waitFor(() => expect(mocks.denoiseProgress).not.toBeNull());
    act(() => mocks.denoiseProgress?.({ job: job + 1, done: 5, total: 9 })); // someone else's job
    act(() => mocks.denoiseProgress?.({ job, done: 40, total: 117 }));
    expect(screen.getByText('tile 40/117')).toBeTruthy();
    expect(pill()).toBe('Running 34 %');
    expect(screen.getByRole('progressbar', { name: 'Denoise progress' }).getAttribute('aria-valuenow')).toBe('34');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(mocks.render).not.toHaveBeenCalled();

    mocks.status.mockResolvedValue(status({ ready: true, bytes: 100 }));
    const epoch = useUiStore.getState().denoise.epoch;
    await act(async () => finish(done()));
    expect(mocks.render).toHaveBeenCalledWith('f1');
    expect(useUiStore.getState().denoise.epoch).toBe(epoch + 1);
    await waitFor(() => expect(pill()).toBe('Applied'));
    expect(statusText()).toBe('Denoised at full size in 13.8 s.');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('Cancel stops the job and leaves the photo as it was', async () => {
    turnOn();
    let finish: (outcome: DenoiseOutcome) => void = () => {};
    mocks.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    const job = (mocks.run.mock.calls[0] as unknown as [string, string, string, unknown, number])[4];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancel).toHaveBeenCalledWith(job);
    expect(pill()).toBe('Cancelling');
    await act(async () => finish({ status: 'cancelled' }));
    await waitFor(() => expect(pill()).toBe('Needs apply'));
    expect(mocks.render).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('reports a failure and a model that turned out to be missing', async () => {
    turnOn();
    mocks.run.mockRejectedValueOnce('decode failed');
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('decode failed');

    mocks.run.mockResolvedValueOnce({ status: 'missingModel', model: model('missing') });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/NAFNet \(w32\) is not installed \(117 MB/),
    );
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('keeps a run going when the group is unmounted, and finishes it', async () => {
    turnOn();
    let finish: (outcome: DenoiseOutcome) => void = () => {};
    mocks.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { unmount } = render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    unmount();
    expect(activeJobFor(useJobsStore.getState(), 'denoise', 'f1')?.state).toBe('running');
    await act(async () => finish(done()));
    expect(mocks.render).toHaveBeenCalledWith('f1');
    expect(activeJobFor(useJobsStore.getState(), 'denoise', 'f1')).toBeUndefined();
  });
});

describe('DenoiseGroup pill transitions (plan 28 review)', () => {
  const done = (): DenoiseOutcome => ({
    status: 'done',
    key: 'key-1',
    path: '/cache/denoise-key-1.png',
    width: 6000,
    height: 4000,
    elapsedMs: 13_800,
    engine: 'CoreML',
    tiles: 117,
  });

  it('reads "Checking…" (the pill stays) while the first status is on its way', () => {
    turnOn();
    mocks.status.mockImplementation(() => new Promise(() => {}));
    render(<Harness />);
    expect(pill()).toBe('Checking…');
  });

  it('holds "Running" until the status after the run lands: no "Needs apply" flash before "Applied"', async () => {
    turnOn();
    let finish: (outcome: DenoiseOutcome) => void = () => {};
    mocks.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.denoiseProgress).not.toBeNull());
    const job = (mocks.run.mock.calls[0] as unknown as [string, string, string, unknown, number])[4];
    act(() => mocks.denoiseProgress?.({ job, done: 117, total: 117 }));
    expect(pill()).toBe('Running 100 %');
    let answer: (s: DenoiseStatus) => void = () => {};
    mocks.status.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const seen: Array<string | null> = [];
    const observer = new MutationObserver(() => seen.push(pill()));
    observer.observe(screen.getByTestId('denoise-group'), { subtree: true, characterData: true, childList: true });
    await act(async () => finish(done()));
    expect(pill()).toBe('Running 100 %');
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
    await act(async () => answer(status({ ready: true })));
    await waitFor(() => expect(pill()).toBe('Applied'));
    observer.disconnect();
    expect(seen).not.toContain('Needs apply');
  });

  it('a cancelled run is not marked for queueing on leave until the settings change', async () => {
    turnOn();
    let finish: (outcome: DenoiseOutcome) => void = () => {};
    mocks.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => finish({ status: 'cancelled' }));
    await waitFor(() => expect(pill()).toBe('Needs apply'));
    expect(shownNeedsApply('f1')).toBe(false);
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight' });
    await waitFor(() => expect(shownNeedsApply('f1')).toBe(true));
  });

  it("shows a run of the same file and settings started for another id (the library key's)", async () => {
    turnOn();
    mocks.run.mockImplementation(() => new Promise(() => {}));
    const settings = book().book?.assets.f1?.develop as DevelopSettings;
    act(() => {
      enqueueDenoise({
        folder: '/photos',
        relPath: 'fixture/f1.jpg',
        hash: 'hash-f1',
        settings,
        label: 'f1.jpg',
        ref: 'folder-1/fixture/f1.jpg',
      });
    });
    render(<Harness />);
    await waitFor(() => expect(pill()).toMatch(/^Running|^Queued/));
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });
});

describe('DenoiseGroup loupe toggle', () => {
  it('toggles the loupe on the picture without asking for any crop itself', async () => {
    turnOn();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Preview at 100 %' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useUiStore.getState().denoise.previewOpen).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    expect(mocks.crop).not.toHaveBeenCalled();
  });
});

describe('DenoiseGroup folded below the threshold (plan 28)', () => {
  const withIso = (iso: number) =>
    useAssetsStore.setState({ files: { 'fixture/f1.jpg': { ...file, iso } }, renderDeveloped: mocks.render });

  it('shows only "Not needed at ISO 200" while off (once the measurement is in), and unfolds on click', async () => {
    withIso(200);
    render(<Harness />);
    // Not folded on the ISO alone while the noise is being measured: no fold, then unfold, when it disagrees.
    expect(screen.queryByTestId('denoise-not-needed')).toBeNull();
    const folded = await screen.findByTestId('denoise-not-needed');
    expect(folded.textContent).toBe('Not needed at ISO 200');
    expect(screen.queryByTestId('denoise-badge')).toBeNull();
    fireEvent.click(folded);
    await waitFor(() => expect(screen.getByTestId('denoise-badge').textContent).toBe('ISO 200 · Not needed'));
  });

  it('switches on from the folded row (gently, at the floor), and is not folded while on', () => {
    withIso(200);
    render(<Harness />);
    fireEvent.click(screen.getByRole('switch', { name: 'Denoise' }));
    expect(denoise()).toMatchObject({ luminance: 10, chroma: 35 });
    expect(screen.queryByTestId('denoise-not-needed')).toBeNull();
    expect(screen.getByRole('slider', { name: 'Amount' })).toBeTruthy();
  });

  it('is not folded at ISO 6400', async () => {
    withIso(6400);
    render(<Harness />);
    expect(screen.queryByTestId('denoise-not-needed')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('denoise-badge').textContent).toBe('ISO 6400 · suggests 67'));
  });
});

describe('DenoiseGroup camera badge (plan 23)', () => {
  const profile = (relative: number, over: Partial<NoiseProfile> = {}): NoiseProfile => {
    const fit = { a: 1e-4, b: 1e-6 };
    const sigma = relative * 0.18;
    return {
      make: 'Fujifilm',
      model: 'X-T5',
      iso: 6400,
      source: 'processed',
      measured: {
        channels: [fit, fit, fit],
        sigma,
        confidence: 0.95,
        patches: 900,
        range: [0.01, 0.6],
        extrapolated: false,
        width: 1600,
        height: 1066,
      },
      learned: null,
      learn: 'averaged',
      photos: 12,
      channels: [fit, fit, fit],
      sigma,
      confidence: 0.97,
      ...over,
    };
  };

  it('shows the camera, ISO, suggestion and learned photos, and switches on at the suggestion', async () => {
    mocks.noise.mockResolvedValue(profile(0.023));
    render(<Harness />);
    expect(screen.getByTestId('denoise-badge').textContent).toBe('Measuring noise…');
    await waitFor(() =>
      expect(screen.getByTestId('denoise-badge').textContent).toBe(
        'Fujifilm X-T5 · ISO 6400 · suggests 61 · learned from 12 photos',
      ),
    );
    expect(mocks.noise).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', 'hash-f1');
    fireEvent.click(screen.getByRole('switch', { name: 'Denoise' }));
    expect(denoise()).toEqual({ model: 'nafnet-w32', luminance: 61, chroma: 86, sharpen: 25, chromaMode: 'filter' });
  });

  it('folds a clean photo to "Not needed" and then switches on gently (the floor, not the defaults)', async () => {
    mocks.noise.mockResolvedValue(profile(0.003, { photos: 1 }));
    render(<Harness />);
    // The measurement says clean although ISO 6400 alone would suggest denoise.
    await waitFor(() =>
      expect(screen.getByTestId('denoise-not-needed').textContent).toBe('Not needed (clean at ISO 6400)'),
    );
    fireEvent.click(screen.getByTestId('denoise-not-needed'));
    expect(screen.getByTestId('denoise-badge').textContent).toBe('Fujifilm X-T5 · ISO 6400 · Not needed');
    fireEvent.click(screen.getByRole('switch', { name: 'Denoise' }));
    expect(denoise()).toEqual({ model: 'nafnet-w32', luminance: 10, chroma: 35, sharpen: 25, chromaMode: 'filter' });
  });

  it('asks once per photo, even when shown twice, and not for a photo left before the delay', async () => {
    mocks.noise.mockResolvedValue(profile(0.023));
    const first = render(<Harness />);
    first.unmount();
    expect(mocks.noise).not.toHaveBeenCalled();
    render(<Harness />);
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByTestId('denoise-badge')[0]?.textContent).toContain('suggests 61'));
    expect(mocks.noise).toHaveBeenCalledTimes(1);
  });

  it('falls back to the ISO when the picture is too busy to measure', async () => {
    mocks.noise.mockResolvedValue(profile(0, { confidence: 0, photos: 0 }));
    render(<Harness />);
    await waitFor(() =>
      expect(screen.getByTestId('denoise-badge').textContent).toBe('Fujifilm X-T5 · ISO 6400 · suggests 67'),
    );
  });
});
