import {
  type AlignEdge,
  alignFrames,
  type BookTemplate,
  distributeFrames,
  type Frame,
  frameLines,
  gapSpread,
  inchFraction,
  lineGaps,
  lineOverlaps,
  type MatchDimension,
  matchFrames,
  type Page,
  resolveTheme,
  type SnapAxis,
  snapGap,
  type TidyOptions,
  tidyFrames,
  tidyLine,
  tokenOnAxis,
} from '@photobook/shared';
import { create } from 'zustand';
import { clampGroupDelta, clampMovedFrame, type SplitAxis } from '../../lib/frames';
import { createIdleGesture, flushIdleGestures, useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { useUiStore } from '../../store/ui';
import { noticeCustomPage, pageLayout } from './customPageNotice';
import { clearSnapGuides, type SnapGuide, setSnapGuides, snapElementFrame } from './snap';

/**
 * Frame commands on the current page's selection, shared by the keyboard shortcuts, the canvas
 * toolbars and the inspector (no React).
 */

function current() {
  const ui = useUiStore.getState();
  const book = currentDesignBook();
  const page = book?.pages[ui.pageIndex];
  return { ui, book, page };
}

/** Selected photo frames on the current page, in page order. */
export function selectedFrameIds(): string[] {
  const { ui, page } = current();
  if (!page) return [];
  return page.elements.filter((e) => e.type === 'photo' && ui.selectedElementIds.includes(e.id)).map((e) => e.id);
}

/** Merge the selected photo frames (two or more) into one and select it. */
export function mergeSelection(): string | null {
  const { ui, page } = current();
  const ids = selectedFrameIds();
  if (!page || ids.length < 2) return null;
  const id = useBookStore.getState().mergeFrames(page.id, ids);
  if (id) ui.select(id);
  return id;
}

/** Split the selected photo frame (exactly one selected) and keep the original selected. */
export function splitSelection(axis: SplitAxis): [string, string] | null {
  const { ui, page } = current();
  const el = page?.elements.find((e) => e.id === ui.selectedElementId);
  if (!page || el?.type !== 'photo' || ui.selectedElementIds.length > 1) return null;
  return useBookStore.getState().splitFrame(page.id, el.id, axis);
}

/** Delete key: remove text and empty frames, empty filled frames (one undo step). */
export function deleteSelection(): boolean {
  const { ui, page } = current();
  if (!page || ui.selectedElementIds.length === 0) return false;
  useBookStore.getState().deleteElements(page.id, ui.selectedElementIds);
  return true;
}

/** The custom-page notice of a burst of nudges: the page and its layout before the burst's first nudge. */
let nudgeNotice: { pageId: string; layoutBefore: string | undefined } | null = null;

/**
 * Repeated nudges (a held arrow key) within 500 ms are one undo step. When that step is recorded (the pause, or
 * undo or a discrete action flushing it first) the burst's custom-page notice shows, so its Undo is that step.
 */
const NUDGE_IDLE_MS = 500;
const nudgeGesture = createIdleGesture(NUDGE_IDLE_MS, () => {
  const notice = nudgeNotice;
  nudgeNotice = null;
  if (notice) noticeCustomPage(notice.pageId, notice.layoutBefore);
});

/** How long the guides show after a nudge lands on one, ms. */
export const NUDGE_GUIDE_FLASH_MS = 600;

const EPS = 1e-9;

/**
 * Snap a nudged frame along the nudge axis only, and only forward: `raw` is `start` moved by the
 * grid step, `snapped` what the engine made of `raw`. The snapped position is taken when it still
 * moves the frame the way the key points, so a frame sitting on a guide can always step off it
 * (a step shorter than the snap threshold would otherwise snap straight back).
 */
export function snapNudge(
  start: Frame,
  raw: Frame,
  snapped: Frame,
  axis: 'x' | 'y',
): { frame: Frame; snapped: boolean } {
  const delta = raw[axis] - start[axis];
  const travel = snapped[axis] - start[axis];
  if (Math.abs(delta) < EPS || Math.abs(travel) < EPS || Math.sign(travel) !== Math.sign(delta)) {
    return { frame: raw, snapped: Math.abs(snapped[axis] - raw[axis]) < EPS };
  }
  return { frame: { ...raw, [axis]: snapped[axis] }, snapped: true };
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

/** Show `guides` for a moment (a nudge that snapped), or drop a flash still showing. */
function flashGuides(pageId: string, guides: SnapGuide[]): void {
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = null;
  if (guides.length === 0) {
    clearSnapGuides();
    return;
  }
  setSnapGuides(pageId, guides);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    clearSnapGuides();
  }, NUDGE_GUIDE_FLASH_MS);
}

/** Call before the burst's nudge is applied: the first one of the burst reads the page's layout before the edit. */
function rememberNudgeNotice(pageId: string): void {
  if (nudgeNotice?.pageId === pageId) return;
  nudgeNotice = { pageId, layoutBefore: pageLayout(pageId) };
}

/**
 * Move the selected elements by (dx, dy) grid steps (`theme.grid`, the same absolute distance on
 * both axes), kept on the page like a drag (`clampMovedFrame`: photos may run into the bleed).
 * A single selected frame also snaps along the step's axis (`snapNudge`; Cmd-free, the "Snap to
 * guides" pref applies) and the guides it lands on flash. A layout page that becomes custom shows
 * the one-time notice.
 */
export function nudgeSelection(dx: number, dy: number): boolean {
  const { ui, book, page } = current();
  if (!book || !page || ui.selectedElementIds.length === 0) return false;
  const theme = resolveTheme(book.theme);
  const sx = theme.grid * dx;
  const sy = tokenOnAxis(theme.grid, book.template, 'y') * dy;
  const single = ui.selectedElementIds.length === 1;
  const axis = dx !== 0 ? 'x' : 'y';
  const frames: Record<string, Frame> = {};
  let guides: SnapGuide[] = [];
  for (const el of page.elements) {
    if (!ui.selectedElementIds.includes(el.id)) continue;
    let moved: Frame = { ...el.frame, x: el.frame.x + sx, y: el.frame.y + sy };
    if (single && (dx === 0) !== (dy === 0)) {
      const result = snapElementFrame({ pageId: page.id, elementId: el.id, frame: moved, handle: 'move' });
      const nudged = snapNudge(el.frame, moved, result.frame, axis);
      moved = nudged.frame;
      if (nudged.snapped) guides = result.guides.filter((g) => g.axis === axis);
    }
    const kept = clampMovedFrame(moved, el.type, theme.bleed, book.template);
    // Clamping can pull the frame off the line it snapped to.
    if (Math.abs(kept[axis] - moved[axis]) > 1e-5) guides = [];
    frames[el.id] = kept;
  }
  if (Object.keys(frames).length === 0) return false;
  rememberNudgeNotice(page.id);
  nudgeGesture.touch();
  useBookStore.getState().setFrames(page.id, frames);
  flashGuides(page.id, guides);
  return true;
}

// Alignment toolbar and the "Fix spacing" hint (workflow plan 30). Each action is one undo step: one
// `setFrames` after flushing any open idle gesture (a nudge burst), so it never merges into it.

/** The selected elements' frames on the current page, keyed by id (page order). */
function selectionFrames(): { pageId: string; frames: Record<string, Frame> } | null {
  const { ui, page } = current();
  if (!page) return null;
  const frames: Record<string, Frame> = {};
  for (const el of page.elements) if (ui.selectedElementIds.includes(el.id)) frames[el.id] = el.frame;
  return { pageId: page.id, frames };
}

/**
 * Write the frames an action computed as one undo step, kept on the page. Each of `blocks` (rows or
 * columns that Tidy, Distribute or Fix spacing laid out) first shifts as a whole back onto the page
 * (`clampGroupDelta`), so its gaps stay equal; then every frame is kept on the page on its own
 * (`clampMovedFrame`, a no-op for a block that fits). Shows the custom-page notice when a layout
 * page turns custom. Returns whether anything moved.
 */
function applyFrames(
  pageId: string,
  next: Record<string, Frame>,
  blocks: readonly (readonly string[])[] = [],
): boolean {
  const book = currentDesignBook();
  const page = book?.pages.find((p) => p.id === pageId);
  if (!book || !page) return false;
  const bleed = resolveTheme(book.theme).bleed;
  const shifted: Record<string, Frame> = { ...next };
  for (const ids of blocks) {
    const items = page.elements
      .filter((e) => ids.includes(e.id) && shifted[e.id])
      .map((e) => ({ frame: shifted[e.id] as Frame, kind: e.type }));
    const { dx, dy } = clampGroupDelta(items, 0, 0, bleed, book.template);
    if (dx === 0 && dy === 0) continue;
    for (const id of ids) {
      const f = shifted[id];
      if (f) shifted[id] = { ...f, x: f.x + dx, y: f.y + dy };
    }
  }
  const frames: Record<string, Frame> = {};
  for (const el of page.elements) {
    const f = shifted[el.id];
    if (!f) continue;
    const kept = clampMovedFrame(f, el.type, bleed, book.template);
    const same = kept.x === el.frame.x && kept.y === el.frame.y && kept.w === el.frame.w && kept.h === el.frame.h;
    if (!same) frames[el.id] = kept;
  }
  if (Object.keys(frames).length === 0) return false;
  const layoutBefore = pageLayout(pageId);
  flushIdleGestures();
  useBookStore.getState().setFrames(pageId, frames);
  noticeCustomPage(pageId, layoutBefore);
  return true;
}

/** Align the selection (two elements or more) to a side or centre line of its bounding box. */
export function alignSelection(edge: AlignEdge): boolean {
  const sel = selectionFrames();
  if (!sel || Object.keys(sel.frames).length < 2) return false;
  return applyFrames(sel.pageId, alignFrames(sel.frames, edge));
}

/** Distribute the selection (three elements or more) with equal gaps, horizontally (x) or vertically (y). */
export function distributeSelection(axis: SnapAxis): boolean {
  const sel = selectionFrames();
  if (!sel || Object.keys(sel.frames).length < 3) return false;
  // The outer frames stay, so the selection keeps its extent; still clamp it as one block.
  return applyFrames(sel.pageId, distributeFrames(sel.frames, axis), [Object.keys(sel.frames)]);
}

/** Give the selection the width or height of the primary selection (the last one clicked). */
export function matchSelection(dimension: MatchDimension): boolean {
  const sel = selectionFrames();
  if (!sel || Object.keys(sel.frames).length < 2) return false;
  const primary = useUiStore.getState().selectedElementId ?? undefined;
  return applyFrames(sel.pageId, matchFrames(sel.frames, dimension, primary));
}

/**
 * Whether a line of `ids` (sizes summing to `sizes` along `axis`) laid out `gap` apart fits on the
 * page plus the bleed (photos only; a line with text must fit the trim).
 */
function lineFits(page: Page, axis: SnapAxis, line: { ids: readonly string[]; sizes: number }, gap: number): boolean {
  const book = currentDesignBook();
  if (!book) return true;
  const theme = resolveTheme(book.theme);
  const photos = page.elements.filter((e) => line.ids.includes(e.id)).every((e) => e.type === 'photo');
  const bleed = photos ? tokenOnAxis(theme.bleed, book.template, axis) : 0;
  return line.sizes + gap * (line.ids.length - 1) <= 1 + 2 * bleed + 1e-9;
}

/**
 * The page's gutter rhythm for a row's gap: the guide's photo-to-photo rule (join, gutter, wide or
 * as is), or the row's mean gap when the snapped gap would make the row longer than the page plus
 * the bleed (`lineFits`). The mean keeps the row's extent, so it always fits.
 */
function rhythm(page: Page, template: Pick<BookTemplate, 'width' | 'height'>): NonNullable<TidyOptions['gap']> {
  const theme = resolveTheme(currentDesignBook()?.theme ?? {});
  return (mean, axis, line) => {
    const gap = snapGap(mean, theme, template, axis);
    return lineFits(page, axis, line, gap) ? gap : mean;
  };
}

/** The lines Tidy lays out (as `tidyFrames` picks them): rows, or the columns when no row has two frames. */
function tidyBlocks(frames: Record<string, Frame>): string[][] {
  const rows = frameLines(frames, 'x').filter((l) => l.length > 1);
  return rows.length > 0 ? rows : frameLines(frames, 'y').filter((l) => l.length > 1);
}

/** Tidy the selection: equal gaps on its rows (or its column), mapped onto the gutter rhythm (`snapGap`). */
export function tidySelection(): boolean {
  const sel = selectionFrames();
  const book = currentDesignBook();
  const page = book?.pages.find((p) => p.id === sel?.pageId);
  if (!sel || !book || !page || Object.keys(sel.frames).length < 2) return false;
  const next = tidyFrames(sel.frames, { gap: rhythm(page, book.template) });
  return applyFrames(sel.pageId, next, tidyBlocks(sel.frames));
}

/**
 * How uneven a row's gaps may get (their standard deviation, inches on the 8 in reference page)
 * before a drop counts as breaking the gutter rhythm. Snapping keeps gaps exact, so anything above
 * a hair is a hand-placed frame.
 */
export const SPACING_HINT_SPREAD_IN = 0.025;

const photoFrames = (page: Page): Record<string, Frame> => {
  const out: Record<string, Frame> = {};
  for (const el of page.elements) if (el.type === 'photo') out[el.id] = el.frame;
  return out;
};

/**
 * The row of photo frames holding `elementId` (ids left to right) when it has three frames or more
 * and its gaps are uneven (`SPACING_HINT_SPREAD_IN`), else null.
 */
export function unevenRow(page: Page, elementId: string, template: Pick<BookTemplate, 'width' | 'height'>) {
  const frames = photoFrames(page);
  if (!frames[elementId]) return null;
  const row = frameLines(frames, 'x').find((l) => l.includes(elementId));
  if (!row || row.length < 3 || lineOverlaps(frames, row, 'x')) return null;
  const spread = gapSpread(lineGaps(frames, row, 'x'));
  return spread > SPACING_HINT_SPREAD_IN * inchFraction(template, 'x') ? row : null;
}

/**
 * The gap spread (standard deviation, page fraction) of the photo row holding `elementId` on a page
 * of the document on the canvas: 0 for a row under three frames or one whose frames overlap.
 */
export function rowSpread(pageId: string, elementId: string): number {
  const page = currentDesignBook()?.pages.find((p) => p.id === pageId);
  if (!page) return 0;
  const frames = photoFrames(page);
  if (!frames[elementId]) return 0;
  const row = frameLines(frames, 'x').find((l) => l.includes(elementId));
  if (!row || row.length < 3 || lineOverlaps(frames, row, 'x')) return 0;
  return gapSpread(lineGaps(frames, row, 'x'));
}

/** The frame whose drop broke its row's rhythm (shown as "Fix spacing" in its floating toolbar). */
export const useSpacingHint = create<{ pageId: string | null; elementId: string | null }>()(() => ({
  pageId: null,
  elementId: null,
}));

/** Ends the hint's store subscriptions while one is shown. */
let hintCleanup: (() => void) | null = null;

/** Forget the hint (the Fix spacing button goes). */
export function clearSpacingHint(): void {
  hintCleanup?.();
  hintCleanup = null;
  const s = useSpacingHint.getState();
  if (s.pageId !== null || s.elementId !== null) useSpacingHint.setState({ pageId: null, elementId: null });
}

/**
 * Show the hint for a dropped frame until the next undo step (another edit, undo or redo), a
 * selection change or a page change: it belongs to that drop only.
 */
function showSpacingHint(pageId: string, elementId: string): void {
  clearSpacingHint();
  useSpacingHint.setState({ pageId, elementId });
  const history = useBookStore.temporal;
  const start = history.getState();
  const last = start.pastStates.at(-1);
  const future = start.futureStates.length;
  const offHistory = history.subscribe((t) => {
    if (t.pastStates.at(-1) !== last || t.futureStates.length !== future) clearSpacingHint();
  });
  const offUi = useUiStore.subscribe((s, prev) => {
    if (s.selectedElementIds !== prev.selectedElementIds || s.pageIndex !== prev.pageIndex) clearSpacingHint();
  });
  hintCleanup = () => {
    offHistory();
    offUi();
  };
}

/**
 * After a single-frame move ends (its undo step recorded): show Fix spacing when the frame's row now
 * has uneven gaps (`unevenRow`) and the drop made them worse than `spreadBefore` (the spread of the
 * frame's row at the press, `rowSpread`); else forget any hint.
 */
export function noteFrameDrop(pageId: string, elementId: string, spreadBefore = 0): void {
  const book = currentDesignBook();
  const page = book?.pages.find((p) => p.id === pageId);
  const uneven = book && page ? unevenRow(page, elementId, book.template) : null;
  if (uneven && rowSpread(pageId, elementId) > spreadBefore + 1e-9) showSpacingHint(pageId, elementId);
  else clearSpacingHint();
}

/**
 * Fix spacing: Tidy the dropped frame's row back onto the page's rhythm. The gap is the mean of the
 * row's gaps that do not touch the dropped frame (the rhythm it broke), or of all of them when every
 * gap touches it (the middle of three: their sum did not change), through the gutter rule. One undo step.
 */
export function fixSpacing(pageId: string, elementId: string): boolean {
  const book = currentDesignBook();
  const page = book?.pages.find((p) => p.id === pageId);
  const row = book && page ? unevenRow(page, elementId, book.template) : null;
  if (!book || !page || !row) return false;
  const frames = photoFrames(page);
  const gaps = lineGaps(frames, row, 'x');
  const at = row.indexOf(elementId);
  // Gap i lies between row[i] and row[i + 1].
  const untouched = gaps.filter((_, i) => i !== at - 1 && i !== at);
  const pool = untouched.length > 0 ? untouched : gaps;
  const mean = pool.reduce((a, b) => a + b, 0) / pool.length;
  const line = { ids: row, sizes: row.reduce((sum, id) => sum + (frames[id]?.w ?? 0), 0) };
  const snapped = snapGap(mean, resolveTheme(book.theme), book.template, 'x');
  // Too long for the page at that gap: the row's own mean gap keeps its extent.
  const gap = lineFits(page, 'x', line, snapped) ? snapped : gaps.reduce((a, b) => a + b, 0) / gaps.length;
  clearSpacingHint();
  return applyFrames(pageId, tidyLine(frames, row, 'x', { gap: () => gap }), [row]);
}
