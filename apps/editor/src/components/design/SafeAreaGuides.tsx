import { findOutput, showsSafeArea, socialTemplate } from '@photobook/shared';
import { memo } from 'react';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

/**
 * A social post's safe area on the canvas (workflow plan 14): the network's template insets (`safeArea`, fractions of
 * the page) where its own interface or the profile grid's crop covers the frame, shaded outside a dashed rectangle,
 * with the reason as the tooltip; a profile grid crop only on the first frame. Its own layer over the page, apart from the layout and snap guides (CanvasGuides);
 * shown with the "Show safe area" preference, never exported. Nothing for the book or a network without one.
 */
/** Plan 48: the safe area keeps its orange, now the `warn` token (it marks where the network covers the frame). */
export const SAFE_AREA_COLOR = 'var(--color-warn)';

export const SafeAreaGuides = memo(function SafeAreaGuides({ width, height }: { width: number; height: number }) {
  const outputId = useUiStore((s) => s.design.outputId);
  const showMargins = useUiStore((s) => s.showMargins);
  const pageIndex = useUiStore((s) => s.pageIndex);
  const network = useBookStore((s) => {
    const output = s.book ? findOutput(s.book, outputId) : undefined;
    return output?.kind === 'social' ? output.network : undefined;
  });
  // The profile grid's crop concerns the first frame only (`safeAreaFrames`).
  if (!network || !showMargins || !showsSafeArea(network, pageIndex)) return null;
  const t = socialTemplate(network);
  const { top, right, bottom, left } = t.safeArea;
  const x = left * width;
  const y = top * height;
  const w = width - x - right * width;
  const h = height - y - bottom * height;
  // The page minus the safe rectangle, shaded (even-odd fill).
  const outside = `M0 0H${width}V${height}H0Z M${x} ${y}V${y + h}H${x + w}V${y}Z`;
  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="safe-area-guides"
      title={`${t.label}: ${t.safeAreaNote}`}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="absolute inset-0"
        aria-hidden="true"
      >
        <path d={outside} fill={SAFE_AREA_COLOR} fillOpacity={0.1} fillRule="evenodd" />
        <rect
          x={x + 0.5}
          y={y + 0.5}
          width={Math.max(0, w - 1)}
          height={Math.max(0, h - 1)}
          fill="none"
          stroke={SAFE_AREA_COLOR}
          strokeOpacity={0.9}
          strokeWidth={1}
          strokeDasharray="6 4"
        />
      </svg>
      <span
        className="absolute rounded-sm bg-stage/60 px-1 py-px text-[10px] text-fg"
        style={{ left: x + 4, top: y + 4 }}
      >
        {t.service} safe area
      </span>
    </div>
  );
});
