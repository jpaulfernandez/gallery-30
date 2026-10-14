import { type Book, type Brief, LAYOUT_CUSTOM, locatePage, normalizeAlt } from '@photobook/shared';
import type { Draft } from 'immer';
import { type PageCaption, placeCaptions } from '../lib/ai/placeCaptions';
import { newCaption } from '../lib/grid';
// A cycle (book.ts builds this slice): only used when an action runs, never while the store is created.
import { withoutHistory } from './book';

/**
 * AI captions (workflow plan 34): the book store's actions for the caption brief and for using a written caption. The
 * brief is project data (`book.captions.brief`, saved in the project file and nowhere else), so setting it is one undo
 * step like any other project edit. Using a caption replaces the text element's text, and records the photo's alt
 * text with it when the photo has none (an existing alt is never overwritten), in one `set`: one undo step. (Undo restores the text; like every asset field but develop, the newest
 * `alt` is kept, see `applyHistory`.)
 */

export interface CaptionsSlice {
  /** Save the caption brief (null removes it). One undo step; nothing happens when it is unchanged. */
  setBrief: (brief: Brief | null) => void;
  /**
   * Replace the text of text element `elementId` on page `pageId` (a book page or an output's frame) with `text`, and
   * set `alt.assetId`'s alt text when given, not blank, and the photo has none yet. One undo step.
   */
  writeCaption: (pageId: string, elementId: string, text: string, alt?: { assetId: string; alt: string }) => void;
  // Workflow plan 35 (page and book captions, alt text).
  /**
   * Place `captions` on page `pageId` (`placeCaptions`: the page's caption slots, else one new caption element at the
   * bottom margin) and record each photo's alt text when it has none yet. One undo step; false when nothing changed.
   */
  applyCaptions: (pageId: string, captions: readonly PageCaption[]) => boolean;
  /**
   * Set (or, when blank, remove) a photo's alt text, published with the book (`normalizeAlt`: one line, at most 125
   * characters). Not an undo step: like every asset field
   * but develop, the newest alt survives undo (see `applyHistory`), so a step would undo nothing.
   */
  setAssetAlt: (assetId: string, alt: string) => void;
  // End of plan 35.
}

type SliceState = { book: Book | null };
type SliceSet = (recipe: (draft: Draft<SliceState>) => void) => void;

const sameBrief = (a: Brief | undefined, b: Brief | null): boolean =>
  (a ?? null) === b || (a !== undefined && b !== null && JSON.stringify(a) === JSON.stringify(b));

export function createCaptionsSlice(
  set: SliceSet,
  get: () => SliceState,
  discrete: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R,
): CaptionsSlice {
  return {
    setBrief: discrete((brief: Brief | null) => {
      const book = get().book;
      if (!book || sameBrief(book.captions.brief, brief)) return;
      set((s) => {
        if (!s.book) return;
        if (brief) s.book.captions.brief = structuredClone(brief);
        else delete s.book.captions.brief;
      });
    }),

    writeCaption: discrete(
      (pageId: string, elementId: string, text: string, alt?: { assetId: string; alt: string }) => {
        const book = get().book;
        const at = book ? locatePage(book, pageId) : undefined;
        const element = at?.pages[at.index]?.elements.find((e) => e.id === elementId);
        if (!book || element?.type !== 'text') return;
        const altText = alt?.alt.trim() ?? '';
        const asset = alt && altText ? book.assets[alt.assetId] : undefined;
        // An alt the photo already has (the author's, or an earlier one) is never replaced here.
        const writeAlt = Boolean(asset && altText && !asset.alt?.trim());
        if (element.text === text && !writeAlt) return;
        set((s) => {
          if (!s.book) return;
          const draftAt = locatePage(s.book, pageId);
          const el = draftAt?.pages[draftAt.index]?.elements.find((e) => e.id === elementId);
          if (el?.type === 'text') el.text = text;
          const target = alt && writeAlt ? s.book.assets[alt.assetId] : undefined;
          if (target) target.alt = altText;
        });
      },
    ),

    // Workflow plan 35.
    applyCaptions: discrete((pageId: string, captions: readonly PageCaption[]) => {
      const book = get().book;
      const at = book ? locatePage(book, pageId) : undefined;
      const page = at?.pages[at.index];
      if (!book || !at || !page) return false;
      const placements = placeCaptions(page, captions, at.template).filter(
        (p) => p.elementId === null || p.text !== p.replaces,
      );
      const alts = new Map<string, string>();
      for (const c of captions) {
        const alt = normalizeAlt(c.alt);
        if (
          c.assetId &&
          alt &&
          !alts.has(c.assetId) &&
          book.assets[c.assetId] &&
          !book.assets[c.assetId]?.alt?.trim()
        ) {
          alts.set(c.assetId, alt);
        }
      }
      if (placements.length === 0 && alts.size === 0) return false;
      const fresh = placements.find((p) => p.elementId === null);
      const created = fresh ? { ...newCaption(at.template, book.theme), text: fresh.text } : null;
      set((s) => {
        if (!s.book) return;
        const draftAt = locatePage(s.book, pageId);
        const draftPage = draftAt?.pages[draftAt.index];
        if (!draftPage) return;
        for (const p of placements) {
          const el = p.elementId ? draftPage.elements.find((e) => e.id === p.elementId) : undefined;
          if (el?.type === 'text') el.text = p.text;
        }
        if (created) {
          draftPage.elements.push(created);
          // A new element makes the page custom, as Add text does.
          if (draftPage.layout !== LAYOUT_CUSTOM) draftPage.layout = LAYOUT_CUSTOM;
        }
        for (const [assetId, alt] of alts) {
          const asset = s.book.assets[assetId];
          if (asset) asset.alt = alt;
        }
      });
      return true;
    }),

    setAssetAlt: (assetId: string, alt: string) => {
      const asset = get().book?.assets[assetId];
      const value = normalizeAlt(alt);
      if (!asset || (asset.alt ?? '') === value) return;
      withoutHistory(() =>
        set((s) => {
          const target = s.book?.assets[assetId];
          if (!target) return;
          if (value) target.alt = value;
          else delete target.alt;
        }),
      );
    },
    // End of plan 35.
  };
}
