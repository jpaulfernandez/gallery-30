/**
 * Plan 44: colour maths for the kitchen sink. Parses a computed CSS colour (`oklch(…)`, `rgb(…)`, `rgba(…)`,
 * `color(srgb …)` or `#rrggbb`), and gives its OKLCH chroma and its WCAG contrast against another colour.
 */

export interface Rgba {
  /** Linear-light sRGB, 0–1 (may fall outside for out-of-gamut OKLCH). */
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const decode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** OKLCH (lightness 0–1, chroma, hue in degrees) to linear sRGB. */
export function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** Linear sRGB to OKLCH. */
export function linearToOklch(r: number, g: number, b: number): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

const num = (s: string): number => (s.endsWith('%') ? Number.parseFloat(s) / 100 : Number.parseFloat(s));

/** A computed CSS colour, or null when the format is not one of the above. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (hex?.[1]) {
    const v = (i: number) => decode(Number.parseInt(hex[1]?.slice(i, i + 2) ?? '0', 16) / 255);
    return { r: v(0), g: v(2), b: v(4), a: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1 };
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(s);
  if (!fn?.[1] || fn[2] === undefined) return null;
  const [body, alphaPart] = fn[2].split('/');
  const parts = (body ?? '').replace(/,/g, ' ').trim().split(/\s+/);
  const commaAlpha = fn[1] === 'rgba' || (fn[1] === 'rgb' && parts.length === 4) ? parts[3] : undefined;
  const alpha = alphaPart !== undefined ? num(alphaPart.trim()) : commaAlpha !== undefined ? num(commaAlpha) : 1;
  if (fn[1] === 'oklch') {
    const [l, c, h] = parts.map((p, i) => (i === 0 && !p.endsWith('%') ? Number.parseFloat(p) : num(p)));
    if (l === undefined || c === undefined) return null;
    const [r, g, b] = oklchToLinear(l, c, Number.isFinite(h) ? (h ?? 0) : 0);
    return { r, g, b, a: alpha };
  }
  if (fn[1] === 'rgb' || fn[1] === 'rgba') {
    const [r, g, b] = parts.slice(0, 3).map((p) => decode(p.endsWith('%') ? num(p) : Number.parseFloat(p) / 255));
    if (r === undefined || g === undefined || b === undefined) return null;
    return { r, g, b, a: alpha };
  }
  if (fn[1] === 'color' && parts[0] === 'srgb') {
    const [r, g, b] = parts.slice(1, 4).map((p) => decode(num(p)));
    if (r === undefined || g === undefined || b === undefined) return null;
    return { r, g, b, a: alpha };
  }
  return null;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** `#rrggbb` of a colour (alpha dropped, clipped to the sRGB gamut). */
export function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(255 * clamp01(encode(clamp01(v))))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export const chromaOf = ({ r, g, b }: Rgba): number => linearToOklch(r, g, b).c;

const luminance = ({ r, g, b }: Rgba): number => 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b);

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
