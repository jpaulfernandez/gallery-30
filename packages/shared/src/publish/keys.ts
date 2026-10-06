/**
 * Object keys on R2 and the image ladder. Shared so the publish CLI (writer) and the viewer
 * (reader) agree; the viewer only ever sees absolute URLs through the manifest, but `siteUrl` and
 * `manifestUrl` are the two it must build itself.
 */

/** Long-edge widths of the browse ladder (AVIF and WebP), ascending. */
export const BROWSE_WIDTHS = [480, 960, 1440, 2048] as const;
export type BrowseWidth = (typeof BROWSE_WIDTHS)[number];

/** Long edge of the blurred placeholder inlined in the manifest as a data URL. */
export const PLACEHOLDER_WIDTH = 24;

/** Default download version: long edge and mozjpeg quality. Both are app settings. */
export const DEFAULT_DOWNLOAD_MAX_EDGE = 4096;
export const DEFAULT_DOWNLOAD_QUALITY = 88;
export const SHARE_MAX_EDGE = 2048;
export const SHARE_QUALITY = 85;
export const AVIF_QUALITY = 52;
export const WEBP_QUALITY = 76;

export const SITE_KEY = 'site.json';

/** `books/<slug>` without a trailing slash. Everything about one book lives below it. */
export function bookPrefix(slug: string): string {
  return `books/${slug}`;
}

export function manifestKey(slug: string): string {
  return `${bookPrefix(slug)}/manifest.json`;
}

/** Folder of every image of a book: `books/<slug>/<r2Prefix>`. */
export function imagePrefix(slug: string, r2Prefix: string): string {
  return `${bookPrefix(slug)}/${r2Prefix}`;
}

/** Image variant file names, keyed by hash: `<hash>-<variant>.<ext>`. */
export type ImageVariant = 'download' | 'share' | `w${BrowseWidth}`;

export function imageKey(
  slug: string,
  r2Prefix: string,
  hash: string,
  variant: ImageVariant,
  ext: 'jpg' | 'avif' | 'webp',
): string {
  return `${imagePrefix(slug, r2Prefix)}/${hash}-${variant}.${ext}`;
}

/** Page images (PRD "Share a page to Instagram"): the whole page rendered at publish time. */
export const PAGE_IMAGE_SIZES = {
  /** Instagram feed portrait. */
  feed: { width: 1080, height: 1350 },
  /** Instagram story. */
  story: { width: 1080, height: 1920 },
  /** Jump-grid thumbnail; height follows the page ratio. */
  thumb: { width: 320 },
} as const;
export type PageImageVariant = keyof typeof PAGE_IMAGE_SIZES;

/** Folder of a book's page images: `books/<slug>/<r2Prefix>/pages`. */
export function pagesPrefix(slug: string, r2Prefix: string): string {
  return `${imagePrefix(slug, r2Prefix)}/pages`;
}

/**
 * Page image file names, keyed by the page's render hash (its content plus the hashes of the photos
 * it shows): `pages/<pageHash>-<variant>.<ext>`. A page whose look did not change keeps its key.
 */
export function pageImageKey(
  slug: string,
  r2Prefix: string,
  pageHash: string,
  variant: PageImageVariant,
  ext: 'png' | 'webp' | 'jpg',
): string {
  return `${pagesPrefix(slug, r2Prefix)}/${pageHash}-${variant}.${ext}`;
}

/** Join a public base URL (with or without a trailing slash) and a key. */
export function publicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key}`;
}

export const siteUrl = (base: string): string => publicUrl(base, SITE_KEY);
export const manifestUrl = (base: string, slug: string): string => publicUrl(base, manifestKey(slug));
