import type { Page } from '@photobook/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { basename } from '../../lib/path';
import { type AssetFile, type AssetsProgress, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import type { MissingAsset } from '../../store/relink';
import { FilmstripCell } from './FilmstripCell';
import { MissingCell } from './MissingCell';

const COLUMNS = 3;
/** Gap between cells and the grid's side padding, px (DESIGN_NOTES: 4 px gap). */
const GAP = 4;
const PAD = 8;

type SortKey = 'time' | 'name';

/** A grid cell: a scanned photo or a book photo whose file is missing (those come first). */
type Item = { kind: 'file'; file: AssetFile } | { kind: 'missing'; asset: MissingAsset };

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Left editor panel: search, sort, progress and a virtualized 3-column grid of thumbnails. */
export function Filmstrip() {
  const files = useAssetsStore((s) => s.files);
  const missing = useAssetsStore((s) => s.missing);
  const progress = useAssetsStore((s) => s.progress);
  const busy = useAssetsStore((s) => s.busy);
  const error = useAssetsStore((s) => s.error);
  const pages = useBookStore((s) => s.book?.pages);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('time');

  const used = useMemo(() => usedAssetIds(pages ?? []), [pages]);
  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const gone = Object.values(missing)
      .filter((m) => !q || basename(m.path).toLowerCase().includes(q))
      .sort((a, b) => nameCollator.compare(basename(a.path), basename(b.path)) || nameCollator.compare(a.path, b.path));
    return [
      ...gone.map((asset): Item => ({ kind: 'missing', asset })),
      ...filterAndSort(Object.values(files), query, sort).map((file): Item => ({ kind: 'file', file })),
    ];
  }, [files, missing, query, sort]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2 border-line border-b p-2">
        <input
          id="filmstrip-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search photos"
          aria-label="Search photos by file name"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-fg text-xs outline-none placeholder:text-fg-muted focus:border-accent"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort photos"
          className="rounded-md border border-line bg-panel-2 px-1 py-1 text-fg text-xs outline-none focus:border-accent"
        >
          <option value="time">Capture time</option>
          <option value="name">Name</option>
        </select>
      </div>
      {busy && <ProgressBar progress={progress} />}
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : items.length > 0 ? (
        <Grid items={items} used={used} />
      ) : busy ? null : (
        <EmptyState>{progress.total === 0 ? 'No photos in this folder' : `No photos match "${query}"`}</EmptyState>
      )}
    </div>
  );
}

function ProgressBar({ progress: { hashed, prepared, total } }: { progress: AssetsProgress }) {
  const hashing = hashed < total;
  const [label, done] = total === 0 ? ['Scanning…', 0] : hashing ? ['Hashing', hashed] : ['Thumbnails', prepared];
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="px-2 pt-1.5 pb-1" role="status">
      <div className="h-0.5 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-fg-muted tabular-nums">
        {total === 0 ? label : `${label} ${done} / ${total}`}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <p className="p-4 text-center text-fg-muted text-xs">{children}</p>;
}

function Grid({ items, used }: { items: Item[]; used: Set<string> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cell = Math.max(0, Math.floor((width - 2 * PAD - GAP * (COLUMNS - 1)) / COLUMNS));
  const virtualizer = useVirtualizer({
    count: Math.ceil(items.length / COLUMNS),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cell + GAP,
    overscan: 4,
    paddingStart: PAD,
    paddingEnd: PAD - GAP,
  });

  // Row height follows the panel width.
  useEffect(() => {
    if (cell > 0) virtualizer.measure();
  }, [cell, virtualizer]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {cell > 0 &&
          virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              className="absolute grid"
              style={{
                top: 0,
                left: PAD,
                right: PAD,
                height: cell,
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
                gap: GAP,
              }}
            >
              {items
                .slice(row.index * COLUMNS, row.index * COLUMNS + COLUMNS)
                .map((item) =>
                  item.kind === 'missing' ? (
                    <MissingCell key={`missing:${item.asset.assetId}`} asset={item.asset} />
                  ) : (
                    <FilmstripCell key={item.file.relPath} file={item.file} used={used.has(item.file.assetId)} />
                  ),
                )}
            </div>
          ))}
      </div>
    </div>
  );
}

function filterAndSort(files: AssetFile[], query: string, sort: SortKey): AssetFile[] {
  const q = query.trim().toLowerCase();
  const matched = q ? files.filter((f) => basename(f.relPath).toLowerCase().includes(q)) : files;
  const byName = (a: AssetFile, b: AssetFile) =>
    nameCollator.compare(basename(a.relPath), basename(b.relPath)) || nameCollator.compare(a.relPath, b.relPath);
  // Capture time is the file mtime until EXIF dates are read.
  return [...matched].sort(sort === 'name' ? byName : (a, b) => a.mtime - b.mtime || byName(a, b));
}

/** Asset ids referenced by any photo element or page background. */
function usedAssetIds(pages: Page[]): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) {
    if (typeof page.background === 'object') ids.add(page.background.asset);
    for (const el of page.elements) {
      if (el.type === 'photo' && el.asset !== null) ids.add(el.asset);
    }
  }
  return ids;
}
