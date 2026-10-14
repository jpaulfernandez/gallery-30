// @vitest-environment jsdom
import { type PhotoElement, pagesOf } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redo, undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));

const { Canvas } = await import('./Canvas');
const { EditorDnd } = await import('./EditorDnd');
const { ViewMenu } = await import('./ViewMenu');
const { useSnapGuides } = await import('./snap');
const { useEditorShortcuts } = await import('./useEditorShortcuts');

function Shell() {
  useEditorShortcuts();
  return (
    <EditorDnd>
      <ViewMenu />
      <Canvas />
    </EditorDnd>
  );
}

// The page box on screen: 500 x 625 px at the origin (4:5, 8 x 10 in: 62.5 px per inch).
const RECT = { x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 625, width: 500, height: 625 };
const ui = () => useUiStore.getState();
const page = () => {
  const book = useBookStore.getState().book;
  const p = book ? pagesOf(book, ui().design.outputId)[0] : undefined;
  if (!p) throw new Error('no page');
  return p;
};
const guides = () => page().guides;
const steps = () => useBookStore.temporal.getState().pastStates.length;
const ruler = (side: 'top' | 'left') => document.querySelector(`[data-ruler="${side}"]`) as HTMLElement;
const guideAt = (i: number) => document.querySelector(`[data-guide-index="${i}"]`) as HTMLElement;

/** Press on `node` at (x0, y0), move to (x1, y1) with the button held, release there. */
function drag(node: HTMLElement, x0: number, y0: number, x1: number, y1: number) {
  fireEvent.pointerDown(node, { button: 0, buttons: 1, clientX: x0, clientY: y0 });
  fireEvent.pointerMove(window, { buttons: 1, clientX: x1, clientY: y1 });
  fireEvent.pointerUp(window, { button: 0, buttons: 0, clientX: x1, clientY: y1 });
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ ...RECT, toJSON: () => RECT } as DOMRect);
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
  useUiStore.setState({ showRulers: true, showGuidesWhileDragging: true, snapEnabled: true });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  await useBookStore.getState().close();
});

describe('Rulers: drag-out guides (workflow plan 31)', () => {
  it('a drag from the top ruler onto the page adds a horizontal guide, one undo step', () => {
    render(<Shell />);
    expect(ruler('top')).toBeTruthy();
    // 250 px down a 625 px page: 0.4 of the height, 4.00 in.
    drag(ruler('top'), 100, -10, 100, 250);
    expect(guides()).toEqual([{ axis: 'y', value: expect.closeTo(0.4, 9) }]);
    expect(steps()).toBe(1);
    expect(screen.getByRole('button', { name: 'Horizontal guide at 4.00 in' })).toBeTruthy();
    undo();
    expect(guides()).toEqual([]);
    redo();
    expect(guides()).toHaveLength(1);
  });

  it('a drag from the left ruler adds a vertical guide; one released over the ruler adds nothing', () => {
    render(<Shell />);
    drag(ruler('left'), -10, 100, 125, 100);
    expect(guides()).toEqual([{ axis: 'x', value: expect.closeTo(0.25, 9) }]);
    drag(ruler('left'), -10, 100, -4, 120);
    expect(guides()).toHaveLength(1);
    expect(steps()).toBe(1);
  });

  it('shows the guide being dragged with its position', () => {
    render(<Shell />);
    fireEvent.pointerDown(ruler('top'), { button: 0, buttons: 1, clientX: 100, clientY: -10 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 125 });
    expect(screen.getByTestId('guide-preview').textContent).toBe('2.00 in');
    fireEvent.pointerUp(window, { button: 0, buttons: 0 });
    expect(screen.queryByTestId('guide-preview')).toBeNull();
  });

  it('a guide drags along its axis (one step) and back onto its ruler is removed (one step)', () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'x', value: 0.25 });
    });
    useBookStore.temporal.getState().clear();
    render(<Shell />);
    drag(guideAt(0), 125, 300, 250, 320);
    expect(guides()).toEqual([{ axis: 'x', value: expect.closeTo(0.5, 9) }]);
    expect(steps()).toBe(1);
    drag(guideAt(0), 250, 300, -8, 300);
    expect(guides()).toEqual([]);
    expect(steps()).toBe(2);
    undo();
    expect(guides()).toEqual([{ axis: 'x', value: expect.closeTo(0.5, 9) }]);
    undo();
    expect(guides()).toEqual([{ axis: 'x', value: 0.25 }]);
  });

  it('a click or a jittery press beside the line moves nothing; a drag keeps the grab offset', () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'x', value: 0.25 });
    });
    useBookStore.temporal.getState().clear();
    render(<Shell />);
    // Pressed 2 px right of the line (at 125 px), wobbling 2 px: no drag, no step.
    drag(guideAt(0), 127, 300, 129, 301);
    fireEvent.doubleClick(guideAt(0));
    expect(guides()).toEqual([{ axis: 'x', value: 0.25 }]);
    expect(steps()).toBe(0);
    fireEvent.keyDown(screen.getByRole('textbox', { name: /guide position/ }), { key: 'Escape' });
    // Pressed 2 px right of the line and dragged 125 px: the line moves 125 px, to 250 px (0.5).
    drag(guideAt(0), 127, 300, 252, 300);
    expect(guides()).toEqual([{ axis: 'x', value: expect.closeTo(0.5, 9) }]);
    expect(steps()).toBe(1);
  });

  it('Escape cancels a guide drag', () => {
    render(<Shell />);
    fireEvent.pointerDown(ruler('top'), { button: 0, buttons: 1, clientX: 100, clientY: -10 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 100, clientY: 200 });
    expect(screen.getByTestId('guide-preview')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('guide-preview')).toBeNull();
    fireEvent.pointerUp(window, { button: 0, buttons: 0 });
    expect(guides()).toEqual([]);
    expect(steps()).toBe(0);
  });

  it('arrow keys nudge a focused guide along its axis, one step each, and never reach the canvas', () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'y', value: 0.5 });
    });
    useBookStore.temporal.getState().clear();
    act(() => ui().setPageIndex(0));
    render(<Shell />);
    // 1 in is 0.1 of the height: 0.01 in is 0.001, 0.1 in (Shift) 0.01.
    fireEvent.keyDown(guideAt(0), { key: 'ArrowDown' });
    expect(guides()[0]?.value).toBeCloseTo(0.501, 9);
    fireEvent.keyDown(guideAt(0), { key: 'ArrowUp', shiftKey: true });
    expect(guides()[0]?.value).toBeCloseTo(0.491, 9);
    expect(steps()).toBe(2);
    // The other axis does nothing, and does not change page either.
    fireEvent.keyDown(guideAt(0), { key: 'ArrowRight' });
    expect(guides()[0]?.value).toBeCloseTo(0.491, 9);
    expect(steps()).toBe(2);
    expect(ui().pageIndex).toBe(0);
    undo();
    expect(guides()[0]?.value).toBeCloseTo(0.501, 9);
  });

  it('a press on a guide without a move changes nothing and keeps the selection', () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'y', value: 0.5 });
    });
    useBookStore.temporal.getState().clear();
    const el = page().elements[0];
    if (!el) throw new Error('no element');
    act(() => ui().select(el.id));
    render(<Shell />);
    fireEvent.pointerDown(guideAt(0), { button: 0, buttons: 1, clientX: 100, clientY: 312 });
    fireEvent.pointerUp(window, { button: 0, buttons: 0 });
    expect(steps()).toBe(0);
    expect(ui().selectedElementId).toBe(el.id);
  });

  it('double-click types a position (Enter moves, Escape cancels); Delete removes a focused guide', () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'y', value: 0.5 });
    });
    useBookStore.temporal.getState().clear();
    render(<Shell />);
    fireEvent.doubleClick(guideAt(0));
    const field = screen.getByRole('textbox', { name: /Horizontal guide position/ }) as HTMLInputElement;
    expect(field.value).toBe('5.00');
    fireEvent.change(field, { target: { value: '2.5' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(guides()).toEqual([{ axis: 'y', value: expect.closeTo(0.25, 9) }]);
    expect(steps()).toBe(1);
    expect(screen.queryByRole('textbox', { name: /guide position/ })).toBeNull();

    fireEvent.doubleClick(guideAt(0));
    const again = screen.getByRole('textbox', { name: /guide position/ });
    fireEvent.change(again, { target: { value: '7' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(guides()).toEqual([{ axis: 'y', value: expect.closeTo(0.25, 9) }]);
    expect(steps()).toBe(1);

    // With a filled photo selected, Delete on the focused guide removes the guide only (not the photo too).
    const filled = page().elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
    if (!filled) throw new Error('no photo');
    act(() => ui().select(filled.id));
    fireEvent.keyDown(guideAt(0), { key: 'Delete' });
    expect(guides()).toEqual([]);
    expect(steps()).toBe(2);
    expect((page().elements.find((e) => e.id === filled.id) as PhotoElement).asset).toBe(filled.asset);
  });
});

describe('View menu (workflow plan 31)', () => {
  it('toggles rulers, snapping and the drag guides, persisted per machine', () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: /View/ }));
    const rulers = screen.getByRole('menuitemcheckbox', { name: /Show rulers and guides/ });
    fireEvent.click(rulers);
    expect(ui().showRulers).toBe(false);
    expect(localStorage.getItem('photobook.ui.showRulers')).toBe('false');
    expect(ruler('top')).toBeNull();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Snap to guides/ }));
    expect(ui().snapEnabled).toBe(false);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Show guides while dragging/ }));
    expect(ui().showGuidesWhileDragging).toBe(false);
    expect(localStorage.getItem('photobook.ui.showGuidesWhileDragging')).toBe('false');
  });

  it("removes the page's guides in one step", () => {
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'y', value: 0.5 }, { axis: 'x', value: 0.5 });
    });
    useBookStore.temporal.getState().clear();
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: /View/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Remove this page's guides (2)" }));
    expect(guides()).toEqual([]);
    expect(steps()).toBe(1);
  });

  it('with "Show guides while dragging" off a drag snaps but draws no guides', () => {
    // The narrowest filled photo, so a 50 px drag stays clear of the page edge.
    const photo = page()
      .elements.filter((e): e is PhotoElement => e.type === 'photo' && e.asset !== null)
      .sort((a, b) => a.frame.w - b.frame.w)[0];
    if (!photo) throw new Error('no photo');
    // A guide just right of where a 50 px drag puts the frame's left edge (within the 6 px threshold at 100%).
    const target = photo.frame.x + 50 / 500 + 0.004;
    useBookStore.getState().updatePage(page().id, (p) => {
      p.guides.push({ axis: 'x', value: target });
    });
    useUiStore.setState({ zoom: 1 });
    render(<Shell />);
    const node = document.querySelector<HTMLElement>(`.pb-page [data-element-id="${photo.id}"]`) as HTMLElement;
    act(() => ui().setPref('showGuidesWhileDragging', false));
    fireEvent.pointerDown(node, { button: 0, buttons: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 150, clientY: 100 });
    // The frame snapped to the guide and the engine reported it; the overlay draws nothing.
    expect(page().elements.find((e) => e.id === photo.id)?.frame.x).toBeCloseTo(target, 9);
    expect(useSnapGuides.getState().guides).toContainEqual(
      expect.objectContaining({ axis: 'x', kind: 'guide', label: 'guide' }),
    );
    expect(document.querySelector('[data-testid="canvas-guides"] line')).toBeNull();
    expect(document.querySelector('[data-page-guide] [data-snapped]')).toBeNull();
    act(() => ui().setPref('showGuidesWhileDragging', true));
    expect(document.querySelector('[data-testid="canvas-guides"] line')).not.toBeNull();
    // The page guide the frame sits on is drawn brighter and wider.
    expect(document.querySelector('[data-page-guide] [data-snapped]')).not.toBeNull();
    fireEvent.pointerUp(window, { button: 0, buttons: 0 });
  });
});
