import {
  type Asset,
  PHOTO_SORT_LABELS,
  PHOTO_SORTS,
  STORY_GROUP_BY_LABELS,
  STORY_GROUP_BYS,
  type StoryGroupBy,
} from '@photobook/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type AssetsProgress, fileKey, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useDesignBook } from '../../store/design';
import { assetVersionNames, resolvedAssets } from '../../store/library';
import { DEFAULT_FILMSTRIP, type FilmstripSort, type FlagFilter, useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Field';
import { FilmstripCell } from './FilmstripCell';
import { MissingCell } from './MissingCell';
import {
  filtersActive,
  type GridRow,
  gridRows,
  type Item,
  itemSections,
  openReview,
  type Section,
  usedAssetIds,
  visibleItems,
} from './visible';

const COLUMNS = 3;
/** Gap between cells and the grid's side padding, px (DESIGN_NOTES: 4 px gap). */
const GAP = 4;
const PAD = 8;
/** Height of a *Group by* divider row, px (plan 56). */
export const DIVIDER = 24;

const NO_ASSETS: Record<string, Asset> = {};

const selectClass =
  'min-w-0 rounded-md border border-line bg-panel-2 px-1 py-1 text-fg text-xs outline-none focus:border-accent';

/**
 * The Design stage's Project tab: the open project's photos (its assets, mapped onto their folders' photos; workflow
 * plan 05) with search, sort, filters (used, flag, rating), the folder scan's progress and a virtualized 3-column grid
 * of thumbnails. Search, filters and scroll live in the UI store, so they survive tab switches.
 */
export function Filmstrip() {
  const files = useAssetsStore((s) => s.files);
  const missing = useAssetsStore((s) => s.missing);
  const progress = useAssetsStore((s) => s.progress);
  const busy = useAssetsStore((s) => s.busy);
  const error = useAssetsStore((s) => s.error);
  const pages = useDesignBook()?.pages;
  // Ratings, flags and edits read through the folder's library.
  const assets = useBookStore((s) => resolvedAssets(s) ?? NO_ASSETS);
  const query = useUiStore((s) => s.filmstrip.query);
  const sort = useUiStore((s) => s.filmstrip.sort);
  const hideUsed = useUiStore((s) => s.filmstrip.hideUsed);
  const flag = useUiStore((s) => s.filmstrip.flag);
  const minRating = useUiStore((s) => s.filmstrip.minRating);
  const groupBy = useUiStore((s) => s.filmstrip.groupBy ?? 'none');
  const setFilmstrip = useUiStore((s) => s.setFilmstrip);

  const view = { query, sort, hideUsed, flag, minRating };
  const used = useMemo(() => usedAssetIds(pages ?? []), [pages]);
  const items = useMemo<Item[]>(
    () => visibleItems(files, missing, assets, used, { query, sort, hideUsed, flag, minRating }),
    [files, missing, assets, used, query, sort, hideUsed, flag, minRating],
  );
  const sections = useMemo(() => itemSections(items, groupBy), [items, groupBy]);
  const total = Object.keys(files).length + Object.keys(missing).length;
  const narrowed = filtersActive(view) || query.trim() !== '';
  const filterKey = `${query}\n${sort}\n${hideUsed}\n${flag}\n${minRating}\n${groupBy}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 border-line border-b p-2">
        <div className="flex gap-2">
          <input
            id="filmstrip-search"
            type="search"
            value={query}
            onChange={(e) => setFilmstrip({ query: e.target.value })}
            placeholder="Search photos"
            aria-label="Search photos by file name"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-fg text-xs outline-none placeholder:text-fg-muted focus:border-accent"
          />
        </div>
        {/* Plan 56: sort and group for storytelling (view state, never written to the library or the project). */}
        <div className="flex gap-1.5">
          <Select
            value={sort}
            onChange={(e) => setFilmstrip({ sort: e.target.value as FilmstripSort })}
            aria-label="Sort by"
            title="Sort by"
            className="flex-1"
          >
            {PHOTO_SORTS.map((s) => (
              <option key={s} value={s}>
                {PHOTO_SORT_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select
            value={groupBy}
            onChange={(e) => setFilmstrip({ groupBy: e.target.value as StoryGroupBy })}
            aria-label="Group by"
            title="Group by"
            className="flex-1"
          >
            {STORY_GROUP_BYS.map((g) => (
              <option key={g} value={g}>
                {STORY_GROUP_BY_LABELS[g]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="toggle"
            size="sm"
            pressed={hideUsed}
            onClick={() => setFilmstrip({ hideUsed: !hideUsed })}
            title="Hide photos that are already on a page"
          >
            Hide used
          </Button>
          <select
            value={flag}
            onChange={(e) => setFilmstrip({ flag: e.target.value as FlagFilter })}
            aria-label="Filter by flag"
            className={`${selectClass} flex-1`}
          >
            <option value="all">All flags</option>
            <option value="no-rejects">Hide rejects</option>
            <option value="picks">Kept only</option>
            <option value="rejects">Rejects only</option>
          </select>
          <select
            value={minRating}
            onChange={(e) => setFilmstrip({ minRating: Number(e.target.value) })}
            aria-label="Filter by minimum star rating"
            className={`${selectClass} flex-1`}
          >
            <option value={0}>Any rating</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {'★'.repeat(n)}
                {n < 5 ? ' & up' : ''}
              </option>
            ))}
          </select>
        </div>
        {narrowed && total > 0 && (
          <div className="flex items-center justify-between text-[11px] text-fg-muted">
            <span className="tabular-nums" role="status">
              {items.length} of {total} photos
            </span>
            <button
              type="button"
              onClick={() =>
                setFilmstrip({
                  query: DEFAULT_FILMSTRIP.query,
                  hideUsed: DEFAULT_FILMSTRIP.hideUsed,
                  flag: DEFAULT_FILMSTRIP.flag,
                  minRating: DEFAULT_FILMSTRIP.minRating,
                })
              }
              className="rounded-sm outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
      {items.some((item) => item.kind === 'file' && item.file.status !== 'error') && (
        <div className="flex justify-end border-line border-b px-2 py-1">
          <button
            type="button"
            onClick={() => useUiStore.getState().openXmpImport(importableIds(items))}
            title="Read Lightroom (.xmp) settings for the photos listed here"
            className="rounded-sm text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            Import Lightroom settings…
          </button>
        </div>
      )}
      {busy && <ProgressBar progress={progress} />}
      {error ? (
        <p className="p-4 text-center text-fg-muted text-xs">{error}</p>
      ) : items.length > 0 ? (
        <Grid sections={sections} used={used} assets={assets} filterKey={filterKey} />
      ) : busy ? null : (
        <EmptyState size="md" className="p-4">
          {total === 0
            ? 'No photos in this project yet. Add them from the Library tab.'
            : query.trim() && !filtersActive(view)
              ? `No photos match "${query}"`
              : 'No photos match these filters'}
        </EmptyState>
      )}
    </div>
  );
}

/** The photos the grid lists that can be read (missing and unreadable ones left out). */
const importableIds = (items: Item[]): string[] =>
  items.flatMap((item) => (item.kind === 'file' && item.file.status !== 'error' ? [item.file.assetId] : []));

function ProgressBar({ progress: { hashed, prepared, total } }: { progress: AssetsProgress }) {
  const hashing = hashed < total;
  const [label, done] = total === 0 ? ['Scanning…', 0] : hashing ? ['Hashing', hashed] : ['Thumbnails', prepared];
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="px-2 pt-1.5 pb-1" role="status">
      <div className="h-0.5 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent transition-[width] duration-base" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-fg-muted tabular-nums">
        {total === 0 ? label : `${label} ${done} / ${total}`}
      </div>
    </div>
  );
}

/** Plan 56: a *Group by* divider row: the section's label and its count in mono. */
export function GroupDivider({ label, count }: { label: string; count: number }) {
  return (
    <div
      className="flex h-full items-end justify-between gap-2 border-hairline border-b pb-1"
      data-group-divider={label}
    >
      <span className="section-title truncate">{label}</span>
      <span className="font-mono text-[11px] text-fg-muted tabular-nums">{count}</span>
    </div>
  );
}

/** The grid's row sizes for virtualizing: a divider, or a row of cells `cell` px square plus the gap. */
export function rowSize<T>(row: GridRow<T> | undefined, cell: number): number {
  return row?.kind === 'divider' ? DIVIDER : cell + GAP;
}

interface GridProps {
  sections: Section<Item>[];
  used: Set<string>;
  assets: Record<string, Asset>;
  /** Changes whenever the search, sort or a filter does; the grid then scrolls back to the top. */
  filterKey: string;
}

function Grid({ sections, used, assets, filterKey }: GridProps) {
  // The version each photo uses (workflow plan 08), for its badge.
  const versions = useBookStore(assetVersionNames);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** The saved scroll offset has been applied; until then scroll events are not saved. */
  const restored = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cell = Math.max(0, Math.floor((width - 2 * PAD - GAP * (COLUMNS - 1)) / COLUMNS));
  const rows = useMemo(() => gridRows(sections, COLUMNS), [sections]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowSize(rows[i], cell),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 4,
    paddingStart: PAD,
    paddingEnd: PAD - GAP,
  });
  const totalSize = virtualizer.getTotalSize();

  // Row height follows the panel width (and the dividers, plan 56).
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows need measuring again
  useLayoutEffect(() => {
    if (cell > 0) virtualizer.measure();
  }, [cell, virtualizer, rows]);
  const expected = rows.reduce((sum, row) => sum + rowSize(row, cell), 0) + 2 * PAD - GAP;

  // Coming back to the tab: scroll to where the grid was, once rows have their real height (the
  // first pass can still use the zero-width estimate, which would clamp the offset).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (restored.current || !el || cell === 0) return;
    const target = useUiStore.getState().filmstrip.scrollTop;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - target) <= 1 || totalSize === expected) {
      restored.current = true;
    }
  }, [cell, expected, totalSize]);

  // A new search or filter starts at the top (not on mount: that is the restore above).
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filterKey]);

  // After review, bring the photo it ended on into view.
  const reveal = useUiStore((s) => s.filmstrip.reveal);
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize changes when the restore above completes
  useEffect(() => {
    if (!reveal || cell === 0 || !restored.current) return;
    const index = rows.findIndex(
      (row) => row.kind === 'cells' && row.items.some((item) => item.kind === 'file' && item.file.assetId === reveal),
    );
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    useUiStore.getState().setFilmstrip({ reveal: null });
  }, [reveal, cell, rows, virtualizer, totalSize]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      onScroll={(e) => {
        if (restored.current) useUiStore.getState().setFilmstrip({ scrollTop: e.currentTarget.scrollTop });
      }}
    >
      <div className="relative" style={{ height: totalSize }}>
        {cell > 0 &&
          virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            if (row.kind === 'divider') {
              return (
                <div
                  key={v.key}
                  className="absolute"
                  style={{
                    top: 0,
                    left: PAD,
                    right: PAD,
                    height: DIVIDER - GAP,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <GroupDivider label={row.label} count={row.count} />
                </div>
              );
            }
            return (
              <div
                key={v.key}
                className="absolute grid"
                style={{
                  top: 0,
                  left: PAD,
                  right: PAD,
                  height: cell,
                  transform: `translateY(${v.start}px)`,
                  gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
                  gap: GAP,
                }}
              >
                {row.items.map((item) =>
                  item.kind === 'missing' ? (
                    <MissingCell key={`missing:${item.asset.assetId}`} asset={item.asset} />
                  ) : (
                    <FilmstripCell
                      key={fileKey(item.file)}
                      file={item.file}
                      used={used.has(item.file.assetId)}
                      rating={assets[item.file.assetId]?.rating}
                      flag={assets[item.file.assetId]?.flag}
                      edited={assets[item.file.assetId]?.develop !== undefined}
                      develop={assets[item.file.assetId]?.develop}
                      version={versions[item.file.assetId]}
                      onOpen={openReview}
                    />
                  ),
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
