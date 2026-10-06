import type { Book, ResolveImage } from '@photobook/shared';
import type { AssetFile } from '../../store/assets';

/**
 * Editor-side `ResolveImage`: asset id -> `book.assets[id].path` -> assets store file -> file URL.
 * `prefer: 'proxy'` falls back to the thumbnail; `'thumb'` (page grid, hundreds of cells) the reverse.
 * Returns null for unknown assets or files that are not prepared yet. `width` / `height` are the
 * asset's upright size when the scan has filled it (the renderer's cover sizing needs the aspect).
 */
export function makeResolver(
  assets: Book['assets'] | undefined,
  files: Record<string, AssetFile>,
  prefer: 'proxy' | 'thumb' = 'proxy',
): ResolveImage {
  return (assetId) => {
    const asset = assets?.[assetId];
    const file = asset === undefined ? undefined : files[asset.path];
    if (!file) return null;
    const src = prefer === 'proxy' ? (file.proxyUrl ?? file.thumbUrl) : (file.thumbUrl ?? file.proxyUrl);
    if (!src) return null;
    // Upright size from the scan: the renderer lays the photo out at its cover size from it.
    return asset?.width && asset.height ? { src, width: asset.width, height: asset.height } : { src };
  };
}
