import type { DevelopGeometry } from '@photobook/shared';
import { useMemo, useRef } from 'react';
import { cropOrFull, frameOf, type SourceSize } from '../../lib/develop/cropEdit';
import {
  andThen,
  applyMat,
  type Mat3,
  perspectiveMatrix,
  rotateAbout,
  scale,
  translate,
} from '../../lib/develop/geometry';
import { orientationKey, useUiStore } from '../../store/ui';
import { frameLayout, useBoxSize } from './CropTool';

/** Colours of the used and rejected lines. */
const USED = '#ffd84a';
const REJECTED = 'rgba(255,255,255,0.4)';

/**
 * Oriented-frame fractions → screen px in a `width × height` box showing the developed render (`object-contain`
 * inside the `CROP_MARGIN` the Develop image keeps, i.e. `frameLayout` with the crop's aspect): `perspectiveMatrix`
 * (Upright and the manual Transform) onto the transformed frame, the straighten turn about the crop centre
 * (clockwise for a positive angle, as `pictureMatrix`), then the crop rect onto the fitted picture. Without a crop
 * this is the guides overlay's frame mapping.
 */
export function structureToScreen(g: DevelopGeometry, size: SourceSize, width: number, height: number): Mat3 {
  const { fw, fh } = frameOf(g, size);
  const { rect, angle } = cropOrFull(g);
  const cw = rect.w * fw;
  const ch = rect.h * fh;
  const layout = frameLayout(width, height, cw / ch);
  let m = andThen(perspectiveMatrix(g, fw, fh), scale(fw, fh));
  m = andThen(m, rotateAbout((angle * Math.PI) / 180, (rect.x + rect.w / 2) * fw, (rect.y + rect.h / 2) * fh));
  m = andThen(m, translate(-rect.x * fw, -rect.y * fh));
  m = andThen(m, scale(layout.fw / cw, layout.fh / ch));
  return andThen(m, translate(layout.ox, layout.oy));
}

export interface StructureOverlayProps {
  assetId: string;
  geometry: DevelopGeometry;
  size: SourceSize;
}

/**
 * "Show structure" (step D2.3): the straight lines the last automatic Upright analysis of this photo found, drawn
 * over the developed picture, the ones the correction used in yellow and the rejected ones muted. The lines live in
 * the oriented frame, so they follow Upright, the manual Transform and the crop; they are hidden once the photo's
 * orientation differs from the analysed one (Update analyses it again).
 */
export function StructureOverlay({ assetId, geometry, size }: StructureOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(rootRef);
  const record = useUiStore((s) => s.uprightLines);
  const lines =
    record && record.assetId === assetId && record.orientation === orientationKey(geometry) ? record.lines : null;
  const m = useMemo(
    () => (box.width > 0 && box.height > 0 ? structureToScreen(geometry, size, box.width, box.height) : null),
    [geometry, size, box.width, box.height],
  );
  // Rejected first, so the used lines draw on top.
  const ordered = useMemo(() => (lines ? [...lines].sort((a, b) => Number(a.used) - Number(b.used)) : []), [lines]);
  const used = ordered.filter((l) => l.used).length;

  return (
    <div
      ref={rootRef}
      data-testid="structure-overlay"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden={lines ? undefined : true}
    >
      {lines && m && (
        <svg
          className="absolute inset-0 h-full w-full"
          width={box.width}
          height={box.height}
          role="img"
          aria-label={`Structure: ${lines.length} lines, ${used} used`}
        >
          {ordered.map((l, i) => {
            const [x1, y1] = applyMat(m, [l.x0, l.y0]);
            const [x2, y2] = applyMat(m, [l.x1, l.y1]);
            if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
            return (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines have no ids and never reorder in place
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                data-testid="structure-line"
                className={l.used ? 'structure-used' : 'structure-rejected'}
                stroke={l.used ? USED : REJECTED}
                strokeWidth={l.used ? 1.5 : 1}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
      )}
      {lines && (
        <span className="absolute top-2 left-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
          Structure: {used} of {lines.length} lines used
        </span>
      )}
    </div>
  );
}
