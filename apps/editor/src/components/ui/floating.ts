import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react';

/** Gap between a trigger and its panel, px. */
export const OFFSET = 4;
/** Distance kept from the window edges, px. */
export const EDGE = 8;

/** What a floating panel hangs from: a trigger's box, or a point (a right-click). */
export type Anchor = { kind: 'rect'; rect: DOMRect } | { kind: 'point'; x: number; y: number };

export interface Placement {
  /** Align the panel's right edge with the anchor's (a rect) or put the panel left of the point. */
  alignEnd?: boolean;
  /** Prefer the side above the anchor (a strip at the bottom of the window). */
  above?: boolean;
}

/**
 * Where a panel of `width` × `height` goes next to `anchor`: under it (or above when asked, or when it does not fit),
 * kept `EDGE` px inside the window.
 */
export function placePanel(
  anchor: Anchor,
  width: number,
  height: number,
  { alignEnd, above }: Placement = {},
  view: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): { left: number; top: number } {
  const box =
    anchor.kind === 'rect'
      ? anchor.rect
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  let left = alignEnd ? box.right - width : box.left;
  left = Math.min(Math.max(left, EDGE), view.width - width - EDGE);
  const below = box.bottom + OFFSET;
  const over = box.top - OFFSET - height;
  const fitsBelow = below + height <= view.height - EDGE;
  const fitsAbove = over >= EDGE;
  let top = above ? (fitsAbove || !fitsBelow ? over : below) : fitsBelow || !fitsAbove ? below : over;
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, view.height - height - EDGE));
  return { left, top };
}

/**
 * The fixed position of an open panel (`null` while closed). It is measured after layout and again on a window
 * resize; until then the panel sits off screen so it never flashes at the wrong place.
 */
export function useFloating(
  open: boolean,
  anchor: () => Anchor | null,
  panel: RefObject<HTMLElement | null>,
  width: number,
  placement: Placement,
): { left: number; top: number } {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { alignEnd, above } = placement;
  const place = useCallback(() => {
    const a = anchor();
    if (!a) return;
    setPos(placePanel(a, width, panel.current?.offsetHeight ?? 0, { alignEnd, above }));
  }, [anchor, panel, width, alignEnd, above]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);

  return pos ?? { left: -9999, top: -9999 };
}

/** Elements a panel focuses: its first one on open. */
export const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
