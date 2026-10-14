/**
 * Sort and group for storytelling (plan 56, ODDHALLS_LAYOUT_PLAN 5): the photo orders the Design filmstrip, its
 * Library tab and Cull's Filters section offer beyond time and name, and the two groupings Design adds to plan 53's
 * Group by (colour family and aspect).
 *
 * - **colour**: the dominant colour's hue family (the first of the five `palette` colours, k-means in Oklab on the
 *   proxy at 240 px, computed in `prepare`), then its lightness; near-greys come after every hue.
 * - **luminance**: the median luma (`stats.medianLum`, plan 38), dark to light.
 * - **aspect**: width ÷ height, portrait to landscape.
 * - **warmth**: the mean Oklab b of the five palette colours, cool to warm (the palette stands in for the photo, so
 *   the mean is over its five colours, not every pixel).
 * - **rating**: most stars first; **sharpness**: the sharpest tile's (`stats.sharpnessMax`) first.
 *
 * Pure: no editor import. Sorting is view state: it never writes the library or the project and never touches ids.
 * A photo without the fact a sort reads keeps its place after the photos that have it (the caller's tie-break
 * orders both runs).
 */
import { type GroupByKey, type GroupBySection, groupBy, MISSING_KEY } from './groupBy.js';

/** Every order a photo list offers. `time` and `name` are the callers' own (capture time, file name). */
export type PhotoSort = 'time' | 'name' | 'rating' | 'sharpness' | 'colour' | 'luminance' | 'aspect' | 'warmth';

export const PHOTO_SORTS: readonly PhotoSort[] = [
  'time',
  'name',
  'rating',
  'sharpness',
  'colour',
  'luminance',
  'aspect',
  'warmth',
];

export const PHOTO_SORT_LABELS: Record<PhotoSort, string> = {
  time: 'Capture time',
  name: 'Name',
  rating: 'Rating',
  sharpness: 'Sharpness',
  colour: 'Colour',
  luminance: 'Luminance',
  aspect: 'Aspect',
  warmth: 'Warmth',
};

/** What the storytelling sorts read of a photo (the index facts; extra fields are ignored). */
export interface SortEntry {
  /** Five sRGB hex colours, most of the picture first. */
  palette?: readonly string[];
  stats?: { medianLum?: number; sharpnessMax?: number };
  /** Upright pixel size. */
  width?: number;
  height?: number;
  rating?: number;
}

/** A colour in Oklab: lightness 0..1, a (green → red), b (blue → yellow). */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** `#rrggbb` (or `rrggbb`) in Oklab; undefined when it is not a hex colour. */
export function hexToOklab(hex: string): Oklab | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 16);
  const r = toLinear(((n >> 16) & 255) / 255);
  const g = toLinear(((n >> 8) & 255) / 255);
  const b = toLinear((n & 255) / 255);
  // Björn Ottosson's matrices (the same as `crates/develop/src/stats.rs`).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  };
}

/** The colour families of the colour sort and grouping, in hue order, then the near-greys. */
export type ColourFamily = 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'pink' | 'neutral';

export const COLOUR_FAMILIES: readonly ColourFamily[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'neutral',
];

export const COLOUR_FAMILY_LABELS: Record<ColourFamily, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  cyan: 'Cyan',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  neutral: 'Neutral',
};

/** Below this Oklab chroma a colour reads as grey: its hue says nothing. */
export const NEUTRAL_CHROMA = 0.04;

/**
 * Upper hue bounds (degrees in Oklab) of each family, red wrapping through 0°: the midpoints between the sRGB
 * primaries' and secondaries' hues (red 29°, orange 58°, yellow 110°, green 142°, cyan 195°, blue 264°, purple 290°,
 * magenta 328°).
 */
const FAMILY_BOUNDS: ReadonlyArray<[ColourFamily, number]> = [
  ['red', 44],
  ['orange', 85],
  ['yellow', 126],
  ['green', 170],
  ['cyan', 230],
  ['blue', 280],
  ['purple', 315],
  ['pink', 350],
];

/** Hue of an Oklab colour, degrees in [0, 360). */
export const oklabHue = (c: Oklab): number => ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;

/** The family of an Oklab colour. */
export function colourFamily(c: Oklab): ColourFamily {
  if (Math.hypot(c.a, c.b) < NEUTRAL_CHROMA) return 'neutral';
  const h = oklabHue(c);
  for (const [family, upper] of FAMILY_BOUNDS) if (h < upper) return family;
  return 'red';
}

/** The dominant (first) palette colour in Oklab. */
export function dominantColour(e: SortEntry): Oklab | undefined {
  const first = e.palette?.[0];
  return first ? hexToOklab(first) : undefined;
}

/** Mean Oklab b of the palette (positive warm, negative cool). */
export function paletteWarmth(e: SortEntry): number | undefined {
  const colours = (e.palette ?? []).flatMap((hex) => hexToOklab(hex) ?? []);
  if (colours.length === 0) return undefined;
  return colours.reduce((sum, c) => sum + c.b, 0) / colours.length;
}

/** Width ÷ height, when both are known. */
export function aspectOf(e: SortEntry): number | undefined {
  return e.width && e.height ? e.width / e.height : undefined;
}

/** Within this of 1, width ÷ height counts as square. */
export const SQUARE_TOLERANCE = 0.05;

export type AspectClass = 'portrait' | 'square' | 'landscape';

export const ASPECT_LABELS: Record<AspectClass, string> = {
  portrait: 'Portrait',
  square: 'Square',
  landscape: 'Landscape',
};

export function aspectClass(ratio: number): AspectClass {
  if (Math.abs(ratio - 1) <= SQUARE_TOLERANCE) return 'square';
  return ratio < 1 ? 'portrait' : 'landscape';
}

/**
 * The sort key of `e` for `sort` as numbers compared in order, ascending; undefined when the photo lacks the fact
 * (or for `time` and `name`, which the callers order themselves).
 */
export function sortKey(e: SortEntry, sort: PhotoSort): readonly number[] | undefined {
  switch (sort) {
    case 'rating':
      return [-(e.rating ?? 0)];
    case 'sharpness':
      return e.stats?.sharpnessMax === undefined ? undefined : [-e.stats.sharpnessMax];
    case 'luminance':
      return e.stats?.medianLum === undefined ? undefined : [e.stats.medianLum];
    case 'aspect': {
      const r = aspectOf(e);
      return r === undefined ? undefined : [r];
    }
    case 'warmth': {
      const w = paletteWarmth(e);
      return w === undefined ? undefined : [w];
    }
    case 'colour': {
      const c = dominantColour(e);
      return c ? [COLOUR_FAMILIES.indexOf(colourFamily(c)), c.L] : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A comparator for `sort` over items whose facts `entryOf` reads, falling back to `tie` (the caller's time or name
 * order) on equal keys; items without the fact come after those with it. For `time` and `name` it is `tie` itself.
 */
export function storyComparator<T>(
  sort: PhotoSort,
  entryOf: (item: T) => SortEntry,
  tie: (a: T, b: T) => number,
): (a: T, b: T) => number {
  if (sort === 'time' || sort === 'name') return tie;
  const keys = new Map<T, readonly number[] | undefined>();
  const keyOf = (item: T) => {
    if (!keys.has(item)) keys.set(item, sortKey(entryOf(item), sort));
    return keys.get(item);
  };
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (ka && kb) {
      for (let i = 0; i < ka.length; i++) {
        const d = (ka[i] ?? 0) - (kb[i] ?? 0);
        if (d !== 0) return d;
      }
    }
    return tie(a, b);
  };
}

/** What Design's *Group by* ▾ offers: plan 53's day, place and camera, and this plan's colour family and aspect. */
export type StoryGroupBy = 'none' | Extract<GroupByKey, 'day' | 'place' | 'camera'> | 'colour' | 'aspect';

export const STORY_GROUP_BYS: readonly StoryGroupBy[] = ['none', 'day', 'place', 'camera', 'colour', 'aspect'];

export const STORY_GROUP_BY_LABELS: Record<StoryGroupBy, string> = {
  none: 'No grouping',
  day: 'Day',
  place: 'Place',
  camera: 'Camera',
  colour: 'Colour family',
  aspect: 'Aspect',
};

/** One photo as the storytelling grouping sees it: its id, plan 53's facts and the sort facts. */
export interface StoryEntry extends SortEntry {
  id: string;
  taken?: number;
  make?: string;
  model?: string;
  gps?: { lat: number; lon: number };
}

/**
 * The labelled sections of `entries` (already sorted) for Design's *Group by*: day, place and camera through
 * `groupBy` (plan 53); colour family and aspect here, in the order each first appears, photos without the fact last.
 * `none` is one unlabelled section.
 */
export function storyGroups(entries: readonly StoryEntry[], key: StoryGroupBy): GroupBySection[] {
  if (key === 'none') return entries.length ? [{ key: 'all', label: '', ids: entries.map((e) => e.id) }] : [];
  if (key === 'day' || key === 'place' || key === 'camera') return groupBy(entries, key);
  const sections: GroupBySection[] = [];
  const byKey = new Map<string, GroupBySection>();
  const missing: string[] = [];
  for (const e of entries) {
    let k: string | undefined;
    let label = '';
    if (key === 'colour') {
      const c = dominantColour(e);
      if (c) {
        k = colourFamily(c);
        label = COLOUR_FAMILY_LABELS[k as ColourFamily];
      }
    } else {
      const r = aspectOf(e);
      if (r !== undefined) {
        k = aspectClass(r);
        label = ASPECT_LABELS[k as AspectClass];
      }
    }
    if (k === undefined) {
      missing.push(e.id);
      continue;
    }
    let section = byKey.get(k);
    if (!section) {
      section = { key: k, label, ids: [] };
      byKey.set(k, section);
      sections.push(section);
    }
    section.ids.push(e.id);
  }
  if (missing.length > 0) {
    sections.push({ key: MISSING_KEY, label: key === 'colour' ? 'No palette yet' : 'Unknown size', ids: missing });
  }
  return sections;
}
