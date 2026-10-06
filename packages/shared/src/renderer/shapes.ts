import type { Shape, ShapeKind } from '../schema.js';
import { SHAPE_KINDS } from '../schema.js';
import { num, pct } from './util.js';

/**
 * Frame shapes: CSS `clip-path` values for a photo slot box, plus the same outline as an SVG path.
 *
 * Every value is relative to the box (CSS percentages, or SVG `objectBoundingBox` units where the
 * box is 0..1 on both axes), so it renders the same at any size. Shapes that must not stretch with
 * the frame (circle, polygon, arch, rounded corners) are computed in a box `aspect` wide and 1 high
 * (the frame's pixel aspect), then x is divided by `aspect`; a circle stays round in any frame.
 *
 * Strategy per kind:
 * - rect: no clip.
 * - rounded: `inset(0 round rx% / ry%)`, the radii given separately per axis so the corners are round.
 * - circle: `circle(closest-side at 50% 50%)`. ellipse: `ellipse(50% 50% at 50% 50%)`.
 * - arch: `inset(0 round ...)` with the top corners rounded by half the width (a semicircle).
 * - diamond, polygon (and stars): `polygon(...)` with percentages.
 * - blob: a smooth closed Bezier path in an SVG `<clipPath clipPathUnits="objectBoundingBox">`,
 *   referenced as `url(#id)`; the host renders the clipPath (see `PhotoElement`).
 *   `shapeClipPath` (no id) samples the curve into a `polygon(...)` instead.
 */

export type { Shape, ShapeKind };
export { SHAPE_KINDS };

/** A missing `shape` means this. */
export const DEFAULT_SHAPE: Shape = { kind: 'rect' };

export interface ShapeClip {
  /** CSS `clip-path` value for the slot box. */
  css: string;
  /**
   * Set when `css` is `url(#id)`: the `d` of the path to put in
   * `<clipPath id={id} clipPathUnits="objectBoundingBox">`.
   */
  svg?: string;
  /** The shape's outline as an SVG path in objectBoundingBox units (0..1 on both axes). */
  outline: string;
}

type Point = readonly [number, number];

/** Blob radii vary in `[1 - roughness * BLOB_DEPTH, 1]`. */
const BLOB_DEPTH = 0.35;
/** Curve samples per blob segment when it has to be a CSS polygon. */
const BLOB_SAMPLES = 12;

const validAspect = (a: number): number => (Number.isFinite(a) && a > 0 ? a : 1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Coordinate in objectBoundingBox units. */
const u = (v: number): string => num(v, 4);
const pt = ([x, y]: Point): string => `${u(x)} ${u(y)}`;
const cssPolygon = (points: readonly Point[]): string =>
  `polygon(${points.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(', ')})`;
const linePath = (points: readonly Point[]): string => `M${points.map(pt).join(' L')} Z`;

/** Stable, url()-safe clip id for an element. */
export function shapeClipId(elementId: string): string {
  return `pb-clip-${elementId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** Deterministic PRNG (mulberry32): the same seed always gives the same blob. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vertices of a regular polygon (or a star with `inset`) in objectBoundingBox units, undistorted
 * for the frame aspect and scaled up uniformly until it touches the frame on two sides.
 */
export function polygonPoints(sides: number, rotation: number, inset: number | undefined, aspect: number): Point[] {
  const a = validAspect(aspect);
  const n = clamp(Math.round(sides), 3, 12);
  const star = inset !== undefined;
  const count = star ? n * 2 : n;
  const raw: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = ((rotation - 90 + (i * 360) / count) * Math.PI) / 180;
    const r = star && i % 2 === 1 ? clamp(inset, 0, 1) : 1;
    raw.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min(a / (maxX - minX), 1 / (maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return raw.map(([x, y]) => [(a / 2 + (x - cx) * s) / a, 0.5 + (y - cy) * s]);
}

/** Blob anchor points around the ellipse inscribed in the frame, starting at the top, clockwise. */
export function blobPoints(points: number, seed: number, roughness: number): Point[] {
  const n = clamp(Math.round(points), 3, 12);
  const next = random(seed);
  const depth = clamp(roughness, 0, 1) * BLOB_DEPTH;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const r = 1 - next() * depth;
    const angle = ((-90 + (i * 360) / n) * Math.PI) / 180;
    out.push([0.5 + 0.5 * r * Math.cos(angle), 0.5 + 0.5 * r * Math.sin(angle)]);
  }
  return out;
}

/** Closed Catmull-Rom spline through `points` as cubic Bezier segments: [start, c1, c2, end]. */
function catmullRom(points: readonly Point[]): Array<[Point, Point, Point, Point]> {
  const n = points.length;
  const at = (i: number) => points[((i % n) + n) % n] as Point;
  const segments: Array<[Point, Point, Point, Point]> = [];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    segments.push([p1, c1, c2, p2]);
  }
  return segments;
}

/** Smooth closed path through the blob points: `M` then one `C` per point, then `Z`. */
export function blobPath(points: readonly Point[]): string {
  const segments = catmullRom(points);
  const first = segments[0]?.[0];
  if (!first) return '';
  return `M${pt(first)}${segments.map(([, c1, c2, end]) => ` C${pt(c1)} ${pt(c2)} ${pt(end)}`).join('')} Z`;
}

/** The blob curve sampled into straight segments (for a CSS polygon). */
function blobSamples(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const [p0, c1, c2, p1] of catmullRom(points)) {
    for (let k = 0; k < BLOB_SAMPLES; k++) {
      const t = k / BLOB_SAMPLES;
      const m = 1 - t;
      const w = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t] as const;
      out.push([
        w[0] * p0[0] + w[1] * c1[0] + w[2] * c2[0] + w[3] * p1[0],
        w[0] * p0[1] + w[1] * c1[1] + w[2] * c2[1] + w[3] * p1[1],
      ]);
    }
  }
  return out;
}

/** Elliptical-arc outline of a rounded box; `rx`, `ry` in objectBoundingBox units per corner (tl, tr, br, bl). */
function roundedPath(rx: readonly number[], ry: readonly number[]): string {
  const [tlx = 0, trx = 0, brx = 0, blx = 0] = rx;
  const [tly = 0, try_ = 0, bry = 0, bly = 0] = ry;
  const arc = (x: number, y: number, ax: number, ay: number) =>
    ax > 0 && ay > 0 ? ` A${u(ax)} ${u(ay)} 0 0 1 ${u(x)} ${u(y)}` : ` L${u(x)} ${u(y)}`;
  return (
    `M${u(tlx)} 0 L${u(1 - trx)} 0${arc(1, try_, trx, try_)}` +
    ` L1 ${u(1 - bry)}${arc(1 - brx, 1, brx, bry)}` +
    ` L${u(blx)} 1${arc(0, 1 - bly, blx, bly)}` +
    ` L0 ${u(tly)}${arc(tlx, 0, tlx, tly)} Z`
  );
}

const ellipsePath = (rx: number, ry: number): string =>
  `M${u(0.5 - rx)} 0.5 A${u(rx)} ${u(ry)} 0 1 1 ${u(0.5 + rx)} 0.5 A${u(rx)} ${u(ry)} 0 1 1 ${u(0.5 - rx)} 0.5 Z`;

/**
 * The clip for a shape in a frame of pixel aspect `aspect` (width / height). Undefined for a
 * rectangle (or no shape). For a blob, `css` is `url(#id)` and `svg` holds the clip path to render
 * under that id; use `shapeClipId(element.id)` for `id`.
 */
export function shapeClip(shape: Shape | undefined, aspect: number, id: string): ShapeClip | undefined {
  if (!shape || shape.kind === 'rect') return undefined;
  const a = validAspect(aspect);
  const short = Math.min(a, 1);
  switch (shape.kind) {
    case 'rounded': {
      const r = clamp(shape.radius, 0, 0.5) * short;
      const rx = r / a;
      return { css: `inset(0 round ${pct(rx)} / ${pct(r)})`, outline: roundedPath([rx, rx, rx, rx], [r, r, r, r]) };
    }
    case 'circle': {
      const r = short / 2;
      return { css: 'circle(closest-side at 50% 50%)', outline: ellipsePath(r / a, r) };
    }
    case 'ellipse':
      return { css: 'ellipse(50% 50% at 50% 50%)', outline: ellipsePath(0.5, 0.5) };
    case 'arch': {
      // Semicircular top of radius w / 2, capped at the frame height for very wide frames.
      const r = Math.min(a / 2, 1);
      const rx = r / a;
      return {
        css: `inset(0 round ${pct(rx)} ${pct(rx)} 0 0 / ${pct(r)} ${pct(r)} 0 0)`,
        outline: roundedPath([rx, rx, 0, 0], [r, r, 0, 0]),
      };
    }
    case 'diamond': {
      const points: Point[] = [
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ];
      return { css: cssPolygon(points), outline: linePath(points) };
    }
    case 'polygon': {
      const points = polygonPoints(shape.sides, shape.rotation, shape.inset, a);
      return { css: cssPolygon(points), outline: linePath(points) };
    }
    case 'blob': {
      const path = blobPath(blobPoints(shape.points, shape.seed, shape.roughness));
      return { css: `url(#${id})`, svg: path, outline: path };
    }
  }
}

/**
 * Pure-CSS `clip-path` for a shape (no SVG defs needed): as `shapeClip`, except a blob is its curve
 * sampled into a `polygon(...)`. Undefined for a rectangle.
 */
export function shapeClipPath(shape: Shape | undefined, frameAspect: number): string | undefined {
  if (shape?.kind === 'blob') return cssPolygon(blobSamples(blobPoints(shape.points, shape.seed, shape.roughness)));
  return shapeClip(shape, frameAspect, '')?.css;
}
