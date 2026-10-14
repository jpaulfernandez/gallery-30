import { type Book, BookSchema, type TextElement, templateFor } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captionFrame } from '../lib/grid';
import { redo, undo, useBookStore } from './book';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();
const actions = () => useBookStore.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const pageIds = () => book().pages.map((p) => p.id);
const allIds = (b: Book) => b.pages.map((p) => [p.id, p.elements.map((e) => e.id)] as const);

/** The fixture book with `n` pages (the fixture pages repeated with fresh ids). */
function bookWithPages(n: number): Book {
  const base = structuredClone(fixtureBook);
  const pages = Array.from({ length: n }, (_, i) => {
    const src = base.pages[i % base.pages.length];
    if (!src) throw new Error('fixture has no pages');
    return {
      ...structuredClone(src),
      id: `page-${i}`,
      elements: src.elements.map((e, j) => ({ ...structuredClone(e), id: `el-${i}-${j}` })),
    };
  });
  return { ...base, pages };
}

beforeEach(() => {
  useBookStore.setState({ book: bookWithPages(10), folder: '/photos' });
  history().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('page operations', () => {
  it('duplicatePage inserts a copy after the source with a new page id and new element ids', () => {
    const before = book();
    const source = before.pages[3];
    if (!source) throw new Error('no page 3');
    const id = actions().duplicatePage(source.id);
    expect(id).toBeTruthy();
    const after = book();
    expect(after.pages).toHaveLength(11);
    const copy = after.pages[4];
    expect(copy?.id).toBe(id);
    expect(copy?.id).not.toBe(source.id);
    // Same content, fresh ids.
    expect(copy?.elements.map(({ id: _, ...rest }) => rest)).toEqual(source.elements.map(({ id: _, ...rest }) => rest));
    const oldIds = new Set(before.pages.flatMap((p) => [p.id, ...p.elements.map((e) => e.id)]));
    for (const e of copy?.elements ?? []) expect(oldIds.has(e.id)).toBe(false);
    // Order of everything else is unchanged.
    expect(pageIds().filter((p) => p !== id)).toEqual(before.pages.map((p) => p.id));
    expect(after.pages[3]).toBe(source);
    expect(() => BookSchema.parse(after)).not.toThrow();
    expect(history().pastStates).toHaveLength(1);
  });

  it('movePage reorders ten pages without changing any page or element id', () => {
    const before = book();
    const idsBefore = allIds(before);
    actions().movePage(0, 9);
    actions().movePage(5, 1);
    actions().movePage(9, 0);
    actions().movePage(2, 7);
    const after = book();
    expect(after.pages).toHaveLength(10);
    // Same set of pages, each with exactly the same element ids in the same order.
    const byId = new Map(idsBefore);
    for (const [pageId, elementIds] of allIds(after)) expect(byId.get(pageId)).toEqual(elementIds);
    expect(new Set(pageIds())).toEqual(new Set(idsBefore.map(([id]) => id)));
    expect(pageIds()).not.toEqual(idsBefore.map(([id]) => id));
    // The serialized project survives a round trip.
    expect(() => BookSchema.parse(after)).not.toThrow();
    // Out-of-range and no-op moves change nothing and record nothing.
    const steps = history().pastStates.length;
    actions().movePage(3, 3);
    actions().movePage(-1, 2);
    actions().movePage(2, 10);
    expect(history().pastStates).toHaveLength(steps);
  });

  it('movePage moves a page to the target index', () => {
    const ids = pageIds();
    actions().movePage(1, 4);
    expect(pageIds()).toEqual([ids[0], ids[2], ids[3], ids[4], ids[1], ...ids.slice(5)]);
    actions().movePage(4, 1);
    expect(pageIds()).toEqual(ids);
  });

  it('deletePage is one undoable step and keeps the ui page index in range', () => {
    const before = book();
    const last = before.pages[9];
    if (!last) throw new Error('no page 9');
    useUiStore.getState().setPageIndex(9);
    actions().deletePage(last.id);
    expect(pageIds()).toEqual(before.pages.slice(0, 9).map((p) => p.id));
    expect(useUiStore.getState().pageIndex).toBe(8);
    expect(history().pastStates).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(book()).toEqual(before);
    expect(redo()).toBe(true);
    expect(book().pages).toHaveLength(9);
  });

  it('can delete every page', () => {
    for (const id of pageIds()) actions().deletePage(id);
    expect(book().pages).toEqual([]);
    expect(useUiStore.getState().pageIndex).toBe(0);
    expect(undo()).toBe(true);
    expect(book().pages).toHaveLength(1);
  });

  it('setPageBackground adds the asset entry for a new photo and refuses a dangling id', () => {
    const id = pageIds()[0] ?? '';
    actions().setPageBackground(id, { asset: 'dangling' });
    expect(book().pages[0]?.background).not.toEqual({ asset: 'dangling' });
    actions().setPageBackground(id, { asset: 'bg-asset' }, { path: 'bg.jpg' });
    expect(book().pages[0]?.background).toEqual({ asset: 'bg-asset' });
    expect(book().assets['bg-asset']).toEqual({ path: 'bg.jpg', folder: 'fixture-folder' });
    actions().setPageBackground(id, '#123456');
    expect(book().pages[0]?.background).toBe('#123456');
    expect(() => BookSchema.parse(book())).not.toThrow();
  });
});

describe('text elements', () => {
  it('addText creates an empty caption at the bottom margin of the page', () => {
    const page = book().pages[0];
    if (!page) throw new Error('no page');
    const id = actions().addText(page.id);
    const text = book().pages[0]?.elements.find((e) => e.id === id) as TextElement | undefined;
    expect(text).toMatchObject({ type: 'text', text: '', style: 'caption', align: 'left' });
    expect(text?.frame).toEqual(captionFrame(book().template, book().theme));
    expect(book().pages[0]?.elements.at(-1)?.id).toBe(id);
    expect(() => BookSchema.parse(book())).not.toThrow();
    expect(history().pastStates).toHaveLength(1);
  });

  it('caption frame lands on the bottom margin for the square template too', () => {
    const square = templateFor('square');
    const f = captionFrame(square, { margin: 0.04, gutter: 0.02 });
    expect(f.x).toBeCloseTo(0.04, 6);
    expect(f.y + f.h).toBeLessThanOrEqual(0.96 + 1e-9);
    expect(0.96 - (f.y + f.h)).toBeLessThan(8 / square.height);
  });

  it('removeElement deletes a text element (undoable)', () => {
    const page = book().pages[0];
    if (!page) throw new Error('no page');
    const id = actions().addText(page.id) ?? '';
    useUiStore.getState().editText(id);
    expect(useUiStore.getState()).toMatchObject({ selectedElementId: id, editingTextId: id });
    actions().removeElement(page.id, id);
    expect(book().pages[0]?.elements.some((e) => e.id === id)).toBe(false);
    // The ui drops a selection and an edit whose element is gone.
    expect(useUiStore.getState()).toMatchObject({ selectedElementId: null, editingTextId: null });
    undo();
    expect(book().pages[0]?.elements.some((e) => e.id === id)).toBe(true);
  });

  it('selecting another element ends inline editing', () => {
    const page = book().pages[0];
    if (!page) throw new Error('no page');
    const id = actions().addText(page.id) ?? '';
    useUiStore.getState().editText(id);
    useUiStore.getState().select(id);
    expect(useUiStore.getState().editingTextId).toBe(id);
    useUiStore.getState().select(page.elements[0]?.id ?? null);
    expect(useUiStore.getState().editingTextId).toBeNull();
  });

  it('single-caption layout adds a caption text element through applyLayout', () => {
    const page = book().pages[0];
    if (!page) throw new Error('no page');
    actions().applyLayout(page.id, 'single-caption');
    const after = book().pages[0];
    expect(after?.layout).toBe('single-caption');
    // The page's first text takes the layout's caption item; the second (extra) one is kept as is.
    const before = page.elements.filter((e) => e.type === 'text');
    const texts = after?.elements.filter((e) => e.type === 'text') ?? [];
    expect(before).toHaveLength(2);
    expect(texts.map((t) => t.id)).toEqual(before.map((t) => t.id));
    expect(texts[1]).toEqual(before[1]);
    expect(() => BookSchema.parse(book())).not.toThrow();
  });
});
