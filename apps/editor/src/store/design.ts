import { BOOK_OUTPUT_ID, type Book, pagesOf, templateOf } from '@photobook/shared';
import { useBookStore } from './book';
import { useUiStore } from './ui';

/**
 * The document on the Design stage (workflow plan 13) as the canvas reads it: the book with `pages` and `template`
 * taken from the open output (`pagesOf`, `templateOf`), the book itself when the book is open. Everything else
 * (assets, theme, custom layouts) is the book's. Read-only: edits go through the book store's page actions, which find
 * a page by id in whichever document it is in.
 */
export type DesignBook = Book;

const views = new WeakMap<Book, Map<string, DesignBook>>();

/** `book` seen through output `outputId` (cached per book and output, so it is stable between renders). */
export function designBook(book: Book, outputId: string): DesignBook;
export function designBook(book: Book | null, outputId: string): DesignBook | null;
export function designBook(book: Book | null, outputId: string): DesignBook | null {
  if (!book || outputId === BOOK_OUTPUT_ID) return book;
  let byOutput = views.get(book);
  if (!byOutput) {
    byOutput = new Map();
    views.set(book, byOutput);
  }
  let view = byOutput.get(outputId);
  if (!view) {
    view = { ...book, pages: pagesOf(book, outputId), template: templateOf(book, outputId) };
    byOutput.set(outputId, view);
  }
  return view;
}

/** The open document right now (outside React): `designBook` of the open book and the Design stage's output. */
export function currentDesignBook(): DesignBook | null {
  return designBook(useBookStore.getState().book, useUiStore.getState().design.outputId);
}

/** The open document, re-rendering when the book or the output on the Design stage changes. */
export function useDesignBook(): DesignBook | null {
  const book = useBookStore((s) => s.book);
  const outputId = useUiStore((s) => s.design.outputId);
  return designBook(book, outputId);
}
