import {
  type Book,
  BookSchema,
  createDevelop,
  DevelopSchema,
  type PhotoElement,
  serializeBook,
  slotAspect,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampCrop, cropFit } from '../lib/crop';
import { cropFits } from '../lib/develop/geometry';
import { newAi, newMask } from '../lib/develop/masks';
import { startAutosave } from './autosave';
import {
  beginDevelopDrag,
  beginGesture,
  createIdleGesture,
  endDevelopDrag,
  endGesture,
  redo,
  undo,
  useBookStore,
} from './book';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();

/** Open `book` as project `projectId` (an opaque key for autosave; the folder path by default) on `folder`. */
function load(book: Book = structuredClone(fixtureBook), folder = '/photos', projectId = folder) {
  useBookStore.setState({ book, folder, projectId });
  history().clear();
}

const page = (i = 0) => {
  const p = useBookStore.getState().book?.pages[i];
  if (!p) throw new Error(`no page ${i}`);
  return p;
};
const photos = (i = 0) => page(i).elements.filter((e): e is PhotoElement => e.type === 'photo');
const actions = () => useBookStore.getState();

beforeEach(() => {
  load();
});
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
    expect(useBookStore.getState().book?.assets['new-asset']).toEqual({ path: 'new.jpg', folder: 'fixture-folder' });
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
    useBookStore.setState({
      book: book && { ...book, assets: { ...book.assets, [a.asset]: { path: 'x.jpg', folder: 'fixture-folder' } } },
    });
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

  it('sets and clears review ratings and flags outside history, and keeps them across undo', () => {
    actions().setTitle('Edited');
    actions().fillAssets({ f1: { path: 'fixture/f1.jpg', hash: 'abc' } });
    actions().reviewAssets([{ assetId: 'f1', path: 'fixture/f1.jpg' }], { rating: 4, flag: 'pick' });
    // A photo the scan has not recorded yet gets an entry with its path.
    actions().reviewAssets([{ assetId: 'new', path: 'fixture/new.jpg' }], { flag: 'reject', rating: 9 });
    expect(history().pastStates).toHaveLength(1);
    let assets = useBookStore.getState().book?.assets;
    expect(assets?.f1).toEqual({
      path: 'fixture/f1.jpg',
      folder: 'fixture-folder',
      hash: 'abc',
      rating: 4,
      flag: 'pick',
    });
    expect(assets?.new).toEqual({ path: 'fixture/new.jpg', folder: 'fixture-folder', rating: 5, flag: 'reject' });
    undo();
    assets = useBookStore.getState().book?.assets;
    expect(assets?.f1).toMatchObject({ rating: 4, flag: 'pick' });
    actions().reviewAssets([{ assetId: 'f1', path: 'fixture/f1.jpg' }], { flag: null });
    actions().reviewAssets([{ assetId: 'f1', path: 'fixture/f1.jpg' }], { rating: null });
    expect(useBookStore.getState().book?.assets.f1).toEqual({
      path: 'fixture/f1.jpg',
      folder: 'fixture-folder',
      hash: 'abc',
    });
    expect(() => BookSchema.parse(useBookStore.getState().book)).not.toThrow();
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

describe('develop settings', () => {
  const asset = (id = 'f1') => useBookStore.getState().book?.assets[id];
  const develop = (id = 'f1') => asset(id)?.develop;

  it('merges a patch into settings created from the defaults', () => {
    expect(develop()).toBeUndefined();
    actions().setAssetDevelop('f1', { light: { exposure: 0.5 } });
    expect(develop()?.light).toEqual({ ...createDevelop().light, exposure: 0.5 });
    // A second patch keeps the first; sibling keys of a nested patch survive.
    actions().setAssetDevelop('f1', { light: { contrast: 20 }, color: { mix: { red: { hue: -10 } } } });
    expect(develop()?.light).toMatchObject({ exposure: 0.5, contrast: 20 });
    expect(develop()?.color.mix.red).toEqual({ hue: -10, saturation: 0, luminance: 0 });
    expect(develop()?.color.mix.blue).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    // Arrays (curve points) are replaced whole.
    actions().setAssetDevelop('f1', {
      curve: {
        luma: [
          [0, 0],
          [0.5, 0.6],
          [1, 1],
        ],
      },
    });
    actions().setAssetDevelop('f1', {
      curve: {
        luma: [
          [0, 0.1],
          [1, 1],
        ],
      },
    });
    expect(develop()?.curve.luma).toEqual([
      [0, 0.1],
      [1, 1],
    ]);
    expect(() => DevelopSchema.parse(develop())).not.toThrow();
    expect(() => BookSchema.parse(useBookStore.getState().book)).not.toThrow();
  });

  it('accepts an updater function and ignores invalid or unknown targets', () => {
    actions().setAssetDevelop('f1', (prev) => ({ ...prev, light: { ...prev.light, whites: 12 } }));
    expect(develop()?.light.whites).toBe(12);
    const before = useBookStore.getState().book;
    actions().setAssetDevelop('f1', { light: { exposure: 99 } });
    actions().setAssetDevelop('nope', { light: { exposure: 1 } });
    expect(useBookStore.getState().book).toBe(before);
  });

  it('switches white balance modes without leftover keys', () => {
    actions().setAssetDevelop('f1', {
      light: { exposure: 1 },
      whiteBalance: { mode: 'incremental', temperature: 30, tint: -5 },
    });
    expect(develop()?.whiteBalance).toEqual({ mode: 'incremental', temperature: 30, tint: -5 });
    actions().setAssetDevelop('f1', { whiteBalance: { mode: 'asShot' } });
    expect(develop()?.whiteBalance).toEqual({ mode: 'asShot' });
    // Going back to as shot with nothing else edited is the default again.
    actions().setAssetDevelop('f1', { light: { exposure: 0 } });
    expect(asset()).not.toHaveProperty('develop');
  });

  it('removes the develop key when the settings come back to the defaults', () => {
    const untouched = serializeBook(useBookStore.getState().book as Book);
    actions().setAssetDevelop('f1', { light: { exposure: 1 } });
    expect(asset()).toHaveProperty('develop');
    actions().setAssetDevelop('f1', { light: { exposure: 0 } });
    expect(asset()).not.toHaveProperty('develop');
    expect(serializeBook(useBookStore.getState().book as Book)).toBe(untouched);
    // A patch that changes nothing on an unedited photo records nothing.
    history().clear();
    actions().setAssetDevelop('f1', { light: { exposure: 0 } });
    expect(history().pastStates).toHaveLength(0);
    expect(asset()).not.toHaveProperty('develop');
  });

  it('resets one section, several, or the whole photo', () => {
    actions().setAssetDevelop('f1', {
      light: { exposure: 1 },
      whiteBalance: { mode: 'incremental', temperature: 10, tint: 0 },
      color: { vibrance: 30 },
    });
    actions().resetDevelopSection('f1', 'light');
    expect(develop()?.light.exposure).toBe(0);
    expect(develop()?.color.vibrance).toBe(30);
    expect(develop()?.whiteBalance.mode).toBe('incremental');
    actions().resetDevelopSection('f1', ['whiteBalance', 'color']);
    // Everything is back to the defaults, so the key is gone.
    expect(asset()).not.toHaveProperty('develop');
    actions().setAssetDevelop('f1', { curve: { parametric: { shadows: 20 } }, light: { contrast: 5 } });
    actions().resetDevelopSection('f1', 'curve');
    expect(develop()?.curve.parametric.shadows).toBe(0);
    expect(develop()?.light.contrast).toBe(5);
    actions().resetAssetDevelop('f1');
    expect(asset()).not.toHaveProperty('develop');
    // Each reset is its own undo step.
    undo();
    expect(develop()?.light.contrast).toBe(5);
  });

  it('copies the default sections and pastes them, leaving geometry and masks, as one undo step', () => {
    expect(actions().copyDevelop('nope')).toBeNull();
    actions().setAssetDevelop('f1', {
      light: { exposure: 0.7, shadows: 25 },
      color: { saturation: -20 },
      curve: { parametric: { highlights: -30 } },
      geometry: { crop: { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } } },
    });
    actions().setAssetDevelop('f2', { geometry: { flipH: true } });
    const clip = actions().copyDevelop('f1');
    if (!clip) throw new Error('no clip');
    expect(clip.sections).toEqual(['basic', 'curve', 'color', 'detail', 'denoise', 'effects', 'look']);
    // The clip is a snapshot: later edits to the source do not leak into it.
    actions().setAssetDevelop('f1', { light: { exposure: -1 } });
    history().clear();
    expect(actions().pasteDevelop(['f2', 'f3', 'missing'], clip)).toBe(2);
    expect(history().pastStates).toHaveLength(1);
    expect(develop('f2')?.light).toMatchObject({ exposure: 0.7, shadows: 25 });
    expect(develop('f2')?.color.saturation).toBe(-20);
    expect(develop('f2')?.curve.parametric.highlights).toBe(-30);
    expect(develop('f2')?.geometry.flipH).toBe(true);
    expect(develop('f2')?.geometry.crop).toBeNull();
    expect(develop('f3')?.light.exposure).toBe(0.7);
    // Pasting the same thing again changes nothing.
    expect(actions().pasteDevelop(['f2'], clip)).toBe(0);
    undo();
    expect(develop('f2')?.light.exposure).toBe(0);
    expect(develop('f2')?.geometry.flipH).toBe(true);
    expect(develop('f3')).toBeUndefined();
    // Copying an unedited photo copies the defaults.
    const plain = actions().copyDevelop('f4');
    if (plain) actions().pasteDevelop(['f2'], plain);
    expect(develop('f2')?.light.exposure).toBe(0);
    expect(develop('f2')?.geometry.flipH).toBe(true);
  });

  it('pastes only the sections the clip lists: crop, masks with fresh ids, denoise apart from detail', () => {
    actions().setAssetDevelop('f1', {
      light: { exposure: 1 },
      detail: { clarity: 30, denoise: { model: 'nafnet-w32' } },
      geometry: { rotate: 90, crop: { rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, angle: 3 } },
    });
    actions().addMask('f1', newMask('Sky', newAi('sky')));
    actions().setAssetDevelop('f2', { detail: { clarity: -10 } });
    const clip = actions().copyDevelop('f1', ['crop', 'masks', 'denoise']);
    if (!clip) throw new Error('no clip');
    history().clear();
    expect(actions().pasteDevelop(['f2'], clip)).toBe(1);
    expect(history().pastStates).toHaveLength(1);
    const pasted = develop('f2');
    expect(pasted?.light.exposure).toBe(0);
    expect(pasted?.detail.clarity).toBe(-10);
    expect(pasted?.detail.denoise?.model).toBe('nafnet-w32');
    expect(pasted?.geometry.crop).toMatchObject({ rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, angle: 3 });
    // Rotation is never copied.
    expect(pasted?.geometry.rotate).toBe(0);
    const source = develop('f1');
    expect(pasted?.masks).toHaveLength(1);
    expect(pasted?.masks[0]?.id).not.toBe(source?.masks[0]?.id);
    expect(pasted?.masks[0]?.components[0]?.id).not.toBe(source?.masks[0]?.components[0]?.id);
  });

  it('fits a pasted crop to the target: a straightened landscape crop on a portrait photo', () => {
    const doc = structuredClone(fixtureBook);
    const [a, b] = [doc.assets.f1, doc.assets.f2];
    if (!a || !b) throw new Error('fixture assets');
    Object.assign(a, { width: 3000, height: 2000 });
    Object.assign(b, { width: 2000, height: 3000 });
    load(doc);
    actions().setAssetDevelop('f1', {
      geometry: { crop: { rect: { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }, angle: 8, aspect: [3, 2] } },
    });
    const clip = actions().copyDevelop('f1', ['crop']);
    if (!clip) throw new Error('no clip');
    expect(actions().pasteDevelop(['f2'], clip)).toBe(1);
    const crop = develop('f2')?.geometry.crop;
    if (!crop) throw new Error('no crop');
    expect(crop.angle).toBe(8);
    expect(crop.aspect).toEqual([3, 2]);
    // The 3:2 lock holds in the portrait frame's pixels, and the turned rect stays inside the picture.
    const ia = 2000 / 3000;
    expect((crop.rect.w * 2000) / (crop.rect.h * 3000)).toBeCloseTo(1.5, 9);
    expect(cropFits(crop.rect, crop.angle, ia)).toBe(true);
    // With constrain off it only stays inside the frame (and keeps the lock).
    actions().setAssetDevelop('f3', { geometry: { constrainCrop: false } });
    actions().pasteDevelop(['f3'], clip);
    expect(develop('f3')?.geometry.crop?.aspect).toEqual([3, 2]);
  });

  it('pasting masks twice changes nothing the second time, and the photo copied from is skipped', () => {
    actions().addMask('f1', newMask('Sky', newAi('sky')));
    actions().setAssetDevelop('f1', { light: { exposure: 0.3 } });
    const clip = actions().copyDevelop('f1', ['basic', 'masks']);
    if (!clip) throw new Error('no clip');
    history().clear();
    expect(actions().pasteDevelop(['f1', 'f2'], clip)).toBe(1);
    const once = develop('f2');
    expect(history().pastStates).toHaveLength(1);
    expect(actions().pasteDevelop(['f1', 'f2'], clip)).toBe(0);
    expect(history().pastStates).toHaveLength(1);
    expect(develop('f2')).toBe(once);
    // The source keeps its own mask ids (it was not pasted onto).
    expect(develop('f1')?.masks[0]?.id).toBe(clip.settings.masks[0]?.id);
    // A clip read from the clipboard text has no source: every photo given is a target.
    const { source: _, ...anonymous } = clip;
    expect(actions().pasteDevelop(['f1'], anonymous)).toBe(0);
  });

  it('pastes onto 20 photos as one undo step', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const doc = structuredClone(fixtureBook);
    const template = doc.assets.f1;
    if (!template) throw new Error('fixture asset');
    for (const id of ids)
      doc.assets[id] = { ...structuredClone(template), path: `fixture/${id}.jpg`, hash: `hash-${id}` };
    load(doc);
    actions().setAssetDevelop('f1', { light: { exposure: 0.4 }, color: { vibrance: 12 } });
    const clip = actions().copyDevelop('f1');
    if (!clip) throw new Error('no clip');
    history().clear();
    expect(actions().pasteDevelop(ids, clip)).toBe(20);
    expect(history().pastStates).toHaveLength(1);
    expect(ids.every((id) => develop(id)?.light.exposure === 0.4)).toBe(true);
    undo();
    expect(ids.every((id) => develop(id) === undefined)).toBe(true);
  });

  it('records a paused drag of five updates as a single undo step', () => {
    const exposures = [0.1, 0.2, 0.3, 0.4, 0.5];
    beginDevelopDrag();
    for (const exposure of exposures) actions().setAssetDevelop('f1', { light: { exposure } });
    expect(history().pastStates).toHaveLength(0);
    expect(develop()?.light.exposure).toBe(0.5);
    endDevelopDrag();
    expect(history().pastStates).toHaveLength(1);
    undo();
    expect(develop()).toBeUndefined();
    redo();
    expect(develop()?.light.exposure).toBe(0.5);
    // Outside a drag every update is a step of its own.
    actions().setAssetDevelop('f1', { light: { exposure: 0.6 } });
    actions().setAssetDevelop('f1', { light: { exposure: 0.7 } });
    expect(history().pastStates).toHaveLength(3);
    // A drag that ends where it began records nothing.
    history().clear();
    beginDevelopDrag();
    actions().setAssetDevelop('f1', { light: { exposure: 0.9 } });
    actions().setAssetDevelop('f1', { light: { exposure: 0.7 } });
    endDevelopDrag();
    expect(history().pastStates).toHaveLength(1);
  });

  it('undo and redo restore develop settings but keep newer scan metadata', () => {
    actions().setAssetDevelop('f1', { light: { exposure: 0.4 } });
    actions().fillAssets({ f1: { ...(asset() as NonNullable<ReturnType<typeof asset>>), hash: 'abc', width: 1200 } });
    undo();
    expect(develop()).toBeUndefined();
    expect(asset()).toMatchObject({ hash: 'abc', width: 1200 });
    redo();
    expect(develop()?.light.exposure).toBe(0.4);
    expect(asset()?.hash).toBe('abc');
  });

  it('fillAssets keeps the develop settings of a rewritten entry', () => {
    actions().setAssetDevelop('f1', { light: { exposure: 0.4 } });
    actions().fillAssets({ f1: { path: 'fixture/f1.jpg', hash: 'new-hash' } });
    expect(asset()).toMatchObject({ hash: 'new-hash' });
    expect(develop()?.light.exposure).toBe(0.4);
  });
});

describe('develop geometry', () => {
  // f1 is 1200 × 800 (frame aspect 1.5).
  const geometry = (id = 'f1') => useBookStore.getState().book?.assets[id]?.develop?.geometry;
  const crop = (id = 'f1') => geometry(id)?.crop ?? null;
  const near = (a: number | undefined, b: number) => expect(Math.abs((a ?? Number.NaN) - b)).toBeLessThan(1e-9);

  it('straightening an uncropped photo crops it to the largest level rect, and back to none at 0°', () => {
    actions().setCropAngle('f1', 10);
    const c = crop();
    expect(c?.angle).toBe(10);
    expect(c?.aspect).toBe('free');
    // Centred, the frame's aspect, strictly inside.
    near((c?.rect.x ?? 0) + (c?.rect.w ?? 0) / 2, 0.5);
    near(((c?.rect.w ?? 0) * 1.5) / (c?.rect.h ?? 1), 1.5);
    expect(c?.rect.w).toBeLessThan(1);
    actions().setCropAngle('f1', 0);
    expect(crop()).toBeNull();
    expect(useBookStore.getState().book?.assets.f1?.develop).toBeUndefined();
  });

  it('a manual crop shrinks with the angle and regrows within one drag; the drag is one undo step', () => {
    actions().setDevelopCrop('f1', { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' });
    history().clear();
    beginDevelopDrag();
    actions().setCropAngle('f1', 30);
    const shrunk = crop()?.rect;
    expect(shrunk?.w).toBeLessThan(0.5);
    actions().setCropAngle('f1', 0);
    // Measured from the crop at the start of the drag: back to the original rect.
    expect(crop()?.rect).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    actions().setCropAngle('f1', 5);
    endDevelopDrag();
    expect(history().pastStates).toHaveLength(1);
    expect(crop()?.angle).toBe(5);
    undo();
    expect(crop()?.angle).toBe(0);
  });

  it('constrain off leaves the rect alone; turning it on shrinks the rect into the rotated image', () => {
    actions().setDevelopCrop('f1', { rect: { x: 0, y: 0, w: 1, h: 1 }, angle: 0, aspect: 'original' });
    actions().setConstrainCrop('f1', false);
    actions().setCropAngle('f1', 20);
    expect(crop()?.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    actions().setConstrainCrop('f1', true);
    expect(geometry()?.constrainCrop).toBe(true);
    expect(crop()?.rect.w).toBeLessThan(1);
    near(((crop()?.rect.w ?? 0) * 1.5) / (crop()?.rect.h ?? 1), 1.5);
  });

  it('setCropAspect re-fits about the centre; free keeps the rect', () => {
    actions().setCropAspect('f1', [1, 1]);
    // A full-frame crop becomes the largest centred square.
    expect(crop()?.aspect).toEqual([1, 1]);
    near(crop()?.rect.h, 1);
    near((crop()?.rect.w ?? 0) * 1.5, 1);
    near((crop()?.rect.x ?? 0) + (crop()?.rect.w ?? 0) / 2, 0.5);
    const square = crop()?.rect;
    actions().setCropAspect('f1', 'free');
    expect(crop()?.rect).toEqual(square);
    expect(crop()?.aspect).toBe('free');
    // A smaller crop keeps its centre and area.
    actions().setDevelopCrop('f1', { rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.6 }, angle: 0, aspect: 'free' });
    actions().setCropAspect('f1', [16, 9]);
    const r = crop()?.rect;
    near((r?.x ?? 0) + (r?.w ?? 0) / 2, 0.4);
    near((r?.y ?? 0) + (r?.h ?? 0) / 2, 0.5);
    near(((r?.w ?? 0) * 1.5) / (r?.h ?? 1), 16 / 9);
    near((r?.w ?? 0) * 1.5 * (r?.h ?? 0), 0.4 * 1.5 * 0.6);
  });

  it('swapCropOrientation turns the lock and the frame', () => {
    actions().setCropAspect('f1', [3, 2]);
    actions().swapCropOrientation('f1');
    expect(crop()?.aspect).toEqual([2, 3]);
    near(((crop()?.rect.w ?? 0) * 1.5) / (crop()?.rect.h ?? 1), 2 / 3);
    near(crop()?.rect.h, 1);
  });

  it('rotate90 turns the frame, remaps the crop and swaps a ratio lock; four turns are the identity', () => {
    const start = { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, angle: 3, aspect: [4, 5] as [number, number] };
    actions().setDevelopCrop('f1', start);
    actions().rotate90('f1', 1);
    expect(geometry()?.rotate).toBe(90);
    const c = crop();
    near(c?.rect.x, 1 - 0.6);
    near(c?.rect.y, 0.1);
    near(c?.rect.w, 0.4);
    near(c?.rect.h, 0.3);
    expect(c?.aspect).toEqual([5, 4]);
    expect(c?.angle).toBe(3);
    actions().rotate90('f1', -1);
    expect(geometry()?.rotate).toBe(0);
    for (let i = 0; i < 4; i++) actions().rotate90('f1', 1);
    near(crop()?.rect.x, 0.1);
    near(crop()?.rect.y, 0.2);
    expect(crop()?.aspect).toEqual([4, 5]);
    // With one flip on, a clockwise turn on screen is a counter-clockwise rotate.
    actions().flip('f1', 'h');
    actions().rotate90('f1', 1);
    expect(geometry()?.rotate).toBe(270);
  });

  it('flip mirrors the crop and negates the angle; each button press is one undo step', () => {
    actions().setDevelopCrop('f1', { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, angle: 2, aspect: 'free' });
    history().clear();
    actions().flip('f1', 'h');
    expect(geometry()?.flipH).toBe(true);
    near(crop()?.rect.x, 0.6);
    expect(crop()?.angle).toBe(-2);
    actions().flip('f1', 'v');
    expect(geometry()?.flipV).toBe(true);
    near(crop()?.rect.y, 0.4);
    expect(crop()?.angle).toBe(2);
    expect(history().pastStates).toHaveLength(2);
  });

  it('resetGeometry and setGeometry replace the whole geometry; other settings stay', () => {
    actions().setAssetDevelop('f1', { light: { exposure: 1 } });
    const before = structuredClone(geometry());
    actions().rotate90('f1', 1);
    actions().setCropAngle('f1', 4);
    actions().setGeometry('f1', before as NonNullable<typeof before>);
    expect(geometry()).toEqual(before);
    actions().flip('f1', 'v');
    actions().resetGeometry('f1');
    expect(geometry()).toEqual(createDevelop().geometry);
    expect(useBookStore.getState().book?.assets.f1?.develop?.light.exposure).toBe(1);
  });

  it('uses an explicit source size when the asset has none', () => {
    const book = structuredClone(fixtureBook);
    const f1 = book.assets.f1;
    if (f1) {
      delete f1.width;
      delete f1.height;
    }
    load(book);
    actions().setCropAspect('f1', [1, 1], { width: 400, height: 200 });
    near((crop()?.rect.w ?? 0) * 2, crop()?.rect.h ?? 0);
  });
});
