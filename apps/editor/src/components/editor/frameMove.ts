import { type Frame, resolveTheme } from '@photobook/shared';
import { boundingBox, clampGroupDelta, clampMovedFrame, clean } from '../../lib/frames';
import { beginGesture, endGesture, useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { noticeCustomPage, pageLayout } from './customPageNotice';
import { noteFrameDrop, rowSpread } from './frameActions';
import { type DragEndReason, trackPointerDrag } from './gestures';
import { clearSnapGuides, setSnapGuides, snapElementFrame } from './snap';

/** Pointer travel before a press becomes a move, px. */
export const MOVE_THRESHOLD = 3;

/** Keep a moved frame (or a group, as a block) on the page; in lib/frames.ts so frameActions.ts can share them. */
export { clampGroupDelta, clampMovedFrame };

export interface FrameMoveStart {
  pageId: string;
  elementId: string;
  /** Pointer position at the press, viewport px. */
  clientX: number;
  clientY: number;
  /** The page box on screen (fractions are of its size). */
  pageRect: { width: number; height: number };
}

/**
 * Drag an element's frame (a plain drag on any frame, or a selected photo frame's outline band;
 * workflow plan 29). The frame snaps to guides through the shared engine (see snap.ts) unless
 * snapping is off or Cmd is held, and stays on the page. Guides show while dragging. The whole drag
 * is one undo step and never touches the photo's crop (no pan); the page becomes custom
 * (`setFrames`), and the first time a layout page does, a toast says so (`noticeCustomPage`).
 */
export function startFrameMove({ pageId, elementId, clientX, clientY, pageRect }: FrameMoveStart): void {
  if (pageRect.width === 0 || pageRect.height === 0) return;
  const el = currentDesignBook()
    ?.pages.find((p) => p.id === pageId)
    ?.elements.find((e) => e.id === elementId);
  if (!el) return;
  const start = el.frame;
  const kind = el.type;
  const layoutBefore = pageLayout(pageId);
  const spreadBefore = rowSpread(pageId, elementId);
  let began = false;
  const move = (e: PointerEvent) => {
    const dx = e.clientX - clientX;
    const dy = e.clientY - clientY;
    if (!began) {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      began = true;
      beginGesture();
    }
    const book = currentDesignBook();
    if (!book) return;
    const raw: Frame = { ...start, x: start.x + dx / pageRect.width, y: start.y + dy / pageRect.height };
    const snapped = snapElementFrame({ pageId, elementId, frame: raw, handle: 'move', bypass: e.metaKey });
    // A move never resizes: keep the size even if the engine adjusted it.
    const next = clampMovedFrame(
      { ...snapped.frame, w: start.w, h: start.h },
      kind,
      resolveTheme(book.theme).bleed,
      book.template,
    );
    // Clamping can pull the frame off a line; only show guides it still sits on.
    const onPage = Math.abs(next.x - snapped.frame.x) < 1e-5 && Math.abs(next.y - snapped.frame.y) < 1e-5;
    setSnapGuides(pageId, onPage ? snapped.guides : [], onPage ? snapped.badges : []);
    // `setFrames` skips unchanged frames and marks the page custom (a hand edit).
    useBookStore.getState().setFrames(pageId, { [elementId]: next });
  };
  const up = () => {
    clearSnapGuides();
    if (!began) return;
    endGesture();
    noticeCustomPage(pageId, layoutBefore);
    // A drop that makes the row's gutter rhythm worse offers "Fix spacing" in the floating toolbar.
    noteFrameDrop(pageId, elementId, spreadBefore);
  };
  trackPointerDrag(move, up);
}

export interface SelectionMoveStart {
  pageId: string;
  /** The elements that move together (the multi-selection). */
  elementIds: readonly string[];
  clientX: number;
  clientY: number;
  pageRect: { width: number; height: number };
  /** Called when the press ends without a move (a click on a member: select it alone). */
  onClick?: () => void;
}

/**
 * Drag a multi-selection as one block (workflow plan 30): the selection's bounding box snaps like a
 * single frame (to margins, the grid, the other frames, gutter gaps and equal spacing; Cmd skips
 * snapping), every member moves by the same delta, and the block stays on the page (each member by
 * its own bounds, `clampGroupDelta`). One undo step; the custom-page notice as for one frame.
 */
export function startSelectionMove({
  pageId,
  elementIds,
  clientX,
  clientY,
  pageRect,
  onClick,
}: SelectionMoveStart): void {
  if (pageRect.width === 0 || pageRect.height === 0) return;
  const page = currentDesignBook()?.pages.find((p) => p.id === pageId);
  const members = page?.elements.filter((e) => elementIds.includes(e.id)) ?? [];
  const box = boundingBox(members.map((e) => e.frame));
  if (!page || !box || members.length === 0) return;
  const items = members.map((e) => ({ id: e.id, frame: { ...e.frame }, kind: e.type }));
  const ids = items.map((i) => i.id);
  const layoutBefore = pageLayout(pageId);
  let began = false;
  const move = (e: PointerEvent) => {
    const dx = e.clientX - clientX;
    const dy = e.clientY - clientY;
    if (!began) {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      began = true;
      beginGesture();
    }
    const book = currentDesignBook();
    if (!book) return;
    const raw: Frame = { ...box, x: box.x + dx / pageRect.width, y: box.y + dy / pageRect.height };
    const snapped = snapElementFrame({
      pageId,
      elementId: ids[0] as string,
      excludeIds: ids,
      frame: raw,
      handle: 'move',
      bypass: e.metaKey,
    });
    const want = { dx: snapped.frame.x - box.x, dy: snapped.frame.y - box.y };
    const got = clampGroupDelta(items, want.dx, want.dy, resolveTheme(book.theme).bleed, book.template);
    const onPage = Math.abs(got.dx - want.dx) < 1e-5 && Math.abs(got.dy - want.dy) < 1e-5;
    setSnapGuides(pageId, onPage ? snapped.guides : [], onPage ? snapped.badges : []);
    const frames: Record<string, Frame> = {};
    for (const i of items) {
      frames[i.id] = { ...i.frame, x: clean(i.frame.x + got.dx), y: clean(i.frame.y + got.dy) };
    }
    useBookStore.getState().setFrames(pageId, frames);
  };
  const up = (reason: DragEndReason) => {
    clearSnapGuides();
    if (!began) {
      // Only a real release is a click (not a blur or a release lost outside the window).
      if (reason === 'up') onClick?.();
      return;
    }
    endGesture();
    noticeCustomPage(pageId, layoutBefore);
  };
  trackPointerDrag(move, up);
}

/**
 * Start a frame move from a press on a page element (the renderer's `onElementPointerDown`): the
 * page box is the element's `.pb-page`.
 */
export function startElementMove(
  pageId: string,
  elementId: string,
  event: { currentTarget: Element; clientX: number; clientY: number },
): void {
  const pageNode = event.currentTarget.closest('.pb-page');
  if (!pageNode) return;
  const pageRect = pageNode.getBoundingClientRect();
  startFrameMove({ pageId, elementId, clientX: event.clientX, clientY: event.clientY, pageRect });
}

/** Start moving a multi-selection from a press on one of its members (see `startSelectionMove`). */
export function startElementSelectionMove(
  pageId: string,
  elementIds: readonly string[],
  event: { currentTarget: Element; clientX: number; clientY: number },
  onClick?: () => void,
): void {
  const pageNode = event.currentTarget.closest('.pb-page');
  if (!pageNode) return;
  const pageRect = pageNode.getBoundingClientRect();
  startSelectionMove({ pageId, elementIds, clientX: event.clientX, clientY: event.clientY, pageRect, onClick });
}
