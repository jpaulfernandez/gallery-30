import {
  type Asset,
  inLens,
  lensOf,
  type Page,
  type StoryGroupBy,
  storyComparator,
  storyGroups,
} from '@photobook/shared';
import { basename } from '../../lib/path';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { folderLensStats, lensEntry, nameMatches } from '../../store/collections';
import { currentDesignBook } from '../../store/design';
import { captureTime, resolvedAssets } from '../../store/library';
import type { MissingAsset } from '../../store/relink';
import { DEFAULT_FILMSTRIP, developFilter, type FilmstripView, useUiStore } from '../../store/ui';

/** A grid cell: a scanned photo or a book photo whose file is missing (those come first). */
export type Item = { kind: 'file'; file: AssetFile } | { kind: 'missing'; asset: MissingAsset };

type Filters = Pick<FilmstripView, 'query' | 'sort' | 'hideUsed' | 'flag' | 'minRating'> &
  Partial<Pick<FilmstripView, 'edited' | 'minIso' | 'lens'>>;

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Some filter besides the search narrows the list. */
export const filtersActive = (view: Filters): boolean =>
  view.hideUsed || view.flag !== DEFAULT_FILMSTRIP.flag || view.minRating > 0 || !!view.edited || !!view.minIso;

/**
 * The filmstrip's cells in order: missing photos first (by name), then scanned ones by `view.sort`,
 * both narrowed by the search, the used filter, the review filters (rating and flag from `assets`, which callers
 * read through the library: `resolvedAssets`), Edited and ISO (the file's, once known), and the lens (plan 41: the
 * project's files are one folder for the Soft cut; a missing photo has no stats, so a lens leaves it out).
 */
export function visibleItems(
  files: Record<string, AssetFile>,
  missing: Record<string, MissingAsset>,
  assets: Record<string, Asset>,
  used: Set<string>,
  view: Filters,
): Item[] {
  const lensStats = view.lens && view.lens !== 'none' ? folderLensStats(files) : null;
  const keep = (assetId: string, path: string, iso?: number, file?: AssetFile) => {
    if (!nameMatches(path, view.query)) return false;
    if (lensStats && !inLens(view.lens, file ? lensOf(lensEntry(file), lensStats) : null)) return false;
    if (view.hideUsed && used.has(assetId)) return false;
    const asset = assets[assetId];
    if ((asset?.rating ?? 0) < view.minRating) return false;
    if (view.edited && asset?.develop === undefined) return false;
    if (view.minIso && (iso ?? 0) < view.minIso) return false;
    switch (view.flag) {
      case 'no-rejects':
        return asset?.flag !== 'reject';
      case 'picks':
        return asset?.flag === 'pick';
      case 'rejects':
        return asset?.flag === 'reject';
      case 'undecided':
        return asset?.flag === undefined;
      default:
        return true;
    }
  };
  const byName = (a: string, b: string) => nameCollator.compare(basename(a), basename(b)) || nameCollator.compare(a, b);
  const gone = Object.values(missing)
    .filter((m) => keep(m.assetId, m.path))
    .sort((a, b) => byName(a.path, b.path));
  const shown = Object.values(files)
    .filter((f) => keep(f.assetId, f.relPath, f.iso, f))
    // Capture time is the Exif `taken` (plan 38), else the file mtime; plan 56's sorts fall back to it on a tie.
    .sort(
      view.sort === 'name'
        ? (a, b) => byName(a.relPath, b.relPath)
        : storyComparator(
            view.sort,
            (f: AssetFile) => ({ ...f, rating: assets[f.assetId]?.rating }),
            (a, b) => captureTime(a) - captureTime(b) || byName(a.relPath, b.relPath),
          ),
    );
  return [
    ...gone.map((asset): Item => ({ kind: 'missing', asset })),
    ...shown.map((file): Item => ({ kind: 'file', file })),
  ];
}

/** A labelled run of a grid's cells (plan 56, *Group by*); an empty label draws no divider. */
export interface Section<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * Plan 56: `items` (already sorted) in Design's *Group by* sections (`storyGroups`): day, place, camera, colour family
 * or aspect; the photos whose file is missing come first, unlabelled. One unlabelled section with no grouping.
 */
export function itemSections(items: Item[], groupBy: StoryGroupBy | undefined): Section<Item>[] {
  const gone = items.filter((item) => item.kind === 'missing');
  const files = items.flatMap((item) => (item.kind === 'file' ? [item.file] : []));
  const byId = new Map(files.map((f) => [f.assetId, f]));
  const grouped = storyGroups(
    files.map((f) => ({ ...f, id: f.assetId })),
    groupBy ?? 'none',
  ).map((g) => ({
    key: g.key,
    label: g.label,
    items: g.ids.flatMap((id): Item[] => {
      const file = byId.get(id);
      return file ? [{ kind: 'file', file }] : [];
    }),
  }));
  return gone.length > 0 ? [{ key: 'missing', label: '', items: gone }, ...grouped] : grouped;
}

/** A virtual row of a sectioned grid: a labelled divider or up to `columns` cells. */
export type GridRow<T> =
  | { kind: 'divider'; key: string; label: string; count: number }
  | { kind: 'cells'; key: string; items: T[] };

/** The rows of `sections` in a `columns`-wide grid: each labelled section's divider, then its cells. */
export function gridRows<T>(sections: readonly Section<T>[], columns: number): GridRow<T>[] {
  const rows: GridRow<T>[] = [];
  for (const section of sections) {
    if (section.label) {
      rows.push({ kind: 'divider', key: `d:${section.key}`, label: section.label, count: section.items.length });
    }
    for (let i = 0; i < section.items.length; i += columns) {
      rows.push({ kind: 'cells', key: `c:${section.key}:${i}`, items: section.items.slice(i, i + columns) });
    }
  }
  return rows;
}

/** Asset ids referenced by any photo element or page background. */
export function usedAssetIds(pages: Page[]): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) {
    if (typeof page.background === 'object') ids.add(page.background.asset);
    for (const el of page.elements) {
      if (el.type === 'photo' && el.asset !== null) ids.add(el.asset);
    }
  }
  return ids;
}

/** Asset ids of the photos the filmstrip shows right now, in order (missing and unreadable ones left out). */
export function filmstripOrder(): string[] {
  const { files, missing } = useAssetsStore.getState();
  const state = useBookStore.getState();
  const ui = useUiStore.getState();
  // The Design filmstrip has no Edited, ISO or lens filter (the project's Cull does): Review steps through what it shows.
  // "Used" is used in the document on the Design stage (the book, or the open post).
  const used = usedAssetIds(currentDesignBook()?.pages ?? []);
  const items = visibleItems(files, missing, resolvedAssets(state) ?? {}, used, {
    ...ui.filmstrip,
    edited: false,
    minIso: 0,
    lens: 'none',
  });
  // In the order the grid shows them (plan 56: *Group by* sections).
  return itemSections(items, ui.filmstrip.groupBy).flatMap((section) =>
    section.items.flatMap((item) => (item.kind === 'file' && item.file.status !== 'error' ? [item.file.assetId] : [])),
  );
}

/**
 * Open review over the photos the filmstrip shows right now (missing and unreadable ones left out),
 * starting at `assetId` or the first one. Returns false when there is nothing to review.
 */
export function openReview(assetId?: string): boolean {
  const ids = filmstripOrder();
  if (ids.length === 0) return false;
  useUiStore.getState().openReview(ids, assetId ? Math.max(ids.indexOf(assetId), 0) : 0);
  return true;
}

/**
 * Open the Develop view on `assetId`, stepping through the same photos review would (the filmstrip's
 * order), less the rejects when the flag filter shows every flag (`developFilter`, workflow plan 08; `assetId` itself
 * stays). A photo the filmstrip does not show (filtered out, used on a page) opens alone. Returns false
 * when the photo has no scanned file (missing or unreadable) so there is nothing to develop.
 */
export function openDevelop(assetId: string): boolean {
  const { files } = useAssetsStore.getState();
  const file = Object.values(files).find((f) => f.assetId === assetId);
  if (!file || file.status === 'error') return false;
  const view = useUiStore.getState().filmstrip;
  const hide = developFilter(view).flag !== view.flag;
  const assets = resolvedAssets(useBookStore.getState()) ?? {};
  const ids = filmstripOrder().filter((id) => !hide || id === assetId || assets[id]?.flag !== 'reject');
  const at = ids.indexOf(assetId);
  if (at < 0) useUiStore.getState().openDevelop([assetId], 0);
  else useUiStore.getState().openDevelop(ids, at);
  return true;
}
