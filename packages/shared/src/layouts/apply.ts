import { newId } from '../ids.js';
import { TEXT_PRESETS } from '../renderer/text.js';
import type {
  BookTemplate,
  Frame,
  LayoutData,
  LayoutItem,
  Page,
  PhotoElement,
  TextElement,
  TextKind,
  Theme,
} from '../schema.js';
import { LAYOUT_BLANK } from './blank.js';
import { layoutItems } from './data.js';
import { getLayout } from './layouts.js';
import { heroIndex } from './library.js';
import type { LayoutDef } from './types.js';

/** Margin and gutter (width fractions); `wideGutter` is used by library layouts when present. */
type Spacing = Pick<Theme, 'margin' | 'gutter'> & Partial<Pick<Theme, 'wideGutter'>>;
type Size = Pick<BookTemplate, 'width' | 'height'>;

/** Slot ratios offered in the inspector (width:height). */
export const SLOT_RATIOS = ['3:2', '4:3', '1:1', '4:5', '2:3', '3:4'] as const;
export type SlotRatio = (typeof SLOT_RATIOS)[number];

/** "4:5" -> 0.8 (width / height). */
export function ratioValue(ratio: SlotRatio): number {
  const [w, h] = ratio.split(':').map(Number);
  return (w ?? 1) / (h ?? 1);
}

export type LayoutTextFrame = Frame & { kind: TextKind };

const frameOf = ({ x, y, w, h }: Frame): Frame => ({ x, y, w, h });

/**
 * A layout's frames for one book: photo slots in order, every text item in order (`texts`), the
 * first text item as `caption` (kept for older callers), and all `items` in reading order.
 */
export function layoutFrames(
  layout: LayoutDef,
  theme: Spacing,
  template: Size,
): { slots: Frame[]; caption: Frame | undefined; texts: LayoutTextFrame[]; items: LayoutItem[] } {
  const items = layoutItems(layout, theme, template);
  const slots: Frame[] = [];
  const texts: LayoutTextFrame[] = [];
  for (const it of items) {
    if (it.kind === 'photo') slots.push(frameOf(it));
    else texts.push({ ...frameOf(it), kind: it.kind });
  }
  const first = texts[0];
  return { slots, caption: first ? frameOf(first) : undefined, texts, items };
}

export interface WireframeFrame extends Frame {
  kind: 'photo' | 'text';
  /** The text role, on text frames. */
  textKind?: TextKind;
  /** The layout's hero photo (see `heroIndex`), for highlighting in the picker. */
  hero?: boolean;
}

/** Frames the layout picker draws as a wireframe thumbnail: photo slots, then text frames, in order. */
export function layoutWireframe(layout: LayoutDef, theme: Spacing, template: Size): WireframeFrame[] {
  const items = layoutItems(layout, theme, template);
  const hero = heroIndex(items);
  const photos: WireframeFrame[] = [];
  const texts: WireframeFrame[] = [];
  items.forEach((it, i) => {
    if (it.kind === 'photo')
      photos.push(i === hero ? { ...frameOf(it), kind: 'photo', hero: true } : { ...frameOf(it), kind: 'photo' });
    else texts.push({ ...frameOf(it), kind: 'text', textKind: it.kind });
  });
  return [...photos, ...texts];
}

/** Font size of a `key` item (numbered key entries), fraction of the page height. */
export const KEY_TEXT_SIZE = 0.018;

/**
 * The text element a layout text item becomes: `cap`/`cap1`/`capR` are captions (`capR` right
 * aligned), `overlay` a white caption with `overlay: true`, `title`/`titleLg` titles (`titleLg` at
 * twice the size), `para` body, `quote` the quote preset, `cell` body in a tinted `box`, and `key`
 * small body text.
 */
export function textForLayoutItem(kind: TextKind, frame: Frame, id: string = newId(), text = ''): TextElement {
  const base: TextElement = { type: 'text', id, text, style: 'caption', frame: frameOf(frame), align: 'left' };
  switch (kind) {
    case 'cap':
    case 'cap1':
      return base;
    case 'capR':
      return { ...base, align: 'right' };
    case 'overlay':
      return { ...base, color: '#ffffff', overlay: true };
    case 'title':
      return { ...base, style: 'title' };
    case 'titleLg':
      return { ...base, style: 'title', size: TEXT_PRESETS.title.size * 2 };
    case 'para':
      return { ...base, style: 'body' };
    case 'quote':
      return { ...base, style: 'quote' };
    case 'cell':
      return { ...base, style: 'body', box: true };
    case 'key':
      return { ...base, style: 'body', size: KEY_TEXT_SIZE };
  }
}

const isPhoto = (el: Page['elements'][number]): el is PhotoElement => el.type === 'photo';
const isText = (el: Page['elements'][number]): el is TextElement => el.type === 'text';

function requireLayout(id: string, customLayouts?: readonly LayoutData[]): LayoutDef {
  const layout = getLayout(id, customLayouts);
  if (!layout) throw new Error(`unknown layout "${id}"`);
  return layout;
}

/**
 * Re-flow a page into another layout, resolved from the library, the legacy layouts or the book's
 * `customLayouts`. `LAYOUT_BLANK` empties the page.
 *
 * Photos: existing photos keep their ids, asset, crop, rotation and filter and are poured into the
 * new photo items in reading order: filled slots first (in page order), then the page's empty
 * slots, then new empty ones. What does not fit is dropped from the page (empty slots go before
 * any photo; dropped photos stay in the filmstrip). Crops are not re-clamped here (that needs the
 * asset sizes; the editor store does it).
 *
 * Text: one text element per text item, in order. The page's first N text elements (N = the
 * layout's text items) keep their id and text and take the item's frame and style (family and
 * weight overrides survive when the style is unchanged); missing ones are created empty. Text
 * elements beyond the layout's text items are kept unchanged at their own frames, after the
 * layout's texts, unless they are empty (an empty extra box is an unused placeholder and is dropped).
 *
 * Elements come out as photos, then texts, so overlay text paints above its photo.
 */
export function applyLayout(
  page: Page,
  layoutId: string,
  theme: Spacing,
  template: Size,
  customLayouts?: readonly LayoutData[],
): Page {
  if (layoutId === LAYOUT_BLANK) return { ...page, layout: LAYOUT_BLANK, elements: [] };
  const layout = requireLayout(layoutId, customLayouts);
  const { slots, texts: textItems } = layoutFrames(layout, theme, template);
  const all = page.elements.filter(isPhoto);
  const photos = [...all.filter((el) => el.asset !== null), ...all.filter((el) => el.asset === null)];

  const nextPhotos: PhotoElement[] = slots.map((frame, i) => {
    const prev = photos[i];
    if (prev) {
      // The slot ratio belonged to the old frame.
      const { ratio: _ratio, ...rest } = prev;
      return { ...rest, frame: { ...frame } };
    }
    return {
      type: 'photo',
      id: newId(),
      asset: null,
      frame: { ...frame },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    };
  });

  const oldTexts = page.elements.filter(isText);
  const nextTexts: TextElement[] = textItems.map(({ kind, ...frame }, i) => {
    const prev = oldTexts[i];
    if (!prev) return textForLayoutItem(kind, frame);
    const next = textForLayoutItem(kind, frame, prev.id, prev.text);
    if (prev.style === next.style) {
      if (prev.family !== undefined) next.family = prev.family;
      if (prev.weight !== undefined) next.weight = prev.weight;
    }
    return next;
  });
  const extraTexts = oldTexts.slice(textItems.length).filter((t) => t.text.trim() !== '');

  return { ...page, layout: layoutId, elements: [...nextPhotos, ...nextTexts, ...extraTexts] };
}

/**
 * Re-fit a page to its own layout after the theme or page size changed (margin, gutter), touching
 * geometry only. When `page.layout` resolves (library, legacy or `customLayouts`), the page's photo
 * elements take the layout's photo slots by index (page order) and its text elements the layout's
 * text items by index: only `frame` changes, and a photo with an inspector `ratio` is re-fitted to
 * that ratio inside its new slot (`setSlotRatio`). Elements with no slot (extra photos, extra text)
 * are left exactly as they are, nothing is added, removed or reordered, and content (assets, crops,
 * text, styles) is untouched; crops are not re-clamped (the editor store does it).
 *
 * Returns the same page object when the layout does not resolve (blank, custom frames, unknown id).
 */
export function reflowLayout(page: Page, theme: Spacing, template: Size, customLayouts?: readonly LayoutData[]): Page {
  const layout = getLayout(page.layout, customLayouts);
  if (!layout) return page;
  const { slots, texts: textItems } = layoutFrames(layout, theme, template);
  let photoIndex = 0;
  let textIndex = 0;
  let changed = false;
  const ratioed: Array<[string, SlotRatio]> = [];
  const elements = page.elements.map((el) => {
    const target = el.type === 'photo' ? slots[photoIndex++] : textItems[textIndex++];
    if (!target) return el;
    if (el.type === 'photo' && el.ratio && isSlotRatio(el.ratio)) ratioed.push([el.id, el.ratio]);
    const frame = frameOf(target);
    if (sameFrame(el.frame, frame)) return el;
    changed = true;
    return { ...el, frame };
  });
  let next: Page = changed ? { ...page, elements } : page;
  for (const [id, ratio] of ratioed) next = setSlotRatio(next, id, ratio, template, theme, customLayouts);
  return next;
}

const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const isSlotRatio = (r: string): r is SlotRatio => (SLOT_RATIOS as readonly string[]).includes(r);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Give a photo slot a new aspect ratio (in page pixels). The new frame is the largest rectangle of
 * that ratio that fits the reference box, centred on the slot's current centre, then shrunk if
 * needed so it stays inside the page. The reference box is the slot's frame in the page's layout
 * when `theme` is given (so toggling ratios never shrinks the slot step by step and never spills
 * into a neighbour), otherwise the slot's current frame.
 */
export function setSlotRatio(
  page: Page,
  elementId: string,
  ratio: SlotRatio,
  template: Size,
  theme?: Spacing,
  customLayouts?: readonly LayoutData[],
): Page {
  const photos = page.elements.filter(isPhoto);
  const index = photos.findIndex((el) => el.id === elementId);
  const el = photos[index];
  if (!el) return page;

  const W = template.width;
  const H = template.height;
  const layout = theme ? getLayout(page.layout, customLayouts) : undefined;
  const ref = (layout && theme && layoutFrames(layout, theme, template).slots[index]) || el.frame;

  const r = ratioValue(ratio);
  // Contain within the reference box, in pixels.
  let w = ref.w * W;
  let h = w / r;
  if (h > ref.h * H) {
    h = ref.h * H;
    w = h * r;
  }

  // Shrink around the current centre so the frame stays inside the page.
  const cx = (el.frame.x + el.frame.w / 2) * W;
  const cy = (el.frame.y + el.frame.h / 2) * H;
  const maxW = 2 * Math.min(cx, W - cx);
  const maxH = 2 * Math.min(cy, H - cy);
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;

  const x = clamp01((cx - w / 2) / W);
  const y = clamp01((cy - h / 2) / H);
  const frame: Frame = { x, y, w: Math.min(w / W, 1 - x), h: Math.min(h / H, 1 - y) };

  return {
    ...page,
    elements: page.elements.map((e) => (e.id === elementId && e.type === 'photo' ? { ...e, frame, ratio } : e)),
  };
}
