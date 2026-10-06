import type { Frame } from '../schema.js';

/** Round to keep inline styles short and stable across renders. */
export function num(n: number, digits = 4): string {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Fraction -> percentage string. */
export const pct = (fraction: number): string => `${num(fraction * 100)}%`;

/** Absolute box from a page-fraction frame. */
export function frameStyle(f: Frame): {
  position: 'absolute';
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return { position: 'absolute', left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) };
}

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
