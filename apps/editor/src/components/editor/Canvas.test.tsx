// @vitest-environment jsdom
import { type Frame, LAYOUT_CUSTOM, type PhotoElement, pagesOf, resolveTheme } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redo, undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));

const { Canvas } = await import('./Canvas');
const { EditorDnd } = await import('./EditorDnd');
const { useEditorShortcuts } = await import('./useEditorShortcuts');
const { useSpacingHint } = await import('./frameActions');

function Shell() {
  useEditorShortcuts();
  return (
    <EditorDnd>
      <Canvas />
    </EditorDnd>
  );
}

const ui = () => useUiStore.getState();
const filled = (): PhotoElement => {
  const book = useBookStore.getState().book;
  const page = book ? pagesOf(book, ui().design.outputId)[0] : undefined;
  const el = page?.elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
  if (!el) throw new Error('no filled photo');
  return el;
};
const slot = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`.pb-page [data-element-id="${id}"]`);
  if (!node) throw new Error(`no slot ${id}`);
  return node;
};

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('Canvas: Adjust photo mode', () => {
  it('double-click enters it (dashed outline, hint, pressed toolbar button); Escape leaves', () => {
    render(<Shell />);
    const el = filled();
    fireEvent.doubleClick(slot(el.id));
    expect(ui().canvas.adjusting).toBe(el.id);
    expect(ui().selectedElementIds).toEqual([el.id]);
    expect(screen.getByText(/Adjust photo: drag to pan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Adjust photo' }).getAttribute('aria-pressed')).toBe('true');
    // No resize handles while adjusting.
    expect(document.querySelector('[data-resize-handle]')).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(ui().canvas.adjusting).toBeNull();
    // The frame stays selected, with its handles back.
    expect(ui().selectedElementIds).toEqual([el.id]);
    expect(document.querySelector('[data-resize-handle]')).not.toBeNull();
  });

  it('the toolbar button toggles it, and a press on the background leaves it', () => {
    render(<Shell />);
    const el = filled();
    act(() => ui().select(el.id));
    fireEvent.click(screen.getByRole('button', { name: 'Adjust photo' }));
    expect(ui().canvas.adjusting).toBe(el.id);
    fireEvent.pointerDown(document.querySelector('main') as HTMLElement);
    expect(ui().canvas.adjusting).toBeNull();
    expect(ui().selectedElementId).toBeNull();
  });

  it('a double-click on a text box edits it instead', () => {
    render(<Shell />);
    const text = document.querySelector<HTMLElement>('.pb-page [data-element-type="text"]');
    if (!text) throw new Error('no text box');
    fireEvent.doubleClick(text);
    expect(ui().editingTextId).toBe(text.dataset.elementId);
    expect(ui().canvas.adjusting).toBeNull();
  });
});

describe('Canvas: pointer and key wiring', () => {
  const RECT = { x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 625, width: 500, height: 625 };
  const photos = () => {
    const book = useBookStore.getState().book;
    const page = book ? pagesOf(book, ui().design.outputId)[0] : undefined;
    return page?.elements.filter((e): e is PhotoElement => e.type === 'photo' && e.asset !== null) ?? [];
  };
  const byId = (id: string) => photos().find((e) => e.id === id) as PhotoElement;
  const main = () => document.querySelector('main') as HTMLElement;
  /** Press on a slot, move the pointer (x, y) px with the button held, release. */
  function drag(id: string, x: number, y: number, keys: { shiftKey?: boolean; altKey?: boolean } = {}) {
    fireEvent.pointerDown(slot(id), { button: 0, buttons: 1, clientX: 100, clientY: 100, ...keys });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100 + x, clientY: 100 + y, ...keys });
    fireEvent.pointerUp(window, { button: 0, buttons: 0, clientX: 100 + x, clientY: 100 + y });
  }

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...RECT, toJSON: () => RECT } as DOMRect);
    useUiStore.getState().setPref('snapEnabled', false);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a plain drag selects a filled photo frame and moves it, leaving the crop alone', () => {
    render(<Shell />);
    const el = filled();
    drag(el.id, 25, 0);
    expect(ui().selectedElementIds).toEqual([el.id]);
    expect(byId(el.id).frame.x).toBeCloseTo(el.frame.x + 25 / 500, 6);
    expect(byId(el.id).crop).toEqual(el.crop);
  });

  it('in Adjust photo a drag pans the photo and leaves the frame', () => {
    render(<Shell />);
    const el = filled();
    act(() => ui().setAdjusting(el.id));
    drag(el.id, 25, 0);
    expect(byId(el.id).frame).toEqual(el.frame);
    expect(byId(el.id).crop).not.toEqual(el.crop);
    expect(ui().canvas.adjusting).toBe(el.id);
  });

  it('Space + drag pans the selected photo without entering the mode', () => {
    render(<Shell />);
    const el = filled();
    act(() => ui().select(el.id));
    fireEvent.keyDown(window, { key: ' ' });
    drag(el.id, 25, 0);
    fireEvent.keyUp(window, { key: ' ' });
    expect(byId(el.id).frame).toEqual(el.frame);
    expect(byId(el.id).crop).not.toEqual(el.crop);
    expect(ui().canvas.adjusting).toBeNull();
    // Space released: a drag moves again.
    drag(el.id, 25, 0);
    expect(byId(el.id).frame.x).toBeCloseTo(el.frame.x + 25 / 500, 6);
  });

  it('the wheel zooms the photo only in Adjust photo; a pinch outside it zooms the canvas', () => {
    render(<Shell />);
    const el = filled();
    fireEvent.wheel(slot(el.id), { deltaY: -100 });
    expect(byId(el.id).crop.scale).toBe(el.crop.scale);
    fireEvent.wheel(slot(el.id), { deltaY: -10, ctrlKey: true });
    expect(byId(el.id).crop.scale).toBe(el.crop.scale);
    expect(ui().zoom).not.toBe('fit');

    act(() => ui().setAdjusting(el.id));
    fireEvent.wheel(slot(el.id), { deltaY: -100 });
    expect(byId(el.id).crop.scale).toBeGreaterThan(el.crop.scale);
  });

  it('arrow keys on the canvas nudge the selection one grid step', () => {
    render(<Shell />);
    const el = filled();
    act(() => ui().select(el.id));
    fireEvent.keyDown(main(), { key: 'ArrowDown' });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    const stepY = (resolveTheme(book.theme).grid * book.template.width) / book.template.height;
    expect(byId(el.id).frame.y).toBeCloseTo(el.frame.y + stepY, 9);
  });

  it('Shift+click builds a selection and leaves frames where they are', () => {
    render(<Shell />);
    const [a, b] = photos();
    if (!a || !b) throw new Error('need two photos');
    fireEvent.pointerDown(slot(a.id), { button: 0, buttons: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { button: 0, buttons: 0 });
    drag(b.id, 25, 0, { shiftKey: true });
    expect(ui().selectedElementIds).toEqual([a.id, b.id]);
    expect(byId(b.id).frame).toEqual(b.frame);
  });

  it('Alt + drag hands the photo to the slot drag: no move, no pan', () => {
    render(<Shell />);
    const el = filled();
    drag(el.id, 25, 0, { altKey: true });
    expect(ui().selectedElementIds).toEqual([el.id]);
    expect(byId(el.id).frame).toEqual(el.frame);
    expect(byId(el.id).crop).toEqual(el.crop);
  });

  it('a press outside the canvas leaves Adjust photo, and so does unmounting it', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    const { unmount } = render(<Shell />);
    const el = filled();
    act(() => ui().setAdjusting(el.id));
    fireEvent.pointerDown(outside);
    expect(ui().canvas.adjusting).toBeNull();
    expect(ui().selectedElementIds).toEqual([el.id]);
    act(() => ui().setAdjusting(el.id));
    unmount();
    expect(ui().canvas.adjusting).toBeNull();
    outside.remove();
  });

  it('a different photo dropped on the adjusted frame leaves the mode', () => {
    render(<Shell />);
    const [a, b] = photos();
    if (!a?.asset || !b?.asset) throw new Error('need two photos');
    act(() => ui().setAdjusting(a.id));
    act(() => useBookStore.getState().setElementAsset(useBookStore.getState().book?.pages[0]?.id ?? '', a.id, b.asset));
    expect(ui().canvas.adjusting).toBeNull();
  });
});

describe('Canvas: smart guides, multi-selection and alignment (workflow plan 30)', () => {
  const RECT = { x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 625, width: 500, height: 625 };
  /** Three photo frames in a rough row on page 1 (default theme, so the gutter is 0.025 of the width). */
  const ROW = {
    a: { x: 0.08, y: 0.3, w: 0.2, h: 0.3 },
    b: { x: 0.36, y: 0.3, w: 0.2, h: 0.3 },
    c: { x: 0.72, y: 0.3, w: 0.2, h: 0.3 },
  };
  function loadRow(frames: Record<string, Frame> = ROW) {
    const book = structuredClone(fixtureBook);
    const first = book.pages[0];
    if (!first) throw new Error('no page');
    book.theme = resolveTheme({});
    first.layout = LAYOUT_CUSTOM;
    first.elements = Object.entries(frames).map(([id, frame], i) => ({
      type: 'photo',
      id,
      asset: `f${i + 1}`,
      frame,
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    }));
    useBookStore.setState({ book, folder: '/photos' });
    useBookStore.temporal.getState().clear();
  }
  const frameOf = (id: string): Frame => {
    const el = useBookStore.getState().book?.pages[0]?.elements.find((e) => e.id === id);
    if (!el) throw new Error(`no element ${id}`);
    return el.frame;
  };
  const history = () => useBookStore.temporal.getState().pastStates.length;
  const press = (id: string, keys: { shiftKey?: boolean } = {}) =>
    fireEvent.pointerDown(slot(id), { button: 0, buttons: 1, clientX: 100, clientY: 100, ...keys });
  const moveTo = (x: number, y: number) => fireEvent.pointerMove(window, { buttons: 1, clientX: x, clientY: y });
  const release = () => fireEvent.pointerUp(window, { button: 0, buttons: 0 });

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...RECT, toJSON: () => RECT } as DOMRect);
    useUiStore.setState({ zoom: 1, snapEnabled: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the equal-spacing guides while the middle of three frames is dragged', () => {
    loadRow();
    render(<Shell />);
    press('b');
    // 21 px of 500 = 0.042: the middle frame's left edge at 0.402, near the equal spot 0.28 + 0.12.
    moveTo(121, 100);
    expect(frameOf('b').x).toBeCloseTo(0.4, 6);
    expect(document.querySelector('[data-guide-kind="equal"]')).not.toBeNull();
    const badges = [...document.querySelectorAll('[data-badge-kind="equal"]')].map((n) => n.textContent);
    expect(badges).toEqual(['equal · 0.96 in', 'equal · 0.96 in']);
    release();
    expect(document.querySelector('[data-guide-kind="equal"]')).toBeNull();
  });

  it('a drag on a member of a multi-selection moves the whole selection in one undo step', () => {
    loadRow();
    useUiStore.setState({ snapEnabled: false });
    render(<Shell />);
    act(() => ui().selectMany(['a', 'b']));
    press('a');
    moveTo(125, 100);
    release();
    expect(ui().selectedElementIds).toEqual(['a', 'b']);
    expect(frameOf('a').x).toBeCloseTo(ROW.a.x + 0.05, 6);
    expect(frameOf('b').x).toBeCloseTo(ROW.b.x + 0.05, 6);
    expect(frameOf('c')).toEqual(ROW.c);
    expect(history()).toBe(1);
    // A click (no drag) on a member selects it alone.
    press('b');
    release();
    expect(ui().selectedElementIds).toEqual(['b']);
  });

  it('a multi-selection snaps its bounding box and stops at the page edge as a block', () => {
    loadRow();
    render(<Shell />);
    act(() => ui().selectMany(['a', 'b']));
    press('a');
    // Far to the left: the block stops when a reaches the bleed (photos may run 0.0125 past the trim).
    moveTo(-400, 100);
    release();
    const shift = frameOf('a').x - ROW.a.x;
    expect(frameOf('a').x).toBeCloseTo(-resolveTheme({}).bleed, 6);
    expect(frameOf('b').x - ROW.b.x).toBeCloseTo(shift, 6);
  });

  it('shows the alignment toolbar on a multi-selection; each action is one undo step', () => {
    const frames = {
      a: { x: 0.08, y: 0.3, w: 0.2, h: 0.3 },
      b: { x: 0.33, y: 0.32, w: 0.15, h: 0.25 },
      c: { x: 0.62, y: 0.28, w: 0.3, h: 0.32 },
    };
    const labels = [
      'Align left',
      'Align centre',
      'Align right',
      'Align top',
      'Align middle',
      'Align bottom',
      'Distribute horizontally',
      'Match width (of the last selected)',
      'Match height (of the last selected)',
      'Tidy: equal gaps on each row, on the gutter',
    ];
    loadRow(frames);
    render(<Shell />);
    expect(screen.queryByRole('toolbar', { name: 'Align' })).toBeNull();
    act(() => ui().selectMany(['a', 'b', 'c']));
    expect(screen.getByRole('toolbar', { name: 'Align' })).toBeTruthy();
    for (const label of labels) {
      act(() => loadRow(frames));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect([label, history()]).toEqual([label, 1]);
      const moved = ['a', 'b', 'c'].some((id) => JSON.stringify(frameOf(id)) !== JSON.stringify(frames[id as 'a']));
      expect([label, moved]).toEqual([label, true]);
      act(() => {
        undo();
      });
      for (const id of ['a', 'b', 'c'] as const) expect(frameOf(id)).toEqual(frames[id]);
    }
    // The three overlap vertically (one row): distributing them vertically has no order, so nothing moves.
    act(() => loadRow(frames));
    fireEvent.click(screen.getByRole('button', { name: 'Distribute vertically' }));
    expect(history()).toBe(0);
    // Tidy put the row on equal gaps.
    act(() => loadRow(frames));
    fireEvent.click(screen.getByRole('button', { name: 'Tidy: equal gaps on each row, on the gutter' }));
    const gaps = [frameOf('b').x - (frameOf('a').x + 0.2), frameOf('c').x - (frameOf('b').x + 0.15)];
    expect(Math.abs((gaps[0] ?? 0) - (gaps[1] ?? 0))).toBeLessThan(1e-3);
    // Distribute needs three.
    act(() => ui().selectMany(['a', 'b']));
    expect(screen.getByRole('button', { name: 'Distribute horizontally' }).hasAttribute('disabled')).toBe(true);
  });

  /** A three-up row on the gutter. */
  const EVEN = {
    a: { x: 0.08, y: 0.3, w: 0.2, h: 0.3 },
    b: { x: 0.305, y: 0.3, w: 0.2, h: 0.3 },
    c: { x: 0.53, y: 0.3, w: 0.2, h: 0.3 },
  };

  it('offers Fix spacing after a drop that breaks the row rhythm, and tidies that row', () => {
    loadRow(EVEN);
    useUiStore.setState({ snapEnabled: false });
    render(<Shell />);
    press('c');
    moveTo(140, 100); // +0.08: gaps 0.025 and 0.105
    release();
    const fix = screen.getByRole('button', { name: 'Fix spacing' });
    const before = history();
    fireEvent.click(fix);
    expect(history()).toBe(before + 1);
    // Back on the untouched gap (the gutter), the row centred where it was.
    const gaps = [frameOf('b').x - (frameOf('a').x + 0.2), frameOf('c').x - (frameOf('b').x + 0.2)];
    expect(gaps[0]).toBeCloseTo(0.025, 6);
    expect(gaps[1]).toBeCloseTo(0.025, 6);
    expect(screen.queryByRole('button', { name: 'Fix spacing' })).toBeNull();
  });

  it('no Fix spacing after a drop that keeps the gaps even', () => {
    loadRow(EVEN);
    useUiStore.setState({ snapEnabled: false });
    render(<Shell />);
    press('a');
    moveTo(100, 110);
    release();
    expect(screen.queryByRole('button', { name: 'Fix spacing' })).toBeNull();
  });
  it('Fix spacing goes with the next undo step and does not come back on redo, nor after a reselect', () => {
    loadRow(EVEN);
    useUiStore.setState({ snapEnabled: false });
    render(<Shell />);
    press('c');
    moveTo(140, 100);
    release();
    expect(screen.getByRole('button', { name: 'Fix spacing' })).toBeTruthy();
    act(() => {
      undo();
    });
    expect(useSpacingHint.getState().elementId).toBeNull();
    act(() => {
      redo();
    });
    // The row is uneven again, but the hint belonged to the drop that was undone.
    expect(frameOf('c').x).toBeCloseTo(EVEN.c.x + 0.08, 6);
    expect(screen.queryByRole('button', { name: 'Fix spacing' })).toBeNull();
    // A new drop that makes it no worse (a vertical nudge of the same frame by drag) shows nothing either.
    press('c');
    moveTo(100, 104);
    release();
    expect(screen.queryByRole('button', { name: 'Fix spacing' })).toBeNull();
    // A drop that makes it worse shows it; selecting another frame and coming back drops it.
    press('c');
    moveTo(110, 100);
    release();
    expect(screen.getByRole('button', { name: 'Fix spacing' })).toBeTruthy();
    act(() => ui().select('a'));
    act(() => ui().select('c'));
    expect(screen.queryByRole('button', { name: 'Fix spacing' })).toBeNull();
  });

  it('Tidy on a bleed-to-bleed row keeps it on the page with equal gaps', () => {
    const bleed = resolveTheme({}).bleed;
    // Gaps 0.03 and 0.05 (mean 0.04 = 0.32 in, the wide gutter 0.05 would not fit): the mean is kept.
    const full = {
      a: { x: -bleed, y: 0.3, w: 0.315, h: 0.3 },
      b: { x: -bleed + 0.345, y: 0.3, w: 0.315, h: 0.3 },
      c: { x: -bleed + 0.71, y: 0.3, w: 0.315, h: 0.3 },
    };
    loadRow(full);
    render(<Shell />);
    act(() => ui().selectMany(['a', 'b', 'c']));
    fireEvent.click(screen.getByRole('button', { name: 'Tidy: equal gaps on each row, on the gutter' }));
    const gaps = [frameOf('b').x - (frameOf('a').x + 0.315), frameOf('c').x - (frameOf('b').x + 0.315)];
    expect(gaps[0]).toBeCloseTo(0.04, 6);
    expect(gaps[1]).toBeCloseTo(0.04, 6);
    expect(frameOf('a').x).toBeCloseTo(-bleed, 6);
    // A shorter row by the left bleed widens to the wide gutter and shifts right as a block.
    const left = {
      a: { x: -bleed, y: 0.3, w: 0.2, h: 0.3 },
      b: { x: -bleed + 0.23, y: 0.3, w: 0.2, h: 0.3 },
      c: { x: -bleed + 0.48, y: 0.3, w: 0.2, h: 0.3 },
    };
    act(() => loadRow(left));
    fireEvent.click(screen.getByRole('button', { name: 'Tidy: equal gaps on each row, on the gutter' }));
    expect(frameOf('a').x).toBeCloseTo(-bleed, 6);
    expect(frameOf('b').x - (frameOf('a').x + 0.2)).toBeCloseTo(0.05, 6);
    expect(frameOf('c').x - (frameOf('b').x + 0.2)).toBeCloseTo(0.05, 6);
    expect(history()).toBe(1);
  });

  it('a press on a member then a window blur keeps the multi-selection (not a click)', () => {
    loadRow();
    render(<Shell />);
    act(() => ui().selectMany(['a', 'b']));
    press('a');
    fireEvent.blur(window);
    expect(ui().selectedElementIds).toEqual(['a', 'b']);
    // A press released with no button (lost outside the window) does not count either.
    press('b');
    moveTo(100, 100);
    fireEvent.pointerMove(window, { buttons: 0, clientX: 100, clientY: 100 });
    expect(ui().selectedElementIds).toEqual(['a', 'b']);
  });
});
