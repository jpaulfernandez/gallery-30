import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/**
 * Pinch to zoom on a page: a CSS transform (`translate(...) scale(...)`, origin 0 0) on `content`,
 * driven by touch events on `viewport` so the track's native scroll can be suppressed with
 * `preventDefault` while two fingers are down or the page is zoomed (pointer events cannot stop a
 * scroll once it starts). Double tap toggles 1x / 2.5x at the tap, ctrl+wheel zooms on desktop.
 * Scale is clamped to 1..4 and the page is kept covering the viewport, or centred when smaller.
 *
 * `viewport` must be the content's offsetParent (`position: relative`). The `is-zoomed` class is
 * toggled on the viewport and `onZoomChange` fires on every 1x <-> zoomed transition so the reader
 * can stop the track from snapping while panning.
 */

export const MAX_ZOOM = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 40;
const DOUBLE_TAP_SCALE = 2.5;

interface Zoom {
  scale: number;
  tx: number;
  ty: number;
}

interface Point {
  x: number;
  y: number;
}

const IDENTITY: Zoom = { scale: 1, tx: 0, ty: 0 };
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export function usePinchZoom(
  viewport: RefObject<HTMLElement>,
  content: RefObject<HTMLElement>,
  onZoomChange: (zoomed: boolean) => void,
): { reset: () => void } {
  const zoom = useRef<Zoom>(IDENTITY);
  const onChange = useRef(onZoomChange);
  onChange.current = onZoomChange;
  const resetRef = useRef<() => void>(() => {});
  // Stable identity so callers can list it in effect deps.
  const reset = useRef(() => resetRef.current()).current;

  useEffect(() => {
    const el = viewport.current;
    const box = content.current;
    if (!el || !box) return;

    let zoomed = false;
    const apply = () => {
      const { scale, tx, ty } = zoom.current;
      box.style.transform = scale === 1 && tx === 0 && ty === 0 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
      const now = scale > 1;
      if (now !== zoomed) {
        zoomed = now;
        el.classList.toggle('is-zoomed', now);
        onChange.current(now);
      }
    };

    /** Keep the page covering the viewport on each axis, or centred when it is smaller. */
    const constrain = (scale: number, tx: number, ty: number): Zoom => {
      const vw = el.clientWidth;
      const vh = el.clientHeight;
      const sw = box.offsetWidth * scale;
      const sh = box.offsetHeight * scale;
      const ox = box.offsetLeft;
      const oy = box.offsetTop;
      return {
        scale,
        tx: sw <= vw ? (vw - sw) / 2 - ox : clamp(tx, vw - sw - ox, -ox),
        ty: sh <= vh ? (vh - sh) / 2 - oy : clamp(ty, vh - sh - oy, -oy),
      };
    };

    /** Zoom from `from` to `scale`, keeping the content point under the focal point `f` fixed. */
    const zoomAround = (scale: number, f: Point, from: Zoom, shift: Point = { x: 0, y: 0 }): Zoom => {
      const s = clamp(scale, 1, MAX_ZOOM);
      const k = s / from.scale;
      const fx = f.x - box.offsetLeft;
      const fy = f.y - box.offsetTop;
      return constrain(s, fx - (fx - from.tx) * k + shift.x, fy - (fy - from.ty) * k + shift.y);
    };

    const resetZoom = () => {
      zoom.current = IDENTITY;
      apply();
    };
    resetRef.current = resetZoom;

    const toggle = (p: Point) => {
      zoom.current = zoom.current.scale > 1 ? IDENTITY : zoomAround(DOUBLE_TAP_SCALE, p, zoom.current);
      apply();
    };

    const local = (t: { clientX: number; clientY: number }): Point => {
      const r = el.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    let pinch: { dist: number; mid: Point; start: Zoom } | null = null;
    let pan: Point | null = null;
    let moved = false;
    let lastTap: { at: number; p: Point } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      moved = false;
      if (e.touches.length === 2) {
        const a = local(e.touches[0] as Touch);
        const b = local(e.touches[1] as Touch);
        pinch = { dist: dist(a, b), mid: mid(a, b), start: zoom.current };
        pan = null;
        e.preventDefault();
      } else if (e.touches.length === 1 && zoom.current.scale > 1) {
        pan = local(e.touches[0] as Touch);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (pinch && e.touches.length >= 2) {
        e.preventDefault();
        const a = local(e.touches[0] as Touch);
        const b = local(e.touches[1] as Touch);
        const m = mid(a, b);
        const scale = (pinch.start.scale * dist(a, b)) / pinch.dist;
        zoom.current = zoomAround(scale, pinch.mid, pinch.start, { x: m.x - pinch.mid.x, y: m.y - pinch.mid.y });
        apply();
        moved = true;
      } else if (pan && e.touches.length === 1) {
        e.preventDefault();
        const p = local(e.touches[0] as Touch);
        const z = zoom.current;
        zoom.current = constrain(z.scale, z.tx + p.x - pan.x, z.ty + p.y - pan.y);
        pan = p;
        apply();
        moved = true;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length < 2) {
          pinch = null;
          if (zoom.current.scale < 1.02) resetZoom();
          // One finger left down: continue as a pan.
          pan = e.touches.length === 1 && zoom.current.scale > 1 ? local(e.touches[0] as Touch) : null;
        }
        return;
      }
      if (e.touches.length !== 0) return;
      pan = null;
      if (moved || e.changedTouches.length !== 1) return;
      const p = local(e.changedTouches[0] as Touch);
      const now = performance.now();
      if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && dist(p, lastTap.p) < DOUBLE_TAP_PX) {
        lastTap = null;
        e.preventDefault(); // no synthesized click
        toggle(p);
      } else {
        lastTap = { at: now, p };
      }
    };

    const onDblClick = (e: MouseEvent) => {
      e.preventDefault();
      toggle(local(e));
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel scrolls the track
      e.preventDefault();
      zoom.current = zoomAround(zoom.current.scale * Math.exp(-e.deltaY * 0.01), local(e), zoom.current);
      apply();
    };

    const opts: AddEventListenerOptions = { passive: false };
    el.addEventListener('touchstart', onTouchStart, opts);
    el.addEventListener('touchmove', onTouchMove, opts);
    el.addEventListener('touchend', onTouchEnd, opts);
    el.addEventListener('touchcancel', onTouchEnd, opts);
    el.addEventListener('dblclick', onDblClick);
    el.addEventListener('wheel', onWheel, opts);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('wheel', onWheel);
      box.style.transform = '';
      el.classList.remove('is-zoomed');
      if (zoomed) onChange.current(false);
    };
  }, [viewport, content]);

  return { reset };
}
