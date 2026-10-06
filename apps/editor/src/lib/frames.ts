import {
  type Asset,
  type BookTemplate,
  type Frame,
  GUIDE_PAGE_WIDTH_IN,
  LAYOUT_CUSTOM,
  type LayoutData,
  LayoutDataSchema,
  type LayoutItem,
  newId,
  type Page,
  type PhotoElement,
  type SnapHandle,
  spacing,
  type TextElement,
  type TextKind,
  type Theme,
} from '@photobook/shared';

/**
 * Frame geometry for the custom frame tools (draw, resize, grid, merge, split, save as layout).
 * Pure functions in page fractions (x, w of the width; y, h of the height), no stores, no React.
 */

type Size = Pick<BookTemplate, 'width' | 'height'>;
type Element = Page['elements'][number];

/** Smallest photo short side from the layout guide, inches on the 8 in reference page. */
export const MIN_PHOTO_IN = 1.5;
/** Smallest text box side, inches (a one-line caption is about 0.6 in tall). */
export const MIN_TEXT_IN = 0.25;
/** Most frames a grid can have per axis. */
export const GRID_MAX = 6;
/** Photo count a saved layout must have (`LayoutDataSchema`). */
export const LAYOUT_MIN_PHOTOS = 1;
export const LAYOUT_MAX_PHOTOS = 6;

/** Drop float noise so values compare and serialize cleanly; `+ 0` turns -0 into 0. */
export const clean = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const cleanFrame = (f: Frame): Frame => ({ x: clean(f.x), y: clean(f.y), w: clean(f.w), h: clean(f.h) });

/** Inches per page fraction along each axis (8 in wide reference page). */
export function inchesPerUnit(template: Size): { x: number; y: number } {
  return { x: GUIDE_PAGE_WIDTH_IN, y: (GUIDE_PAGE_WIDTH_IN * template.height) / template.width };
}

/** Minimum frame size as page fractions: 1.5 in for photos (0.1875 of the width), 0.25 in for text. */
export function minFrameSize(template: Size, kind: Element['type']): { w: number; h: number } {
  const inches = kind === 'photo' ? MIN_PHOTO_IN : MIN_TEXT_IN;
  const per = inchesPerUnit(template);
  return { w: inches / per.x, h: inches / per.y };
}

/** A new empty photo frame. */
export function emptyFrame(frame: Frame, id: string = newId()): PhotoElement {
  return {
    type: 'photo',
    id,
    asset: null,
    frame: cleanFrame(frame),
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none',
  };
}

/**
 * The frame a photo dropped on a page (not on a slot) gets: the largest rectangle of the photo's
 * upright aspect (from its scanned size; unknown: the safe-margin box itself) that fits inside the
 * safe margins, centred on the page.
 */
export function photoDropFrame(
  asset: Pick<Asset, 'width' | 'height'> | undefined,
  theme: Pick<Theme, 'margin' | 'gutter'>,
  template: Size,
): Frame {
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);
  const liveW = (1 - 2 * s.mx) * template.width;
  const liveH = (1 - 2 * s.my) * template.height;
  const ratio = asset?.width && asset.height ? asset.width / asset.height : liveW / liveH;
  const w = Math.min(liveW, liveH * ratio);
  const h = w / ratio;
  const fw = w / template.width;
  const fh = h / template.height;
  return cleanFrame({ x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh });
}

// Pointer and drawing -------------------------------------------------------------------------------

/** A viewport point as page fractions of `rect` (the page box on screen), clamped to the page. */
export function pointToPage(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}

/**
 * The rectangle between the press point (`anchor`) and the pointer, and the corner handle the
 * pointer is dragging (the anchor is the opposite corner), e.g. dragging down-right is `se`.
 */
export function rectFromDrag(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
): { frame: Frame; handle: SnapHandle } {
  const handle = `${point.y < anchor.y ? 'n' : 's'}${point.x < anchor.x ? 'w' : 'e'}` as SnapHandle;
  return {
    frame: {
      x: Math.min(anchor.x, point.x),
      y: Math.min(anchor.y, point.y),
      w: Math.abs(point.x - anchor.x),
      h: Math.abs(point.y - anchor.y),
    },
    handle,
  };
}

/**
 * A drawn frame: the drag rectangle grown to the minimum size away from the anchor, then kept on
 * the page (the anchor corner stays put). See `fitResized`.
 */
export function drawnFrame(
  anchor: { x: number; y: number },
  point: { x: number; y: number },
  min: { w: number; h: number },
): Frame {
  const { frame, handle } = rectFromDrag(anchor, point);
  return fitResized(frame, frame, handle, false, min);
}

// Resizing ------------------------------------------------------------------------------------------

const sides = (handle: SnapHandle) => ({
  east: handle.includes('e'),
  west: handle.includes('w'),
  north: handle.includes('n'),
  south: handle.includes('s'),
});

/**
 * The frame a resize handle drag of (dx, dy) page fractions asks for, before snapping. Free: the
 * dragged edges follow the pointer. Locked: the frame keeps `start`'s aspect; a corner scales by
 * whichever axis changed more, relative to the frame (anchored at the opposite corner), an edge sets its side and
 * grows the other one around the centre.
 */
export function resizeFrame(start: Frame, handle: SnapHandle, dx: number, dy: number, lock: boolean): Frame {
  if (handle === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  const { east, west, north, south } = sides(handle);
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  let w = east ? start.w + dx : west ? start.w - dx : start.w;
  let h = south ? start.h + dy : north ? start.h - dy : start.h;
  if (lock && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    const horizontal = east || west;
    const vertical = north || south;
    if (horizontal && vertical) {
      // Follow the axis the pointer moved further along (relative to the frame's size).
      const sx = w / start.w;
      const sy = h / start.h;
      const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
      w = start.w * s;
      h = start.h * s;
    } else if (horizontal) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
  }
  const horizontal = east || west;
  const vertical = north || south;
  const x = west ? right - w : horizontal || !lock ? start.x : start.x + start.w / 2 - w / 2;
  const y = north ? bottom - h : vertical || !lock ? start.y : start.y + start.h / 2 - h / 2;
  return { x, y, w, h };
}

/**
 * How far past the trim a frame may sit, page fractions per axis: photos may run into the bleed
 * (`theme.bleed`, a fraction of the width; the same distance on the y axis), text stays inside the
 * trim. Moves (`clampMovedFrame`) and resizes (`fitResized`) share it.
 */
export function bleedBounds(kind: Element['type'], bleed: number, template: Size): { x: number; y: number } {
  if (kind !== 'photo') return { x: 0, y: 0 };
  return { x: bleed, y: (bleed * template.width) / template.height };
}

/**
 * Enforce the minimum size and keep a resized frame inside the page plus `bounds` past the trim
 * (default none: 0..1; photos get the bleed, see `bleedBounds`), with the edges the handle does
 * not move anchored where they were in `start`. Locked frames keep `start`'s aspect (an edge
 * handle keeps the other axis centred). Staying inside the bounds wins over the minimum size.
 */
export function fitResized(
  frame: Frame,
  start: Frame,
  handle: SnapHandle,
  lock: boolean,
  min: { w: number; h: number },
  bounds: { x: number; y: number } = { x: 0, y: 0 },
): Frame {
  if (handle === 'move') return cleanFrame(frame);
  const { east, west, north, south } = sides(handle);
  const horizontal = east || west;
  const vertical = north || south;
  const x0 = -bounds.x;
  const x1 = 1 + bounds.x;
  const y0 = -bounds.y;
  const y1 = 1 + bounds.y;

  if (!lock) {
    let { x, y, w, h } = frame;
    if (east) {
      const right = clamp(Math.max(x + w, start.x + min.w), x0, x1);
      x = start.x;
      w = right - x;
    } else if (west) {
      const right = start.x + start.w;
      x = clamp(Math.min(x, right - min.w), x0, x1);
      w = right - x;
    }
    if (south) {
      const bottom = clamp(Math.max(y + h, start.y + min.h), y0, y1);
      y = start.y;
      h = bottom - y;
    } else if (north) {
      const bottom = start.y + start.h;
      y = clamp(Math.min(y, bottom - min.h), y0, y1);
      h = bottom - y;
    }
    return cleanFrame({ x, y, w: Math.max(w, 1e-6), h: Math.max(h, 1e-6) });
  }

  const ratio = start.w / start.h;
  const ax = east ? start.x : start.x + start.w;
  const ay = south ? start.y : start.y + start.h;
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const maxW = horizontal ? (east ? x1 - ax : ax - x0) : 2 * Math.min(cx - x0, x1 - cx);
  const maxH = vertical ? (south ? y1 - ay : ay - y0) : 2 * Math.min(cy - y0, y1 - cy);
  let w = Math.max(frame.w, min.w, min.h * ratio);
  w = Math.max(1e-6, Math.min(w, maxW, maxH * ratio));
  const h = w / ratio;
  const x = horizontal ? (east ? ax : ax - w) : cx - w / 2;
  const y = vertical ? (south ? ay : ay - h) : cy - h / 2;
  return cleanFrame({ x, y, w, h });
}

/**
 * A frame typed in the inspector (inches), applied to `frame`: X / Y move it, W / H resize it from
 * the top-left corner (keeping the aspect when `lock`), with the minimum size and the page bounds.
 */
export function frameWithField(
  frame: Frame,
  field: 'x' | 'y' | 'w' | 'h',
  inches: number,
  opts: { template: Size; lock: boolean; min: { w: number; h: number }; bleed: { x: number; y: number } },
): Frame {
  const per = inchesPerUnit(opts.template);
  const v = inches / (field === 'x' || field === 'w' ? per.x : per.y);
  if (field === 'x') return cleanFrame({ ...frame, x: clamp(v, -opts.bleed.x, 1 + opts.bleed.x - frame.w) });
  if (field === 'y') return cleanFrame({ ...frame, y: clamp(v, -opts.bleed.y, 1 + opts.bleed.y - frame.h) });
  // Resize from the top-left: the right / bottom edge is the dragged one. Frames sitting in the
  // bleed are pulled onto the page first so the anchor is valid.
  const start: Frame = {
    x: clamp(frame.x, 0, 1),
    y: clamp(frame.y, 0, 1),
    w: Math.min(frame.w, 1 - clamp(frame.x, 0, 1)),
    h: Math.min(frame.h, 1 - clamp(frame.y, 0, 1)),
  };
  const ratio = frame.w / frame.h;
  if (field === 'w') {
    const wanted = { ...start, w: v, h: opts.lock ? v / ratio : start.h };
    return fitResized(
      wanted,
      { ...start, h: opts.lock ? start.w / ratio : start.h },
      opts.lock ? 'se' : 'e',
      opts.lock,
      opts.min,
    );
  }
  const wanted = { ...start, h: v, w: opts.lock ? v * ratio : start.w };
  return fitResized(
    wanted,
    { ...start, w: opts.lock ? start.h * ratio : start.w },
    opts.lock ? 'se' : 's',
    opts.lock,
    opts.min,
  );
}

// Grid, merge, split --------------------------------------------------------------------------------

export interface FrameGridOptions {
  /** Columns, 1 to 6. */
  cols: number;
  /** Rows, 1 to 6. */
  rows: number;
  /** Use the wide gutter (0.4 in) instead of the gutter (0.2 in). */
  wide?: boolean;
  /** Fill the whole page (outer frames bleed) instead of the safe-margin box. */
  bleed?: boolean;
}

/**
 * `cols` x `rows` frames in reading order (row by row), like the reference `grid(LIVE, cols, rows,
 * all())`: the safe-margin box (or the whole page with `bleed`) split evenly with the theme gutter
 * (or wide gutter) between frames, the same absolute distance on both axes.
 */
export function gridFrames(
  options: FrameGridOptions,
  theme: Pick<Theme, 'margin' | 'gutter' | 'wideGutter'>,
  template: Size,
): Frame[] {
  const cols = clamp(Math.round(options.cols), 1, GRID_MAX);
  const rows = clamp(Math.round(options.rows), 1, GRID_MAX);
  const s = spacing(theme.margin, options.wide ? theme.wideGutter : theme.gutter, template.width / template.height);
  const box: Frame = options.bleed
    ? { x: 0, y: 0, w: 1, h: 1 }
    : { x: s.mx, y: s.my, w: 1 - 2 * s.mx, h: 1 - 2 * s.my };
  const cw = (box.w - s.gx * (cols - 1)) / cols;
  const rh = (box.h - s.gy * (rows - 1)) / rows;
  const out: Frame[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(cleanFrame({ x: box.x + c * (cw + s.gx), y: box.y + r * (rh + s.gy), w: cw, h: rh }));
    }
  }
  return out;
}

/** The smallest frame containing every frame (null for none). */
export function boundingBox(frames: readonly Frame[]): Frame | null {
  if (frames.length === 0) return null;
  const x0 = Math.min(...frames.map((f) => f.x));
  const y0 = Math.min(...frames.map((f) => f.y));
  const x1 = Math.max(...frames.map((f) => f.x + f.w));
  const y1 = Math.max(...frames.map((f) => f.y + f.h));
  return cleanFrame({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

/**
 * Which way a split cuts: `horizontal` cuts with a horizontal line (top and bottom frames),
 * `vertical` with a vertical line (left and right frames).
 */
export type SplitAxis = 'horizontal' | 'vertical';

/**
 * Two halves of `frame` with a gutter between them (theme gutter on that axis). Null when the
 * frame is too small to hold the gutter.
 */
export function splitRect(
  frame: Frame,
  axis: SplitAxis,
  theme: Pick<Theme, 'margin' | 'gutter'>,
  template: Size,
): [Frame, Frame] | null {
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);
  if (axis === 'vertical') {
    const w = (frame.w - s.gx) / 2;
    if (!(w > 1e-4)) return null;
    return [cleanFrame({ ...frame, w }), cleanFrame({ ...frame, x: frame.x + w + s.gx, w })];
  }
  const h = (frame.h - s.gy) / 2;
  if (!(h > 1e-4)) return null;
  return [cleanFrame({ ...frame, h }), cleanFrame({ ...frame, y: frame.y + h + s.gy, h })];
}

// Save as layout ------------------------------------------------------------------------------------

/** The layout text role a text element is saved as (see `textForLayoutItem` for the way back). */
export function textKindOf(el: TextElement): TextKind {
  if (el.overlay) return 'overlay';
  switch (el.style) {
    case 'title':
      return 'title';
    case 'body':
      return el.box ? 'cell' : 'para';
    case 'quote':
      return 'quote';
    case 'date':
      return 'cap1';
    default:
      return el.align === 'right' ? 'capR' : 'cap';
  }
}

export const photoCount = (page: Pick<Page, 'elements'>): number =>
  page.elements.filter((e) => e.type === 'photo').length;

/** Why a page cannot be saved as a layout, or null when it can. */
export function saveLayoutBlocker(page: Pick<Page, 'elements'>): string | null {
  if (page.elements.length === 0) return 'Add frames to the page first';
  const n = photoCount(page);
  if (n < LAYOUT_MIN_PHOTOS) return 'A layout needs at least one photo frame';
  if (n > LAYOUT_MAX_PHOTOS) return `A layout holds at most ${LAYOUT_MAX_PHOTOS} photos (this page has ${n})`;
  return null;
}

const touchesTrim = (f: Frame) => f.x <= 1e-5 || f.y <= 1e-5 || f.x + f.w >= 1 - 1e-5 || f.y + f.h >= 1 - 1e-5;

/**
 * A page's frames as a custom layout: photos become `photo` items, text elements their text role
 * (`textKindOf`), in element order. Null when the page cannot be saved (`saveLayoutBlocker`).
 */
export function pageToLayoutData(
  page: Pick<Page, 'elements'>,
  name: string,
  id = `custom-${newId()}`,
): LayoutData | null {
  if (saveLayoutBlocker(page)) return null;
  const items: LayoutItem[] = page.elements.map((el) => ({
    kind: el.type === 'photo' ? 'photo' : textKindOf(el),
    ...cleanFrame(el.frame),
  }));
  const photos = items.filter((i) => i.kind === 'photo');
  const data: LayoutData = {
    id,
    name: name.trim() || 'Custom layout',
    photos: photos.length,
    group: 'custom',
    source: 'custom',
    items,
  };
  if (photos.some(touchesTrim)) data.bleed = true;
  const parsed = LayoutDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

// Page transforms (pure; the store wraps them as undoable actions) --------------------------------

const isPhoto = (el: Element): el is PhotoElement => el.type === 'photo';

/** Index after the last photo element, so new frames paint below every text element after them. */
function photoInsertIndex(elements: readonly Element[]): number {
  let at = 0;
  elements.forEach((el, i) => {
    if (el.type === 'photo') at = i + 1;
  });
  return at;
}

/** The page with a new empty frame added (after the last photo), marked custom. */
export function withFrame(page: Page, frame: Frame, id: string = newId()): Page {
  const elements = [...page.elements];
  elements.splice(photoInsertIndex(elements), 0, emptyFrame(frame, id));
  return { ...page, layout: LAYOUT_CUSTOM, elements };
}

/**
 * The page filled with a grid of frames (`gridFrames`): the page's empty frames are replaced, its
 * filled photos keep their ids, photo, crop, rotation and filter and are poured into the cells in
 * page order (as `applyLayout` does; photos beyond the last cell are dropped from the page), text
 * elements stay as they are, after the photos. Marked custom.
 */
export function withFrameGrid(
  page: Page,
  options: FrameGridOptions,
  theme: Pick<Theme, 'margin' | 'gutter' | 'wideGutter'>,
  template: Size,
): Page {
  const cells = gridFrames(options, theme, template);
  const filled = page.elements.filter(isPhoto).filter((el) => el.asset !== null);
  const photos: PhotoElement[] = cells.map((frame, i) => {
    const prev = filled[i];
    if (!prev) return emptyFrame(frame);
    const { ratio: _ratio, ...rest } = prev;
    return { ...rest, frame: { ...frame } };
  });
  const texts = page.elements.filter((el) => el.type === 'text');
  return { ...page, layout: LAYOUT_CUSTOM, elements: [...photos, ...texts] };
}

/**
 * The page with the photo frames among `ids` (two or more) replaced by one frame at their bounding
 * box: the first filled one in page order (else the first one) keeps its id and photo and takes
 * the box; the others are removed. Text ids are ignored. Null when fewer than two frames match.
 */
export function withMergedFrames(page: Page, ids: readonly string[]): { page: Page; id: string } | null {
  const chosen = page.elements.filter((el): el is PhotoElement => isPhoto(el) && ids.includes(el.id));
  if (chosen.length < 2) return null;
  const box = boundingBox(chosen.map((el) => el.frame));
  const keep = chosen.find((el) => el.asset !== null) ?? chosen[0];
  if (!box || !keep) return null;
  const drop = new Set(chosen.filter((el) => el !== keep).map((el) => el.id));
  const { ratio: _ratio, ...rest } = keep;
  const elements = page.elements
    .filter((el) => !drop.has(el.id))
    .map((el): Element => (el.id === keep.id ? { ...rest, frame: box } : el));
  return { page: { ...page, layout: LAYOUT_CUSTOM, elements }, id: keep.id };
}

/**
 * The page with photo frame `id` split in two with a gutter between (`splitRect`): the frame keeps
 * its id and photo in the first half (top or left); a new empty frame takes the second half, right
 * after it. Null when the frame is missing or too small.
 */
export function withSplitFrame(
  page: Page,
  id: string,
  axis: SplitAxis,
  theme: Pick<Theme, 'margin' | 'gutter'>,
  template: Size,
): { page: Page; ids: [string, string] } | null {
  const index = page.elements.findIndex((el) => el.id === id);
  const el = page.elements[index];
  if (!el || !isPhoto(el)) return null;
  const halves = splitRect(el.frame, axis, theme, template);
  if (!halves) return null;
  const { ratio: _ratio, ...rest } = el;
  const second = emptyFrame(halves[1]);
  const elements = [...page.elements];
  elements.splice(index, 1, { ...rest, frame: halves[0] }, second);
  return { page: { ...page, layout: LAYOUT_CUSTOM, elements }, ids: [el.id, second.id] };
}
