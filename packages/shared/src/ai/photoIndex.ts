import type { Library, LibraryPhotoAi } from '../library.js';
import type { Asset, Book } from '../schema.js';

/**
 * Workflow plan 33: the photo index as text. Caption requests (plans 34 and 35) send it in the cached system block
 * instead of the photos themselves: about 60 tokens a photo, so a 90-photo book is about 5,400 tokens at text prices.
 *
 * Photos are numbered book-wide, `Photo 1`, `Photo 2`, ... in book order (the first page they appear on; with scope
 * `all`, then the photos on no page by path), so no ids, file names or paths are sent. These numbers are the index's
 * own: `ai_describe` labels the images of each request `Photo 1` to `Photo 8` afresh, so a caption request that sends
 * images (plan 35) should label them with their index number (`PhotoIndexEntry.n`) for the two to agree. The text is a
 * pure function of the book, the libraries and the options: the same inputs give the same bytes, which keeps the
 * prompt cache warm across a book's requests.
 */

/** One photo of the index. */
export interface PhotoIndexEntry {
  /** 1-based; the text calls it `Photo n`. */
  n: number;
  assetId: string;
  /** 1-based numbers of the book pages it is on (as a photo or a background), in order; empty when on none. */
  pages: number[];
  /** Its library entry's description; absent when it has not been described yet. */
  ai?: LibraryPhotoAi;
}

/**
 * Which photos the index lists. `placed` (the default): the photos on the book's pages, then `include` (e.g. the photo
 * a caption is for) when not placed. `all`: every asset of the book, the unplaced ones by path after the placed ones.
 */
export interface IndexOptions {
  scope?: 'placed' | 'all';
  /** Asset ids listed after the placed photos when they are on no page (scope `placed`; `all` lists them anyway). */
  include?: readonly string[];
}

/** The library of an asset (its folder's), or one library for every asset. */
export type IndexLibrary = Library | ((asset: Asset) => Library | undefined);

function libraryFor(library: IndexLibrary | undefined, asset: Asset): Library | undefined {
  return typeof library === 'function' ? library(asset) : library;
}

/** The asset's index entry in `library`, if it is hashed and described. */
export function photoAi(asset: Asset, library: Library | undefined): LibraryPhotoAi | undefined {
  const hash = asset.hash;
  if (!hash || !library || !Object.hasOwn(library.photos, hash)) return undefined;
  return library.photos[hash]?.ai;
}

/** The photos of `book` the index lists (`options`), in index order with their pages and description. */
export function indexEntries(
  book: Pick<Book, 'assets' | 'pages'>,
  library?: IndexLibrary,
  options: IndexOptions = {},
): PhotoIndexEntry[] {
  const pagesOf = new Map<string, number[]>();
  const order: string[] = [];
  const see = (assetId: string | null | undefined, page: number) => {
    if (!assetId || !Object.hasOwn(book.assets, assetId)) return;
    let pages = pagesOf.get(assetId);
    if (!pages) {
      pages = [];
      pagesOf.set(assetId, pages);
      order.push(assetId);
    }
    if (pages[pages.length - 1] !== page) pages.push(page);
  };
  book.pages.forEach((page, i) => {
    if (typeof page.background === 'object') see(page.background.asset, i + 1);
    for (const element of page.elements) if (element.type === 'photo') see(element.asset, i + 1);
  });
  const rest =
    options.scope === 'all'
      ? Object.keys(book.assets)
          .filter((id) => !pagesOf.has(id))
          .sort((a, b) => {
            const pa = book.assets[a]?.path ?? '';
            const pb = book.assets[b]?.path ?? '';
            return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : a > b ? 1 : 0;
          })
      : [...new Set(options.include ?? [])].filter((id) => !pagesOf.has(id) && Object.hasOwn(book.assets, id));
  return [...order, ...rest].map((assetId, i) => {
    const asset = book.assets[assetId] as Asset;
    const ai = photoAi(asset, libraryFor(library, asset));
    return { n: i + 1, assetId, pages: pagesOf.get(assetId) ?? [], ...(ai ? { ai } : {}) };
  });
}

/** One line on one line: newlines and runs of spaces become single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `Photo 3 (p. 2): <description> People: 2. Setting: tram stop. Time: evening. Mood: nostalgic.` */
export function indexLine(entry: PhotoIndexEntry): string {
  const where =
    entry.pages.length === 0
      ? ''
      : ` (${entry.pages.length === 1 ? 'p.' : 'pp.'} ${entry.pages.map((p) => String(p)).join(', ')})`;
  const head = `Photo ${entry.n}${where}:`;
  const ai = entry.ai;
  if (!ai) return `${head} not described yet.`;
  const description = oneLine(ai.description);
  const parts = [
    description ? (/[.!?]$/.test(description) ? description : `${description}.`) : '',
    `People: ${ai.people}.`,
    ai.setting.trim() ? `Setting: ${oneLine(ai.setting)}.` : '',
    ai.timeOfDay !== 'unknown' ? `Time: ${ai.timeOfDay}.` : '',
    ai.mood.trim() ? `Mood: ${oneLine(ai.mood)}.` : '',
  ].filter(Boolean);
  return `${head} ${parts.join(' ')}`;
}

/** The heading of the index block. */
export const INDEX_HEADING = 'Photo index (the photos of this book, in book order):';

/**
 * The index of `book` as the system block text: a heading and one line per photo (`indexLine`). `library` is the
 * folder library of each asset (or one library for all); `options.scope` is `placed` unless told otherwise (plan 35
 * uses `placed`). Empty string when it lists no photo.
 */
export function indexText(
  book: Pick<Book, 'assets' | 'pages'>,
  library?: IndexLibrary,
  options?: IndexOptions,
): string {
  const entries = indexEntries(book, library, options);
  if (entries.length === 0) return '';
  return [INDEX_HEADING, ...entries.map(indexLine)].join('\n');
}
