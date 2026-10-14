import { z } from 'zod';
import { LensSchema } from './cull/lenses.js';

/**
 * Saved collections (workflow plan 06): named filters over the imported folders, in `<appdata>/collections.json` as
 * `[{ id, name, filter }]`. A collection is a filter, never a copy: its photos are whatever matches when it opens.
 * The editor reads and writes the file through the `read_collections` / `write_collections` commands and parses it
 * here; Rust only checks the id and the name.
 */

/**
 * Flag filter of the library views and of a collection: everything, no rejects, only picks (Kept), only rejects, or
 * only the photos with no flag yet (Undecided, plan 40).
 */
export const FlagFilterSchema = z.enum(['all', 'no-rejects', 'picks', 'rejects', 'undecided']);
export type FlagFilter = z.infer<typeof FlagFilterSchema>;

export const CollectionFilterSchema = z.object({
  /** Registry ids of the folders it draws from; absent means every imported folder. */
  folders: z.array(z.string().min(1)).min(1).optional(),
  flag: FlagFilterSchema.default('all'),
  /** Only photos rated at least this many stars; 0 keeps every rating, unrated included. */
  minRating: z.number().int().min(0).max(5).default(0),
  /** Only photos with a master edit. */
  edited: z.boolean().optional(),
  /** Only photos whose ISO (from the folder index) is at least this. */
  iso: z.number().int().positive().optional(),
  /** File name contains this (case-insensitive); '' keeps every name. */
  query: z.string().max(200).default(''),
  /** Capture time (the file mtime until EXIF dates are read) within `[from, to]`, epoch ms, inclusive. */
  dateRange: z
    .tuple([z.number(), z.number()])
    .refine(([from, to]) => from <= to, 'dateRange starts after it ends')
    .optional(),
  /**
   * The technical lens (plan 41): only photos in it (`inLens`). Absent reads as `'none'`, so collections saved before
   * the field still parse; a value this version does not know is dropped (as `'none'`) instead of the collection.
   */
  lens: LensSchema.optional().catch(undefined),
});
export type CollectionFilter = z.infer<typeof CollectionFilterSchema>;

export const COLLECTION_NAME_MAX = 80;

export const SavedCollectionSchema = z.object({
  /** A ULID (`newId()`), the route parameter of the collection. */
  id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  name: z.string().trim().min(1).max(COLLECTION_NAME_MAX),
  filter: CollectionFilterSchema,
});
export type SavedCollection = z.infer<typeof SavedCollectionSchema>;

/**
 * The saved collections of a `collections.json` value: entries that do not validate (or repeat an id) are dropped one
 * by one, so a bad entry never hides the others. Anything but an array is empty.
 */
export function parseSavedCollections(raw: unknown): SavedCollection[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SavedCollection[] = [];
  for (const entry of raw) {
    const parsed = SavedCollectionSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}
