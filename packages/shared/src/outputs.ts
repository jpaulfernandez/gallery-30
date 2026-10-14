import type { BookTemplate, Output, OutputKind, Page } from './schema.js';
import { DEFAULT_SOCIAL_NETWORK, frameTemplate } from './social/templates.js';

/**
 * Output documents (workflow plan 13): a project holds the book (its top-level `pages`) and the documents in
 * `book.outputs` (social posts now, print and slideshow later). The Design stage edits one at a time, named by an
 * output id; `BOOK_OUTPUT_ID` is the reserved id of the book's own pages. These helpers are generic over the
 * book's shape so the editor's Immer drafts go through them too.
 */

/** The reserved output id of the book's own pages (`/project/$id/design/book`). */
export const BOOK_OUTPUT_ID = 'book';

/** What the UI calls each kind of output (it never says "output"). */
export const OUTPUT_KIND_LABELS: Record<OutputKind | 'book', string> = {
  book: 'Book',
  social: 'Post',
  print: 'Print',
  slideshow: 'Slideshow',
};

/**
 * Page size of a social post on the default network (the 4:5 Instagram carousel, what plan 13 drew every post as). A
 * post's own size is its network's (`frameTemplate`), never the book's, so a post in a square book keeps its shape.
 */
export const SOCIAL_DEFAULT_TEMPLATE: BookTemplate = frameTemplate(DEFAULT_SOCIAL_NETWORK);

/** The shape of a book these helpers read: its pages, template and outputs (a `Book` or an Immer draft of one). */
export interface OutputHolder<P> {
  pages: P[];
  template: BookTemplate;
  outputs: Array<{ id: string; kind: string; frames?: P[]; network?: string; source?: string }>;
}

/** The output with `outputId`, or undefined (also for `BOOK_OUTPUT_ID`). */
export function findOutput<O extends { id: string }>(book: { outputs: O[] }, outputId: string): O | undefined {
  if (outputId === BOOK_OUTPUT_ID) return undefined;
  return book.outputs.find((o) => o.id === outputId);
}

/** Whether `outputId` names a document of this book: the book itself or one of its outputs. */
export function hasOutput(book: { outputs: Array<{ id: string }> }, outputId: string): boolean {
  return outputId === BOOK_OUTPUT_ID || book.outputs.some((o) => o.id === outputId);
}

/**
 * The pages document `outputId` shows and edits: the book's pages for `BOOK_OUTPUT_ID`, a social post's frames, the
 * pages of a print's source (plan 15: the book, or a post; `printSourceId`). An unknown id has no pages (a fresh
 * empty array, so a write to it goes nowhere). The array is the book's own, so a draft's can be spliced in place.
 */
export function pagesOf<P>(book: OutputHolder<P>, outputId: string): P[] {
  if (outputId === BOOK_OUTPUT_ID) return book.pages;
  const output = book.outputs.find((o) => o.id === outputId);
  if (!output) return [];
  if (output.kind === 'print') return pagesOf(book, printSourceId(book, output));
  // A slideshow (plan 16) shows its source's pages on the canvas, as a print does (for the picks, the book's).
  if (output.kind === 'slideshow') return pagesOf(book, printSourceId(book, output));
  return output.frames ?? book.pages;
}

/** The page size of document `outputId`: the book's template, or the output's (a post's frames have their own). */
export function templateOf(book: Pick<OutputHolder<unknown>, 'template' | 'outputs'>, outputId: string): BookTemplate {
  const output = outputId === BOOK_OUTPUT_ID ? undefined : book.outputs.find((o) => o.id === outputId);
  if (output?.kind === 'print') return templateOf(book, printSourceId(book, output));
  if (output?.kind === 'slideshow') return templateOf(book, printSourceId(book, output));
  return output?.kind === 'social' ? frameTemplate(output.network) : book.template;
}

/**
 * The document a print prints (workflow plan 15): its `source` when that is a social post, else the book
 * (`BOOK_OUTPUT_ID`; also for a source that was deleted). Only pages documents qualify, so sources never loop.
 */
export function printSourceId(
  book: { outputs: Array<{ id: string; kind: string }> },
  print: { source?: string },
): string {
  const source = print.source;
  if (!source || source === BOOK_OUTPUT_ID) return BOOK_OUTPUT_ID;
  const output = book.outputs.find((o) => o.id === source);
  return output?.kind === 'social' ? output.id : BOOK_OUTPUT_ID;
}

/** Where a page lives: its document's id, that document's page list and template, and its index in the list. */
export interface PageLocation<P> {
  outputId: string;
  pages: P[];
  index: number;
  template: BookTemplate;
}

/** Find page `pageId` in the book's pages or any output's frames (page ids are unique across the whole book). */
export function locatePage<P extends { id: string }>(
  book: OutputHolder<P>,
  pageId: string,
): PageLocation<P> | undefined {
  const index = book.pages.findIndex((p) => p.id === pageId);
  if (index >= 0) return { outputId: BOOK_OUTPUT_ID, pages: book.pages, index, template: book.template };
  for (const output of book.outputs) {
    const frames = output.frames;
    const at = frames?.findIndex((p) => p.id === pageId) ?? -1;
    if (frames && at >= 0)
      return { outputId: output.id, pages: frames, index: at, template: templateOf(book, output.id) };
  }
  return undefined;
}

/** Every page of the book: its own pages, then each output's frames (an output without frames, a print, adds none). */
export function allPages<P>(book: Pick<OutputHolder<P>, 'pages' | 'outputs'>): P[] {
  const pages = [...book.pages];
  for (const output of book.outputs) if (output.frames) pages.push(...output.frames);
  return pages;
}

/** A name for a new output of `kind` that no other output of the book has: "Post", "Post 2", ... */
export function nextOutputName(book: { outputs: Array<Pick<Output, 'name'>> }, kind: OutputKind): string {
  return uniqueOutputName(book, OUTPUT_KIND_LABELS[kind]);
}

/** `base` when no output of the book has that name, else "base 2", "base 3", ... (e.g. a duplicate's "Post copy"). */
export function uniqueOutputName(book: { outputs: Array<Pick<Output, 'name'>> }, base: string): string {
  const taken = new Set(book.outputs.map((o) => o.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/** Ids of the assets every page of the book uses (photo elements and page backgrounds), outputs included. */
export function usedAssetIdsOf(book: Pick<OutputHolder<Page>, 'pages' | 'outputs'>): Set<string> {
  const ids = new Set<string>();
  for (const page of allPages(book)) {
    if (typeof page.background === 'object') ids.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset !== null) ids.add(el.asset);
  }
  return ids;
}
