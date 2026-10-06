import {
  type BookTemplate,
  type Frame,
  inchFraction,
  resolveTheme,
  type SnapFrameOptions,
  type SnapGuide,
  type SnapHandle,
  type SnapTheme,
  snapFrame,
  spacing,
} from '@photobook/shared';
import { useCallback } from 'react';
import { create } from 'zustand';
import { useBookStore } from '../../store/book';
import { effectiveZoom, PAGE_PX_PER_UNIT, useUiStore } from '../../store/ui';

/**
 * Snapping for frames dragged on the canvas: a thin layer over the shared engine (`snapFrame`)
 * that fills in what the editor knows (the page's other frames, the resolved theme, the template,
 * a threshold of SNAP_THRESHOLD_PX screen px at the current zoom) and publishes the guides the
 * last snap produced, so the canvas overlay can draw them while the drag lasts.
 */

/** How close (CSS px on screen) an edge must come to a guide to snap. */
export const SNAP_THRESHOLD_PX = 6;

export type { SnapGuide, SnapHandle };

export interface SnapRequest {
  pageId: string;
  /** The element being dragged (left out of the frames it snaps to). */
  elementId: string;
  /** Where the pointer would put the frame, unsnapped. */
  frame: Frame;
  /** What is being dragged: the whole frame (a move) or one edge or corner (a resize). */
  handle: SnapHandle;
  /** Resizes keep the frame's aspect ratio. */
  lockRatio?: boolean;
  /** Skip snapping for this event (Cmd held). */
  bypass?: boolean;
}

/** A distance label at a gap snap, centred in the gap (page fractions). */
export interface GapBadge {
  x: number;
  y: number;
  /** "gutter · 0.20 in", "wide · 0.40 in". */
  label: string;
}

export interface SnapResult {
  frame: Frame;
  guides: SnapGuide[];
  /** One per gap guide whose neighbour was found. */
  badges: GapBadge[];
}

interface GuideState {
  /** Page the guides belong to. */
  pageId: string | null;
  guides: SnapGuide[];
  badges: GapBadge[];
}

/** Guides of the drag in progress (empty when nothing is being dragged). */
export const useSnapGuides = create<GuideState>()(() => ({ pageId: null, guides: [], badges: [] }));

export const NO_GUIDES: SnapGuide[] = [];
export const NO_BADGES: GapBadge[] = [];

export function setSnapGuides(pageId: string | null, guides: SnapGuide[], badges: GapBadge[] = NO_BADGES): void {
  const prev = useSnapGuides.getState();
  if (prev.guides.length === 0 && guides.length === 0) return;
  useSnapGuides.setState({
    pageId,
    guides: guides.length > 0 ? guides : NO_GUIDES,
    badges: badges.length > 0 ? badges : NO_BADGES,
  });
}

export const clearSnapGuides = (): void => setSnapGuides(null, NO_GUIDES);

const EPS = 1e-6;

/**
 * Badges for the gap guides of a snapped frame: the neighbour sharing its row (x) or column (y)
 * whose facing edge is a gutter or wide gutter away, labelled with that distance in inches on the
 * 8 in reference page.
 */
export function gapBadges(
  frame: Frame,
  guides: readonly SnapGuide[],
  others: readonly Frame[],
  theme: SnapTheme,
  template: Pick<BookTemplate, 'width' | 'height'>,
): GapBadge[] {
  const out: GapBadge[] = [];
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);
  for (const g of guides) {
    if (g.kind !== 'gap') continue;
    const ax = g.axis === 'x';
    const gutter = ax ? s.gx : s.gy;
    const wide = ax ? theme.wideGutter : (theme.wideGutter * template.width) / template.height;
    const [f0, f1] = ax ? [frame.x, frame.x + frame.w] : [frame.y, frame.y + frame.h];
    const [p0, p1] = ax ? [frame.y, frame.y + frame.h] : [frame.x, frame.x + frame.w];
    for (const o of others) {
      const [o0, o1] = ax ? [o.x, o.x + o.w] : [o.y, o.y + o.h];
      const [q0, q1] = ax ? [o.y, o.y + o.h] : [o.x, o.x + o.w];
      if (!(p0 < q1 && q0 < p1)) continue;
      // The neighbour before the frame (its far edge, then the gap, then the frame) or after it.
      const spans: Array<[number, number]> = [];
      if (Math.abs(f0 - g.value) < EPS) spans.push([o1, f0]);
      if (Math.abs(f1 - g.value) < EPS) spans.push([f1, o0]);
      const hit = spans.find(([a, b]) => Math.abs(b - a - gutter) < EPS || Math.abs(b - a - wide) < EPS);
      if (!hit) continue;
      const [a, b] = hit;
      const inches = (b - a) / inchFraction(template, g.axis);
      const name = Math.abs(b - a - gutter) < EPS ? 'gutter' : 'wide';
      const mid = (Math.max(p0, q0) + Math.min(p1, q1)) / 2;
      const along = (a + b) / 2;
      out.push({ x: ax ? along : mid, y: ax ? mid : along, label: `${name} · ${inches.toFixed(2)} in` });
      break;
    }
  }
  return out;
}

/** Snap threshold as a fraction of the page width, at the current zoom. */
export function snapThreshold(): number {
  const book = useBookStore.getState().book;
  const pageWidthPx = effectiveZoom(useUiStore.getState()) * (book?.template.width ?? 1080) * PAGE_PX_PER_UNIT;
  return pageWidthPx > 0 ? SNAP_THRESHOLD_PX / pageWidthPx : 0;
}

/**
 * Snap a frame against the current book and page (reads the stores; no React). Returns the frame
 * unchanged with no guides when snapping is off (the "Snap to guides" pref), bypassed, or the page
 * is gone.
 */
export function snapElementFrame(req: SnapRequest): SnapResult {
  const book = useBookStore.getState().book;
  const page = book?.pages.find((p) => p.id === req.pageId);
  if (!book || !page || req.bypass || !useUiStore.getState().snapEnabled) {
    return { frame: req.frame, guides: NO_GUIDES, badges: NO_BADGES };
  }
  const others = page.elements.filter((e) => e.id !== req.elementId).map((e) => e.frame);
  const theme = resolveTheme(book.theme);
  const options: SnapFrameOptions = { threshold: snapThreshold(), handle: req.handle };
  if (req.lockRatio) options.lockRatio = true;
  const { frame, guides } = snapFrame(req.frame, others, theme, book.template, options);
  return { frame, guides, badges: gapBadges(frame, guides, others, theme, book.template) };
}

export interface UseSnap {
  /** Snap a frame and publish the guides for the overlay. */
  snap: (req: SnapRequest) => SnapResult;
  /** Drop the guides (drag ended). */
  clear: () => void;
  /** Guides of the last snap on any page. */
  guides: SnapGuide[];
  /** Gap distance badges of the last snap. */
  badges: GapBadge[];
}

/** Snapping for a drag on the canvas; see `snapElementFrame`. `snap` and `clear` are stable. */
export function useSnap(): UseSnap {
  const guides = useSnapGuides((s) => s.guides);
  const badges = useSnapGuides((s) => s.badges);
  const snap = useCallback((req: SnapRequest) => {
    const result = snapElementFrame(req);
    setSnapGuides(req.pageId, result.guides, result.badges);
    return result;
  }, []);
  return { snap, clear: clearSnapGuides, guides, badges };
}
