import {
  type Book,
  BookSchema,
  type Frame,
  LAYOUT_CUSTOM,
  type Page,
  type PhotoElement,
  resolveTheme,
  spacing,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampCrop, cropFit } from '../lib/crop';
import { pageToLayoutData } from '../lib/frames';
import { undo, useBookStore } from './book';
import { isRatioLocked, useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();
const actions = () => useBookStore.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const page = (i = 0): Page => {
  const p = book().pages[i];
  if (!p) throw new Error(`no page ${i}`);
  return p;
};
const photos = (i = 0) => page(i).elements.filter((e): e is PhotoElement => e.type === 'photo');
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);
const valid = () => expect(() => BookSchema.parse(book())).not.toThrow();

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('frame store actions', () => {
  it('addFrameGrid 3 x 2 inside the margins: six frames, equal gutters, filled photos poured in', () => {
    const before = photos();
    const texts = page().elements.filter((e) => e.type === 'text');
    const ids = actions().addFrameGrid(page().id, { cols: 3, rows: 2 });
    expect(ids).toHaveLength(6);
    const frames = photos().map((e) => e.frame);
    const theme = resolveTheme(book().theme);
    const s = spacing(theme.margin, theme.gutter, book().template.width / book().template.height);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const a = frames[r * 3 + c] as Frame;
        const b = frames[r * 3 + c + 1] as Frame;
        close(b.x - (a.x + a.w), s.gx);
      }
    }
    close((frames[3] as Frame).y - ((frames[0] as Frame).y + (frames[0] as Frame).h), s.gy);
    close((frames[0] as Frame).x, s.mx);
    close((frames[0] as Frame).y, s.my);
    // The three filled photos keep their ids and assets, in order; the rest are empty.
    expect(
      photos()
        .slice(0, 3)
        .map((e) => [e.id, e.asset]),
    ).toEqual(before.map((e) => [e.id, e.asset]));
    expect(
      photos()
        .slice(3)
        .every((e) => e.asset === null),
    ).toBe(true);
    // Text stays, after the photos.
    expect(page().elements.slice(6)).toEqual(texts);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    for (const el of photos()) expect(el.crop).toEqual(clampCrop(el.crop, cropFit(book(), el)));
    valid();
    expect(history().pastStates).toHaveLength(1);
    // A second grid replaces the empty frames instead of adding more.
    actions().addFrameGrid(page().id, { cols: 2, rows: 1 });
    expect(photos()).toHaveLength(2);
  });

  it('mergeFrames keeps the first filled photo at the bounding box of the selection', () => {
    actions().addFrameGrid(page().id, { cols: 2, rows: 2 });
    // Empty the first cell so the first filled one is the second.
    actions().deleteElements(page().id, [photos()[0]?.id ?? '']);
    const [a, b, c] = photos() as [PhotoElement, PhotoElement, PhotoElement];
    expect(a.asset).toBeNull();
    const keepAsset = b.asset;
    const id = actions().mergeFrames(page().id, [c.id, a.id, b.id]);
    expect(id).toBe(b.id);
    const merged = photos().find((e) => e.id === id);
    expect(merged?.asset).toBe(keepAsset);
    expect(photos()).toHaveLength(2);
    close(merged?.frame.x ?? -1, a.frame.x);
    close(merged?.frame.y ?? -1, a.frame.y);
    close((merged?.frame.x ?? 0) + (merged?.frame.w ?? 0), b.frame.x + b.frame.w);
    close((merged?.frame.y ?? 0) + (merged?.frame.h ?? 0), c.frame.y + c.frame.h);
    expect(actions().mergeFrames(page().id, [b.id])).toBeNull();
    valid();
  });

  it('splitFrame makes two frames with a gutter; the photo stays in the first', () => {
    actions().addFrame(page(1).id, { x: 0.1, y: 0.1, w: 0.8, h: 0.6 });
    const el = photos(1).at(-1) as PhotoElement;
    const original = el.frame;
    const theme = resolveTheme(book().theme);
    const s = spacing(theme.margin, theme.gutter, book().template.width / book().template.height);

    const ids = actions().splitFrame(page(1).id, el.id, 'vertical');
    if (!ids) throw new Error('not split');
    const [left, right] = ids.map((id) => photos(1).find((e) => e.id === id)) as [PhotoElement, PhotoElement];
    expect(left.id).toBe(el.id);
    close(right.frame.x - (left.frame.x + left.frame.w), s.gx);
    close(left.frame.w, right.frame.w);
    close(right.frame.x + right.frame.w, original.x + original.w);
    expect(right.frame.h).toBe(original.h);

    const filled = photos(0)[0] as PhotoElement;
    const rows = actions().splitFrame(page(0).id, filled.id, 'horizontal');
    if (!rows) throw new Error('not split');
    const [top, bottom] = rows.map((id) => photos(0).find((e) => e.id === id)) as [PhotoElement, PhotoElement];
    expect(top.asset).toBe(filled.asset);
    expect(bottom.asset).toBeNull();
    close(bottom.frame.y - (top.frame.y + top.frame.h), s.gy);
    expect(page(0).layout).toBe(LAYOUT_CUSTOM);
    valid();
  });

  it('addFrame adds an empty frame below the text, marks the page custom; Delete empties then removes', () => {
    const id = actions().addFrame(page().id, { x: 0.2, y: 0.2, w: 0.3, h: 0.3 });
    if (!id) throw new Error('no frame');
    const index = page().elements.findIndex((e) => e.id === id);
    expect(index).toBe(3); // after the three photos, before the two text boxes
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    actions().deleteElements(page().id, [id]);
    expect(page().elements.some((e) => e.id === id)).toBe(false);
    const filled = photos()[0] as PhotoElement;
    actions().deleteElements(page().id, [filled.id]);
    expect(photos()[0]?.asset).toBeNull();
    actions().deleteElements(page().id, [filled.id]);
    expect(page().elements.some((e) => e.id === filled.id)).toBe(false);
    undo();
    expect(page().elements.some((e) => e.id === filled.id)).toBe(true);
  });

  it('setFrames re-clamps photo crops', () => {
    const el = photos()[0] as PhotoElement;
    actions().setCrop(page().id, el.id, { x: 10, y: 10, scale: 2 });
    actions().setFrames(page().id, { [el.id]: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 } });
    const after = photos()[0] as PhotoElement;
    expect(after.frame).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.2 });
    expect(after.crop).toEqual(clampCrop(after.crop, cropFit(book(), after)));
  });

  it('save as layout: addCustomLayout, apply from the Custom group, rename, remove', () => {
    const saved = pageToLayoutData(page(), 'Mine');
    if (!saved) throw new Error('not saved');
    const id = actions().addCustomLayout(saved, page().id);
    if (!id) throw new Error('not added');
    expect(id).toMatch(/^custom-[0-9A-Z]{26}$/);
    const data = { ...saved, id };
    // Every add gets a fresh id, so the same data can never clash with an existing layout.
    const again = actions().addCustomLayout(saved);
    expect(again).not.toBe(id);
    expect(book().customLayouts.map((l) => l.id)).toEqual([id, again]);
    expect(page().layout).toBe(id);
    valid();
    undo();
    expect(book().customLayouts.map((l) => l.id)).toEqual([id]);

    // Apply it to the full-bleed page: the frames come back.
    actions().applyLayout(page(1).id, data.id);
    expect(page(1).elements.map((e) => e.type)).toEqual(page(0).elements.map((e) => e.type));
    page(1).elements.forEach((e, i) => {
      const want = page(0).elements[i]?.frame as Frame;
      for (const k of ['x', 'y', 'w', 'h'] as const) close(e.frame[k], want[k]);
    });

    actions().renameCustomLayout(data.id, ' Renamed ');
    expect(book().customLayouts[0]?.name).toBe('Renamed');
    actions().removeCustomLayout(data.id);
    expect(book().customLayouts).toEqual([]);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    undo();
    expect(book().customLayouts[0]?.name).toBe('Renamed');
  });
});

describe('selection and ratio lock (ui store)', () => {
  it('Shift+click builds a multi-selection with the last one as primary', () => {
    const ui = useUiStore.getState;
    ui().select('p1-e1');
    ui().toggleSelection('p1-e2');
    expect(ui()).toMatchObject({ selectedElementIds: ['p1-e1', 'p1-e2'], selectedElementId: 'p1-e2' });
    ui().toggleSelection('p1-e2');
    expect(ui()).toMatchObject({ selectedElementIds: ['p1-e1'], selectedElementId: 'p1-e1' });
    ui().toggleSelection('p1-e3');
    // Deleting a selected element drops it from the selection.
    actions().removeElement(page().id, 'p1-e3');
    expect(ui()).toMatchObject({ selectedElementIds: ['p1-e1'], selectedElementId: 'p1-e1' });
    ui().select(null);
    expect(ui().selectedElementIds).toEqual([]);
  });

  it('locks photos and frees text by default; the inspector choice wins', () => {
    const ui = useUiStore.getState;
    expect(isRatioLocked(ui(), { id: 'a', type: 'photo' })).toBe(true);
    expect(isRatioLocked(ui(), { id: 'b', type: 'text' })).toBe(false);
    ui().setRatioLock('a', false);
    ui().setRatioLock('b', true);
    expect(isRatioLocked(ui(), { id: 'a', type: 'photo' })).toBe(false);
    expect(isRatioLocked(ui(), { id: 'b', type: 'text' })).toBe(true);
  });
});
