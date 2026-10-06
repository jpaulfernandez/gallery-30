import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhotoElementSchema, SHAPE_KINDS, type Shape, type ShapeKind, ShapeSchema } from '../schema.js';
import { PhotoElement } from './PhotoElement.js';
import { blobPath, blobPoints, DEFAULT_SHAPE, polygonPoints, shapeClip, shapeClipId, shapeClipPath } from './shapes.js';

/** `polygon(a b, c d, ...)` -> number of points. */
const polygonCount = (css: string | undefined): number =>
  (css?.match(/^polygon\((.*)\)$/)?.[1] ?? '').split(',').length;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('shape schema', () => {
  it('lists every kind once', () => {
    const exact: Same<ShapeKind, (typeof SHAPE_KINDS)[number]> = true;
    expect(exact).toBe(true);
    expect(new Set(SHAPE_KINDS).size).toBe(8);
    expect(DEFAULT_SHAPE).toEqual({ kind: 'rect' });
  });

  it('accepts valid shapes and rejects out-of-range values', () => {
    const ok: Shape[] = [
      { kind: 'rect' },
      { kind: 'rounded', radius: 0.5 },
      { kind: 'circle' },
      { kind: 'ellipse' },
      { kind: 'polygon', sides: 6, rotation: 30 },
      { kind: 'polygon', sides: 5, rotation: 0, inset: 0.45 },
      { kind: 'blob', points: 7, seed: 42, roughness: 0.6 },
      { kind: 'arch' },
      { kind: 'diamond' },
    ];
    for (const shape of ok) expect(ShapeSchema.parse(shape)).toEqual(shape);
    expect(ShapeSchema.safeParse({ kind: 'rounded', radius: 0.6 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'polygon', sides: 2, rotation: 0 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'polygon', sides: 13, rotation: 0 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'blob', points: 5, seed: 1, roughness: 1.5 }).success).toBe(false);
    expect(ShapeSchema.safeParse({ kind: 'heart' }).success).toBe(false);
  });

  it('keeps shape optional on photo elements', () => {
    const el = {
      type: 'photo',
      id: 'e',
      asset: null,
      frame: { x: 0, y: 0, w: 1, h: 1 },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    };
    expect(PhotoElementSchema.parse(el).shape).toBeUndefined();
    expect(PhotoElementSchema.parse({ ...el, shape: { kind: 'circle' } }).shape).toEqual({ kind: 'circle' });
  });
});

describe('shapeClip', () => {
  it('does not clip rectangles', () => {
    expect(shapeClip(undefined, 1, 'x')).toBeUndefined();
    expect(shapeClip({ kind: 'rect' }, 1.5, 'x')).toBeUndefined();
    expect(shapeClipPath({ kind: 'rect' }, 1.5)).toBeUndefined();
  });

  it('uses the largest centred circle and a frame-filling ellipse', () => {
    expect(shapeClip({ kind: 'circle' }, 0.8, 'x')?.css).toBe('circle(closest-side at 50% 50%)');
    expect(shapeClip({ kind: 'ellipse' }, 0.8, 'x')?.css).toBe('ellipse(50% 50% at 50% 50%)');
    // In a 2:1 frame the circle's outline is half the width wide and the full height high.
    expect(shapeClip({ kind: 'circle' }, 2, 'x')?.outline).toBe(
      'M0.25 0.5 A0.25 0.5 0 1 1 0.75 0.5 A0.25 0.5 0 1 1 0.25 0.5 Z',
    );
  });

  it('rounds corners by a fraction of the short side, per axis', () => {
    // 2:1 frame, radius 0.25 of the height: 12.5% of the width, 25% of the height.
    expect(shapeClip({ kind: 'rounded', radius: 0.25 }, 2, 'x')?.css).toBe('inset(0 round 12.5% / 25%)');
    expect(shapeClip({ kind: 'rounded', radius: 0.5 }, 1, 'x')?.css).toBe('inset(0 round 50% / 50%)');
  });

  it('gives a regular polygon `sides` points and a star twice as many', () => {
    for (const sides of [3, 5, 6, 12]) {
      const clip = shapeClip({ kind: 'polygon', sides, rotation: 0 }, 0.8, 'x');
      expect(polygonCount(clip?.css)).toBe(sides);
      expect(clip?.outline.match(/[ML]/g)).toHaveLength(sides);
      expect(polygonCount(shapeClip({ kind: 'polygon', sides, rotation: 0, inset: 0.5 }, 0.8, 'x')?.css)).toBe(
        sides * 2,
      );
    }
    expect(polygonCount(shapeClip({ kind: 'diamond' }, 1, 'x')?.css)).toBe(4);
  });

  it('keeps polygons undistorted and inside the frame', () => {
    const aspect = 2;
    const pts = polygonPoints(4, 45, undefined, aspect);
    // A square rotated 45 degrees: equal sides in pixels (x scaled back by the aspect).
    const px = pts.map(([x, y]) => [x * aspect, y] as const);
    const side = (i: number) => {
      const [a, b] = [px[i] as readonly number[], px[(i + 1) % 4] as readonly number[]];
      return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));
    };
    for (let i = 1; i < 4; i++) expect(side(i)).toBeCloseTo(side(0), 9);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Scaled to touch the frame: the height is used in full.
    expect(Math.min(...pts.map((p) => p[1]))).toBeCloseTo(0, 9);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(1, 9);
    // A triangle with rotation 0 has its apex at the top centre; in a square it is width-limited.
    const tri = polygonPoints(3, 0, undefined, 1);
    expect(tri[0]?.[0]).toBeCloseTo(0.5, 9);
    expect(tri[0]?.[1]).toBe(Math.min(...tri.map((p) => p[1])));
    expect(Math.min(...tri.map((p) => p[0]))).toBeCloseTo(0, 9);
    expect(Math.max(...tri.map((p) => p[0]))).toBeCloseTo(1, 9);
  });

  it('draws an arch with a semicircular top', () => {
    const clip = shapeClip({ kind: 'arch' }, 0.8, 'x');
    // Top corners: half the width across, and the same pixels (0.4 of the height) down.
    expect(clip?.css).toBe('inset(0 round 50% 50% 0 0 / 40% 40% 0 0)');
    expect(clip?.outline).toBe('M0.5 0 L0.5 0 A0.5 0.4 0 0 1 1 0.4 L1 1 L1 1 L0 1 L0 1 L0 0.4 A0.5 0.4 0 0 1 0.5 0 Z');
    // Very wide frames cap the radius at the frame height.
    expect(shapeClip({ kind: 'arch' }, 4, 'x')?.css).toBe('inset(0 round 25% 25% 0 0 / 100% 100% 0 0)');
  });

  it('builds a smooth, seeded blob as an SVG clip path', () => {
    const shape: Shape = { kind: 'blob', points: 7, seed: 1234, roughness: 0.8 };
    const id = shapeClipId('01JABC');
    expect(id).toBe('pb-clip-01JABC');
    const clip = shapeClip(shape, 0.8, id);
    expect(clip?.css).toBe('url(#pb-clip-01JABC)');
    expect(clip?.svg).toBe(clip?.outline);
    expect(clip?.svg?.startsWith('M')).toBe(true);
    expect(clip?.svg?.endsWith('Z')).toBe(true);
    expect(clip?.svg?.match(/C/g)).toHaveLength(7);
    // Deterministic for a seed, different for another.
    expect(shapeClip(shape, 0.8, id)?.svg).toBe(clip?.svg);
    expect(shapeClip({ ...shape, seed: 1235 }, 0.8, id)?.svg).not.toBe(clip?.svg);
    // The aspect does not matter: the blob follows the ellipse inscribed in the frame.
    expect(shapeClip(shape, 2, id)?.svg).toBe(clip?.svg);
  });

  it('keeps blob radii within [1 - roughness * 0.35, 1] of the inscribed ellipse', () => {
    for (const roughness of [0, 0.5, 1]) {
      const pts = blobPoints(12, 99, roughness);
      expect(pts).toHaveLength(12);
      for (const [x, y] of pts) {
        const r = Math.hypot((x - 0.5) / 0.5, (y - 0.5) / 0.5);
        expect(r).toBeLessThanOrEqual(1 + 1e-9);
        expect(r).toBeGreaterThanOrEqual(1 - roughness * 0.35 - 1e-9);
      }
    }
    // Roughness 0 is a smooth ellipse through evenly spaced points, starting at the top.
    expect(blobPath(blobPoints(4, 1, 0)).startsWith('M0.5 0 C')).toBe(true);
  });

  it('has a pure-CSS fallback for blobs', () => {
    const css = shapeClipPath({ kind: 'blob', points: 5, seed: 3, roughness: 0.5 }, 1);
    expect(css?.startsWith('polygon(')).toBe(true);
    expect(polygonCount(css)).toBe(5 * 12);
    expect(shapeClipPath({ kind: 'circle' }, 1)).toBe('circle(closest-side at 50% 50%)');
  });

  it('makes url-safe ids', () => {
    expect(shapeClipId('page:background')).toBe('pb-clip-page_background');
  });
});

describe('PhotoElement with a shape', () => {
  const base = {
    type: 'photo' as const,
    id: 'e1',
    asset: null,
    frame: { x: 0, y: 0, w: 0.5, h: 0.5 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0 as const,
    filter: 'none' as const,
  };
  const render = (shape: Shape | undefined, editable = true) =>
    renderToStaticMarkup(createElement(PhotoElement, { element: { ...base, shape }, resolve: () => null, editable }));

  it('clips the box and outlines empty editable slots along the shape', () => {
    const html = render({ kind: 'circle' });
    expect(html).toContain('clip-path:circle(closest-side at 50% 50%)');
    expect(html).toContain('pb-shaped');
    expect(html).toContain('class="pb-shape-outline"');
    expect(html).not.toContain('<clipPath');
  });

  it('renders the clipPath defs for a blob', () => {
    const html = render({ kind: 'blob', points: 6, seed: 7, roughness: 0.5 });
    expect(html).toContain('clip-path:url(#pb-clip-e1)');
    expect(html).toMatch(/<clipPath id="pb-clip-e1" clipPathUnits="objectBoundingBox"><path d="M/);
  });

  it('leaves rectangles and non-editable slots alone', () => {
    expect(render(undefined)).not.toContain('clip-path');
    expect(render({ kind: 'rect' })).not.toContain('pb-shaped');
    expect(render({ kind: 'ellipse' }, false)).not.toContain('pb-shape-outline');
  });
});
