import {
  type Book,
  BookSchema,
  type Frame,
  getLayout,
  LAYOUT_BLANK,
  LAYOUT_CUSTOM,
  type LayoutData,
  layoutFrames,
  type Page,
  type PhotoElement,
  resolveTheme,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFrameMove } from '../components/editor/frameMove';
import { undo, useBookStore } from './book';
import { useUiStore } from './ui';

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
const LIB_LAYOUT = '3-hero-over-two';

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
  actions().applyLayout(page().id, LIB_LAYOUT);
});
afterEach(() => useBookStore.getState().close());

describe('hand edits mark the page custom', () => {
  it('setFrames (resize, nudge, inspector) marks the page custom only when a frame changes', () => {
    const el = photos()[0] as PhotoElement;
    actions().setFrames(page().id, { [el.id]: { ...el.frame } });
    expect(page().layout).toBe(LIB_LAYOUT);
    actions().setFrames(page().id, { [el.id]: { ...el.frame, x: el.frame.x + 0.01 } });
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    undo();
    expect(page().layout).toBe(LIB_LAYOUT);
  });

  it('a frame move drag goes through setFrames and marks the page custom', () => {
    const el = photos()[0] as PhotoElement;
    useUiStore.getState().setPref('snapEnabled', false);
    // Node has no window: an EventTarget stands in for the pointer listeners.
    vi.stubGlobal('window', new EventTarget());
    const pointer = (type: string, clientX = 0, clientY = 0) =>
      Object.assign(new Event(type), { clientX, clientY, metaKey: false });
    try {
      startFrameMove({
        pageId: page().id,
        elementId: el.id,
        clientX: 0,
        clientY: 0,
        pageRect: { width: 500, height: 625 },
      });
      window.dispatchEvent(pointer('pointermove', 20, 0));
      window.dispatchEvent(pointer('pointerup'));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(photos()[0]?.frame.x).toBeCloseTo(el.frame.x + 20 / 500, 5);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
  });

  it('addText, removeElement and deleteElements mark the page custom', () => {
    actions().addText(page().id);
    expect(page().layout).toBe(LAYOUT_CUSTOM);

    // Re-applying drops the new (empty) caption and keeps the fixture's extra text.
    actions().applyLayout(page().id, LIB_LAYOUT);
    expect(page().layout).toBe(LIB_LAYOUT);
    const text = page().elements.find((e) => e.type === 'text');
    if (!text) throw new Error('no text');
    actions().removeElement(page().id, text.id);
    expect(page().layout).toBe(LAYOUT_CUSTOM);

    actions().applyLayout(page().id, LIB_LAYOUT);
    const filled = photos()[0] as PhotoElement;
    // Emptying a filled frame is not a layout change.
    actions().deleteElements(page().id, [filled.id]);
    expect(page().layout).toBe(LIB_LAYOUT);
    actions().deleteElements(page().id, [filled.id]);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
  });

  it('a circle shape squares the frame and marks the page custom', () => {
    const el = photos()[0] as PhotoElement;
    actions().setShape(page().id, el.id, { kind: 'ellipse' });
    expect(page().layout).toBe(LIB_LAYOUT);
    actions().setShape(page().id, el.id, { kind: 'circle' });
    expect(page().layout).toBe(LAYOUT_CUSTOM);
  });
});

describe('reapplyLayouts is geometry-only', () => {
  it('re-fits library pages to the new margin and skips hand-edited pages', () => {
    const edited = photos()[1] as PhotoElement;
    actions().setFrames(page().id, { [edited.id]: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 } });
    actions().applyLayout(page(1).id, LIB_LAYOUT);
    actions().setTheme({ margin: 0.12 });
    const before = book();
    expect(actions().reapplyLayouts()).toBeGreaterThan(0);
    // The hand-edited page is untouched.
    expect(page(0)).toBe(before.pages[0]);
    const def = getLayout(LIB_LAYOUT);
    if (!def) throw new Error('missing layout');
    const { slots } = layoutFrames(def, resolveTheme(book().theme), book().template);
    photos(1).forEach((p, i) => {
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(p.frame[k]).toBeCloseTo((slots[i] as Frame)[k], 9);
    });
    expect(() => BookSchema.parse(book())).not.toThrow();
  });

  it('keeps extra text, never restores deleted frames and never reorders', () => {
    const p = page(1);
    actions().applyLayout(p.id, LIB_LAYOUT);
    // A deleted empty frame stays deleted (the page is now custom and skipped) ...
    const empty = page(1).elements.find((e) => e.type === 'photo' && e.asset === null);
    if (empty) {
      actions().deleteElements(p.id, [empty.id]);
      actions().setTheme({ gutter: 0.05 });
      actions().reapplyLayouts();
      expect(page(1).elements.some((e) => e.id === empty.id)).toBe(false);
    }
    // ... and on a page that still follows its layout, extra text stays where it is.
    actions().applyLayout(p.id, LIB_LAYOUT);
    const extra = {
      type: 'text' as const,
      id: 'extra',
      text: 'Hand-placed',
      style: 'caption' as const,
      frame: { x: 0.2, y: 0.2, w: 0.3, h: 0.05 },
      align: 'left' as const,
    };
    actions().updatePage(p.id, (d) => {
      d.elements.push(extra);
    });
    const ids = page(1).elements.map((e) => e.id);
    actions().setTheme({ margin: 0.1 });
    actions().reapplyLayouts();
    expect(page(1).layout).toBe(LIB_LAYOUT);
    expect(page(1).elements.map((e) => e.id)).toEqual(ids);
    expect(page(1).elements.find((e) => e.id === 'extra')).toEqual(extra);
  });

  it('skips blank pages', () => {
    const id = actions().addPage() ?? '';
    actions().setTheme({ margin: 0.1 });
    actions().reapplyLayouts();
    const blank = book().pages.find((x) => x.id === id);
    expect(blank).toMatchObject({ layout: LAYOUT_BLANK, elements: [] });
  });
});

describe('setSlotRatio and custom layouts', () => {
  it('uses the custom layout slot as the reference box', () => {
    const custom: LayoutData = {
      id: 'custom-x',
      name: 'Mine',
      photos: 1,
      group: 'custom',
      source: 'custom',
      items: [{ kind: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.4 }],
    };
    useBookStore.setState((s) => {
      if (s.book) s.book.customLayouts = [custom];
    });
    actions().applyLayout(page(1).id, 'custom-x');
    const el = photos(1)[0] as PhotoElement;
    // Shrink it first: without the layout as reference the next ratio would only fit the small frame.
    actions().setSlotRatio(page(1).id, el.id, '1:1');
    actions().setSlotRatio(page(1).id, el.id, '3:2');
    const f = photos(1)[0]?.frame as Frame;
    const { width, height } = book().template;
    expect((f.w * width) / (f.h * height)).toBeCloseTo(1.5, 6);
    // 3:2 inside the 0.8 x 0.4 slot (4:5 page) is height-bound: full slot height.
    expect(f.h).toBeCloseTo(0.4, 6);
  });
});
