import { useState } from 'react';
import type { BookLookup } from './lookup';

/**
 * A photo thumbnail by asset id. Unknown ids (photo removed since) and thumbnails that fail to load
 * show a dashed placeholder; a known photo whose thumbnail is not ready yet pulses.
 */
export function AssetThumb({
  assetId,
  lookup,
  className = 'size-10',
}: {
  assetId: string;
  lookup: BookLookup;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const url = lookup.thumbUrl(assetId);
  const name = lookup.photoName(assetId);

  if (!lookup.hasPhoto(assetId) || (url !== null && broken === url)) {
    return (
      <span
        role="img"
        aria-label="Photo no longer in the book"
        title="This photo is no longer in the book"
        className={`flex shrink-0 items-center justify-center rounded-sm border border-fg-muted/50 border-dashed text-[10px] text-fg-muted ${className}`}
      >
        ?
      </span>
    );
  }
  if (!url) {
    return (
      <span
        aria-hidden="true"
        title={name ?? undefined}
        className={`shrink-0 animate-pulse rounded-sm bg-line ${className}`}
      />
    );
  }
  return (
    <img
      src={url}
      alt={name ?? 'Photo'}
      title={name ?? undefined}
      draggable={false}
      decoding="async"
      onError={() => setBroken(url)}
      className={`shrink-0 rounded-sm bg-line object-cover ${className}`}
    />
  );
}
