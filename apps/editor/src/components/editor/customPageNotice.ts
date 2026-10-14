import { LAYOUT_BLANK, LAYOUT_CUSTOM } from '@photobook/shared';
import { undo, useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { dismissToast, showToast } from './Toast';

/**
 * The one-time notice after a hand edit on the canvas (a frame move, resize or nudge) turns a layout page into a
 * custom page (workflow plan 29): a toast "This page is now custom" with Undo, once per page per session. Undo
 * reverts the edit that made it custom; the toast closes as soon as the history changes (another edit, Cmd+Z), so
 * its Undo never reverts something else.
 */

export const CUSTOM_PAGE_MESSAGE = 'This page is now custom';

/** Pages that showed the notice this session. */
const noticed = new Set<string>();

/** The page's layout id in the document on the canvas (undefined: no such page). */
export function pageLayout(pageId: string): string | undefined {
  return currentDesignBook()?.pages.find((p) => p.id === pageId)?.layout;
}

/**
 * Call after a hand edit's undo step is recorded, with the page's layout from before the edit. Shows the notice
 * when the page went from a layout to custom and has not shown it yet. Returns whether it showed.
 */
export function noticeCustomPage(pageId: string, layoutBefore: string | undefined): boolean {
  if (layoutBefore === undefined || layoutBefore === LAYOUT_CUSTOM || layoutBefore === LAYOUT_BLANK) return false;
  if (noticed.has(pageId) || pageLayout(pageId) !== LAYOUT_CUSTOM) return false;
  noticed.add(pageId);
  const history = useBookStore.temporal;
  const start = history.getState();
  const last = start.pastStates.at(-1);
  const future = start.futureStates.length;
  let unsubscribe: (() => void) | null = null;
  const id = showToast(CUSTOM_PAGE_MESSAGE, {
    action: { label: 'Undo', run: () => undo() },
    onClose: () => unsubscribe?.(),
  });
  // Another step (or an undo) makes "Undo" ambiguous: close the toast.
  unsubscribe = history.subscribe((t) => {
    if (t.pastStates.at(-1) !== last || t.futureStates.length !== future) dismissToast(id);
  });
  return true;
}

/** Forget which pages showed the notice (tests). */
export function resetCustomPageNotices(): void {
  noticed.clear();
}
