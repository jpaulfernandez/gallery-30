import {
  type Asset,
  type Book,
  type BookTemplateName,
  type Crop,
  createEmptyBook,
  createEmptyPage,
  type Frame,
  LAYOUT_BLANK,
  LAYOUT_CUSTOM,
  type LayoutData,
  newId,
  type Page,
  type PageBackground,
  type PhotoElement,
  parseBook,
  reflowLayout,
  resolveTheme,
  type SlotRatio,
  serializeBook,
  applyLayout as sharedApplyLayout,
  setSlotRatio as sharedSetSlotRatio,
  type Theme,
  templateFor,
} from '@photobook/shared';
import type { Draft } from 'immer';
import { temporal } from 'zundo';
import { create, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { clampCrop, cropFit } from '../lib/crop';
import {
  type FrameGridOptions,
  photoDropFrame,
  type SplitAxis,
  withFrame,
  withFrameGrid,
  withMergedFrames,
  withSplitFrame,
} from '../lib/frames';
import { newCaption } from '../lib/grid';
import { devLog } from '../lib/log';
import { basename } from '../lib/path';
import { openBook, setRecent, writeBook } from '../lib/tauri';

/**
 * The document store: `book` is exactly the project file. Every action is an Immer recipe, and
 * zundo's `temporal` tracks `book` for undo and redo (UI state lives in ./ui.ts and is never undone).
 *
 * History rules:
 * - One action = one undo step, except inside `beginGesture()` / `endGesture()`, which records the
 *   whole gesture (a pan drag, a zoom slider drag, a pinch) as a single step.
 * - Idle gestures (`createIdleGesture`: pinch, color picker) end on their own after a pause; undo,
 *   redo and every discrete action (rotate, filter, layout, page and slot edits) end them first,
 *   so the gesture is its own step and is what the next undo reverts.
 * - Loading or closing a book clears the history.
 * - `fillAssets`, `replaceAssetId` and `removeAssets` (scan bookkeeping) are never undo steps, and undo/redo keep the newest asset
 *   metadata (see `applyHistory`) so undoing an edit never forgets a hash or a size.
 */

type PageElement = Page['elements'][number];
type Filter = PhotoElement['filter'];
type Shape = NonNullable<PhotoElement['shape']>;

interface LoadOptions {
  /** Create and write a new book when the folder has no project file. Default true. */
  create?: boolean;
  /** Page size of a book created here (ignored when the folder already has a project). Default phone portrait. */
  template?: BookTemplateName;
}

export interface BookState {
  /** The open project document, exactly as stored in book.photobook.json. */
  book: Book | null;
  /** Absolute path of the source folder the book lives in. */
  folder: string | null;
  /** Replace the whole document (one undo step). */
  setBook: (book: Book) => void;
  /**
   * Open the book in `folder`, creating an empty book of `options.template` (default phone portrait)
   * if none exists (unless `create: false`, in which case it resolves to null). Records the folder as recent.
   */
  loadFromFolder: (folder: string, options?: LoadOptions) => Promise<Book | null>;
  /** Wait for autosave to write the open book, then close it. */
  close: () => Promise<void>;

  setTitle: (title: string) => void;
  /** Merge publish settings (slug, visibility, the publish record). One undo step. */
  setPublish: (patch: Partial<Book['publish']>) => void;
  /**
   * Change the page size to a preset (`templateFor`). Frames are page fractions, so elements stretch
   * to the new ratio; photo crops are re-clamped so every photo still covers its slot. One undo step;
   * not available for `custom` or when the template is already the one set.
   */
  setTemplate: (name: BookTemplateName) => void;
  /** Merge book-wide theme tokens (margin, gutter, grid, ...). One undo step. */
  setTheme: (patch: Partial<Theme>) => void;
  /**
   * Background color new pages get (`theme.defaultPageBackground`). Not `discrete`, so the color
   * picker's idle gesture makes a drag one undo step.
   */
  setDefaultPageBackground: (color: string) => void;
  /**
   * Re-fit every page to its layout with the current theme (margin, gutter changed): geometry only
   * (shared `reflowLayout`), so photo slots and text items move to the recomputed frames by index
   * and elements without a slot (extra text, extra photos) are left alone; nothing is added or
   * deleted. Blank pages, hand-edited pages (`LAYOUT_CUSTOM`), the book's custom layouts (captured
   * in page fractions, the theme does not change them) and unknown ids are skipped. One undo step;
   * returns how many pages were re-flowed.
   */
  reapplyLayouts: () => number;
  /** Mutate one page in place (Immer draft). */
  updatePage: (pageId: string, fn: (page: Draft<Page>) => void) => void;
  /**
   * Mutate one element in place (Immer draft). Content only (text, style): frame changes go through
   * `setFrames`, which marks the page custom.
   */
  updateElement: (pageId: string, elementId: string, fn: (el: Draft<PageElement>) => void) => void;
  /**
   * Put an asset in a photo slot (or empty it with null). Resets crop and rotation, which belonged
   * to the previous photo. `asset` adds the `book.assets` entry when the id is not there yet (a
   * filmstrip file dropped before its hash landed), so the book never holds a dangling id.
   */
  setElementAsset: (pageId: string, elementId: string, assetId: string | null, asset?: Asset) => void;
  /** Swap the photos of two slots on a page: asset, rotation and filter travel, crops reset. */
  swapAssets: (pageId: string, elementA: string, elementB: string) => void;
  /** Set a slot's crop, clamped so the photo always covers the slot (see lib/crop.ts). */
  setCrop: (pageId: string, elementId: string, crop: Crop) => void;
  /** Rotate a photo 90 degrees clockwise. */
  rotateElement: (pageId: string, elementId: string) => void;
  setFilter: (pageId: string, elementId: string, filter: Filter) => void;
  /**
   * Set a slot's clip shape (`rect` removes it). The crop is kept: clipping does not change the cover
   * math. A circle also makes the frame square in page pixels around its centre (shrunk to its short
   * side, kept on the page), sets the 1:1 ratio and re-clamps the pan for the new slot; when that
   * moves the frame the page becomes custom (`LAYOUT_CUSTOM`).
   */
  setShape: (pageId: string, elementId: string, shape: Shape) => void;
  /** Shared `setSlotRatio` against the page's layout frame (library or the book's custom layouts) and the book theme. */
  setSlotRatio: (pageId: string, elementId: string, ratio: SlotRatio) => void;
  /** Shared `applyLayout` (library, custom or blank): photos keep their ids and order. */
  applyLayout: (pageId: string, layoutId: string) => void;
  /**
   * Set a color or photo background. For a photo, `asset` adds the `book.assets` entry when the id
   * is not there yet (as in `setElementAsset`); an unknown id without it is refused.
   */
  setPageBackground: (pageId: string, background: PageBackground, asset?: Asset) => void;
  /**
   * Insert a blank page (no elements, `theme.defaultPageBackground`) at `index` (default: the end).
   * Returns its id.
   */
  addPage: (index?: number) => string | null;
  /** Copy a page right after itself with a new page id and new element ids. Returns the new id. */
  duplicatePage: (pageId: string) => string | null;
  /** Remove a page (one undo step). The last page can be deleted too. */
  deletePage: (pageId: string) => void;
  /** Move the page at `from` to index `to`. Page and element ids never change. */
  movePage: (from: number, to: number) => void;
  /** Add an empty caption at the page's bottom margin (see lib/grid.ts) and mark the page custom. Returns its id. */
  addText: (pageId: string) => string | null;
  /**
   * Remove an element from a page (text boxes, empty frames; filled slots are emptied with
   * `setElementAsset`). The page becomes custom.
   */
  removeElement: (pageId: string, elementId: string) => void;
  /**
   * Delete key on a selection (one undo step): text boxes and empty frames are removed, filled
   * photo frames are emptied (a second Delete then removes the frame). Removing anything marks the
   * page custom.
   */
  deleteElements: (pageId: string, elementIds: readonly string[]) => void;
  /**
   * Set element frames (a resize or move drag step, a nudge, an inspector field). Photo crops are
   * re-clamped against the new slot, and a page whose frames changed becomes custom
   * (`LAYOUT_CUSTOM`), so re-flowing layouts never undoes hand edits. Not `discrete`, so it can run
   * inside a gesture.
   */
  setFrames: (pageId: string, frames: Readonly<Record<string, Frame>>) => void;
  /**
   * Drop a photo on a page area that is not a slot: fill the page's first empty frame, or else add
   * a new frame holding it (the largest frame of the photo's aspect inside the safe margins,
   * centred) and mark the page custom. `asset` adds the `book.assets` entry as in
   * `setElementAsset`. Returns the frame's id.
   */
  dropPhotoOnPage: (pageId: string, assetId: string, asset?: Asset) => string | null;
  /** Add an empty photo frame (after the last photo) and mark the page custom. Returns its id. */
  addFrame: (pageId: string, frame: Frame) => string | null;
  /** Fill the page with a grid of empty frames, keeping filled photos (see lib/frames.ts `withFrameGrid`). */
  addFrameGrid: (pageId: string, options: FrameGridOptions) => string[];
  /** Merge two or more photo frames into one at their bounding box. Returns the kept frame's id. */
  mergeFrames: (pageId: string, elementIds: readonly string[]) => string | null;
  /** Split a photo frame in two with a gutter. Returns both ids (the original first). */
  splitFrame: (pageId: string, elementId: string, axis: SplitAxis) => [string, string] | null;
  /**
   * Add a layout to `book.customLayouts` (one undo step); with `pageId`, that page now uses it. The
   * layout always gets a fresh `custom-<ulid>` id (any incoming id is ignored), so it can never clash
   * with a library layout or another custom one. Returns the new id.
   */
  addCustomLayout: (layout: LayoutData, pageId?: string) => string | null;
  renameCustomLayout: (layoutId: string, name: string) => void;
  /** Remove a custom layout; pages that used it become custom pages (their frames stay). */
  removeCustomLayout: (layoutId: string) => void;
  /** Merge scan metadata into `book.assets`. Not an undo step. */
  fillAssets: (assets: Record<string, Asset>) => void;
  /**
   * Point every element and page background that uses `fromId` at `toId` and delete the `fromId`
   * entry (Locate onto a file another, unused asset id held). Not an undo step.
   */
  replaceAssetId: (fromId: string, toId: string) => void;
  /** Delete `book.assets` entries (unused files gone from the folder). Not an undo step. */
  removeAssets: (ids: string[]) => void;
}

type HistoryState = { book: Book | null };

/** zundo's internal "push this past state" function, captured through the `handleSet` option. */
let recordHistory: ((past: HistoryState, current: HistoryState) => void) | null = null;

function findPage(book: Draft<Book> | null, pageId: string): Draft<Page> | undefined {
  return book?.pages.find((p) => p.id === pageId);
}

function findPhoto(book: Draft<Book> | null, pageId: string, elementId: string): Draft<PhotoElement> | undefined {
  const el = findPage(book, pageId)?.elements.find((e) => e.id === elementId);
  return el?.type === 'photo' ? el : undefined;
}

const EMPTY_CROP: Crop = { x: 0, y: 0, scale: 1 };

/** A hand edit (frame moved or resized, element added or deleted): the page no longer follows a layout. */
function markCustom(page: Draft<Page> | undefined): void {
  if (page && page.layout !== LAYOUT_CUSTOM) page.layout = LAYOUT_CUSTOM;
}

/**
 * Immer recipe step: put `page` in place of the page with `pageId`, with its photo crops re-clamped.
 * `page` may share (frozen) elements with the current state, so crops are fixed on copies.
 */
function replacePage(s: Draft<BookState>, pageId: string, page: Page): void {
  const book = s.book;
  const index = book?.pages.findIndex((p) => p.id === pageId) ?? -1;
  if (!book || index < 0) return;
  const fit = { assets: book.assets, template: book.template };
  const elements = page.elements.map((el) => {
    if (el.type !== 'photo') return el;
    const crop = clampCrop(el.crop, cropFit(fit, el));
    const same = crop.x === el.crop.x && crop.y === el.crop.y && crop.scale === el.crop.scale;
    return same ? el : { ...el, crop };
  });
  book.pages[index] = { ...page, elements };
}

/** Wrap a discrete action so any open idle gesture is recorded as its own step first. */
function discrete<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    flushIdleGestures();
    return fn(...args);
  };
}

let flushSave: () => Promise<void> = async () => {};

/** Autosave registers its flush here, so closing or switching books waits for the write. */
export function setSaveFlusher(fn: (() => Promise<void>) | null): void {
  flushSave = fn ?? (async () => {});
}

export const useBookStore = create<BookState>()(
  temporal(
    immer((set, get) => ({
      book: null,
      folder: null,

      setBook: discrete((book: Book) => set({ book })),

      loadFromFolder: async (folder, { create = true, template } = {}) => {
        // Write the current book before open_book moves the Rust scope to the new folder.
        flushIdleGestures();
        await flushSave();
        const text = await openBook(folder);
        let book: Book;
        if (text !== null) {
          book = parseBook(text);
        } else if (create) {
          book = createEmptyBook({ title: basename(folder), sourceFolder: folder, template });
          await writeBook(folder, serializeBook(book));
        } else {
          return null;
        }
        await setRecent(folder);
        set({ book, folder });
        useBookStore.temporal.getState().clear();
        devLog('book', 'loaded', { title: book.title, pages: book.pages.length, folder });
        return book;
      },

      close: async () => {
        flushIdleGestures();
        await flushSave();
        set({ book: null, folder: null });
        useBookStore.temporal.getState().clear();
      },

      setTitle: (title) =>
        set((s) => {
          if (s.book) s.book.title = title;
        }),

      setPublish: discrete((patch: Partial<Book['publish']>) =>
        set((s) => {
          if (!s.book) return;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            (s.book.publish as Record<string, unknown>)[key] = value;
          }
        }),
      ),

      setTemplate: discrete((name: BookTemplateName) => {
        const book = get().book;
        if (!book || name === 'custom' || book.template.name === name) return;
        const next = templateFor(name);
        set((s) => {
          if (!s.book) return;
          s.book.template = next;
          // The slot's pixel ratio changed with the page's: keep each photo covering its slot.
          for (const page of s.book.pages) {
            for (const el of page.elements) {
              if (el.type !== 'photo') continue;
              const crop = clampCrop(el.crop, cropFit(s.book, el));
              if (crop.x !== el.crop.x || crop.y !== el.crop.y || crop.scale !== el.crop.scale) el.crop = crop;
            }
          }
        });
        devLog('book', 'template changed', { from: book.template.name, to: name });
      }),

      setTheme: discrete((patch: Partial<Theme>) =>
        set((s) => {
          if (!s.book) return;
          for (const [key, value] of Object.entries(patch) as Array<[keyof Theme, Theme[keyof Theme]]>) {
            if (value === undefined || s.book.theme[key] === value) continue;
            (s.book.theme as Record<keyof Theme, unknown>)[key] = value;
          }
        }),
      ),

      setDefaultPageBackground: (color) =>
        set((s) => {
          if (s.book && s.book.theme.defaultPageBackground !== color) s.book.theme.defaultPageBackground = color;
        }),

      reapplyLayouts: discrete(() => {
        const book = get().book;
        if (!book) return 0;
        const custom = new Set(book.customLayouts.map((l) => l.id));
        let count = 0;
        const pages = book.pages.map((page) => {
          if (page.layout === LAYOUT_BLANK || page.layout === LAYOUT_CUSTOM || custom.has(page.layout)) return page;
          // Unknown ids (hand-edited file) come back as the same page.
          const next = reflowLayout(page, book.theme, book.template, book.customLayouts);
          if (next !== page) count += 1;
          return next;
        });
        if (count === 0) return 0;
        set((s) => {
          // Re-clamp each pan against its new slot (on copies: unchanged elements are frozen state).
          pages.forEach((page, i) => {
            if (page !== book.pages[i]) replacePage(s, page.id, page);
          });
        });
        return count;
      }),

      updatePage: (pageId, fn) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (page) fn(page);
        }),

      updateElement: (pageId, elementId, fn) =>
        set((s) => {
          const el = findPage(s.book, pageId)?.elements.find((e) => e.id === elementId);
          if (el) fn(el);
        }),

      setElementAsset: discrete((pageId: string, elementId: string, assetId: string | null, asset?: Asset) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el || !s.book) return;
          if (assetId !== null && !(assetId in s.book.assets)) {
            if (!asset) return;
            s.book.assets[assetId] = asset;
          }
          el.asset = assetId;
          el.crop = { ...EMPTY_CROP };
          el.rotate = 0;
        }),
      ),

      swapAssets: discrete((pageId: string, elementA: string, elementB: string) =>
        set((s) => {
          if (elementA === elementB) return;
          const a = findPhoto(s.book, pageId, elementA);
          const b = findPhoto(s.book, pageId, elementB);
          if (!a || !b) return;
          const held = { asset: a.asset, rotate: a.rotate, filter: a.filter };
          a.asset = b.asset;
          a.rotate = b.rotate;
          a.filter = b.filter;
          b.asset = held.asset;
          b.rotate = held.rotate;
          b.filter = held.filter;
          a.crop = { ...EMPTY_CROP };
          b.crop = { ...EMPTY_CROP };
        }),
      ),

      setCrop: (pageId, elementId, crop) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el) return;
          // Clamp against the asset's size, the slot frame and the template (old rule if size unknown).
          const next = clampCrop(crop, cropFit(s.book, el));
          if (next.x === el.crop.x && next.y === el.crop.y && next.scale === el.crop.scale) return;
          el.crop = next;
        }),

      rotateElement: discrete((pageId: string, elementId: string) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el) return;
          el.rotate = ((el.rotate + 90) % 360) as PhotoElement['rotate'];
          // The cover size changes with the rotation, so the stored pan must stay in range.
          el.crop = clampCrop(el.crop, cropFit(s.book, el));
        }),
      ),

      setFilter: discrete((pageId: string, elementId: string, filter: Filter) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (el) el.filter = filter;
        }),
      ),

      setShape: discrete((pageId: string, elementId: string, shape: Shape) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el || !s.book) return;
          if (shape.kind === 'rect') {
            if (el.shape) delete el.shape;
          } else if (JSON.stringify(el.shape) !== JSON.stringify(shape)) {
            el.shape = shape;
          }
          if (shape.kind !== 'circle') return;
          const { width, height } = s.book.template;
          const f = el.frame;
          const side = Math.min(f.w * width, f.h * height, width, height);
          const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
          const w = r6(side / width);
          const h = r6(side / height);
          const x = r6(Math.min(Math.max(f.x + (f.w - w) / 2, 0), 1 - w));
          const y = r6(Math.min(Math.max(f.y + (f.h - h) / 2, 0), 1 - h));
          if (x !== f.x || y !== f.y || w !== f.w || h !== f.h) {
            el.frame = { x, y, w, h };
            el.crop = clampCrop(el.crop, cropFit(s.book, el));
            markCustom(findPage(s.book, pageId));
          }
          if (el.ratio !== '1:1') el.ratio = '1:1';
        }),
      ),

      setSlotRatio: discrete((pageId: string, elementId: string, ratio: SlotRatio) => {
        const book = get().book;
        const index = book?.pages.findIndex((p) => p.id === pageId) ?? -1;
        const page = book?.pages[index];
        if (!book || !page) return;
        const next = sharedSetSlotRatio(page, elementId, ratio, book.template, book.theme, book.customLayouts);
        if (next === page) return;
        set((s) => {
          if (!s.book) return;
          s.book.pages[index] = next;
          // The slot's aspect changed, so re-clamp the pan against the new cover size.
          const el = findPhoto(s.book, pageId, elementId);
          if (el) el.crop = clampCrop(el.crop, cropFit(s.book, el));
        });
      }),

      applyLayout: discrete((pageId: string, layoutId: string) => {
        const book = get().book;
        const index = book?.pages.findIndex((p) => p.id === pageId) ?? -1;
        const page = book?.pages[index];
        if (!book || !page) return;
        const next = sharedApplyLayout(page, layoutId, book.theme, book.template, book.customLayouts);
        set((s) => {
          if (!s.book) return;
          s.book.pages[index] = next;
          // Every slot may have a new frame, so re-clamp each pan against its new cover size.
          for (const el of s.book.pages[index]?.elements ?? []) {
            if (el.type === 'photo') el.crop = clampCrop(el.crop, cropFit(s.book, el));
          }
        });
      }),

      setPageBackground: (pageId, background, asset) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || !s.book) return;
          if (typeof background === 'object' && !(background.asset in s.book.assets)) {
            if (!asset) return;
            s.book.assets[background.asset] = asset;
          }
          page.background = background;
        }),

      addPage: discrete((index?: number) => {
        const book = get().book;
        if (!book) return null;
        // A blank page, whatever `createEmptyPage` puts on it: layouts are applied on purpose.
        const page: Page = {
          ...createEmptyPage(resolveTheme(book.theme).defaultPageBackground),
          layout: LAYOUT_BLANK,
          elements: [],
        };
        const at = Math.min(Math.max(index ?? book.pages.length, 0), book.pages.length);
        set((s) => {
          s.book?.pages.splice(at, 0, page);
        });
        return page.id;
      }),

      duplicatePage: discrete((pageId: string) => {
        const book = get().book;
        const index = book?.pages.findIndex((p) => p.id === pageId) ?? -1;
        const source = book?.pages[index];
        if (!source) return null;
        const copy: Page = structuredClone(source);
        copy.id = newId();
        for (const el of copy.elements) el.id = newId();
        set((s) => {
          s.book?.pages.splice(index + 1, 0, copy);
        });
        return copy.id;
      }),

      deletePage: discrete((pageId: string) =>
        set((s) => {
          const index = s.book?.pages.findIndex((p) => p.id === pageId) ?? -1;
          if (index >= 0) s.book?.pages.splice(index, 1);
        }),
      ),

      movePage: discrete((from: number, to: number) =>
        set((s) => {
          const pages = s.book?.pages;
          if (!pages || from === to) return;
          if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) return;
          const [page] = pages.splice(from, 1);
          if (page) pages.splice(to, 0, page);
        }),
      ),

      addText: discrete((pageId: string) => {
        const book = get().book;
        if (!book?.pages.some((p) => p.id === pageId)) return null;
        const text = newCaption(book.template, book.theme);
        set((s) => {
          const page = findPage(s.book, pageId);
          page?.elements.push(text);
          markCustom(page);
        });
        return text.id;
      }),

      removeElement: discrete((pageId: string, elementId: string) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          const index = page?.elements.findIndex((e) => e.id === elementId) ?? -1;
          if (!page || index < 0) return;
          page.elements.splice(index, 1);
          markCustom(page);
        }),
      ),

      deleteElements: discrete((pageId: string, elementIds: readonly string[]) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || elementIds.length === 0) return;
          const ids = new Set(elementIds);
          for (const el of page.elements) {
            if (ids.has(el.id) && el.type === 'photo' && el.asset !== null) {
              el.asset = null;
              el.crop = { ...EMPTY_CROP };
              el.rotate = 0;
              ids.delete(el.id);
            }
          }
          if (ids.size === 0) return;
          const kept = page.elements.filter((el) => !ids.has(el.id));
          if (kept.length === page.elements.length) return;
          page.elements = kept;
          markCustom(page);
        }),
      ),

      setFrames: (pageId, frames) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || !s.book) return;
          let changed = false;
          for (const el of page.elements) {
            const f = frames[el.id];
            if (!f) continue;
            const same = el.frame.x === f.x && el.frame.y === f.y && el.frame.w === f.w && el.frame.h === f.h;
            if (same) continue;
            el.frame = { x: f.x, y: f.y, w: f.w, h: f.h };
            if (el.type === 'photo') el.crop = clampCrop(el.crop, cropFit(s.book, el));
            changed = true;
          }
          if (changed) markCustom(page);
        }),

      dropPhotoOnPage: discrete((pageId: string, assetId: string, asset?: Asset) => {
        const book = get().book;
        const page = book?.pages.find((p) => p.id === pageId);
        if (!book || !page) return null;
        if (!(assetId in book.assets) && !asset) return null;
        const empty = page.elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset === null);
        if (empty) {
          get().setElementAsset(pageId, empty.id, assetId, asset);
          return empty.id;
        }
        const known = book.assets[assetId] ?? asset;
        const frame = photoDropFrame(known, resolveTheme(book.theme), book.template);
        const id = newId();
        const next = withFrame(page, frame, id);
        set((s) => {
          if (!s.book) return;
          if (!(assetId in s.book.assets) && asset) s.book.assets[assetId] = asset;
          replacePage(s, pageId, {
            ...next,
            elements: next.elements.map((el) => (el.id === id && el.type === 'photo' ? { ...el, asset: assetId } : el)),
          });
        });
        return id;
      }),

      addFrame: discrete((pageId: string, frame: Frame) => {
        const page = get().book?.pages.find((p) => p.id === pageId);
        if (!page) return null;
        const id = newId();
        set((s) => replacePage(s, pageId, withFrame(page, frame, id)));
        return id;
      }),

      addFrameGrid: discrete((pageId: string, options: FrameGridOptions) => {
        const book = get().book;
        const page = book?.pages.find((p) => p.id === pageId);
        if (!book || !page) return [];
        const next = withFrameGrid(page, options, resolveTheme(book.theme), book.template);
        set((s) => replacePage(s, pageId, next));
        return next.elements.filter((e) => e.type === 'photo').map((e) => e.id);
      }),

      mergeFrames: discrete((pageId: string, elementIds: readonly string[]) => {
        const page = get().book?.pages.find((p) => p.id === pageId);
        const merged = page ? withMergedFrames(page, elementIds) : null;
        if (!merged) return null;
        set((s) => replacePage(s, pageId, merged.page));
        return merged.id;
      }),

      splitFrame: discrete((pageId: string, elementId: string, axis: SplitAxis) => {
        const book = get().book;
        const page = book?.pages.find((p) => p.id === pageId);
        const split =
          book && page ? withSplitFrame(page, elementId, axis, resolveTheme(book.theme), book.template) : null;
        if (!split) return null;
        set((s) => replacePage(s, pageId, split.page));
        return split.ids;
      }),

      addCustomLayout: discrete((layout: LayoutData, pageId?: string) => {
        if (!get().book) return null;
        // Always a fresh id: an incoming one could shadow a library layout or another custom one.
        const id = `custom-${newId()}`;
        set((s) => {
          if (!s.book) return;
          s.book.customLayouts.push({ ...structuredClone(layout), id, source: 'custom', group: 'custom' });
          const page = pageId ? findPage(s.book, pageId) : undefined;
          if (page) page.layout = id;
        });
        return id;
      }),

      renameCustomLayout: discrete((layoutId: string, name: string) =>
        set((s) => {
          const layout = s.book?.customLayouts.find((l) => l.id === layoutId);
          const trimmed = name.trim();
          if (layout && trimmed && layout.name !== trimmed) layout.name = trimmed;
        }),
      ),

      removeCustomLayout: discrete((layoutId: string) =>
        set((s) => {
          if (!s.book) return;
          const index = s.book.customLayouts.findIndex((l) => l.id === layoutId);
          if (index < 0) return;
          s.book.customLayouts.splice(index, 1);
          for (const page of s.book.pages) if (page.layout === layoutId) page.layout = LAYOUT_CUSTOM;
        }),
      ),

      fillAssets: (assets) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book) return;
            for (const [id, asset] of Object.entries(assets)) s.book.assets[id] = asset;
          }),
        ),

      replaceAssetId: (fromId, toId) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book || fromId === toId || !(fromId in s.book.assets)) return;
            for (const page of s.book.pages) {
              if (typeof page.background === 'object' && page.background.asset === fromId) page.background.asset = toId;
              for (const el of page.elements) if (el.type === 'photo' && el.asset === fromId) el.asset = toId;
            }
            delete s.book.assets[fromId];
          }),
        ),

      removeAssets: (ids) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book) return;
            for (const id of ids) delete s.book.assets[id];
          }),
        ),
    })),
    {
      partialize: (s): HistoryState => ({ book: s.book }),
      limit: 200,
      equality: (a, b) => a.book === b.book,
      handleSet: (handleSet) => {
        const push = handleSet as unknown as (
          past: HistoryState,
          replace: undefined,
          current: HistoryState,
          delta: null,
        ) => void;
        recordHistory = (past, current) => push(past, undefined, current, null);
        return handleSet;
      },
    },
  ),
);

// History helpers ------------------------------------------------------------------------------

let pauseDepth = 0;

function pauseHistory() {
  pauseDepth += 1;
  if (pauseDepth === 1) useBookStore.temporal.getState().pause();
}

function resumeHistory() {
  if (pauseDepth === 0) return;
  pauseDepth -= 1;
  if (pauseDepth === 0) useBookStore.temporal.getState().resume();
}

/** Run `fn` without recording undo history (nests with gestures). */
export function withoutHistory<T>(fn: () => T): T {
  pauseHistory();
  try {
    return fn();
  } finally {
    resumeHistory();
  }
}

let gesture: { depth: number; start: Book | null } | null = null;

/**
 * Start a continuous gesture: changes until the matching `endGesture()` become one undo step.
 * Calls nest; only the outermost pair records.
 */
export function beginGesture(): void {
  if (gesture) {
    gesture.depth += 1;
    return;
  }
  gesture = { depth: 1, start: useBookStore.getState().book };
  pauseHistory();
}

/** End a gesture and record it as a single undo step if the book changed. */
export function endGesture(): void {
  if (!gesture) return;
  gesture.depth -= 1;
  if (gesture.depth > 0) return;
  const { start } = gesture;
  gesture = null;
  resumeHistory();
  const current = useBookStore.getState().book;
  if (start && current && start !== current) recordHistory?.({ book: start }, { book: current });
}

export const isGestureActive = (): boolean => gesture !== null;

/** End functions of the idle gestures that are open right now. */
const openIdleGestures = new Set<() => void>();

export interface IdleGesture {
  /** Call before each change; opens the gesture on the first call. */
  touch: () => void;
  /** End the gesture now (no-op when none is open). */
  end: () => void;
}

/**
 * A gesture with no clear end (pinch wheel events, the native color picker): it ends `idleMs`
 * after the last `touch()`, or earlier through `flushIdleGestures()`.
 */
export function createIdleGesture(idleMs: number): IdleGesture {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    openIdleGestures.delete(end);
    endGesture();
  };
  const touch = () => {
    if (timer) clearTimeout(timer);
    else {
      beginGesture();
      openIdleGestures.add(end);
    }
    timer = setTimeout(end, idleMs);
  };
  return { touch, end };
}

/** End every open idle gesture now, recording each as its own undo step. */
export function flushIdleGestures(): void {
  for (const end of [...openIdleGestures]) end();
}

function applyHistory(kind: 'undo' | 'redo'): boolean {
  flushIdleGestures();
  if (gesture) return false;
  const t = useBookStore.temporal.getState();
  if ((kind === 'undo' ? t.pastStates : t.futureStates).length === 0) return false;
  const before = useBookStore.getState().book;
  t[kind]();
  const after = useBookStore.getState().book;
  // Scan metadata is not history: keep the newest entries over the restored ones.
  if (before && after && before.id === after.id && before.assets !== after.assets) {
    withoutHistory(() =>
      useBookStore.setState((s) => {
        if (s.book) s.book.assets = { ...after.assets, ...before.assets };
      }),
    );
  }
  const next = useBookStore.temporal.getState();
  devLog('history', kind, { past: next.pastStates.length, future: next.futureStates.length });
  return true;
}

export const undo = (): boolean => applyHistory('undo');
export const redo = (): boolean => applyHistory('redo');

/** canUndo / canRedo for the top bar buttons. */
export function useHistoryAvailability(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useStore(useBookStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useBookStore.temporal, (s) => s.futureStates.length > 0);
  return { canUndo, canRedo };
}
