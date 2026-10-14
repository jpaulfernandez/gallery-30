import type { DevelopGeometry } from '@photobook/shared';
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  aspectRatioOf,
  type CropHandle,
  cropOrFull,
  frameOf,
  moveRect,
  resizeRect,
  type SourceSize,
  warpedPolygon,
} from '../../lib/develop/cropEdit';
import {
  andThen,
  type CropRect,
  foldAngle,
  IDENTITY_TRANSFORM,
  isAffine,
  type Mat3,
  normalized,
  type PerspectiveGeometry,
  preCropMatrix,
  rotateAbout,
  scale,
  translate,
} from '../../lib/develop/geometry';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from '../../store/book';
import { assetDevelop } from '../../store/library';

/** Composition guides drawn inside the crop frame; `O` cycles through them. */
export const CROP_OVERLAYS = ['thirds', 'grid', 'diagonal', 'golden', 'off'] as const;
export type CropOverlay = (typeof CROP_OVERLAYS)[number];
export const OVERLAY_LABEL: Record<CropOverlay, string> = {
  thirds: 'Thirds',
  grid: 'Grid',
  diagonal: 'Diagonal',
  golden: 'Golden ratio',
  off: 'Off',
};
export const nextOverlay = (o: CropOverlay): CropOverlay =>
  CROP_OVERLAYS[(CROP_OVERLAYS.indexOf(o) + 1) % CROP_OVERLAYS.length] ?? 'thirds';

/** Space kept around the frame so handles and turned corners stay reachable. */
export const CROP_MARGIN = 24;
const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<CropHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};
/** Ruler lines shorter than this (px) are ignored. */
const MIN_RULER = 6;

/**
 * Where the frame sits in a `width × height` box: the transformed, uncropped frame (aspect `ia`) fitted inside
 * the box less `CROP_MARGIN`, centred. A frame fraction `(u, v)` is at screen `(ox + u·fw, oy + v·fh)`.
 */
export interface FrameLayout {
  ox: number;
  oy: number;
  fw: number;
  fh: number;
}

export function frameLayout(width: number, height: number, ia: number): FrameLayout {
  const aw = Math.max(width - 2 * CROP_MARGIN, 1);
  const ah = Math.max(height - 2 * CROP_MARGIN, 1);
  const fh = Math.min(ah, aw / ia);
  const fw = fh * ia;
  return { ox: (width - fw) / 2, oy: (height - fh) / 2, fw, fh };
}

/** The crop rect in screen pixels (axis-aligned: the frame stays square to the screen). */
export const rectOnScreen = (r: CropRect, l: FrameLayout) => ({
  left: l.ox + r.x * l.fw,
  top: l.oy + r.y * l.fh,
  width: r.w * l.fw,
  height: r.h * l.fh,
});

/** The geometry the picture matrix reads (Upright and the manual Transform default to none). */
export type PictureGeometry = Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV'> & Partial<PerspectiveGeometry>;

const NO_UPRIGHT: DevelopGeometry['upright'] = { mode: 'off', guides: [], transform: null, focal: null };

/**
 * Proxy px (`iw × ih`, upright as decoded and drawn at the frame's scale) → the transformed, uncropped frame on
 * screen: proxy px → source fractions → `preCropMatrix` (orientation, Upright, the manual Transform) → the frame's
 * place in the box. `iw × ih` has the source's shape, so it stands in for the source size (the manual matrix only
 * reads the frame's aspect). Without straighten; `pictureMatrix` adds it.
 */
export function frameMatrix(g: PictureGeometry, iw: number, ih: number, l: FrameLayout): Mat3 {
  const full = { ...g, upright: g.upright ?? NO_UPRIGHT, transform: g.transform ?? IDENTITY_TRANSFORM };
  let m = andThen(scale(1 / iw, 1 / ih), preCropMatrix(full, iw, ih));
  m = andThen(m, scale(l.fw, l.fh));
  return andThen(m, translate(l.ox, l.oy));
}

/**
 * The CSS matrix that draws the un-oriented proxy (`iw × ih` px, upright as decoded) as the picture behind the
 * frame: `frameMatrix` (orientation, Upright and the manual Transform onto the frame on screen), then the
 * straighten turn about the crop centre, clockwise for a positive angle. The same chain as the Rust plan's forward
 * map, with the screen frame in place of the output.
 */
export function pictureMatrix(
  g: PictureGeometry,
  iw: number,
  ih: number,
  l: FrameLayout,
  crop: CropRect,
  angle: number,
): Mat3 {
  const cx = l.ox + (crop.x + crop.w / 2) * l.fw;
  const cy = l.oy + (crop.y + crop.h / 2) * l.fh;
  return andThen(frameMatrix(g, iw, ih, l), rotateAbout((angle * Math.PI) / 180, cx, cy));
}

/**
 * A 2-D homography as a CSS transform (with `transform-origin: 0 0`). Affine maps use `matrix(a, b, c, d, e, f)`;
 * projective ones `matrix3d`, whose column-major 4×4 puts the homography's third row in the `w` row and leaves z
 * alone: for row-major `H = [h0 h1 h2; h3 h4 h5; h6 h7 h8]`,
 * `matrix3d(h0, h3, 0, h6,  h1, h4, 0, h7,  0, 0, 1, 0,  h2, h5, 0, h8)`, so `(x, y, 0, 1)` maps to
 * `(h0x + h1y + h2, h3x + h4y + h5, 0, h6x + h7y + h8)` and the browser's perspective divide is the homography's.
 */
export function cssTransform(h: Mat3): string {
  const m = normalized(h);
  if (isAffine(m, 0)) return `matrix(${m[0]}, ${m[3]}, ${m[1]}, ${m[4]}, ${m[2]}, ${m[5]})`;
  return `matrix3d(${m[0]}, ${m[3]}, 0, ${m[6]}, ${m[1]}, ${m[4]}, 0, ${m[7]}, 0, 0, 1, 0, ${m[2]}, ${m[5]}, 0, ${m[8]})`;
}

/** The element's size in CSS px, kept up to date with a `ResizeObserver`. */
export function useBoxSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const measure = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setBox((b) => (b.width === r.width && b.height === r.height ? b : { width: r.width, height: r.height }));
  }, [ref]);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, ref]);
  return box;
}

type Drag =
  | { kind: 'move' | 'resize'; pointerId: number; x: number; y: number; start: CropRect; handle?: CropHandle }
  | { kind: 'rotate'; pointerId: number; centre: [number, number]; startAngle: number; startPointer: number }
  | { kind: 'ruler'; pointerId: number; x: number; y: number };

export interface CropToolProps {
  assetId: string;
  geometry: DevelopGeometry;
  /** The picture to show: the live render without geometry, or the cached proxy. */
  imageUrl: string | undefined;
  /** Upright source size (the crop maths and the proxy's shape). */
  size: SourceSize;
  overlay: CropOverlay;
  /** Straighten ruler armed (the panel's button); holding Cmd / Ctrl arms it for one drag too. */
  ruler: boolean;
  /** A ruler line was drawn (the button disarms). */
  onRulerDone: () => void;
  name: string;
}

/**
 * The crop overlay of the Develop view (`R`). Shows the whole oriented picture, warped by Upright and the
 * manual Transform (a CSS `matrix3d`, no render needed) and turned by the straighten angle, behind an
 * axis-aligned crop frame, dimmed outside it. With a perspective part, constrain keeps the frame inside the warped
 * outline. Drag a handle to resize (Shift keeps the aspect, Alt
 * resizes about the centre), inside to move, outside to rotate; with the ruler, drag along a horizon to level
 * it. Every drag is one undo step and goes through the crop maths so the frame never leaves the image while
 * constrain-to-image is on.
 */
export function CropTool({ assetId, geometry, imageUrl, size, overlay, ruler, onRulerDone, name }: CropToolProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(rootRef);
  const [line, setLine] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const drag = useRef<Drag | null>(null);

  // A drag cut short by unmounting (Escape, stepping) still ends its undo step.
  useEffect(
    () => () => {
      if (drag.current && drag.current.kind !== 'ruler') endDevelopDrag();
      drag.current = null;
    },
    [],
  );

  const { ia } = frameOf(geometry, size);
  const crop = cropOrFull(geometry);
  const layout = useMemo(() => frameLayout(box.width, box.height, ia), [box.width, box.height, ia]);
  const screen = rectOnScreen(crop.rect, layout);
  const swapped = geometry.rotate === 90 || geometry.rotate === 270;
  // The proxy is drawn at the frame's scale before it is oriented.
  const iw = swapped ? layout.fh : layout.fw;
  const ih = swapped ? layout.fw : layout.fh;
  const matrix = pictureMatrix(geometry, iw, ih, layout, crop.rect, crop.angle);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = rootRef.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current || box.width <= 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = local(e);
    if (ruler || e.metaKey || e.ctrlKey) {
      drag.current = { kind: 'ruler', pointerId: e.pointerId, x, y };
      setLine({ x0: x, y0: y, x1: x, y1: y });
      return;
    }
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle as
      | CropHandle
      | undefined;
    const inside =
      x >= screen.left && x <= screen.left + screen.width && y >= screen.top && y <= screen.top + screen.height;
    beginDevelopDrag();
    if (handle || inside) {
      drag.current = { kind: handle ? 'resize' : 'move', pointerId: e.pointerId, x, y, start: crop.rect, handle };
    } else {
      const centre: [number, number] = [screen.left + screen.width / 2, screen.top + screen.height / 2];
      drag.current = {
        kind: 'rotate',
        pointerId: e.pointerId,
        centre,
        startAngle: crop.angle,
        startPointer: Math.atan2(y - centre[1], x - centre[0]),
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const [x, y] = local(e);
    const store = useBookStore.getState();
    const g = assetDevelop(store, assetId)?.geometry ?? geometry;
    const current = cropOrFull(g);
    if (d.kind === 'ruler') {
      setLine((l) => (l ? { ...l, x1: x, y1: y } : l));
      return;
    }
    if (d.kind === 'rotate') {
      let delta = Math.atan2(y - d.centre[1], x - d.centre[0]) - d.startPointer;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      const angle = Math.round((d.startAngle + (delta * 180) / Math.PI) * 100) / 100;
      store.setCropAngle(assetId, Math.min(45, Math.max(-45, angle)), size);
      return;
    }
    const dx = (x - d.x) / layout.fw;
    const dy = (y - d.y) / layout.fh;
    const ctx = { ia, angle: current.angle, constrain: g.constrainCrop, poly: warpedPolygon(g, size) };
    let rect: CropRect;
    if (d.kind === 'move') rect = moveRect(d.start, dx, dy, ctx);
    else {
      const locked = aspectRatioOf(current.aspect, g, size);
      const aspect = locked ?? (e.shiftKey ? (d.start.w * ia) / d.start.h : null);
      rect = resizeRect(d.start, d.handle ?? 'se', dx, dy, { ...ctx, aspect, fromCenter: e.altKey });
    }
    store.setDevelopCrop(assetId, { ...current, rect });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (d.kind !== 'ruler') {
      endDevelopDrag();
      return;
    }
    const [x, y] = local(e);
    setLine(null);
    onRulerDone();
    if (Math.hypot(x - d.x, y - d.y) < MIN_RULER) return;
    const along = (Math.atan2(y - d.y, x - d.x) * 180) / Math.PI;
    const angle = Math.round(foldAngle(crop.angle - along) * 100) / 100;
    useBookStore.getState().setCropAngle(assetId, angle, size);
  };

  const ready = box.width > 0 && box.height > 0;
  return (
    <div
      ref={rootRef}
      data-testid="crop-tool"
      aria-label="Crop frame: drag inside to move, a handle to resize, outside to rotate"
      role="application"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={`absolute inset-0 touch-none select-none overflow-hidden ${ruler ? 'cursor-draw' : 'cursor-rotate'}`}
    >
      {ready && imageUrl && (
        <img
          src={imageUrl}
          alt={name}
          draggable={false}
          data-testid="crop-picture"
          className="pointer-events-none absolute top-0 left-0 max-w-none"
          style={{ width: iw, height: ih, transformOrigin: '0 0', transform: cssTransform(matrix) }}
        />
      )}
      {ready && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          width={box.width}
          height={box.height}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            fill="rgba(0,0,0,0.62)"
            d={`M0 0H${box.width}V${box.height}H0Z M${screen.left} ${screen.top}h${screen.width}v${screen.height}h${-screen.width}Z`}
          />
          <Guides overlay={overlay} left={screen.left} top={screen.top} width={screen.width} height={screen.height} />
          <rect
            x={screen.left}
            y={screen.top}
            width={screen.width}
            height={screen.height}
            fill="none"
            stroke="white"
            strokeWidth={1}
          />
          {line && (
            <line
              x1={line.x0}
              y1={line.y0}
              x2={line.x1}
              y2={line.y1}
              stroke="var(--color-accent, #4f8cff)"
              strokeWidth={1.5}
              data-testid="crop-ruler"
            />
          )}
        </svg>
      )}
      {ready && (
        <div
          data-testid="crop-frame"
          className="absolute"
          style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height, cursor: 'move' }}
        >
          {HANDLES.map((h) => (
            <div
              key={h}
              data-handle={h}
              className="absolute size-3 border border-stage/50 bg-fg"
              style={{
                left: h.includes('w') ? -6 : h.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
                top: h.includes('n') ? -6 : h.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)',
                cursor: HANDLE_CURSOR[h],
              }}
            />
          ))}
        </div>
      )}
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg tabular-nums">
        {crop.angle.toFixed(1)}°
      </span>
    </div>
  );
}

/** The composition guides inside the crop frame. */
function Guides({
  overlay,
  left,
  top,
  width,
  height,
}: {
  overlay: CropOverlay;
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  if (overlay === 'off') return null;
  const lines: Array<[number, number, number, number]> = [];
  const cross = (fractions: number[]) => {
    for (const f of fractions) {
      lines.push([left + f * width, top, left + f * width, top + height]);
      lines.push([left, top + f * height, left + width, top + f * height]);
    }
  };
  if (overlay === 'thirds') cross([1 / 3, 2 / 3]);
  else if (overlay === 'grid') cross([1, 2, 3, 4, 5, 6, 7].map((i) => i / 8));
  else if (overlay === 'golden') cross([0.382, 0.618]);
  else {
    // 45° lines in from each corner, as long as the short side.
    const s = Math.min(width, height);
    const r = left + width;
    const b = top + height;
    lines.push(
      [left, top, left + s, top + s],
      [r, top, r - s, top + s],
      [left, b, left + s, b - s],
      [r, b, r - s, b - s],
    );
  }
  return (
    <g data-testid={`crop-guides-${overlay}`} stroke="rgba(255,255,255,0.45)" strokeWidth={1}>
      {lines.map(([x1, y1, x2, y2]) => (
        <line key={`${x1},${y1},${x2},${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
      ))}
    </g>
  );
}
