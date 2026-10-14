import { z } from 'zod';
import { AccessPasswordSchema } from '../schema.js';

/**
 * `site.json` at the bucket root: the listed books and the social API origin. Rewritten by every
 * publish (merging that book in or out by visibility). Passwords are per book, in each manifest.
 */

/** The old site-wide password, from before passwords moved onto each book. Read, never written anew. */
export const SitePasswordSchema = AccessPasswordSchema;

export const SiteBookSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  /** Thumbnail URL of the first page, or null for a book without photos. */
  cover: z.url().nullable(),
  pages: z.number().int().nonnegative(),
  publishedAt: z.iso.datetime({ offset: true }),
  /** The book has a password: the list blurs its cover. */
  locked: z.boolean().default(false),
});

export const SiteSchema = z.object({
  /**
   * Legacy site-wide password, or null. Still honoured by the viewer for the book list and for
   * manifests published before per-book passwords (they have no `password` field); publishing
   * keeps it as it is, and `photobook password clear` removes it.
   */
  password: SitePasswordSchema.nullable().default(null),
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
