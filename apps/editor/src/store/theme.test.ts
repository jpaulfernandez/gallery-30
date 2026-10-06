import { type Book, BookSchema, LAYOUT_BLANK, LAYOUT_LIBRARY, resolveTheme } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redo, undo, useBookStore } from './book';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();
const actions = () => useBookStore.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('book theme settings', () => {
  it('setTheme merges tokens as one undo step, and undo / redo restore them', () => {
    const before = book().theme;
    actions().setTheme({ margin: 0.1, gutter: 0.03 });
    expect(book().theme).toMatchObject({ margin: 0.1, gutter: 0.03 });
    expect(book().theme.fonts).toEqual(before.fonts);
    expect(history().pastStates).toHaveLength(1);
    expect(() => BookSchema.parse(book())).not.toThrow();

    expect(undo()).toBe(true);
    expect(book().theme).toEqual(before);
    expect(redo()).toBe(true);
    expect(book().theme).toMatchObject({ margin: 0.1, gutter: 0.03 });
  });

  it('setTheme with unchanged values records nothing', () => {
    const { margin } = resolveTheme(book().theme);
    actions().setTheme({ margin });
    expect(history().pastStates).toHaveLength(0);
  });

  it('setDefaultPageBackground is undoable and new pages use it', () => {
    actions().setDefaultPageBackground('#f4efe6');
    expect(book().theme.defaultPageBackground).toBe('#f4efe6');
    expect(history().pastStates).toHaveLength(1);
    const id = actions().addPage();
    expect(book().pages.find((p) => p.id === id)?.background).toBe('#f4efe6');
    undo();
    undo();
    expect(book().theme.defaultPageBackground).toBe(resolveTheme(fixtureBook.theme).defaultPageBackground);
  });

  it('reapplyLayouts re-flows library pages with the new margin and skips blank pages', () => {
    const layout = LAYOUT_LIBRARY.find((l) => l.photos === 1 && l.group === 'photos' && !l.bleed);
    if (!layout) throw new Error('no 1-photo layout');
    const first = book().pages[0];
    if (!first) throw new Error('no page');
    actions().applyLayout(first.id, layout.id);
    const blankId = actions().addPage() ?? '';
    const frameBefore = book().pages[0]?.elements.find((e) => e.type === 'photo')?.frame;
    actions().setTheme({ margin: 0.12 });
    const steps = history().pastStates.length;
    const count = actions().reapplyLayouts();
    expect(count).toBeGreaterThan(0);
    expect(history().pastStates).toHaveLength(steps + 1);
    const frameAfter = book().pages[0]?.elements.find((e) => e.type === 'photo')?.frame;
    expect(frameAfter).not.toEqual(frameBefore);
    const blank = book().pages.find((p) => p.id === blankId);
    expect(blank?.layout).toBe(LAYOUT_BLANK);
    expect(blank?.elements).toEqual([]);
    expect(() => BookSchema.parse(book())).not.toThrow();
  });
});

describe('addPage', () => {
  it('adds a blank page with the theme default background and no elements', () => {
    actions().setDefaultPageBackground('#101820');
    const count = book().pages.length;
    const id = actions().addPage(1);
    expect(id).toBeTruthy();
    expect(book().pages).toHaveLength(count + 1);
    const added = book().pages[1];
    expect(added?.id).toBe(id);
    expect(added?.layout).toBe(LAYOUT_BLANK);
    expect(added?.elements).toEqual([]);
    expect(added?.background).toBe('#101820');
    expect(() => BookSchema.parse(book())).not.toThrow();
  });

  it('applying a layout to the blank page fills it, and Blank empties it again', () => {
    const id = actions().addPage() ?? '';
    const layout = LAYOUT_LIBRARY.find((l) => l.photos === 3);
    if (!layout) throw new Error('no 3-photo layout');
    actions().applyLayout(id, layout.id);
    const page = book().pages.find((p) => p.id === id);
    expect(page?.layout).toBe(layout.id);
    expect(page?.elements.filter((e) => e.type === 'photo')).toHaveLength(3);
    actions().applyLayout(id, LAYOUT_BLANK);
    expect(book().pages.find((p) => p.id === id)?.elements).toEqual([]);
  });
});
