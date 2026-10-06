import type { Book } from '../schema.js';
import { sha256Hex } from './password.js';

/**
 * Everything about a book that reaches the published manifest or `site.json`, in a canonical form:
 * title, template, theme, slug and visibility, the pages without their notes, and the content hash
 * of every asset a page uses. Local paths, sizes, mtimes, unused assets and the publish record
 * itself are left out, so the fingerprint only changes when a republish would change something.
 */
export function publishableContent(book: Book): unknown {
  const used = new Set<string>();
  const pages = book.pages.map(({ notes: _notes, ...page }) => {
    if (typeof page.background === 'object') used.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset) used.add(el.asset);
    return page;
  });
  const assets: Record<string, string | null> = {};
  for (const id of [...used].sort()) assets[id] = book.assets[id]?.hash ?? null;
  return {
    id: book.id,
    title: book.title,
    template: book.template,
    theme: book.theme,
    slug: book.publish.slug,
    visibility: book.publish.visibility,
    assets,
    pages,
  };
}

/** Stable JSON: object keys sorted at every level, arrays in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 hex of `publishableContent(book)`. Stored as `publish.publishedFingerprint` after a publish. */
export function publishFingerprint(book: Book): Promise<string> {
  return sha256Hex(canonicalJson(publishableContent(book)));
}

/** True when the book differs from what was last published (or was never published). */
export async function hasUnpublishedChanges(book: Book): Promise<boolean> {
  if (!book.publish.publishedFingerprint) return true;
  return (await publishFingerprint(book)) !== book.publish.publishedFingerprint;
}
