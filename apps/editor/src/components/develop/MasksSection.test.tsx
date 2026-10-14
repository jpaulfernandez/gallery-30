// @vitest-environment jsdom
import type { DevelopMask } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_BRUSH, DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({ render: vi.fn(), overlay: vi.fn(), commit: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
  developMaskOverlay: mocks.overlay,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

// f1 is 1200 × 800. The box is 648 × 448, so the picture (less the 24 px margin) is 600 × 400 at (24, 24).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const at = (u: number, v: number): [number, number] => [24 + 600 * u, 24 + 400 * v];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

const file = (): AssetFile => ({
  relPath: 'fixture/f1.jpg',
  assetId: 'f1',
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: 'hash-f1',
  status: 'ready',
  proxyUrl: 'asset://proxy/f1.jpg',
  thumbUrl: 'asset://thumb/f1.jpg',
});

const masks = (): DevelopMask[] => useBookStore.getState().book?.assets.f1?.develop?.masks ?? [];
const steps = () => useBookStore.temporal.getState().pastStates.length;
const tools = () => screen.getByTestId('mask-tools');
const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(screen.getByRole('dialog'), { key: k, ...init });

function open() {
  act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
  render(<DevelopMode />);
  key('m');
}

function create(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Create new mask' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

function drag(points: Array<[number, number]>, init: Partial<PointerEventInit> = {}) {
  const [first, ...rest] = points;
  if (!first) return;
  fireEvent.pointerDown(tools(), { pointerId: 1, button: 0, clientX: first[0], clientY: first[1], ...init });
  for (const [x, y] of rest) fireEvent.pointerMove(tools(), { pointerId: 1, clientX: x, clientY: y, ...init });
  const last = rest[rest.length - 1] ?? first;
  fireEvent.pointerUp(tools(), { pointerId: 1, clientX: last[0], clientY: last[1] });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:overlay');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: 0,
    y: 0,
    right: BOX.width,
    bottom: BOX.height,
    toJSON: () => BOX,
  } as DOMRect);
  // jsdom has no canvas: the overlay paints nothing, but its source is still reported.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.overlay.mockReset();
  mocks.overlay.mockImplementation(async () => jpeg());
  mocks.commit.mockReset();
  const doc = structuredClone(fixtureBook);
  const asset = doc.assets.f1;
  if (asset) asset.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file() } });
  useUiStore.setState({
    develop: null,
    developBeforeAfter: false,
    filmstrip: DEFAULT_FILMSTRIP,
    maskOverlay: true,
    maskBrush: { ...DEFAULT_BRUSH },
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('MasksSection', () => {
  it('M opens the section; the Create menu lists the drawing tools and the AI masks', () => {
    act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
    render(<DevelopMode />);
    expect(screen.queryByRole('button', { name: 'Create new mask' })).toBeNull();
    key('m');
    expect(useUiStore.getState().developMasks).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create new mask' }));
    for (const label of ['Brush', 'Linear gradient', 'Radial gradient', 'Luminance range', 'Color range']) {
      expect((screen.getByRole('menuitem', { name: label }) as HTMLButtonElement).disabled).toBe(false);
    }
    for (const label of ['Subject', 'Sky', 'Background', 'People', 'Depth range']) {
      expect((screen.getByRole('menuitem', { name: label }) as HTMLButtonElement).disabled).toBe(false);
    }
    key('m');
    expect(useUiStore.getState().developMasks).toBe(false);
  });

  it('draws a linear gradient as one undo step, then selects it and edits its local sliders', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.1), at(0.5, 0.5), at(0.5, 0.9)]);
    expect(steps()).toBe(1);
    const [m] = masks();
    expect(m?.name).toBe('Mask 1');
    const c = m?.components[0];
    if (c?.kind !== 'linear') throw new Error('linear expected');
    // Plan 56: full at the press (`to`), fading toward the release (`from`).
    expect(c.to[0]).toBeCloseTo(0.5);
    expect(c.to[1]).toBeCloseTo(0.1);
    expect(c.from[1]).toBeCloseTo(0.9);
    expect(screen.getAllByTestId(/^linear-line-/)).toHaveLength(3);

    const detail = screen.getByRole('group', { name: 'Mask Mask 1' });
    const exposure = within(detail).getByRole('slider', { name: 'Exposure' });
    expect(exposure.getAttribute('aria-valuemin')).toBe('-4');
    fireEvent.keyDown(exposure, { key: 'ArrowRight', shiftKey: true });
    expect(masks()[0]?.adjustments.exposure).toBeCloseTo(0.1);
    // Workflow plan 24: the local Noise slider is live.
    const noise = within(detail).getByRole('slider', { name: 'Noise' });
    expect(noise.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.keyDown(noise, { key: 'ArrowRight' });
    expect(masks()[0]?.adjustments.noise).toBeGreaterThan(0);
    fireEvent.click(within(detail).getByRole('button', { name: 'Reset' }));
    expect(masks()[0]?.adjustments.exposure).toBe(0);

    // A component through Subtract, and the mask's own controls.
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Invert mask' }));
    expect(masks()[0]?.invert).toBe(true);
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete mask' }));
    expect(masks()).toEqual([]);
  });

  it('paints a brush stroke in frame fractions as one undo step', () => {
    open();
    create('Brush');
    expect(useUiStore.getState().developMaskTool).toMatchObject({ tool: 'brush', create: 'new' });
    const path = Array.from({ length: 13 }, (_, i) => at(0.2 + i * 0.05, 0.5));
    drag(path);
    expect(steps()).toBe(1);
    const c = masks()[0]?.components[0];
    if (c?.kind !== 'brush') throw new Error('brush expected');
    expect(c.strokes).toHaveLength(1);
    const points = c.strokes[0]?.points ?? [];
    expect(points.length).toBeGreaterThanOrEqual(2);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeCloseTo(0.5);
    }
    expect(points[0]?.[0]).toBeCloseTo(0.2);
    expect(points[points.length - 1]?.[0]).toBeCloseTo(0.8);
    expect(c.strokes[0]).toMatchObject({ size: DEFAULT_BRUSH.size, flow: 100, erase: false });

    // The next stroke (Alt: erase) goes into the same component.
    drag([at(0.5, 0.5), at(0.55, 0.5)], { altKey: true });
    const again = masks()[0]?.components[0];
    expect(again?.kind === 'brush' && again.strokes.map((s) => s.erase)).toEqual([false, true]);
    expect(steps()).toBe(2);
    undo();
    undo();
    expect(masks()).toEqual([]);
  });

  it('drags out a radial gradient (radii in frame fractions) and moves it by its inside', () => {
    open();
    create('Radial gradient');
    drag([at(0.5, 0.5), [at(0.5, 0.5)[0] + 60, at(0.5, 0.5)[1] + 40]]);
    const c = masks()[0]?.components[0];
    if (c?.kind !== 'radial') throw new Error('radial expected');
    // 60 px at 0.5 px per frame px over a 1200 px frame = 0.1; 40 px over 800 px = 0.1.
    expect(c.center[0]).toBeCloseTo(0.5);
    expect(c.radii[0]).toBeCloseTo(0.1);
    expect(c.radii[1]).toBeCloseTo(0.1);
    expect(c.angle).toBe(0);
    const inside = screen.getByTestId('radial-shape').querySelector('[data-mask-handle="move"]');
    if (!inside) throw new Error('no move handle');
    const [x, y] = at(0.5, 0.5);
    fireEvent.pointerDown(inside, { pointerId: 2, button: 0, clientX: x, clientY: y });
    fireEvent.pointerMove(tools(), { pointerId: 2, clientX: x + 60, clientY: y });
    fireEvent.pointerUp(tools(), { pointerId: 2, clientX: x + 60, clientY: y });
    const moved = masks()[0]?.components[0];
    expect(moved?.kind === 'radial' && moved.center[0]).toBeCloseTo(0.6);
    expect(steps()).toBe(2);
  });

  it('requests the overlay for the selected mask and shows it; O toggles it', async () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.1), at(0.5, 0.9)]);
    const id = masks()[0]?.id;
    await waitFor(() => expect(mocks.overlay).toHaveBeenCalled());
    const [folder, relPath, hash, settings, maskId] = mocks.overlay.mock.calls.at(-1) ?? [];
    expect([folder, relPath, hash, maskId]).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1', id]);
    expect(settings.masks[0].id).toBe(id);
    await waitFor(() => expect(screen.getByTestId('mask-overlay').getAttribute('data-source')).toBe('rendered'));
    key('o');
    expect(useUiStore.getState().maskOverlay).toBe(false);
    expect(screen.queryByTestId('mask-overlay')).toBeNull();
  });

  it('[ ] change the brush size (Shift: feather), Escape ends the tool, Delete removes the component', () => {
    open();
    create('Brush');
    key(']', { code: 'BracketRight' });
    expect(useUiStore.getState().maskBrush.size).toBeGreaterThan(DEFAULT_BRUSH.size);
    key('[', { code: 'BracketLeft' });
    key('[', { code: 'BracketLeft' });
    expect(useUiStore.getState().maskBrush.size).toBeLessThan(DEFAULT_BRUSH.size);
    key('{', { code: 'BracketLeft', shiftKey: true });
    expect(useUiStore.getState().maskBrush.feather).toBe(DEFAULT_BRUSH.feather - 10);
    drag([at(0.3, 0.3), at(0.4, 0.3)]);
    key('Escape');
    expect(useUiStore.getState().developMaskTool?.tool).toBeNull();
    expect(useUiStore.getState().develop).not.toBeNull();
    key('Delete');
    expect(masks()).toEqual([]);
  });

  it('a luminance range mask is created at once with its range control', () => {
    open();
    create('Luminance range');
    const c = masks()[0]?.components[0];
    expect(c?.kind).toBe('luminance');
    expect(useUiStore.getState().developMaskTool).toMatchObject({ tool: 'luminance', componentId: c?.id });
    const high = screen.getByRole('slider', { name: 'Luminance range high' });
    const low = screen.getByRole('slider', { name: 'Luminance range low' });
    fireEvent.keyDown(low, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(high, { key: 'ArrowLeft' });
    const now = masks()[0]?.components[0];
    expect(now?.kind === 'luminance' && now.range).toEqual([0.4, 0.99]);
  });
});
