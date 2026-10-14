import {
  type Book,
  createDevelop,
  type DevelopMask,
  LocalAdjustmentsSchema,
  type UprightGuide,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rectFitsPolygon, warpedPolygon } from '../lib/develop/cropEdit';
import { applyMat, invert, orientedSize, perspectiveMatrix, preCropMatrix, remapPoints } from '../lib/develop/geometry';
import { beginDevelopDrag, endDevelopDrag, undo, useBookStore } from './book';

const mocks = vi.hoisted(() => ({ solve: vi.fn() }));
vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  solveUprightGuides: mocks.solve,
}));

// f1 is 1200 × 800.
const SIZE = { width: 1200, height: 800 };
const UPRIGHT = [
  1.188363649281757, 0.06446848332522802, -0.060354038357723586, 0.09312103093822446, 1.2001118428071103,
  -0.08055440892689829, 0.127347455051356, 0.13690065673171983, 1,
];
const GUIDES: UprightGuide[] = [
  { id: 'g1', kind: 'vertical', from: [0.3, 0.1], to: [0.26, 0.9] },
  { id: 'g2', kind: 'vertical', from: [0.7, 0.1], to: [0.74, 0.9] },
];
const MASK: DevelopMask = {
  id: 'm1',
  name: 'Window',
  enabled: true,
  invert: false,
  opacity: 100,
  feather: 0,
  adjustments: LocalAdjustmentsSchema.parse({}),
  components: [
    {
      id: 'c1',
      mode: 'add',
      invert: false,
      kind: 'brush',
      strokes: [{ points: [[0.42, 0.33]], size: 10, feather: 50, flow: 100, erase: false }],
    },
  ],
};

const store = () => useBookStore.getState();
const develop = () => store().book?.assets.f1?.develop;
const geometry = () => develop()?.geometry ?? createDevelop().geometry;

function seed() {
  store().setAssetDevelop('f1', (prev) => ({
    ...prev,
    masks: [structuredClone(MASK)],
    geometry: { ...prev.geometry, upright: { ...prev.geometry.upright, guides: structuredClone(GUIDES) } },
  }));
  useBookStore.temporal.getState().clear();
}

beforeEach(() => {
  mocks.solve.mockReset();
  useBookStore.setState({ book: structuredClone(fixtureBook) as Book, folder: '/photos' });
  useBookStore.temporal.getState().clear();
});

afterEach(() => {
  useBookStore.setState({ book: null, folder: null });
});

describe('setTransform', () => {
  it('re-maps masks and guides through H_new · H_old⁻¹ and refits the crop inside the warped image', () => {
    seed();
    const before = structuredClone(geometry());
    store().setTransform('f1', { vertical: -40 });
    const after = geometry();
    expect(after.transform.vertical).toBe(-40);
    const hOld = preCropMatrix(before, SIZE.width, SIZE.height);
    const hNew = preCropMatrix(after, SIZE.width, SIZE.height);
    const g1 = after.upright.guides[0];
    const [from, to] = remapPoints([GUIDES[0]?.from ?? [0, 0], GUIDES[0]?.to ?? [0, 0]], hOld, hNew);
    expect(g1?.from).toEqual(from);
    expect(g1?.to).toEqual(to);
    const stroke = develop()?.masks[0]?.components[0];
    expect(stroke?.kind === 'brush' && stroke.strokes[0]?.points[0]).toEqual(
      remapPoints([[0.42, 0.33]], hOld, hNew)[0],
    );
    // Constrain is on: the crop is the largest frame-shaped one inside the warped outline.
    const crop = after.crop;
    expect(crop).not.toBeNull();
    const poly = warpedPolygon(after, SIZE);
    expect(poly).not.toBeNull();
    if (!crop || !poly) return;
    expect(rectFitsPolygon(crop.rect, crop.angle, 1.5, poly, 1e-9)).toBe(true);
    expect((crop.rect.w * 1.5) / crop.rect.h).toBeCloseTo(1.5, 9);
    expect(crop.rect.w).toBeLessThan(1);
  });

  it('is one undo step, and a slider drag is one step too', () => {
    seed();
    store().setTransform('f1', { horizontal: 20 });
    undo();
    expect(geometry().transform.horizontal).toBe(0);
    expect(geometry().upright.guides).toEqual(GUIDES);
    expect(geometry().crop).toBeNull();

    beginDevelopDrag();
    for (const v of [5, 10, 15]) store().setTransform('f1', { vertical: v });
    endDevelopDrag();
    expect(geometry().transform.vertical).toBe(15);
    undo();
    expect(geometry().transform.vertical).toBe(0);
    // Incremental re-maps telescope back to the start.
    geometry().upright.guides.forEach((g, i) => {
      expect(g.from[0]).toBeCloseTo(GUIDES[i]?.from[0] ?? Number.NaN, 12);
      expect(g.to[1]).toBeCloseTo(GUIDES[i]?.to[1] ?? Number.NaN, 12);
    });
  });

  it('leaves the crop alone with Constrain Crop off, and refits it when turned back on', () => {
    store().setConstrainCrop('f1', false);
    store().setTransform('f1', { vertical: -40 });
    expect(geometry().crop).toBeNull();
    store().setConstrainCrop('f1', true);
    const crop = geometry().crop;
    expect(crop?.rect.w).toBeLessThan(1);
    const poly = warpedPolygon(geometry(), SIZE);
    if (crop && poly) expect(rectFitsPolygon(crop.rect, crop.angle, 1.5, poly, 1e-9)).toBe(true);
  });

  it('keeps a locked aspect when refitting', () => {
    store().setCropAspect('f1', [1, 1]);
    store().setTransform('f1', { horizontal: 50 });
    const crop = geometry().crop;
    expect(crop?.aspect).toEqual([1, 1]);
    expect(((crop?.rect.w ?? 0) * 1.5) / (crop?.rect.h ?? 1)).toBeCloseTo(1, 9);
  });

  it('resetTransform puts the sliders back (and Upright too with upright: true), the crop back to none', () => {
    seed();
    store().setTransform('f1', { vertical: -30, scale: 120 });
    store().setUprightResult('f1', { transform: UPRIGHT, focal: 0.8, mode: 'guided' });
    store().resetTransform('f1');
    expect(geometry().transform).toEqual(createDevelop().geometry.transform);
    expect(geometry().upright.mode).toBe('guided');
    store().resetTransform('f1', { upright: true });
    expect(geometry().upright).toEqual(createDevelop().geometry.upright);
    expect(geometry().crop).toBeNull();
  });
});

describe('Upright mode', () => {
  it('choosing a mode resets the manual sliders unless asked to keep them', () => {
    store().setTransform('f1', { vertical: -30 });
    store().setUprightMode('f1', 'guided');
    expect(geometry().upright.mode).toBe('guided');
    expect(geometry().transform.vertical).toBe(0);
    store().setTransform('f1', { vertical: -30 });
    store().setUprightMode('f1', 'off', { keepTransform: true });
    expect(geometry().upright.mode).toBe('off');
    expect(geometry().transform.vertical).toBe(-30);
    // The same mode again changes nothing.
    store().setUprightMode('f1', 'off');
    expect(geometry().transform.vertical).toBe(-30);
  });

  it('off keeps the stored transform and guides but ignores them; the guides follow the picture back', () => {
    seed();
    store().setUprightResult('f1', { transform: UPRIGHT, focal: 0.78, mode: 'guided' });
    const warped = geometry().upright.guides;
    expect(warped[0]?.from).not.toEqual(GUIDES[0]?.from);
    store().setUprightMode('f1', 'off');
    expect(geometry().upright.transform).toEqual(UPRIGHT);
    expect(geometry().upright.guides).toHaveLength(2);
    geometry().upright.guides.forEach((g, i) => {
      expect(g.from[0]).toBeCloseTo(GUIDES[i]?.from[0] ?? Number.NaN, 12);
      expect(g.from[1]).toBeCloseTo(GUIDES[i]?.from[1] ?? Number.NaN, 12);
    });
    expect(perspectiveMatrix(geometry(), 1200, 800)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    store().setUprightMode('f1', 'guided');
    expect(geometry().upright.guides[0]?.from[0]).toBeCloseTo(warped[0]?.from[0] ?? Number.NaN, 12);
  });

  it('a 90° turn carries the Upright transform with the frame', () => {
    seed();
    store().setUprightResult('f1', { transform: UPRIGHT, focal: null, mode: 'guided' });
    const before = structuredClone(geometry());
    store().rotate90('f1', 1);
    const after = geometry();
    expect(after.rotate).toBe(90);
    // A source point lands where the clockwise turn of the screen puts it: (u, v) → (1 − v, u).
    for (const p of [
      [0.2, 0.3],
      [0.8, 0.6],
    ] as const) {
      const [u, v] = applyMat(preCropMatrix(before, 1200, 800), p);
      const [u2, v2] = applyMat(preCropMatrix(after, 1200, 800), p);
      expect(u2).toBeCloseTo(1 - v, 12);
      expect(v2).toBeCloseTo(u, 12);
    }
    // The guides turned with it.
    const g = after.upright.guides[0];
    const was = before.upright.guides[0];
    expect(g?.from[0]).toBeCloseTo(1 - (was?.from[1] ?? 0), 12);
  });
});

describe('resetCrop (the crop tool Reset)', () => {
  it('resets orientation and crop but keeps Upright and the Transform, refitting the crop', () => {
    seed();
    store().setUprightResult('f1', { transform: UPRIGHT, focal: null, mode: 'guided' });
    store().setTransform('f1', { vertical: -20 });
    store().rotate90('f1', 1);
    store().flip('f1', 'h');
    store().resetCrop('f1');
    const g = geometry();
    expect([g.rotate, g.flipH, g.flipV]).toEqual([0, false, false]);
    expect(g.transform.vertical).toBe(-20);
    expect(g.upright.mode).toBe('guided');
    // The Upright transform turned back with the frame.
    g.upright.transform?.forEach((v, i) => {
      expect(v).toBeCloseTo(UPRIGHT[i] ?? Number.NaN, 12);
    });
    const poly = warpedPolygon(g, SIZE);
    expect(g.crop && poly && rectFitsPolygon(g.crop.rect, g.crop.angle, 1.5, poly, 1e-9)).toBe(true);
    // resetGeometry still resets everything.
    store().resetGeometry('f1');
    expect(geometry()).toEqual(createDevelop().geometry);
  });
});

describe('updateUpright', () => {
  it('solves the guides mapped back to the oriented frame and stores the result as one undo step', async () => {
    seed();
    store().setTransform('f1', { vertical: -20 });
    const stored = structuredClone(geometry().upright.guides);
    mocks.solve.mockResolvedValue({ transform: UPRIGHT, focal: 0.7, residual: 0.01, correction: 'vertical' });
    useBookStore.temporal.getState().clear();
    const outcome = await store().updateUpright('f1');
    expect(outcome).toEqual({ ok: true, correction: 'vertical', residual: 0.01 });
    expect(mocks.solve).toHaveBeenCalledTimes(1);
    const [guides, fw, fh, focal] = mocks.solve.mock.calls[0] ?? [];
    expect([fw, fh, focal]).toEqual([1200, 800, null]);
    // The stored guides are in the transformed frame; the solver got them through perspectiveMatrix⁻¹.
    const back = invert(perspectiveMatrix({ ...geometry(), upright: createDevelop().geometry.upright }, 1200, 800));
    expect(back).not.toBeNull();
    const sent = (guides as UprightGuide[])[0];
    const expected = applyMat(back ?? [], stored[0]?.from ?? [0, 0]);
    expect(sent?.from[0]).toBeCloseTo(expected[0], 12);
    expect(sent?.from[1]).toBeCloseTo(expected[1], 12);
    expect(sent?.from[0]).toBeCloseTo(GUIDES[0]?.from[0] ?? Number.NaN, 12);
    expect(geometry().upright).toMatchObject({ mode: 'guided', transform: UPRIGHT, focal: 0.7 });
    // The manual sliders stay (only choosing a mode resets them).
    expect(geometry().transform.vertical).toBe(-20);
    undo();
    expect(geometry().upright.transform).toBeNull();
    expect(geometry().upright.guides).toEqual(stored);
  });

  it('writes nothing for an invalid combination and returns the message', async () => {
    seed();
    store().setUprightGuides('f1', GUIDES.slice(0, 1));
    mocks.solve.mockRejectedValue(
      'InvalidGuides: 0 horizontal and 1 vertical guides; use 2H, 2V, 2H+2V, 2H+1V, 2V+1H or 1V+1H',
    );
    const outcome = await store().updateUpright('f1');
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toMatch(/2 horizontal or 2 vertical/);
    expect(geometry().upright.transform).toBeNull();
    expect(geometry().upright.mode).toBe('off');
  });

  it('no guides clears the transform without calling the solver', async () => {
    store().setUprightResult('f1', { transform: UPRIGHT, focal: 0.8, mode: 'guided' });
    const outcome = await store().updateUpright('f1');
    expect(outcome).toEqual({ ok: true, correction: null, residual: null });
    expect(mocks.solve).not.toHaveBeenCalled();
    expect(geometry().upright.transform).toBeNull();
  });

  it('drops a result when the guides changed while it was solving', async () => {
    seed();
    let resolve: (v: unknown) => void = () => {};
    mocks.solve.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = store().updateUpright('f1');
    store().setUprightGuides('f1', GUIDES.slice(0, 1));
    resolve({ transform: UPRIGHT, focal: 0.7, residual: 0, correction: 'vertical' });
    expect(await pending).toEqual({ ok: false, message: '' });
    expect(geometry().upright.transform).toBeNull();
  });
});

it('the oriented size helper agrees with the frame the solver is given', () => {
  expect(orientedSize(90, 1200, 800)).toEqual([800, 1200]);
});
