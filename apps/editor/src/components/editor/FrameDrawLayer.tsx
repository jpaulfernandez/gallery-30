import type { BookTemplate, Frame } from '@photobook/shared';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { fitResized, inchesPerUnit, minFrameSize, pointToPage, rectFromDrag } from '../../lib/frames';
import { useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { useUiStore } from '../../store/ui';
import { MOVE_THRESHOLD } from './frameMove';
import { clearSnapGuides, setSnapGuides, snapElementFrame } from './snap';
import { focusCanvas } from './textActions';

const pct = (n: number) => `${n * 100}%`;

/** Snap a single point (the press point of a draw) to the guides, as a zero-size moved frame. */
function snapPoint(pageId: string, p: { x: number; y: number }, bypass: boolean): { x: number; y: number } {
  const { frame } = snapElementFrame({
    pageId,
    elementId: '',
    frame: { x: p.x, y: p.y, w: 1e-9, h: 1e-9 },
    handle: 'move',
    bypass,
  });
  return { x: frame.x, y: frame.y };
}

export interface FrameDrawStart {
  pageId: string;
  clientX: number;
  clientY: number;
  /** The page box on screen. */
  pageRect: { left: number; top: number; width: number; height: number };
  bypassSnap: boolean;
  /** The rectangle to preview while drawing (null: none). */
  onPreview: (frame: Frame | null) => void;
}

/**
 * Draw a new empty photo frame by dragging. The press point and the dragged corner both snap to
 * the guides (Cmd skips snapping), the frame grows to the minimum photo size (1.5 in) away from the
 * press point and stays on the page. On release the frame is added (`addFrame`, one undo step, the
 * page becomes custom) and selected, and the tool returns to Select unless Shift is held. Escape
 * cancels. A press without a drag adds nothing. Returns a cancel function.
 */
export function startFrameDraw({
  pageId,
  clientX,
  clientY,
  pageRect,
  bypassSnap,
  onPreview,
}: FrameDrawStart): () => void {
  const book = currentDesignBook();
  if (!book || pageRect.width === 0 || pageRect.height === 0) return () => {};
  const min = minFrameSize(book.template, 'photo');
  const anchor = snapPoint(pageId, pointToPage(clientX, clientY, pageRect), bypassSnap);
  let began = false;
  let last: Frame | null = null;

  const move = (e: PointerEvent) => {
    if (!began) {
      if (Math.hypot(e.clientX - clientX, e.clientY - clientY) < MOVE_THRESHOLD) return;
      began = true;
    }
    const { frame, handle } = rectFromDrag(anchor, pointToPage(e.clientX, e.clientY, pageRect));
    const snapped = snapElementFrame({ pageId, elementId: '', frame, handle, bypass: e.metaKey });
    last = fitResized(snapped.frame, frame, handle, false, min);
    setSnapGuides(pageId, snapped.guides, snapped.badges);
    onPreview(last);
  };
  const cleanup = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey, true);
    clearSnapGuides();
    onPreview(null);
  };
  const up = (e: PointerEvent) => {
    cleanup();
    if (!began || !last) return;
    const id = useBookStore.getState().addFrame(pageId, last);
    const ui = useUiStore.getState();
    if (id) ui.select(id);
    if (!e.shiftKey) ui.setTool('select');
    focusCanvas();
  };
  const cancel = () => cleanup();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cleanup();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', onKey, true);
  return cleanup;
}

/**
 * Covers the page while the Frame tool is on (or the page is empty, so a blank page can be drawn
 * on with the Select tool): drag to draw a frame (see `startFrameDraw`), with a live outline and
 * its size in inches.
 */
export function FrameDrawLayer({
  pageId,
  template,
}: {
  pageId: string;
  template: Pick<BookTemplate, 'width' | 'height'>;
}) {
  const [preview, setPreview] = useState<Frame | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const box = e.currentTarget.closest('[data-page-box]');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    cancelRef.current?.();
    cancelRef.current = startFrameDraw({
      pageId,
      clientX: e.clientX,
      clientY: e.clientY,
      pageRect: box.getBoundingClientRect(),
      bypassSnap: e.metaKey,
      onPreview: setPreview,
    });
  };

  const per = inchesPerUnit(template);
  return (
    <div data-canvas-ui data-frame-draw className="absolute inset-0 z-[5] cursor-draw" onPointerDown={onPointerDown}>
      {preview && (
        <div
          className="pointer-events-none absolute bg-accent/10 outline-2 outline-accent outline-dashed"
          style={{ left: pct(preview.x), top: pct(preview.y), width: pct(preview.w), height: pct(preview.h) }}
        >
          <span className="absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-accent px-1 py-px font-medium text-[10px] text-accent-ink tabular-nums leading-tight">
            {(preview.w * per.x).toFixed(2)} × {(preview.h * per.y).toFixed(2)} in
          </span>
        </div>
      )}
    </div>
  );
}
