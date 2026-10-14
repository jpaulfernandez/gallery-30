import { useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { useUiStore } from '../../store/ui';

/** Add an empty caption at the bottom margin of the current page, select it and start editing. */
export function addTextToCurrentPage(): string | null {
  const ui = useUiStore.getState();
  const page = currentDesignBook()?.pages[ui.pageIndex];
  if (!page) return null;
  const id = useBookStore.getState().addText(page.id);
  if (id) ui.editText(id);
  return id;
}

/** Give keyboard focus back to the canvas (arrow keys, T, Enter) after editing ends. */
export function focusCanvas(): void {
  document.querySelector<HTMLElement>('.editor-canvas')?.focus({ preventScroll: true });
}
