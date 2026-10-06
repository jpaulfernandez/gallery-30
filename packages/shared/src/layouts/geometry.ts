import type { Frame } from '../schema.js';

/**
 * Spacing converted to page fractions. Theme margin and gutter are fractions of the page WIDTH
 * (like every theme token, see `ThemeSchema`), so on a non-square page the y fractions differ:
 * the same absolute distance is `token * width / height` of the page height.
 */
export interface PageSpacing {
  /** Margin as a fraction of the page width / height. */
  mx: number;
  my: number;
  /** Gutter as a fraction of the page width / height. */
  gx: number;
  gy: number;
}

/**
 * @param margin fraction of the page width
 * @param gutter fraction of the page width
 * @param aspect page width / page height
 */
export function spacing(margin: number, gutter: number, aspect: number): PageSpacing {
  return { mx: margin, my: margin * aspect, gx: gutter, gy: gutter * aspect };
}

/** The page minus its margins. */
export function contentBox({ mx, my }: PageSpacing): Frame {
  return { x: mx, y: my, w: 1 - 2 * mx, h: 1 - 2 * my };
}

function split(total: number, weights: number[], gap: number): Array<[number, number]> {
  const free = total - gap * (weights.length - 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const w of weights) {
    const size = (free * w) / sum;
    out.push([at, size]);
    at += size + gap;
  }
  return out;
}

/** Split a box into columns with the given relative widths. */
export function cols(box: Frame, weights: number[], gx: number): Frame[] {
  return split(box.w, weights, gx).map(([at, size]) => ({ x: box.x + at, y: box.y, w: size, h: box.h }));
}

/** Split a box into rows with the given relative heights. */
export function rows(box: Frame, weights: number[], gy: number): Frame[] {
  return split(box.h, weights, gy).map(([at, size]) => ({ x: box.x, y: box.y + at, w: box.w, h: size }));
}

/** `n` equal parts. */
export const even = (n: number): number[] => Array.from({ length: n }, () => 1);

/**
 * One cell (optionally spanning several) of an evenly divided grid inside `box`.
 */
export function cell(
  box: Frame,
  grid: { cols: number; rows: number },
  s: Pick<PageSpacing, 'gx' | 'gy'>,
  at: { c: number; r: number; cs?: number; rs?: number },
): Frame {
  const cw = (box.w - s.gx * (grid.cols - 1)) / grid.cols;
  const rh = (box.h - s.gy * (grid.rows - 1)) / grid.rows;
  const cs = at.cs ?? 1;
  const rs = at.rs ?? 1;
  return {
    x: box.x + at.c * (cw + s.gx),
    y: box.y + at.r * (rh + s.gy),
    w: cw * cs + s.gx * (cs - 1),
    h: rh * rs + s.gy * (rs - 1),
  };
}

/** Pick element `i`, failing loudly instead of returning undefined (noUncheckedIndexedAccess). */
export function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  if (v === undefined) throw new Error(`layout geometry: index ${i} out of range`);
  return v;
}

export function frameCenter(f: Frame): { cx: number; cy: number } {
  return { cx: f.x + f.w / 2, cy: f.y + f.h / 2 };
}
