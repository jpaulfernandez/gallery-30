import { describe, expect, it } from 'vitest';
import { type CropFit, clampCrop, cropFit, MAX_SCALE, panCrop, panLimit, UNKNOWN_FIT, zoomCrop } from './crop';

/** A 3:2 landscape photo in a 4:5 portrait slot: cover is 1.875 slot widths by 1 slot height. */
const LANDSCAPE_IN_PORTRAIT: CropFit = { imageAspect: 1.5, slotAspect: 0.8, rotate: 0 };

describe('cropFit', () => {
  const book = {
    assets: { a: { path: 'a.jpg', width: 3000, height: 2000 }, b: { path: 'b.jpg' } },
    template: { width: 1080, height: 1350 },
  };

  it('reads the upright asset size and the slot pixel aspect', () => {
    const fit = cropFit(book, { asset: 'a', frame: { x: 0, y: 0, w: 0.5, h: 0.5 }, rotate: 90 });
    expect(fit.imageAspect).toBe(1.5);
    expect(fit.slotAspect).toBeCloseTo(0.8, 10);
    expect(fit.rotate).toBe(90);
  });

  it('has no image aspect before the scan fills the size', () => {
    expect(cropFit(book, { asset: 'b', frame: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0 }).imageAspect).toBeNull();
    expect(cropFit(null, { asset: 'a', frame: { x: 0, y: 0, w: 1, h: 1 }, rotate: 0 }).imageAspect).toBeNull();
  });
});

describe('crop math', () => {
  it('pans a landscape photo sideways in a portrait slot at scale 1', () => {
    expect(panLimit(1, LANDSCAPE_IN_PORTRAIT)).toEqual({ x: 0.4375, y: 0 });
    expect(clampCrop({ x: 0.9, y: -0.2, scale: 1 }, LANDSCAPE_IN_PORTRAIT)).toEqual({ x: 0.4375, y: 0, scale: 1 });
  });

  it('widens both ranges with the scale', () => {
    expect(panLimit(2, LANDSCAPE_IN_PORTRAIT)).toEqual({ x: 1.375, y: 0.5 });
    expect(clampCrop({ x: -9, y: 0.9, scale: 2 }, LANDSCAPE_IN_PORTRAIT)).toEqual({ x: -1.375, y: 0.5, scale: 2 });
  });

  it('swaps the photo aspect for a 90 degree rotation', () => {
    const lim = panLimit(1, { ...LANDSCAPE_IN_PORTRAIT, rotate: 90 });
    expect(lim.x).toBe(0);
    expect(lim.y).toBeCloseTo(0.1, 10);
  });

  it('falls back to (scale - 1) / 2 without the photo size', () => {
    expect(panLimit(1)).toEqual({ x: 0, y: 0 });
    expect(clampCrop({ x: 0.3, y: -0.2, scale: 1 })).toEqual({ x: 0, y: 0, scale: 1 });
    expect(panLimit(2, UNKNOWN_FIT)).toEqual({ x: 0.5, y: 0.5 });
    expect(clampCrop({ x: 0.9, y: -0.9, scale: 2 })).toEqual({ x: 0.5, y: -0.5, scale: 2 });
    expect(clampCrop({ x: 0.1, y: -0.2, scale: 1.5 })).toEqual({ x: 0.1, y: -0.2, scale: 1.5 });
  });

  it('clamps the scale to [1, 4] and repairs non-finite values', () => {
    expect(clampCrop({ x: 0, y: 0, scale: 0.5 }).scale).toBe(1);
    expect(clampCrop({ x: 0, y: 0, scale: 9 }).scale).toBe(MAX_SCALE);
    expect(clampCrop({ x: Number.NaN, y: 0, scale: Number.NaN })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('pans by pointer delta as a fraction of the slot size', () => {
    const start = { x: 0, y: 0, scale: 2 };
    expect(panCrop(start, 50, -25, 200, 100)).toEqual({ x: 0.25, y: -0.25, scale: 2 });
    // Clamped at the edge.
    expect(panCrop(start, 500, 0, 200, 100).x).toBe(0.5);
    // A zero-size slot does not divide by zero.
    expect(panCrop(start, 10, 10, 0, 0)).toEqual(start);
    // At scale 1 a landscape photo in a portrait slot moves sideways only.
    expect(panCrop({ x: 0, y: 0, scale: 1 }, 40, 40, 160, 200, LANDSCAPE_IN_PORTRAIT)).toEqual({
      x: 0.25,
      y: 0,
      scale: 1,
    });
  });

  it('zooms around the centre and re-clamps the pan when zooming out', () => {
    expect(zoomCrop({ x: 0.2, y: 0, scale: 2 }, 3)).toEqual({ x: 0.3, y: 0, scale: 3 });
    // Back to 1: no pan room left without the photo size...
    expect(zoomCrop({ x: 0.4, y: -0.3, scale: 2 }, 1)).toEqual({ x: 0, y: 0, scale: 1 });
    // ...but a landscape photo in a portrait slot keeps its sideways room.
    expect(zoomCrop({ x: 0.4, y: -0.3, scale: 2 }, 1, undefined, LANDSCAPE_IN_PORTRAIT)).toEqual({
      x: 0.2,
      y: 0,
      scale: 1,
    });
  });

  it('keeps the anchor point fixed when zooming around the pointer', () => {
    const crop = { x: 0.1, y: 0.05, scale: 2 };
    const anchor = { x: 0.3, y: -0.2 };
    const next = zoomCrop(crop, 2.5, anchor, LANDSCAPE_IN_PORTRAIT);
    // Image point under the anchor before and after: p = (u - t) / s.
    expect((anchor.x - next.x) / next.scale).toBeCloseTo((anchor.x - crop.x) / crop.scale, 5);
    expect((anchor.y - next.y) / next.scale).toBeCloseTo((anchor.y - crop.y) / crop.scale, 5);
  });
});
