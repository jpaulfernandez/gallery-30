// @vitest-environment jsdom
import { BOOK_TEMPLATES, parseBook, serializeBook } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redo, undo, useBookStore } from '../../store/book';
import { bookForDisk } from '../../store/library';
import {
  addPageGuide,
  clearPageGuides,
  movePageGuide,
  parseGuideValue,
  removePageGuide,
  roundGuideValue,
  rulerTicks,
} from './pageGuides';

const portrait = BOOK_TEMPLATES['phone-portrait'];
const guides = () => useBookStore.getState().book?.pages[0]?.guides ?? [];
const steps = () => useBookStore.temporal.getState().pastStates.length;

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
});
afterEach(() => useBookStore.getState().close());

describe('page guide edits', () => {
  it('add, move and remove are one undo step each', () => {
    addPageGuide('p1', { axis: 'x', value: 0.25 });
    expect(guides()).toEqual([{ axis: 'x', value: 0.25 }]);
    expect(steps()).toBe(1);
    movePageGuide('p1', 0, 0.5);
    expect(guides()).toEqual([{ axis: 'x', value: 0.5 }]);
    // Moving it where it already is records nothing.
    movePageGuide('p1', 0, 0.5);
    expect(steps()).toBe(2);
    removePageGuide('p1', 0);
    expect(guides()).toEqual([]);
    expect(steps()).toBe(3);
    undo();
    expect(guides()).toEqual([{ axis: 'x', value: 0.5 }]);
    undo();
    expect(guides()).toEqual([{ axis: 'x', value: 0.25 }]);
    redo();
    expect(guides()).toEqual([{ axis: 'x', value: 0.5 }]);
  });

  it('clears a page in one step, and clamps values onto the page', () => {
    addPageGuide('p1', { axis: 'y', value: 1.4 });
    addPageGuide('p1', { axis: 'x', value: 0.3 });
    expect(guides()[0]).toEqual({ axis: 'y', value: 1 });
    clearPageGuides('p1');
    expect(guides()).toEqual([]);
    expect(steps()).toBe(3);
    clearPageGuides('p1');
    expect(steps()).toBe(3);
  });

  it('survive save and reload (the project file round trip through parseBook)', () => {
    addPageGuide('p1', { axis: 'x', value: 0.25 });
    addPageGuide('p1', { axis: 'y', value: 0.6 });
    const { book, libraries, folder } = useBookStore.getState();
    if (!book) throw new Error('no book');
    const reloaded = parseBook(serializeBook(bookForDisk({ libraries }, book, folder)));
    expect(reloaded.pages[0]?.guides).toEqual([
      { axis: 'x', value: 0.25 },
      { axis: 'y', value: 0.6 },
    ]);
    // Other pages keep none.
    expect(reloaded.pages[1]?.guides).toEqual([]);
  });
});

describe('ruler units', () => {
  it('parses inches, mm and cm, and refuses values off the page', () => {
    // 8 x 10 in: 1 in is 0.125 of the width, 0.1 of the height.
    expect(parseGuideValue('2', portrait, 'x')).toBeCloseTo(0.25, 12);
    expect(parseGuideValue('2.5 in', portrait, 'y')).toBeCloseTo(0.25, 12);
    expect(parseGuideValue('4"', portrait, 'x')).toBeCloseTo(0.5, 12);
    expect(parseGuideValue('50.8 mm', portrait, 'x')).toBeCloseTo(0.25, 12);
    expect(parseGuideValue('5,08cm', portrait, 'x')).toBeCloseTo(0.25, 12);
    expect(parseGuideValue('9', portrait, 'x')).toBeNull();
    expect(parseGuideValue('9', portrait, 'y')).toBeCloseTo(0.9, 12);
    expect(parseGuideValue('-1', portrait, 'x')).toBeNull();
    expect(parseGuideValue('abc', portrait, 'x')).toBeNull();
  });

  it('rounds a dragged guide to 1/100 in', () => {
    expect(roundGuideValue(portrait, 'x', 0.25 + 0.0004)).toBeCloseTo(0.25, 12);
    expect(roundGuideValue(portrait, 'y', 0.4567)).toBeCloseTo(0.457, 12);
  });

  it('subdivides the inches as the zoom allows and labels whole inches', () => {
    const coarse = rulerTicks(8, 15);
    expect(coarse.every((t) => t.size === 'major')).toBe(true);
    expect(coarse.filter((t) => t.label).map((t) => t.label)).toEqual(['0', '2', '4', '6', '8']);
    const fine = rulerTicks(8, 100);
    expect(fine).toHaveLength(8 * 8 + 1);
    expect(fine[4]).toEqual({ inches: 0.5, size: 'half' });
    expect(fine[1]).toEqual({ inches: 0.125, size: 'minor' });
    expect(fine.filter((t) => t.label)).toHaveLength(9);
  });
});
