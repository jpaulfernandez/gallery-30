import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { readLocal, removeLocal, writeLocal } from './storage';

/**
 * A collection: the per-device, per-book shortlist of photos a viewer wants to keep, as ordered
 * asset ids in local storage (`photobook.collection.<slug>`). Ids that are no longer in the book
 * (a republish dropped the photo) are ignored on read.
 */

const PREFIX = 'photobook.collection.';

export function readCollection(slug: string, exists: (assetId: string) => boolean): string[] {
  const raw = readLocal(PREFIX + slug);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((id): id is string => typeof id === 'string' && exists(id));
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

export function writeCollection(slug: string, ids: string[]): void {
  if (ids.length === 0) removeLocal(PREFIX + slug);
  else writeLocal(PREFIX + slug, JSON.stringify(ids));
}

export interface CollectionState {
  ids: string[];
  toggle: (assetId: string) => void;
  remove: (assetId: string) => void;
  clear: () => void;
}

/** The collection of a book, persisted on every change and kept in step with other tabs. */
export function useCollection(slug: string, exists: (assetId: string) => boolean): CollectionState {
  const [ids, setIds] = useState(() => readCollection(slug, exists));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFIX + slug || e.key === null) setIds(readCollection(slug, exists));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [slug, exists]);

  const update = useCallback(
    (fn: (ids: string[]) => string[]) =>
      setIds((prev) => {
        const next = fn(prev);
        writeCollection(slug, next);
        return next;
      }),
    [slug],
  );

  const toggle = useCallback(
    (id: string) => update((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [update],
  );
  const remove = useCallback((id: string) => update((prev) => prev.filter((x) => x !== id)), [update]);
  const clear = useCallback(() => update(() => []), [update]);
  return useMemo(() => ({ ids, toggle, remove, clear }), [ids, toggle, remove, clear]);
}
