import {
  type ImageRecord,
  type Manifest,
  type ManifestPage,
  pageAssetIds,
  type ResolveImage,
  resolveFromManifest,
} from '@photobook/shared';

/** The distinct photos a page shows, background first: the lightbox set and the side panel list. */
export function pagePhotos(page: ManifestPage | undefined): string[] {
  return page ? Array.from(new Set(pageAssetIds(page))) : [];
}

export interface Resolvers {
  /** Current page and its neighbours: the browser fetches these right away. */
  eager: ResolveImage;
  /** Everything further out (grid cells, pages reached by a fast swipe). */
  lazy: ResolveImage;
}

/** The shared manifest resolver with the img `loading` attribute set per page distance. */
export function makeResolvers(manifest: Pick<Manifest, 'images'>): Resolvers {
  const base = resolveFromManifest(manifest);
  const withLoading =
    (loading: 'eager' | 'lazy'): ResolveImage =>
    (assetId, targetWidthPx) => {
      const image = base(assetId, targetWidthPx);
      return image ? { ...image, loading } : null;
    };
  return { eager: withLoading('eager'), lazy: withLoading('lazy') };
}

/** Smallest browse version of an image (for thumbnails and covers); the share JPEG when no ladder exists. */
export function smallestUrl(image: ImageRecord): string {
  return image.webp[0]?.url ?? image.avif[0]?.url ?? image.share;
}
