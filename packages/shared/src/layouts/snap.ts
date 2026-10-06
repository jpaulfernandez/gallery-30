/**
 * Snap rules from `docs/design/reference/layout-guide.md` as pure functions. Everything is in page
 * fractions along one axis (x: of the width, y: of the height). The guide is written for an 8 in
 * wide page, so 1 in = 0.125 of the width; on the y axis the same absolute inch is
 * 0.125 * width / height of the height. Width-fraction theme tokens convert the same way.
 *
 * `margin` and `gutter` go through `spacing()` (width fractions, like every token) so snap lines
 * coincide with the layouts' content box on any page.
 */
import type { BookTemplate, Frame, Theme } from '../schema.js';
import { spacing } from './geometry.js';

type Size = Pick<BookTemplate, 'width' | 'height'>;

export type SnapAxis = 'x' | 'y';
export type SnapKind = 'grid' | 'margin' | 'hard' | 'edge' | 'center' | 'frame' | 'gap';
export type SnapHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Theme tokens the snap rules read (a resolved `Theme` satisfies it). */
export type SnapTheme = Pick<Theme, 'margin' | 'gutter' | 'wideGutter' | 'hardMargin' | 'grid'>;

/**
 * Which side of a neighbour a gap line sits on: `before` (`o0 - gap`) only the moving frame's far
 * edge (right / bottom) may snap to it, `after` (`o1 + gap`) only its near edge (left / top). Any
 * other pairing would pull the frame over the neighbour.
 */
export type GapSide = 'before' | 'after';

export interface SnapLine {
  /** Position along the axis, page fraction. */
  value: number;
  kind: SnapKind;
  /** Higher wins when several lines are within the threshold; ties go to the nearest. */
  strength: number;
  /** Gap lines only: the frame edge allowed to snap to it. */
  side?: GapSide;
}

export interface SnapGuide {
  axis: SnapAxis;
  value: number;
  kind: SnapKind;
}

/** Page width in inches the guide's rules are written for. */
export const GUIDE_PAGE_WIDTH_IN = 8;

/** Line strengths: page edges, margins, other frames and gaps beat the grid. */
export const SNAP_STRENGTH: Record<SnapKind, number> = {
  edge: 4,
  margin: 4,
  frame: 3,
  gap: 3,
  hard: 2,
  center: 2,
  grid: 1,
};

/** One inch as a fraction of the page along `axis`. */
export function inchFraction(template: Size, axis: SnapAxis): number {
  const x = 1 / GUIDE_PAGE_WIDTH_IN;
  return axis === 'x' ? x : (x * template.width) / template.height;
}

/** A width-fraction token expressed along `axis`. */
export function tokenOnAxis(token: number, template: Size, axis: SnapAxis): number {
  return axis === 'x' ? token : (token * template.width) / template.height;
}

function marginGutter(theme: SnapTheme, template: Size, axis: SnapAxis): { margin: number; gutter: number } {
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);
  return axis === 'x' ? { margin: s.mx, gutter: s.gx } : { margin: s.my, gutter: s.gy };
}

/**
 * Photo-to-photo gap rule: under 0.1 in joins the photos (0), 0.1 to 0.3 in becomes the gutter,
 * 0.3 to 0.5 in the wide gutter, anything wider (or an overlap past 0.1 in) is left as is.
 */
export function snapGap(gap: number, theme: SnapTheme, template: Size, axis: SnapAxis): number {
  const inches = gap / inchFraction(template, axis);
  if (inches > -0.1 && inches < 0.1) return 0;
  if (inches >= 0.1 && inches < 0.3) return marginGutter(theme, template, axis).gutter;
  if (inches >= 0.3 && inches <= 0.5) return tokenOnAxis(theme.wideGutter, template, axis);
  return gap;
}

/**
 * Photo-to-trim rule: closer than 0.25 in (or past the trim) bleeds, which returns 0 ("touch the
 * page edge"; the print bleed is added on export); from 0.25 in up to the safe margin (0.64 in by
 * default) snaps to the safe margin; further in is left as is.
 */
export function snapToTrim(distance: number, theme: SnapTheme, template: Size, axis: SnapAxis): number {
  const inch = inchFraction(template, axis);
  if (distance < 0.25 * inch) return 0;
  const { margin } = marginGutter(theme, template, axis);
  if (distance <= margin) return margin;
  return distance;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * Every line a frame edge or centre can snap to, per axis: the theme grid, safe-margin and
 * hard-margin lines, page edges and centre, every other frame's edges and centre, and gutter /
 * wide-gutter positions beside each neighbour that shares a row (for x) or column (for y) with
 * `frame`, tagged with the side they belong to (see `GapSide`).
 */
export function snapCandidates(
  frame: Frame,
  others: readonly Frame[],
  theme: SnapTheme,
  template: Size,
): { x: SnapLine[]; y: SnapLine[] } {
  const line = (value: number, kind: SnapKind): SnapLine => ({ value, kind, strength: SNAP_STRENGTH[kind] });
  const gap = (value: number, side: GapSide): SnapLine => ({ ...line(value, 'gap'), side });
  const axisLines = (axis: SnapAxis): SnapLine[] => {
    const out: SnapLine[] = [];
    const step = tokenOnAxis(theme.grid, template, axis);
    if (step > 0) {
      const n = Math.floor(1 / step + 1e-9);
      for (let k = 1; k <= n; k++) if (k * step < 1 - 1e-9) out.push(line(k * step, 'grid'));
    }
    const { margin, gutter } = marginGutter(theme, template, axis);
    const hard = tokenOnAxis(theme.hardMargin, template, axis);
    const wide = tokenOnAxis(theme.wideGutter, template, axis);
    out.push(line(0, 'edge'), line(1, 'edge'), line(0.5, 'center'));
    out.push(line(margin, 'margin'), line(1 - margin, 'margin'));
    out.push(line(hard, 'hard'), line(1 - hard, 'hard'));
    const [p0, p1] = axis === 'x' ? [frame.y, frame.y + frame.h] : [frame.x, frame.x + frame.w];
    for (const o of others) {
      const [o0, size] = axis === 'x' ? [o.x, o.w] : [o.y, o.h];
      const o1 = o0 + size;
      out.push(line(o0, 'frame'), line(o1, 'frame'), line(o0 + size / 2, 'frame'));
      const [q0, q1] = axis === 'x' ? [o.y, o.y + o.h] : [o.x, o.x + o.w];
      if (overlaps(p0, p1, q0, q1)) {
        out.push(
          gap(o0 - gutter, 'before'),
          gap(o0 - wide, 'before'),
          gap(o1 + gutter, 'after'),
          gap(o1 + wide, 'after'),
        );
      }
    }
    return out;
  };
  return { x: axisLines('x'), y: axisLines('y') };
}

export interface SnapFrameOptions {
  /** Snap distance as a fraction of the page width (converted for the y axis). */
  threshold: number;
  /** Keep the frame's aspect ratio while resizing. */
  lockRatio?: boolean;
  /** What is being dragged (default `move`). */
  handle?: SnapHandle;
}

interface Hit {
  line: SnapLine;
  delta: number;
  /** Distance over threshold, 0..1, for comparing axes. */
  score: number;
}

/** Which feature of the moving frame a value is, along one axis. */
type EdgeRole = 'near' | 'center' | 'far';
type Probe = { value: number; role: EdgeRole };

/** Gap lines only take the edge on their side; every other line takes any feature. */
const accepts = (l: SnapLine, role: EdgeRole) =>
  l.side === undefined || (l.side === 'before' ? role === 'far' : role === 'near');

/** Best line for any of `probes` within `threshold`: strongest first, then nearest. */
function bestHit(probes: Probe[], lines: readonly SnapLine[], threshold: number): Hit | null {
  let best: Hit | null = null;
  for (const { value: v, role } of probes) {
    for (const l of lines) {
      if (!accepts(l, role)) continue;
      const d = Math.abs(l.value - v);
      if (d > threshold) continue;
      const hit = { line: l, delta: l.value - v, score: threshold > 0 ? d / threshold : 0 };
      if (!best || l.strength > best.line.strength || (l.strength === best.line.strength && hit.score < best.score)) {
        best = hit;
      }
    }
  }
  return best;
}

const better = (a: Hit, b: Hit) =>
  a.line.strength > b.line.strength || (a.line.strength === b.line.strength && a.score <= b.score);

const MIN_SIZE = 1e-3;

/**
 * Snap a moving or resizing frame to the nearest candidate lines within `threshold`, preferring
 * margins, page edges, other frames and gaps over the grid. `move` snaps the left edge, centre or
 * right edge (and top, middle or bottom) and keeps the size; edge and corner handles snap only the
 * dragged edges. With `lockRatio`, a corner snaps whichever axis has the stronger (then nearer) hit
 * and derives the other side from the ratio, anchored at the opposite corner; an edge handle keeps
 * the ratio by growing the other side around its centre. Returns the frame and the guides to draw.
 */
export function snapFrame(
  frame: Frame,
  others: readonly Frame[],
  theme: SnapTheme,
  template: Size,
  opts: SnapFrameOptions,
): { frame: Frame; guides: SnapGuide[] } {
  const handle = opts.handle ?? 'move';
  const lines = snapCandidates(frame, others, theme, template);
  const thr = { x: opts.threshold, y: tokenOnAxis(opts.threshold, template, 'y') };
  let { x, y, w, h } = frame;
  const hits: Partial<Record<SnapAxis, Hit>> = {};

  if (handle === 'move') {
    const probes = (p: number, size: number): Probe[] => [
      { value: p, role: 'near' },
      { value: p + size / 2, role: 'center' },
      { value: p + size, role: 'far' },
    ];
    const hx = bestHit(probes(x, w), lines.x, thr.x);
    const hy = bestHit(probes(y, h), lines.y, thr.y);
    if (hx) {
      x += hx.delta;
      hits.x = hx;
    }
    if (hy) {
      y += hy.delta;
      hits.y = hy;
    }
  } else {
    const east = handle.includes('e');
    const west = handle.includes('w');
    const north = handle.includes('n');
    const south = handle.includes('s');
    const right = x + w;
    const bottom = y + h;
    // Only the dragged edge may snap (and to gap lines on its own side only).
    const hx =
      east || west
        ? bestHit([east ? { value: right, role: 'far' } : { value: x, role: 'near' }], lines.x, thr.x)
        : null;
    const hy =
      north || south
        ? bestHit([south ? { value: bottom, role: 'far' } : { value: y, role: 'near' }], lines.y, thr.y)
        : null;
    // Width / height (page fractions) after snapping one dragged edge.
    const snapW = (hit: Hit) => (east ? right + hit.delta - x : right - (x + hit.delta));
    const snapH = (hit: Hit) => (south ? bottom + hit.delta - y : bottom - (y + hit.delta));
    const okX = hx && snapW(hx) > MIN_SIZE ? hx : null;
    const okY = hy && snapH(hy) > MIN_SIZE ? hy : null;

    if (!opts.lockRatio) {
      if (okX) {
        const nw = snapW(okX);
        if (west) x = right - nw;
        w = nw;
        hits.x = okX;
      }
      if (okY) {
        const nh = snapH(okY);
        if (north) y = bottom - nh;
        h = nh;
        hits.y = okY;
      }
    } else {
      const ratio = frame.w / frame.h;
      const corner = (east || west) && (north || south);
      const useX = okX && (!okY || better(okX, okY));
      if (useX && okX) {
        const nw = snapW(okX);
        const nh = nw / ratio;
        if (west) x = right - nw;
        if (corner) {
          if (north) y = bottom - nh;
        } else {
          y = frame.y + frame.h / 2 - nh / 2;
        }
        w = nw;
        h = nh;
        hits.x = okX;
      } else if (okY) {
        const nh = snapH(okY);
        const nw = nh * ratio;
        if (north) y = bottom - nh;
        if (corner) {
          if (west) x = right - nw;
        } else {
          x = frame.x + frame.w / 2 - nw / 2;
        }
        w = nw;
        h = nh;
        hits.y = okY;
      }
    }
  }

  const out: Frame = { x, y, w, h };
  const guides: SnapGuide[] = [];
  const seen = new Set<string>();
  const add = (axis: SnapAxis, l: SnapLine) => {
    const key = `${axis}:${l.kind}:${l.value.toFixed(9)}`;
    if (seen.has(key)) return;
    seen.add(key);
    guides.push({ axis, value: l.value, kind: l.kind });
  };
  for (const axis of ['x', 'y'] as const) {
    const hit = hits[axis];
    if (!hit) continue;
    add(axis, hit.line);
    // Other non-grid lines the snapped frame now also sits on.
    const [p, size] = axis === 'x' ? [out.x, out.w] : [out.y, out.h];
    const features: Probe[] = [
      { value: p, role: 'near' },
      { value: p + size / 2, role: 'center' },
      { value: p + size, role: 'far' },
    ];
    for (const l of lines[axis]) {
      if (l.kind === 'grid') continue;
      if (features.some((f) => accepts(l, f.role) && Math.abs(f.value - l.value) < 1e-9)) add(axis, l);
    }
  }
  return { frame: out, guides };
}
