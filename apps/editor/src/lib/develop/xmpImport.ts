/**
 * Importing Lightroom (or Photobook) XMP settings into a photo (step D6.3): the settings an import produces, and the
 * table of what it changes. Pure; `store/book.ts` writes the result and `XmpImportDialog` shows the table.
 */
import { DEVELOP_DEFAULTS, type DevelopSettings } from '@photobook/shared';
import type { XmpImportResult } from '../tauri';
import { deepEqual } from './merge';

export type OrientationChange = NonNullable<XmpImportResult['orientationChange']>;

/**
 * The develop settings an import leaves on a photo whose current settings are `current`: the imported ones over the
 * defaults (the whole tree is replaced, so masks the Lightroom packet could not carry are gone).
 *
 * `change` is set when the sidecar records another orientation than the file. Its crop, Upright and Transform were
 * mapped into that orientation, so with `applyOrientation` the rotation and flip are set to match; without it the
 * photo's own geometry stays as it was (those fields would land in the wrong frame).
 */
export function importedDevelop(
  current: DevelopSettings | undefined,
  imported: DevelopSettings,
  change: OrientationChange | null | undefined,
  applyOrientation: boolean,
): DevelopSettings {
  const next = structuredClone(imported);
  if (!change) return next;
  next.geometry = applyOrientation
    ? { ...next.geometry, rotate: change.rotate, flipH: change.flipH, flipV: false }
    : structuredClone((current ?? DEVELOP_DEFAULTS).geometry);
  return next;
}

/** One line of the import preview. */
export interface DiffRow {
  /** Dotted path in the settings, e.g. `light.exposure`. */
  path: string;
  /** The first segment, humanised: Light, White balance, Curve, Color, Detail, Geometry, Masks. */
  group: string;
  /** The rest of the path, humanised. */
  label: string;
  from: string;
  to: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `whiteBalance` → `White balance`; `mix` → `Mix`. */
export function humanise(segment: string): string {
  const words = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const round = (n: number): string => String(Math.round(n * 1000) / 1000);

/** A value for the table: numbers rounded, lists counted, `null` as "none", a missing value as a dash. */
export function formatValue(path: string, value: unknown): string {
  if (value === undefined) return '–';
  if (value === null) return 'none';
  if (typeof value === 'number') return round(value);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    if (path === 'masks') return value.length === 1 ? '1 mask' : `${value.length} masks`;
    if (path.startsWith('curve.')) return `${value.length} points`;
    if (value.every((v) => typeof v === 'number')) return value.map((v) => round(v as number)).join(', ');
    return value.length === 1 ? '1 item' : `${value.length} items`;
  }
  return 'set';
}

/**
 * Every setting that differs between `current` and `next`, in tree order. Objects are compared key by key; lists
 * (curve points, masks, guides) and a crop that appears or goes are one row each.
 */
export function diffDevelop(current: DevelopSettings, next: DevelopSettings): DiffRow[] {
  const rows: DiffRow[] = [];
  const walk = (path: string[], a: unknown, b: unknown) => {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
        (k) => !(path.length === 0 && k === 'version'),
      );
      for (const key of keys) walk([...path, key], a[key], b[key]);
      return;
    }
    if (deepEqual(a, b)) return;
    const dotted = path.join('.');
    const [first = '', ...rest] = path;
    rows.push({
      path: dotted,
      group: humanise(first),
      label: rest.map(humanise).join(' › ') || humanise(first),
      from: formatValue(dotted, a),
      to: formatValue(dotted, b),
    });
  };
  walk([], current, next);
  return rows;
}
