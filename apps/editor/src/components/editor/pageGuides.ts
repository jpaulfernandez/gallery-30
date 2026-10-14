import {
  type Book,
  type BookTemplate,
  GUIDE_PAGE_WIDTH_IN,
  inchFraction,
  locatePage,
  type PageGuide,
  type SnapAxis,
} from '@photobook/shared';
import { flushIdleGestures, useBookStore } from '../../store/book';

/**
 * Ruler guides on a page (`page.guides`, workflow plan 31): the unit maths the rulers draw with and
 * the three edits (add, move, remove), each one undo step. Values are fractions of the page along
 * the guide's axis (an `x` guide is a vertical line at that fraction of the width); the rulers
 * show them in inches on the 8 in reference page, like every other measure on the canvas.
 */

type Size = Pick<BookTemplate, 'width' | 'height'>;

/** A guide's position in inches on the reference page. */
export const guideInches = (template: Size, axis: SnapAxis, value: number): number =>
  value / inchFraction(template, axis);

/** "2.50 in". */
export const formatInches = (inches: number): string => `${inches.toFixed(2)} in`;

/** A dragged guide lands on the nearest 1/100 in, the precision the rulers and the value field show. */
export function roundGuideValue(template: Size, axis: SnapAxis, value: number): number {
  const inch = inchFraction(template, axis);
  return (Math.round((value / inch) * 100) / 100) * inch;
}

const UNIT_INCHES: Record<string, number> = { '': 1, in: 1, '"': 1, mm: 1 / 25.4, cm: 1 / 2.54 };

/**
 * A typed guide position as a page fraction along `axis`: a number of inches ("2.5", "2.5 in",
 * `2.5"`), or of mm or cm ("64 mm"). Null when it does not parse or falls off the page.
 */
export function parseGuideValue(text: string, template: Size, axis: SnapAxis): number | null {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(in|"|mm|cm)?\s*$/i.exec(text.replace(',', '.'));
  if (!m) return null;
  const inches = Number(m[1]) * (UNIT_INCHES[(m[2] ?? '').toLowerCase()] ?? 1);
  const value = inches * inchFraction(template, axis);
  if (!Number.isFinite(value) || value < -1e-9 || value > 1 + 1e-9) return null;
  return Math.min(1, Math.max(0, value));
}

export interface RulerTick {
  /** Inches from the page's top or left edge. */
  inches: number;
  size: 'major' | 'half' | 'minor';
  /** Whole inches only, at a spacing that stays readable. */
  label?: string;
}

/**
 * Ticks of a ruler `lengthIn` inches long drawn at `pxPerIn` CSS px per inch: whole inches, with
 * halves, quarters and eighths as the zoom gives them room (a tick at least ~10 px apart).
 */
export function rulerTicks(lengthIn: number, pxPerIn: number): RulerTick[] {
  const sub = pxPerIn >= 80 ? 8 : pxPerIn >= 40 ? 4 : pxPerIn >= 20 ? 2 : 1;
  const labelEvery = pxPerIn >= 24 ? 1 : pxPerIn >= 12 ? 2 : 4;
  const out: RulerTick[] = [];
  const n = Math.floor(lengthIn * sub + 1e-9);
  for (let k = 0; k <= n; k++) {
    const inches = k / sub;
    if (k % sub === 0) {
      const tick: RulerTick = { inches, size: 'major' };
      if (inches % labelEvery === 0) tick.label = String(inches);
      out.push(tick);
    } else {
      out.push({ inches, size: sub >= 2 && k % (sub / 2) === 0 ? 'half' : 'minor' });
    }
  }
  return out;
}

/** Length of the ruler along `axis` in inches: 8 across, the page's height in proportion down. */
export const rulerLengthIn = (template: Size, axis: SnapAxis): number =>
  axis === 'x' ? GUIDE_PAGE_WIDTH_IN : (GUIDE_PAGE_WIDTH_IN * template.height) / template.width;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Add a guide to the page. One undo step. */
export function addPageGuide(pageId: string, guide: PageGuide): void {
  flushIdleGestures();
  useBookStore.getState().updatePage(pageId, (page) => {
    page.guides.push({ axis: guide.axis, value: clamp01(guide.value) });
  });
}

/** Move the page's guide `index` to `value` (no step when it is already there). One undo step. */
export function movePageGuide(pageId: string, index: number, value: number): void {
  flushIdleGestures();
  const next = clamp01(value);
  const book = useBookStore.getState();
  const before = findGuide(book.book, pageId, index);
  if (!before || Math.abs(before.value - next) < 1e-12) return;
  book.updatePage(pageId, (page) => {
    const g = page.guides[index];
    if (g) g.value = next;
  });
}

/** Remove the page's guide `index`. One undo step. */
export function removePageGuide(pageId: string, index: number): void {
  flushIdleGestures();
  const book = useBookStore.getState();
  if (!findGuide(book.book, pageId, index)) return;
  book.updatePage(pageId, (page) => {
    page.guides.splice(index, 1);
  });
}

/** Remove every guide of the page (the View menu). One undo step; none when the page has none. */
export function clearPageGuides(pageId: string): void {
  flushIdleGestures();
  const book = useBookStore.getState();
  const at = book.book ? locatePage(book.book, pageId) : undefined;
  if (!at?.pages[at.index]?.guides.length) return;
  book.updatePage(pageId, (page) => {
    page.guides = [];
  });
}

/** The page's guide `index` in whichever document the page is (the book or an output's frames). */
function findGuide(book: Book | null, pageId: string, index: number): PageGuide | undefined {
  const at = book ? locatePage(book, pageId) : undefined;
  return at?.pages[at.index]?.guides[index];
}
