import { describe, expect, it } from 'vitest';
import {
  createDevelop,
  DevelopSchema,
  developHashInput,
  GRADING_PRESET_IDS,
  GRADING_PRESETS,
  gradingPresetValues,
  matchGradingPreset,
  withGradingPreset,
} from './index.js';

describe('grading presets (plan 55)', () => {
  it('lists the six presets of the Layout plan in order, each valid in the schema', () => {
    expect(GRADING_PRESETS.map((p) => p.label)).toEqual([
      'Teal & orange',
      'Warm/cool split',
      'Bleach',
      'Golden',
      'Moody blue',
      'Pastel',
    ]);
    expect(GRADING_PRESETS.map((p) => p.id)).toEqual([...GRADING_PRESET_IDS]);
    for (const p of GRADING_PRESETS) {
      expect(() => DevelopSchema.parse({ version: 1, effects: { grading: p.values } }), p.id).not.toThrow();
      expect(p.hint.length).toBeGreaterThan(0);
    }
  });

  it('writes the wheels, Blending and Balance and keeps luminance, the Global wheel and the lock', () => {
    const grading = createDevelop().effects.grading;
    grading.shadows.luminance = 20;
    grading.global = { hue: 90, saturation: 10, luminance: -5 };
    grading.harmony = 'triadic';
    const next = withGradingPreset(grading, 'tealOrange');
    expect(next.shadows).toEqual({ hue: 190, saturation: 35, luminance: 20 });
    expect(next.highlights).toMatchObject({ hue: 32, saturation: 30 });
    expect(next.global).toEqual(grading.global);
    expect(next.harmony).toBe('triadic');
    expect(matchGradingPreset(next)).toBe('tealOrange');
    expect(matchGradingPreset(createDevelop().effects.grading)).toBeNull();
    // Pure: the input is untouched, and the values are a copy.
    expect(grading.shadows.hue).toBe(0);
    const v = gradingPresetValues('golden');
    v.blending = 0;
    expect(gradingPresetValues('golden').blending).toBe(60);
  });

  it('a preset hashes like the same values set by hand', () => {
    for (const id of GRADING_PRESET_IDS) {
      const s = createDevelop();
      s.effects.grading = withGradingPreset(s.effects.grading, id);
      const byHand = { version: 1 as const, effects: { grading: gradingPresetValues(id) } };
      expect(developHashInput(s)).toBe(developHashInput(byHand));
      expect(matchGradingPreset(s.effects.grading)).toBe(id);
    }
  });
});
