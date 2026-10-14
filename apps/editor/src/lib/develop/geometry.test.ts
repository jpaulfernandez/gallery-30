/**
 * Parity with `crates/develop/src/geometry/`: every case of the fixtures the Rust writes
 * (`crates/develop/tests/fixtures/geometry/*.json`, regenerated with
 * `UPDATE_GEOMETRY_FIXTURES=1 cargo test -p photobook-develop --test geometry`) must agree to the fixture's
 * tolerance (1e-9; 1e-6 for `maxCropInWarped`). `guided-solve.json` is not ported (the solver stays in Rust).
 */
import { createDevelop, type DevelopGeometry, type ManualTransform } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  applyMat,
  type CropRect,
  constrainCrop,
  fitScaleInPolygon,
  fixedAspectHalfWidth,
  flipRect,
  foldAngle,
  geometryPlan,
  hasPerspective,
  invert,
  isIdentityTransform,
  largestRectInQuad,
  manualMatrix,
  maxAreaRectInRotated,
  maxCrop,
  maxCropInWarped,
  nextRotation,
  orientationMatrix,
  type PlanGeometry,
  perspectiveMatrix,
  preCropMatrix,
  type Quad,
  remapPoints,
  rotateRect90,
  uprightMatrix,
  warpedRegion,
} from './geometry';

// Vite inlines the JSON at transform time (the editor has no Node types to read files with).
const FIXTURES = import.meta.glob<Fixture<unknown, unknown>>(
  '../../../../../crates/develop/tests/fixtures/geometry/*.json',
  {
    eager: true,
    import: 'default',
  },
);

interface Fixture<I, O> {
  function: string;
  tolerance: number;
  cases: Array<{ input: I; output: O } & Record<string, unknown>>;
}

function load<I, O>(name: string): Fixture<I, O> {
  const key = Object.keys(FIXTURES).find((k) => k.endsWith(`/${name}.json`));
  const fixture = key ? FIXTURES[key] : undefined;
  if (!fixture) throw new Error(`missing fixture ${name}.json`);
  return fixture as Fixture<I, O>;
}

/** Numbers within `tol` (relative above 1), everything else structurally equal; returns the first mismatch. */
function mismatch(a: unknown, b: unknown, tol: number, path = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const m = mismatch(a[i], b[i], tol, `${path}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(b);
    if (Object.keys(a).length !== keys.length) return `${path}: keys ${Object.keys(a)} vs ${keys}`;
    for (const k of keys) {
      const m = mismatch((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol, `${path}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
}

function checkAll<I, O>(fixture: Fixture<I, O>, run: (input: I) => unknown): number {
  const failures: string[] = [];
  fixture.cases.forEach((c, i) => {
    const m = mismatch(run(c.input), c.output, fixture.tolerance);
    if (m) failures.push(`case ${i} ${JSON.stringify(c.input).slice(0, 160)}${m}`);
  });
  expect(failures).toEqual([]);
  return fixture.cases.length;
}

describe('geometry parity with crates/develop', () => {
  let total = 0;

  it('maxAreaRectInRotated', () => {
    const f = load<{ w: number; h: number; angle: number }, { w: number; h: number }>('max-area-rect');
    expect(f.function).toBe('maxAreaRectInRotated');
    total += checkAll(f, ({ w, h, angle }) => maxAreaRectInRotated(w, h, angle));
  });

  it('fixedAspectHalfWidth', () => {
    const f = load<{ a: number; b: number; r: number; angle: number }, { halfWidth: number }>('fixed-aspect');
    expect(f.function).toBe('fixedAspectHalfWidth');
    total += checkAll(f, ({ a, b, r, angle }) => ({ halfWidth: fixedAspectHalfWidth(a, b, r, angle) }));
  });

  it('constrainCrop (and maxCrop on the full-frame cases)', () => {
    type In = { rect: CropRect; aspect: number | null; angle: number; imageAspect: number };
    const f = load<In, CropRect>('constrain-crop');
    expect(f.function).toBe('constrainCrop');
    total += checkAll(f, ({ rect, aspect, angle, imageAspect }) => constrainCrop(rect, aspect, angle, imageAspect));
    const full = f.cases.filter((c) => c.maxCrop === true);
    expect(full.length).toBeGreaterThan(0);
    for (const c of full) {
      const m = mismatch(maxCrop(c.input.aspect, c.input.angle, c.input.imageAspect), c.output, f.tolerance);
      expect(m).toBeNull();
    }
  });

  it('largestRectInQuad', () => {
    type In = { quad: Quad; center: [number, number]; aspect: number };
    const f = load<In, { halfWidth: number; halfHeight: number }>('rect-in-quad');
    expect(f.function).toBe('largestRectInQuad');
    total += checkAll(f, ({ quad, center, aspect }) => largestRectInQuad(quad, center, aspect));
  });

  it('geometryPlan (every case: orientation, crop, straighten, Upright and the manual Transform)', () => {
    type In = { geometry: DevelopGeometry; sourceWidth: number; sourceHeight: number; targetLongEdge: number | null };
    const f = load<In, Record<string, unknown>>('geometry-plan');
    expect(f.function).toBe('geometryPlan');
    const perspective = f.cases.filter(
      (c) => c.input.geometry.upright.mode !== 'off' || !isIdentityTransform(c.input.geometry.transform),
    );
    expect(perspective.length).toBeGreaterThanOrEqual(12);
    total += checkAll(f, ({ geometry, sourceWidth, sourceHeight, targetLongEdge }) =>
      geometryPlan(geometry, sourceWidth, sourceHeight, targetLongEdge),
    );
  });

  it('manualMatrix', () => {
    type In = ManualTransform & { frameW: number; frameH: number; focal: number | null };
    const f = load<In, { matrix: number[] }>('manual-matrix');
    expect(f.function).toBe('manualMatrix');
    total += checkAll(f, ({ frameW, frameH, focal, ...t }) => ({
      matrix: [...manualMatrix(t, frameW, frameH, focal)],
    }));
  });

  it('maxCropInWarped', () => {
    type In = { geometry: DevelopGeometry; frameW: number; frameH: number };
    const f = load<In, CropRect>('max-crop-warped');
    expect(f.function).toBe('maxCropInWarped');
    total += checkAll(f, ({ geometry, frameW, frameH }) => maxCropInWarped(geometry, frameW, frameH));
  });

  it('remapPoints', () => {
    type In = { hOld: number[]; hNew: number[]; points: [number, number][] };
    const f = load<In, { points: [number, number][] }>('remap-points');
    expect(f.function).toBe('remapPoints');
    // Each case maps 7 points.
    total += checkAll(f, ({ hOld, hNew, points }) => ({ points: remapPoints(points, hOld, hNew) }));
  });

  it('covers every fixture case except the solver', () => {
    // 28 + 56 + 336 + 40 + 42 + 52 + 16 + 4 when the D2.2 fixtures were written; more if the Rust adds cases.
    expect(total).toBeGreaterThanOrEqual(574);
    // guided-solve.json stays in Rust (the UI calls `solve_upright_guides`).
    expect(Object.keys(FIXTURES).filter((k) => !k.endsWith('/guided-solve.json'))).toHaveLength(8);
  });
});

const base: PlanGeometry = { rotate: 0, flipH: false, flipV: false, constrainCrop: true, crop: null };
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-12);

describe('geometry helpers', () => {
  it('maxCrop at 0° is the full frame', () => {
    expect(maxCrop(null, 0, 1.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(maxCrop(1.5, 0, 1.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('a 3:2 image with a 1:1 crop develops square', () => {
    const plan = geometryPlan(
      { ...base, crop: { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, aspect: [1, 1] } },
      6000,
      4000,
      null,
    );
    expect([plan.developedWidth, plan.developedHeight]).toEqual([4000, 4000]);
    expect(plan.crop.x).toBeCloseTo(1 / 6, 12);
  });

  it('rotating the rect 90° keeps the same pixels selected', () => {
    // A rect in the frame of an unrotated 6000×4000 source...
    const rect: CropRect = { x: 0.1, y: 0.2, w: 0.3, h: 0.5 };
    const before: DevelopGeometry['rotate'] = 0;
    for (const dir of [1, -1] as const) {
      const g0 = { rotate: before, flipH: false, flipV: false };
      const g1 = { ...g0, rotate: nextRotation(g0, dir) };
      const moved = rotateRect90(rect, dir);
      // ...maps the source corner under it to the same corner of the remapped rect.
      const sourceTopLeft = applyMat(invert(orientationMatrix(g0)) ?? [], [rect.x, rect.y]);
      const [u, v] = applyMat(orientationMatrix(g1), sourceTopLeft);
      const corners = [
        [moved.x, moved.y],
        [moved.x + moved.w, moved.y],
        [moved.x + moved.w, moved.y + moved.h],
        [moved.x, moved.y + moved.h],
      ];
      expect(corners.some(([x, y]) => Math.abs((x ?? 0) - u) < 1e-12 && Math.abs((y ?? 0) - v) < 1e-12)).toBe(true);
      close(moved.w, rect.h);
      close(moved.h, rect.w);
    }
    // Four clockwise turns are the identity, with or without a flip.
    for (const flipH of [false, true]) {
      let g = { rotate: 0 as DevelopGeometry['rotate'], flipH, flipV: false };
      let r = rect;
      for (let i = 0; i < 4; i++) {
        g = { ...g, rotate: nextRotation(g, 1) };
        r = rotateRect90(r, 1);
      }
      expect(g.rotate).toBe(0);
      close(r.x, rect.x);
      close(r.y, rect.y);
    }
  });

  it('a clockwise turn on screen with one flip on is a counter-clockwise rotate', () => {
    // Top-left of the displayed picture goes to the top-right after a clockwise turn, whatever the flips.
    for (const [flipH, flipV] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const g0 = { rotate: 90 as DevelopGeometry['rotate'], flipH, flipV };
      const g1 = { ...g0, rotate: nextRotation(g0, 1) };
      // The source point displayed at the top-left before the turn...
      const src = applyMat(invert(orientationMatrix(g0)) ?? [], [0, 0]);
      // ...is displayed at the top-right after it.
      const [u, v] = applyMat(orientationMatrix(g1), src);
      close(u, 1);
      close(v, 0);
    }
  });

  it('flipRect mirrors the rect', () => {
    expect(flipRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'h').x).toBeCloseTo(0.6, 12);
    expect(flipRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 'v').y).toBeCloseTo(0.4, 12);
  });

  it('foldAngle keeps a line level or plumb', () => {
    expect(foldAngle(3)).toBe(3);
    expect(foldAngle(-87)).toBe(3);
    expect(foldAngle(92)).toBe(2);
    expect(foldAngle(178)).toBe(-2);
    expect(foldAngle(-180)).toBe(0);
  });

  it('a straighten rect of the plan stays inside the rotated image', () => {
    const plan = geometryPlan(
      { ...base, crop: { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 10, aspect: 'free' } },
      600,
      400,
      null,
    );
    // The output corners map back inside the source.
    for (const p of [
      [0, 0],
      [plan.outputWidth, 0],
      [plan.outputWidth, plan.outputHeight],
      [0, plan.outputHeight],
    ] as const) {
      const [x, y] = applyMat(plan.inverse, p);
      expect(x).toBeGreaterThan(-1e-6);
      expect(y).toBeGreaterThan(-1e-6);
      expect(x).toBeLessThan(600 + 1e-6);
      expect(y).toBeLessThan(400 + 1e-6);
    }
  });
});

describe('perspective helpers', () => {
  const persp = (transform: Partial<ManualTransform>, rest: Partial<DevelopGeometry> = {}): DevelopGeometry => ({
    ...createDevelop().geometry,
    ...rest,
    transform: { ...createDevelop().geometry.transform, ...transform },
  });
  const edge = (m: readonly number[], a: [number, number], b: [number, number]) => {
    const [x0, y0] = applyMat(m, a);
    const [x1, y1] = applyMat(m, b);
    return Math.hypot(x1 - x0, y1 - y0);
  };

  it('Vertical −30 widens the top, +30 widens the bottom; Horizontal + enlarges the right', () => {
    const top = (m: readonly number[]) => edge(m, [0, 0], [1, 0]);
    const bottom = (m: readonly number[]) => edge(m, [0, 1], [1, 1]);
    const minus = manualMatrix(persp({ vertical: -30 }).transform, 6000, 4000);
    const plus = manualMatrix(persp({ vertical: 30 }).transform, 6000, 4000);
    expect(top(minus)).toBeGreaterThan(bottom(minus));
    expect(bottom(plus)).toBeGreaterThan(top(plus));
    const h = manualMatrix(persp({ horizontal: 30 }).transform, 6000, 4000);
    expect(edge(h, [1, 0], [1, 1])).toBeGreaterThan(edge(h, [0, 0], [0, 1]));
    // The centre stays put.
    const [cx, cy] = applyMat(minus, [0.5, 0.5]);
    close(cx, 0.5);
    close(cy, 0.5);
  });

  it('maxCropInWarped stays inside the warped outline and keeps the aspect', () => {
    for (const g of [
      persp({ vertical: -60 }),
      persp({ horizontal: 45, rotate: 4 }),
      persp({ vertical: 25, aspect: 30 }, { crop: { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 6, aspect: [1, 1] } }),
    ]) {
      const [fw, fh] = [6000, 4000];
      const ia = fw / fh;
      const rect = maxCropInWarped(g, fw, fh);
      const poly = warpedRegion(perspectiveMatrix(g, fw, fh), fw, fh);
      expect(poly).not.toBeNull();
      const angle = g.crop?.angle ?? 0;
      const hw = (rect.w * ia) / 2;
      const hh = rect.h / 2;
      expect(
        fitScaleInPolygon(poly ?? [], [rect.x * ia + hw, rect.y + hh], hw * (1 - 1e-9), hh * (1 - 1e-9), angle),
      ).toBe(1);
      const want = g.crop?.aspect === 'free' || !g.crop ? ia : 1;
      expect((rect.w * ia) / rect.h).toBeCloseTo(want, 9);
      expect(rect.w).toBeLessThan(1);
    }
  });

  it('the plan of a warped geometry maps its output corners inside the source', () => {
    const g = persp({ vertical: -50, rotate: 3 });
    const plan = geometryPlan(g, 600, 400, null);
    expect(plan.developedWidth).toBeLessThan(600);
    for (const p of [
      [0, 0],
      [plan.outputWidth, 0],
      [plan.outputWidth, plan.outputHeight],
      [0, plan.outputHeight],
    ] as const) {
      const [x, y] = applyMat(plan.inverse, p);
      expect(x).toBeGreaterThan(-1e-6);
      expect(y).toBeGreaterThan(-1e-6);
      expect(x).toBeLessThan(600 + 1e-6);
      expect(y).toBeLessThan(400 + 1e-6);
    }
  });

  it('upright off ignores a stored transform; preCropMatrix is orientation then perspective', () => {
    const t = [1.1, 0.05, -0.06, 0.09, 1.2, -0.08, 0.12, 0.13, 1];
    const off = persp({}, { upright: { mode: 'off', guides: [], transform: t, focal: null } });
    expect(hasPerspective(off)).toBe(false);
    expect([...uprightMatrix(off.upright)]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const on = persp(
      { scale: 120 },
      { rotate: 90, upright: { mode: 'guided', guides: [], transform: t, focal: null } },
    );
    const m = preCropMatrix(on, 1200, 800);
    const p: [number, number] = [0.3, 0.7];
    const expected = applyMat(perspectiveMatrix(on, 800, 1200), applyMat(orientationMatrix(on), p));
    const got = applyMat(m, p);
    close(got[0], expected[0]);
    close(got[1], expected[1]);
  });
});
