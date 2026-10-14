// @vitest-environment jsdom
import { createDevelop, type DevelopGeometry } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMat, perspectiveMatrix } from '../../lib/develop/geometry';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';
import { structureToScreen } from './StructureOverlay';
import { resetPreviewWarnings } from './usePreview';

// f1 is 1200 × 800. The box is 648 × 448, so the picture (less the 24 px margin) is 600 × 400 at (24, 24).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const SIZE = { width: 1200, height: 800 };
const UPRIGHT = [1.05, 0.02, -0.03, 0.01, 1.1, -0.04, 0.02, 0.09, 1];
const LINES = [
  { x0: 0, y0: 0.5, x1: 1, y1: 0.5, used: true },
  { x0: 0.5, y0: 0, x1: 0.5, y1: 1, used: true },
  { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.2, used: false },
];

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

const lineEls = () => screen.queryAllByTestId('structure-line');
const ends = (el: Element) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(el.getAttribute(a)));

function open() {
  act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
  render(<DevelopMode />);
  act(() => useUiStore.getState().setUprightLines({ assetId: 'f1', orientation: '0|', lines: LINES }));
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
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file() } });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP, showStructure: true });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  useUiStore.setState({ showStructure: false });
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('structure overlay', () => {
  it('draws every line, used and rejected in two classes, on the picture', () => {
    open();
    const els = lineEls();
    expect(els).toHaveLength(3);
    expect(els.filter((l) => l.classList.contains('structure-used'))).toHaveLength(2);
    expect(els.filter((l) => l.classList.contains('structure-rejected'))).toHaveLength(1);
    // Rejected lines first, so the used ones draw on top.
    expect(els[0]?.getAttribute('class')).toBe('structure-rejected');
    // No geometry: the oriented frame is the picture, 600 × 400 at (24, 24).
    const horizon = els.find((l) => l.getAttribute('y1') === l.getAttribute('y2'));
    expect(horizon && ends(horizon)).toEqual([24, 224, 624, 224]);
    expect(screen.getByText('Structure: 2 of 3 lines used')).toBeTruthy();
  });

  it('is hidden when off, for another photo, another orientation, Before, or with no lines', () => {
    open();
    expect(lineEls()).toHaveLength(3);
    act(() => useUiStore.getState().setDevelopBeforeAfter(true));
    expect(lineEls()).toHaveLength(0);
    act(() => useUiStore.getState().setDevelopBeforeAfter(false));
    act(() => useUiStore.getState().setPref('showStructure', false));
    expect(screen.queryByTestId('structure-overlay')).toBeNull();
    act(() => useUiStore.getState().setPref('showStructure', true));
    act(() => useBookStore.getState().rotate90('f1', 1));
    expect(lineEls()).toHaveLength(0);
    act(() => useUiStore.getState().setUprightLines({ assetId: 'f1', orientation: '90|', lines: LINES }));
    expect(lineEls()).toHaveLength(3);
    act(() => useUiStore.getState().setUprightLines({ assetId: 'f2', orientation: '90|', lines: LINES }));
    expect(lineEls()).toHaveLength(0);
  });

  it('follows Upright and the crop', () => {
    const g: DevelopGeometry = {
      ...createDevelop().geometry,
      upright: { mode: 'auto', guides: [], transform: UPRIGHT, focal: 0.9 },
    };
    // Upright only: the perspective onto the 600 × 400 picture at (24, 24).
    const m = structureToScreen(g, SIZE, BOX.width, BOX.height);
    const p = applyMat(perspectiveMatrix(g, 1200, 800), [0.3, 0.6]);
    const s = applyMat(m, [0.3, 0.6]);
    expect(s[0]).toBeCloseTo(24 + p[0] * 600, 9);
    expect(s[1]).toBeCloseTo(24 + p[1] * 400, 9);

    // A centred half crop fills the picture: its corners land on the picture's corners.
    const cropped: DevelopGeometry = {
      ...createDevelop().geometry,
      crop: { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' },
    };
    const c = structureToScreen(cropped, SIZE, BOX.width, BOX.height);
    expect(applyMat(c, [0.25, 0.25]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([24, 24]);
    expect(applyMat(c, [0.75, 0.75]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([624, 424]);

    // Straightened by +10°: the crop centre stays put and the picture turns clockwise (right of it moves down).
    const turned: DevelopGeometry = {
      ...cropped,
      crop: { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 10, aspect: 'free' },
    };
    const t = structureToScreen(turned, SIZE, BOX.width, BOX.height);
    const centre = applyMat(t, [0.5, 0.5]);
    expect(centre[0]).toBeCloseTo(324, 9);
    expect(centre[1]).toBeCloseTo(224, 9);
    expect(applyMat(t, [0.6, 0.5])[1]).toBeGreaterThan(224);
  });
});
