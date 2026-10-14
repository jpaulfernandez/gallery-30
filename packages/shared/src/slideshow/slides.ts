import { LAYOUT_BLANK } from '../layouts/blank.js';
import type { BookTemplate, Page } from '../schema.js';
import { frameTemplate } from '../social/templates.js';
import {
  SLIDESHOW_SIZES,
  SLIDESHOW_SOURCE_BOOK,
  SLIDESHOW_SOURCE_PICKS,
  type SlideshowOrder,
  type SlideshowSettings,
} from './settings.js';

/**
 * The slides of a slideshow (workflow plan 16): the pages it shows, in order, and their page size. A slideshow shows
 * the book's pages, a social post's frames or the project's picked photos; a picked photo becomes a page of its own
 * at the video's size, the whole photo centred on black. Pure, so the CLI and the inspector agree on the count.
 */

/** The shape of a book these helpers read (a `Book`, or an Immer draft of one). */
export interface SlideshowBook {
  pages: Page[];
  template: BookTemplate;
  assets: Record<string, { width?: number; height?: number }>;
  outputs: Array<{ id: string; kind: string; frames?: Page[]; network?: string }>;
}

export interface SlideshowSlides {
  pages: Page[];
  /** The slides' page size: the book's, the post's network's, or the video's own for picks. */
  template: BookTemplate;
}

export interface SlidesOptions {
  /** Whether asset `id` is a pick (the folder library's flag; the editor's `assetFlag`, the CLI's library read). */
  isPick: (assetId: string) => boolean;
  /** Width / height of asset `id` as rendered, when known better than `book.assets` (the CLI's processed photo). */
  aspectOf?: (assetId: string) => number | null;
}

/** Background of a picked photo's slide. */
export const PICK_SLIDE_BACKGROUND = '#000000';

/** The video size as a page size (`custom`): what a picked photo's slide is laid out on. */
export function videoTemplate(settings: Pick<SlideshowSettings, 'size'>): BookTemplate {
  const size = SLIDESHOW_SIZES[settings.size] ?? SLIDESHOW_SIZES['1080p'];
  return { name: 'custom', width: size.width, height: size.height };
}

/** Ids of the picked photos of `book`, in the project's order (the order assets were added). */
export function pickedAssetIds(book: Pick<SlideshowBook, 'assets'>, isPick: (assetId: string) => boolean): string[] {
  return Object.keys(book.assets).filter((id) => isPick(id));
}

/**
 * A page showing photo `assetId` whole, centred on black, on a page of `template`'s size. Its id is derived from the
 * asset's (`slide-<assetId>`): it never enters the book.
 */
export function pickSlide(assetId: string, aspect: number | null, template: BookTemplate): Page {
  const page = template.width / template.height;
  const a = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : page;
  const frame =
    a >= page ? { x: 0, y: (1 - page / a) / 2, w: 1, h: page / a } : { x: (1 - a / page) / 2, y: 0, w: a / page, h: 1 };
  return {
    id: `slide-${assetId}`,
    layout: LAYOUT_BLANK,
    background: PICK_SLIDE_BACKGROUND,
    guides: [],
    elements: [
      {
        type: 'photo',
        id: `slide-photo-${assetId}`,
        asset: assetId,
        frame,
        crop: { x: 0, y: 0, scale: 1 },
        rotate: 0,
        filter: 'none',
      },
    ],
  };
}

/** A small seeded generator (mulberry32) from a string, for a stable shuffle. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `items` in `order`; a shuffle is seeded by `seed` (the slideshow's id), so every export has the same order. */
export function orderSlides<T>(items: readonly T[], order: SlideshowOrder, seed: string): T[] {
  if (order === 'reverse') return [...items].reverse();
  if (order !== 'shuffle') return [...items];
  const out = [...items];
  const random = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The slides of slideshow `output` of `book`: its source's pages (the book's for `book` and for an unknown source, a
 * post's frames, or one slide per picked photo) in its order.
 */
export function slideshowSlides(
  book: SlideshowBook,
  output: Pick<SlideshowSettings, 'source' | 'order' | 'size'> & { id: string },
  options: SlidesOptions,
): SlideshowSlides {
  let pages: Page[];
  let template: BookTemplate;
  if (output.source === SLIDESHOW_SOURCE_PICKS) {
    template = videoTemplate(output);
    pages = pickedAssetIds(book, options.isPick).map((id) => {
      const asset = book.assets[id];
      const known = asset?.width && asset.height ? asset.width / asset.height : null;
      return pickSlide(id, options.aspectOf?.(id) ?? known, template);
    });
  } else {
    const post =
      output.source === SLIDESHOW_SOURCE_BOOK
        ? undefined
        : book.outputs.find((o) => o.id === output.source && o.kind === 'social');
    pages = post?.frames ?? book.pages;
    template = post ? frameTemplate(post.network) : book.template;
  }
  return { pages: orderSlides(pages, output.order, output.id), template };
}
