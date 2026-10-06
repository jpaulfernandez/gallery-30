import { type Book, getLayout, LAYOUT_BLANK, LAYOUT_CUSTOM, LAYOUT_LIBRARY, type LayoutData } from '@photobook/shared';

/** Photo counts the Layouts tab and the picker filter by. */
export const LAYOUT_COUNTS = [1, 2, 3, 4, 5, 6] as const;
export type LayoutCountFilter = 'all' | (typeof LAYOUT_COUNTS)[number];

/**
 * Library layouts the UI offers. `LAYOUT_LIBRARY` holds only the reference library; the legacy
 * `LayoutDef`s (kept so old pages still resolve) are not in it, so they stay hidden.
 */
export const VISIBLE_LAYOUTS: readonly LayoutData[] = LAYOUT_LIBRARY.filter((l) => l.group !== 'custom');

export interface LayoutCountGroup {
  photos: number;
  /** "Photos only". */
  photosOnly: LayoutData[];
  /** "With captions". */
  captioned: LayoutData[];
}

/** Library layouts by photo count (1 to 6), each split into photos only / with captions. */
export function groupLayouts(filter: LayoutCountFilter = 'all', library = VISIBLE_LAYOUTS): LayoutCountGroup[] {
  const counts = filter === 'all' ? LAYOUT_COUNTS : [filter];
  return counts
    .map((photos) => {
      const of = library.filter((l) => l.photos === photos);
      return {
        photos,
        photosOnly: of.filter((l) => l.group === 'photos'),
        captioned: of.filter((l) => l.group === 'captioned'),
      };
    })
    .filter((g) => g.photosOnly.length + g.captioned.length > 0);
}

/** Custom layouts of the book, filtered by photo count. */
export function customLayouts(book: Pick<Book, 'customLayouts'>, filter: LayoutCountFilter = 'all'): LayoutData[] {
  return filter === 'all' ? book.customLayouts : book.customLayouts.filter((l) => l.photos === filter);
}

/**
 * A layout by id: the book's custom layouts first, then the library, the same order as shared
 * `getLayout` (legacy ids have no `LayoutData` here; `layoutName` falls back to `getLayout`).
 */
export function findLayout(id: string, book: Pick<Book, 'customLayouts'>): LayoutData | undefined {
  return book.customLayouts.find((l) => l.id === id) ?? LAYOUT_LIBRARY.find((l) => l.id === id);
}

/** Display name of a page's layout id (legacy ids included). */
export function layoutName(id: string, book: Pick<Book, 'customLayouts'>): string {
  if (id === LAYOUT_BLANK) return 'Blank';
  if (id === LAYOUT_CUSTOM) return 'Custom frames';
  return findLayout(id, book)?.name ?? getLayout(id, book.customLayouts)?.name ?? id;
}
