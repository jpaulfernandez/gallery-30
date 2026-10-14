import type { Book } from '@photobook/shared';
import { useMemo } from 'react';
import { basename } from '../../lib/path';
import { fileOfAsset, useAssetsStore } from '../../store/assets';

/** What the Downloads tab knows about an id from the Worker, from the open book and the assets store. */
export interface BookLookup {
  /** The asset is in `book.assets`; false for photos removed since. */
  hasPhoto: (assetId: string) => boolean;
  /** File name, or null for unknown ids. */
  photoName: (assetId: string) => string | null;
  /** 256 px thumbnail URL when the scan has prepared it. */
  thumbUrl: (assetId: string) => string | null;
  /** 1-based page number, or null for pages deleted since. */
  pageNumber: (pageId: string) => number | null;
  /** Position of the first page that shows the photo, for ordering; Infinity when no page uses it. */
  photoOrder: (assetId: string) => number;
}

export function makeLookup(
  book: Pick<Book, 'assets' | 'pages'>,
  files: Record<string, { assetId: string; thumbUrl?: string }>,
): BookLookup {
  const pageIndex = new Map(book.pages.map((p, i) => [p.id, i]));
  const firstUse = new Map<string, number>();
  book.pages.forEach((page, i) => {
    for (const el of page.elements) {
      if (el.type === 'photo' && el.asset && !firstUse.has(el.asset)) firstUse.set(el.asset, i);
    }
  });
  return {
    hasPhoto: (id) => id in book.assets,
    photoName: (id) => {
      const asset = book.assets[id];
      return asset ? basename(asset.path) : null;
    },
    thumbUrl: (id) => {
      const asset = book.assets[id];
      return (asset && fileOfAsset(files, id)?.thumbUrl) || null;
    },
    pageNumber: (id) => {
      const i = pageIndex.get(id);
      return i === undefined ? null : i + 1;
    },
    photoOrder: (id) => firstUse.get(id) ?? Number.POSITIVE_INFINITY,
  };
}

export function useBookLookup(book: Pick<Book, 'assets' | 'pages'>): BookLookup {
  const files = useAssetsStore((s) => s.files);
  return useMemo(() => makeLookup(book, files), [book, files]);
}
