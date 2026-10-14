import type { CurvePoint } from '@photobook/shared';

/**
 * Point-curve maths for the Develop curve editor: a monotone cubic Hermite spline through the points
 * (Fritsch and Carlson, 1980), so a curve never overshoots between points and stays a valid tone map.
 * Points are `[input, output]` pairs in 0..1, sorted by input. The Rust pipeline bakes the same kind of
 * spline into a LUT; this file only draws it and edits the points.
 */

/** Closest two neighbouring points may get on the input axis. */
export const MIN_POINT_GAP = 0.004;
/** The editor stops adding points here. */
export const MAX_CURVE_POINTS = 16;

export const IDENTITY_CURVE: readonly CurvePoint[] = [
  [0, 0],
  [1, 1],
];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Tangent at every point (Fritsch-Carlson): secant averages, zeroed at extrema and limited so the spline is monotone. */
export function monotoneTangents(points: readonly CurvePoint[]): number[] {
  const n = points.length;
  if (n < 2) return new Array<number>(n).fill(0);
  const dx: number[] = [];
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as CurvePoint;
    const b = points[i + 1] as CurvePoint;
    const h = b[0] - a[0];
    dx.push(h);
    secant.push(h > 0 ? (b[1] - a[1]) / h : 0);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = secant[0] as number;
  m[n - 1] = secant[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const s0 = secant[i - 1] as number;
    const s1 = secant[i] as number;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const s = secant[i] as number;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / s;
    const b = (m[i + 1] as number) / s;
    const r = a * a + b * b;
    if (r > 9) {
      const tau = 3 / Math.sqrt(r);
      m[i] = tau * a * s;
      m[i + 1] = tau * b * s;
    }
  }
  return m;
}

/** A curve ready to evaluate repeatedly (tangents computed once). */
export type CurveEvaluator = (x: number) => number;

export function curveEvaluator(points: readonly CurvePoint[]): CurveEvaluator {
  const n = points.length;
  if (n === 0) return (x) => clamp01(x);
  if (n === 1) {
    const only = (points[0] as CurvePoint)[1];
    return () => only;
  }
  const m = monotoneTangents(points);
  return (x) => {
    const first = points[0] as CurvePoint;
    const last = points[n - 1] as CurvePoint;
    if (x <= first[0]) return first[1];
    if (x >= last[0]) return last[1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((points[mid] as CurvePoint)[0] <= x) lo = mid;
      else hi = mid;
    }
    const p0 = points[lo] as CurvePoint;
    const p1 = points[hi] as CurvePoint;
    const h = p1[0] - p0[0];
    const t = (x - p0[0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const y =
      (2 * t3 - 3 * t2 + 1) * p0[1] +
      (t3 - 2 * t2 + t) * h * (m[lo] as number) +
      (-2 * t3 + 3 * t2) * p1[1] +
      (t3 - t2) * h * (m[hi] as number);
    // Rounding can leave a hair outside the segment's range; keep it a valid tone map.
    return Math.min(Math.max(y, Math.min(p0[1], p1[1])), Math.max(p0[1], p1[1]));
  };
}

/** Value of the monotone cubic spline through `points` at `x`; flat outside the first and last point. */
export function evaluateCurve(points: readonly CurvePoint[], x: number): number {
  return curveEvaluator(points)(x);
}

/** `count` samples of the curve at evenly spaced inputs from 0 to 1 (a LUT). */
export function sampleCurve(points: readonly CurvePoint[], count = 256): number[] {
  const f = curveEvaluator(points);
  return Array.from({ length: count }, (_, i) => f(i / (count - 1)));
}

/** SVG path of the curve in a `size` x `size` box (y up), as a polyline of `steps` segments. */
export function curvePath(points: readonly CurvePoint[], size: number, steps = 96): string {
  const f = curveEvaluator(points);
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    parts.push(`${i === 0 ? 'M' : 'L'}${(x * size).toFixed(2)} ${((1 - f(x)) * size).toFixed(2)}`);
  }
  return parts.join(' ');
}

export const isIdentityCurve = (points: readonly CurvePoint[]): boolean =>
  points.length === 2 &&
  (points[0] as CurvePoint)[0] === 0 &&
  (points[0] as CurvePoint)[1] === 0 &&
  (points[1] as CurvePoint)[0] === 1 &&
  (points[1] as CurvePoint)[1] === 1;

/**
 * Add a point at `(x, y)`, keeping the list sorted. Returns the new list and the index of the point, or
 * null when the curve is full or `x` is within `MIN_POINT_GAP` of a neighbour (or an end).
 */
export function addCurvePoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
): { points: CurvePoint[]; index: number } | null {
  if (points.length >= MAX_CURVE_POINTS) return null;
  const px = clamp01(x);
  if (points.some((p) => Math.abs(p[0] - px) < MIN_POINT_GAP)) return null;
  const at = points.findIndex((p) => p[0] > px);
  const index = at < 0 ? points.length : at;
  const next = [...points];
  next.splice(index, 0, [px, clamp01(y)]);
  return { points: next, index };
}

/**
 * Move point `index` to `(x, y)`. The end points keep x = 0 and x = 1 (only y moves); inner points
 * stay between their neighbours (`MIN_POINT_GAP` apart). Output is clamped to 0..1.
 */
export function moveCurvePoint(points: readonly CurvePoint[], index: number, x: number, y: number): CurvePoint[] {
  const current = points[index];
  if (!current) return [...points];
  const last = points.length - 1;
  let nx: number;
  if (index === 0) nx = current[0];
  else if (index === last) nx = current[0];
  else {
    const lo = (points[index - 1] as CurvePoint)[0] + MIN_POINT_GAP;
    const hi = (points[index + 1] as CurvePoint)[0] - MIN_POINT_GAP;
    nx = Math.min(Math.max(x, lo), hi);
  }
  const next = [...points];
  next[index] = [nx, clamp01(y)];
  return next;
}

/** Remove an inner point; the two end points cannot be removed (returns the list unchanged). */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (index <= 0 || index >= points.length - 1) return [...points];
  return points.filter((_, i) => i !== index);
}

/** Index of the point within `radius` (input/output units) of `(x, y)` that is closest, or -1. */
export function nearestPoint(points: readonly CurvePoint[], x: number, y: number, radiusX: number, radiusY = radiusX) {
  let best = -1;
  let bestD = 1;
  points.forEach((p, i) => {
    const dx = (p[0] - x) / radiusX;
    const dy = (p[1] - y) / radiusY;
    const d = dx * dx + dy * dy;
    if (d <= 1 && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Smallest distance between the parametric split handles, and from the ends. */
export const MIN_SPLIT_GAP = 0.05;

/** Move split handle `index` (0..2) to `x`, keeping the three in order, at least `MIN_SPLIT_GAP` apart and inside 0..1. */
export function moveSplit(
  splits: readonly [number, number, number],
  index: 0 | 1 | 2,
  x: number,
): [number, number, number] {
  const lo = index === 0 ? MIN_SPLIT_GAP : (splits[index - 1] as number) + MIN_SPLIT_GAP;
  const hi = index === 2 ? 1 - MIN_SPLIT_GAP : (splits[index + 1] as number) - MIN_SPLIT_GAP;
  const next: [number, number, number] = [splits[0], splits[1], splits[2]];
  next[index] = Math.min(Math.max(x, lo), hi);
  return next;
}
