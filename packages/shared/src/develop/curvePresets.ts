import type { CurvePoint, DevelopCurve } from './schema.js';

/**
 * Plan 54 (ODDHALLS_LAYOUT_PLAN 4.1): the point-curve presets the Light card's Curve shows as chips. A preset is only
 * a list of points: applying one writes those points into a channel of the existing curve field exactly as a drawn
 * curve would, so it is hashed and rendered like one (no schema field, no render maths, no engine version).
 *
 * Every list is sorted by input, starts at x = 0 and ends at x = 1, and keeps its points at least
 * `MIN_POINT_GAP` (0.004, the editor's) apart, so the curve editor can go on editing it.
 */
export const CURVE_PRESET_IDS = ['linear', 'softS', 'strongS', 'matte', 'faded', 'reverseS'] as const;
export type CurvePresetId = (typeof CURVE_PRESET_IDS)[number];

export interface CurvePreset {
  id: CurvePresetId;
  /** The chip's label. */
  label: string;
  /** The chip's tooltip. */
  hint: string;
  points: readonly CurvePoint[];
}

export const CURVE_PRESETS: readonly CurvePreset[] = [
  {
    id: 'linear',
    label: 'Linear',
    hint: 'No curve: output equals input',
    points: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    id: 'softS',
    label: 'Soft S',
    hint: 'A little more contrast in the midtones',
    points: [
      [0, 0],
      [0.25, 0.21],
      [0.75, 0.79],
      [1, 1],
    ],
  },
  {
    id: 'strongS',
    label: 'Strong S',
    hint: 'Strong midtone contrast: darker shadows, brighter highlights',
    points: [
      [0, 0],
      [0.25, 0.16],
      [0.75, 0.84],
      [1, 1],
    ],
  },
  {
    id: 'matte',
    label: 'Matte',
    hint: 'Lifted blacks: the darkest tones turn to a soft grey',
    points: [
      [0, 0.08],
      [0.25, 0.25],
      [1, 1],
    ],
  },
  {
    id: 'faded',
    label: 'Faded',
    hint: 'Lifted blacks and pulled whites: a low-contrast, printed look',
    points: [
      [0, 0.1],
      [0.5, 0.5],
      [1, 0.9],
    ],
  },
  {
    id: 'reverseS',
    label: 'Reverse S',
    hint: 'Less midtone contrast, flatter and softer',
    points: [
      [0, 0],
      [0.25, 0.3],
      [0.75, 0.7],
      [1, 1],
    ],
  },
];

/** A fresh copy of a preset's points (the curve field owns its arrays). */
export function curvePresetPoints(id: CurvePresetId): CurvePoint[] {
  const preset = CURVE_PRESETS.find((p) => p.id === id);
  return (preset?.points ?? CURVE_PRESETS[0]?.points ?? []).map(([x, y]) => [x, y] as CurvePoint);
}

/** The preset a channel's points equal, or null for a drawn curve that matches none. */
export function matchCurvePreset(points: readonly CurvePoint[]): CurvePresetId | null {
  for (const preset of CURVE_PRESETS) {
    if (
      preset.points.length === points.length &&
      preset.points.every(([x, y], i) => points[i]?.[0] === x && points[i]?.[1] === y)
    ) {
      return preset.id;
    }
  }
  return null;
}

/** `curve` with one channel set to a preset's points: what the curve editor writes for a chip. */
export function withCurvePreset(
  curve: DevelopCurve,
  channel: 'luma' | 'red' | 'green' | 'blue',
  id: CurvePresetId,
): DevelopCurve {
  return { ...curve, [channel]: curvePresetPoints(id) };
}
