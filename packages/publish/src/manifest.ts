import {
  type Book,
  type ImageRecord,
  imageKey,
  MANIFEST_VERSION,
  type Manifest,
  type ManifestPage,
  ManifestSchema,
  pageAssetIds,
  pageImageKey,
  publicUrl,
} from '@photobook/shared';
import type { FrozenAsset } from './freeze.js';
import type { ImageMeta } from './images.js';
import { CONTENT_TYPES } from './store.js';

export interface ProcessedAsset {
  asset: FrozenAsset;
  meta: ImageMeta;
}

/** One object to upload: where it is on disk (relative to the asset's out dir) and its key. */
export interface ImageObject {
  key: string;
  file: string;
  contentType: string;
  bytes: number;
}

/** Every key of an asset's published versions, with the local file names. */
export function imageObjects(book: Book, { asset, meta }: ProcessedAsset): ImageObject[] {
  const { slug, r2Prefix } = book.publish;
  const out: ImageObject[] = [
    {
      key: imageKey(slug, r2Prefix, asset.hash, 'download', 'jpg'),
      file: meta.download.file,
      contentType: CONTENT_TYPES.jpg,
      bytes: meta.download.bytes,
    },
    {
      key: imageKey(slug, r2Prefix, asset.hash, 'share', 'jpg'),
      file: meta.share.file,
      contentType: CONTENT_TYPES.jpg,
      bytes: meta.share.bytes,
    },
  ];
  for (const l of meta.ladder) {
    out.push({
      key: imageKey(slug, r2Prefix, asset.hash, `w${l.w}`, 'avif'),
      file: `w${l.w}.avif`,
      contentType: CONTENT_TYPES.avif,
      bytes: l.avif,
    });
    out.push({
      key: imageKey(slug, r2Prefix, asset.hash, `w${l.w}`, 'webp'),
      file: `w${l.w}.webp`,
      contentType: CONTENT_TYPES.webp,
      bytes: l.webp,
    });
  }
  return out;
}

export function imageRecord(book: Book, base: string, { asset, meta }: ProcessedAsset): ImageRecord {
  const { slug, r2Prefix } = book.publish;
  const url = (variant: Parameters<typeof imageKey>[3], ext: Parameters<typeof imageKey>[4]) =>
    publicUrl(base, imageKey(slug, r2Prefix, asset.hash, variant, ext));
  return {
    width: meta.width,
    height: meta.height,
    download: { url: url('download', 'jpg'), bytes: meta.download.bytes, filename: downloadName(asset.filename) },
    share: url('share', 'jpg'),
    avif: meta.ladder.map((l) => ({ w: l.width, url: url(`w${l.w}`, 'avif') })),
    webp: meta.ladder.map((l) => ({ w: l.width, url: url(`w${l.w}`, 'webp') })),
    placeholder: meta.placeholder,
  };
}

/** The download is always a JPEG, whatever the original was. */
export function downloadName(filename: string): string {
  return `${filename.replace(/\.[^.]+$/, '')}.jpg`;
}

/**
 * Step 2.4: the manifest. No notes, no local paths. A page with rendered images (`pageHashes`: page
 * id -> render hash) points its thumbnail and share PNGs at them; otherwise the thumbnail is the first
 * photo's smallest WebP and the share PNGs are null.
 */
export function buildManifest(
  book: Book,
  base: string,
  processed: Map<string, ProcessedAsset>,
  publishedAt: string,
  pageHashes: ReadonlyMap<string, string> = new Map(),
): Manifest {
  const { slug, r2Prefix } = book.publish;
  const images: Record<string, ImageRecord> = {};
  for (const [id, p] of processed) images[id] = imageRecord(book, base, p);
  const pages: ManifestPage[] = book.pages.map(({ notes: _notes, ...page }) => {
    const hash = pageHashes.get(page.id);
    if (hash) {
      return {
        ...page,
        thumbnail: publicUrl(base, pageImageKey(slug, r2Prefix, hash, 'thumb', 'webp')),
        shareFeed: publicUrl(base, pageImageKey(slug, r2Prefix, hash, 'feed', 'png')),
        shareStory: publicUrl(base, pageImageKey(slug, r2Prefix, hash, 'story', 'png')),
      };
    }
    const first = pageAssetIds(page).find((id) => id in images);
    const thumb = first ? (images[first]?.webp[0]?.url ?? images[first]?.share ?? null) : null;
    return { ...page, thumbnail: thumb, shareFeed: null, shareStory: null };
  });
  return ManifestSchema.parse({
    version: MANIFEST_VERSION,
    id: book.id,
    slug,
    title: book.title,
    listed: book.publish.visibility === 'listed',
    template: book.template,
    theme: book.theme,
    publishedAt,
    images,
    pages,
  });
}
