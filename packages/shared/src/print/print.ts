import type { BookTemplate } from '../schema.js';

/**
 * Print PDF (workflow plan 15): the paper presets, the boxes of a printed sheet and the imposition. Everything here is
 * in millimetres, measured from the sheet's top-left corner (the PDF page's MediaBox), and pure, so the CLI
 * (`packages/publish/src/print.ts`), the inspector and the tests share one geometry.
 *
 * A sheet is, from the outside in: the slug (only with marks: where the crop marks sit), the bleed (what is printed
 * past the cut so a photo touching the edge has no white sliver) and the trim (the finished page, or two pages side by
 * side for spreads). A page fills its trim when the ratios match (within `FIT_TOLERANCE`), else it is centred inside it.
 */

/** Paper sizes a print can be made on. Stored in project files: append, never rename. */
export const PAPER_SIZES = ['a5', 'a4', 'letter', '8x10', '8x8'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const PRINT_ORIENTATIONS = ['portrait', 'landscape'] as const;
export type PrintOrientation = (typeof PRINT_ORIENTATIONS)[number];

/** `pages`: one page per PDF page. `spreads`: facing pages side by side, the first page alone on the right. */
export const PRINT_IMPOSITIONS = ['pages', 'spreads'] as const;
export type PrintImposition = (typeof PRINT_IMPOSITIONS)[number];

export interface PaperPreset {
  paper: PaperSize;
  label: string;
  /** Portrait size in millimetres. */
  widthMm: number;
  heightMm: number;
}

const INCH = 25.4;

export const PAPER_PRESETS: Record<PaperSize, PaperPreset> = {
  a5: { paper: 'a5', label: 'A5', widthMm: 148, heightMm: 210 },
  a4: { paper: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
  letter: { paper: 'letter', label: 'US Letter', widthMm: 8.5 * INCH, heightMm: 11 * INCH },
  '8x10': { paper: '8x10', label: '8 × 10 in', widthMm: 8 * INCH, heightMm: 10 * INCH },
  '8x8': { paper: '8x8', label: '8 × 8 in square', widthMm: 8 * INCH, heightMm: 8 * INCH },
};

export const DEFAULT_PAPER: PaperSize = 'a5';
export const DEFAULT_BLEED_MM = 3;
export const DEFAULT_PRINT_DPI = 300;
export const MAX_BLEED_MM = 10;
export const MIN_PRINT_DPI = 72;
export const MAX_PRINT_DPI = 600;

/** The print settings of a print output (`PrintOutputSchema` without its id, name and kind). */
export interface PrintSettings {
  /** `book`, or the id of another output (a post) whose pages are printed. */
  source: string;
  imposition: PrintImposition;
  paper: PaperSize;
  orientation: PrintOrientation;
  /** Bleed on every outside edge, in millimetres. */
  bleedMm: number;
  /** Crop marks (and fold marks on spreads) in a slug outside the bleed. */
  marks: boolean;
  /** Resolution the photos are embedded at, in pixels per inch of the printed size. */
  dpi: number;
}

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  source: 'book',
  imposition: 'pages',
  paper: DEFAULT_PAPER,
  orientation: 'portrait',
  bleedMm: DEFAULT_BLEED_MM,
  // On by default with the default bleed: once the sheet is larger than the page, the marks are what show the trim.
  marks: true,
  dpi: DEFAULT_PRINT_DPI,
};

/** Named settings the inspector offers in one click (they keep the print's source and the pages' orientation). */
export const PRINT_PRESETS = {
  /** A folded zine: A5 reader spreads, 3 mm bleed, crop and fold marks. */
  zine: {
    label: 'Zine',
    description: 'A5 spreads, 3 mm bleed, crop marks',
    settings: { imposition: 'spreads', paper: 'a5', bleedMm: 3, marks: true, dpi: 300 },
  },
} as const satisfies Record<
  string,
  { label: string; description: string; settings: Omit<PrintSettings, 'source' | 'orientation'> }
>;

export type PrintPresetName = keyof typeof PRINT_PRESETS;

/** Preset `name`'s settings for pages of `template`: the preset's, in the pages' orientation. */
export function presetSettings(
  name: PrintPresetName,
  template: Pick<BookTemplate, 'width' | 'height'>,
): Omit<PrintSettings, 'source'> {
  const orientation: PrintOrientation = template.width > template.height ? 'landscape' : 'portrait';
  return { ...PRINT_PRESETS[name].settings, orientation };
}

/** Ratios this close (relative) count as the same, so an A4 book (1080 × 1527) fills A4 paper (210 × 297). */
export const FIT_TOLERANCE = 0.01;

/** Crop marks: the gap between the bleed edge and a mark, the mark's length, and the margin outside it. */
export const MARK_GAP_MM = 1;
export const MARK_LENGTH_MM = 5;
export const MARK_MARGIN_MM = 1;
/** Line width of the marks, in points (a hairline). */
export const MARK_STROKE_PT = 0.25;

export interface PrintBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The paper's size in millimetres in the chosen orientation. */
export function paperSize(paper: PaperSize, orientation: PrintOrientation = 'portrait'): { w: number; h: number } {
  const p = PAPER_PRESETS[paper] ?? PAPER_PRESETS[DEFAULT_PAPER];
  const short = Math.min(p.widthMm, p.heightMm);
  const long = Math.max(p.widthMm, p.heightMm);
  return orientation === 'landscape' ? { w: long, h: short } : { w: short, h: long };
}

/**
 * The paper a new print of a book on `template` starts on: the paper whose ratio is the page's (4:5 → 8 × 10 in, 1:1 →
 * 8 × 8 in, A4 pages → A4, landscape when the page is), else A5 in the page's orientation.
 */
export function paperForTemplate(template: Pick<BookTemplate, 'width' | 'height'>): {
  paper: PaperSize;
  orientation: PrintOrientation;
} {
  const orientation: PrintOrientation = template.width > template.height ? 'landscape' : 'portrait';
  const ratio = template.width / template.height;
  const order: PaperSize[] = ['8x10', '8x8', 'a4', 'letter', 'a5'];
  for (const paper of order) {
    const size = paperSize(paper, orientation);
    if (sameRatio(size.w / size.h, ratio)) return { paper, orientation };
  }
  return { paper: DEFAULT_PAPER, orientation };
}

/** Print settings for a new print of a book on `template`: the defaults on the paper that matches its pages. */
export function defaultPrintSettings(template: Pick<BookTemplate, 'width' | 'height'>): PrintSettings {
  return { ...DEFAULT_PRINT_SETTINGS, ...paperForTemplate(template) };
}

/** Whether two ratios (width / height) are equal within `FIT_TOLERANCE`. */
export function sameRatio(a: number, b: number): boolean {
  return Math.abs(a / b - 1) <= FIT_TOLERANCE;
}

type Geometry = Pick<PrintSettings, 'paper' | 'orientation' | 'imposition' | 'bleedMm' | 'marks'>;

/** Width of the slug outside the bleed: room for the marks, or nothing without them. */
export function slugMm(settings: Pick<PrintSettings, 'marks'>): number {
  return settings.marks ? MARK_GAP_MM + MARK_LENGTH_MM + MARK_MARGIN_MM : 0;
}

/** The size of one PDF page: the trim plus the bleed and the slug on every side. */
export function sheetSize(settings: Geometry): { w: number; h: number } {
  const trim = trimBox(settings);
  const edge = settings.bleedMm + slugMm(settings);
  return { w: trim.w + 2 * edge, h: trim.h + 2 * edge };
}

/** The finished size on the sheet: one page, or two side by side for spreads. */
export function trimBox(settings: Geometry): PrintBox {
  const paper = paperSize(settings.paper, settings.orientation);
  const edge = settings.bleedMm + slugMm(settings);
  const w = settings.imposition === 'spreads' ? 2 * paper.w : paper.w;
  return { x: edge, y: edge, w, h: paper.h };
}

/** The trim grown by the bleed: what is printed. Without marks it is the whole sheet. */
export function bleedBox(settings: Geometry): PrintBox {
  const trim = trimBox(settings);
  const b = settings.bleedMm;
  return { x: trim.x - b, y: trim.y - b, w: trim.w + 2 * b, h: trim.h + 2 * b };
}

/** One page's place on a sheet: which page (0-based), its trim box, and which of its edges are outside edges. */
export interface PlacedPage {
  page: number;
  /** The page's own trim (half the sheet's trim on a spread). */
  trim: PrintBox;
  /** Edges on the sheet's outside, which bleed. The spine side of a spread page does not. */
  bleeds: { top: boolean; right: boolean; bottom: boolean; left: boolean };
}

export interface PrintSheet {
  /** The pages on this sheet: one for `pages`; one or two for `spreads` (the cover and an even last page are alone). */
  pages: PlacedPage[];
}

/**
 * Which pages go on which sheet. `pages`: one each. `spreads`: reader spreads as a book opens, the first page alone on
 * the right half, then 2–3, 4–5, …, and an even last page alone on the left half (the other half stays blank).
 */
export function imposePages(pageCount: number, settings: Geometry): PrintSheet[] {
  const trim = trimBox(settings);
  const all = { top: true, right: true, bottom: true, left: true };
  if (settings.imposition === 'pages') {
    return Array.from({ length: pageCount }, (_, page) => ({ pages: [{ page, trim, bleeds: all }] }));
  }
  const half = trim.w / 2;
  const left = (page: number): PlacedPage => ({
    page,
    trim: { ...trim, w: half },
    bleeds: { ...all, right: false },
  });
  const right = (page: number): PlacedPage => ({
    page,
    trim: { ...trim, x: trim.x + half, w: half },
    bleeds: { ...all, left: false },
  });
  const sheets: PrintSheet[] = [];
  if (pageCount === 0) return sheets;
  sheets.push({ pages: [right(0)] });
  for (let p = 1; p < pageCount; p += 2) {
    sheets.push({ pages: p + 1 < pageCount ? [left(p), right(p + 1)] : [left(p)] });
  }
  return sheets;
}

/**
 * Where a page of `template`'s ratio sits inside its trim: the whole trim when the ratios match within
 * `FIT_TOLERANCE`, else the largest box of the page's ratio, centred (the rest is the page's background colour).
 */
export function printContentBox(
  trim: PrintBox,
  template: Pick<BookTemplate, 'width' | 'height'>,
): PrintBox & { fills: boolean } {
  const ratio = template.width / template.height;
  if (sameRatio(trim.w / trim.h, ratio)) return { ...trim, fills: true };
  const w = Math.min(trim.w, trim.h * ratio);
  const h = w / ratio;
  return { x: trim.x + (trim.w - w) / 2, y: trim.y + (trim.h - h) / 2, w, h, fills: false };
}

/** A straight line on the sheet, in millimetres. */
export interface MarkLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The crop marks of a sheet: two short lines at each corner of the trim, on the trim's lines but outside the bleed
 * (they start `MARK_GAP_MM` past the bleed edge), and on spreads a fold mark above and below the spine. None without
 * `marks`.
 */
export function cropMarks(settings: Geometry): MarkLine[] {
  if (!settings.marks) return [];
  const t = trimBox(settings);
  const start = settings.bleedMm + MARK_GAP_MM;
  const end = start + MARK_LENGTH_MM;
  const right = t.x + t.w;
  const bottom = t.y + t.h;
  const lines: MarkLine[] = [];
  for (const y of [t.y, bottom]) {
    lines.push({ x1: t.x - end, y1: y, x2: t.x - start, y2: y });
    lines.push({ x1: right + start, y1: y, x2: right + end, y2: y });
  }
  for (const x of [t.x, right]) {
    lines.push({ x1: x, y1: t.y - end, x2: x, y2: t.y - start });
    lines.push({ x1: x, y1: bottom + start, x2: x, y2: bottom + end });
  }
  if (settings.imposition === 'spreads') {
    const spine = t.x + t.w / 2;
    lines.push({ x1: spine, y1: t.y - end, x2: spine, y2: t.y - start });
    lines.push({ x1: spine, y1: bottom + start, x2: spine, y2: bottom + end });
  }
  return lines;
}

/** Millimetres to PDF points (1/72 in). */
export const mmToPt = (mm: number): number => (mm * 72) / INCH;

/** Millimetres to pixels at `dpi`. */
export const mmToPx = (mm: number, dpi: number): number => (mm * dpi) / INCH;

/** A one-line summary for the inspector and the Export sheet: "A5 portrait spreads, 154 × 216 mm with bleed". */
export function printSummary(settings: Geometry): string {
  const paper = PAPER_PRESETS[settings.paper] ?? PAPER_PRESETS[DEFAULT_PAPER];
  const bleed = bleedBox(settings);
  const round = (v: number) => Math.round(v * 10) / 10;
  const what = settings.imposition === 'spreads' ? 'spreads' : 'pages';
  return `${paper.label} ${settings.orientation} ${what}, ${round(bleed.w)} × ${round(bleed.h)} mm with bleed`;
}

/** The PDF's file name for a print named `name`: its slug plus `.pdf` (`print.pdf` when nothing is left). */
export function printFileName(slug: string): string {
  return `${slug || 'print'}.pdf`;
}
