import { useCallback, useMemo, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui';

/**
 * The zoom stops of Compare. `fit` shows the whole picture in its pane; a number is the proxy's own pixels times it
 * (1 is one proxy pixel per screen pixel, so a look at sharpness never decodes the original).
 */
export type ZoomStop = 'fit' | 1 | 2 | 4;
export const ZOOM_STOPS: readonly ZoomStop[] = ['fit', 1, 2, 4];

/**
 * What both Compare panes show: a zoom stop and the loupe point, as fractions of the picture (0.5, 0.5 is its
 * centre). Fractions, not pixels, so two photos of one scene line up whatever their size.
 */
export interface ViewportState {
  zoom: ZoomStop;
  cx: number;
  cy: number;
}

export const INITIAL_VIEWPORT: ViewportState = { zoom: 'fit', cx: 0.5, cy: 0.5 };

/** Long edge of `proxy.jpg` (`PROXY_EDGE` in `commands/assets.rs`), for a picture whose size the browser has not told yet. */
export const PROXY_EDGE = 1600;

export interface Size {
  w: number;
  h: number;
}

/** The size of the proxy of a photo that is `w` by `h`. */
export function proxySize(w: number, h: number): Size {
  const scale = Math.min(1, PROXY_EDGE / Math.max(w, h, 1));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** The next zoom stop in (`dir` 1) or out (-1), stopping at the ends. */
export function stepZoom(zoom: ZoomStop, dir: 1 | -1): ZoomStop {
  const at = ZOOM_STOPS.indexOf(zoom) + dir;
  return ZOOM_STOPS[Math.min(Math.max(at, 0), ZOOM_STOPS.length - 1)] ?? 'fit';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Where the picture sits in its pane, px from the pane's top left. */
export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Screen (CSS) px per proxy px: `fit` makes the picture fit the pane; a stop is that many proxy pixels per device
 * pixel, so 1× is one proxy pixel on one screen pixel whatever the display's `dpr` (devicePixelRatio).
 */
function scaleOf(zoom: ZoomStop, pane: Size, picture: Size, dpr: number): number {
  if (zoom !== 'fit') return zoom / dpr;
  return Math.min(pane.w / Math.max(picture.w, 1), pane.h / Math.max(picture.h, 1));
}

/**
 * `view` with its loupe point kept where the picture still fills `pane` (centred on an axis the picture is smaller
 * than the pane on), so a click near an edge or a drag never leaves the pane empty. Fit has no point to keep.
 */
export function clampCenter(view: ViewportState, pane: Size, picture: Size, dpr = 1): ViewportState {
  if (view.zoom === 'fit') return view;
  const scale = scaleOf(view.zoom, pane, picture, dpr);
  const axis = (at: number, extent: number, size: number) => {
    const half = size > 0 ? extent / (2 * size) : 0.5;
    return clamp(at, Math.min(0.5, half), Math.max(0.5, 1 - half));
  };
  return {
    ...view,
    cx: axis(view.cx, pane.w, picture.w * scale),
    cy: axis(view.cy, pane.h, picture.h * scale),
  };
}

/** `view` at another stop around the same point (`point` when given: the one clicked); 0 to 1 either way. */
export function zoomTo(view: ViewportState, zoom: ZoomStop, point?: { x: number; y: number }): ViewportState {
  if (zoom === 'fit') return { ...view, zoom };
  return { zoom, cx: clamp(point?.x ?? view.cx, 0, 1), cy: clamp(point?.y ?? view.cy, 0, 1) };
}

/**
 * The picture's box in a pane: contained and centred at fit, else the stop's scale with the (clamped) loupe point at
 * the pane's centre; a picture smaller than the pane on an axis stays centred on it.
 */
export function placement(view: ViewportState, pane: Size, picture: Size, dpr = 1): Placement {
  const { zoom, cx, cy } = clampCenter(view, pane, picture, dpr);
  const scale = scaleOf(zoom, pane, picture, dpr);
  const width = picture.w * scale;
  const height = picture.h * scale;
  const axis = (extent: number, size: number, at: number) =>
    zoom === 'fit' || size <= extent ? (extent - size) / 2 : extent / 2 - at * size;
  return { left: axis(pane.w, width, cx), top: axis(pane.h, height, cy), width, height };
}

/**
 * One viewport for several panes: zoom and pan on either move both. The zoom stop is Cull's one zoom (`ui.cull.zoom`,
 * plan 52: the filter bar's control, shared by One and Two); the loupe point is the view's own.
 */
export function useLinkedViewport() {
  const zoom = useUiStore((s) => s.cull.zoom);
  const [point, setPoint] = useState({ cx: INITIAL_VIEWPORT.cx, cy: INITIAL_VIEWPORT.cy });
  // The point as last set (a key can repeat before a render); the zoom is read from the store when used.
  const pointRef = useRef(point);
  const view = useMemo<ViewportState>(() => ({ zoom, ...point }), [zoom, point]);
  const setView = useCallback((next: ViewportState) => {
    pointRef.current = { cx: next.cx, cy: next.cy };
    setPoint(pointRef.current);
    useUiStore.getState().setCull({ zoom: next.zoom });
  }, []);
  const current = useCallback(
    (): ViewportState => ({ zoom: useUiStore.getState().cull.zoom, ...pointRef.current }),
    [],
  );
  const setZoom = useCallback(
    (to: ZoomStop, at?: { x: number; y: number }) => setView(zoomTo(current(), to, at)),
    [setView, current],
  );
  const step = useCallback(
    (dir: 1 | -1) => setView(zoomTo(current(), stepZoom(current().zoom, dir))),
    [setView, current],
  );
  return { view, setView, setZoom, step };
}
