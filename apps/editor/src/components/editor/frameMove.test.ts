// @vitest-environment jsdom
import { type Book, type Frame, LAYOUT_CUSTOM, type Page, type PhotoElement, resolveTheme } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, fireEvent, render, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { ToastHost } from '../ui/Toast';
import { CUSTOM_PAGE_MESSAGE, resetCustomPageNotices } from './customPageNotice';
import { NUDGE_GUIDE_FLASH_MS, nudgeSelection, snapNudge } from './frameActions';
import { startFrameMove } from './frameMove';
import { resizeFromCentre, startFrameResize } from './frameResize';
import { pressAction } from './gestures';
import { useSnapGuides } from './snap';
import { dismissToast, useToastStore } from './Toast';

const LIB_LAYOUT = '3-hero-over-two';
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const page = (): Page => {
  const p = book().pages[0];
  if (!p) throw new Error('no page');
  return p;
};
const filled = (): PhotoElement => {
  const el = page().elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
  if (!el) throw new Error('no filled photo');
  return el;
};
const RECT = { width: 500, height: 625 };
interface PointerOptions {
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Buttons held: 1 (the primary) for moves by default; 0 is a move after a release that never arrived. */
  buttons?: number;
}
const pointer = (type: string, clientX = 0, clientY = 0, { buttons = 1, ...keys }: PointerOptions = {}) =>
  new MouseEvent(type, { clientX, clientY, buttons: type === 'pointerup' ? 0 : buttons, ...keys });

/** Press on a frame as the canvas does (`pressAction`), then drag by (dx, dy) px and release. */
function drag(el: PhotoElement, dx: number, dy: number, metaKey = false) {
  const ui = useUiStore.getState();
  const { action } = pressAction({
    target: { id: el.id, type: 'photo', filled: el.asset !== null },
    adjusting: ui.canvas.adjusting,
    selectedId: ui.selectedElementId,
    shiftKey: false,
    altKey: false,
    space: false,
  });
  expect(action).toBe('move');
  startFrameMove({ pageId: page().id, elementId: el.id, clientX: 100, clientY: 100, pageRect: RECT });
  window.dispatchEvent(pointer('pointermove', 100 + dx / 2, 100 + dy / 2, { metaKey }));
  window.dispatchEvent(pointer('pointermove', 100 + dx, 100 + dy, { metaKey }));
  window.dispatchEvent(pointer('pointerup'));
}

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useUiStore.getState().reset();
  useBookStore.getState().applyLayout(page().id, LIB_LAYOUT);
  useBookStore.temporal.getState().clear();
  useUiStore.setState({ zoom: 1 });
  resetCustomPageNotices();
  dismissToast();
});
afterEach(() => {
  // Let pending idle gestures and notices settle inside this test, not the next one.
  if (vi.isFakeTimers()) vi.runAllTimers();
  vi.useRealTimers();
  dismissToast();
  useBookStore.getState().close();
});

describe('a plain drag on a filled photo frame', () => {
  it('moves the frame and does not pan the photo', () => {
    const el = filled();
    useUiStore.getState().setPref('snapEnabled', false);
    drag(el, 20, 25);
    const after = filled();
    expect(after.id).toBe(el.id);
    expect(after.frame.x).toBeCloseTo(el.frame.x + 20 / RECT.width, 6);
    expect(after.frame.y).toBeCloseTo(el.frame.y + 25 / RECT.height, 6);
    expect(after.frame.w).toBe(el.frame.w);
    expect(after.frame.h).toBe(el.frame.h);
    expect(after.crop).toEqual(el.crop);
    expect(after.asset).toBe(el.asset);
    // One undo step.
    undo();
    expect(filled().frame).toEqual(el.frame);
  });

  it('snaps to guides unless Cmd is held', () => {
    const el = filled();
    useUiStore.getState().setPref('snapEnabled', true);
    drag(el, 4, 0, true);
    expect(filled().frame.x).toBeCloseTo(el.frame.x + 4 / RECT.width, 6);
    undo();
    // A 4 px drag (under the 6 px threshold) snaps back onto the layout's own line.
    drag(el, 4, 0);
    expect(filled().frame.x).toBeCloseTo(el.frame.x, 6);
  });
});

describe('a lost release', () => {
  beforeEach(() => {
    // Room to move on every side.
    const id = filled().id;
    useBookStore.getState().setFrames(page().id, { [id]: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } });
  });

  it('a move with no button down ends the drag, so undo works', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    const el = filled();
    startFrameMove({ pageId: page().id, elementId: el.id, clientX: 100, clientY: 100, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', 130, 100));
    expect(filled().frame.x).toBeCloseTo(el.frame.x + 30 / RECT.width, 6);
    // The release happened outside the window: the next move reports no button and ends the drag.
    window.dispatchEvent(pointer('pointermove', 160, 100, { buttons: 0 }));
    expect(filled().frame.x).toBeCloseTo(el.frame.x + 30 / RECT.width, 6);
    expect(undo()).toBe(true);
    expect(filled().frame).toEqual(el.frame);
  });

  it('the window losing focus ends a move and a resize', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    const el = filled();
    startFrameMove({ pageId: page().id, elementId: el.id, clientX: 100, clientY: 100, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', 130, 100));
    window.dispatchEvent(new Event('blur'));
    // Later moves no longer drag.
    window.dispatchEvent(pointer('pointermove', 200, 100));
    expect(filled().frame.x).toBeCloseTo(el.frame.x + 30 / RECT.width, 6);
    expect(undo()).toBe(true);
    expect(filled().frame).toEqual(el.frame);

    startFrameResize({ pageId: page().id, elementId: el.id, handle: 'e', clientX: 0, clientY: 0, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', -20, 0));
    window.dispatchEvent(new Event('blur'));
    expect(undo()).toBe(true);
    expect(filled().frame).toEqual(el.frame);
  });
});

describe('startFrameResize modifiers', () => {
  const start: Frame = { x: 0.3, y: 0.3, w: 0.4, h: 0.2 };
  /** Page 1 holds one element at `start`; resize it from the south-east corner by (dx, dy) px. */
  function resize(type: 'photo' | 'text', dx: number, dy: number, keys: PointerOptions = {}): Frame {
    const next = structuredClone(book());
    const source = type === 'photo' ? filled() : fixtureBook.pages[0]?.elements.find((e) => e.type === 'text');
    if (!source) throw new Error('no element');
    (next.pages[0] as Page).elements = [{ ...source, frame: start }];
    useBookStore.setState({ book: next });
    startFrameResize({ pageId: page().id, elementId: source.id, handle: 'se', clientX: 0, clientY: 0, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', dx, dy, keys));
    window.dispatchEvent(pointer('pointerup'));
    const el = page().elements[0];
    if (!el) throw new Error('gone');
    return el.frame;
  }
  const ratio = (f: Frame) => f.w / f.h;

  beforeEach(() => useUiStore.getState().setPref('snapEnabled', false));

  it('a locked photo keeps its ratio; Shift frees it', () => {
    expect(ratio(resize('photo', 50, 0))).toBeCloseTo(2, 4);
    const free = resize('photo', 50, 0, { shiftKey: true });
    expect(free.w).toBeCloseTo(0.4 + 50 / RECT.width, 6);
    expect(free.h).toBeCloseTo(0.2, 6);
  });

  it('a photo set free changes shape; Shift keeps its ratio', () => {
    useUiStore.getState().setRatioLock(filled().id, false);
    expect(resize('photo', 50, 0).h).toBeCloseTo(0.2, 6);
    useUiStore.getState().setRatioLock(page().elements[0]?.id ?? '', false);
    expect(ratio(resize('photo', 50, 0, { shiftKey: true }))).toBeCloseTo(2, 4);
  });

  it('a text box is free; Shift keeps its ratio', () => {
    expect(resize('text', 50, 0).h).toBeCloseTo(0.2, 6);
    expect(ratio(resize('text', 50, 0, { shiftKey: true }))).toBeCloseTo(2, 4);
  });

  it('Alt resizes from the centre', () => {
    const centre = (f: Frame) => [f.x + f.w / 2, f.y + f.h / 2];
    for (const type of ['photo', 'text'] as const) {
      const f = resize(type, 50, 0, { altKey: true });
      expect(centre(f)[0]).toBeCloseTo(0.5, 6);
      expect(centre(f)[1]).toBeCloseTo(0.4, 6);
      expect(f.w).toBeCloseTo(0.4 + (2 * 50) / RECT.width, 6);
    }
  });
});

describe('the custom-page notice', () => {
  it('shows once per page: two pages each show their own', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    const pages = book().pages;
    const second = pages[1];
    if (!second) throw new Error('no second page');
    expect(second.layout).not.toBe(LAYOUT_CUSTOM);
    drag(filled(), 30, 0);
    expect(useToastStore.getState().toast?.text).toBe(CUSTOM_PAGE_MESSAGE);
    dismissToast();
    const other = second.elements.find((e): e is PhotoElement => e.type === 'photo');
    if (!other) throw new Error('no photo on page 2');
    startFrameMove({ pageId: second.id, elementId: other.id, clientX: 0, clientY: 0, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', 0, 30));
    window.dispatchEvent(pointer('pointerup'));
    expect(useToastStore.getState().toast?.text).toBe(CUSTOM_PAGE_MESSAGE);
    dismissToast();
    // Both pages showed theirs: back on a layout, neither shows again this session.
    useBookStore.getState().applyLayout(page().id, LIB_LAYOUT);
    drag(filled(), 30, 0);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('shows once per page after the first move turns a layout page custom; Undo reverts the move', () => {
    const el = filled();
    useUiStore.getState().setPref('snapEnabled', false);
    drag(el, 30, 0);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    const toast = useToastStore.getState().toast;
    expect(toast?.text).toBe(CUSTOM_PAGE_MESSAGE);
    expect(toast?.action?.label).toBe('Undo');
    toast?.action?.run();
    expect(page().layout).toBe(LIB_LAYOUT);
    expect(filled().frame).toEqual(el.frame);

    // Same page again: no second toast this session.
    dismissToast();
    drag(el, 30, 0);
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('shows in the toast host; its Undo button there reverts the move and closes it (plan 48)', () => {
    const el = filled();
    useUiStore.getState().setPref('snapEnabled', false);
    const host = render(createElement(ToastHost));
    act(() => drag(el, 30, 0));
    expect(page().layout).toBe(LAYOUT_CUSTOM);
    const card = within(host.container).getByText(CUSTOM_PAGE_MESSAGE).closest('[role="status"]');
    if (!(card instanceof HTMLElement)) throw new Error('no toast card');
    fireEvent.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(page().layout).toBe(LIB_LAYOUT);
    expect(filled().frame).toEqual(el.frame);
    expect(useToastStore.getState().toast).toBeNull();
    expect(within(host.container).queryByText(CUSTOM_PAGE_MESSAGE)).toBeNull();
    host.unmount();
  });

  it('closes when another step lands, so its Undo never reverts something else', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    drag(filled(), 30, 0);
    expect(useToastStore.getState().toast).not.toBeNull();
    useBookStore.getState().rotateElement(page().id, filled().id);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('does not show on a page that was already custom', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    useBookStore.getState().setFrames(page().id, { [filled().id]: { ...filled().frame, x: filled().frame.x + 0.01 } });
    drag(filled(), 30, 0);
    expect(useToastStore.getState().toast).toBeNull();
  });
});

describe('nudge', () => {
  const step = () => resolveTheme(book().theme).grid;
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Page 1 holds one photo frame at `frame` (and keeps its layout id). */
  function lone(frame: Frame): PhotoElement {
    const el: PhotoElement = { ...filled(), frame };
    const next = structuredClone(book());
    (next.pages[0] as Page).elements = [el];
    useBookStore.setState({ book: next });
    useUiStore.getState().select(el.id);
    return el;
  }

  it('moves one grid step (Shift: ten) without snapping when snapping is off', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    const el = lone({ x: 0.4, y: 0.3, w: 0.1, h: 0.1 });
    nudgeSelection(1, 0);
    expect(filled().frame.x).toBeCloseTo(el.frame.x + step(), 9);
    nudgeSelection(-10, 0);
    expect(filled().frame.x).toBeCloseTo(el.frame.x - 9 * step(), 9);
    nudgeSelection(0, 10);
    const stepY = (step() * book().template.width) / book().template.height;
    expect(filled().frame.y).toBeCloseTo(el.frame.y + 10 * stepY, 9);
  });

  it('snapNudge takes a snap only forward along the step', () => {
    const start: Frame = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    const raw = { ...start, x: 0.21 };
    // Snaps forward to 0.215: taken.
    expect(snapNudge(start, raw, { ...raw, x: 0.215, y: 0.3 }, 'x')).toEqual({
      frame: { ...raw, x: 0.215 },
      snapped: true,
    });
    // Snaps back onto the start line: refused, the step stands.
    expect(snapNudge(start, raw, { ...raw, x: 0.2 }, 'x')).toEqual({ frame: raw, snapped: false });
    // Lands exactly on a line: kept, and it counts as snapped (the guides flash).
    expect(snapNudge(start, raw, raw, 'x').snapped).toBe(true);
  });

  it('flashes the guides of a step that lands on one, then clears them', () => {
    useUiStore.getState().setPref('snapEnabled', true);
    // A lone frame one grid step left of the page centre line, centred on it after a nudge.
    lone({ x: 0.35 - step(), y: 0.4, w: 0.3, h: 0.2 });
    const centred = 0.35;
    nudgeSelection(1, 0);
    expect(filled().frame.x).toBeCloseTo(centred, 9);
    const guides = useSnapGuides.getState().guides;
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.every((g) => g.axis === 'x')).toBe(true);
    vi.advanceTimersByTime(NUDGE_GUIDE_FLASH_MS + 10);
    expect(useSnapGuides.getState().guides).toHaveLength(0);
  });

  it('shows the custom-page notice after the nudges settle into one undo step', () => {
    useUiStore.getState().setPref('snapEnabled', false);
    const el = filled();
    useUiStore.getState().select(el.id);
    nudgeSelection(1, 0);
    nudgeSelection(1, 0);
    expect(useToastStore.getState().toast).toBeNull();
    vi.advanceTimersByTime(499);
    expect(useToastStore.getState().toast).toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toast?.text).toBe(CUSTOM_PAGE_MESSAGE);
    useToastStore.getState().toast?.action?.run();
    expect(filled().frame).toEqual(el.frame);
    expect(page().layout).toBe(LIB_LAYOUT);
  });
});

describe('resizeFromCentre (Alt on a resize handle)', () => {
  const start: Frame = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
  const min = { w: 0.05, h: 0.05 };

  it('mirrors the dragged edge, keeping it where the anchored resize put it', () => {
    // East edge dragged 0.05 right: the west edge moves 0.05 left.
    const fitted = { ...start, w: 0.25 };
    expect(resizeFromCentre(fitted, start, 'e', false, min)).toEqual({ x: 0.25, y: 0.3, w: 0.3, h: 0.2 });
    // A locked corner keeps the ratio around the centre.
    const corner = { x: 0.3, y: 0.3, w: 0.3, h: 0.3 };
    expect(resizeFromCentre(corner, start, 'se', true, min)).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
  });

  it('keeps the minimum size and the page', () => {
    expect(resizeFromCentre({ ...start, w: 0.01 }, start, 'e', false, min).w).toBe(0.05);
    const huge = resizeFromCentre({ ...start, w: 0.7 }, start, 'e', false, min);
    expect(huge.x).toBeCloseTo(0, 6);
    expect(huge.w).toBeCloseTo(0.8, 6);
  });
});

describe('the nudge notice and a discrete edit', () => {
  it('a discrete edit inside the idle window records the nudges first; the toast then closes', () => {
    vi.useFakeTimers();
    useUiStore.getState().setPref('snapEnabled', false);
    const el = filled();
    useUiStore.getState().select(el.id);
    nudgeSelection(1, 0);
    // Rotate before the nudge burst settles: the burst becomes its own step, its notice shows, the rotate closes it.
    useBookStore.getState().rotateElement(page().id, el.id);
    expect(useToastStore.getState().toast).toBeNull();
    undo();
    expect(filled().rotate).toBe(el.rotate);
    expect(filled().frame.x).not.toBe(el.frame.x);
    undo();
    expect(filled().frame).toEqual(el.frame);
  });
});

describe('size match on resize (workflow plan 30)', () => {
  const start: Frame = { x: 0.1, y: 0.4, w: 0.2, h: 0.2 };
  const other: Frame = { x: 0.6, y: 0.05, w: 0.25, h: 0.15 };
  /** Drag the east handle of a free photo frame (Shift) by `dx` px; returns the frame and the guides mid-drag. */
  function resizeEast(dx: number, altKey: boolean) {
    const next = structuredClone(book());
    const el = filled();
    next.theme = { ...resolveTheme({}), grid: 0.5 };
    (next.pages[0] as Page).elements = [
      { ...el, frame: start },
      { ...el, id: 'other', frame: other },
    ];
    useBookStore.setState({ book: next });
    useUiStore.setState({ snapEnabled: true });
    startFrameResize({ pageId: page().id, elementId: el.id, handle: 'e', clientX: 0, clientY: 0, pageRect: RECT });
    window.dispatchEvent(pointer('pointermove', dx, 0, { shiftKey: true, altKey }));
    const guides = useSnapGuides.getState().guides;
    window.dispatchEvent(pointer('pointerup'));
    return { frame: page().elements.find((e) => e.id === el.id)?.frame as Frame, guides };
  }

  it('snaps an anchored resize to the neighbour width', () => {
    const { frame, guides } = resizeEast(23, false);
    expect(frame.w).toBeCloseTo(0.25, 6);
    expect(guides.find((g) => g.kind === 'size')?.label).toBe('same width');
  });

  it('offers no size match from the centre (Alt), where the size is twice the edge travel', () => {
    const { frame, guides } = resizeEast(23, true);
    expect(guides.some((g) => g.kind === 'size')).toBe(false);
    expect(frame.w).toBeCloseTo(0.2 + 2 * (23 / 500), 6);
    expect(frame.x + frame.w / 2).toBeCloseTo(0.2, 6);
  });
});
