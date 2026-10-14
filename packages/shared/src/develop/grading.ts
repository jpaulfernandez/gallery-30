import type { Grading, GradingWheel } from './schema.js';

/**
 * Plan 55 (ODDHALLS_LAYOUT_PLAN 4.2): the colour-grading presets the Effects card shows as chips under the wheels.
 * A preset is the three tonal wheels' hue and saturation with Blending and Balance, authored like the built-in looks
 * (hues on the colour wheel of the schema: 0 red, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta). Applying one
 * writes those values into the existing grading fields and leaves the luminance offsets, the Global wheel and the
 * harmony lock as they are: no schema field of its own, hashed and rendered like the same values set by hand.
 */
export const GRADING_PRESET_IDS = ['tealOrange', 'warmCool', 'bleach', 'golden', 'moodyBlue', 'pastel'] as const;
export type GradingPresetId = (typeof GRADING_PRESET_IDS)[number];

type HueSat = Pick<GradingWheel, 'hue' | 'saturation'>;

/** What a preset writes. */
export interface GradingPresetValues {
  shadows: HueSat;
  midtones: HueSat;
  highlights: HueSat;
  blending: number;
  balance: number;
}

export interface GradingPreset {
  id: GradingPresetId;
  /** The chip's label. */
  label: string;
  /** The chip's tooltip. */
  hint: string;
  values: GradingPresetValues;
}

export const GRADING_PRESETS: readonly GradingPreset[] = [
  {
    id: 'tealOrange',
    label: 'Teal & orange',
    hint: 'Teal shadows, orange highlights: the film-poster split',
    values: {
      shadows: { hue: 190, saturation: 35 },
      midtones: { hue: 0, saturation: 0 },
      highlights: { hue: 32, saturation: 30 },
      blending: 60,
      balance: 0,
    },
  },
  {
    id: 'warmCool',
    label: 'Warm/cool split',
    hint: 'Cool blue shadows under warm highlights',
    values: {
      shadows: { hue: 220, saturation: 25 },
      midtones: { hue: 0, saturation: 0 },
      highlights: { hue: 42, saturation: 25 },
      blending: 50,
      balance: 0,
    },
  },
  {
    id: 'bleach',
    label: 'Bleach',
    hint: 'A cold, metallic cast with barely warm highlights',
    values: {
      shadows: { hue: 200, saturation: 12 },
      midtones: { hue: 180, saturation: 5 },
      highlights: { hue: 50, saturation: 6 },
      blending: 70,
      balance: 10,
    },
  },
  {
    id: 'golden',
    label: 'Golden',
    hint: 'Late-afternoon gold, strongest in the highlights',
    values: {
      shadows: { hue: 30, saturation: 15 },
      midtones: { hue: 40, saturation: 15 },
      highlights: { hue: 45, saturation: 30 },
      blending: 60,
      balance: 20,
    },
  },
  {
    id: 'moodyBlue',
    label: 'Moody blue',
    hint: 'Deep blue shadows that reach into the midtones',
    values: {
      shadows: { hue: 225, saturation: 40 },
      midtones: { hue: 210, saturation: 12 },
      highlights: { hue: 200, saturation: 8 },
      blending: 55,
      balance: -20,
    },
  },
  {
    id: 'pastel',
    label: 'Pastel',
    hint: 'Soft lilac shadows, pink midtones, mint highlights',
    values: {
      shadows: { hue: 280, saturation: 12 },
      midtones: { hue: 330, saturation: 8 },
      highlights: { hue: 170, saturation: 12 },
      blending: 80,
      balance: 10,
    },
  },
];

const TONAL = ['shadows', 'midtones', 'highlights'] as const;

/** The values of preset `id`. */
export function gradingPresetValues(id: GradingPresetId): GradingPresetValues {
  const preset = GRADING_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`No grading preset "${id}"`);
  return structuredClone(preset.values);
}

/** `grading` with preset `id` written into it: the three wheels' hue and saturation, Blending and Balance. Pure. */
export function withGradingPreset(grading: Grading, id: GradingPresetId): Grading {
  const v = gradingPresetValues(id);
  const next: Grading = { ...grading, blending: v.blending, balance: v.balance };
  for (const key of TONAL) next[key] = { ...grading[key], ...v[key] };
  return next;
}

/** The preset whose values `grading` has (luminance, the Global wheel and the lock aside), or null. */
export function matchGradingPreset(grading: Grading): GradingPresetId | null {
  for (const p of GRADING_PRESETS) {
    const v = p.values;
    if (grading.blending !== v.blending || grading.balance !== v.balance) continue;
    if (TONAL.every((k) => grading[k].hue === v[k].hue && grading[k].saturation === v[k].saturation)) return p.id;
  }
  return null;
}
