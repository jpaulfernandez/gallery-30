import { type Frame, resolveTheme, type SnapHandle } from '@photobook/shared';
import { bleedBounds, fitResized, minFrameSize, resizeFrame } from '../../lib/frames';
import { beginGesture, endGesture, useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { isRatioLocked, useUiStore } from '../../store/ui';
import { noticeCustomPage, pageLayout } from './customPageNotice';
import { MOVE_THRESHOLD } from './frameMove';
import { trackPointerDrag } from './gestures';
import { clearSnapGuides, setSnapGuides, snapElementFrame } from './snap';

/** The eight resize handles, corners first. */
export const RESIZE_HANDLES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const satisfies readonly SnapHandle[];
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

export interface FrameResizeStart {
  pageId: string;
  elementId: string;
  handle: ResizeHandle;
  /** Pointer position at the press, viewport px. */
  clientX: number;
  clientY: number;
  /** The page box on screen (fractions are of its size). */
  pageRect: { width: number; height: number };
}

/**
 * Drag a resize handle of an element's frame. The frame follows the pointer through the shared
 * snap engine (the dragged edges snap to margins, the grid, other frames and gutter gaps; Cmd or
 * the "Snap to guides" pref off skips snapping), keeps its aspect ratio when the element's ratio
 * lock is on (`isRatioLocked`: photos by default; Shift inverts it, so Shift frees a photo frame
 * and keeps a text box's ratio), never gets smaller than the minimum size (1.5 in for photos) and
 * stays inside the page (photos: up to the bleed past the trim, like a move, see `bleedBounds`).
 * Alt resizes from the centre (`resizeFromCentre`). Photo crops are re-clamped on every step
 * (`setFrames`). The whole drag is one undo step.
 */
export function startFrameResize({ pageId, elementId, handle, clientX, clientY, pageRect }: FrameResizeStart): void {
  if (pageRect.width === 0 || pageRect.height === 0) return;
  const book = currentDesignBook();
  const el = book?.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === elementId);
  if (!book || !el) return;
  const start: Frame = { ...el.frame };
  const min = minFrameSize(book.template, el.type);
  // Same bounds as a move: photos may run into the bleed, text stays on the page.
  const bounds = bleedBounds(el.type, resolveTheme(book.theme).bleed, book.template);
  const locked = isRatioLocked(useUiStore.getState(), el);
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
    const lock = e.shiftKey ? !locked : locked;
    const raw = resizeFrame(start, handle, dx / pageRect.width, dy / pageRect.height, lock);
    // From the centre (Alt) the size is twice the dragged edge's travel: no size-match lines then.
    const snapped = snapElementFrame({
      pageId,
      elementId,
      frame: raw,
      handle,
      lockRatio: lock,
      bypass: e.metaKey,
      noSizeMatch: e.altKey,
    });
    const fitted = fitResized(snapped.frame, start, handle, lock, min, bounds);
    const next = e.altKey ? resizeFromCentre(fitted, start, handle, lock, min, bounds) : fitted;
    // Only show guides the fitted frame still sits on.
    // (From the centre the dragged edges stay where `fitted` put them unless the size had to be clamped.)
    const centred = !e.altKey || sameSize(next, mirroredSize(fitted, start, handle));
    const same =
      centred &&
      Math.abs(fitted.x - snapped.frame.x) < 1e-5 &&
      Math.abs(fitted.y - snapped.frame.y) < 1e-5 &&
      Math.abs(fitted.w - snapped.frame.w) < 1e-5 &&
      Math.abs(fitted.h - snapped.frame.h) < 1e-5;
    setSnapGuides(pageId, same ? snapped.guides : [], same ? snapped.badges : []);
    useBookStore.getState().setFrames(pageId, { [elementId]: next });
  };
  const up = () => {
    clearSnapGuides();
    if (!began) return;
    endGesture();
    noticeCustomPage(pageId, layoutBefore);
  };
  trackPointerDrag(move, up);
}

const sameSize = (a: { w: number; h: number }, b: { w: number; h: number }): boolean =>
  Math.abs(a.w - b.w) < 1e-5 && Math.abs(a.h - b.h) < 1e-5;

/** The size a from-centre resize gets: twice the change `fitted` made along each dragged axis. */
function mirroredSize(fitted: Frame, start: Frame, handle: ResizeHandle): { w: number; h: number } {
  const horizontal = handle.includes('e') || handle.includes('w');
  const vertical = handle.includes('n') || handle.includes('s');
  return {
    w: horizontal ? start.w + 2 * (fitted.w - start.w) : fitted.w,
    h: vertical ? start.h + 2 * (fitted.h - start.h) : fitted.h,
  };
}

const clampTo = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), Math.max(lo, hi));
const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Alt + drag on a handle: resize around the frame's centre. `fitted` is the anchored resize (opposite edge fixed,
 * snapped, at least `min`); the opposite edge mirrors the dragged one, so the dragged edge stays where `fitted` put it
 * (on its snap line). The size is then kept at least `min`, inside the page plus `bounds`, and at the start ratio when
 * `lock`.
 */
export function resizeFromCentre(
  fitted: Frame,
  start: Frame,
  handle: ResizeHandle,
  lock: boolean,
  min: { w: number; h: number },
  bounds: { x: number; y: number } = { x: 0, y: 0 },
): Frame {
  const cx = start.x + start.w / 2;
  const cy = start.y + start.h / 2;
  const maxW = 2 * Math.min(cx + bounds.x, 1 + bounds.x - cx);
  const maxH = 2 * Math.min(cy + bounds.y, 1 + bounds.y - cy);
  let { w, h } = mirroredSize(fitted, start, handle);
  if (lock && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    const horizontal = handle.includes('e') || handle.includes('w');
    w = clampTo(horizontal ? w : h * ratio, Math.max(min.w, min.h * ratio), Math.min(maxW, maxH * ratio));
    h = w / ratio;
  } else {
    w = clampTo(w, min.w, maxW);
    h = clampTo(h, min.h, maxH);
  }
  return { x: clean(cx - w / 2), y: clean(cy - h / 2), w: clean(w), h: clean(h) };
}

/** CSS cursor per handle. */
export const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};
