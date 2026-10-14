import { describe, expect, it } from 'vitest';
import { createEmptyBook, loadBook } from '../book.js';
import { BOOK_OUTPUT_ID, pagesOf, printSourceId, templateOf } from '../outputs.js';
import { PrintOutputSchema } from '../schema.js';
import { frameTemplate } from '../social/templates.js';
import { templateFor } from '../templates.js';
import {
  bleedBox,
  cropMarks,
  DEFAULT_PRINT_SETTINGS,
  defaultPrintSettings,
  imposePages,
  mmToPt,
  PAPER_PRESETS,
  PAPER_SIZES,
  PRINT_PRESETS,
  type PrintSettings,
  paperForTemplate,
  paperSize,
  presetSettings,
  printContentBox,
  printSummary,
  sheetSize,
  slugMm,
  trimBox,
} from './print.js';

const settings = (patch: Partial<PrintSettings> = {}): PrintSettings => ({ ...DEFAULT_PRINT_SETTINGS, ...patch });

describe('paper presets', () => {
  it('has one preset per paper, portrait, with the standard sizes', () => {
    expect(Object.keys(PAPER_PRESETS).sort()).toEqual([...PAPER_SIZES].sort());
    for (const paper of PAPER_SIZES) {
      const p = PAPER_PRESETS[paper];
      expect(p.paper).toBe(paper);
      expect(p.widthMm).toBeLessThanOrEqual(p.heightMm);
    }
    expect(paperSize('a5')).toEqual({ w: 148, h: 210 });
    expect(paperSize('a4', 'landscape')).toEqual({ w: 297, h: 210 });
    expect(paperSize('letter').w).toBeCloseTo(215.9, 6);
    expect(paperSize('letter').h).toBeCloseTo(279.4, 6);
    expect(paperSize('8x10').w).toBeCloseTo(203.2, 6);
    expect(paperSize('8x8')).toEqual({ w: 203.2, h: 203.2 });
  });

  it('starts a print on the paper whose ratio is the book page', () => {
    expect(paperForTemplate(templateFor('phone-portrait'))).toEqual({ paper: '8x10', orientation: 'portrait' });
    expect(paperForTemplate(templateFor('square'))).toEqual({ paper: '8x8', orientation: 'portrait' });
    expect(paperForTemplate(templateFor('a4-portrait'))).toEqual({ paper: 'a4', orientation: 'portrait' });
    expect(paperForTemplate(templateFor('a4-landscape'))).toEqual({ paper: 'a4', orientation: 'landscape' });
    // Nothing matches a 9:16 story: A5.
    expect(paperForTemplate(templateFor('story'))).toEqual({ paper: 'a5', orientation: 'portrait' });
    expect(defaultPrintSettings(templateFor('square'))).toEqual({ ...DEFAULT_PRINT_SETTINGS, paper: '8x8' });
  });
});

describe('trim and bleed boxes', () => {
  it('pages without marks: the sheet is the trim plus the bleed', () => {
    const s = settings({ paper: 'a5', bleedMm: 3, marks: false });
    expect(slugMm(s)).toBe(0);
    expect(trimBox(s)).toEqual({ x: 3, y: 3, w: 148, h: 210 });
    expect(bleedBox(s)).toEqual({ x: 0, y: 0, w: 154, h: 216 });
    expect(sheetSize(s)).toEqual({ w: 154, h: 216 });
    expect(mmToPt(sheetSize(s).w)).toBeCloseTo(436.535, 2);
  });

  it('spreads double the trim width; marks add a slug outside the bleed', () => {
    const s = settings({ paper: 'a5', imposition: 'spreads', bleedMm: 3, marks: true });
    const slug = slugMm(s);
    expect(slug).toBeGreaterThan(0);
    expect(trimBox(s)).toEqual({ x: 3 + slug, y: 3 + slug, w: 296, h: 210 });
    expect(bleedBox(s)).toEqual({ x: slug, y: slug, w: 302, h: 216 });
    expect(sheetSize(s)).toEqual({ w: 302 + 2 * slug, h: 216 + 2 * slug });
  });

  it('no bleed: the trim is the sheet', () => {
    const s = settings({ paper: '8x8', bleedMm: 0, marks: false });
    expect(trimBox(s)).toEqual(bleedBox(s));
    expect(sheetSize(s)).toEqual({ w: 203.2, h: 203.2 });
  });

  it('a page fills its trim when the ratios match, else it is centred', () => {
    const a4 = { x: 0, y: 0, w: 210, h: 297 };
    expect(printContentBox(a4, templateFor('a4-portrait'))).toEqual({ ...a4, fills: true });
    const square = printContentBox(a4, templateFor('square'));
    expect(square.fills).toBe(false);
    expect(square.w).toBeCloseTo(210, 6);
    expect(square.h).toBeCloseTo(210, 6);
    expect(square.y).toBeCloseTo((297 - 210) / 2, 6);
    const story = printContentBox({ x: 10, y: 10, w: 148, h: 210 }, frameTemplate('instagram-story'));
    expect(story.h).toBeCloseTo(210, 6);
    expect(story.x).toBeGreaterThan(10);
  });

  it('summarises the sheet', () => {
    expect(printSummary(settings({ paper: 'a5', bleedMm: 3, marks: false }))).toBe(
      'A5 portrait pages, 154 × 216 mm with bleed',
    );
  });
});

describe('imposition', () => {
  it('pages: one per sheet, every edge bleeds', () => {
    const sheets = imposePages(3, settings());
    expect(sheets.map((s) => s.pages.map((p) => p.page))).toEqual([[0], [1], [2]]);
    expect(sheets[0]?.pages[0]?.bleeds).toEqual({ top: true, right: true, bottom: true, left: true });
  });

  it('spreads: the first page alone on the right, then pairs, an even last page alone on the left', () => {
    const s = settings({ imposition: 'spreads', bleedMm: 3 });
    expect(imposePages(5, s).map((sheet) => sheet.pages.map((p) => p.page))).toEqual([[0], [1, 2], [3, 4]]);
    const four = imposePages(4, s);
    expect(four.map((sheet) => sheet.pages.map((p) => p.page))).toEqual([[0], [1, 2], [3]]);
    const trim = trimBox(s);
    const [cover] = four[0]?.pages ?? [];
    expect(cover?.trim).toEqual({ ...trim, x: trim.x + trim.w / 2, w: trim.w / 2 });
    expect(cover?.bleeds).toEqual({ top: true, right: true, bottom: true, left: false });
    const [left, right] = four[1]?.pages ?? [];
    expect(left?.trim).toEqual({ ...trim, w: trim.w / 2 });
    expect(left?.bleeds.right).toBe(false);
    expect(right?.bleeds.left).toBe(false);
    expect(four[2]?.pages[0]?.trim.x).toBe(trim.x);
    expect(imposePages(0, s)).toEqual([]);
  });
});

describe('crop marks', () => {
  it('sit on the trim lines, outside the bleed and inside the sheet', () => {
    const s = settings({ paper: 'a5', bleedMm: 3, marks: true });
    const marks = cropMarks(s);
    expect(marks).toHaveLength(8);
    const trim = trimBox(s);
    const bleed = bleedBox(s);
    const sheet = sheetSize(s);
    const outsideBleed = (x: number, y: number) =>
      x <= bleed.x || x >= bleed.x + bleed.w || y <= bleed.y || y >= bleed.y + bleed.h;
    for (const m of marks) {
      for (const [x, y] of [
        [m.x1, m.y1],
        [m.x2, m.y2],
      ] as const) {
        expect(outsideBleed(x, y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(sheet.w);
        expect(y).toBeLessThanOrEqual(sheet.h);
      }
      // Horizontal marks lie on a trim edge's y, vertical ones on a trim edge's x.
      if (m.y1 === m.y2) expect([trim.y, trim.y + trim.h]).toContain(m.y1);
      else expect([trim.x, trim.x + trim.w]).toContain(m.x1);
    }
    expect(cropMarks({ ...s, marks: false })).toEqual([]);
  });

  it('spreads add a fold mark above and below the spine', () => {
    const s = settings({ imposition: 'spreads', marks: true });
    const trim = trimBox(s);
    const spine = cropMarks(s).filter((m) => m.x1 === trim.x + trim.w / 2 && m.x2 === m.x1);
    expect(spine).toHaveLength(2);
  });
});

describe('print outputs', () => {
  it('fill every setting with a default, so a plan 13 print reads as an A5 print', () => {
    const parsed = PrintOutputSchema.parse({ id: '01PRINT', name: 'Print', createdAt: 1, kind: 'print' });
    expect(parsed).toMatchObject(DEFAULT_PRINT_SETTINGS);
    expect(() => PrintOutputSchema.parse({ ...parsed, paper: 'a3' })).toThrow();
    expect(() => PrintOutputSchema.parse({ ...parsed, bleedMm: 20 })).toThrow();
    expect(() => PrintOutputSchema.parse({ ...parsed, dpi: 30 })).toThrow();
  });

  it('the zine preset is A5 spreads with 3 mm bleed and marks', () => {
    expect(PRINT_PRESETS.zine.settings).toMatchObject({ paper: 'a5', imposition: 'spreads', bleedMm: 3, marks: true });
    // It keeps the pages' orientation: a landscape book makes a landscape zine.
    expect(presetSettings('zine', templateFor('a4-landscape')).orientation).toBe('landscape');
    expect(presetSettings('zine', templateFor('phone-portrait')).orientation).toBe('portrait');
    // Marks are on by default, with the default 3 mm bleed.
    expect(DEFAULT_PRINT_SETTINGS).toMatchObject({ bleedMm: 3, marks: true });
  });

  it("print the book's pages, or a post's frames when that is the source", () => {
    const base = createEmptyBook({ title: 'Zine', folders: {} });
    const post = {
      id: '01POST',
      name: 'Post',
      createdAt: 1,
      kind: 'social',
      network: 'instagram-story',
      frames: [{ ...base.pages[0], id: '01FRAME' }],
      caption: '',
    };
    const book = loadBook(
      JSON.parse(
        JSON.stringify({
          ...base,
          outputs: [
            post,
            { id: '01PRINT', name: 'Print', createdAt: 1, kind: 'print' },
            { id: '01PRINTPOST', name: 'Post print', createdAt: 1, kind: 'print', source: '01POST' },
            { id: '01PRINTGONE', name: 'Old', createdAt: 1, kind: 'print', source: '01DELETED' },
          ],
        }),
      ),
    );
    expect(pagesOf(book, '01PRINT')).toBe(book.pages);
    expect(templateOf(book, '01PRINT')).toEqual(book.template);
    expect(pagesOf(book, '01PRINTPOST').map((p) => p.id)).toEqual(['01FRAME']);
    expect(templateOf(book, '01PRINTPOST')).toEqual(frameTemplate('instagram-story'));
    expect(printSourceId(book, { source: '01DELETED' })).toBe(BOOK_OUTPUT_ID);
    expect(printSourceId(book, { source: '01PRINT' })).toBe(BOOK_OUTPUT_ID);
    expect(pagesOf(book, '01PRINTGONE')).toBe(book.pages);
  });
});
