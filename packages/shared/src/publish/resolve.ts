import type { ResolvedImage, ResolveImage } from '../renderer/types.js';
import type { ImageRecord, Manifest } from './manifest.js';

/** `srcset` text for a ladder. */
export function ladderSrcSet(entries: ImageRecord['avif']): string {
  return entries.map((e) => `${e.url} ${e.w}w`).join(', ');
}

/**
 * Turn an image record into what the renderer wants: a `<picture>` with the AVIF and WebP ladders
 * (`sizes` from the slot's width in CSS px), the share JPEG as the fallback `src`, the placeholder
 * behind it and the upright size for cover layout.
 */
export function resolveImageRecord(image: ImageRecord, targetWidthPx: number): ResolvedImage {
  const sizes = `${Math.max(1, Math.round(targetWidthPx))}px`;
  const sources: NonNullable<ResolvedImage['sources']> = [];
  if (image.avif.length) sources.push({ type: 'image/avif', srcSet: ladderSrcSet(image.avif), sizes });
  if (image.webp.length) sources.push({ type: 'image/webp', srcSet: ladderSrcSet(image.webp), sizes });
  return {
    src: image.share,
    sources,
    placeholder: image.placeholder,
    width: image.width,
    height: image.height,
  };
}

/** The viewer's `ResolveImage`: a lookup into `manifest.images`. */
export function resolveFromManifest(manifest: Pick<Manifest, 'images'>): ResolveImage {
  return (assetId, targetWidthPx) => {
    const image = manifest.images[assetId];
    return image ? resolveImageRecord(image, targetWidthPx) : null;
  };
}
