import { type Book, Page, type ResolveImage } from '@photobook/shared';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** Edge zones (fraction of the track width) where a click steps a page. */
const EDGE_ZONE = 0.2;
/** Fallback for engines without `scrollend`: settle this long after the last scroll event. */
const SETTLE_MS = 120;
/** Phone screen size; used until the track has been measured. */
const FALLBACK = { w: 393, h: 852 };
const GRID_PAD = 16;
const GRID_GAP = 12;
const GRID_COLS = 3;

export interface ReaderProps {
  book: Book;
  /** Full-size resolver (proxy URLs). */
  resolve: ResolveImage;
  /** Resolver for the page grid; defaults to `resolve`. Pass a thumbnail-first one for big books. */
  resolveThumb?: ResolveImage;
  /** 0-based page to open on. Read on mount only (remount with a `key` to jump from outside). */
  initialIndex?: number;
  /** Called with the 0-based index on mount and after every page change. */
  onIndexChange?: (index: number) => void;
  /** Escape with no grid open. */
  onExit?: () => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * The viewer-like page reader: a horizontal scroll-snap track, one page per viewport width, with the
 * shared `<Page>` mounted only for the current page and its neighbours. It fills its parent, so the
 * parent decides whether this is a phone screen or the desktop column.
 */
export function Reader({ book, resolve, resolveThumb, initialIndex = 0, onIndexChange, onExit }: ReaderProps) {
  const count = book.pages.length;
  const trackRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `index` is the settled page (counter, hash, keys). `near` follows the scroll position so a fast
  // swipe past the neighbours still finds mounted pages.
  const [index, setIndex] = useState(() => clamp(initialIndex, 0, Math.max(0, count - 1)));
  const [near, setNear] = useState(index);
  const [size, setSize] = useState(FALLBACK);
  const [gridOpen, setGridOpen] = useState(false);

  const current = clamp(index, 0, Math.max(0, count - 1));
  const indexRef = useRef(current);
  indexRef.current = current;
  const countRef = useRef(count);
  countRef.current = count;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // Pages changed under us (deleted at the end): pull the index back in range.
  useEffect(() => {
    if (index !== current) {
      setIndex(current);
      setNear(current);
    }
  }, [index, current]);

  useEffect(() => {
    onIndexChangeRef.current?.(current);
  }, [current]);

  /** Scroll to a page and update the counter right away (the scroll catches up). */
  const goTo = useCallback((target: number, behavior: ScrollBehavior = 'smooth') => {
    const last = countRef.current - 1;
    if (last < 0) return;
    const i = clamp(target, 0, last);
    indexRef.current = i;
    setIndex(i);
    if (behavior === 'instant') setNear(i);
    const el = trackRef.current;
    el?.scrollTo({ left: i * el.clientWidth, behavior });
  }, []);

  // Measure the track; keep the current page aligned when its width changes.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      setSize((s) =>
        s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight },
      );
      const left = indexRef.current * el.clientWidth;
      if (el.scrollLeft !== left) el.scrollTo({ left, behavior: 'instant' });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const settle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const el = trackRef.current;
    if (!el || el.clientWidth === 0 || countRef.current === 0) return;
    const i = clamp(Math.round(el.scrollLeft / el.clientWidth), 0, countRef.current - 1);
    indexRef.current = i;
    setIndex(i);
    setNear(i);
  }, []);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el || el.clientWidth === 0) return;
    setNear(clamp(Math.round(el.scrollLeft / el.clientWidth), 0, Math.max(0, countRef.current - 1)));
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, SETTLE_MS);
  }, [settle]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  // Keyboard: arrows step, Escape closes the grid, then exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (gridOpen) setGridOpen(false);
        else onExitRef.current?.();
      } else if (!gridOpen && e.key === 'ArrowRight') {
        e.preventDefault();
        goTo(indexRef.current + 1);
      } else if (!gridOpen && e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(indexRef.current - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gridOpen, goTo]);

  // Click on the outer 20 % of either side steps a page.
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    if (x < EDGE_ZONE) goTo(indexRef.current - 1);
    else if (x > 1 - EDGE_ZONE) goTo(indexRef.current + 1);
  };

  const ratio = book.template.width / book.template.height;
  const pageW = Math.round(Math.min(size.w, size.h * ratio));
  const background = book.theme.background;

  if (count === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-fg-muted" style={{ background }}>
        <span className="rounded-full bg-stage/55 px-3 py-1.5 text-fg">No pages yet</span>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background }}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the arrow keys are handled on window, the click zones are a pointer shortcut */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div
        ref={trackRef}
        data-testid="reader-track"
        className="flex h-full w-full snap-x snap-mandatory scroll-smooth overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        onScroll={onScroll}
        onScrollEnd={settle}
        onClick={onTrackClick}
      >
        {book.pages.map((page, i) => (
          <div
            key={page.id}
            data-slide={i}
            className="flex h-full w-full shrink-0 snap-start snap-always items-center justify-center"
            style={{ background }}
          >
            {Math.abs(i - near) <= 1 || Math.abs(i - current) <= 1 ? (
              <Slide page={page} book={book} resolve={resolve} widthPx={pageW} />
            ) : null}
          </div>
        ))}
      </div>

      <button
        type="button"
        data-testid="reader-counter"
        aria-label="Show all pages"
        aria-expanded={gridOpen}
        onClick={() => setGridOpen((open) => !open)}
        className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 cursor-pointer rounded-full border-0 bg-stage/55 px-3.5 py-1.5 text-[13px] text-fg tabular-nums backdrop-blur-md"
      >
        {`${current + 1} / ${count}`}
      </button>

      {gridOpen && (
        <PageGrid
          book={book}
          resolve={resolveThumb ?? resolve}
          current={current}
          width={size.w}
          onPick={(i) => {
            setGridOpen(false);
            goTo(i, 'instant');
          }}
        />
      )}
    </div>
  );
}

const Slide = memo(function Slide({
  page,
  book,
  resolve,
  widthPx,
}: {
  page: Book['pages'][number];
  book: Book;
  resolve: ResolveImage;
  widthPx: number;
}) {
  return (
    <div style={{ width: widthPx }}>
      <Page page={page} template={book.template} theme={book.theme} resolve={resolve} pageWidthPx={widthPx} />
    </div>
  );
});

function PageGrid({
  book,
  resolve,
  current,
  width,
  onPick,
}: {
  book: Book;
  resolve: ResolveImage;
  current: number;
  width: number;
  onPick: (index: number) => void;
}) {
  const cellW = Math.max(40, Math.floor((width - GRID_PAD * 2 - GRID_GAP * (GRID_COLS - 1)) / GRID_COLS));
  return (
    <div
      role="dialog"
      aria-label="All pages"
      data-testid="reader-grid"
      className="absolute inset-0 z-10 scrollbar overflow-x-hidden overflow-y-auto bg-stage/95 backdrop-blur-sm"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
          gap: GRID_GAP,
          padding: `${GRID_PAD}px ${GRID_PAD}px 64px`,
        }}
      >
        {book.pages.map((page, i) => (
          <GridCell
            key={page.id}
            book={book}
            page={page}
            number={i + 1}
            selected={i === current}
            resolve={resolve}
            widthPx={cellW}
            onPick={() => onPick(i)}
          />
        ))}
      </div>
    </div>
  );
}

const GridCell = memo(function GridCell({
  book,
  page,
  number,
  selected,
  resolve,
  widthPx,
  onPick,
}: {
  book: Book;
  page: Book['pages'][number];
  number: number;
  selected: boolean;
  resolve: ResolveImage;
  widthPx: number;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // Mount the page only once its cell is near the viewport, so a long book does not load every proxy.
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [selected]);

  const aspect = useMemo(() => `${book.template.width} / ${book.template.height}`, [book.template]);

  return (
    <button
      ref={ref}
      type="button"
      data-testid="grid-cell"
      aria-label={`Page ${number}`}
      aria-current={selected ? 'page' : undefined}
      onClick={onPick}
      className="m-0 flex cursor-pointer flex-col items-center gap-1.5 border-0 bg-transparent p-0 text-fg-muted"
    >
      <span
        className="block w-full overflow-hidden rounded-[3px]"
        style={{
          aspectRatio: aspect,
          background: book.theme.background,
          outline: selected ? '2px solid #4f8cff' : '1px solid #333',
          outlineOffset: selected ? 2 : 0,
        }}
      >
        {visible && (
          <Page page={page} template={book.template} theme={book.theme} resolve={resolve} pageWidthPx={widthPx} />
        )}
      </span>
      <span className="text-[11px] tabular-nums" style={selected ? { color: '#4f8cff' } : undefined}>
        {number}
      </span>
    </button>
  );
});
