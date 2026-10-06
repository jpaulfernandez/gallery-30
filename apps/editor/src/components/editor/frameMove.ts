import { type Frame, resolveTheme } from '@photobook/shared';
import { bleedBounds } from '../../lib/frames';
import { beginGesture, endGesture, useBookStore } from '../../store/book';
import { clearSnapGuides, setSnapGuides, snapElementFrame } from './snap';

/** Pointer travel before a press becomes a move, px. */
export const MOVE_THRESHOLD = 3;

const clean = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), Math.max(min, max));

/**
 * Keep a moved frame on the page. Photos may run into the bleed (`theme.bleed` past the trim, a
 * fraction of the width; the same distance on the y axis), text stays inside the trim.
 */
export function clampMovedFrame(
  frame: Frame,
  kind: 'photo' | 'text',
  bleed: number,
  template: { width: number; height: number },
): Frame {
  const { x: bx, y: by } = bleedBounds(kind, bleed, template);
  return {
    ...frame,
    x: clean(clamp(frame.x, -bx, 1 + bx - frame.w)),
    y: clean(clamp(frame.y, -by, 1 + by - frame.h)),
  };
}

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
 * Drag an element's frame (a text box, or a photo slot by its selection band). The frame snaps to
 * guides through the shared engine (see snap.ts) unless snapping is off or Cmd is held, and stays
 * on the page. Guides show while dragging. The whole drag is one undo step, and the page becomes
 * custom (`setFrames`).
 */
export function startFrameMove({ pageId, elementId, clientX, clientY, pageRect }: FrameMoveStart): void {
  if (pageRect.width === 0 || pageRect.height === 0) return;
  const el = useBookStore
    .getState()
    .book?.pages.find((p) => p.id === pageId)
    ?.elements.find((e) => e.id === elementId);
  if (!el) return;
  const start = el.frame;
  const kind = el.type;
  let began = false;
  const move = (e: PointerEvent) => {
    const dx = e.clientX - clientX;
    const dy = e.clientY - clientY;
    if (!began) {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      began = true;
      beginGesture();
    }
    const book = useBookStore.getState().book;
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
