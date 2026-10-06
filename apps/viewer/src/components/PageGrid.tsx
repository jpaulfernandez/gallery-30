import { type Manifest, type ManifestPage, Page, type ResolveImage } from '@photobook/shared';
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

const PAD = 16;
const GAP = 12;

/** 3 columns on phones, more as the stage widens. */
const columnsFor = (width: number) => (width < 600 ? 3 : width < 1000 ? 4 : 6);

export interface PageGridProps {
  manifest: Manifest;
  resolve: ResolveImage;
  current: number;
  /** Stage width in CSS px (sets the cell size, which sets the image sizes). */
  width: number;
  onPick: (index: number) => void;
  onClose: () => void;
}

/**
 * The jump grid behind the page counter: every page rendered by the shared `<Page>` at cell size.
 * Loaded on demand (dynamic import in `Reader`).
 */
export default function PageGrid({ manifest, resolve, current, width, onPick, onClose }: PageGridProps) {
  const cols = columnsFor(width);
  const cellW = Math.max(40, Math.floor((width - PAD * 2 - GAP * (cols - 1)) / cols));
  return (
    <div role="dialog" aria-label="All pages" class="pv-grid">
      <button type="button" class="pv-pill pv-grid-close" onClick={onClose}>
        Close
      </button>
      <div class="pv-grid-cells" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}>
        {manifest.pages.map((page, i) => (
          <GridCell
            key={page.id}
            manifest={manifest}
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
  manifest,
  page,
  number,
  selected,
  resolve,
  widthPx,
  onPick,
}: {
  manifest: Manifest;
  page: ManifestPage;
  number: number;
  selected: boolean;
  resolve: ResolveImage;
  widthPx: number;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // Mount the page only once its cell is near the viewport, so a long book does not fetch every image.
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

  return (
    <button
      ref={ref}
      type="button"
      class={selected ? 'pv-grid-cell is-current' : 'pv-grid-cell'}
      aria-label={`Page ${number}`}
      aria-current={selected ? 'page' : undefined}
      onClick={onPick}
    >
      <span
        class="pv-grid-page"
        style={{
          aspectRatio: `${manifest.template.width} / ${manifest.template.height}`,
          background: manifest.theme.background,
        }}
      >
        {visible && (
          <Page
            page={page}
            template={manifest.template}
            theme={manifest.theme}
            resolve={resolve}
            pageWidthPx={widthPx}
          />
        )}
      </span>
      <span class="pv-grid-number">{number}</span>
    </button>
  );
});
