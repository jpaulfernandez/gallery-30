// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { useMaskView } from './maskView';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  mask: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  developSharpenMask: mocks.mask,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const book = () => useBookStore.getState();
const develop = () => book().book?.assets.f1?.develop;
const slider = (name: string) => screen.getByRole('slider', { name });

function files(): Record<string, AssetFile> {
  return Object.fromEntries(
    IDS.map((id) => [
      `fixture/${id}.jpg`,
      {
        relPath: `fixture/${id}.jpg`,
        assetId: id,
        size: 1,
        mtime: 1,
        kind: 'jpeg',
        hash: `hash-${id}`,
        status: 'ready',
        proxyUrl: `asset://proxy/${id}.jpg`,
        thumbUrl: `asset://thumb/${id}.jpg`,
      } satisfies AssetFile,
    ]),
  );
}

function openDetail() {
  act(() => useUiStore.getState().openDevelop(IDS, 0));
  render(<DevelopMode />);
  fireEvent.click(screen.getByRole('button', { name: /^Detail/ }));
  // Plan 54: Sharpening and denoise are the next card; Radius, Detail and Masking its ▸ in Basic.
  fireEvent.click(screen.getByRole('button', { name: /^Sharpen & denoise/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Radius, detail, masking/ }));
}

function rect(el: HTMLElement) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 16, right: 200, bottom: 16 }) as DOMRect;
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:mask-${++n}`);
  URL.revokeObjectURL = vi.fn();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.mask.mockReset();
  mocks.mask.mockImplementation(async () => jpeg());
  mocks.commit.mockReset();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  useMaskView.setState({ active: false });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('DetailSection', () => {
  it('is collapsed until opened, then shows the seven sliders (two cards) with their ranges and defaults', () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    const header = screen.getByRole('button', { name: /^Detail/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('slider', { name: 'Texture' })).toBeNull();
    fireEvent.click(header);
    fireEvent.click(screen.getByRole('button', { name: /^Sharpen & denoise/ }));
    // Basic: Amount; Radius, Detail and Masking wait behind the ▸.
    expect(screen.getByRole('slider', { name: 'Amount' })).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Radius' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Radius, detail, masking/ }));

    const expected: Array<[string, string, string, string]> = [
      ['Texture', '-100', '100', '0'],
      ['Clarity', '-100', '100', '0'],
      ['Dehaze', '-100', '100', '0'],
      ['Amount', '0', '150', '40'],
      ['Radius', '0.5', '3', '1'],
      ['Detail', '0', '100', '25'],
      ['Masking', '0', '100', '0'],
    ];
    for (const [name, min, max, value] of expected) {
      const el = slider(name);
      expect(el.getAttribute('aria-valuemin')).toBe(min);
      expect(el.getAttribute('aria-valuemax')).toBe(max);
      expect(el.getAttribute('aria-valuenow')).toBe(value);
    }
    expect(slider('Radius').getAttribute('aria-valuetext')).toBe('1.0');
    expect(screen.getByText('Applied with any Detail edit')).toBeTruthy();
    // No denoise yet (step D5).
    expect(screen.queryByRole('slider', { name: /denoise/i })).toBeNull();
    // Nothing is edited, so the cards have nothing to reset.
    expect((screen.getByRole('button', { name: 'Reset Detail' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reset Sharpen & denoise' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('writes detail.clarity through setAssetDevelop when Clarity is dragged, as one undo step', () => {
    const original = book().setAssetDevelop;
    const spy = vi.fn(original);
    useBookStore.setState({ setAssetDevelop: spy });
    openDetail();
    const track = slider('Clarity');
    rect(track);
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0 });
    for (const x of [120, 150]) fireEvent.pointerMove(track, { pointerId: 1, clientX: x });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 150 });
    expect(spy).toHaveBeenCalledWith('f1', { detail: { clarity: 50 } });
    expect(develop()?.detail.clarity).toBe(50);
    expect(develop()?.detail.sharpen.amount).toBe(40);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(develop()).toBeUndefined();
  });

  it('writes the Sharpening values under detail.sharpen', () => {
    openDetail();
    fireEvent.keyDown(slider('Masking'), { key: 'PageUp' });
    fireEvent.keyDown(slider('Radius'), { key: 'ArrowRight' });
    fireEvent.keyDown(slider('Amount'), { key: 'ArrowRight', shiftKey: true });
    expect(develop()?.detail.sharpen).toEqual({ amount: 50, radius: 1.1, detail: 25, masking: 10 });
  });

  it('each card resets its own part of detail, one undo step each (plan 54)', () => {
    openDetail();
    act(() =>
      book().setAssetDevelop('f1', { detail: { texture: 30, sharpen: { masking: 60 } }, light: { exposure: 1 } }),
    );
    useBookStore.temporal.getState().clear();
    // The ▸ is tagged while Masking is off its default.
    expect(screen.getByRole('button', { name: /^Radius, detail, masking/ }).textContent).toContain('·edited');
    const reset = screen.getByRole('button', { name: 'Reset Detail' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(develop()?.detail.texture).toBe(0);
    expect(develop()?.detail.sharpen.masking).toBe(60);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Sharpen & denoise' }));
    expect(develop()?.detail.sharpen.masking).toBe(0);
    expect(screen.getByRole('button', { name: /^Radius, detail, masking/ }).textContent).not.toContain('·edited');
    // Other sections stay.
    expect(develop()?.light.exposure).toBe(1);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(2);
  });
});

describe('Alt-drag sharpening mask', () => {
  const maskImg = () => screen.queryByTestId('develop-mask');

  it('shows the mask while Masking is held with Alt, and the live preview again on release', async () => {
    openDetail();
    const track = slider('Masking');
    rect(track);
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0, altKey: true });
    expect(useMaskView.getState().active).toBe(true);
    await waitFor(() => expect(maskImg()).not.toBeNull());
    expect(mocks.mask).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', 'hash-f1', expect.objectContaining({}));
    expect(maskImg()?.getAttribute('src')).toBe('blob:mask-1');

    fireEvent.pointerUp(track, { pointerId: 1, clientX: 100 });
    expect(useMaskView.getState().active).toBe(false);
    expect(maskImg()).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mask-1');
  });

  it('requests a new mask as the value changes during the drag', async () => {
    openDetail();
    const track = slider('Masking');
    rect(track);
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0, altKey: true });
    for (const x of [120, 160]) fireEvent.pointerMove(track, { pointerId: 1, clientX: x, altKey: true });
    await waitFor(() => {
      const last = mocks.mask.mock.calls.at(-1);
      expect(last?.[3].detail.sharpen.masking).toBe(80);
    });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 160 });
    expect(maskImg()).toBeNull();
  });

  it('returns to the render when Alt is released mid-drag, and back with the next Alt press', async () => {
    openDetail();
    const track = slider('Radius');
    rect(track);
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0, altKey: true });
    await waitFor(() => expect(maskImg()).not.toBeNull());
    fireEvent.keyUp(window, { key: 'Alt' });
    expect(maskImg()).toBeNull();
    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    await waitFor(() => expect(maskImg()).not.toBeNull());
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 100 });
    expect(maskImg()).toBeNull();
  });

  it('does nothing without Alt, or for sliders outside the Sharpening group', async () => {
    openDetail();
    const masking = slider('Masking');
    rect(masking);
    fireEvent.pointerDown(masking, { pointerId: 1, clientX: 100, button: 0 });
    expect(useMaskView.getState().active).toBe(false);
    fireEvent.pointerUp(masking, { pointerId: 1, clientX: 100 });
    const clarity = slider('Clarity');
    rect(clarity);
    fireEvent.pointerDown(clarity, { pointerId: 2, clientX: 100, button: 0, altKey: true });
    fireEvent.pointerUp(clarity, { pointerId: 2, clientX: 100 });
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.mask).not.toHaveBeenCalled();
    expect(maskImg()).toBeNull();
  });
});
