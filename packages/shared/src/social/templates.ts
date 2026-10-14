import { slugify } from '../ids.js';
import type { BookTemplate } from '../schema.js';

/**
 * Social post templates (workflow plan 14): one entry of data per network, no code per network. A post's frames are
 * pages whose page size is fixed by its network (`frameTemplate`); the export writes `01.jpg … NN.jpg` at the
 * template's pixel size plus `caption.txt`. Nothing is posted: the files go to the phone or a scheduler.
 *
 * The numbers were checked against each network's help pages and creator guides on `SOCIAL_TEMPLATES_CHECKED`; they
 * change, so each template carries that date and the editor shows it next to the limits.
 */

/** The date the sizes, frame limits, safe areas and caption limits below were last checked. */
export const SOCIAL_TEMPLATES_CHECKED = '2026-10-13';

/** The networks a post can be made for (`SocialOutput.network`). Stored in project files: append, never rename. */
export const SOCIAL_NETWORKS = [
  'instagram-carousel',
  'instagram-square',
  'instagram-story',
  'tiktok-photo',
  'threads',
  'bluesky',
  'x',
  'pinterest',
] as const;

export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** The network a post gets when none is chosen, and the one posts made before plan 14 had (4:5, as plan 13 drew them). */
export const DEFAULT_SOCIAL_NETWORK: SocialNetwork = 'instagram-carousel';

/** Insets from each page edge, as fractions of the page's own width (left, right) and height (top, bottom). */
export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type SocialFormat = 'jpeg' | 'png';

export interface SocialTemplate {
  network: SocialNetwork;
  /** What the picker and the inspector call it, e.g. "Instagram carousel". */
  label: string;
  /** The service, for grouping and messages ("Instagram"). */
  service: string;
  /** Display ratio, width:height. */
  ratio: string;
  /** Export size in pixels; the frames' page size. */
  width: number;
  height: number;
  /** Most frames one post can hold on this network. */
  maxFrames: number;
  /** Where the network's own interface (or the profile grid's crop) covers the frame; drawn as guides. */
  safeArea: SafeArea;
  /**
   * Which frames the safe area concerns: `first` for the profile grid's crop (only a post's first frame is shown in
   * the grid), `all` for interface that sits over every frame.
   */
  safeAreaFrames: 'first' | 'all';
  /** What the safe area is for, shown as the guides' tooltip. */
  safeAreaNote: string;
  /** The file format the network prefers (the Export sheet can switch to the other). */
  format: SocialFormat;
  /**
   * Longest caption the network accepts, in characters. Counted here as grapheme clusters (an emoji is one), which is
   * close to but not exactly every network's rule: X counts a link as 23 and a CJK character as 2.
   */
  captionLimit: number;
  /** Largest image file the network accepts, when it has a small one; a JPEG frame is re-encoded smaller to fit. */
  maxBytes?: number;
  /** When these numbers were checked (`SOCIAL_TEMPLATES_CHECKED`). */
  checked: string;
}

const NONE: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };

export const SOCIAL_TEMPLATES: Record<SocialNetwork, SocialTemplate> = {
  'instagram-carousel': {
    network: 'instagram-carousel',
    label: 'Instagram carousel',
    service: 'Instagram',
    ratio: '4:5',
    width: 1080,
    height: 1350,
    maxFrames: 20,
    // The profile grid shows a 3:4 centre crop of a 4:5 post: 33.75 px off each side.
    safeArea: { top: 0, right: 0.03125, bottom: 0, left: 0.03125 },
    safeAreaNote: 'The profile grid crops the first frame to 3:4',
    safeAreaFrames: 'first',
    format: 'jpeg',
    captionLimit: 2200,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  'instagram-square': {
    network: 'instagram-square',
    label: 'Instagram square',
    service: 'Instagram',
    ratio: '1:1',
    width: 1080,
    height: 1080,
    maxFrames: 20,
    // The profile grid shows a 3:4 centre crop of a square post: 135 px off each side.
    safeArea: { top: 0, right: 0.125, bottom: 0, left: 0.125 },
    safeAreaNote: 'The profile grid crops the first frame to 3:4',
    safeAreaFrames: 'first',
    format: 'jpeg',
    captionLimit: 2200,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  'instagram-story': {
    network: 'instagram-story',
    label: 'Instagram / Facebook story',
    service: 'Instagram',
    ratio: '9:16',
    width: 1080,
    height: 1920,
    maxFrames: 20,
    // The profile bar on top (250 px) and the reply field at the bottom (340 px).
    safeArea: { top: 250 / 1920, right: 0.06, bottom: 340 / 1920, left: 0.06 },
    safeAreaNote: 'The profile bar and the reply field cover the top and bottom',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 2200,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  'tiktok-photo': {
    network: 'tiktok-photo',
    label: 'TikTok photo slideshow',
    service: 'TikTok',
    ratio: '9:16',
    width: 1080,
    height: 1920,
    maxFrames: 35,
    // The tabs on top, the action column on the right, the caption and sound line at the bottom.
    safeArea: { top: 130 / 1920, right: 140 / 1080, bottom: 400 / 1920, left: 60 / 1080 },
    safeAreaNote: 'The tabs, the like and share column and the caption cover these edges',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 4000,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  threads: {
    network: 'threads',
    label: 'Threads',
    service: 'Threads',
    ratio: '4:5',
    width: 1080,
    height: 1350,
    maxFrames: 20,
    safeArea: NONE,
    safeAreaNote: 'Threads shows the whole frame',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 500,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  bluesky: {
    network: 'bluesky',
    label: 'Bluesky',
    service: 'Bluesky',
    ratio: '4:5',
    width: 1080,
    height: 1350,
    maxFrames: 4,
    safeArea: NONE,
    safeAreaNote: 'Bluesky shows the whole frame when opened',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 300,
    // Bluesky refuses images over about 1 MB.
    maxBytes: 1_000_000,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  x: {
    network: 'x',
    label: 'X',
    service: 'X',
    ratio: '1:1',
    width: 1080,
    height: 1080,
    maxFrames: 4,
    safeArea: NONE,
    safeAreaNote: 'X shows the whole frame when opened',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 280,
    maxBytes: 5 * 1024 * 1024,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
  pinterest: {
    network: 'pinterest',
    label: 'Pinterest pin',
    service: 'Pinterest',
    ratio: '2:3',
    width: 1000,
    height: 1500,
    maxFrames: 5,
    // The save button and the pin's menu sit over the bottom corners in the feed.
    safeArea: { top: 0, right: 0, bottom: 0.07, left: 0 },
    safeAreaNote: 'The feed puts its buttons over the bottom edge',
    safeAreaFrames: 'all',
    format: 'jpeg',
    captionLimit: 500,
    checked: SOCIAL_TEMPLATES_CHECKED,
  },
};

/** The template of `network` (the default network's for an unknown value, e.g. from a newer file). */
export function socialTemplate(network: string | undefined): SocialTemplate {
  return SOCIAL_TEMPLATES[network as SocialNetwork] ?? SOCIAL_TEMPLATES[DEFAULT_SOCIAL_NETWORK];
}

/** The page size of a post's frames on `network`: the template's pixel size under the book template name of its ratio. */
export function frameTemplate(network: string | undefined): BookTemplate {
  const t = socialTemplate(network);
  const name =
    t.ratio === '4:5' ? 'phone-portrait' : t.ratio === '1:1' ? 'square' : t.ratio === '9:16' ? 'story' : 'custom';
  return { name, width: t.width, height: t.height };
}

/** Whether a post on `network` with `count` frames is full. */
export function frameCapReached(network: string | undefined, count: number): boolean {
  return count >= socialTemplate(network).maxFrames;
}

/** The message shown when a frame would go over the network's limit. */
export function frameCapMessage(network: string | undefined): string {
  const t = socialTemplate(network);
  return `A ${t.label} post holds up to ${t.maxFrames} frames`;
}

/** The file extension of a format. */
export const socialExtension = (format: SocialFormat): string => (format === 'png' ? 'png' : 'jpg');

/** The file name of frame `index` (0-based) of a post: `01.jpg`, `02.jpg`, … (three digits past 99). */
export function frameFileName(index: number, format: SocialFormat): string {
  return `${String(index + 1).padStart(2, '0')}.${socialExtension(format)}`;
}

/** The caption file next to the frames. */
export const CAPTION_FILE = 'caption.txt';

/** The folder a post exports into, under the chosen destination: its name as a slug ("instagram-carousel"). */
export function postSlug(name: string): string {
  const slug = slugify(name);
  return slug === 'book' && !/book/i.test(name) ? 'post' : slug;
}

/**
 * The export folder of post `outputId` among the project's posts: its name as a slug, with `-2`, `-3`, … when an
 * earlier post's name gives the same slug ("Trip A" and "Trip-A"), so two posts never write into one folder.
 */
export function uniquePostSlug(
  outputs: ReadonlyArray<{ id: string; kind: string; name: string }>,
  outputId: string,
): string {
  const taken = new Set<string>();
  for (const output of outputs) {
    if (output.kind !== 'social') continue;
    const base = postSlug(output.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    if (output.id === outputId) return slug;
    taken.add(slug);
  }
  return postSlug(outputs.find((o) => o.id === outputId)?.name ?? '');
}

/** Whether frame `index` (0-based) of a post on `network` shows the safe area (`safeAreaFrames`). */
export function showsSafeArea(network: string | undefined, index: number): boolean {
  const t = socialTemplate(network);
  const { top, right, bottom, left } = t.safeArea;
  return top + right + bottom + left > 0 && (t.safeAreaFrames === 'all' || index === 0);
}

/** Characters in `text` as the networks count them (grapheme clusters: an emoji with modifiers is one). */
export function captionLength(text: string): number {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!Segmenter) return [...text].length;
  let n = 0;
  for (const _ of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n += 1;
  return n;
}
