// @vitest-environment jsdom
import { createDevelop, type DevelopGeometry, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rectFitsPolygon, warpedPolygon } from '../../lib/develop/cropEdit';
import { andThen, applyMat, cropFits, geometryPlan, rotateAbout, scale } from '../../lib/develop/geometry';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { clearDevelopClipboard } from './copyPaste';
import { COMMIT_IDLE_MS, resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn(), analyse: vi.fn() }));
vi.mock('../../lib/tauri', () => ({ renderDevelopPreview: mocks.render, analyseGeometry: mocks.analyse }));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { cssTransform, frameLayout, pictureMatrix, rectOnScreen } from './CropTool';
import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
// f1 is 1200 × 800. The tool's box is 648 × 448, so the frame (less the 24 px margin) is 600 × 400 at (24, 24).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const OX = 24;
const OY = 24;
const FW = 600;
const FH = 400;
const IA = 1.5;

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

const geometry = (id = 'f1') => useBookStore.getState().book?.assets[id]?.develop?.geometry;
const crop = (id = 'f1') => geometry(id)?.crop ?? null;
const tool = () => screen.getByTestId('crop-tool');
const handle = (h: string) => {
  const el = tool().querySelector(`[data-handle="${h}"]`);
  if (!el) throw new Error(`no handle ${h}`);
  return el;
};
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key: k, ...init });

function drag(
  from: [number, number],
  to: Array<[number, number]>,
  init: { target?: Element; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  const { target = tool(), ...mods } = init;
  fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1], ...mods });
  for (const [x, y] of to) fireEvent.pointerMove(tool(), { pointerId: 1, clientX: x, clientY: y, ...mods });
  const last = to[to.length - 1] ?? from;
  fireEvent.pointerUp(tool(), { pointerId: 1, clientX: last[0], clientY: last[1], ...mods });
}

function openTool() {
  act(() => useUiStore.getState().openDevelop(IDS, 0));
  render(<DevelopMode />);
  key('r');
  expect(screen.getByTestId('crop-panel')).toBeTruthy();
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
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
  mocks.analyse.mockReset();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  clearDevelopClipboard();
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('crop tool', () => {
  it('R opens it in place of the adjustments, showing the whole frame with the crop on top', () => {
    useBookStore
      .getState()
      .setDevelopCrop('f1', { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' });
    openTool();
    expect(screen.queryByRole('region', { name: 'Basic' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Crop/ }).getAttribute('aria-pressed')).toBe('true');
    const frame = screen.getByTestId('crop-frame') as HTMLElement;
    expect(frame.style.left).toBe(`${OX + 0.25 * FW}px`);
    expect(frame.style.top).toBe(`${OY + 0.25 * FH}px`);
    expect(frame.style.width).toBe(`${0.5 * FW}px`);
    // The picture is the proxy drawn over the frame (crop-only edits leave the tone settings default).
    const picture = screen.getByTestId('crop-picture') as HTMLImageElement;
    expect(picture.getAttribute('src')).toBe('asset://proxy/f1.jpg');
    expect(picture.style.transform).toBe(`matrix(1, 0, 0, 1, ${OX}, ${OY})`);
    expect(screen.getByTestId('crop-guides-thirds')).toBeTruthy();
  });

  it('previews the tone settings without the geometry while open', async () => {
    useBookStore.getState().setAssetDevelop('f1', { light: { exposure: 1 } });
    useBookStore
      .getState()
      .setDevelopCrop('f1', { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 3, aspect: 'free' });
    openTool();
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    const settings = mocks.render.mock.calls.at(-1)?.[3] as DevelopSettings;
    expect(settings.geometry.crop).toBeNull();
    expect(settings.light.exposure).toBe(1);
  });

  it('dragging a handle resizes the crop, which stays inside the frame', () => {
    openTool();
    drag([OX + FW, OY + FH], [[OX + FW - 60, OY + FH - 40]], { target: handle('se') });
    const r = crop();
    expect(r?.rect.x).toBe(0);
    expect(r?.rect.w).toBeCloseTo(0.9, 9);
    expect(r?.rect.h).toBeCloseTo(0.9, 9);
    // Pulling the same corner far outside stops at the frame, and the other edges stay.
    drag([OX + 0.9 * FW, OY + 0.9 * FH], [[OX + FW + 200, OY + 0.95 * FH]], { target: handle('se') });
    const out = crop()?.rect;
    expect(out?.x).toBe(0);
    expect(out?.y).toBe(0);
    expect((out?.x ?? 0) + (out?.w ?? 0)).toBeLessThanOrEqual(1);
    expect((out?.x ?? 0) + (out?.w ?? 0)).toBeCloseTo(1, 9);
    expect(out?.h).toBeCloseTo(0.95, 9);
    expect(cropFits(out ?? { x: 0, y: 0, w: 1, h: 1 }, 0, IA)).toBe(true);
    // Each drag was one undo step.
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(2);
  });

  it('Shift keeps the aspect of a free crop; dragging inside moves it', () => {
    openTool();
    drag([OX + FW, OY + FH / 2], [[OX + FW - 120, OY + FH / 2]], { target: handle('e'), shiftKey: true });
    const r = crop()?.rect;
    expect(((r?.w ?? 0) * IA) / (r?.h ?? 1)).toBeCloseTo(1.5, 9);
    expect(r?.w).toBeCloseTo(0.8, 9);
    drag([OX + 100, OY + 200], [[OX + 130, OY + 210]]);
    const moved = crop()?.rect;
    expect(moved?.x).toBeCloseTo((r?.x ?? 0) + 30 / FW, 9);
    expect(moved?.y).toBeCloseTo((r?.y ?? 0) + 10 / FH, 9);
  });

  it('dragging outside the frame rotates the picture and shrinks the crop to stay inside', () => {
    openTool();
    const [cx, cy] = [OX + FW / 2, OY + FH / 2];
    // Start right of the frame, level with the centre; swing down (clockwise on screen).
    drag(
      [OX + FW + 10, cy],
      [
        [OX + FW + 10, cy + 30],
        [OX + FW + 10, cy + 60],
      ],
    );
    const c = crop();
    const expected = (Math.atan2(60, OX + FW + 10 - cx) * 180) / Math.PI;
    expect(c?.angle).toBeCloseTo(expected, 1);
    expect(c?.rect.w).toBeLessThan(1);
    expect(cropFits(c?.rect ?? { x: 0, y: 0, w: 1, h: 1 }, c?.angle ?? 0, IA)).toBe(true);
    // The picture turns clockwise about the crop centre.
    const transform = (screen.getByTestId('crop-picture') as HTMLElement).style.transform;
    const [a, b] = transform.slice(7, -1).split(',').map(Number);
    expect(Math.atan2(b ?? 0, a ?? 1)).toBeCloseTo(((c?.angle ?? 0) * Math.PI) / 180, 6);
  });

  it('the straighten ruler levels a drawn line', () => {
    openTool();
    const tilt = (10 * Math.PI) / 180;
    drag([OX + 100, OY + 100], [[OX + 300, OY + 100 + 200 * Math.tan(tilt)]], { metaKey: true });
    expect(crop()?.angle).toBeCloseTo(-10, 2);
    // The panel button arms it too, for one line.
    fireEvent.click(screen.getByRole('button', { name: 'Straighten tool' }));
    drag([OX + 100, OY + 100], [[OX + 100 + 200 * Math.tan(tilt), OY + 300]]);
    // A nearly vertical line becomes plumb: drawn at 80° on a picture turned by −10°, it is vertical at 0°
    // (and a level, uncropped photo stores no crop).
    expect(crop()?.angle ?? 0).toBeCloseTo(0, 2);
    expect(screen.getByRole('button', { name: 'Straighten tool' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('X swaps the orientation, O cycles the guides', () => {
    openTool();
    fireEvent.click(screen.getByRole('radio', { name: '2:3' }));
    expect(crop()?.aspect).toEqual([3, 2]);
    key('x');
    expect(crop()?.aspect).toEqual([2, 3]);
    const r = crop()?.rect;
    expect(((r?.w ?? 0) * IA) / (r?.h ?? 1)).toBeCloseTo(2 / 3, 9);
    key('o');
    expect(screen.getByTestId('crop-guides-grid')).toBeTruthy();
    for (const next of ['diagonal', 'golden']) {
      key('o');
      expect(screen.getByTestId(`crop-guides-${next}`)).toBeTruthy();
    }
    key('o');
    expect(screen.queryByTestId(/crop-guides-/)).toBeNull();
  });

  it('Escape restores the geometry from when it opened as one undo step and keeps the view open', () => {
    useBookStore
      .getState()
      .setDevelopCrop('f1', { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' });
    const before = structuredClone(geometry());
    openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flip horizontal' }));
    drag([OX + 50, OY + 50], [[OX + 80, OY + 60]]);
    const past = useBookStore.temporal.getState().pastStates.length;
    key('Escape');
    expect(screen.queryByTestId('crop-panel')).toBeNull();
    expect(useUiStore.getState().develop).not.toBeNull();
    expect(geometry()).toEqual(before);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(past + 1);
    undo();
    expect(geometry()?.rotate).toBe(90);
  });

  it('Return applies and commits once; nothing commits while the tool is open', async () => {
    openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    await new Promise((r) => setTimeout(r, COMMIT_IDLE_MS + 100));
    expect(mocks.commit).not.toHaveBeenCalled();
    key('Enter');
    expect(screen.queryByTestId('crop-panel')).toBeNull();
    expect(geometry()?.rotate).toBe(90);
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith('f1'));
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it('stepping to another photo applies and commits the one left', async () => {
    openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Flip vertical' }));
    key('ArrowRight');
    expect(useUiStore.getState().develop?.index).toBe(1);
    expect(screen.queryByTestId('crop-panel')).toBeNull();
    expect(geometry()?.flipV).toBe(true);
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith('f1'));
    // Stepping back does not reopen it.
    key('ArrowLeft');
    expect(screen.queryByTestId('crop-panel')).toBeNull();
  });

  it('the angle slider straightens; constrain off keeps the rect', () => {
    openTool();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Constrain to image' }));
    expect(geometry()?.constrainCrop).toBe(false);
    const slider = screen.getByRole('slider', { name: 'Angle' });
    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true });
    expect(crop()?.angle).toBeCloseTo(1, 9);
    expect(crop()?.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Constrain to image' }));
    expect(crop()?.rect.w).toBeLessThan(1);
  });
});

describe('overlay mapping', () => {
  it('draws the picture where the Rust plan puts it: screen inside the crop frame = the output', () => {
    const geometry = {
      rotate: 90 as const,
      flipH: true,
      flipV: false,
      constrainCrop: true,
      crop: { rect: { x: 0.2, y: 0.1, w: 0.5, h: 0.6 }, angle: -7.5, aspect: 'free' as const },
    };
    // Source 1200 × 800, so the frame is 800 × 1200 (aspect 2/3).
    const plan = geometryPlan(geometry, 1200, 800, null);
    const layout = frameLayout(700, 900, 800 / 1200);
    const [iw, ih] = [layout.fh, layout.fw];
    const m = pictureMatrix(geometry, iw, ih, layout, plan.crop, plan.angle);
    const frame = rectOnScreen(plan.crop, layout);
    for (const p of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.9, 0.7],
    ] as const) {
      const [sx, sy] = applyMat(m, [p[0] * iw, p[1] * ih]);
      const [ox, oy] = applyMat(plan.forward, p);
      expect((sx - frame.left) / frame.width).toBeCloseTo(ox, 9);
      expect((sy - frame.top) / frame.height).toBeCloseTo(oy, 9);
    }
  });
});

describe('Develop view with a crop', () => {
  it('hides the uncropped original under the cropped live render', async () => {
    useBookStore.getState().setDevelopCrop('f1', { rect: { x: 0.25, y: 0, w: 0.5, h: 1 }, angle: 0, aspect: 'free' });
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    await waitFor(() => expect(screen.getByTestId('develop-preview')).toBeTruthy());
    const base = screen.getByRole('img', { name: 'f1.jpg' });
    expect(base.className).toContain('invisible');
    expect(screen.getByTestId('develop-preview').className).not.toContain('invisible');
  });
});

describe('crop tool with perspective', () => {
  const inside = () => {
    const g = geometry();
    const c = g?.crop;
    const poly = g ? warpedPolygon(g, { width: 1200, height: 800 }) : null;
    expect(c && poly).toBeTruthy();
    return c && poly ? rectFitsPolygon(c.rect, c.angle, IA, poly, 1e-9) : false;
  };

  it('draws the warped picture with matrix3d where the Rust plan puts it', () => {
    const base = createDevelop().geometry;
    const g: DevelopGeometry = {
      ...base,
      rotate: 90,
      transform: { ...base.transform, vertical: -40, horizontal: 15, rotate: 3 },
      upright: {
        mode: 'guided',
        guides: [],
        transform: [1.05, 0.02, -0.03, 0.01, 1.1, -0.04, 0.02, 0.09, 1],
        focal: 0.8,
      },
      crop: { rect: { x: 0.2, y: 0.15, w: 0.5, h: 0.6 }, angle: 4, aspect: 'free' },
    };
    const plan = geometryPlan(g, 1200, 800, null);
    const layout = frameLayout(700, 900, 800 / 1200);
    const [iw, ih] = [layout.fh, layout.fw];
    const m = pictureMatrix(g, iw, ih, layout, plan.crop, plan.angle);
    expect(cssTransform(m).startsWith('matrix3d(')).toBe(true);
    const frame = rectOnScreen(plan.crop, layout);
    for (const p of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.9, 0.7],
    ] as const) {
      const [sx, sy] = applyMat(m, [p[0] * iw, p[1] * ih]);
      const [ox, oy] = applyMat(plan.forward, p);
      expect((sx - frame.left) / frame.width).toBeCloseTo(ox, 9);
      expect((sy - frame.top) / frame.height).toBeCloseTo(oy, 9);
    }
    // matrix3d(h0, h3, 0, h6, h1, h4, 0, h7, 0, 0, 1, 0, h2, h5, 0, h8) applied to (x, y, 0, 1) is the homography.
    const n = cssTransform(m).slice('matrix3d('.length, -1).split(',').map(Number);
    const [x, y] = [0.3 * iw, 0.6 * ih];
    const w = (n[3] ?? 0) * x + (n[7] ?? 0) * y + (n[15] ?? 0);
    const [hx, hy] = applyMat(m, [x, y]);
    expect(((n[0] ?? 0) * x + (n[4] ?? 0) * y + (n[12] ?? 0)) / w).toBeCloseTo(hx, 6);
    expect(((n[1] ?? 0) * x + (n[5] ?? 0) * y + (n[13] ?? 0)) / w).toBeCloseTo(hy, 6);
  });

  it('keeps the crop inside the warped image while resizing and moving', () => {
    useBookStore.getState().setTransform('f1', { vertical: -60 });
    expect(inside()).toBe(true);
    openTool();
    const picture = screen.getByTestId('crop-picture') as HTMLImageElement;
    expect(picture.style.transform.startsWith('matrix3d(')).toBe(true);
    const start = crop()?.rect;
    if (!start) throw new Error('no crop');
    // Pull the top-left handle to the box corner: it stops at the warped outline.
    const s = rectOnScreen(start, { ox: OX, oy: OY, fw: FW, fh: FH });
    drag([s.left, s.top], [[0, 0]], { target: handle('nw') });
    expect(inside()).toBe(true);
    // Shrink it, then shove it far to the left and down: it slides along the outline.
    const r = crop()?.rect;
    if (!r) throw new Error('no crop');
    const se = rectOnScreen(r, { ox: OX, oy: OY, fw: FW, fh: FH });
    drag([se.left + se.width, se.top + se.height], [[se.left + se.width / 2, se.top + se.height / 2]], {
      target: handle('se'),
    });
    expect(inside()).toBe(true);
    const small = crop()?.rect;
    if (!small) throw new Error('no crop');
    const c = rectOnScreen(small, { ox: OX, oy: OY, fw: FW, fh: FH });
    drag([c.left + c.width / 2, c.top + c.height / 2], [[-400, 900]]);
    expect(inside()).toBe(true);
    expect(crop()?.rect.x).toBeLessThan(small.x);
    // Turning keeps it inside too.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Angle' }), { key: 'ArrowRight', shiftKey: true });
    expect(crop()?.angle).toBeCloseTo(1, 9);
    expect(inside()).toBe(true);
  });
});

describe('crop tool Auto', () => {
  const level = (patch: Record<string, unknown> = {}) => ({
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    focal: 0.9,
    angle: 2.345,
    confidence: 0.86,
    correction: 'level',
    message: null,
    lines: [{ x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.47, used: true }],
    elapsedMs: 90,
    ...patch,
  });

  it('levels the photo through the Angle in one undo step and says so', async () => {
    openTool();
    mocks.analyse.mockResolvedValue(level());
    fireEvent.click(screen.getByRole('button', { name: 'Auto straighten' }));
    expect(mocks.analyse).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', 'hash-f1', 'level', 0, false, false);
    await waitFor(() => expect(crop()?.angle).toBeCloseTo(2.35, 9));
    expect(screen.getByTestId('crop-auto-message').textContent).toBe('Level +2.4° · confidence 0.9');
    expect(screen.getByRole('slider', { name: 'Angle' }).getAttribute('aria-valuenow')).toBe('2.35');
    // Upright is untouched: Auto here only straightens.
    expect(geometry()?.upright.mode).toBe('off');
    act(() => {
      undo();
    });
    expect(crop()?.angle ?? 0).toBe(0);
  });

  it('takes off the rotation Upright already applies', async () => {
    // A Level Upright turning the 1200 × 800 frame 2° clockwise about its centre (normalised coordinates).
    const turn = andThen(
      andThen(scale(1200, 800), rotateAbout((2 * Math.PI) / 180, 600, 400)),
      scale(1 / 1200, 1 / 800),
    );
    useBookStore.getState().applyUpright('f1', 'level', { transform: [...turn], focal: 0.9 });
    openTool();
    mocks.analyse.mockResolvedValue(level({ angle: 2.5 }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto straighten' }));
    // Upright already turns 2° of the 2.5° the analysis measured before it: the crop takes the rest.
    await waitFor(() => expect(crop()?.angle).toBeCloseTo(0.5, 9));
  });

  it('declines with the message when there are no straight lines', async () => {
    openTool();
    mocks.analyse.mockResolvedValue(
      level({ transform: null, angle: null, correction: null, message: 'no straight lines found' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Auto straighten' }));
    await waitFor(() => expect(screen.getByTestId('crop-auto-message').textContent).toBe('No straight lines found'));
    expect(crop()).toBeNull();
  });
});
