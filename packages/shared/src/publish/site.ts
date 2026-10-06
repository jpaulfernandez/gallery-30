import { z } from 'zod';

/**
 * `site.json` at the bucket root: the soft password and the listed books. Rewritten by every
 * publish (merging that book in or out by visibility) and by a password change.
 */

export const SitePasswordSchema = z.object({
  /** `hashPassword(word, salt)`: SHA-256 hex over `salt + word`. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  salt: z.string().min(1),
  /** Bumped on every change; the viewer stores the version it was granted. */
  version: z.number().int().positive(),
  /** Grants older than this are asked again; null never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

export const SiteBookSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  /** Thumbnail URL of the first page, or null for a book without photos. */
  cover: z.url().nullable(),
  pages: z.number().int().nonnegative(),
  publishedAt: z.iso.datetime({ offset: true }),
});

export const SiteSchema = z.object({
  /** null while no password is set: the viewer shows no prompt. */
  password: SitePasswordSchema.nullable(),
  /** Listed books only, in publish order. */
  books: z.array(SiteBookSchema),
  /**
   * Origin of the social API Worker (likes and the download log), or null when none is configured:
   * the viewer then hides likes and does not log. Written from the `SOCIAL_API_URL` setting.
   */
  api: z.url().nullable().default(null),
});

export type SitePassword = z.infer<typeof SitePasswordSchema>;
export type SiteBook = z.infer<typeof SiteBookSchema>;
export type Site = z.infer<typeof SiteSchema>;

export const EMPTY_SITE: Site = { password: null, books: [], api: null };

export function parseSite(json: unknown): Site {
  return SiteSchema.parse(json);
}

/** Put `book` in `site.books` (replacing an entry with the same slug) or take it out. */
export function mergeSiteBook(site: Site, book: SiteBook, listed: boolean): Site {
  const others = site.books.filter((b) => b.slug !== book.slug);
  if (!listed) return { ...site, books: others };
  const index = site.books.findIndex((b) => b.slug === book.slug);
  const books = index === -1 ? [...others, book] : site.books.map((b) => (b.slug === book.slug ? book : b));
  return { ...site, books };
}
