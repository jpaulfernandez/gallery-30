import { isDefaultDevelop } from '../develop/schema.js';
import { resolveAssetDevelop } from '../library.js';
import type { Book } from '../schema.js';
import { normalizeAlt } from './alt.js';
import { canonicalJson } from './canonical.js';
import { sha256Hex } from './password.js';

export { canonicalJson };

/**
 * Everything about a book that reaches the published manifest or `site.json`, in a canonical form:
 * title, template, theme, slug, visibility, password and a Display P3 output profile, the pages without their notes and guides, and
 * the content hash of every asset a page uses (with its develop settings when edited, and its alt text when it has one: the
 * manifest publishes it, plan 35). Local paths, folders, sizes, mtimes, unused
 * assets, outputs, captions and the publish record itself are left out, so the fingerprint only changes when a republish would
 * change something.
 *
 * Develop settings are `resolveAssetDevelop(asset)` without a library (the snapshot, else `asset.develop`): pass the book read
 * through the library (`withResolvedDevelop`; the editor's `libraryBook`), as publishing renders it.
 */
export function publishableContent(book: Book): unknown {
  const used = new Set<string>();
  const pages = book.pages.map(({ notes: _notes, guides: _guides, ...page }) => {
    if (typeof page.background === 'object') used.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset) used.add(el.asset);
    return page;
  });
  // The content hash alone, or `{ hash, develop?, alt? }` once the photo has develop edits or alt text: books without
  // edits or alt text (and every book from before the Develop module) keep their fingerprint. Alt text changes the
  // manifest only (page renders are keyed without it, `pageHash` in the CLI), but a republish is still needed.
  const assets: Record<string, string | null | { hash: string | null; develop?: unknown; alt?: string }> = {};
  for (const id of [...used].sort()) {
    const asset = book.assets[id];
    const hash = asset?.hash ?? null;
    const develop = asset && resolveAssetDevelop(asset);
    const edited = develop && !isDefaultDevelop(develop) ? develop : undefined;
    const alt = normalizeAlt(asset?.alt) || undefined;
    assets[id] = edited || alt ? { hash, ...(edited ? { develop: edited } : {}), ...(alt ? { alt } : {}) } : hash;
  }
  return {
    id: book.id,
    title: book.title,
    template: book.template,
    theme: book.theme,
    slug: book.publish.slug,
    visibility: book.publish.visibility,
    // Left out when unset, so books published before passwords keep their fingerprint.
    password: book.publish.password ?? undefined,
    // Display P3 changes every developed render; left out for sRGB so earlier books keep their fingerprint.
    outputProfile: book.outputProfile === 'display-p3' ? book.outputProfile : undefined,
    assets,
    pages,
  };
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
