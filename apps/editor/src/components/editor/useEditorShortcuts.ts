import { useEffect } from 'react';
import { redo, undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { deleteSelection, mergeSelection, splitSelection } from './frameActions';
import { isEditableTarget } from './gestures';

/**
 * Shell-level keys (window): Cmd+Z / Shift+Cmd+Z undo and redo, Cmd+0 / Cmd+= / Cmd+- zoom,
 * Escape closes a modal or clears the selection, Delete / Backspace empties the selected photo
 * slot or removes the selected text box, Cmd+N adds a blank page after the current one and shows
 * it, Cmd+D duplicates the current page and Cmd+Backspace deletes it. Text fields (and inline text editing) keep their own keys. Arrow keys, T (add text)
 * and Enter (edit text) live on the canvas (they need its focus).
 *
 * Frame tools: V / F pick the Select / Frame tool (Escape in Frame mode goes back to Select),
 * Cmd+Shift+M merges the selected photo frames, Cmd+Shift+H splits the selected frame top / bottom and
 * Cmd+Shift+V left / right. Delete on an empty frame removes it (a filled one is emptied first).
 */
export function useEditorShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const inField = isEditableTarget(e.target);
      const key = e.key.toLowerCase();

      if (mod && key === 'z' && !e.altKey) {
        if (inField) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !e.altKey && (key === '0' || key === '=' || key === '+' || key === '-')) {
        e.preventDefault();
        if (key === '0') ui.setZoom('fit');
        else ui.stepZoom(key === '-' ? -1 : 1);
        return;
      }
      if (e.key === 'Escape') {
        if (ui.originalModal) ui.closeOriginal();
        else if (ui.layoutPicker) ui.closeLayoutPicker();
        else if (inField && e.target instanceof HTMLElement) e.target.blur();
        else if (ui.tool !== 'select') ui.setTool('select');
        else ui.select(null);
        return;
      }
      const blocked = inField || ui.originalModal || ui.layoutPicker || ui.editingTextId;
      if (!mod && !e.altKey && !e.shiftKey && (key === 'v' || key === 'f')) {
        if (blocked) return;
        e.preventDefault();
        ui.setTool(key === 'f' ? 'frame' : 'select');
        return;
      }
      if (mod && !e.altKey && e.shiftKey && key === 'm') {
        if (blocked) return;
        // Cmd+M is macOS Minimize in Tauri's default menu, which fires before the webview sees it.
        e.preventDefault();
        mergeSelection();
        return;
      }
      if (mod && !e.altKey && e.shiftKey && (key === 'h' || key === 'v')) {
        if (blocked) return;
        e.preventDefault();
        splitSelection(key === 'h' ? 'horizontal' : 'vertical');
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key === 'n') {
        if (inField || ui.originalModal || ui.layoutPicker) return;
        e.preventDefault();
        addBlankPageAfterCurrent();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (key === 'd' || e.key === 'Backspace' || e.key === 'Delete')) {
        if (inField || ui.originalModal || ui.layoutPicker) return;
        const store = useBookStore.getState();
        const page = store.book?.pages[ui.pageIndex];
        e.preventDefault();
        if (!page) return;
        if (key === 'd') {
          if (store.duplicatePage(page.id)) ui.setPageIndex(ui.pageIndex + 1);
        } else {
          store.deletePage(page.id);
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !inField) {
        if (ui.originalModal || ui.layoutPicker || ui.selectedElementIds.length === 0) return;
        e.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Insert a blank page right after the current one (at the end of an empty book) and show it. */
export function addBlankPageAfterCurrent(): string | null {
  const ui = useUiStore.getState();
  const store = useBookStore.getState();
  const count = store.book?.pages.length ?? 0;
  const at = count === 0 ? 0 : Math.min(ui.pageIndex + 1, count);
  const id = store.addPage(at);
  if (id) useUiStore.getState().setPageIndex(at);
  return id;
}
