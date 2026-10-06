import { type BookTemplate, resolveTheme, spacing, type Theme } from '@photobook/shared';
import { memo, useMemo } from 'react';
import { useUiStore } from '../../store/ui';
import { NO_BADGES, NO_GUIDES, useSnapGuides } from './snap';

/**
 * Layout helpers over the page (SVG in CSS px, pointer events off): grid lines every `theme.grid`
 * of the page width on both axes (same absolute spacing), the safe-margin rectangle (dashed
 * accent) and the hard-margin rectangle (fainter); the page edge is the bleed line. Grid and
 * margins follow the "Show grid" / "Show safe area" prefs. Snap guides of the drag in progress are
 * 1 px accent lines across the page, with a distance badge in the gap at gap snaps.
 */
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
  const guides = useSnapGuides((s) => (s.pageId === pageId ? s.guides : NO_GUIDES));
  const badges = useSnapGuides((s) => (s.pageId === pageId ? s.badges : NO_BADGES));
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
            stroke="var(--color-accent)"
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
              stroke="var(--color-accent)"
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
              stroke="var(--color-accent)"
              strokeOpacity={0.75}
              strokeDasharray="5 4"
              data-testid="safe-margin"
            />
          </>
        )}
        {guides.map((g, i) =>
          g.axis === 'x' ? (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: guides are positional
              key={i}
              x1={Math.round(g.value * width) + 0.5}
              x2={Math.round(g.value * width) + 0.5}
              y1={0}
              y2={height}
              stroke="var(--color-accent)"
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
              stroke="var(--color-accent)"
              strokeWidth={1}
            />
          ),
        )}
      </svg>
      {badges.map((b, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: badges are positional
          key={i}
          className="absolute z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-accent px-1 py-px font-medium text-[10px] text-white tabular-nums leading-tight shadow-black/30 shadow-sm"
          style={{ left: b.x * width, top: b.y * height }}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
});
