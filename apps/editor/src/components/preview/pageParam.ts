/**
 * The preview's current page lives in the hash query: `#/book/preview?page=3` (1-based).
 *
 * The router uses hash history and the route has no `validateSearch`, so this reads and writes
 * `window.location.hash` directly. Writes use `history.replaceState` (no history entry per swipe,
 * and the router is not re-run); the history state object is kept so the router's bookkeeping survives.
 */

export const PREVIEW_PATH = '/book/preview';

function splitHash(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  return q < 0
    ? { path: raw, params: new URLSearchParams() }
    : { path: raw.slice(0, q), params: new URLSearchParams(raw.slice(q + 1)) };
}

/** The 1-based `page` in the current hash, or null when absent or not a positive integer. */
export function readPreviewPage(): number | null {
  const value = splitHash().params.get('page');
  if (value === null || !/^\d+$/.test(value)) return null;
  const page = Number(value);
  return page >= 1 ? page : null;
}

/** Write the 1-based `page` into the hash with `replaceState`. No-op when not on the preview route. */
export function writePreviewPage(page: number): void {
  const { path, params } = splitHash();
  if (path !== PREVIEW_PATH) return;
  params.set('page', String(page));
  const url = `${window.location.pathname}${window.location.search}#${path}?${params.toString()}`;
  window.history.replaceState(window.history.state, '', url);
}

/** Hash to assign to `window.location.hash` (or use as an href) to open the preview on a 1-based page. */
export function previewHref(page?: number): string {
  return page === undefined ? `#${PREVIEW_PATH}` : `#${PREVIEW_PATH}?page=${page}`;
}
