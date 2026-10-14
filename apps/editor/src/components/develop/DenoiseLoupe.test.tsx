// @vitest-environment jsdom
import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { resetJobs } from '../../store/jobs';
import { DENOISE_UI_INITIAL, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  crop: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  denoiseStatus: mocks.status,
  previewDenoiseCrop: mocks.crop,
  noiseProfile: vi.fn(),
}));

import { DenoiseLoupe, LOUPE_HOLD_MS } from './DenoiseLoupe';
import {
  CROP_PREVIEW_DEBOUNCE_MS,
  CROP_PREVIEW_SETTLE_MS,
  forgetDenoiseStatusRequests,
  noteSwitchOn,
  useCropPreview,
} from './useDenoise';

type CropCall = [string, string, string, DevelopSettings, [number, number], boolean?];

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const calls = () => mocks.crop.mock.calls as unknown as CropCall[];
const afterCalls = () => calls().filter((c) => c[5] !== true);
const beforeCalls = () => calls().filter((c) => c[5] === true);
const center = () => useUiStore.getState().denoise.center;
const loupe = () => screen.getByTestId('denoise-loupe');
const beforeClip = () => (screen.getByTestId('denoise-loupe-before') as HTMLImageElement).style.clipPath;
const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

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

/** The picture box is 400 × 200 CSS px and the picture 2:1, so it fills it; the loupe is 200 px square. */
function layout() {
  const rects: Record<string, DOMRect> = {
    'denoise-loupe-box': { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 } as DOMRect,
    // Centred on (200, 100): left 100.
    'denoise-loupe': { left: 100, top: 0, width: 200, height: 200, right: 300, bottom: 200 } as DOMRect,
  };
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return rects[this.dataset.testid ?? ''] ?? original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

/** Clicks that reach the picture under the loupe (DevelopImage moves the point on them). */
const pictureClick = vi.fn();

function Harness() {
  const settings = useBookStore((s) => s.book?.assets.f1?.develop) ?? createDevelop();
  return (
    <>
      <div role="slider" aria-label="Some slider" aria-valuenow={0} tabIndex={0} />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stands in for DevelopImage's click to pick */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stands in for DevelopImage's click to pick */}
      <div onClick={pictureClick}>
        <DenoiseLoupe assetId="f1" settings={settings} ar={2} />
      </div>
    </>
  );
}

let restore = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  restore = layout();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:crop-${++n}`);
  URL.revokeObjectURL = vi.fn();
  mocks.status.mockReset();
  mocks.status.mockResolvedValue({
    key: 'k',
    ready: false,
    bytes: 0,
    model: {
      name: 'nafnet-sidd-width32',
      title: 'NAFNet (w32)',
      version: '1',
      bytes: 117_115_760,
      licence: 'MIT',
      licenceUrl: '',
      status: { state: 'installed' },
    },
  });
  mocks.crop.mockReset();
  forgetDenoiseStatusRequests();
  mocks.crop.mockImplementation(async () => jpeg());
  resetJobs();
  const doc = structuredClone(fixtureBook);
  const f1 = doc.assets.f1;
  if (f1) f1.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file } });
  useUiStore.setState({ denoise: { ...DENOISE_UI_INITIAL, previewOpen: true }, developBeforeAfter: false });
  act(() => useBookStore.getState().setDenoise('f1', {}));
});

afterEach(async () => {
  cleanup();
  restore();
  vi.useRealTimers();
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

/** Render, let the status arrive, the opening settle pass and the first crops render. */
async function open() {
  render(<Harness />);
  await flush();
  await flush(CROP_PREVIEW_SETTLE_MS);
  await flush();
}

describe('DenoiseLoupe crop and debounce', () => {
  it('asks for the denoised crop first and the untouched one only once it is back (one decode)', async () => {
    let finish: (bytes: ArrayBuffer) => void = () => {};
    mocks.crop.mockImplementation((_f: string, _r: string, _h: string, _s: unknown, _c: unknown, before?: boolean) =>
      before ? Promise.resolve(jpeg()) : new Promise((resolve) => (finish = resolve)),
    );
    render(<Harness />);
    await flush();
    await flush(CROP_PREVIEW_SETTLE_MS - 1);
    // Opening (not a switch-on) settles first.
    expect(mocks.crop).not.toHaveBeenCalled();
    await flush(1);
    expect(calls().map((c) => c[5] === true)).toEqual([false]);
    await act(async () => finish(jpeg()));
    expect(calls().map((c) => c[5] === true)).toEqual([false, true]);
  });

  it('forgets a switch-on once the loupe closed: opening again settles first', async () => {
    noteSwitchOn('hash-f1');
    mocks.crop.mockImplementation(() => new Promise(() => {}));
    const first = render(<Harness />);
    await flush();
    await flush();
    expect(afterCalls()).toHaveLength(1);
    first.unmount();
    mocks.crop.mockClear();
    mocks.crop.mockImplementation(async () => jpeg());
    render(<Harness />);
    await flush();
    await flush();
    expect(afterCalls()).toHaveLength(0);
    await flush(CROP_PREVIEW_SETTLE_MS);
    expect(afterCalls()).toHaveLength(1);
  });

  it('renders at once right after denoise was switched on', async () => {
    noteSwitchOn('hash-f1');
    render(<Harness />);
    await flush();
    await flush();
    expect(afterCalls()).toHaveLength(1);
    expect(beforeCalls()).toHaveLength(1);
  });

  it('renders the before and after crops at the centre when it opens', async () => {
    await open();
    expect(beforeCalls()).toHaveLength(1);
    expect(afterCalls()).toHaveLength(1);
    expect(afterCalls()[0]?.slice(0, 3)).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1']);
    expect(afterCalls()[0]?.[4]).toEqual([0.5, 0.5]);
    expect(screen.getByAltText('Denoise loupe, after')).toBeTruthy();
    expect(screen.getByAltText('Denoise loupe, before')).toBeTruthy();
    // The window sits on the point: 200 px square centred on (200, 100), kept inside the box.
    expect(loupe().style.left).toBe('100px');
    expect(loupe().style.width).toBe('200px');
  });

  it(`renders again only once the sliders have settled for ${CROP_PREVIEW_DEBOUNCE_MS} ms`, async () => {
    await open();
    act(() => useBookStore.getState().setDenoise('f1', { luminance: 60 }));
    await flush(CROP_PREVIEW_DEBOUNCE_MS - 200);
    act(() => useBookStore.getState().setDenoise('f1', { luminance: 70 }));
    await flush(CROP_PREVIEW_DEBOUNCE_MS - 100);
    expect(afterCalls()).toHaveLength(1);
    await flush(100);
    expect(afterCalls()).toHaveLength(2);
    expect(afterCalls()[1]?.[3].detail.denoise?.luminance).toBe(70);
    // The untouched crop does not depend on the settings.
    expect(beforeCalls()).toHaveLength(1);
  });

  it('never renders while a slider is held, and finishes the debounce after release', async () => {
    await open();
    const held = screen.getByRole('slider', { name: 'Some slider' });
    fireEvent.pointerDown(held, { pointerId: 1, button: 0 });
    act(() => useBookStore.getState().setDenoise('f1', { luminance: 80 }));
    await flush(2000);
    expect(afterCalls()).toHaveLength(1);
    fireEvent.pointerUp(held, { pointerId: 1 });
    await flush(31);
    expect(afterCalls()).toHaveLength(1);
    await flush(1);
    expect(afterCalls()).toHaveLength(2);
  });

  it('logs the time from switching on to the first denoised crop (the plan 28 gate)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    noteSwitchOn('hash-f1', 'fixture/f1.jpg');
    let finish: (bytes: ArrayBuffer) => void = () => {};
    mocks.crop.mockImplementation((_f: string, _r: string, _h: string, _s: unknown, _c: unknown, before?: boolean) =>
      before ? Promise.resolve(jpeg()) : new Promise((resolve) => (finish = resolve)),
    );
    render(<Harness />);
    await flush();
    await flush();
    expect(screen.getByRole('status', { name: 'Rendering the loupe' })).toBeTruthy();
    await flush(1234);
    await act(async () => finish(jpeg()));
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('[photobook:denoise] switched on'))).toBe(true);
    const first = lines.find((l) => l.startsWith('[photobook:denoise] first crop preview'));
    expect(first).toBeDefined();
    expect(JSON.parse(first?.slice(first.indexOf('{')) ?? '{}').ms).toBeGreaterThanOrEqual(1234);
    expect(screen.queryByRole('status', { name: 'Rendering the loupe' })).toBeNull();
    log.mockRestore();
  });

  it('asks for nothing while the model is missing, and says so', async () => {
    mocks.status.mockResolvedValue({
      key: 'k',
      ready: false,
      bytes: 0,
      model: {
        name: 'nafnet-sidd-width32',
        title: 'NAFNet (w32)',
        version: '1',
        bytes: 117_115_760,
        licence: 'MIT',
        licenceUrl: '',
        status: { state: 'missing' },
      },
    });
    await open();
    await flush(2000);
    expect(mocks.crop).not.toHaveBeenCalled();
    expect(screen.getByText('Download the model to see the loupe.')).toBeTruthy();
  });
});

describe('DenoiseLoupe gestures', () => {
  it('shows the before crop while pressed and held, and the split again on release', async () => {
    await open();
    expect(beforeClip()).toBe('inset(0 50% 0 0)');
    fireEvent.pointerDown(loupe(), { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    await flush(LOUPE_HOLD_MS - 1);
    expect(beforeClip()).toBe('inset(0 50% 0 0)');
    await flush(1);
    expect(beforeClip()).toBe('inset(0 0% 0 0)');
    expect(loupe().dataset.holding).toBe('true');
    fireEvent.pointerUp(loupe(), { pointerId: 1, clientX: 200, clientY: 100 });
    expect(beforeClip()).toBe('inset(0 50% 0 0)');
    // A hold is not a move.
    expect(center()).toEqual([0.5, 0.5]);
  });

  it('shows the before crop while Before / After (\\) is on', async () => {
    await open();
    act(() => useUiStore.getState().setDevelopBeforeAfter(true));
    expect(beforeClip()).toBe('inset(0 0% 0 0)');
  });

  it('is dragged to a new point, which is pinned (and rendered) on release', async () => {
    await open();
    fireEvent.pointerDown(loupe(), { pointerId: 1, button: 0, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(loupe(), { pointerId: 1, clientX: 250, clientY: 125 });
    fireEvent.pointerMove(loupe(), { pointerId: 1, clientX: 300, clientY: 150 });
    // The window follows the pointer; the point moves on release only.
    expect(loupe().style.left).toBe('200px');
    expect(center()).toEqual([0.5, 0.5]);
    await flush(LOUPE_HOLD_MS);
    expect(loupe().dataset.holding).toBeUndefined();
    fireEvent.pointerUp(loupe(), { pointerId: 1, clientX: 300, clientY: 150 });
    expect(center()).toEqual([0.75, 0.75]);
    await flush(CROP_PREVIEW_SETTLE_MS);
    await flush();
    expect(afterCalls().at(-1)?.[4]).toEqual([0.75, 0.75]);
    expect(beforeCalls().at(-1)?.[4]).toEqual([0.75, 0.75]);
    expect(beforeCalls()).toHaveLength(2);
  });

  it('moves the point with the arrow keys, and does not pass the click on to the picture', async () => {
    await open();
    fireEvent.keyDown(loupe(), { key: 'ArrowRight', shiftKey: true });
    expect(center()[0]).toBeCloseTo(0.55);
    pictureClick.mockClear();
    fireEvent.click(loupe());
    expect(pictureClick).not.toHaveBeenCalled();
  });

  it('moves the split with its handle and the arrow keys, without moving the loupe', async () => {
    await open();
    const split = screen.getByRole('slider', { name: 'Before / after split' });
    fireEvent.pointerDown(split, { pointerId: 2, button: 0, clientX: 200 });
    fireEvent.pointerMove(split, { pointerId: 2, clientX: 150 });
    fireEvent.pointerUp(split, { pointerId: 2, clientX: 150 });
    expect(beforeClip()).toBe('inset(0 75% 0 0)');
    fireEvent.keyDown(split, { key: 'ArrowRight', shiftKey: true });
    expect(beforeClip()).toBe('inset(0 65% 0 0)');
    expect(center()).toEqual([0.5, 0.5]);
    expect(loupe().style.left).toBe('100px');
  });

  it('keeps the split inside the window past either edge, so it can be dragged back (split = 1)', async () => {
    await open();
    const split = screen.getByRole('slider', { name: 'Before / after split' });
    fireEvent.pointerDown(split, { pointerId: 2, button: 0, clientX: 200 });
    fireEvent.pointerMove(split, { pointerId: 2, clientX: 900 });
    fireEvent.pointerUp(split, { pointerId: 2, clientX: 900 });
    expect(split.getAttribute('aria-valuenow')).toBe('98');
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(split, { key: 'ArrowRight', shiftKey: true });
    expect(split.getAttribute('aria-valuenow')).toBe('98');
    expect(screen.getByRole('slider', { name: 'Before / after split' })).toBe(split);
    expect(screen.getByText('After')).toBeTruthy();
    fireEvent.keyDown(split, { key: 'ArrowLeft', shiftKey: true });
    expect(split.getAttribute('aria-valuenow')).toBe('88');
    fireEvent.pointerDown(split, { pointerId: 3, button: 0, clientX: 300 });
    fireEvent.pointerMove(split, { pointerId: 3, clientX: 0 });
    fireEvent.pointerUp(split, { pointerId: 3, clientX: 0 });
    expect(split.getAttribute('aria-valuenow')).toBe('2');
  });

  it('keeps the split handle (and its focus) while Before / After shows the whole before crop', async () => {
    await open();
    const split = screen.getByRole('slider', { name: 'Before / after split' });
    split.focus();
    act(() => useUiStore.getState().setDevelopBeforeAfter(true));
    expect(screen.getByRole('slider', { name: 'Before / after split' })).toBe(split);
    expect(document.activeElement).toBe(split);
    expect(screen.queryByText('After')).toBeNull();
  });

  it('dragging the split does not hold the crop back', async () => {
    await open();
    const split = screen.getByRole('slider', { name: 'Before / after split' });
    fireEvent.pointerDown(split, { pointerId: 2, button: 0, clientX: 200 });
    act(() => useBookStore.getState().setDenoise('f1', { luminance: 70 }));
    await flush(CROP_PREVIEW_DEBOUNCE_MS);
    expect(afterCalls()).toHaveLength(2);
    fireEvent.pointerUp(split, { pointerId: 2, clientX: 200 });
  });

  it('closes', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Close the loupe' }));
    expect(useUiStore.getState().denoise.previewOpen).toBe(false);
  });
});

describe('useCropPreview while stepping through photos', () => {
  it('asks only for the photo it stops on', async () => {
    const settings = createDevelop();
    settings.detail.denoise = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' };
    const { rerender } = renderHook(
      ({ n }) =>
        useCropPreview({
          enabled: true,
          folder: '/photos',
          relPath: `p${n}.jpg`,
          hash: `hash-${n}`,
          settings,
          center: [0.5, 0.5],
        }),
      { initialProps: { n: 0 } },
    );
    for (let n = 1; n < 20; n += 1) {
      await flush(CROP_PREVIEW_SETTLE_MS / 2);
      rerender({ n });
    }
    await flush(CROP_PREVIEW_SETTLE_MS);
    await flush();
    expect(calls().map((c) => [c[2], c[5] === true])).toEqual([
      ['hash-19', false],
      ['hash-19', true],
    ]);
  });
});
