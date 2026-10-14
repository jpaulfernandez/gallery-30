/**
 * Crop and orientation edits as pure functions of `DevelopGeometry`: what the store's geometry actions and the
 * crop tool's drags compute. Everything works in the crop model of `geometry.ts` (rect in fractions of the
 * transformed, uncropped frame; the picture turns about the crop centre) and keeps the crop inside the rotated
 * image when `constrainCrop` is on, so the renderer's own `constrain_crop` never has to shrink it. With a
 * perspective part (Upright or the manual Transform) "inside the image" means inside the warped outline clipped to
 * the frame (`warpedPolygon`), as the Rust plan's `constrain_crop_in_polygon` does.
 */
import type { DevelopCrop, DevelopGeometry } from '@photobook/shared';
import {
  andThen,
  type CropRect,
  compose,
  constrainCrop,
  constrainCropInPolygon,
  cropAspectRatio,
  cropFits,
  fitScaleInPolygon,
  flipRect,
  hasPerspective,
  invert,
  maxCrop,
  maxRectInPolygon,
  nextRotation,
  normalized,
  orientationMatrix,
  orientedSize,
  type Point,
  perspectiveMatrix,
  rectsClose,
  rotateRect90,
  warpedRegion,
} from './geometry';

/** Upright pixel size of the source (EXIF orientation applied), as the scan records it. */
export interface SourceSize {
  width: number;
  height: number;
}

export type CropAspect = DevelopCrop['aspect'];

export const FULL_RECT: CropRect = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** Smallest crop side, in frame units (the frame is 1 high). */
export const MIN_CROP = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The transformed, uncropped frame: its pixel size and aspect (width / height). */
export function frameOf(g: Pick<DevelopGeometry, 'rotate'>, size: SourceSize): { fw: number; fh: number; ia: number } {
  const [fw, fh] = orientedSize(g.rotate, Math.max(size.width, 1), Math.max(size.height, 1));
  return { fw, fh, ia: fw / fh };
}

/**
 * The valid region of the transformed frame when the geometry has a perspective part: the warped image outline
 * clipped to the frame, in frame units (the frame `ia` wide, 1 high). Null without perspective (the rotated frame
 * formulas apply) or when the outline is degenerate.
 */
export function warpedPolygon(
  g: Pick<DevelopGeometry, 'rotate' | 'upright' | 'transform'>,
  size: SourceSize,
): Point[] | null {
  if (!hasPerspective(g)) return null;
  const { fw, fh } = frameOf(g, size);
  const poly = warpedRegion(perspectiveMatrix(g, fw, fh), fw, fh);
  return poly && poly.length >= 3 ? poly : null;
}

/** The largest crop of `aspect` at `angle`: inside the rotated frame, or inside `poly` when given. */
export const maxFit = (aspect: number | null, angle: number, ia: number, poly: readonly Point[] | null): CropRect =>
  poly ? maxRectInPolygon(poly, aspect, angle, ia) : maxCrop(aspect, angle, ia);

/** `constrainCrop`, or `constrainCropInPolygon` when `poly` is given. */
export const constrainFit = (
  rect: CropRect,
  aspect: number | null,
  angle: number,
  ia: number,
  poly: readonly Point[] | null,
): CropRect => (poly ? constrainCropInPolygon(rect, aspect, angle, ia, poly) : constrainCrop(rect, aspect, angle, ia));

/** The crop's aspect lock as width / height in frame pixels, null for free. */
export function aspectRatioOf(aspect: CropAspect, g: Pick<DevelopGeometry, 'rotate'>, size: SourceSize): number | null {
  const { fw, fh } = frameOf(g, size);
  return cropAspectRatio(aspect, fw, fh);
}

/** The crop as edited: no crop is the full frame, level, free. */
export const cropOrFull = (g: DevelopGeometry): DevelopCrop =>
  g.crop ?? { rect: { ...FULL_RECT }, angle: 0, aspect: 'free' };

/** No crop at all when it is the full frame, level and free (so untouched photos stay default). */
export function normalizeCrop(crop: DevelopCrop | null): DevelopCrop | null {
  if (!crop) return null;
  const angle = Object.is(crop.angle, -0) ? 0 : crop.angle;
  if (angle === 0 && crop.aspect === 'free' && rectsClose(crop.rect, FULL_RECT, 1e-12)) return null;
  return angle === crop.angle ? crop : { ...crop, angle };
}

const withCrop = (g: DevelopGeometry, crop: DevelopCrop | null): DevelopGeometry => ({
  ...g,
  crop: normalizeCrop(crop),
});

/** Fit a rect for the current constrain mode: inside the rotated (or warped) image, or just inside the frame when off. */
function fitCrop(
  g: DevelopGeometry,
  rect: CropRect,
  aspect: number | null,
  angle: number,
  ia: number,
  poly: readonly Point[] | null,
): CropRect {
  return g.constrainCrop ? constrainFit(rect, aspect, angle, ia, poly) : constrainCrop(rect, aspect, 0, ia);
}

/**
 * A crop taken from another photo (Copy / Paste, workflow plan 10), fitted to this one as the tool would fit it: its
 * aspect lock resolved for this frame, and with constrain on kept inside the rotated (or warped) image, else just
 * inside the frame. The angle stays.
 */
export function fitCropTo(g: DevelopGeometry, size: SourceSize): DevelopGeometry {
  if (!g.crop) return g;
  const { ia } = frameOf(g, size);
  const r = aspectRatioOf(g.crop.aspect, g, size);
  const rect = fitCrop(g, g.crop.rect, r, g.crop.angle, ia, warpedPolygon(g, size));
  return withCrop(g, { ...g.crop, rect });
}

/**
 * Set the straighten angle (clamped to −45..45). With constrain on, a crop that filled the frame for the old
 * angle fills it for the new one (`maxCrop`); any other crop is shrunk to fit (`constrainCrop`). `base` is the
 * crop the change starts from (the crop when a drag began, so dragging back regrows it); default the current.
 */
export function applyAngle(
  g: DevelopGeometry,
  angle: number,
  size: SourceSize,
  base?: DevelopCrop | null,
): DevelopGeometry {
  const next = clamp(Number.isFinite(angle) ? angle : 0, -45, 45);
  const current = cropOrFull(g);
  const from = base === undefined ? current : (base ?? { rect: { ...FULL_RECT }, angle: 0, aspect: current.aspect });
  const { ia } = frameOf(g, size);
  const r = aspectRatioOf(current.aspect, g, size);
  const poly = warpedPolygon(g, size);
  let rect = current.rect;
  if (g.constrainCrop) {
    rect = rectsClose(from.rect, maxFit(r, from.angle, ia, poly))
      ? maxFit(r, next, ia, poly)
      : constrainFit(from.rect, r, next, ia, poly);
  }
  return withCrop(g, { ...current, rect, angle: next });
}

/**
 * Lock the crop to `aspect` (or unlock with `free`), re-fitted about its centre: a crop that filled the frame
 * still does; any other keeps its centre and area, then shrinks to fit.
 */
export function applyAspect(g: DevelopGeometry, aspect: CropAspect, size: SourceSize): DevelopGeometry {
  const current = cropOrFull(g);
  const { ia } = frameOf(g, size);
  const rNew = aspectRatioOf(aspect, g, size);
  if (rNew === null) return withCrop(g, { ...current, aspect });
  const rOld = aspectRatioOf(current.aspect, g, size);
  const angle = g.constrainCrop ? current.angle : 0;
  const poly = g.constrainCrop ? warpedPolygon(g, size) : null;
  let rect: CropRect;
  if (rectsClose(current.rect, maxFit(rOld, angle, ia, poly))) rect = maxFit(rNew, angle, ia, poly);
  else {
    const { rect: r } = current;
    const area = r.w * ia * r.h;
    const h = Math.sqrt(area / rNew);
    const w = h * rNew;
    const cx = (r.x + r.w / 2) * ia;
    const cy = r.y + r.h / 2;
    rect = fitCrop(g, { x: (cx - w / 2) / ia, y: cy - h / 2, w: w / ia, h }, rNew, current.angle, ia, poly);
  }
  return withCrop(g, { ...current, rect, aspect });
}

/** Swap the crop between landscape and portrait (`X`): a `[w, h]` lock becomes `[h, w]`, the frame is turned. */
export function swapOrientation(g: DevelopGeometry, size: SourceSize): DevelopGeometry {
  const current = cropOrFull(g);
  const { ia, fw, fh } = frameOf(g, size);
  const rOld = aspectRatioOf(current.aspect, g, size);
  const aspect: CropAspect =
    current.aspect === 'free'
      ? 'free'
      : current.aspect === 'original'
        ? [fh, fw]
        : [current.aspect[1], current.aspect[0]];
  const { rect: r } = current;
  const W = r.w * ia;
  const H = r.h;
  const rNew = aspectRatioOf(aspect, g, size) ?? H / W;
  const angle = g.constrainCrop ? current.angle : 0;
  const poly = g.constrainCrop ? warpedPolygon(g, size) : null;
  let rect: CropRect;
  if (rectsClose(r, maxFit(rOld, angle, ia, poly))) rect = maxFit(rNew, angle, ia, poly);
  else {
    const cx = (r.x + r.w / 2) * ia;
    const cy = r.y + r.h / 2;
    rect = fitCrop(g, { x: (cx - H / 2) / ia, y: cy - W / 2, w: H / ia, h: W }, rNew, current.angle, ia, poly);
  }
  return withCrop(g, { ...current, rect, aspect });
}

/**
 * A stored Upright transform carried through an orientation change: conjugated by `D = O_new · O_old⁻¹` (the old
 * oriented frame → the new one), so the corrected picture turns with the frame instead of being re-corrected along
 * the wrong axes. The manual sliders are kept as they are (they act on the new frame's axes).
 */
function carryUpright(g: DevelopGeometry, next: DevelopGeometry): DevelopGeometry {
  const t = g.upright.transform;
  const same = g.rotate === next.rotate && g.flipH === next.flipH && g.flipV === next.flipV;
  const oInv = invert(orientationMatrix(g));
  if (!t || same || !oInv) return next;
  const d = andThen(oInv, orientationMatrix(next));
  const dInv = invert(d);
  if (!dInv) return next;
  return { ...next, upright: { ...next.upright, transform: [...normalized(compose(compose(d, t), dInv))] } };
}

/**
 * Turn the picture 90° on screen (`dir` 1 clockwise): `rotate` changes (the other way when exactly one flip is on)
 * and the crop is mapped into the new frame so the same pixels stay selected; a `[w, h]` lock swaps. A stored
 * Upright transform turns with it (`carryUpright`).
 */
export function applyRotate90(g: DevelopGeometry, dir: 1 | -1): DevelopGeometry {
  const rotate = nextRotation(g, dir);
  const crop = g.crop
    ? {
        ...g.crop,
        rect: rotateRect90(g.crop.rect, dir),
        aspect: Array.isArray(g.crop.aspect)
          ? ([g.crop.aspect[1], g.crop.aspect[0]] as [number, number])
          : g.crop.aspect,
      }
    : null;
  return carryUpright(g, { ...g, rotate, crop });
}

/** Mirror the picture on screen; the crop follows the pixels and the straighten angle changes sign. */
export function applyFlip(g: DevelopGeometry, axis: 'h' | 'v'): DevelopGeometry {
  const crop = g.crop ? { ...g.crop, rect: flipRect(g.crop.rect, axis), angle: -g.crop.angle } : null;
  const flips = axis === 'h' ? { flipH: !g.flipH } : { flipV: !g.flipV };
  return carryUpright(g, withCrop({ ...g, ...flips }, crop));
}

/**
 * Turn constrain-to-image on or off; turning it on shrinks the crop into the rotated image. With a perspective
 * part, turning it on refits the crop to the largest one inside the warped image (Lightroom's Constrain Crop),
 * keeping the crop's aspect.
 */
export function applyConstrain(g: DevelopGeometry, on: boolean, size: SourceSize): DevelopGeometry {
  if (!on) return { ...g, constrainCrop: false };
  const next = { ...g, constrainCrop: true };
  if (warpedPolygon(g, size)) return refitWarpedCrop(next, size);
  if (!g.crop) return next;
  const { ia } = frameOf(g, size);
  const r = aspectRatioOf(g.crop.aspect, g, size);
  return withCrop(next, { ...g.crop, rect: constrainCrop(g.crop.rect, r, g.crop.angle, ia) });
}

/**
 * Constrain Crop after a perspective change: the largest crop inside the warped image for the crop's aspect lock,
 * or for its current shape when free (so a free crop keeps its aspect), and its straighten angle. Without a
 * perspective part this is the largest crop in the rotated frame. The stored aspect lock is kept.
 */
export function refitWarpedCrop(g: DevelopGeometry, size: SourceSize): DevelopGeometry {
  const current = cropOrFull(g);
  const { ia } = frameOf(g, size);
  const locked = aspectRatioOf(current.aspect, g, size);
  const r = current.rect;
  const shape = r.w > 0 && r.h > 0 ? (r.w * ia) / r.h : ia;
  // A free crop of the frame's own shape refits as free (the same numbers `applyAngle` compares against).
  const aspect = locked ?? (Math.abs(shape - ia) <= 1e-9 * ia ? null : shape);
  const angle = Number.isFinite(current.angle) ? Math.min(Math.max(current.angle, -45), 45) : 0;
  const rect = maxFit(aspect, angle, ia, warpedPolygon(g, size));
  return withCrop(g, { ...current, rect });
}

/**
 * The crop tool's Reset: orientation, crop, angle and constrain back to their defaults while Upright and the manual
 * Transform stay (the Upright transform turns back with the frame, `carryUpright`). With a perspective part the
 * crop is then the largest one inside the warped image, as Constrain Crop keeps it.
 */
export function resetCropTool(g: DevelopGeometry, size: SourceSize): DevelopGeometry {
  let next = carryUpright(g, { ...g, rotate: 0, flipH: false, flipV: false, crop: null, constrainCrop: true });
  if (warpedPolygon(next, size)) next = refitWarpedCrop(next, size);
  return next;
}

// ---------- frame drags (the crop tool) ----------

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface DragContext {
  /** Frame aspect (width / height). */
  ia: number;
  angle: number;
  constrain: boolean;
  /** The warped outline in frame units when the geometry has a perspective part (`warpedPolygon`). */
  poly?: readonly Point[] | null;
}

/** Whether `rect`, turned by `angle` about its centre, lies inside `poly` (frame units); `eps` relative slack. */
export function rectFitsPolygon(rect: CropRect, angle: number, ia: number, poly: readonly Point[], eps = 0): boolean {
  const hw = (rect.w * ia) / 2;
  const hh = rect.h / 2;
  return fitScaleInPolygon(poly, [rect.x * ia + hw, rect.y + hh], hw, hh, angle) >= 1 - eps;
}

/**
 * Whether `rect` is allowed: inside the rotated (or warped) image (constrain on) or inside the frame (off).
 * Strict by default so a drag stopped by bisection lands inside, never a rounding error past the edge.
 */
const allowed = (rect: CropRect, ctx: DragContext, eps = 0) =>
  ctx.constrain && ctx.poly
    ? rectFitsPolygon(rect, ctx.angle, ctx.ia, ctx.poly, eps) && cropFits(rect, 0, ctx.ia, eps)
    : cropFits(rect, ctx.constrain ? ctx.angle : 0, ctx.ia, eps);

const shifted = (r: CropRect, dx: number, dy: number): CropRect => ({ ...r, x: r.x + dx, y: r.y + dy });

/** Move the crop by `(dx, dy)` frame fractions, stopping at the edge of the image instead of shrinking. */
export function moveRect(start: CropRect, dx: number, dy: number, ctx: DragContext): CropRect {
  if (ctx.constrain && ctx.poly) {
    // The warped outline has no closed form: go as far as allowed along the drag, then slide along each axis.
    const want = shifted(start, dx, dy);
    if (allowed(want, ctx)) return want;
    if (!allowed(start, ctx, 1e-9)) return start;
    const t = bisect((u) => allowed(shifted(start, dx * u, dy * u), ctx));
    let best = shifted(start, dx * t, dy * t);
    const restX = dx * (1 - t);
    best = shifted(best, restX * bisect((u) => allowed(shifted(best, restX * u, 0), ctx)), 0);
    const restY = dy * (1 - t);
    best = shifted(best, 0, restY * bisect((u) => allowed(shifted(best, 0, restY * u), ctx)));
    return best;
  }
  const { ia } = ctx;
  const hw = (start.w * ia) / 2;
  const hh = start.h / 2;
  const phi = ((ctx.constrain ? ctx.angle : 0) * Math.PI) / 180;
  const s = Math.abs(Math.sin(phi));
  const c = Math.abs(Math.cos(phi));
  const ex = Math.min(hw * c + hh * s, ia / 2);
  const ey = Math.min(hw * s + hh * c, 0.5);
  const cx = clamp((start.x + dx) * ia + hw, ex, ia - ex);
  const cy = clamp(start.y + dy + hh, ey, 1 - ey);
  return { x: (cx - hw) / ia, y: cy - hh, w: start.w, h: start.h };
}

interface Edges {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const toEdges = (r: CropRect, ia: number): Edges => ({ x0: r.x * ia, y0: r.y, x1: (r.x + r.w) * ia, y1: r.y + r.h });
const toRect = (e: Edges, ia: number): CropRect => ({ x: e.x0 / ia, y: e.y0, w: (e.x1 - e.x0) / ia, h: e.y1 - e.y0 });
const lerpEdges = (a: Edges, b: Edges, t: number): Edges => ({
  x0: a.x0 + (b.x0 - a.x0) * t,
  y0: a.y0 + (b.y0 - a.y0) * t,
  x1: a.x1 + (b.x1 - a.x1) * t,
  y1: a.y1 + (b.y1 - a.y1) * t,
});

/** Largest `t` in [0, 1] for which `ok(t)` holds, assuming it holds at 0 (bisection). */
function bisect(ok: (t: number) => boolean): number {
  if (ok(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface ResizeOptions extends DragContext {
  /** Keep this aspect (width / height in frame pixels): the lock, or the start aspect with Shift. */
  aspect: number | null;
  /** Resize about the centre (Alt). */
  fromCenter: boolean;
}

/**
 * Drag `handle` of the crop by `(dx, dy)` frame fractions. Edges never cross (`MIN_CROP`), a kept aspect is
 * enforced (edge handles grow the other side about the centre), and the drag stops where the crop would leave
 * the image (free crops keep sliding along the edge they did not hit).
 */
export function resizeRect(start: CropRect, handle: CropHandle, dx: number, dy: number, o: ResizeOptions): CropRect {
  const { ia } = o;
  const s = toEdges(start, ia);
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  const left = handle.includes('w');
  const right = handle.includes('e');
  const top = handle.includes('n');
  const bottom = handle.includes('s');
  const DX = dx * ia;

  // Width and height the pointer asks for (signed growth is folded into a minimum size).
  let w = s.x1 - s.x0;
  let h = s.y1 - s.y0;
  const k = o.fromCenter ? 2 : 1;
  if (left) w -= k * DX;
  if (right) w += k * DX;
  if (top) h -= k * dy;
  if (bottom) h += k * dy;
  w = Math.max(w, MIN_CROP);
  h = Math.max(h, MIN_CROP);
  const horizontal = left || right;
  const vertical = top || bottom;
  if (o.aspect) {
    const r = o.aspect;
    if (horizontal && vertical) {
      if (w / r >= h) h = w / r;
      else w = h * r;
    } else if (horizontal) h = w / r;
    else w = h * r;
    if (w < MIN_CROP) {
      w = MIN_CROP;
      h = w / r;
    }
    if (h < MIN_CROP) {
      h = MIN_CROP;
      w = h * r;
    }
  }

  // Anchor: the opposite edge, or the centre with Alt (and on the axis an edge handle does not drag).
  const place = (lo: number, hi: number, size: number, dragLo: boolean, dragHi: boolean, centre: number) => {
    if (o.fromCenter || (!dragLo && !dragHi)) return [centre - size / 2, centre + size / 2] as const;
    return dragLo ? ([hi - size, hi] as const) : ([lo, lo + size] as const);
  };
  const [x0, x1] = place(s.x0, s.x1, w, left, right, cx);
  const [y0, y1] = place(s.y0, s.y1, h, top, bottom, cy);
  const want: Edges = { x0, y0, x1, y1 };
  const wantRect = toRect(want, ia);
  if (allowed(wantRect, o)) return wantRect;
  if (!allowed(start, o, 1e-9)) {
    return o.constrain && o.poly
      ? constrainCropInPolygon(wantRect, o.aspect, o.angle, ia, o.poly)
      : constrainCrop(wantRect, o.aspect, o.constrain ? o.angle : 0, ia);
  }
  const t = bisect((t) => allowed(toRect(lerpEdges(s, want, t), ia), o));
  let best = lerpEdges(s, want, t);
  if (!o.aspect) {
    // Free: keep following the pointer on the axis that did not hit the edge.
    const alongX = (u: number): Edges => ({
      ...best,
      x0: best.x0 + (want.x0 - best.x0) * u,
      x1: best.x1 + (want.x1 - best.x1) * u,
    });
    best = alongX(bisect((u) => allowed(toRect(alongX(u), ia), o)));
    const alongY = (u: number): Edges => ({
      ...best,
      y0: best.y0 + (want.y0 - best.y0) * u,
      y1: best.y1 + (want.y1 - best.y1) * u,
    });
    best = alongY(bisect((u) => allowed(toRect(alongY(u), ia), o)));
  }
  return toRect(best, ia);
}

/** The aspect presets of the crop tool: `[w, h]` in landscape form; the tool turns them to the crop's orientation. */
export const ASPECT_PRESETS: ReadonlyArray<{ label: string; ratio: [number, number] }> = [
  { label: '1:1', ratio: [1, 1] },
  { label: '4:5', ratio: [5, 4] },
  { label: '5:7', ratio: [7, 5] },
  { label: '2:3', ratio: [3, 2] },
  { label: '16:9', ratio: [16, 9] },
];

/** `ratio` turned to the orientation of `rect` (portrait crops get `[short, long]`). */
export function orientRatio(ratio: [number, number], rect: CropRect, ia: number): [number, number] {
  const portrait = rect.w * ia < rect.h;
  const [a, b] = ratio;
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return portrait ? [short, long] : [long, short];
}
