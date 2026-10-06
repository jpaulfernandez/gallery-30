/**
 * Paths: `/` lists the books, `/<slug>` opens a book, `/<slug>/<page>` opens it on a 1-based page.
 * vercel.json rewrites all three to index.html; this module is the whole router (no library).
 */

export type Route = { kind: 'root' } | { kind: 'book'; slug: string; page: number | null };

export function parseRoute(pathname: string): Route {
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  const slug = parts[0];
  if (slug === undefined) return { kind: 'root' };
  const pageText = parts[1];
  const page = pageText !== undefined && /^\d+$/.test(pageText) && Number(pageText) >= 1 ? Number(pageText) : null;
  return { kind: 'book', slug, page };
}

export function bookPath(slug: string, page?: number): string {
  const base = `/${encodeURIComponent(slug)}`;
  return page === undefined ? base : `${base}/${page}`;
}

export const currentRoute = (): Route => parseRoute(window.location.pathname);

/** Rewrite the URL without a history entry (page turns, the single-book redirect). */
export function replacePath(path: string): void {
  if (window.location.pathname !== path) window.history.replaceState(window.history.state, '', path);
}

/** In-app navigation: push a history entry and let the `popstate` listener re-route. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
