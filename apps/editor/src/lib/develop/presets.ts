/**
 * Develop presets (step D6.3): named subsets of `DevelopSettings`. A preset lists the `sections` it applies
 * (`light`, `whiteBalance`, `curve`, `color`, `detail`, `effects`, `look`) and holds the values for them; geometry and masks belong to
 * the photo and are never part of one. Saved presets live in the app data dir (`commands/presets.rs`); the two
 * built-in ones below stand in for the page elements' `bw` and `fade` filters.
 */
import { type DevelopSettings, newId } from '@photobook/shared';
import type { DevelopPreset } from '../tauri';
import { type DeepPartial, deepMerge } from './merge';
import { DEVELOP_SECTION_KEYS, type DevelopSectionKey } from './sections';

export type Preset = DevelopPreset;

/** What the section checklists call each section. */
export const PRESET_SECTION_LABELS: Record<DevelopSectionKey, string> = {
  light: 'Light',
  whiteBalance: 'White balance',
  curve: 'Curve',
  color: 'Color',
  detail: 'Detail',
  effects: 'Effects',
  look: 'Look (LUT)',
};

/**
 * "Black & white": the element filter `bw` is `grayscale(1)`. Saturation to -100 removes the colour; a touch of
 * contrast (+10) keeps the grey from looking flat. Only those two sliders are set, so the photo's exposure,
 * curve and the rest stay as they are.
 */
export const PRESET_BW: Preset = {
  id: 'builtin:bw',
  name: 'Black & white',
  sections: ['light', 'color'],
  settings: { light: { contrast: 10 }, color: { saturation: -100 } },
  builtIn: true,
};

/**
 * "Faded": the element filter `fade` lifts the blacks and mutes the colour (`contrast(.9) saturate(.85)
 * brightness(1.05)`). The luma curve [[0, 0.08], [1, 0.96]] raises black to 8 % and pulls white to 96 %, and
 * saturation -20 mutes the colour.
 */
export const PRESET_FADED: Preset = {
  id: 'builtin:fade',
  name: 'Faded',
  sections: ['curve', 'color'],
  settings: {
    curve: {
      luma: [
        [0, 0.08],
        [1, 0.96],
      ],
    },
    color: { saturation: -20 },
  },
  builtIn: true,
};

export const BUILT_IN_PRESETS: readonly Preset[] = Object.freeze([PRESET_BW, PRESET_FADED]);

/** The sections of `preset` that exist (a stored file from a newer version may list others). */
export const presetSections = (preset: Pick<Preset, 'sections'>): DevelopSectionKey[] =>
  DEVELOP_SECTION_KEYS.filter((key) => preset.sections.includes(key));

/**
 * `settings` with the preset laid over it: for every section the preset lists, its values are merged over the
 * section as it is (a saved preset holds whole sections, so that replaces them; a partial one such as the built-ins
 * touches only the sliders it names). Other sections, the geometry and the masks are untouched. Pure.
 */
export function applyPreset(settings: DevelopSettings, preset: Pick<Preset, 'sections' | 'settings'>): DevelopSettings {
  const next: DevelopSettings = { ...settings };
  const values = preset.settings as DeepPartial<DevelopSettings>;
  for (const key of presetSections(preset)) {
    const patch = values[key];
    if (patch === undefined) continue;
    const copy = structuredClone(patch);
    // A white balance with a mode is a whole value (the modes have different fields), not a patch.
    (next as Record<string, unknown>)[key] =
      key === 'whiteBalance' && 'mode' in (copy as object)
        ? copy
        : deepMerge(settings[key], copy as DeepPartial<never>);
  }
  return next;
}

/** The part of `settings` a preset over `sections` holds: whole sections, copied. */
export function presetValues(settings: DevelopSettings, sections: readonly DevelopSectionKey[]): Preset['settings'] {
  const values: Record<string, unknown> = {};
  for (const key of DEVELOP_SECTION_KEYS) if (sections.includes(key)) values[key] = structuredClone(settings[key]);
  // Which look wrote the photo's values (plan 20) belongs to the photo, not to a preset made from it.
  const look = values.look as { applied?: unknown } | undefined;
  if (look) delete look.applied;
  return values as Preset['settings'];
}

/** A new saved preset (fresh ULID) from a photo's settings. `name` is trimmed. */
export function makePreset(
  name: string,
  settings: DevelopSettings,
  sections: readonly DevelopSectionKey[],
  id: string = newId(),
): Preset {
  const kept = DEVELOP_SECTION_KEYS.filter((key) => sections.includes(key));
  return { id, name: name.trim(), sections: kept, settings: presetValues(settings, kept), builtIn: false };
}

/** Built-in presets first, then the user's. */
export const allPresets = (saved: readonly Preset[]): Preset[] => [...BUILT_IN_PRESETS, ...saved];
