// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PhotoElement as PhotoData } from '../schema.js';
import { clampCropToCover, coverLayout, coverSize, cropPanLimit, rotatedAspect, slotAspect } from './cover.js';
import { PhotoElement } from './PhotoElement.js';
import type { ResolveImage } from './types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHOTO_3_2 = 3 / 2;
const SLOT_4_5 = 4 / 5;

function photo(extra: Partial<PhotoData> = {}): PhotoData {
  return {
    type: 'photo',
    id: 'e1',
    asset: 'a1',
    frame: { x: 0, y: 0, w: 1, h: 1 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none',
    ...extra,
  };
}

describe('cover math', () => {
  it('computes the slot pixel aspect from the frame and the template', () => {
    expect(slotAspect({ w: 0.5, h: 0.5 }, { width: 1080, height: 1350 })).toBeCloseTo(0.8, 10);
    expect(slotAspect({ w: 1, h: 0.5 }, { width: 1000, height: 1000 })).toBe(2);
  });

  it('sizes a 3:2 photo in a 4:5 slot to full height and 1.875 slot widths', () => {
    const c = coverSize(PHOTO_3_2, SLOT_4_5);
    expect(c.h).toBe(1);
    expect(c.w).toBeCloseTo(1.875, 10);
    // A portrait photo in a landscape slot: full width, taller than the slot.
    const p = coverSize(2 / 3, 2);
    expect(p.w).toBe(1);
    expect(p.h).toBeCloseTo(3, 10);
    // Unknown aspect: assume the photo matches the slot.
    expect(coverSize(null, SLOT_4_5)).toEqual({ w: 1, h: 1 });
    expect(coverSize(Number.NaN, SLOT_4_5)).toEqual({ w: 1, h: 1 });
  });

  it('allows panning along the long side at scale 1', () => {
    const lim = cropPanLimit(1, PHOTO_3_2, SLOT_4_5);
    expect(lim.x).toBeCloseTo(0.4375, 10);
    expect(lim.y).toBe(0);
    expect(clampCropToCover({ x: 0.9, y: 0.3, scale: 1 }, PHOTO_3_2, SLOT_4_5)).toEqual({
      x: 0.4375,
      y: 0,
      scale: 1,
    });
    expect(clampCropToCover({ x: -0.2, y: 0, scale: 1 }, PHOTO_3_2, SLOT_4_5)).toEqual({ x: -0.2, y: 0, scale: 1 });
  });

  it('widens the range on both axes at scale 2', () => {
    const lim = cropPanLimit(2, PHOTO_3_2, SLOT_4_5);
    // (1.875 * 2 - 1) / 2 and (1 * 2 - 1) / 2.
    expect(lim.x).toBeCloseTo(1.375, 10);
    expect(lim.y).toBeCloseTo(0.5, 10);
    expect(clampCropToCover({ x: -3, y: 3, scale: 2 }, PHOTO_3_2, SLOT_4_5)).toEqual({ x: -1.375, y: 0.5, scale: 2 });
  });

  it('falls back to (scale - 1) / 2 when the photo aspect is unknown', () => {
    expect(cropPanLimit(1, undefined, SLOT_4_5)).toEqual({ x: 0, y: 0 });
    expect(cropPanLimit(2, null, SLOT_4_5)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('swaps the aspect for 90 and 270 degree rotations', () => {
    expect(rotatedAspect(PHOTO_3_2, 90)).toBeCloseTo(2 / 3, 10);
    expect(rotatedAspect(PHOTO_3_2, 270)).toBeCloseTo(2 / 3, 10);
    expect(rotatedAspect(PHOTO_3_2, 180)).toBe(PHOTO_3_2);
    // Rotated, the 3:2 photo is 2:3, narrower than 4:5: full width, taller than the slot.
    const c = coverSize(PHOTO_3_2, SLOT_4_5, 90);
    expect(c.w).toBe(1);
    expect(c.h).toBeCloseTo(1.2, 10);
    const lim = cropPanLimit(1, PHOTO_3_2, SLOT_4_5, 90);
    expect(lim.x).toBe(0);
    expect(lim.y).toBeCloseTo(0.1, 10);
  });

  it('clamps the scale to [1, 4] and repairs non-finite values', () => {
    expect(clampCropToCover({ x: 0, y: 0, scale: 0.5 }, PHOTO_3_2, SLOT_4_5).scale).toBe(1);
    expect(clampCropToCover({ x: 0, y: 0, scale: 9 }, PHOTO_3_2, SLOT_4_5).scale).toBe(4);
    expect(clampCropToCover({ x: Number.NaN, y: 0, scale: Number.NaN }, PHOTO_3_2, SLOT_4_5)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it('centres crop (0, 0, 1) at the cover size', () => {
    const style = coverLayout({ x: 0, y: 0, scale: 1 }, 0, PHOTO_3_2, SLOT_4_5);
    expect(style).toEqual({
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '187.5%',
      height: '100%',
      transform: 'translate(-50%, -50%) scale(1)',
    });
  });

  it('pans with left / top in slot units and scales around the photo centre', () => {
    const style = coverLayout({ x: -0.25, y: 0.1, scale: 2 }, 180, PHOTO_3_2, SLOT_4_5);
    expect(style.left).toBe('25%');
    expect(style.top).toBe('60%');
    expect(style.transform).toBe('translate(-50%, -50%) rotate(180deg) scale(2)');
  });

  it('sizes the unrotated img along the swapped axes for a 90 degree rotation', () => {
    const style = coverLayout({ x: 0, y: 0, scale: 1 }, 90, PHOTO_3_2, SLOT_4_5);
    // Displayed cover: 1 slot width by 1.2 slot heights. The img before rotating is that turned on
    // its side: width = 1.2 * sh = 1.5 sw (150%), height = 1 * sw = 0.8 sh (80%).
    expect(style.width).toBe('150%');
    expect(style.height).toBe('80%');
    expect(style.transform).toBe('translate(-50%, -50%) rotate(90deg) scale(1)');
  });
});

describe('<PhotoElement>', () => {
  const template = { width: 1080, height: 1350 };

  function render(element: PhotoData, resolve: ResolveImage): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<PhotoElement element={element} resolve={resolve} template={template} />);
    return host.querySelector('.pb-photo') as HTMLElement;
  }

  it('renders a pan at scale 1 when the resolver knows the size', () => {
    const resolve: ResolveImage = () => ({ src: 'a.jpg', width: 1500, height: 1000 });
    const img = render(photo({ crop: { x: 0.3, y: 0, scale: 1 } }), resolve).querySelector('img') as HTMLImageElement;
    expect(img.style.left).toBe('80%');
    expect(img.style.width).toBe('187.5%');
  });

  it('clamps an out-of-range crop at render time', () => {
    const resolve: ResolveImage = () => ({ src: 'a.jpg', width: 1500, height: 1000 });
    const img = render(photo({ crop: { x: 2, y: -1, scale: 1 } }), resolve).querySelector('img') as HTMLImageElement;
    expect(img.style.left).toBe('93.75%');
    expect(img.style.top).toBe('50%');
  });

  it('uses the natural size from onLoad when the resolver has no size', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const element = photo({ crop: { x: 0.3, y: 0, scale: 1 } });
    await act(async () => {
      root.render(<PhotoElement element={element} resolve={() => ({ src: 'a.jpg' })} template={template} />);
    });
    const img = host.querySelector('img') as HTMLImageElement;
    // Before load: object-fit cover fallback.
    expect(img.style.transform).toBe('translate(30%, 0%) scale(1)');
    Object.defineProperty(img, 'naturalWidth', { value: 1500 });
    Object.defineProperty(img, 'naturalHeight', { value: 1000 });
    await act(async () => {
      img.dispatchEvent(new Event('load'));
    });
    const after = host.querySelector('img') as HTMLImageElement;
    expect(after.style.left).toBe('80%');
    expect(after.style.width).toBe('187.5%');
    expect(after.style.transform).toBe('translate(-50%, -50%) scale(1)');
    act(() => root.unmount());
    host.remove();
  });
});
