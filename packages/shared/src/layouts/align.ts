/**
 * Alignment maths for a multi-selection on the canvas (workflow plan 30): align, distribute, match
 * size and tidy, on frame records keyed by element id. Everything is in page fractions; the result
 * holds every input frame (moved or not), rounded to 1e-6 like the editor's frame maths. Pure: the
 * editor writes the result with one `setFrames` (one undo step).
 */
import type { Frame } from '../schema.js';
import type { SnapAxis } from './snap.js';

export type FrameRecord = Readonly<Record<string, Frame>>;

/** Align to the selection's bounding box: its left, centre or right (x), top, middle or bottom (y). */
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export type MatchDimension = 'width' | 'height';

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;
const cleanFrame = (f: Frame): Frame => ({ x: clean(f.x), y: clean(f.y), w: clean(f.w), h: clean(f.h) });

const start = (f: Frame, axis: SnapAxis) => (axis === 'x' ? f.x : f.y);
const size = (f: Frame, axis: SnapAxis) => (axis === 'x' ? f.w : f.h);
const crossStart = (f: Frame, axis: SnapAxis) => (axis === 'x' ? f.y : f.x);
const crossSize = (f: Frame, axis: SnapAxis) => (axis === 'x' ? f.h : f.w);
const at = (f: Frame, axis: SnapAxis, value: number): Frame => (axis === 'x' ? { ...f, x: value } : { ...f, y: value });

function bounds(frames: readonly Frame[]): Frame {
  const x0 = Math.min(...frames.map((f) => f.x));
  const y0 = Math.min(...frames.map((f) => f.y));
  const x1 = Math.max(...frames.map((f) => f.x + f.w));
  const y1 = Math.max(...frames.map((f) => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function mapFrames(frames: FrameRecord, fn: (f: Frame, id: string) => Frame): Record<string, Frame> {
  const out: Record<string, Frame> = {};
  for (const [id, f] of Object.entries(frames)) out[id] = cleanFrame(fn(f, id));
  return out;
}

/** Align every frame to one side or the centre line of the frames' bounding box. Two frames or more. */
export function alignFrames(frames: FrameRecord, edge: AlignEdge): Record<string, Frame> {
  const list = Object.values(frames);
  if (list.length < 2) return { ...frames };
  const box = bounds(list);
  return mapFrames(frames, (f) => {
    switch (edge) {
      case 'left':
        return { ...f, x: box.x };
      case 'center':
        return { ...f, x: box.x + box.w / 2 - f.w / 2 };
      case 'right':
        return { ...f, x: box.x + box.w - f.w };
      case 'top':
        return { ...f, y: box.y };
      case 'middle':
        return { ...f, y: box.y + box.h / 2 - f.h / 2 };
      case 'bottom':
        return { ...f, y: box.y + box.h - f.h };
    }
  });
}

/** Ids in order along `axis`: by start, then centre, then id (stable for equal positions). */
function ordered(frames: FrameRecord, ids: readonly string[], axis: SnapAxis): string[] {
  const f = (id: string) => frames[id] as Frame;
  return [...ids].sort(
    (a, b) =>
      start(f(a), axis) - start(f(b), axis) ||
      start(f(a), axis) + size(f(a), axis) / 2 - (start(f(b), axis) + size(f(b), axis) / 2) ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
}

/** Place `ids` (in order) along `axis` from `from`, `gap` apart. */
function lay(frames: FrameRecord, ids: readonly string[], axis: SnapAxis, from: number, gap: number) {
  const out: Record<string, Frame> = {};
  let p = from;
  for (const id of ids) {
    const f = frames[id] as Frame;
    out[id] = at(f, axis, p);
    p += size(f, axis) + gap;
  }
  return out;
}

/**
 * Distribute horizontally (x) or vertically (y): the first and last frames along the axis stay, the
 * ones between move so that every gap is the same. Three frames or more; fewer come back unchanged,
 * and so do frames where two consecutive ones overlap along the axis (`lineOverlaps`).
 */
export function distributeFrames(frames: FrameRecord, axis: SnapAxis): Record<string, Frame> {
  const ids = Object.keys(frames);
  if (ids.length < 3) return { ...frames };
  const order = ordered(frames, ids, axis);
  // Overlapping frames along the axis (one inside another) have no order to space out: leave them.
  if (lineOverlaps(frames, order, axis)) return { ...frames };
  const list = order.map((id) => frames[id] as Frame);
  const first = list[0] as Frame;
  const end = Math.max(...list.map((f) => start(f, axis) + size(f, axis)));
  const total = list.reduce((sum, f) => sum + size(f, axis), 0);
  const gap = (end - start(first, axis) - total) / (list.length - 1);
  const placed = lay(frames, order, axis, start(first, axis), gap);
  return mapFrames(frames, (f, id) => placed[id] ?? f);
}

/**
 * Give every frame the width or height of the reference frame (`referenceId`, else the largest
 * along that dimension). Frames keep their left or top edge.
 */
export function matchFrames(
  frames: FrameRecord,
  dimension: MatchDimension,
  referenceId?: string,
): Record<string, Frame> {
  const list = Object.values(frames);
  if (list.length < 2) return { ...frames };
  const key = dimension === 'width' ? 'w' : 'h';
  const ref = (referenceId && frames[referenceId]) || list.reduce((a, b) => (b[key] > a[key] ? b : a));
  return mapFrames(frames, (f) => ({ ...f, [key]: ref[key] }));
}

/**
 * Two frames share a row (x) or column (y) when each one's centre across the axis lies inside the
 * other's span (mutual containment): a three-up row with small offsets is one row; a tall frame
 * beside two stacked ones is not a row with them, and neither is a short top-aligned caption beside
 * a tall photo (the photo's centre is below the caption).
 */
function sameLine(a: Frame, b: Frame, axis: SnapAxis): boolean {
  const ca = crossStart(a, axis) + crossSize(a, axis) / 2;
  const cb = crossStart(b, axis) + crossSize(b, axis) / 2;
  const inside = (c: number, f: Frame) => c > crossStart(f, axis) && c < crossStart(f, axis) + crossSize(f, axis);
  return inside(ca, b) && inside(cb, a);
}

/** The rows (x) or columns (y) of `ids`: groups linked by `sameLine`, in input order, ids ordered along the axis. */
export function frameLines(
  frames: FrameRecord,
  axis: SnapAxis,
  ids: readonly string[] = Object.keys(frames),
): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(id, r);
    return r;
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as string;
      const b = ids[j] as string;
      if (sameLine(frames[a] as Frame, frames[b] as Frame, axis)) parent.set(find(a), find(b));
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const g = groups.get(r) ?? [];
    g.push(id);
    groups.set(r, g);
  }
  return [...groups.values()].map((g) => ordered(frames, g, axis));
}

/** Overlap along the axis beyond float noise that makes a line unorderable. */
const OVERLAP_EPS = 1e-6;

/**
 * Whether two consecutive frames of a line (`ids` in order along `axis`) overlap along it (a text
 * box over a photo, a frame inside a bigger one). Tidy and distribute leave such a line alone.
 */
export function lineOverlaps(frames: FrameRecord, ids: readonly string[], axis: SnapAxis): boolean {
  return lineGaps(frames, ids, axis).some((g) => g < -OVERLAP_EPS);
}

/** The gaps between consecutive frames of one row or column (`ids` in order along `axis`). */
export function lineGaps(frames: FrameRecord, ids: readonly string[], axis: SnapAxis): number[] {
  const out: number[] = [];
  for (let i = 1; i < ids.length; i++) {
    const a = frames[ids[i - 1] as string] as Frame;
    const b = frames[ids[i] as string] as Frame;
    out.push(start(b, axis) - (start(a, axis) + size(a, axis)));
  }
  return out;
}

export interface TidyOptions {
  /**
   * The gap to use on a row from its mean gap (default: the mean, which keeps the row's extent).
   * The editor maps it onto the page's gutter rhythm (`snapGap`) and falls back to the mean when the
   * row would no longer fit on the page (`line`: the row's ids and the sum of their sizes).
   */
  gap?: (mean: number, axis: SnapAxis, line: { ids: readonly string[]; sizes: number }) => number;
}

/**
 * Tidy: equal gaps on the current rows. Every row of two frames or more (see `frameLines`) gets one
 * gap between all its frames, `opts.gap` of the row's mean gap, and stays centred where it was;
 * only the x positions change, so a grid keeps its vertical gaps. A row whose frames overlap along
 * it (`lineOverlaps`) is left alone. When no row has two frames (a single column), the columns are
 * tidied the same way along y.
 */
export function tidyFrames(frames: FrameRecord, opts: TidyOptions = {}): Record<string, Frame> {
  const tidyAxis = (axis: SnapAxis): Record<string, Frame> | null => {
    const lines = frameLines(frames, axis).filter((l) => l.length > 1);
    if (lines.length === 0) return null;
    const placed: Record<string, Frame> = {};
    for (const ids of lines) Object.assign(placed, tidyLine(frames, ids, axis, opts));
    return mapFrames(frames, (f, id) => placed[id] ?? f);
  };
  return tidyAxis('x') ?? tidyAxis('y') ?? { ...frames };
}

/**
 * Tidy one row (x) or column (y): `ids` in order along `axis`, as `frameLines` returns them. Returns
 * nothing for a line whose frames overlap along the axis.
 */
export function tidyLine(
  frames: FrameRecord,
  ids: readonly string[],
  axis: SnapAxis,
  opts: TidyOptions = {},
): Record<string, Frame> {
  if (ids.length < 2 || lineOverlaps(frames, ids, axis)) return {};
  const list = ids.map((id) => frames[id] as Frame);
  const gaps = lineGaps(frames, ids, axis);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sizes = list.reduce((sum, f) => sum + size(f, axis), 0);
  const gap = opts.gap ? opts.gap(mean, axis, { ids, sizes }) : mean;
  const lo = Math.min(...list.map((f) => start(f, axis)));
  const hi = Math.max(...list.map((f) => start(f, axis) + size(f, axis)));
  const total = sizes + gap * (ids.length - 1);
  const placed = lay(frames, ids, axis, (lo + hi) / 2 - total / 2, gap);
  const out: Record<string, Frame> = {};
  for (const id of ids) out[id] = cleanFrame(placed[id] as Frame);
  return out;
}

/** Population standard deviation of a row's gaps (0 for fewer than two gaps). */
export function gapSpread(gaps: readonly number[]): number {
  if (gaps.length < 2) return 0;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.sqrt(gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length);
}
