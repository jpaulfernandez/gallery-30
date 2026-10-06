import type { BookTemplate, LayoutData, LayoutItem, Theme } from '../schema.js';
import { spacing } from './geometry.js';
import { LIBRARY_GUTTER, LIBRARY_MARGIN, LIBRARY_PAGE } from './library.js';
import type { LayoutDef, LayoutPhotoCount, LayoutVariant } from './types.js';

/** Margin and gutter (width fractions); the wide gutter defaults to twice the gutter, as in the guide. */
type Spacing = Pick<Theme, 'margin' | 'gutter'> & Partial<Pick<Theme, 'wideGutter'>>;
type Size = Pick<BookTemplate, 'width' | 'height'>;

/** Edges this close to 0 or 1 count as touching the trim (bleed) and are never moved. */
const EDGE_EPS = 1e-5;
const MIN_SIZE = 1e-6;
/** Distinct edge coordinates closer than this are one edge. */
const SAME_EDGE = 1e-6;
/** A segment this close to the library gutter or wide gutter is a gap between items. */
const GAP_TOLERANCE = 1e-3;
/** Content never shrinks below this share of the live length, however wide the gutters. */
const MIN_CONTENT_SHARE = 0.05;
/** Library wide gutter (0.4 in), fraction of the page width. */
const LIBRARY_WIDE_GUTTER = 2 * LIBRARY_GUTTER;

interface AxisSpec {
  /** Authored margin and gaps on this axis, fractions of the page along it. */
  srcMargin: number;
  srcGutter: number;
  srcWide: number;
  /** Theme margin and gaps on this axis. */
  dstMargin: number;
  dstGutter: number;
  dstWide: number;
}

const near = (list: readonly number[], v: number) => list.some((x) => Math.abs(x - v) < SAME_EDGE);

/**
 * A monotone map of one axis from the authored page to the theme's. Inside the live area the
 * sorted distinct item edges split it into segments; a segment as long as the library gutter or
 * wide gutter with an item ending at its start and another starting at its end is a gap and gets
 * the theme gutter / wide gutter; every other segment is content and scales uniformly so content
 * plus gaps fill the theme's live length. Outside the live area (the margin band) values follow
 * the live scale linearly; trim edges (0 and 1) never move.
 */
function axisMap(starts: readonly number[], ends: readonly number[], a: AxisSpec): (v: number) => number {
  const s0 = a.srcMargin;
  const s1 = 1 - a.srcMargin;
  const d0 = a.dstMargin;
  const d1 = 1 - a.dstMargin;
  const inside = [...starts, ...ends].filter((v) => v > s0 + SAME_EDGE && v < s1 - SAME_EDGE).sort((x, y) => x - y);
  const edges: number[] = [s0];
  for (const v of inside) if (v - (edges[edges.length - 1] ?? s0) >= SAME_EDGE) edges.push(v);
  if (s1 - (edges[edges.length - 1] ?? s0) < SAME_EDGE) edges.pop();
  edges.push(s1);

  // Per segment: its new length if it is a gap, null for content.
  const gaps: Array<number | null> = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const len = hi - lo;
    const bounded = near(ends, lo) && near(starts, hi);
    if (bounded && Math.abs(len - a.srcGutter) < GAP_TOLERANCE) gaps.push(a.dstGutter);
    else if (bounded && Math.abs(len - a.srcWide) < GAP_TOLERANCE) gaps.push(a.dstWide);
    else gaps.push(null);
  }
  const srcLive = s1 - s0;
  const dstLive = d1 - d0;
  let srcContent = 0;
  let dstGaps = 0;
  gaps.forEach((g, i) => {
    if (g === null) srcContent += (edges[i + 1] as number) - (edges[i] as number);
    else dstGaps += g;
  });
  // Keep some content even with absurd gutters: shrink the gaps instead.
  const minContent = srcContent > 0 ? MIN_CONTENT_SHARE * dstLive : 0;
  const gapScale = dstGaps > 0 && dstLive - dstGaps < minContent ? Math.max(0, dstLive - minContent) / dstGaps : 1;
  const contentScale = srcContent > 0 ? (dstLive - dstGaps * gapScale) / srcContent : 0;

  const targets: number[] = [d0];
  gaps.forEach((g, i) => {
    const len = g === null ? ((edges[i + 1] as number) - (edges[i] as number)) * contentScale : g * gapScale;
    targets.push((targets[i] as number) + len);
  });
  targets[targets.length - 1] = d1;
  const live = srcLive > 0 ? dstLive / srcLive : 1;

  return (v) => {
    if (v <= EDGE_EPS || v >= 1 - EDGE_EPS) return v;
    let out: number;
    if (v <= s0) out = d0 + (v - s0) * live;
    else if (v >= s1) out = d1 + (v - s1) * live;
    else {
      let i = 0;
      while (i < edges.length - 2 && v > (edges[i + 1] as number)) i++;
      const lo = edges[i] as number;
      const hi = edges[i + 1] as number;
      const t = hi > lo ? (v - lo) / (hi - lo) : 0;
      out = (targets[i] as number) + t * ((targets[i + 1] as number) - (targets[i] as number));
    }
    return Math.min(1, Math.max(0, out));
  };
}

/**
 * A layout's items adapted to a book's page and theme, in page fractions.
 *
 * Library layouts are authored on a 4:5 page with an 8% margin (0.064 of the height), a 2.5%
 * gutter and a 5% wide gutter (fractions of the width; on y the same distance in units of the
 * height). Their fractions are used as-is on any page shape: on non-4:5 pages they stretch
 * vertically (x and w keep their share of the width, y and h their share of the height). The live
 * area then honours the theme, per axis (`spacing(margin, gutter, aspect)`, width fractions): the
 * live box maps to the theme's margins, gaps between items that equal the library gutter or wide
 * gutter become `theme.gutter` / `theme.wideGutter` (twice the gutter when absent), and the content
 * between them scales uniformly so the live area is filled exactly (see `axisMap`). Edges that
 * touch the trim (0 or 1, i.e. bleed) stay put, so a full-bleed photo stays full bleed.
 *
 * Custom layouts (`source: 'custom'`) were captured on this book's own pages, so they are returned
 * unchanged.
 */
export function layoutItemsFor(layout: LayoutData, template: Size, theme: Spacing): LayoutItem[] {
  const copy = () => layout.items.map((it) => ({ ...it }));
  if (layout.source !== 'library') return copy();
  const aspect = template.width / template.height;
  const s = spacing(theme.margin, theme.gutter, aspect);
  const wide = theme.wideGutter ?? 2 * theme.gutter;
  const toY = LIBRARY_PAGE.width / LIBRARY_PAGE.height;
  const x: AxisSpec = {
    srcMargin: LIBRARY_MARGIN,
    srcGutter: LIBRARY_GUTTER,
    srcWide: LIBRARY_WIDE_GUTTER,
    dstMargin: s.mx,
    dstGutter: s.gx,
    dstWide: wide,
  };
  const y: AxisSpec = {
    srcMargin: LIBRARY_MARGIN * toY,
    srcGutter: LIBRARY_GUTTER * toY,
    srcWide: LIBRARY_WIDE_GUTTER * toY,
    dstMargin: s.my,
    dstGutter: s.gy,
    dstWide: wide * aspect,
  };
  const same = (a: AxisSpec) =>
    Math.abs(a.srcMargin - a.dstMargin) < 1e-12 &&
    Math.abs(a.srcGutter - a.dstGutter) < 1e-12 &&
    Math.abs(a.srcWide - a.dstWide) < 1e-12;
  if (same(x) && same(y)) return copy();
  const mapX = axisMap(
    layout.items.map((it) => it.x),
    layout.items.map((it) => it.x + it.w),
    x,
  );
  const mapY = axisMap(
    layout.items.map((it) => it.y),
    layout.items.map((it) => it.y + it.h),
    y,
  );
  return layout.items.map((it) => {
    const x0 = mapX(it.x);
    const x1 = mapX(it.x + it.w);
    const y0 = mapY(it.y);
    const y1 = mapY(it.y + it.h);
    return { kind: it.kind, x: x0, y: y0, w: Math.max(MIN_SIZE, x1 - x0), h: Math.max(MIN_SIZE, y1 - y0) };
  });
}

/** Landscape / portrait / any from the photo slots' mean aspect on the 4:5 reference page. */
function variantOf(items: readonly LayoutItem[]): LayoutVariant {
  const photos = items.filter((i) => i.kind === 'photo');
  if (photos.length === 0) return 'any';
  const k = LIBRARY_PAGE.width / LIBRARY_PAGE.height;
  const mean = photos.reduce((sum, p) => sum + Math.log((p.w / p.h) * k), 0) / photos.length;
  if (mean > Math.log(1.15)) return 'landscape';
  if (mean < -Math.log(1.15)) return 'portrait';
  return 'any';
}

const toCount = (n: number): LayoutPhotoCount => Math.min(6, Math.max(1, Math.round(n))) as LayoutPhotoCount;

/** A picker/apply `LayoutDef` backed by layout data (library or custom). */
export function fromLayoutData(data: LayoutData): LayoutDef {
  const items = (margin: number, gutter: number, aspect: number, wideGutter?: number) =>
    layoutItemsFor(
      data,
      { width: aspect, height: 1 },
      wideGutter === undefined ? { margin, gutter } : { margin, gutter, wideGutter },
    );
  const frame = ({ x, y, w, h }: LayoutItem) => ({ x, y, w, h });
  const def: LayoutDef = {
    id: data.id,
    name: data.name,
    photos: toCount(data.photos),
    variant: variantOf(data.items),
    group: data.group,
    data,
    items,
    slots: (m, g, a) =>
      items(m, g, a)
        .filter((i) => i.kind === 'photo')
        .map(frame),
  };
  if (data.best !== undefined) def.best = data.best;
  if (data.bleed) def.bleed = true;
  if (data.items.some((i) => i.kind !== 'photo')) {
    def.caption = (m, g, a) => {
      const first = items(m, g, a).find((i) => i.kind !== 'photo');
      if (!first) throw new Error(`layout ${data.id}: no text item`);
      return frame(first);
    };
  }
  return def;
}

/**
 * Every item of any layout in reading order, adapted to the page. Legacy layouts (no `items`)
 * give their slots, then the caption as a `cap` item.
 */
export function layoutItems(def: LayoutDef, theme: Spacing, template: Size): LayoutItem[] {
  const aspect = template.width / template.height;
  if (def.items) return def.items(theme.margin, theme.gutter, aspect, theme.wideGutter);
  const out: LayoutItem[] = def.slots(theme.margin, theme.gutter, aspect).map((f) => ({ kind: 'photo', ...f }));
  const caption = def.caption?.(theme.margin, theme.gutter, aspect);
  if (caption) out.push({ kind: 'cap', ...caption });
  return out;
}

/**
 * Serializable form of a layout. Library and custom layouts return their data; legacy layouts are
 * sampled on the 4:5 reference page with the library margin and gutter.
 */
export function toLayoutData(def: LayoutDef): LayoutData {
  if (def.data) return structuredClone(def.data);
  const items = layoutItems(
    def,
    { margin: LIBRARY_MARGIN, gutter: LIBRARY_GUTTER },
    { width: LIBRARY_PAGE.width, height: LIBRARY_PAGE.height },
  );
  const data: LayoutData = {
    id: def.id,
    name: def.name,
    photos: def.photos,
    group: items.some((i) => i.kind !== 'photo') ? 'captioned' : 'photos',
    source: 'library',
    items,
  };
  if (def.best !== undefined) data.best = def.best;
  if (def.bleed) data.bleed = true;
  return data;
}
