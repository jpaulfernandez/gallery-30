import { type Book, BookSchema, type PhotoElement, serializeBook, slotAspect } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampCrop, cropFit } from '../lib/crop';
import { startAutosave } from './autosave';
import { beginGesture, createIdleGesture, endGesture, redo, undo, useBookStore } from './book';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();

function load(book: Book = structuredClone(fixtureBook), folder = '/photos') {
  useBookStore.setState({ book, folder });
  history().clear();
}

const page = (i = 0) => {
  const p = useBookStore.getState().book?.pages[i];
  if (!p) throw new Error(`no page ${i}`);
  return p;
};
const photos = (i = 0) => page(i).elements.filter((e): e is PhotoElement => e.type === 'photo');
const actions = () => useBookStore.getState();

beforeEach(() => load());
afterEach(async () => {
  await useBookStore.getState().close();
  vi.useRealTimers();
});

describe('book store actions', () => {
  it('applyLayout keeps element ids and order, then adds empty slots', () => {
    const before = photos();
    actions().applyLayout(page().id, 'four-grid');
    const after = photos();
    expect(page().layout).toBe('four-grid');
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3).map((e) => [e.id, e.asset])).toEqual(before.map((e) => [e.id, e.asset]));
    expect(after[3]?.asset).toBeNull();
    // Shrinking drops the extra photos from the page but keeps the first ones' ids.
    actions().applyLayout(page().id, 'two-side-by-side');
    expect(photos().map((e) => e.id)).toEqual(before.slice(0, 2).map((e) => e.id));
    expect(() => BookSchema.parse(useBookStore.getState().book)).not.toThrow();
    expect(history().pastStates).toHaveLength(2);
  });

  it('applyLayout re-clamps every crop against the new slot', () => {
    let changed = false;
    for (const layout of ['two-side-by-side', 'two-stacked', 'single-full', 'four-grid']) {
      for (const el of photos()) if (el.asset) actions().setCrop(page().id, el.id, { x: 10, y: 10, scale: 1.5 });
      const before = photos().map((el) => el.crop);
      actions().applyLayout(page().id, layout);
      const book = useBookStore.getState().book;
      photos().forEach((el, i) => {
        expect(el.crop).toEqual(clampCrop(el.crop, cropFit(book, el)));
        if (before[i] && JSON.stringify(before[i]) !== JSON.stringify(el.crop)) changed = true;
      });
    }
    expect(changed).toBe(true);
  });

  it('replaceAssetId and removeAssets edit book.assets outside history', () => {
    const [a] = photos();
    if (!a?.asset) throw new Error('no photo');
    const from = a.asset;
    actions().replaceAssetId(from, 'other');
    expect(photos()[0]?.asset).toBe('other');
    expect(useBookStore.getState().book?.assets[from]).toBeUndefined();
    // The page background reference follows too.
    actions().setPageBackground(page(1).id, { asset: 'f3' });
    history().clear();
    actions().replaceAssetId('f3', 'bg');
    expect(
      useBookStore.getState().book?.pages.some((p) => typeof p.background === 'object' && p.background.asset === 'bg'),
    ).toBe(true);
    actions().removeAssets(['f2', 'nope']);
    expect(useBookStore.getState().book?.assets.f2).toBeUndefined();
    expect(history().pastStates).toHaveLength(0);
  });

  it('swapAssets swaps photo, rotation and filter and resets both crops', () => {
    const [a, b] = photos();
    if (!a || !b) throw new Error('fixture needs two photos');
    actions().swapAssets(page().id, a.id, b.id);
    const [a2, b2] = photos();
    expect(a2?.asset).toBe(b.asset);
    expect(b2?.asset).toBe(a.asset);
    expect(a2?.filter).toBe(b.filter);
    expect(a2?.crop).toEqual({ x: 0, y: 0, scale: 1 });
    expect(b2?.crop).toEqual({ x: 0, y: 0, scale: 1 });
    expect(undo()).toBe(true);
    expect(photos()[0]).toEqual(a);
  });

  it('setElementAsset adds a missing asset entry and empties a slot with null', () => {
    const [a] = photos();
    if (!a) throw new Error('no photo');
    actions().setElementAsset(page().id, a.id, 'new-asset', { path: 'new.jpg' });
    expect(useBookStore.getState().book?.assets['new-asset']).toEqual({ path: 'new.jpg' });
    expect(photos()[0]?.asset).toBe('new-asset');
    // Unknown id without an entry is refused (the book never holds a dangling id).
    actions().setElementAsset(page().id, a.id, 'dangling');
    expect(photos()[0]?.asset).toBe('new-asset');
    actions().setElementAsset(page().id, a.id, null);
    expect(photos()[0]?.asset).toBeNull();
    expect(photos().length).toBe(3);
  });

  it('records a gesture as one undo step', () => {
    const [a] = photos();
    if (!a) throw new Error('no photo');
    const original = a.crop;
    beginGesture();
    for (const x of [0.05, 0.1, 0.15, 0.2]) actions().setCrop(page().id, a.id, { x, y: 0, scale: 2 });
    expect(history().pastStates).toHaveLength(0);
    endGesture();
    expect(history().pastStates).toHaveLength(1);
    expect(photos()[0]?.crop).toEqual({ x: 0.2, y: 0, scale: 2 });
    undo();
    expect(photos()[0]?.crop).toEqual(original);
    redo();
    expect(photos()[0]?.crop).toEqual({ x: 0.2, y: 0, scale: 2 });
    // An empty gesture records nothing.
    beginGesture();
    endGesture();
    expect(history().pastStates).toHaveLength(1);
  });

  it('undo right after an idle gesture (pinch) undoes the gesture', () => {
    vi.useFakeTimers();
    const [a] = photos();
    if (!a) throw new Error('no photo');
    const original = a.crop;
    const pinch = createIdleGesture(300);
    for (const scale of [1.2, 1.4, 1.6]) {
      pinch.touch();
      actions().setCrop(page().id, a.id, { x: 0, y: 0, scale });
    }
    // Still within the idle window: undo ends the gesture first, then reverts it.
    expect(undo()).toBe(true);
    expect(photos()[0]?.crop).toEqual(original);
    expect(history().futureStates).toHaveLength(1);

    // A discrete action during an idle gesture is a step of its own.
    pinch.touch();
    actions().setCrop(page().id, a.id, { x: 0, y: 0, scale: 2 });
    actions().rotateElement(page().id, a.id);
    expect(history().pastStates).toHaveLength(2);
    undo();
    expect(photos()[0]?.rotate).toBe(a.rotate);
    expect(photos()[0]?.crop.scale).toBe(2);
    // The idle timer firing later records nothing more.
    vi.advanceTimersByTime(1000);
    expect(history().pastStates).toHaveLength(1);
  });

  it('clamps crops so the photo covers the slot', () => {
    const [a] = photos();
    if (!a) throw new Error('no photo');
    actions().setCrop(page().id, a.id, { x: 0.9, y: -0.9, scale: 1.5 });
    // f1 is 3:2, wider than the hero slot: more room sideways than the (scale - 1) / 2 vertically.
    const book = useBookStore.getState().book;
    const slot = slotAspect(a.frame, book?.template ?? { width: 1, height: 1 });
    const crop = photos()[0]?.crop;
    expect(crop?.x).toBeCloseTo((1.5 * (1.5 / slot) - 1) / 2, 5);
    expect(crop?.x).toBeGreaterThan(0.25);
    expect(crop?.y).toBe(-0.25);
    expect(crop?.scale).toBe(1.5);
  });

  it('clamps crops with the (scale - 1) / 2 rule while the photo size is unknown', () => {
    const [a] = photos();
    if (!a?.asset) throw new Error('no photo');
    const book = useBookStore.getState().book;
    useBookStore.setState({ book: book && { ...book, assets: { ...book.assets, [a.asset]: { path: 'x.jpg' } } } });
    actions().setCrop(page().id, a.id, { x: 0.9, y: -0.9, scale: 1.5 });
    expect(photos()[0]?.crop).toEqual({ x: 0.25, y: -0.25, scale: 1.5 });
  });

  it('keeps scan metadata out of history and across undo', () => {
    actions().setTitle('Edited');
    actions().fillAssets({ f1: { path: 'fixture/f1.jpg', hash: 'abc', width: 1200, height: 800 } });
    expect(history().pastStates).toHaveLength(1);
    undo();
    const book = useBookStore.getState().book;
    expect(book?.title).toBe(fixtureBook.title);
    expect(book?.assets.f1?.hash).toBe('abc');
  });

  it('keeps the UI page index and selection valid', () => {
    useUiStore.getState().setPageIndex(2);
    useUiStore.getState().select('p3-e1');
    actions().updatePage('p3', (p) => {
      p.elements = p.elements.filter((e) => e.id !== 'p3-e1');
    });
    expect(useUiStore.getState().selectedElementId).toBeNull();
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    useBookStore.setState({ book: { ...book, pages: book.pages.slice(0, 1) } });
    expect(useUiStore.getState().pageIndex).toBe(0);
  });
});

describe('autosave', () => {
  it('debounces edits into one write and skips unchanged books', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_folder: string, _json: string) => {});
    const stop = startAutosave({ write, delayMs: 500 });
    // A newly opened book is the saved state.
    load(structuredClone(fixtureBook), '/other');
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();

    actions().setTitle('One');
    await vi.advanceTimersByTimeAsync(200);
    actions().setTitle('Two');
    await vi.advanceTimersByTimeAsync(200);
    actions().setTitle('Three');
    expect(useUiStore.getState().saveStatus).toBe('dirty');
    await vi.advanceTimersByTimeAsync(499);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(write).toHaveBeenCalledWith('/other', serializeBook(book));
    expect(useUiStore.getState().saveStatus).toBe('saved');

    // Same reference: nothing to write.
    actions().setBook(book);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);

    // Undo back to the saved book after another edit: also nothing to write.
    actions().setTitle('Four');
    undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    stop();
  });

  it('flushes a pending change when the book closes', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_folder: string, _json: string) => {});
    const stop = startAutosave({ write, delayMs: 500 });
    load(structuredClone(fixtureBook), '/closing');
    actions().setTitle('Last edit');
    actions().close();
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('/closing');
    expect(write.mock.calls[0]?.[1]).toContain('"title": "Last edit"');
    stop();
  });

  it('close waits for the write of the open book to finish', async () => {
    let release = () => {};
    const write = vi.fn(
      (_folder: string, _json: string) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startAutosave({ write, delayMs: 500 });
    load(structuredClone(fixtureBook), '/closing');
    actions().setTitle('Unsaved');
    let closed = false;
    const closing = actions()
      .close()
      .then(() => {
        closed = true;
      });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    expect(useBookStore.getState().folder).toBe('/closing');
    release();
    await closing;
    expect(useBookStore.getState().book).toBeNull();
    expect(write).toHaveBeenCalledTimes(1);
    stop();
  });
});
