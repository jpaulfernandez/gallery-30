import { type Book, type OutputProfile, type ResolveImage, resolveAssetDevelop } from '@photobook/shared';
import { type AssetFile, currentDeveloped, fileOfAsset } from '../../store/assets';

/**
 * Editor-side `ResolveImage`: asset id -> assets store file (`fileOfAsset`, whatever folder it is in) -> file URL. Callers pass the
 * assets read through the folder's library (`resolvedAssets`), so `develop` is the library's edit; the settings are
 * read with `resolveAssetDevelop`, so a project's develop snapshot wins either way.
 * `prefer: 'proxy'` falls back to the thumbnail; `'thumb'` (page grid, hundreds of cells) the reverse.
 * Returns null for unknown assets or files that are not prepared yet. `width` / `height` are the
 * asset's upright size when the scan has filled it (the renderer's cover sizing needs the aspect).
 *
 * Develop: when the asset has non-default `develop` settings and the file's cached render was made for exactly
 * those settings in the book's output `profile` (`currentDeveloped`), the developed proxy/thumbnail and its size are
 * returned instead. While a render for new settings (or a new profile) is pending the source variant shows, so the
 * canvas never goes blank and never shows a render in the other colour space.
 */
export function makeResolver(
  assets: Book['assets'] | undefined,
  files: Record<string, AssetFile>,
  prefer: 'proxy' | 'thumb' = 'proxy',
  profile: OutputProfile = 'srgb',
): ResolveImage {
  return (assetId) => {
    const asset = assets?.[assetId];
    const file = asset === undefined ? undefined : fileOfAsset(files, assetId);
    if (!file) return null;
    const developed = currentDeveloped(file, asset && resolveAssetDevelop(asset), profile);
    if (developed) {
      const src = prefer === 'proxy' ? developed.proxyUrl : developed.thumbUrl;
      return { src, width: developed.width, height: developed.height };
    }
    const src = prefer === 'proxy' ? (file.proxyUrl ?? file.thumbUrl) : (file.thumbUrl ?? file.proxyUrl);
    if (!src) return null;
    // Upright size from the scan: the renderer lays the photo out at its cover size from it.
    return asset?.width && asset.height ? { src, width: asset.width, height: asset.height } : { src };
  };
}
