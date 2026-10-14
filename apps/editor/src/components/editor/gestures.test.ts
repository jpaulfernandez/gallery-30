import { type PhotoElement, pagesOf } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBookStore } from '../../store/book';
import { adjustingHolds, useUiStore } from '../../store/ui';
import { doubleClickAction, type PressInput, type PressTarget, pressAction } from './gestures';

const filled: PressTarget = { id: 'a', type: 'photo', filled: true };
const empty: PressTarget = { id: 'b', type: 'photo', filled: false };
const text: PressTarget = { id: 't', type: 'text', filled: false };
const press = (patch: Partial<PressInput>): PressInput => ({
  target: filled,
  adjusting: null,
  selectedId: null,
  shiftKey: false,
  altKey: false,
  space: false,
  ...patch,
});

describe('pressAction: what a press on the canvas starts', () => {
  it('a plain drag moves any frame, filled, empty or text, selected or not', () => {
    for (const target of [filled, empty, text]) {
      expect(pressAction(press({ target }))).toEqual({ action: 'move', adjusting: null });
      expect(pressAction(press({ target, selectedId: target.id }))).toEqual({ action: 'move', adjusting: null });
    }
  });

  it('Shift toggles the selection and Alt hands a filled photo to the slot drag', () => {
    expect(pressAction(press({ shiftKey: true })).action).toBe('toggle-selection');
    expect(pressAction(press({ altKey: true })).action).toBe('swap');
    // An empty frame or a text box has no photo to swap: Alt + drag moves it.
    expect(pressAction(press({ target: empty, altKey: true })).action).toBe('move');
    expect(pressAction(press({ target: text, altKey: true })).action).toBe('move');
  });

  it('a press on nothing deselects and leaves Adjust photo', () => {
    expect(pressAction(press({ target: null, adjusting: 'a' }))).toEqual({ action: 'deselect', adjusting: null });
  });

  it('in Adjust photo every drag on the adjusted frame pans and the mode stays', () => {
    expect(pressAction(press({ adjusting: 'a', selectedId: 'a' }))).toEqual({ action: 'pan', adjusting: 'a' });
    expect(pressAction(press({ adjusting: 'a', selectedId: 'a', altKey: true }))).toEqual({
      action: 'pan',
      adjusting: 'a',
    });
  });

  it('a press on another frame leaves Adjust photo and moves that frame', () => {
    const other: PressTarget = { id: 'c', type: 'photo', filled: true };
    expect(pressAction(press({ target: other, adjusting: 'a', selectedId: 'a' }))).toEqual({
      action: 'move',
      adjusting: null,
    });
    expect(pressAction(press({ target: text, adjusting: 'a' }))).toEqual({ action: 'move', adjusting: null });
    // Shift+click while adjusting builds a selection, which ends the mode.
    expect(pressAction(press({ adjusting: 'a', selectedId: 'a', shiftKey: true }))).toEqual({
      action: 'toggle-selection',
      adjusting: null,
    });
  });

  it('Space + drag pans the selected filled photo only, without entering the mode', () => {
    expect(pressAction(press({ space: true, selectedId: 'a' }))).toEqual({ action: 'pan', adjusting: null });
    expect(pressAction(press({ space: true, selectedId: 'x' })).action).toBe('move');
    expect(pressAction(press({ target: empty, space: true, selectedId: 'b' })).action).toBe('move');
  });
});

describe('pressAction: a multi-selection (workflow plan 30)', () => {
  it('a press on a member drags the whole selection; Shift, Alt on a photo and non-members keep their action', () => {
    const many = { selectedId: 'b', selectedIds: ['a', 'b'] };
    expect(pressAction(press(many))).toEqual({ action: 'move-selection', adjusting: null });
    expect(pressAction(press({ ...many, target: empty })).action).toBe('move-selection');
    expect(pressAction(press({ ...many, shiftKey: true })).action).toBe('toggle-selection');
    expect(pressAction(press({ ...many, altKey: true })).action).toBe('swap');
    expect(pressAction(press({ ...many, target: text })).action).toBe('move');
    // A single selection is a plain move.
    expect(pressAction(press({ selectedId: 'a', selectedIds: ['a'] })).action).toBe('move');
  });
});

describe('doubleClickAction', () => {
  it('adjusts a filled photo, edits text, and does nothing on an empty frame or nothing', () => {
    expect(doubleClickAction(filled)).toBe('adjust');
    expect(doubleClickAction(text)).toBe('edit-text');
    expect(doubleClickAction(empty)).toBe('none');
    expect(doubleClickAction(null)).toBe('none');
  });
});

describe('adjustingHolds', () => {
  const state = { selectedElementIds: ['a'], tool: 'select', filled: true };
  it('needs the frame to be the only selection, filled, with the Select tool', () => {
    expect(adjustingHolds('a', state)).toBe(true);
    expect(adjustingHolds(null, state)).toBe(false);
    expect(adjustingHolds('a', { ...state, selectedElementIds: ['a', 'b'] })).toBe(false);
    expect(adjustingHolds('a', { ...state, selectedElementIds: ['b'] })).toBe(false);
    expect(adjustingHolds('a', { ...state, tool: 'frame' })).toBe(false);
    expect(adjustingHolds('a', { ...state, filled: false })).toBe(false);
  });
});

describe('ui.canvas.adjusting', () => {
  const ui = () => useUiStore.getState();
  const page = () => {
    const book = useBookStore.getState().book;
    const p = book ? pagesOf(book, ui().design.outputId)[0] : undefined;
    if (!p) throw new Error('no page');
    return p;
  };
  const photos = () => page().elements.filter((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
  const first = () => photos()[0]?.id ?? '';

  beforeEach(() => {
    useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
    useBookStore.temporal.getState().clear();
    useUiStore.getState().reset();
  });
  afterEach(() => useBookStore.getState().close());

  it('entering selects the frame alone and switches to the Select tool', () => {
    ui().setTool('frame');
    ui().selectMany([first(), 'p1-t1']);
    ui().setAdjusting(first());
    expect(ui().canvas.adjusting).toBe(first());
    expect(ui().selectedElementIds).toEqual([first()]);
    expect(ui().tool).toBe('select');
    ui().setAdjusting(null);
    expect(ui().canvas.adjusting).toBeNull();
  });

  it('ends when the selection, the tool or the page changes', () => {
    ui().setAdjusting(first());
    ui().select(photos()[1]?.id ?? null);
    expect(ui().canvas.adjusting).toBeNull();

    ui().setAdjusting(first());
    ui().select(null);
    expect(ui().canvas.adjusting).toBeNull();

    ui().setAdjusting(first());
    ui().setTool('frame');
    expect(ui().canvas.adjusting).toBeNull();

    ui().setAdjusting(first());
    ui().setPageIndex(1);
    expect(ui().canvas.adjusting).toBeNull();
  });

  it('ends when the frame loses its photo', () => {
    const id = first();
    ui().setAdjusting(id);
    useBookStore.getState().setElementAsset(page().id, id, null);
    expect(ui().canvas.adjusting).toBeNull();
  });

  it('cannot be entered on an empty frame', () => {
    const id = first();
    useBookStore.getState().setElementAsset(page().id, id, null);
    ui().setAdjusting(id);
    expect(ui().canvas.adjusting).toBeNull();
  });
});
