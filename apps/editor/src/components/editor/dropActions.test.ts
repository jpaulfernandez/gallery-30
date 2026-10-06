import {
  type Book,
  LAYOUT_BLANK,
  LAYOUT_CUSTOM,
  LAYOUT_LIBRARY,
  type PhotoElement,
  resolveTheme,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { photoDropFrame } from '../../lib/frames';
import { useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { layoutDndId } from './dnd';
import { handleDrop } from './dropActions';

const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};

const layoutOf = (photos: number) => {
  const layout = LAYOUT_LIBRARY.find((l) => l.photos === photos && l.group === 'photos');
  if (!layout) throw new Error(`no ${photos}-photo layout`);
  return layout;
};

beforeEach(() => {
  const b = structuredClone(fixtureBook);
  const first = b.pages[0];
  if (!first) throw new Error('fixture has no pages');
  // At least three pages to drop onto.
  while (b.pages.length < 3) b.pages.push({ ...structuredClone(first), id: `extra-${b.pages.length}` });
  useBookStore.setState({ book: b, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('layout drops', () => {
  it('a layout dropped on the canvas page applies to that page id only', () => {
    const target = book().pages[2];
    const other = book().pages[0];
    if (!target || !other) throw new Error('no pages');
    const layout = layoutOf(4);
    handleDrop({ kind: 'layout', layoutId: layout.id }, { kind: 'page-drop', pageId: target.id });
    expect(book().pages[2]?.layout).toBe(layout.id);
    expect(book().pages[2]?.elements.filter((e) => e.type === 'photo')).toHaveLength(4);
    expect(book().pages[0]).toBe(other);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
  });

  it('a layout dropped on a page strip tile applies to that page and keeps the current page', () => {
    useUiStore.getState().setPageIndex(0);
    const target = book().pages[1];
    if (!target) throw new Error('no page 1');
    const layout = layoutOf(2);
    handleDrop({ kind: 'layout', layoutId: layout.id }, { kind: 'page', pageId: target.id });
    expect(book().pages[1]?.layout).toBe(layout.id);
    expect(useUiStore.getState().pageIndex).toBe(0);
  });

  it('a layout dropped on a slot or the background well does nothing', () => {
    const before = book();
    const page = before.pages[0];
    const slot = page?.elements[0];
    if (!page || !slot) throw new Error('no slot');
    handleDrop({ kind: 'layout', layoutId: layoutOf(1).id }, { kind: 'slot', pageId: page.id, elementId: slot.id });
    handleDrop({ kind: 'layout', layoutId: layoutOf(1).id }, { kind: 'page-bg', pageId: page.id });
    expect(book()).toBe(before);
  });

  it('layout drag ids carry the layout prefix', () => {
    expect(layoutDndId('six-grid')).toBe('layout:six-grid');
  });
});

describe('photo drops on the page (outside any slot)', () => {
  const drag = { kind: 'asset' as const, assetId: 'new-asset', relPath: 'trip/new.jpg' };

  beforeEach(() => {
    useAssetsStore.setState({
      files: {
        [drag.relPath]: {
          relPath: drag.relPath,
          assetId: drag.assetId,
          size: 1234,
          mtime: 1,
          kind: 'jpeg',
          width: 3000,
          height: 2000,
          status: 'ready',
        },
      },
    });
  });
  afterEach(() => useAssetsStore.setState({ files: {} }));

  it('adds a frame holding the photo on a blank page, marks it custom and selects it', () => {
    const id = useBookStore.getState().addPage() ?? '';
    handleDrop(drag, { kind: 'page-drop', pageId: id });
    const page = book().pages.find((p) => p.id === id);
    const el = page?.elements[0] as PhotoElement | undefined;
    expect(page?.layout).toBe(LAYOUT_CUSTOM);
    expect(page?.elements).toHaveLength(1);
    expect(el).toMatchObject({ type: 'photo', asset: drag.assetId });
    // The largest 3:2 frame inside the safe margins, centred.
    const want = photoDropFrame({ width: 3000, height: 2000 }, resolveTheme(book().theme), book().template);
    expect(el?.frame).toEqual(want);
    expect(want.x + want.w / 2).toBeCloseTo(0.5, 6);
    expect(book().assets[drag.assetId]).toMatchObject({ path: drag.relPath, width: 3000, height: 2000 });
    expect(useUiStore.getState().selectedElementId).toBe(el?.id);
    // One undo step takes it all back.
    undo();
    expect(book().pages.find((p) => p.id === id)).toMatchObject({ layout: LAYOUT_BLANK, elements: [] });
  });

  it('fills the first empty frame instead when the page has one', () => {
    const target = book().pages[1];
    if (!target) throw new Error('no page');
    useBookStore.getState().applyLayout(target.id, layoutOf(4).id);
    const before = book().pages[1];
    const empty = before?.elements.find((e) => e.type === 'photo' && e.asset === null);
    if (!before || !empty) throw new Error('no empty frame');
    handleDrop(drag, { kind: 'page-drop', pageId: target.id });
    const after = book().pages[1];
    expect(after?.elements).toHaveLength(before.elements.length);
    expect(after?.layout).toBe(before.layout);
    expect(after?.elements.find((e) => e.id === empty.id)).toMatchObject({ asset: drag.assetId });
    expect(useUiStore.getState().selectedElementId).toBe(empty.id);
  });

  it('ignores slot drags dropped on the page', () => {
    const before = book();
    const page = before.pages[0];
    const slot = page?.elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
    if (!page || !slot?.asset) throw new Error('no filled slot');
    handleDrop(
      { kind: 'slot', pageId: page.id, elementId: slot.id, assetId: slot.asset },
      { kind: 'page-drop', pageId: page.id },
    );
    expect(book()).toBe(before);
  });
});
