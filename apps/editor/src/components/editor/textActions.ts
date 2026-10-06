import type { ElementPointerEvent, TextElement } from '@photobook/shared';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { startFrameMove } from './frameMove';

/**
 * Drag a text box by its frame: it snaps to guides (shared engine; Cmd bypasses) and stays inside
 * the page. The whole drag is one undo step. See `startFrameMove`.
 */
export function startTextMove(pageId: string, el: TextElement, event: ElementPointerEvent): void {
  const pageNode = event.currentTarget.closest('.pb-page');
  if (!pageNode) return;
  const rect = pageNode.getBoundingClientRect();
  startFrameMove({ pageId, elementId: el.id, clientX: event.clientX, clientY: event.clientY, pageRect: rect });
}

/** Add an empty caption at the bottom margin of the current page, select it and start editing. */
export function addTextToCurrentPage(): string | null {
  const ui = useUiStore.getState();
  const page = useBookStore.getState().book?.pages[ui.pageIndex];
  if (!page) return null;
  const id = useBookStore.getState().addText(page.id);
  if (id) ui.editText(id);
  return id;
}

/** Give keyboard focus back to the canvas (arrow keys, T, Enter) after editing ends. */
export function focusCanvas(): void {
  document.querySelector<HTMLElement>('.editor-canvas')?.focus({ preventScroll: true });
}
