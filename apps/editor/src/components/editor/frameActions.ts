import { type Frame, resolveTheme, tokenOnAxis } from '@photobook/shared';
import type { SplitAxis } from '../../lib/frames';
import { createIdleGesture, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { clampMovedFrame } from './frameMove';

/**
 * Frame commands on the current page's selection, shared by the keyboard shortcuts, the canvas
 * toolbars and the inspector (no React).
 */

function current() {
  const ui = useUiStore.getState();
  const book = useBookStore.getState().book;
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

/** Repeated nudges (a held arrow key) within 500 ms are one undo step. */
const nudgeGesture = createIdleGesture(500);

/**
 * Move the selected elements by (dx, dy) grid steps (`theme.grid`, the same absolute distance on
 * both axes), kept on the page like a drag (`clampMovedFrame`: photos may run into the bleed).
 */
export function nudgeSelection(dx: number, dy: number): boolean {
  const { ui, book, page } = current();
  if (!book || !page || ui.selectedElementIds.length === 0) return false;
  const theme = resolveTheme(book.theme);
  const sx = theme.grid * dx;
  const sy = tokenOnAxis(theme.grid, book.template, 'y') * dy;
  const frames: Record<string, Frame> = {};
  for (const el of page.elements) {
    if (!ui.selectedElementIds.includes(el.id)) continue;
    const moved = { ...el.frame, x: el.frame.x + sx, y: el.frame.y + sy };
    frames[el.id] = clampMovedFrame(moved, el.type, theme.bleed, book.template);
  }
  if (Object.keys(frames).length === 0) return false;
  nudgeGesture.touch();
  useBookStore.getState().setFrames(page.id, frames);
  return true;
}
