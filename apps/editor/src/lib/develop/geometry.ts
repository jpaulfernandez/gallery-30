/**
 * Geometry maths for the crop tool and the Transform section: the TypeScript twin of
 * `crates/develop/src/geometry/` (`crop.rs`, `homography.rs`, `orientation.rs`, `transform.rs`, `remap.rs`,
 * `nelder_mead.rs`). The functions are transliterated line by line so the parity fixtures in
 * `crates/develop/tests/fixtures/geometry/` hold (1e-9, 1e-6 for `maxCropInWarped`); keep the arithmetic in the
 * same order as the Rust when editing either side. The guided Upright solver is not ported: the UI calls the
 * `solve_upright_guides` command.
 *
 * **The crop model.** The crop rectangle is axis-aligned and stored in fractions of the *transformed,
 * uncropped* frame (after rotate/flip, Upright and the manual Transform). The straighten angle turns the
 * picture (not the frame) about the crop centre, clockwise for a positive angle, in frame pixels. Working in
 * frame units where the frame is `imageAspect` wide and 1 high keeps rotations metric.
 */
import type { DevelopCrop, DevelopGeometry, ManualTransform, Upright } from '@photobook/shared';

// ---------- homography ----------

/**
 * A 3×3 projective transform, row-major, acting on column vectors `[x, y, 1]`:
 * `x' = (m0·x + m1·y + m2) / (m6·x + m7·y + m8)`, `y' = (m3·x + m4·y + m5) / (m6·x + m7·y + m8)`.
 */
export type Mat3 = readonly number[];

export const identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const translate = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];
export const scale = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

/** Rotation by `radians` about the origin; in image coordinates (y down) positive turns clockwise. */
export function rotate(radians: number): Mat3 {
  const s = Math.sin(radians);
  const c = Math.cos(radians);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Matrix product `a · b` (applies `b` first). */
export function compose(a: Mat3, b: Mat3): Mat3 {
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] =
        (a[r * 3] ?? 0) * (b[c] ?? 0) + (a[r * 3 + 1] ?? 0) * (b[3 + c] ?? 0) + (a[r * 3 + 2] ?? 0) * (b[6 + c] ?? 0);
    }
  }
  return m;
}

/**
 * `first`, then `next`: the matrix `next · first` (Rust `first.then(&next)`). Not exported as `then`: that would
 * make this module's namespace a thenable, and `await import()` of it would hang.
 */
export const andThen = (first: Mat3, next: Mat3): Mat3 => compose(next, first);

/** Rotation by `radians` about `(cx, cy)`. */
export const rotateAbout = (radians: number, cx: number, cy: number): Mat3 =>
  andThen(andThen(translate(-cx, -cy), rotate(radians)), translate(cx, cy));

const at = (m: Mat3, i: number): number => m[i] ?? 0;

export function determinant(m: Mat3): number {
  return (
    at(m, 0) * (at(m, 4) * at(m, 8) - at(m, 5) * at(m, 7)) -
    at(m, 1) * (at(m, 3) * at(m, 8) - at(m, 5) * at(m, 6)) +
    at(m, 2) * (at(m, 3) * at(m, 7) - at(m, 4) * at(m, 6))
  );
}

/** The inverse, or null when the matrix is singular (relative determinant at most 1e-12). */
export function invert(m: Mat3): Mat3 | null {
  const det = determinant(m);
  const norm = m.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
  if (!Number.isFinite(det) || norm === 0 || Math.abs(det) <= 1e-12 * norm * norm * norm) return null;
  const inv = 1 / det;
  return [
    (at(m, 4) * at(m, 8) - at(m, 5) * at(m, 7)) * inv,
    (at(m, 2) * at(m, 7) - at(m, 1) * at(m, 8)) * inv,
    (at(m, 1) * at(m, 5) - at(m, 2) * at(m, 4)) * inv,
    (at(m, 5) * at(m, 6) - at(m, 3) * at(m, 8)) * inv,
    (at(m, 0) * at(m, 8) - at(m, 2) * at(m, 6)) * inv,
    (at(m, 2) * at(m, 3) - at(m, 0) * at(m, 5)) * inv,
    (at(m, 3) * at(m, 7) - at(m, 4) * at(m, 6)) * inv,
    (at(m, 1) * at(m, 6) - at(m, 0) * at(m, 7)) * inv,
    (at(m, 0) * at(m, 4) - at(m, 1) * at(m, 3)) * inv,
  ];
}

/** Divide through by `m8` (when it is not ~0). */
export function normalized(m: Mat3): Mat3 {
  const d = at(m, 8);
  if (Math.abs(d) < 1e-300) return m;
  return m.map((v) => v / d);
}

/** Map a point (homogeneous divide). */
export function applyMat(m: Mat3, [x, y]: readonly [number, number]): [number, number] {
  const w = at(m, 6) * x + at(m, 7) * y + at(m, 8);
  return [(at(m, 0) * x + at(m, 1) * y + at(m, 2)) / w, (at(m, 3) * x + at(m, 4) * y + at(m, 5)) / w];
}

/** Whether the bottom row is `[0, 0, 1]` (after normalising), within `eps`. */
export function isAffine(m: Mat3, eps: number): boolean {
  const n = normalized(m);
  return Math.abs(at(n, 6)) <= eps && Math.abs(at(n, 7)) <= eps;
}

/** Jacobian `[[∂x'/∂x, ∂x'/∂y], [∂y'/∂x, ∂y'/∂y]]` at `p`, row-major `[a, b, c, d]`. */
export function jacobian(m: Mat3, [x, y]: readonly [number, number]): [number, number, number, number] {
  const w = at(m, 6) * x + at(m, 7) * y + at(m, 8);
  const u = at(m, 0) * x + at(m, 1) * y + at(m, 2);
  const v = at(m, 3) * x + at(m, 4) * y + at(m, 5);
  const w2 = w * w;
  return [
    (at(m, 0) * w - u * at(m, 6)) / w2,
    (at(m, 1) * w - u * at(m, 7)) / w2,
    (at(m, 3) * w - v * at(m, 6)) / w2,
    (at(m, 4) * w - v * at(m, 7)) / w2,
  ];
}

// ---------- orientation ----------

export type Rotation = DevelopGeometry['rotate'];

/** Normalised map for a clockwise rotation (90 and 270 swap the axes). */
export function rotationMatrix(rotation: Rotation): Mat3 {
  switch (rotation) {
    case 90:
      return [0, -1, 1, 1, 0, 0, 0, 0, 1];
    case 180:
      return [-1, 0, 1, 0, -1, 1, 0, 0, 1];
    case 270:
      return [0, 1, 0, -1, 0, 1, 0, 0, 1];
    default:
      return identity();
  }
}

/** Normalised map for the flips: `flipH` is (u, v) → (1 − u, v), `flipV` is (u, v) → (u, 1 − v). */
export function flipMatrix(flipH: boolean, flipV: boolean): Mat3 {
  const [sx, tx] = flipH ? [-1, 1] : [1, 0];
  const [sy, ty] = flipV ? [-1, 1] : [1, 0];
  return [sx, 0, tx, 0, sy, ty, 0, 0, 1];
}

/** `O_orientation`: rotate, then flip (the flips act on the image as the user sees it). */
export const orientationMatrix = (g: Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV'>): Mat3 =>
  andThen(rotationMatrix(g.rotate), flipMatrix(g.flipH, g.flipV));

/** Size of the oriented image: `[width, height]` swapped for 90 and 270. */
export function orientedSize(rotation: Rotation, width: number, height: number): [number, number] {
  return rotation === 90 || rotation === 270 ? [height, width] : [width, height];
}

// ---------- inscribed rectangles ----------

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * The classic maximum-area axis-aligned rectangle inside a `w × h` rectangle rotated by `angleDeg`, both
 * centred on the same point (free aspect). Half-constrained when the short side is at most `2·sin·cos·long`.
 */
export function maxAreaRectInRotated(w: number, h: number, angleDeg: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const widthIsLonger = w >= h;
  const [long, short] = widthIsLonger ? [w, h] : [h, w];
  const a = rad(angleDeg);
  const sinA = Math.abs(Math.sin(a));
  const cosA = Math.abs(Math.cos(a));
  if (short <= 2 * sinA * cosA * long || Math.abs(sinA - cosA) < 1e-10) {
    const x = 0.5 * short;
    return widthIsLonger ? { w: x / sinA, h: x / cosA } : { w: x / cosA, h: x / sinA };
  }
  const cos2a = cosA * cosA - sinA * sinA;
  return { w: (w * cosA - h * sinA) / cos2a, h: (h * cosA - w * sinA) / cos2a };
}

/**
 * Half width of the largest rectangle of aspect `r` (width / height) centred on a point whose distances to the
 * nearest vertical and horizontal edges of the unrotated image are `a` and `b`, when the image is rotated by
 * `angleDeg` about that point. The half height is `p / r`.
 */
export function fixedAspectHalfWidth(a: number, b: number, r: number, angleDeg: number): number {
  const phi = rad(angleDeg);
  const s = Math.abs(Math.sin(phi));
  const c = Math.abs(Math.cos(phi));
  const p1 = a / (c + s / r);
  const p2 = b / (s + c / r);
  return Math.max(Math.min(p1, p2), 0);
}

export type Point = readonly [number, number];
export type Quad = readonly [Point, Point, Point, Point];

/** Whether `p` is inside (or on) the convex polygon `quad` (either winding). */
export function pointInConvexQuad(quad: Quad, p: Point): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i] as Point;
    const b = quad[(i + 1) % 4] as Point;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
  }
  return !(pos && neg);
}

/** Bisection steps in `largestRectInQuad`, the same as the Rust so both give identical numbers. */
export const QUAD_SEARCH_STEPS = 64;

/**
 * The largest axis-aligned rectangle of `aspect` (width / height) centred on `center` inside the convex
 * `quad`, by bisection on the half width. `{0, 0}` when the centre is outside the quad.
 */
export function largestRectInQuad(
  quad: Quad,
  center: Point,
  aspect: number,
): { halfWidth: number; halfHeight: number } {
  if (!(aspect > 0) || !pointInConvexQuad(quad, center)) return { halfWidth: 0, halfHeight: 0 };
  const [cx, cy] = center;
  const fits = (hw: number) => {
    const hh = hw / aspect;
    const corners: Point[] = [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];
    return corners.every((p) => pointInConvexQuad(quad, p));
  };
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  let lo = 0;
  let hi = Math.max(spanX, spanY * aspect);
  for (let i = 0; i < QUAD_SEARCH_STEPS; i++) {
    const mid = 0.5 * (lo + hi);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { halfWidth: lo, halfHeight: lo / aspect };
}

const clampN = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Make a crop valid for a straighten angle (`rect` in fractions of a frame whose width / height is
 * `imageAspect`): at angle 0 intersected with the frame; narrowed to `aspect` (width / height in frame
 * pixels) about its centre when given; centre clamped into the frame; shrunk about the centre until it fits
 * inside the image rotated by `angleDeg` about that centre. A rectangle that already fits is returned as is
 * (the same object), never enlarged. For "fill the frame at this angle" use `maxCrop`.
 */
export function constrainCrop(rect: CropRect, aspect: number | null, angleDeg: number, imageAspect: number): CropRect {
  const fw = imageAspect;
  let changed = false;
  let x0 = rect.x * fw;
  let y0 = rect.y;
  let x1 = (rect.x + rect.w) * fw;
  let y1 = rect.y + rect.h;
  if (angleDeg === 0 && (x0 < 0 || y0 < 0 || x1 > fw || y1 > 1)) {
    changed = true;
    x0 = Math.max(x0, 0);
    y0 = Math.max(y0, 0);
    x1 = Math.min(x1, fw);
    y1 = Math.min(y1, 1);
  }
  let cx = 0.5 * (x0 + x1);
  let cy = 0.5 * (y0 + y1);
  let hw = Math.max(0.5 * (x1 - x0), 0);
  let hh = Math.max(0.5 * (y1 - y0), 0);
  if (aspect !== null && aspect > 0 && Number.isFinite(aspect)) {
    const r = aspect;
    // Only when the aspect is off by more than rounding, so a locked rect comes back unchanged.
    if (hh > 0 && Math.abs(hw / hh - r) > 1e-12 * r) {
      changed = true;
      if (hw / hh > r) hw = hh * r;
      else hh = hw / r;
    }
  }
  if (cx < 0 || cx > fw || cy < 0 || cy > 1) {
    changed = true;
    cx = clampN(cx, 0, fw);
    cy = clampN(cy, 0, 1);
  }
  const phi = rad(angleDeg);
  const s = Math.abs(Math.sin(phi));
  const c = Math.abs(Math.cos(phi));
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  const a = Math.min(cx, fw - cx);
  const b = Math.min(cy, 1 - cy);
  let k = 1;
  if (ex > a) k = Math.min(k, a / ex);
  if (ey > b) k = Math.min(k, b / ey);
  if (k < 1) {
    changed = true;
    hw *= k;
    hh *= k;
  }
  if (!changed) return rect;
  return { x: (cx - hw) / fw, y: cy - hh, w: (2 * hw) / fw, h: 2 * hh };
}

/**
 * The largest crop of `aspect` (null keeps the frame's own aspect) centred in the frame for the straighten
 * angle: what the crop becomes when constrain-to-image is on and the user rotates an uncropped photo.
 */
export const maxCrop = (aspect: number | null, angleDeg: number, imageAspect: number): CropRect =>
  constrainCrop({ x: 0, y: 0, w: 1, h: 1 }, aspect, angleDeg, imageAspect);

// ---------- convex polygons (the warped outline) ----------

/** Whether `p` is inside (or on) the convex polygon `poly` (either winding, at least 3 vertices). */
export function pointInConvexPolygon(poly: readonly Point[], p: Point): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let pos = false;
  let neg = false;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Point;
    const b = poly[(i + 1) % n] as Point;
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cross > 0) pos = true;
    else if (cross < 0) neg = true;
  }
  return !(pos && neg);
}

/** Sutherland–Hodgman clip of the convex `poly` to `[0, frameW] × [0, frameH]` (left, right, top, bottom). */
export function clipToFrame(poly: readonly Point[], frameW: number, frameH: number): Point[] {
  const edges: Array<[0 | 1, number, boolean]> = [
    [0, 0, true],
    [0, frameW, false],
    [1, 0, true],
    [1, frameH, false],
  ];
  let out: Point[] = [...poly];
  for (const [axis, bound, keepGreater] of edges) {
    if (out.length === 0) break;
    const inside = (p: Point) => (keepGreater ? p[axis] >= bound : p[axis] <= bound);
    const input = out;
    out = [];
    const n = input.length;
    for (let i = 0; i < n; i++) {
      const cur = input[i] as Point;
      const prev = input[(i + n - 1) % n] as Point;
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci !== pi) {
        const t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
        const q: [number, number] = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
        q[axis] = bound;
        out.push(q);
      }
      if (ci) out.push(cur);
    }
  }
  return out;
}

/**
 * Largest `k ∈ [0, 1]` such that the rectangle of half extents `k·hw × k·hh` centred on `center` fits inside
 * the convex `poly` turned by `angleDeg` (clockwise) about `center`; bisection, `QUAD_SEARCH_STEPS` steps.
 */
export function fitScaleInPolygon(
  poly: readonly Point[],
  center: Point,
  hw: number,
  hh: number,
  angleDeg: number,
): number {
  if (poly.length < 3 || !pointInConvexPolygon(poly, center)) return 0;
  const [cx, cy] = center;
  const phi = rad(angleDeg);
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const turned: Point[] = poly.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    return [cx + c * dx - s * dy, cy + s * dx + c * dy];
  });
  const fits = (k: number) => {
    const w = hw * k;
    const h = hh * k;
    const corners: Point[] = [
      [cx - w, cy - h],
      [cx + w, cy - h],
      [cx + w, cy + h],
      [cx - w, cy + h],
    ];
    return corners.every((p) => pointInConvexPolygon(turned, p));
  };
  if (fits(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < QUAD_SEARCH_STEPS; i++) {
    const mid = 0.5 * (lo + hi);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const vertexAverage = (poly: readonly Point[]): [number, number] => {
  const n = poly.length;
  let sx = 0;
  let sy = 0;
  for (const p of poly) sx += p[0];
  for (const p of poly) sy += p[1];
  return [sx / n, sy / n];
};

/**
 * `constrainCrop` for a warped image: the valid region is the convex `poly` (frame units). Narrowed to
 * `aspect` about its centre, re-centred on the vertex average when the centre is outside, then shrunk about
 * its centre (never enlarged) until it fits the polygon turned by `angleDeg`. A fitting rect comes back as is.
 */
export function constrainCropInPolygon(
  rect: CropRect,
  aspect: number | null,
  angleDeg: number,
  imageAspect: number,
  poly: readonly Point[],
): CropRect {
  const fw = imageAspect;
  if (poly.length < 3) return rect;
  let changed = false;
  const x0 = rect.x * fw;
  const y0 = rect.y;
  const x1 = (rect.x + rect.w) * fw;
  const y1 = rect.y + rect.h;
  let cx = 0.5 * (x0 + x1);
  let cy = 0.5 * (y0 + y1);
  let hw = Math.max(0.5 * (x1 - x0), 0);
  let hh = Math.max(0.5 * (y1 - y0), 0);
  if (aspect !== null && aspect > 0 && Number.isFinite(aspect)) {
    const r = aspect;
    if (hh > 0 && Math.abs(hw / hh - r) > 1e-12 * r) {
      changed = true;
      if (hw / hh > r) hw = hh * r;
      else hh = hw / r;
    }
  }
  if (!pointInConvexPolygon(poly, [cx, cy])) {
    changed = true;
    [cx, cy] = vertexAverage(poly);
  }
  const k = fitScaleInPolygon(poly, [cx, cy], hw, hh, angleDeg);
  if (k < 1) {
    changed = true;
    hw *= k;
    hh *= k;
  }
  if (!changed) return rect;
  return { x: (cx - hw) / fw, y: cy - hh, w: (2 * hw) / fw, h: 2 * hh };
}

// ---------- Nelder–Mead (nelder_mead.rs) ----------

export const NELDER_MEAD_MAX_ITERATIONS = 600;

/**
 * Minimise `f` from `x0` (standard coefficients, axis-aligned initial simplex of side `step`, at most
 * `NELDER_MEAD_MAX_ITERATIONS`), as `nelder_mead::minimize`. Returns the best point and its value.
 */
export function nelderMead(
  f: (p: readonly number[]) => number,
  x0: readonly number[],
  step: number,
  fTol: number,
  xTol: number,
): [number[], number] {
  const N = x0.length;
  let pts: number[][] = [];
  for (let i = 0; i <= N; i++) {
    const p = [...x0];
    if (i > 0) p[i - 1] = (p[i - 1] ?? 0) + step;
    pts.push(p);
  }
  let vals = pts.map(f);
  const P = (i: number) => pts[i] as number[];
  const V = (i: number) => vals[i] as number;

  for (let iter = 0; iter < NELDER_MEAD_MAX_ITERATIONS; iter++) {
    const order = pts.map((_, i) => i).sort((a, b) => V(a) - V(b));
    pts = order.map((i) => P(i));
    vals = order.map((i) => V(i));

    const spread = V(N) - V(0);
    let diameter = 0;
    for (let i = 1; i <= N; i++) {
      let m = 0;
      for (let k = 0; k < N; k++) m = Math.max(m, Math.abs((P(i)[k] ?? 0) - (P(0)[k] ?? 0)));
      diameter = Math.max(diameter, m);
    }
    if (spread <= fTol && diameter <= xTol) break;

    const c = new Array<number>(N).fill(0);
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < N; k++) c[k] = (c[k] ?? 0) + (P(i)[k] ?? 0) / N;
    }
    const worst = P(N);
    const along = (t: number): number[] => c.map((ck, k) => ck + t * ((worst[k] ?? 0) - ck));

    const xr = along(-1);
    const fr = f(xr);
    if (fr < V(0)) {
      const xe = along(-2);
      const fe = f(xe);
      if (fe < fr) {
        pts[N] = xe;
        vals[N] = fe;
      } else {
        pts[N] = xr;
        vals[N] = fr;
      }
      continue;
    }
    if (fr < V(N - 1)) {
      pts[N] = xr;
      vals[N] = fr;
      continue;
    }
    const xc = fr < V(N) ? along(-0.5) : along(0.5);
    const fc = f(xc);
    if (fc < Math.min(V(N), fr)) {
      pts[N] = xc;
      vals[N] = fc;
      continue;
    }
    const best = P(0);
    for (let i = 1; i <= N; i++) {
      const p = P(i);
      pts[i] = best.map((b, k) => b + 0.5 * ((p[k] ?? 0) - b));
      vals[i] = f(P(i));
    }
  }
  let best = 0;
  for (let i = 0; i <= N; i++) if (V(i) < V(best)) best = i;
  return [P(best), V(best)];
}

/** Settings of `maxRectInPolygon`'s centre search (crop.rs). */
export const MAX_RECT_STEP = 0.05;
export const MAX_RECT_F_TOL = 1e-12;
export const MAX_RECT_X_TOL = 1e-9;
export const MAX_RECT_CENTRE_PULL = 1e-3;

/**
 * The largest rectangle of `aspect` (null keeps the frame's) inside the convex `poly` (frame units) turned by
 * `angleDeg` about the rectangle's centre, at most the frame's size; the centre found by Nelder–Mead.
 */
export function maxRectInPolygon(
  poly: readonly Point[],
  aspect: number | null,
  angleDeg: number,
  imageAspect: number,
): CropRect {
  const fw = imageAspect;
  let hw = 0.5 * fw;
  let hh = 0.5;
  if (aspect !== null && aspect > 0 && Number.isFinite(aspect)) {
    if (hw / hh > aspect) hw = hh * aspect;
    else hh = hw / aspect;
  }
  if (poly.length < 3) return { x: 0.5 - hw / fw, y: 0.5 - hh, w: (2 * hw) / fw, h: 2 * hh };
  const middle: Point = [0.5 * fw, 0.5];
  const start: Point = pointInConvexPolygon(poly, middle) ? middle : vertexAverage(poly);
  const [cArr] = nelderMead(
    (p) => {
      const px = p[0] ?? 0;
      const py = p[1] ?? 0;
      const k = fitScaleInPolygon(poly, [px, py], hw, hh, angleDeg);
      const dx = px - middle[0];
      const dy = py - middle[1];
      return -k + MAX_RECT_CENTRE_PULL * (dx * dx + dy * dy);
    },
    start,
    MAX_RECT_STEP,
    MAX_RECT_F_TOL,
    MAX_RECT_X_TOL,
  );
  const c: Point = [cArr[0] ?? 0, cArr[1] ?? 0];
  let best: [Point, number] = [c, fitScaleInPolygon(poly, c, hw, hh, angleDeg)];
  const kMid = fitScaleInPolygon(poly, middle, hw, hh, angleDeg);
  if (kMid >= best[1]) best = [middle, kMid];
  const [[cx, cy], k] = best;
  const w = hw * k;
  const h = hh * k;
  return { x: (cx - w) / fw, y: cy - h, w: (2 * w) / fw, h: 2 * h };
}

// ---------- Upright and the manual Transform (transform.rs) ----------

/** Keystone angle at ±100 on the Vertical and Horizontal sliders, degrees. */
export const KEYSTONE_MAX_DEGREES = 30;
/** Aspect slider: each axis scales by `2^(±ASPECT_LOG2 · aspect / 100)`. */
export const ASPECT_LOG2 = 0.137;

/** The manual Transform at its defaults (every slider zero, scale 100). */
export const IDENTITY_TRANSFORM: Readonly<ManualTransform> = Object.freeze({
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  aspect: 0,
  scale: 100,
  offsetX: 0,
  offsetY: 0,
});

/** Whether every slider of `t` is at its default (Rust `== ManualTransform::default()`). */
export const isIdentityTransform = (t: ManualTransform): boolean =>
  t.vertical === 0 &&
  t.horizontal === 0 &&
  t.rotate === 0 &&
  t.aspect === 0 &&
  t.scale === 100 &&
  t.offsetX === 0 &&
  t.offsetY === 0;

/** Rust `f64::to_radians`. */
const toRadians = (deg: number): number => deg * (Math.PI / 180);

/** Normalised (0..1) frame coordinates → centred long-edge units (origin at the centre, long edge 1). */
export function centredUnits(frameW: number, frameH: number): Mat3 {
  const long = Math.max(frameW, frameH);
  const ax = frameW / long;
  const ay = frameH / long;
  return [ax, 0, -0.5 * ax, 0, ay, -0.5 * ay, 0, 0, 1];
}

/** Inverse of `centredUnits`. */
export function fromCentredUnits(frameW: number, frameH: number): Mat3 {
  const long = Math.max(frameW, frameH);
  const ax = frameW / long;
  const ay = frameH / long;
  return [1 / ax, 0, 0.5, 0, 1 / ay, 0.5, 0, 0, 1];
}

type Rot3 = [[number, number, number], [number, number, number], [number, number, number]];

/** `K · R · K⁻¹` with `K = diag(f, f, 1)`; `r` row-major. */
export function conjugateRotation(r: Rot3, focal: number): Mat3 {
  const k = scale(focal, focal);
  const kInv = scale(1 / focal, 1 / focal);
  const rm: Mat3 = [r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]];
  return compose(compose(k, rm), kInv);
}

/** `R = R_x(pitch) · R_y(yaw)` (radians, row-major; yaw first). */
export function pitchYaw(pitch: number, yaw: number): Rot3 {
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  return [
    [cy, 0, sy],
    [sp * sy, cp, -sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
}

/**
 * Translate so the centre (the origin of centred units) maps to itself, then scale uniformly so the two centre
 * lines (`extent = [width, height]`) keep their lengths on geometric average.
 */
export function recentreAndRescale(h: Mat3, extent: readonly [number, number]): Mat3 {
  const hw = 0.5 * extent[0];
  const hh = 0.5 * extent[1];
  const c = applyMat(h, [0, 0]);
  const len = (a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
  };
  const lh = len(applyMat(h, [-hw, 0]), applyMat(h, [hw, 0])) / extent[0];
  const lv = len(applyMat(h, [0, -hh]), applyMat(h, [0, hh])) / extent[1];
  const k = 1 / Math.sqrt(lh * lv);
  if (!(Number.isFinite(k) && k > 0 && Number.isFinite(c[0]) && Number.isFinite(c[1]))) return h;
  return andThen(andThen(h, translate(-c[0], -c[1])), scale(k, k));
}

/**
 * `M_manual = offset · scale · aspect · keystone · rotate` (rotate first) in normalised (0..1) coordinates of a
 * `frameW × frameH` frame, built in centred long-edge units (`manual_matrix_with_focal`). Vertical −100..100 is a
 * pitch of `−v/100 · 30°` (negative widens the top), Horizontal a yaw of `h/100 · 30°` (positive enlarges the
 * right), Rotate degrees clockwise, Aspect `2^(±0.137·a/100)`, Scale percent, Offset X/Y hundredths of the long
 * edge (positive right / down). `focal` (long edges) defaults to 1. Exactly the identity at the defaults.
 */
export function manualMatrix(t: ManualTransform, frameW: number, frameH: number, focal?: number | null): Mat3 {
  if (isIdentityTransform(t)) return identity();
  const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const long = Math.max(frameW, frameH);
  const extent: [number, number] = [frameW / long, frameH / long];

  const rot = rotate(toRadians(finite(t.rotate, 0)));
  const v = finite(t.vertical, 0);
  const hz = finite(t.horizontal, 0);
  let keystone = identity();
  if (!(v === 0 && hz === 0)) {
    const f = focal !== null && focal !== undefined && Number.isFinite(focal) && focal > 0 ? focal : 1;
    const max = toRadians(KEYSTONE_MAX_DEGREES);
    const r = pitchYaw((-v / 100) * max, (hz / 100) * max);
    keystone = recentreAndRescale(conjugateRotation(r, f), extent);
  }
  const e = (ASPECT_LOG2 * finite(t.aspect, 0)) / 100;
  const aspect = scale(2 ** e, 2 ** -e);
  const s = finite(t.scale, 100) / 100;
  const sc = scale(s, s);
  const offset = translate(finite(t.offsetX, 0) / 100, finite(t.offsetY, 0) / 100);
  const centred = andThen(andThen(andThen(andThen(rot, keystone), aspect), sc), offset);
  return normalized(andThen(andThen(centredUnits(frameW, frameH), centred), fromCentredUnits(frameW, frameH)));
}

/** `H_upright`: the stored transform when the mode is not `off` and it is finite and invertible, else identity. */
export function uprightMatrix(upright: Pick<Upright, 'mode' | 'transform'>): Mat3 {
  const t = upright.transform;
  if (upright.mode === 'off' || !t) return identity();
  return t.every(Number.isFinite) && invert(t) !== null ? t : identity();
}

export type PerspectiveGeometry = Pick<DevelopGeometry, 'upright' | 'transform'>;

/** Whether `H_upright · M_manual` can differ from the identity. */
export const hasPerspective = (g: PerspectiveGeometry): boolean =>
  (g.upright.mode !== 'off' && g.upright.transform !== null) || !isIdentityTransform(g.transform);

/** `M_manual · H_upright`: the oriented frame → the transformed frame (normalised), for a `frameW × frameH` frame. */
export function perspectiveMatrix(g: PerspectiveGeometry, frameW: number, frameH: number): Mat3 {
  const u = uprightMatrix(g.upright);
  const m = manualMatrix(g.transform, frameW, frameH, g.upright.focal);
  return andThen(u, m);
}

/** `M_manual · H_upright · O`: the decoded source → the transformed, uncropped frame (normalised). */
export function preCropMatrix(
  g: PerspectiveGeometry & Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV'>,
  sourceWidth: number,
  sourceHeight: number,
): Mat3 {
  const [fw, fh] = orientedSize(g.rotate, Math.max(sourceWidth, 1), Math.max(sourceHeight, 1));
  return andThen(orientationMatrix(g), perspectiveMatrix(g, fw, fh));
}

/**
 * The valid region of the transformed frame in frame units (`frameW / frameH` wide, 1 high): the image outline
 * after `perspective` clipped to the frame; null when a corner maps through infinity.
 */
export function warpedRegion(perspective: Mat3, frameW: number, frameH: number): Point[] | null {
  const ia = frameW / frameH;
  const m = perspective;
  const corners: Point[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const w0 = at(m, 6) * 0 + at(m, 7) * 0 + at(m, 8);
  const sameSide = corners.every((p) => {
    const w = at(m, 6) * p[0] + at(m, 7) * p[1] + at(m, 8);
    return w * w0 > 0 && Math.abs(w) > 1e-12;
  });
  if (!sameSide) return null;
  const quad: Point[] = corners.map((p) => {
    const q = applyMat(perspective, p);
    return [q[0] * ia, q[1]];
  });
  if (!quad.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  return clipToFrame(quad, ia, 1);
}

/**
 * The largest crop for the geometry's crop aspect (the frame's when free or original) and straighten angle that
 * fits inside the warped image clipped to the frame (`max_crop_in_warped`); `maxCrop` without perspective.
 * `frameW × frameH` is the oriented frame.
 */
export function maxCropInWarped(
  g: PerspectiveGeometry & Pick<DevelopGeometry, 'crop'>,
  frameW: number,
  frameH: number,
): CropRect {
  const ia = frameW / frameH;
  let angle = 0;
  let aspect: number | null = null;
  if (g.crop) {
    angle = Number.isFinite(g.crop.angle) ? clampN(g.crop.angle, -45, 45) : 0;
    aspect = cropAspectRatio(g.crop.aspect, frameW, frameH);
  }
  if (!hasPerspective(g)) return maxCrop(aspect, angle, ia);
  const poly = warpedRegion(perspectiveMatrix(g, frameW, frameH), frameW, frameH);
  return poly && poly.length >= 3 ? maxRectInPolygon(poly, aspect, angle, ia) : maxCrop(aspect, angle, ia);
}

// ---------- re-mapping (remap.rs) ----------

/** `H_new · H_old⁻¹` (normalised), or null when `hOld` is singular. */
export function remapMatrix(hOld: Mat3, hNew: Mat3): Mat3 | null {
  const inv = invert(hOld);
  return inv ? normalized(andThen(inv, hNew)) : null;
}

/** Map `points` through `H_new · H_old⁻¹`; unchanged when `hOld` is singular. */
export function remapPoints(points: readonly Point[], hOld: Mat3, hNew: Mat3): [number, number][] {
  const m = remapMatrix(hOld, hNew);
  return m ? points.map((p) => applyMat(m, p)) : points.map((p) => [p[0], p[1]]);
}

// ---------- the plan ----------

/** The aspect lock as width / height in frame pixels (null for free). */
export function cropAspectRatio(aspect: DevelopCrop['aspect'], frameWidth: number, frameHeight: number): number | null {
  if (aspect === 'free') return null;
  if (aspect === 'original') return frameWidth / frameHeight;
  const [w, h] = aspect;
  return w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : null;
}

/** `[w, h]` fitted inside `edge` on the long side (never upscaled), like the Rust decode `fit`. */
export function fitSize(w: number, h: number, edge: number): [number, number] {
  const long = Math.max(w, h);
  if (long <= edge) return [w, h];
  const s = (v: number) => Math.max(Math.round((v * edge) / long), 1);
  return w >= h ? [edge, s(h)] : [s(w), edge];
}

export interface GeometryPlan {
  outputWidth: number;
  outputHeight: number;
  /** Size of the crop at the source's own resolution: what a full-size render outputs. */
  developedWidth: number;
  developedHeight: number;
  /** The crop actually used (after constrain and pixel snapping), fractions of the transformed frame. */
  crop: CropRect;
  /** Straighten angle used, degrees clockwise (clamped to −45..45). */
  angle: number;
  /** Source normalised (0..1) → output normalised (0..1). */
  forward: Mat3;
  /** Output pixel → source pixel (pixel `i` spans `[i, i + 1)`). */
  inverse: Mat3;
}

/**
 * The geometry the plan reads: orientation, constrain and the crop, plus Upright and the manual Transform (both
 * optional here so crop-only callers can omit them; absent means identity).
 */
export type PlanGeometry = Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV' | 'constrainCrop' | 'crop'> &
  Partial<PerspectiveGeometry>;

const NO_PERSPECTIVE: PerspectiveGeometry = {
  upright: { mode: 'off', guides: [], transform: null, focal: null },
  transform: IDENTITY_TRANSFORM,
};

/**
 * Plan the warp of a `sourceWidth × sourceHeight` (EXIF-upright) image, as `GeometryPlan::new` does: output
 * and developed size, the crop used, and the forward / inverse maps. `targetLongEdge` fits the output inside
 * that long edge (never upscales).
 */
export function geometryPlan(
  geometry: PlanGeometry,
  sourceWidth: number,
  sourceHeight: number,
  targetLongEdge: number | null,
): GeometryPlan {
  const sw = Math.max(sourceWidth, 1);
  const sh = Math.max(sourceHeight, 1);
  const [fw, fh] = orientedSize(geometry.rotate, sw, sh);
  const persp: PerspectiveGeometry = {
    upright: geometry.upright ?? NO_PERSPECTIVE.upright,
    transform: geometry.transform ?? NO_PERSPECTIVE.transform,
  };
  const o = orientationMatrix(geometry);
  const perspective = hasPerspective(persp) ? perspectiveMatrix(persp, fw, fh) : null;
  const preCrop = perspective ? andThen(o, perspective) : o;

  const full: CropRect = { x: 0, y: 0, w: 1, h: 1 };
  let rect: CropRect = full;
  let angle = 0;
  let aspect: number | null = null;
  if (geometry.crop) {
    const c = geometry.crop;
    angle = Number.isFinite(c.angle) ? clampN(c.angle, -45, 45) : 0;
    rect = { ...c.rect };
    aspect = cropAspectRatio(c.aspect, fw, fh);
  }
  const valid = [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0;
  if (!valid) rect = full;
  const imageAspect = fw / fh;
  const warped = perspective ? warpedRegion(perspective, fw, fh) : null;
  const region = warped && warped.length >= 3 ? warped : null;
  if (geometry.constrainCrop) {
    rect = region
      ? constrainCropInPolygon(rect, aspect, angle, imageAspect, region)
      : constrainCrop(rect, aspect, angle, imageAspect);
  } else if (angle === 0) rect = constrainCrop(rect, null, 0, imageAspect);

  const axisAligned = angle === 0 && perspective === null && isAffine(preCrop, 0);
  let x0: number;
  let y0: number;
  let cw: number;
  let ch: number;
  let developed: [number, number];
  if (axisAligned) {
    const snap = (a: number, b: number, size: number): [number, number] => {
      const lo = clampN(Math.round(a * size), 0, size - 1);
      const hi = clampN(Math.round(b * size), lo + 1, size);
      return [lo, hi];
    };
    const [sx0, sx1] = snap(rect.x, rect.x + rect.w, fw);
    const [sy0, sy1] = snap(rect.y, rect.y + rect.h, fh);
    x0 = sx0;
    y0 = sy0;
    cw = sx1 - sx0;
    ch = sy1 - sy0;
    developed = [cw, ch];
  } else {
    cw = rect.w * fw;
    ch = rect.h * fh;
    x0 = rect.x * fw;
    y0 = rect.y * fh;
    developed = [Math.max(Math.round(cw), 1), Math.max(Math.round(ch), 1)];
  }
  const crop: CropRect = { x: x0 / fw, y: y0 / fh, w: cw / fw, h: ch / fh };
  const [ow, oh] =
    targetLongEdge && targetLongEdge > 0 ? fitSize(developed[0], developed[1], targetLongEdge) : developed;

  const ccx = x0 + cw / 2;
  const ccy = y0 + ch / 2;
  let forwardPx = andThen(scale(1 / sw, 1 / sh), preCrop);
  forwardPx = andThen(forwardPx, scale(fw, fh));
  forwardPx = andThen(forwardPx, rotateAbout(angle * (Math.PI / 180), ccx, ccy));
  forwardPx = andThen(forwardPx, translate(-x0, -y0));
  forwardPx = andThen(forwardPx, scale(ow / cw, oh / ch));
  const inverse = normalized(invert(forwardPx) ?? identity());
  const forward = normalized(andThen(andThen(scale(sw, sh), forwardPx), scale(1 / ow, 1 / oh)));

  return {
    outputWidth: ow,
    outputHeight: oh,
    developedWidth: developed[0],
    developedHeight: developed[1],
    crop,
    angle,
    forward,
    inverse,
  };
}

// ---------- editing helpers (UI only, no Rust twin) ----------

/** Width / height of the transformed, uncropped frame for an upright `width × height` source. */
export function frameAspect(rotation: Rotation, width: number, height: number): number {
  const [fw, fh] = orientedSize(rotation, width, height);
  return fw > 0 && fh > 0 ? fw / fh : 1;
}

/** Whether two rects agree to `eps` (absolute, in frame fractions). */
export function rectsClose(a: CropRect, b: CropRect, eps = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps
  );
}

/**
 * The same pixels after the frame turns 90° clockwise (`dir` 1) or counter-clockwise (-1) on screen:
 * clockwise maps (u, v) → (1 − v, u).
 */
export function rotateRect90(rect: CropRect, dir: 1 | -1): CropRect {
  return dir === 1
    ? { x: 1 - (rect.y + rect.h), y: rect.x, w: rect.h, h: rect.w }
    : { x: rect.y, y: 1 - (rect.x + rect.w), w: rect.h, h: rect.w };
}

/** The same pixels after the frame is mirrored left/right (`h`) or top/bottom (`v`) on screen. */
export function flipRect(rect: CropRect, axis: 'h' | 'v'): CropRect {
  return axis === 'h' ? { ...rect, x: 1 - (rect.x + rect.w) } : { ...rect, y: 1 - (rect.y + rect.h) };
}

/**
 * The stored `rotate` after turning the picture 90° on screen (`dir` 1 clockwise). The flips act after the
 * rotation, so with exactly one flip on, a clockwise turn on screen is a counter-clockwise `rotate`.
 */
export function nextRotation(g: Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV'>, dir: 1 | -1): Rotation {
  const sign = g.flipH !== g.flipV ? -dir : dir;
  return ((((g.rotate + sign * 90) % 360) + 360) % 360) as Rotation;
}

/** Whether `rect` fits inside the image rotated by `angleDeg` about its centre (and inside the frame at 0°). */
export function cropFits(rect: CropRect, angleDeg: number, imageAspect: number, eps = 1e-9): boolean {
  const fw = imageAspect;
  const hw = (rect.w * fw) / 2;
  const hh = rect.h / 2;
  const cx = rect.x * fw + hw;
  const cy = rect.y + hh;
  const phi = rad(angleDeg);
  const s = Math.abs(Math.sin(phi));
  const c = Math.abs(Math.cos(phi));
  const ex = hw * c + hh * s;
  const ey = hw * s + hh * c;
  return ex <= Math.min(cx, fw - cx) + eps && ey <= Math.min(cy, 1 - cy) + eps;
}

/** Fold an angle in degrees into −45..45 by adding multiples of 90 (a line is level or plumb either way). */
export function foldAngle(deg: number): number {
  let a = deg % 90;
  if (a > 45) a -= 90;
  else if (a < -45) a += 90;
  return Object.is(a, -0) ? 0 : a;
}
