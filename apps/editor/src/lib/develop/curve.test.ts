import type { CurvePoint } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  addCurvePoint,
  curvePath,
  evaluateCurve,
  isIdentityCurve,
  MAX_CURVE_POINTS,
  MIN_POINT_GAP,
  MIN_SPLIT_GAP,
  monotoneTangents,
  moveCurvePoint,
  moveSplit,
  nearestPoint,
  removeCurvePoint,
  sampleCurve,
} from './curve';

const ID: CurvePoint[] = [
  [0, 0],
  [1, 1],
];

describe('monotone cubic evaluation', () => {
  it('is the identity for the two default points', () => {
    for (const x of [0, 0.1, 0.37, 0.5, 0.99, 1]) expect(evaluateCurve(ID, x)).toBeCloseTo(x, 10);
    expect(isIdentityCurve(ID)).toBe(true);
  });

  it('passes through every point and stays flat outside the ends', () => {
    const pts: CurvePoint[] = [
      [0, 0.1],
      [0.3, 0.2],
      [0.6, 0.8],
      [1, 0.9],
    ];
    for (const [x, y] of pts) expect(evaluateCurve(pts, x)).toBeCloseTo(y, 10);
    expect(evaluateCurve(pts, -1)).toBe(0.1);
    expect(evaluateCurve(pts, 2)).toBe(0.9);
  });

  it('never overshoots: increasing data gives an increasing curve inside the data range', () => {
    // A steep step is the classic case where an ordinary cubic spline rings.
    const pts: CurvePoint[] = [
      [0, 0],
      [0.45, 0.05],
      [0.55, 0.95],
      [1, 1],
    ];
    const lut = sampleCurve(pts, 512);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i] as number).toBeGreaterThanOrEqual((lut[i - 1] as number) - 1e-12);
    }
    for (const v of lut) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('keeps flat runs flat and local extrema local (zero tangent)', () => {
    const flat: CurvePoint[] = [
      [0, 0],
      [0.4, 0.5],
      [0.6, 0.5],
      [1, 1],
    ];
    for (const x of [0.41, 0.5, 0.59]) expect(evaluateCurve(flat, x)).toBeCloseTo(0.5, 10);
    const peak: CurvePoint[] = [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ];
    expect(monotoneTangents(peak)[1]).toBe(0);
    for (const v of sampleCurve(peak, 101)) expect(v).toBeLessThanOrEqual(1);
  });

  it('is continuous across a point', () => {
    const pts: CurvePoint[] = [
      [0, 0],
      [0.5, 0.3],
      [1, 1],
    ];
    const eps = 1e-6;
    expect(evaluateCurve(pts, 0.5 - eps)).toBeCloseTo(evaluateCurve(pts, 0.5 + eps), 4);
  });

  it('is the straight line between two points (both tangents are the secant)', () => {
    const pts: CurvePoint[] = [
      [0.2, 0.1],
      [0.8, 0.7],
    ];
    expect(evaluateCurve(pts, 0.5)).toBeCloseTo(0.4, 10);
  });

  it('samples a LUT and draws a path', () => {
    const lut = sampleCurve(ID, 5);
    [0, 0.25, 0.5, 0.75, 1].forEach((v, i) => {
      expect(lut[i]).toBeCloseTo(v, 10);
    });
    expect(curvePath(ID, 100, 4)).toBe('M0.00 100.00 L25.00 75.00 L50.00 50.00 L75.00 25.00 L100.00 0.00');
  });
});

describe('point editing', () => {
  it('adds points sorted, and refuses crowded or surplus ones', () => {
    const a = addCurvePoint(ID, 0.5, 0.3);
    expect(a).toEqual({
      points: [
        [0, 0],
        [0.5, 0.3],
        [1, 1],
      ],
      index: 1,
    });
    const b = addCurvePoint(a?.points ?? [], 0.25, 0.1);
    expect(b?.index).toBe(1);
    expect(b?.points.map((p) => p[0])).toEqual([0, 0.25, 0.5, 1]);
    expect(addCurvePoint(a?.points ?? [], 0.5 + MIN_POINT_GAP / 2, 0.3)).toBeNull();
    expect(addCurvePoint(ID, 0, 0.5)).toBeNull();
    let full: CurvePoint[] = ID.slice();
    for (let i = 1; full.length < MAX_CURVE_POINTS; i++) full = addCurvePoint(full, i / 20, 0.5)?.points ?? full;
    expect(full).toHaveLength(MAX_CURVE_POINTS);
    expect(addCurvePoint(full, 0.999, 0.5)).toBeNull();
  });

  it('clamps the end points to x = 0 and x = 1 and only moves them vertically', () => {
    const pts: CurvePoint[] = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ];
    expect(moveCurvePoint(pts, 0, 0.3, 0.2)[0]).toEqual([0, 0.2]);
    expect(moveCurvePoint(pts, 2, 0.7, 2)[2]).toEqual([1, 1]);
    expect(moveCurvePoint(pts, 2, 0.7, -3)[2]).toEqual([1, 0]);
  });

  it('keeps inner points sorted between their neighbours and inside 0..1', () => {
    const pts: CurvePoint[] = [
      [0, 0],
      [0.3, 0.3],
      [0.6, 0.6],
      [1, 1],
    ];
    const left = moveCurvePoint(pts, 2, -5, 0.5);
    expect(left[2]?.[0]).toBeCloseTo(0.3 + MIN_POINT_GAP, 10);
    const right = moveCurvePoint(pts, 1, 5, 7);
    expect(right[1]?.[0]).toBeCloseTo(0.6 - MIN_POINT_GAP, 10);
    expect(right[1]?.[1]).toBe(1);
    for (let i = 1; i < right.length; i++) {
      expect((right[i] as CurvePoint)[0]).toBeGreaterThan((right[i - 1] as CurvePoint)[0]);
    }
    // The input is not mutated.
    expect(pts[1]).toEqual([0.3, 0.3]);
  });

  it('removes inner points but never the ends', () => {
    const pts: CurvePoint[] = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ];
    expect(removeCurvePoint(pts, 1)).toEqual(ID);
    expect(removeCurvePoint(pts, 0)).toEqual(pts);
    expect(removeCurvePoint(pts, 2)).toEqual(pts);
  });

  it('finds the nearest point within a radius', () => {
    const pts: CurvePoint[] = [
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ];
    expect(nearestPoint(pts, 0.52, 0.49, 0.05)).toBe(1);
    expect(nearestPoint(pts, 0.7, 0.2, 0.05)).toBe(-1);
  });
});

describe('parametric split handles', () => {
  it('stay ordered, apart, and inside the range', () => {
    const splits: [number, number, number] = [0.25, 0.5, 0.75];
    expect(moveSplit(splits, 1, 0.6)).toEqual([0.25, 0.6, 0.75]);
    expect(moveSplit(splits, 1, 0.9)[1]).toBeCloseTo(0.75 - MIN_SPLIT_GAP, 10);
    expect(moveSplit(splits, 1, 0.1)[1]).toBeCloseTo(0.25 + MIN_SPLIT_GAP, 10);
    expect(moveSplit(splits, 0, -1)[0]).toBeCloseTo(MIN_SPLIT_GAP, 10);
    expect(moveSplit(splits, 2, 2)[2]).toBeCloseTo(1 - MIN_SPLIT_GAP, 10);
  });
});
