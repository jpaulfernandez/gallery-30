import { useLayoutEffect, useRef, useState } from 'react';
import {
  clampCenter,
  INITIAL_VIEWPORT,
  type Placement,
  placement,
  proxySize,
  type Size,
  type ViewportState,
  zoomTo,
} from '../cull/viewport';

/** A press that moves less than this (CSS px) is a click: it zooms instead of panning. */
const DRAG_SLOP = 4;

interface SideBySideProps {
  /** The original (the master or the version's base, as the Before view shows it). */
  beforeUrl: string | undefined;
  /** The live render, else the cached developed proxy, else the original. */
  afterUrl: string | undefined;
  name: string;
  /** The photo's pixel size, for a picture the browser has not measured yet. */
  width?: number;
  height?: number;
}

/**
 * Plan 54 (ODDHALLS_LAYOUT_PLAN 4.5): Before | After side by side, the before on the left and the after on the right
 * at the same zoom and point: one viewport for both panes, with the pure helpers of Compare's linked viewport (plan 07,
 * `components/cull/viewport.ts`), held here (not Cull's saved zoom). A click zooms both to 1× at that point (again:
 * back to Fit); a drag pans both. View only: no store write, no undo step. Keyed by photo, so a step starts at Fit.
 * The before is the uncropped original and the after the developed picture, so with a crop the two are framed
 * differently; the point is a fraction of each picture, as in Compare.
 */
export function SideBySide({ beforeUrl, afterUrl, name, width, height }: SideBySideProps) {
  const [view, setView] = useState<ViewportState>(INITIAL_VIEWPORT);
  const fallback = width && height ? proxySize(width, height) : { w: 1600, h: 1067 };
  return (
    <div className="absolute inset-0 flex gap-2 p-6" data-testid="develop-side-by-side" data-zoom={view.zoom}>
      <SidePane
        label="Before"
        src={beforeUrl}
        alt={`${name}, before`}
        fallback={fallback}
        view={view}
        onView={setView}
      />
      <SidePane label="After" src={afterUrl} alt={name} fallback={fallback} view={view} onView={setView} />
    </div>
  );
}

function SidePane({
  label,
  src,
  alt,
  fallback,
  view,
  onView,
}: {
  label: string;
  src: string | undefined;
  alt: string;
  fallback: Size;
  view: ViewportState;
  onView: (view: ViewportState) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const picture: Size = loaded && loaded.src === src ? loaded.size : fallback;
  const dpr = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  const measured = pane.w > 0 && pane.h > 0;
  const at: Placement | null = measured ? placement(view, pane, picture, dpr) : null;
  const geo = { view, pane, picture, dpr, at };
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const first = geoRef.current;
    let last = start;
    let dragged = false;
    let point = first.view.zoom === 'fit' ? first.view : clampCenter(first.view, first.pane, first.picture, first.dpr);
    const onMove = (m: MouseEvent) => {
      if (!dragged && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_SLOP) return;
      dragged = true;
      const { view: v, pane: p, picture: pic, dpr: d, at: a } = geoRef.current;
      if (v.zoom !== 'fit' && a && a.width > 0 && a.height > 0) {
        point = clampCenter(
          { ...point, cx: point.cx - (m.clientX - last.x) / a.width, cy: point.cy - (m.clientY - last.y) / a.height },
          p,
          pic,
          d,
        );
        onView(point);
      }
      last = { x: m.clientX, y: m.clientY };
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragged) return;
      const { view: v, pane: p, picture: pic, dpr: d, at: a } = geoRef.current;
      if (v.zoom !== 'fit') return onView(zoomTo(v, 'fit'));
      if (!a || a.width <= 0 || a.height <= 0) return onView(zoomTo(v, 1));
      const clicked = { x: (start.x - box.left - a.left) / a.width, y: (start.y - box.top - a.top) / a.height };
      onView(clampCenter(zoomTo(v, 1, clicked), p, pic, d));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <section aria-label={label} className="relative flex min-w-0 flex-1 flex-col">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the mouse zooms and pans; the keys stay Develop's */}
      <div
        ref={boxRef}
        onMouseDown={onMouseDown}
        className={`relative min-h-0 flex-1 overflow-hidden ${view.zoom === 'fit' ? 'cursor-zoom-in' : 'cursor-pan'}`}
      >
        {src ? (
          <img
            key={src}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w > 0 && h > 0) setLoaded({ src, size: { w, h } });
            }}
            className={`absolute max-w-none select-none ${at ? '' : 'inset-0 h-full w-full object-contain'}`}
            style={at ? { left: at.left, top: at.top, width: at.width, height: at.height } : undefined}
          />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center text-fg-muted text-xs">Preparing preview…</p>
        )}
        <span className="pointer-events-none absolute top-2 left-2 rounded-xs bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
          {label}
        </span>
      </div>
    </section>
  );
}
