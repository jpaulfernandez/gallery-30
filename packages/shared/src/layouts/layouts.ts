import type { Frame, LayoutData } from '../schema.js';
import { fromLayoutData } from './data.js';
import { at, cell, cols, contentBox, even, rows, spacing } from './geometry.js';
import { LAYOUT_LIBRARY } from './library.js';
import type { LayoutDef, LayoutPhotoCount } from './types.js';

export type { LayoutDef, LayoutPhotoCount, LayoutVariant } from './types.js';

/** Caption band height as a fraction of the page height. */
const CAPTION_H = 0.07;

function singleCaption(margin: number, gutter: number, aspect: number): { photo: Frame; caption: Frame } {
  const s = spacing(margin, gutter, aspect);
  const c = contentBox(s);
  const photo = { x: c.x, y: c.y, w: c.w, h: c.h - s.gy - CAPTION_H };
  return { photo, caption: { x: c.x, y: photo.y + photo.h + s.gy, w: c.w, h: CAPTION_H } };
}

/** Shorthand: content box plus spacing for the common case. */
function box(margin: number, gutter: number, aspect: number) {
  const s = spacing(margin, gutter, aspect);
  return { s, c: contentBox(s) };
}

/**
 * The first-generation layouts. Pages saved with these ids must keep resolving, so they stay in
 * `LAYOUTS` flagged `legacy` (pickers hide them).
 */
const LEGACY_LAYOUTS: ReadonlyArray<Omit<LayoutDef, 'group' | 'legacy'>> = [
  // 1 photo
  {
    id: 'single-full',
    name: 'Full bleed',
    photos: 1,
    variant: 'any',
    slots: () => [{ x: 0, y: 0, w: 1, h: 1 }],
  },
  {
    id: 'single-framed',
    name: 'Framed',
    photos: 1,
    variant: 'portrait',
    slots: (m, g, a) => [box(m, g, a).c],
  },
  {
    id: 'single-framed-landscape',
    name: 'Framed, 3:2',
    photos: 1,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { c } = box(m, g, a);
      // A 3:2 photo across the content width, centred vertically.
      const h = Math.min(c.h, (c.w * a) / 1.5);
      return [{ x: c.x, y: c.y + (c.h - h) / 2, w: c.w, h }];
    },
  },
  {
    id: 'single-caption',
    name: 'With caption',
    photos: 1,
    variant: 'any',
    slots: (m, g, a) => [singleCaption(m, g, a).photo],
    caption: (m, g, a) => singleCaption(m, g, a).caption,
  },

  // 2 photos
  {
    id: 'two-side-by-side',
    name: 'Side by side',
    photos: 2,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return cols(c, even(2), s.gx);
    },
  },
  {
    id: 'two-stacked',
    name: 'Stacked',
    photos: 2,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return rows(c, even(2), s.gy);
    },
  },
  {
    id: 'two-large-small',
    name: 'Large + small',
    photos: 2,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, [62, 38], s.gy);
      return [at(parts, 0), at(cols(at(parts, 1), even(2), s.gx), 1)];
    },
  },
  {
    id: 'two-large-small-portrait',
    name: 'Large + small, tall',
    photos: 2,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, [62, 38], s.gx);
      return [at(parts, 0), at(rows(at(parts, 1), even(2), s.gy), 1)];
    },
  },

  // 3 photos
  {
    id: 'three-hero-two',
    name: 'Hero + two',
    photos: 3,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, [58, 42], s.gy);
      return [at(parts, 0), ...cols(at(parts, 1), even(2), s.gx)];
    },
  },
  {
    id: 'three-hero-two-portrait',
    name: 'Hero + two, L',
    photos: 3,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, [62, 38], s.gx);
      return [at(parts, 0), ...rows(at(parts, 1), even(2), s.gy)];
    },
  },
  {
    id: 'three-strip',
    name: 'Three columns',
    photos: 3,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return cols(c, even(3), s.gx);
    },
  },
  {
    id: 'three-rows',
    name: 'Three rows',
    photos: 3,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return rows(c, even(3), s.gy);
    },
  },

  // 4 photos
  {
    id: 'four-grid',
    name: 'Grid',
    photos: 4,
    variant: 'any',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return rows(c, even(2), s.gy).flatMap((r) => cols(r, even(2), s.gx));
    },
  },
  {
    id: 'four-hero-column',
    name: 'Hero + column',
    photos: 4,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, [64, 36], s.gx);
      return [at(parts, 0), ...rows(at(parts, 1), even(3), s.gy)];
    },
  },
  {
    id: 'four-filmstrip-wide',
    name: 'Filmstrip + wide',
    photos: 4,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, [32, 68], s.gy);
      return [...cols(at(parts, 0), even(3), s.gx), at(parts, 1)];
    },
  },
  {
    id: 'four-filmstrip-wide-portrait',
    name: 'Filmstrip + wide, tall',
    photos: 4,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, [50, 50], s.gy);
      return [...cols(at(parts, 0), even(3), s.gx), at(parts, 1)];
    },
  },

  // 5 photos
  {
    id: 'five-hero-four',
    name: 'Hero + four',
    photos: 5,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, even(2), s.gy);
      const grid = at(parts, 1);
      return [at(parts, 0), ...rows(grid, even(2), s.gy).flatMap((r) => cols(r, even(2), s.gx))];
    },
  },
  {
    id: 'five-hero-four-portrait',
    name: 'Hero + four, side',
    photos: 5,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, even(2), s.gx);
      const grid = at(parts, 1);
      return [at(parts, 0), ...rows(grid, even(2), s.gy).flatMap((r) => cols(r, even(2), s.gx))];
    },
  },
  {
    id: 'five-two-over-three',
    name: 'Two over three',
    photos: 5,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = rows(c, [55, 45], s.gy);
      return [...cols(at(parts, 0), even(2), s.gx), ...cols(at(parts, 1), even(3), s.gx)];
    },
  },
  {
    id: 'five-two-over-three-portrait',
    name: 'Two beside three',
    photos: 5,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, even(2), s.gx);
      return [...rows(at(parts, 0), even(2), s.gy), ...rows(at(parts, 1), even(3), s.gy)];
    },
  },

  // 6 photos
  {
    id: 'six-grid-2x3',
    name: 'Grid 2 x 3',
    photos: 6,
    variant: 'landscape',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return rows(c, even(3), s.gy).flatMap((r) => cols(r, even(2), s.gx));
    },
  },
  {
    id: 'six-grid-3x2',
    name: 'Grid 3 x 2',
    photos: 6,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      return rows(c, even(2), s.gy).flatMap((r) => cols(r, even(3), s.gx));
    },
  },
  {
    id: 'six-hero-five',
    name: 'Hero + five',
    photos: 6,
    variant: 'any',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const grid = { cols: 3, rows: 3 };
      return [
        cell(c, grid, s, { c: 0, r: 0, cs: 2, rs: 2 }),
        cell(c, grid, s, { c: 2, r: 0 }),
        cell(c, grid, s, { c: 2, r: 1 }),
        cell(c, grid, s, { c: 0, r: 2 }),
        cell(c, grid, s, { c: 1, r: 2 }),
        cell(c, grid, s, { c: 2, r: 2 }),
      ];
    },
  },
  {
    id: 'six-hero-five-portrait',
    name: 'Hero + five, tall',
    photos: 6,
    variant: 'portrait',
    slots: (m, g, a) => {
      const { s, c } = box(m, g, a);
      const parts = cols(c, even(2), s.gx);
      const right = rows(at(parts, 1), even(3), s.gy);
      return [at(parts, 0), ...cols(at(right, 0), even(2), s.gx), at(right, 1), ...cols(at(right, 2), even(2), s.gx)];
    },
  },
];

/** The library (from `LAYOUT_LIBRARY`) first, then the legacy layouts. */
export const LAYOUTS: readonly LayoutDef[] = [
  ...LAYOUT_LIBRARY.map(fromLayoutData),
  ...LEGACY_LAYOUTS.map((l): LayoutDef => ({ ...l, group: 'photos', legacy: true })),
];

const BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]));

/**
 * A layout by id: the book's own `customLayouts` first, then built-in (library or legacy), the same
 * order as the editor's `findLayout`. Custom ids are `custom-<ulid>`, so they never shadow a
 * library id in practice. `'blank'` and `'custom'` are not layout definitions (see `LAYOUT_BLANK`,
 * `LAYOUT_CUSTOM`) and return undefined.
 */
export function getLayout(id: string, customLayouts?: readonly LayoutData[]): LayoutDef | undefined {
  const data = customLayouts?.find((l) => l.id === id);
  return data ? fromLayoutData(data) : BY_ID.get(id);
}

export interface LayoutListOptions {
  /** Also list the legacy layouts (default false). */
  includeLegacy?: boolean;
  /** The book's own layouts, listed after the built-in ones (group `custom`). */
  customLayouts?: readonly LayoutData[];
}

function listed(options: LayoutListOptions): LayoutDef[] {
  const builtIn = options.includeLegacy ? LAYOUTS : LAYOUTS.filter((l) => !l.legacy);
  return [...builtIn, ...(options.customLayouts ?? []).map(fromLayoutData)];
}

/** Layouts for one photo count, in picker order. Legacy layouts are left out unless asked for. */
export function layoutsForCount(photos: LayoutPhotoCount, options: LayoutListOptions = {}): LayoutDef[] {
  return listed(options).filter((l) => l.photos === photos);
}

const COUNTS = [1, 2, 3, 4, 5, 6] as const;

/** Layouts grouped by photo count (1..6), for the picker grid. Legacy layouts are left out unless asked for. */
export function layoutsByCount(
  options: LayoutListOptions = {},
): Array<{ photos: LayoutPhotoCount; layouts: LayoutDef[] }> {
  const list = listed(options);
  return COUNTS.map((photos) => ({ photos, layouts: list.filter((l) => l.photos === photos) }));
}

export interface LayoutCountGroup {
  photos: LayoutPhotoCount;
  layouts: { photos: LayoutDef[]; captioned: LayoutDef[]; custom: LayoutDef[] };
}

/**
 * Layouts by photo count, then by picker group: photos only, with text, and the book's own
 * (`customLayouts`, whatever group they were saved with). Legacy layouts are left out.
 */
export function layoutsByCountAndGroup(customLayouts: readonly LayoutData[] = []): LayoutCountGroup[] {
  const builtIn = LAYOUTS.filter((l) => !l.legacy);
  const custom = customLayouts.map(fromLayoutData);
  return COUNTS.map((photos) => {
    const n = (l: LayoutDef) => l.photos === photos;
    return {
      photos,
      layouts: {
        photos: builtIn.filter((l) => n(l) && l.group === 'photos'),
        captioned: builtIn.filter((l) => n(l) && l.group === 'captioned'),
        custom: custom.filter(n),
      },
    };
  });
}
