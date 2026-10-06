import type { CSSProperties } from 'react';
import type { Crop, Frame, PhotoElement } from '../schema.js';
import type { PageSize } from './types.js';
import { num, pct } from './util.js';

/**
 * Cover-fit crop math shared by the renderer and the editor.
 *
 * Model: the photo is laid out at its cover size (the smallest size at the photo's displayed aspect
 * that covers the slot) times `crop.scale`, centred in the slot, then moved by `crop.x` / `crop.y`
 * (fractions of the slot width / height). A 90 or 270 degree rotation swaps the displayed aspect.
 * Crop (0, 0, 1) is a centred cover fit, which is what an `object-fit: cover` img shows.
 *
 * All sizes here are fractions of the slot: a cover size of `{ w: 1.5, h: 1 }` is 1.5 slot widths
 * by one slot height. Aspects are width / height in pixels.
 */

type Rotate = PhotoElement['rotate'];

export const MIN_CROP_SCALE = 1;
export const MAX_CROP_SCALE = 4;

/** True for a usable aspect (finite and positive). */
const validAspect = (a: number | null | undefined): a is number => typeof a === 'number' && Number.isFinite(a) && a > 0;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Six decimals is far below a pixel and keeps the project file tidy; `+ 0` turns -0 into 0. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

/** Pixel aspect (width / height) of a slot: `frame.w * template.width : frame.h * template.height`. */
export function slotAspect(frame: Pick<Frame, 'w' | 'h'>, template: PageSize): number {
  return (frame.w * template.width) / (frame.h * template.height);
}

/** Aspect of the photo as displayed: a 90/270 degree rotation swaps width and height. */
export function rotatedAspect(imageAspect: number, rotate: number = 0): number {
  return rotate === 90 || rotate === 270 ? 1 / imageAspect : imageAspect;
}

/**
 * Cover size at scale 1, as fractions of the slot. One side is always exactly 1. With an unknown
 * image aspect (null, NaN, <= 0) the photo is assumed to match the slot: `{ w: 1, h: 1 }`.
 */
export function coverSize(
  imageAspect: number | null | undefined,
  slot: number,
  rotate: number = 0,
): { w: number; h: number } {
  if (!validAspect(imageAspect) || !validAspect(slot)) return { w: 1, h: 1 };
  const a = rotatedAspect(imageAspect, rotate);
  return a >= slot ? { w: a / slot, h: 1 } : { w: 1, h: slot / a };
}

/**
 * Largest |crop.x| and |crop.y| (fractions of the slot) that keep the photo covering the slot:
 * with cover size (cw, ch) = cover * scale, `|x| <= (cw - sw) / (2 sw)`, `|y| <= (ch - sh) / (2 sh)`.
 * With an unknown image aspect this is the old `(scale - 1) / 2` on both axes.
 */
export function cropPanLimit(
  scale: number,
  imageAspect: number | null | undefined,
  slot: number,
  rotate: number = 0,
): { x: number; y: number } {
  const c = coverSize(imageAspect, slot, rotate);
  return { x: Math.max(0, (c.w * scale - 1) / 2), y: Math.max(0, (c.h * scale - 1) / 2) };
}

/**
 * Clamp the scale to [MIN_CROP_SCALE, MAX_CROP_SCALE] and the pan so the photo covers the slot;
 * non-finite values are repaired and the result is rounded to 6 decimals.
 */
export function clampCropToCover(
  crop: Crop,
  imageAspect: number | null | undefined,
  slot: number,
  rotate: number = 0,
): Crop {
  const scale = round6(clamp(Number.isFinite(crop.scale) ? crop.scale : 1, MIN_CROP_SCALE, MAX_CROP_SCALE));
  const lim = cropPanLimit(scale, imageAspect, slot, rotate);
  return {
    x: round6(clamp(Number.isFinite(crop.x) ? crop.x : 0, -lim.x, lim.x)),
    y: round6(clamp(Number.isFinite(crop.y) ? crop.y : 0, -lim.y, lim.y)),
    scale,
  };
}

/**
 * Inline style for the photo's img inside an `overflow: hidden` slot box: the img is the unrotated
 * photo at its cover size (percentages of the slot), its centre is put at the slot centre plus the
 * pan (`left` / `top` percentages are of the slot width / height, so the pan stays in slot units),
 * and it is rotated and scaled around that centre. The crop is used as given; clamp it first.
 */
export function coverLayout(crop: Crop, rotate: Rotate | number, imageAspect: number, slot: number): CSSProperties {
  const c = coverSize(imageAspect, slot, rotate);
  const quarter = rotate === 90 || rotate === 270;
  // Before rotating, the img's width runs along the slot's height (and vice versa).
  const width = quarter ? c.h / slot : c.w;
  const height = quarter ? c.w * slot : c.h;
  const transform = ['translate(-50%, -50%)'];
  if (rotate) transform.push(`rotate(${rotate}deg)`);
  transform.push(`scale(${num(crop.scale)})`);
  return {
    position: 'absolute',
    left: pct(0.5 + crop.x),
    top: pct(0.5 + crop.y),
    width: pct(width),
    height: pct(height),
    transform: transform.join(' '),
  };
}
