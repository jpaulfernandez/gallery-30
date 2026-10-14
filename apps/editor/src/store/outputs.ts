import {
  BOOK_OUTPUT_ID,
  type Book,
  createEmptyPage,
  DEFAULT_PRINT_SETTINGS,
  DEFAULT_SLIDESHOW_SETTINGS,
  DEFAULT_SOCIAL_NETWORK,
  defaultPrintSettings,
  findOutput,
  frameCapReached,
  frameTemplate,
  LAYOUT_BLANK,
  LAYOUT_CUSTOM,
  locatePage,
  MAX_BLEED_MM,
  MAX_PRINT_DPI,
  MIN_PRINT_DPI,
  newId,
  type Output,
  type OutputKind,
  type Page,
  PrintOutputSchema,
  type PrintSettings,
  printSourceId,
  reflowLayout,
  resolveTheme,
  type SocialNetwork,
  socialTemplate,
  uniqueOutputName,
} from '@photobook/shared';
import type { Draft } from 'immer';
import { clampCrop, cropFit } from '../lib/crop';
import { emptyFrame, photoDropFrame } from '../lib/frames';

/**
 * Output documents of the open project (workflow plan 13): the book store's actions that add, rename, duplicate and
 * delete entries of `book.outputs` (each one undo step), and the Design stage's current output that page actions
 * without an explicit one work on. The output on screen lives in the UI store (`ui.design.outputId`), which registers
 * itself here with `setOutputContext` (the book store cannot import the UI store: the UI store imports it).
 */

export interface OutputsSlice {
  /**
   * Add an output of `kind` named `name` (a social post starts with one blank frame, on `options.network` or the
   * default network; with `options.firstPage` its first frame is that page sent to it, as `sendPageToOutput`); returns
   * its id.
   */
  addOutput: (
    kind: OutputKind,
    name: string,
    options?: { network?: SocialNetwork; firstPage?: string },
  ) => string | null;
  /**
   * Plan 56 (the chooser's Carousel): a post on `network` (default: the 4:5 Instagram carousel) with one frame per
   * photo of `assetIds`, in that order, up to the network's frame limit: each frame the post's blank page with the
   * photo fit inside it (`photoDropFrame`). Unknown ids are skipped; null when none is left. One undo step; returns
   * the post's id.
   */
  addPhotoPost: (name: string, assetIds: readonly string[], network?: SocialNetwork) => string | null;
  /** Rename an output; a blank name is ignored. */
  renameOutput: (outputId: string, name: string) => void;
  /** Delete an output and its frames (the UI asks first). */
  deleteOutput: (outputId: string) => void;
  /** Copy an output right after it, named "<name> copy" ("<name> copy 2" when taken); its frames and elements get new ids. Returns the new id. */
  duplicateOutput: (outputId: string) => string | null;
  /**
   * Add a blank frame at the end of post `outputId` (plan 14; the book store's `addFrame` adds a photo frame to a page).
   * Returns the new frame's id, or null when the post is full (`postFull`: the UI shows `frameCapMessage`) or unknown.
   */
  addPostFrame: (outputId: string) => string | null;
  /**
   * Copy page `pageId` (from the book or another post) to the end of post `outputId`: a new page id, the same element
   * and asset ids, layout pages re-fitted to the post's page size with the layout engine (`reflowLayout`; custom frames
   * keep their page fractions) and every crop re-clamped to its new slot. Returns the new frame's id, or null when the
   * post is full or either is unknown. One undo step.
   */
  sendPageToOutput: (pageId: string, outputId: string) => string | null;
  /** Set a post's caption (the inspector commits typing after a pause, so a burst is one undo step). */
  setPostCaption: (outputId: string, caption: string) => void;
  /**
   * Change print `outputId`'s settings (plan 15: source, paper, imposition, bleed, marks, dpi). Values outside the
   * schema's ranges are clamped; one undo step per call.
   */
  setPrintSettings: (outputId: string, patch: Partial<PrintSettings>) => void;
}

/**
 * Whether document `outputId` cannot take another page: a social post with as many frames as its network allows
 * (`frameCapReached`), or a print of such a post. The book and prints of it have no cap.
 */
export function postFull(book: Pick<Book, 'outputs'>, outputId: string): boolean {
  let output = findOutput(book, outputId);
  // A print of a post (plan 15) adds its pages to the post: the post's cap applies.
  if (output?.kind === 'print') output = findOutput(book, printSourceId(book, output));
  // A slideshow of a post (plan 16) shows, and adds to, the post's frames too.
  if (output?.kind === 'slideshow') output = findOutput(book, printSourceId(book, output));
  return output?.kind === 'social' && frameCapReached(output.network, output.frames.length);
}

/**
 * `page` copied for post `outputId` of `book`: new page id, element ids kept, re-fitted to the post's page size, crops
 * clamped to the new slots.
 */
export function pageForPost(book: Book, page: Page, network: string): Page {
  const template = frameTemplate(network);
  const copy: Page = { ...structuredClone(page), id: newId() };
  const fitted = reflowLayout(copy, book.theme, template, book.customLayouts);
  const fit = { assets: book.assets, template };
  return {
    ...fitted,
    elements: fitted.elements.map((el) =>
      el.type === 'photo' ? { ...el, crop: clampCrop(el.crop, cropFit(fit, el)) } : el,
    ),
  };
}

let outputContext: () => string = () => BOOK_OUTPUT_ID;

/** Where page actions that are not given an output id add and move pages: the output on the Design stage. */
export function setOutputContext(fn: () => string): void {
  outputContext = fn;
}

/** The output the Design stage shows (`BOOK_OUTPUT_ID` until the UI store registers itself). */
export function activeOutputId(): string {
  return outputContext();
}

/** A blank page with the theme's page background: what a new page or a new post's first frame is. */
export function blankPage(book: Pick<Book, 'theme'>): Page {
  return { ...createEmptyPage(resolveTheme(book.theme).defaultPageBackground), layout: LAYOUT_BLANK, elements: [] };
}

/** A copy of `page` with new page and element ids (a copy is a new page: page ids are unique across the book). */
export function copyPage(page: Page): Page {
  const copy: Page = structuredClone(page);
  copy.id = newId();
  for (const el of copy.elements) el.id = newId();
  return copy;
}

type SliceState = { book: Book | null };
type SliceSet = (recipe: (draft: Draft<SliceState>) => void) => void;

/** The output actions of the book store; `discrete` wraps each so an open idle gesture is its own undo step first. */
export function createOutputsSlice(
  set: SliceSet,
  get: () => SliceState,
  discrete: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R,
): OutputsSlice {
  return {
    addOutput: discrete((kind: OutputKind, name: string, options?: { network?: SocialNetwork; firstPage?: string }) => {
      const book = get().book;
      if (!book) return null;
      const network = options?.network ?? DEFAULT_SOCIAL_NETWORK;
      const at = options?.firstPage ? locatePage(book, options.firstPage) : undefined;
      const source = at?.pages[at.index];
      const base = { id: newId(), name: name.trim() || 'Untitled', createdAt: Date.now() };
      const output: Output =
        kind === 'social'
          ? {
              ...base,
              kind,
              network,
              frames: [source ? pageForPost(book, source, network) : blankPage(book)],
              caption: '',
            }
          : kind === 'print'
            ? // Plan 15: a print starts on the paper that matches the book's pages (`defaultPrintSettings`).
              { ...base, kind, ...defaultPrintSettings(book.template) }
            : // Plan 16: a slideshow starts with every setting at its default.
              { ...base, kind, ...DEFAULT_SLIDESHOW_SETTINGS };
      set((s) => {
        s.book?.outputs.push(output);
      });
      return output.id;
    }),

    addPhotoPost: discrete((name: string, assetIds: readonly string[], network?: SocialNetwork) => {
      const book = get().book;
      if (!book) return null;
      const net = network ?? DEFAULT_SOCIAL_NETWORK;
      const template = frameTemplate(net);
      const theme = resolveTheme(book.theme);
      const frames = assetIds
        .filter((id) => id in book.assets)
        .slice(0, socialTemplate(net).maxFrames)
        .map(
          (id): Page => ({
            ...blankPage(book),
            layout: LAYOUT_CUSTOM,
            elements: [{ ...emptyFrame(photoDropFrame(book.assets[id], theme, template)), asset: id }],
          }),
        );
      if (frames.length === 0) return null;
      const output: Output = {
        id: newId(),
        name: name.trim() || 'Untitled',
        createdAt: Date.now(),
        kind: 'social',
        network: net,
        frames,
        caption: '',
      };
      set((s) => {
        s.book?.outputs.push(output);
      });
      return output.id;
    }),

    renameOutput: discrete((outputId: string, name: string) =>
      set((s) => {
        const output = s.book?.outputs.find((o) => o.id === outputId);
        const trimmed = name.trim();
        if (output && trimmed && output.name !== trimmed) output.name = trimmed;
      }),
    ),

    deleteOutput: discrete((outputId: string) =>
      set((s) => {
        const index = s.book?.outputs.findIndex((o) => o.id === outputId) ?? -1;
        if (index >= 0) s.book?.outputs.splice(index, 1);
      }),
    ),

    duplicateOutput: discrete((outputId: string) => {
      const book = get().book;
      const index = book?.outputs.findIndex((o) => o.id === outputId) ?? -1;
      const source = book?.outputs[index];
      if (!source) return null;
      const copy: Output = {
        ...structuredClone(source),
        id: newId(),
        name: uniqueOutputName(book ?? { outputs: [] }, `${source.name} copy`),
        createdAt: Date.now(),
      };
      if (copy.kind === 'social') copy.frames = copy.frames.map(copyPage);
      set((s) => {
        s.book?.outputs.splice(index + 1, 0, copy);
      });
      return copy.id;
    }),

    addPostFrame: discrete((outputId: string) => {
      const book = get().book;
      const output = book ? findOutput(book, outputId) : undefined;
      if (!book || output?.kind !== 'social' || postFull(book, outputId)) return null;
      const page = blankPage(book);
      set((s) => {
        const target = s.book ? findOutput(s.book, outputId) : undefined;
        if (target?.kind === 'social') target.frames.push(page);
      });
      return page.id;
    }),

    sendPageToOutput: discrete((pageId: string, outputId: string) => {
      const book = get().book;
      const output = book ? findOutput(book, outputId) : undefined;
      const at = book ? locatePage(book, pageId) : undefined;
      const source = at?.pages[at.index];
      if (!book || !source || output?.kind !== 'social' || postFull(book, outputId)) return null;
      const page = pageForPost(book, source, output.network);
      set((s) => {
        const target = s.book ? findOutput(s.book, outputId) : undefined;
        if (target?.kind === 'social') target.frames.push(page);
      });
      return page.id;
    }),

    setPostCaption: (outputId: string, caption: string) =>
      set((s) => {
        const output = s.book ? findOutput(s.book, outputId) : undefined;
        if (output?.kind === 'social' && output.caption !== caption) output.caption = caption;
      }),

    setPrintSettings: discrete((outputId: string, patch: Partial<PrintSettings>) => {
      const book = get().book;
      const output = book ? findOutput(book, outputId) : undefined;
      if (!book || output?.kind !== 'print') return;
      const next = clampPrintSettings({ ...output, ...patch });
      // A source must be the book or a post of this project (`printSourceId` would print the book anyway).
      if (printSourceId(book, next) !== next.source) next.source = BOOK_OUTPUT_ID;
      const parsed = PrintOutputSchema.safeParse(next);
      if (!parsed.success) return;
      set((s) => {
        const target = s.book ? findOutput(s.book, outputId) : undefined;
        if (target?.kind !== 'print') return;
        for (const key of PRINT_SETTING_KEYS) {
          if (target[key] !== parsed.data[key]) (target as Record<string, unknown>)[key] = parsed.data[key];
        }
      });
    }),
  };
}

/** The fields of a print output that `setPrintSettings` changes. */
const PRINT_SETTING_KEYS = ['source', 'imposition', 'paper', 'orientation', 'bleedMm', 'marks', 'dpi'] as const;

/** Print settings with the bleed and dpi brought into the schema's ranges (the inspector's fields may overshoot). */
export function clampPrintSettings<T extends PrintSettings>(settings: T): T {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    ...settings,
    bleedMm: Math.round(clamp(settings.bleedMm, 0, MAX_BLEED_MM, DEFAULT_PRINT_SETTINGS.bleedMm) * 10) / 10,
    dpi: Math.round(clamp(settings.dpi, MIN_PRINT_DPI, MAX_PRINT_DPI, DEFAULT_PRINT_SETTINGS.dpi)),
  };
}
