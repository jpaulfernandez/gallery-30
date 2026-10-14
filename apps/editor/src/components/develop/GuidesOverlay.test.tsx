// @vitest-environment jsdom
import { createDevelop, type UprightGuide } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMat, invert, perspectiveMatrix } from '../../lib/develop/geometry';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn(), solve: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
  solveUprightGuides: mocks.solve,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';
import { kindOfExtent } from './GuidesOverlay';
import { resetPreviewWarnings } from './usePreview';

// f1 is 1200 × 800. The box is 648 × 448, so the frame (less the 24 px margin) is 600 × 400 at (24, 24).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const OX = 24;
const OY = 24;
const FW = 600;
const FH = 400;
const UPRIGHT = [1.05, 0.02, -0.03, 0.01, 1.1, -0.04, 0.02, 0.09, 1];

const geometry = () => useBookStore.getState().book?.assets.f1?.develop?.geometry ?? createDevelop().geometry;
const guides = () => geometry().upright.guides;
const overlay = () => screen.getByTestId('guides-overlay');
const at = (u: number, v: number): [number, number] => [OX + u * FW, OY + v * FH];

function file(): AssetFile {
  return {
    relPath: 'fixture/f1.jpg',
    assetId: 'f1',
    size: 1,
    mtime: 1,
    kind: 'jpeg',
    hash: 'hash-f1',
    status: 'ready',
    proxyUrl: 'asset://proxy/f1.jpg',
    thumbUrl: 'asset://thumb/f1.jpg',
  } satisfies AssetFile;
}

function drag(from: [number, number], to: Array<[number, number]>, target: Element = overlay()) {
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
  for (const [x, y] of to) fireEvent.pointerMove(overlay(), { pointerId: 1, clientX: x, clientY: y });
  const last = to[to.length - 1] ?? from;
  fireEvent.pointerUp(overlay(), { pointerId: 1, clientX: last[0], clientY: last[1] });
}

function open() {
  act(() => {
    useUiStore.getState().openDevelop(['f1', 'f2'], 0);
    useUiStore.getState().setDevelopGuides(true);
  });
  render(<DevelopMode />);
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: 0,
    y: 0,
    right: BOX.width,
    bottom: BOX.height,
    toJSON: () => BOX,
  } as DOMRect);
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.commit.mockReset();
  mocks.solve.mockReset();
  mocks.solve.mockImplementation(async (gs: UprightGuide[]) => {
    const nh = gs.filter((g) => g.kind === 'horizontal').length;
    const nv = gs.length - nh;
    const ok = (nh === 2 && nv === 0) || (nh === 0 && nv === 2) || (nh >= 1 && nv >= 1 && nh <= 2 && nv <= 2);
    if (!ok)
      throw `InvalidGuides: ${nh} horizontal and ${nv} vertical guides; use 2H, 2V, 2H+2V, 2H+1V, 2V+1H or 1V+1H`;
    return { transform: UPRIGHT, focal: 0.78, residual: 0, correction: nh === 0 ? 'vertical' : 'full' };
  });
  const doc = structuredClone(fixtureBook);
  const asset = doc.assets.f1;
  if (asset) asset.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file() } });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('guides overlay', () => {
  it('types guides by their extent', () => {
    expect(kindOfExtent(10, 3)).toBe('horizontal');
    expect(kindOfExtent(-2, 30)).toBe('vertical');
  });

  it('shows the whole picture with the geometry previewed in CSS, not rendered', async () => {
    useBookStore.getState().setAssetDevelop('f1', { light: { exposure: 1 } });
    useBookStore.getState().setTransform('f1', { vertical: -30 });
    open();
    const picture = screen.getByTestId('guides-picture') as HTMLImageElement;
    expect(picture.getAttribute('src')).toBe('asset://proxy/f1.jpg');
    expect(picture.style.transform.startsWith('matrix3d(')).toBe(true);
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    // The live render runs without geometry: the overlay warps it itself.
    const settings = mocks.render.mock.calls.at(-1)?.[3];
    expect(settings.geometry.transform.vertical).toBe(0);
    expect(settings.geometry.crop).toBeNull();
    expect(settings.light.exposure).toBe(1);
  });

  it('a drag on empty space draws a guide, solved once on pointer up, as one undo step', async () => {
    open();
    fireEvent.pointerDown(overlay(), { pointerId: 1, button: 0, clientX: at(0.3, 0.1)[0], clientY: at(0.3, 0.1)[1] });
    fireEvent.pointerMove(overlay(), { pointerId: 1, clientX: at(0.28, 0.5)[0], clientY: at(0.28, 0.5)[1] });
    expect(screen.getByTestId('guides-loupe')).toBeTruthy();
    fireEvent.pointerMove(overlay(), { pointerId: 1, clientX: at(0.26, 0.9)[0], clientY: at(0.26, 0.9)[1] });
    expect(mocks.solve).not.toHaveBeenCalled();
    fireEvent.pointerUp(overlay(), { pointerId: 1, clientX: at(0.26, 0.9)[0], clientY: at(0.26, 0.9)[1] });
    expect(screen.queryByTestId('guides-loupe')).toBeNull();
    await waitFor(() => expect(mocks.solve).toHaveBeenCalledTimes(1));
    expect(guides()).toHaveLength(1);
    const g = guides()[0];
    expect(g?.kind).toBe('vertical');
    expect(g?.from[0]).toBeCloseTo(0.3, 12);
    expect(g?.to[1]).toBeCloseTo(0.9, 12);
    // One guide is not a valid combination: the message, no transform.
    await waitFor(() => expect(screen.getByText(/2 horizontal or 2 vertical/)).toBeTruthy());
    expect(geometry().upright.transform).toBeNull();

    drag(at(0.7, 0.1), [at(0.74, 0.9)]);
    await waitFor(() => expect(mocks.solve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(geometry().upright.transform).toEqual(UPRIGHT));
    expect(geometry().upright.mode).toBe('guided');
    // The solver got the guides in the oriented frame (no perspective yet when they were drawn).
    const sent = mocks.solve.mock.calls[1]?.[0] as UprightGuide[];
    expect(sent[1]?.to[0]).toBeCloseTo(0.74, 12);
    // Stored guides follow the corrected picture: mapped back they are where they were drawn.
    const back = invert(perspectiveMatrix(geometry(), 1200, 800)) ?? [];
    const [u, v] = applyMat(back, guides()[1]?.to ?? [0, 0]);
    expect(u).toBeCloseTo(0.74, 9);
    expect(v).toBeCloseTo(0.9, 9);
    // Drawing the second guide and its solve undo together.
    act(() => undo());
    expect(guides()).toHaveLength(1);
    expect(geometry().upright.transform).toBeNull();
  });

  it('a click without a drag draws nothing', () => {
    open();
    drag(at(0.5, 0.5), [at(0.5 + 2 / FW, 0.5)]);
    expect(guides()).toHaveLength(0);
    expect(mocks.solve).not.toHaveBeenCalled();
  });

  it('dragging an end moves it with a loupe, re-solving on pointer up', async () => {
    useBookStore.getState().setUprightGuides('f1', [
      { id: 'a', kind: 'vertical', from: [0.3, 0.1], to: [0.26, 0.9] },
      { id: 'b', kind: 'vertical', from: [0.7, 0.1], to: [0.74, 0.9] },
    ]);
    open();
    const end = overlay().querySelector('[data-guide="a"][data-guide-end="to"]');
    if (!end) throw new Error('no end handle');
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: at(0.26, 0.9)[0], clientY: at(0.26, 0.9)[1] });
    fireEvent.pointerMove(overlay(), { pointerId: 1, clientX: at(0.2, 0.95)[0], clientY: at(0.2, 0.95)[1] });
    expect(screen.getByTestId('guides-loupe')).toBeTruthy();
    expect(guides()[0]?.to[0]).toBeCloseTo(0.2, 12);
    expect(mocks.solve).not.toHaveBeenCalled();
    fireEvent.pointerUp(overlay(), { pointerId: 1, clientX: at(0.2, 0.95)[0], clientY: at(0.2, 0.95)[1] });
    await waitFor(() => expect(geometry().upright.transform).toEqual(UPRIGHT));
    expect(mocks.solve).toHaveBeenCalledTimes(1);
    const sent = (mocks.solve.mock.calls[0]?.[0] ?? []) as UprightGuide[];
    expect(sent[0]?.to[0]).toBeCloseTo(0.2, 12);
  });

  it('the badge toggles a guide between vertical and horizontal; Delete removes the selected one', async () => {
    useBookStore.getState().setUprightGuides('f1', [
      { id: 'a', kind: 'vertical', from: [0.3, 0.1], to: [0.26, 0.9] },
      { id: 'b', kind: 'vertical', from: [0.7, 0.1], to: [0.74, 0.9] },
      { id: 'c', kind: 'horizontal', from: [0.1, 0.5], to: [0.9, 0.52] },
    ]);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Guide 3: horizontal. Make it vertical' }));
    await waitFor(() => expect(mocks.solve).toHaveBeenCalledTimes(1));
    expect(guides()[2]?.kind).toBe('vertical');
    // 3V is not valid: nothing written.
    await waitFor(() => expect(screen.getAllByText(/2 horizontal or 2 vertical/).length).toBeGreaterThan(0));
    expect(geometry().upright.transform).toBeNull();

    const line = overlay().querySelector('[data-guide-line="c"]');
    if (!line) throw new Error('no line');
    fireEvent.pointerDown(line, { pointerId: 1, button: 0, clientX: at(0.5, 0.51)[0], clientY: at(0.5, 0.51)[1] });
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(mocks.solve).toHaveBeenCalledTimes(2));
    expect(guides().map((g) => g.id)).toEqual(['a', 'b']);
    await waitFor(() => expect(geometry().upright.transform).toEqual(UPRIGHT));
  });

  it('allows four guides at most', () => {
    const four: UprightGuide[] = ['a', 'b', 'c', 'd'].map((id, i) => ({
      id,
      kind: i < 2 ? 'vertical' : 'horizontal',
      from: [0.1 + i * 0.2, 0.1],
      to: [0.1 + i * 0.2, 0.3],
    }));
    useBookStore.getState().setUprightGuides('f1', four);
    open();
    drag(at(0.2, 0.8), [at(0.8, 0.82)]);
    expect(guides()).toHaveLength(4);
    expect(screen.getByText(/Four guides at most/)).toBeTruthy();
  });

  it('Escape ends drawing before it closes the view', () => {
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().developGuides).toBe(false);
    expect(useUiStore.getState().develop).not.toBeNull();
    expect(screen.queryByTestId('guides-overlay')).toBeNull();
  });
});
