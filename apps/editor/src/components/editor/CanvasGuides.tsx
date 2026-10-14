import { type BookTemplate, resolveTheme, spacing, type Theme } from '@photobook/shared';
import { memo, useMemo } from 'react';
import { useUiStore } from '../../store/ui';
import { type GapBadge, NO_BADGES, NO_GUIDES, type SnapGuide, useSnapGuides } from './snap';

/**
 * Layout helpers over the page (SVG in CSS px, pointer events off): grid lines every `theme.grid`
 * of the page width on both axes (same absolute spacing), the safe-margin rectangle (dashed
 * guide blue) and the hard-margin rectangle (fainter); the page edge is the bleed line. Grid and
 * margins follow the "Show grid" / "Show safe area" prefs. Snap guides of the drag in progress are
 * 1 px accent lines across the page, with a distance badge in the gap at gap snaps. Equal-spacing
 * guides (workflow plan 30) draw no line across the page but a measure in each equal gap (a
 * segment with end ticks, labelled "equal · 0.35 in"), and size-match guides a dimension line just
 * outside the resized frame and the neighbour it matches ("same width · 2.00 in" on the frame's).
 */
/**
 * Plan 48: the colours over the page. Snap lines (and their measures and badges) are the drag's feedback, in the
 * accent; the grid and the margins stay on the page, over photos, so they take the guide blue, never the accent.
 */
export const SNAP_COLOR = 'var(--color-accent)';
export const LAYOUT_GUIDE_COLOR = 'var(--color-guide)';

export const CanvasGuides = memo(function CanvasGuides({
  pageId,
  template,
  theme,
  width,
}: {
  pageId: string;
  template: Pick<BookTemplate, 'width' | 'height'>;
  theme: Theme;
  /** Page width on screen, CSS px. */
  width: number;
}) {
  const showGrid = useUiStore((s) => s.showGrid);
  const showMargins = useUiStore((s) => s.showMargins);
  // "Show guides while dragging" off (workflow plan 31): frames still snap, nothing is drawn.
  const showSnapGuides = useUiStore((s) => s.showGuidesWhileDragging);
  const guides = useSnapGuides((s) => (showSnapGuides && s.pageId === pageId ? s.guides : NO_GUIDES));
  const badges = useSnapGuides((s) => (showSnapGuides && s.pageId === pageId ? s.badges : NO_BADGES));
  const t = useMemo(() => resolveTheme(theme), [theme]);
  const height = (width * template.height) / template.width;

  const gridPath = useMemo(() => {
    if (!showGrid) return '';
    const step = t.grid * width;
    if (!(step >= 2)) return ''; // Too dense to read at this zoom.
    let d = '';
    for (let x = step; x < width - 0.5; x += step) d += `M${x.toFixed(2)} 0V${height.toFixed(2)}`;
    for (let y = step; y < height - 0.5; y += step) d += `M0 ${y.toFixed(2)}H${width.toFixed(2)}`;
    return d;
  }, [showGrid, t.grid, width, height]);

  const safe = spacing(t.margin, t.gutter, template.width / template.height);
  const hard = t.hardMargin * width;

  if (!showGrid && !showMargins && guides.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="canvas-guides">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="absolute inset-0 overflow-visible"
        aria-hidden="true"
      >
        {gridPath && (
          <path
            d={gridPath}
            fill="none"
            stroke={LAYOUT_GUIDE_COLOR}
            strokeOpacity={0.16}
            strokeWidth={1}
            data-testid="grid-lines"
          />
        )}
        {showMargins && (
          <>
            <rect
              x={hard}
              y={hard}
              width={Math.max(0, width - 2 * hard)}
              height={Math.max(0, height - 2 * hard)}
              fill="none"
              stroke={LAYOUT_GUIDE_COLOR}
              strokeOpacity={0.3}
              strokeDasharray="2 4"
              data-testid="hard-margin"
            />
            <rect
              x={safe.mx * width}
              y={safe.my * height}
              width={Math.max(0, (1 - 2 * safe.mx) * width)}
              height={Math.max(0, (1 - 2 * safe.my) * height)}
              fill="none"
              stroke={LAYOUT_GUIDE_COLOR}
              strokeOpacity={0.75}
              strokeDasharray="5 4"
              data-testid="safe-margin"
            />
          </>
        )}
        {guides.map((g, i) =>
          g.spans ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional
            <GuideSpans key={i} guide={g} width={width} height={height} />
          ) : g.axis === 'x' ? (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional
              key={i}
              x1={Math.round(g.value * width) + 0.5}
              x2={Math.round(g.value * width) + 0.5}
              y1={0}
              y2={height}
              stroke={SNAP_COLOR}
              strokeWidth={1}
            />
          ) : (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional
              key={i}
              x1={0}
              x2={width}
              y1={Math.round(g.value * height) + 0.5}
              y2={Math.round(g.value * height) + 0.5}
              stroke={SNAP_COLOR}
              strokeWidth={1}
            />
          ),
        )}
      </svg>
      {badges.map((b, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: badges are positional
          key={i}
          data-badge-kind={b.kind ?? 'gap'}
          className="absolute z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-accent px-1 py-px font-medium text-[10px] text-accent-ink tabular-nums leading-tight shadow-raised"
          style={badgeStyle(b, width, height)}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
});

/** How far outside a frame a size-match dimension line sits, CSS px. */
const SIZE_OFFSET = 7;
/** Half the length of a measure's end ticks, CSS px. */
const TICK = 4;

/** A size badge sits on its dimension line, outside the frame; the others where they were computed. */
function badgeStyle(b: GapBadge, width: number, height: number) {
  if (b.kind !== 'size') return { left: b.x * width, top: b.y * height };
  // Width badges sit on the line above the frame (y is its top edge), height badges left of it.
  return b.axis === 'y'
    ? { left: b.x * width - SIZE_OFFSET, top: b.y * height }
    : { left: b.x * width, top: b.y * height - SIZE_OFFSET };
}

/**
 * The measures of an equal-spacing or size-match guide: one segment per span along the guide's
 * axis with a tick at each end. Size-match spans sit just outside the frames (above for widths,
 * left for heights).
 */
function GuideSpans({ guide, width, height }: { guide: SnapGuide; width: number; height: number }) {
  const ax = guide.axis === 'x';
  const shift = guide.kind === 'size' ? -SIZE_OFFSET : 0;
  let d = '';
  for (const s of guide.spans ?? []) {
    if (ax) {
      const y = Math.round(s.at * height + shift) + 0.5;
      const x0 = s.from * width;
      const x1 = s.to * width;
      d += `M${x0.toFixed(2)} ${y}H${x1.toFixed(2)}M${x0.toFixed(2)} ${y - TICK}v${2 * TICK}M${x1.toFixed(2)} ${y - TICK}v${2 * TICK}`;
    } else {
      const x = Math.round(s.at * width + shift) + 0.5;
      const y0 = s.from * height;
      const y1 = s.to * height;
      d += `M${x} ${y0.toFixed(2)}V${y1.toFixed(2)}M${x - TICK} ${y0.toFixed(2)}h${2 * TICK}M${x - TICK} ${y1.toFixed(2)}h${2 * TICK}`;
    }
  }
  return <path d={d} fill="none" stroke={SNAP_COLOR} strokeWidth={1} data-guide-kind={guide.kind} />;
}
