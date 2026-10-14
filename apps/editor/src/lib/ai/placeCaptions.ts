import type { BookTemplate, Frame, Page, TextElement } from '@photobook/shared';

/**
 * Workflow plan 35: where the captions of a page go (pure, so the review lists exactly what Apply does). A page
 * caption or one caption per photo lands in the page's caption slots: the text elements in the caption style, which
 * every captioned layout creates (`cap`, `cap1`, `capR`, `overlay` items). A photo's caption takes the slot that belongs
 * to it (the slot nearest that photo); the rest take the free slots in page order; when every slot is taken, a caption
 * joins the slot nearest its photo (a shared caption strip holds the captions of every photo it serves). A page with no
 * caption slot gets one new caption element at the bottom margin (`captionFrame`) holding every caption.
 */

/** One caption to place: about one photo (`assetId`), or the whole page (`null`). */
export interface PageCaption {
  assetId: string | null;
  text: string;
  /** Alt text of `assetId` (recorded when the photo has none yet). */
  alt?: string;
}

/** Where a text goes: an existing caption slot, or a new caption element (`elementId: null`). */
export interface CaptionPlacement {
  elementId: string | null;
  /** The full text the element ends with. */
  text: string;
  /** The captions it holds (asset ids, `null` for the page caption), in order. */
  assetIds: Array<string | null>;
  /** The element's text before (empty for a new element). */
  replaces: string;
}

/** Gap between two frames (0 when they touch or overlap), in page widths: `aspect` is the page's height / width. */
function gap(a: Frame, b: Frame, aspect: number): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)) * aspect;
  return Math.hypot(dx, dy);
}

const FULL_PAGE: Frame = { x: 0, y: 0, w: 1, h: 1 };

/** Ends a sentence: a full stop, question or exclamation mark or ellipsis, maybe followed by closing quotes or brackets. */
const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]*$/;

/**
 * Captions sharing one text box, as one text: each but the last gets a full stop when it does not end a sentence
 * already ("We wait" + "The hill." reads "We wait. The hill."), then a space.
 */
export function joinCaptions(texts: readonly string[]): string {
  return texts.map((t, i) => (i < texts.length - 1 && !SENTENCE_END.test(t) ? `${t}.` : t)).join(' ');
}

/** The page's caption slots: its text elements in the caption style, in page order. */
export function captionSlots(page: Pick<Page, 'elements'>): TextElement[] {
  return page.elements.filter((e): e is TextElement => e.type === 'text' && e.style === 'caption');
}

/** True when the page has a caption with text in it. */
export function pageHasCaption(page: Pick<Page, 'elements'>): boolean {
  return captionSlots(page).some((e) => e.text.trim() !== '');
}

/** The photos of a page (asset ids, the background first, then the photo elements in page order), unique. */
export function pagePhotoIds(page: Pick<Page, 'elements' | 'background'>): string[] {
  const ids: string[] = [];
  if (typeof page.background === 'object') ids.push(page.background.asset);
  for (const e of page.elements) if (e.type === 'photo' && e.asset) ids.push(e.asset);
  return [...new Set(ids)];
}

/** Each photo's frame on the page (its first photo element, or the whole page for the background photo). */
function photoFrames(page: Pick<Page, 'elements' | 'background'>): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  for (const e of page.elements) {
    if (e.type === 'photo' && e.asset && !frames.has(e.asset)) frames.set(e.asset, e.frame);
  }
  if (typeof page.background === 'object' && !frames.has(page.background.asset)) {
    frames.set(page.background.asset, FULL_PAGE);
  }
  return frames;
}

/**
 * Where `captions` go on `page` (see the module doc). Blank captions are left out; the result lists each element that
 * changes once, the new element (if any) last.
 */
export function placeCaptions(
  page: Pick<Page, 'elements' | 'background'>,
  captions: readonly PageCaption[],
  template: Pick<BookTemplate, 'width' | 'height'>,
): CaptionPlacement[] {
  const entries = captions
    .map((c) => ({ assetId: c.assetId, text: c.text.replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.text !== '');
  if (entries.length === 0) return [];
  const slots = captionSlots(page);
  if (slots.length === 0) {
    return [
      {
        elementId: null,
        text: joinCaptions(entries.map((c) => c.text)),
        assetIds: entries.map((c) => c.assetId),
        replaces: '',
      },
    ];
  }

  const aspect = template.height / template.width;
  const frames = photoFrames(page);
  const slotGap = (slot: TextElement, assetId: string | null): number => {
    const frame = assetId ? frames.get(assetId) : undefined;
    return frame ? gap(slot.frame, frame, aspect) : 0;
  };
  /** The photo each slot belongs to: the nearest one (page order breaks ties). */
  const owner = new Map<string, string | null>();
  for (const slot of slots) {
    let best: string | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const [assetId, frame] of frames) {
      const g = gap(slot.frame, frame, aspect);
      if (g < bestGap) {
        best = assetId;
        bestGap = g;
      }
    }
    owner.set(slot.id, best);
  }

  const placed = new Map<string, { text: string[]; assetIds: Array<string | null> }>();
  const put = (slot: TextElement, entry: { assetId: string | null; text: string }) => {
    const at = placed.get(slot.id) ?? { text: [], assetIds: [] };
    at.text.push(entry.text);
    at.assetIds.push(entry.assetId);
    placed.set(slot.id, at);
  };
  const free = (slot: TextElement) => !placed.has(slot.id);

  // 1. A photo's caption takes its own slot.
  const deferred: typeof entries = [];
  for (const entry of entries) {
    const own = entry.assetId ? slots.find((s) => free(s) && owner.get(s.id) === entry.assetId) : undefined;
    if (own) put(own, entry);
    else deferred.push(entry);
  }
  // 2. The page caption first, then the photos without a slot of their own: free slots, the empty ones first.
  deferred.sort((a, b) => Number(a.assetId !== null) - Number(b.assetId !== null));
  for (const entry of deferred) {
    const open = slots.filter(free);
    const slot = open.find((s) => s.text.trim() === '') ?? open[0];
    if (slot) {
      put(slot, entry);
      continue;
    }
    // 3. Every slot is taken: join the slot nearest the photo (the first slot for the page caption).
    const nearest = [...slots].sort((a, b) => slotGap(a, entry.assetId) - slotGap(b, entry.assetId))[0] as TextElement;
    put(nearest, entry);
  }

  return slots.flatMap((slot) => {
    const at = placed.get(slot.id);
    return at ? [{ elementId: slot.id, text: joinCaptions(at.text), assetIds: at.assetIds, replaces: slot.text }] : [];
  });
}
