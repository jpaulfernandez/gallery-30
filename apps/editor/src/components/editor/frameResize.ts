import { type Frame, resolveTheme, type SnapHandle } from '@photobook/shared';
import { bleedBounds, fitResized, minFrameSize, resizeFrame } from '../../lib/frames';
import { beginGesture, endGesture, useBookStore } from '../../store/book';
import { isRatioLocked, useUiStore } from '../../store/ui';
import { MOVE_THRESHOLD } from './frameMove';
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
 * lock is on (`isRatioLocked`: photos by default) unless Shift is held, never gets smaller than
 * the minimum size (1.5 in for photos) and stays inside the page (photos: up to the bleed past the
 * trim, like a move, see `bleedBounds`). Photo crops are re-clamped on
 * every step (`setFrames`). The whole drag is one undo step.
 */
export function startFrameResize({ pageId, elementId, handle, clientX, clientY, pageRect }: FrameResizeStart): void {
  if (pageRect.width === 0 || pageRect.height === 0) return;
  const book = useBookStore.getState().book;
  const el = book?.pages.find((p) => p.id === pageId)?.elements.find((e) => e.id === elementId);
  if (!book || !el) return;
  const start: Frame = { ...el.frame };
  const min = minFrameSize(book.template, el.type);
  // Same bounds as a move: photos may run into the bleed, text stays on the page.
  const bounds = bleedBounds(el.type, resolveTheme(book.theme).bleed, book.template);
  const locked = isRatioLocked(useUiStore.getState(), el);
  let began = false;

  const move = (e: PointerEvent) => {
    const dx = e.clientX - clientX;
    const dy = e.clientY - clientY;
    if (!began) {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      began = true;
      beginGesture();
    }
    const lock = locked && !e.shiftKey;
    const raw = resizeFrame(start, handle, dx / pageRect.width, dy / pageRect.height, lock);
    const snapped = snapElementFrame({ pageId, elementId, frame: raw, handle, lockRatio: lock, bypass: e.metaKey });
    const next = fitResized(snapped.frame, start, handle, lock, min, bounds);
    // Only show guides the fitted frame still sits on.
    const same =
      Math.abs(next.x - snapped.frame.x) < 1e-5 &&
      Math.abs(next.y - snapped.frame.y) < 1e-5 &&
      Math.abs(next.w - snapped.frame.w) < 1e-5 &&
      Math.abs(next.h - snapped.frame.h) < 1e-5;
    setSnapGuides(pageId, same ? snapped.guides : [], same ? snapped.badges : []);
    useBookStore.getState().setFrames(pageId, { [elementId]: next });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    clearSnapGuides();
    if (began) endGesture();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
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
