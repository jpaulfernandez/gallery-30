import {
  type Book,
  type Crop,
  clampCropToCover,
  cropPanLimit,
  MAX_CROP_SCALE,
  MIN_CROP_SCALE,
  type PhotoElement,
  slotAspect,
} from '@photobook/shared';

/**
 * Crop math for the editor: thin wrappers over the shared renderer's cover math
 * (packages/shared/src/renderer/cover.ts), so what the editor clamps is exactly what renders.
 *
 * The renderer lays the photo out at its cover size (smallest size at the photo's aspect that
 * covers the slot, aspect swapped for 90/270 degree rotations) times `scale`, centred, then moved
 * by (x, y), fractions of the slot width / height. It covers the slot iff
 * |x| <= (cover.w * scale - 1) / 2 and |y| <= (cover.h * scale - 1) / 2, with the cover size in
 * slot units (one side is 1). So a landscape photo in a portrait slot pans sideways at scale 1.
 * Without the photo's size (not scanned yet) the photo is assumed to match the slot: (scale - 1) / 2.
 */

export const MIN_SCALE = MIN_CROP_SCALE;
export const MAX_SCALE = MAX_CROP_SCALE;

/** What the clamp needs to know about a slot. */
export interface CropFit {
  /** Upright width / height of the photo, or null when unknown. */
  imageAspect: number | null;
  /** Pixel width / height of the slot (`frame.w * template.width : frame.h * template.height`). */
  slotAspect: number;
  rotate: number;
}

/** Nothing known: the old `(scale - 1) / 2` rule. */
export const UNKNOWN_FIT: CropFit = { imageAspect: null, slotAspect: 1, rotate: 0 };

type FitBook = { assets: Book['assets']; template: Pick<Book['template'], 'width' | 'height'> };

/** The fit for a photo element: the asset's upright size from `book.assets`, the slot frame and template. */
export function cropFit(
  book: FitBook | null | undefined,
  element: Pick<PhotoElement, 'asset' | 'frame' | 'rotate'>,
): CropFit {
  if (!book) return { ...UNKNOWN_FIT, rotate: element.rotate };
  const asset = element.asset ? book.assets[element.asset] : undefined;
  const imageAspect = asset?.width && asset.height ? asset.width / asset.height : null;
  return { imageAspect, slotAspect: slotAspect(element.frame, book.template), rotate: element.rotate };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Largest |x| and |y| (fractions of the slot) that keep the photo covering the slot at `scale`. */
export function panLimit(scale: number, fit: CropFit = UNKNOWN_FIT): { x: number; y: number } {
  return cropPanLimit(scale, fit.imageAspect, fit.slotAspect, fit.rotate);
}

/** Clamp the scale to [MIN_SCALE, MAX_SCALE] and the pan so the photo covers the slot. */
export function clampCrop(crop: Crop, fit: CropFit = UNKNOWN_FIT): Crop {
  return clampCropToCover(crop, fit.imageAspect, fit.slotAspect, fit.rotate);
}

/** Pan by a pointer delta in screen px, given the slot's on-screen size in px. */
export function panCrop(
  start: Crop,
  dxPx: number,
  dyPx: number,
  slotWidthPx: number,
  slotHeightPx: number,
  fit: CropFit = UNKNOWN_FIT,
): Crop {
  if (slotWidthPx <= 0 || slotHeightPx <= 0) return clampCrop(start, fit);
  return clampCrop({ ...start, x: start.x + dxPx / slotWidthPx, y: start.y + dyPx / slotHeightPx }, fit);
}

/**
 * Zoom to `scale`, keeping the point at `anchor` fixed on screen. `anchor` is the offset from the
 * slot centre as fractions of the slot (0, 0 = centre, the inspector slider; the pointer for pinch).
 * The photo's centre sits at t (the pan) and its size is proportional to s, so a screen point u
 * maps to photo point p = (u - t) / s, whatever the cover size: t' = u - (s' / s)(u - t).
 */
export function zoomCrop(
  crop: Crop,
  scale: number,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
  fit: CropFit = UNKNOWN_FIT,
): Crop {
  const next = clamp(scale, MIN_SCALE, MAX_SCALE);
  const k = next / crop.scale;
  return clampCrop(
    {
      x: anchor.x - k * (anchor.x - crop.x),
      y: anchor.y - k * (anchor.y - crop.y),
      scale: next,
    },
    fit,
  );
}
