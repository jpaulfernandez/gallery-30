import { describe, expect, it } from 'vitest';
import {
  CURVE_PRESET_IDS,
  CURVE_PRESETS,
  curvePresetPoints,
  matchCurvePreset,
  withCurvePreset,
} from './curvePresets.js';
import { DEVELOP_DEFAULTS, DevelopCurveSchema, DevelopSchema, developHashInput } from './schema.js';

describe('curve presets (plan 54)', () => {
  it('lists the six presets in the chip order', () => {
    expect(CURVE_PRESETS.map((p) => p.label)).toEqual(['Linear', 'Soft S', 'Strong S', 'Matte', 'Faded', 'Reverse S']);
    expect(CURVE_PRESETS.map((p) => p.id)).toEqual([...CURVE_PRESET_IDS]);
  });

  it('are valid point curves the editor can keep editing', () => {
    for (const { id, points } of CURVE_PRESETS) {
      expect(() => DevelopCurveSchema.parse({ luma: points }), id).not.toThrow();
      expect(points[0]?.[0], id).toBe(0);
      expect(points[points.length - 1]?.[0], id).toBe(1);
      expect(points.length, id).toBeLessThanOrEqual(16);
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1] ?? [0, 0];
        const [x1, y1] = points[i] ?? [0, 0];
        // Sorted, at least the editor's minimum gap apart, and a tone map (never darker for a brighter input).
        expect(x1 - x0, id).toBeGreaterThanOrEqual(0.004);
        expect(y1, id).toBeGreaterThanOrEqual(y0);
      }
    }
  });

  it('Linear is the default curve; Matte lifts the blacks; Faded lifts the blacks and pulls the whites', () => {
    expect(curvePresetPoints('linear')).toEqual(DEVELOP_DEFAULTS.curve.luma);
    expect(curvePresetPoints('matte')[0]?.[1]).toBeGreaterThan(0);
    const faded = curvePresetPoints('faded');
    expect(faded[0]?.[1]).toBeGreaterThan(0);
    expect(faded[faded.length - 1]?.[1]).toBeLessThan(1);
  });

  it('applying one writes plain points: the hash equals the same curve drawn by hand', () => {
    const drawn = DevelopSchema.parse({
      version: DEVELOP_DEFAULTS.version,
      curve: {
        red: [
          [0, 0],
          [0.25, 0.16],
          [0.75, 0.84],
          [1, 1],
        ],
      },
    });
    const preset = { ...DEVELOP_DEFAULTS, curve: withCurvePreset(DEVELOP_DEFAULTS.curve, 'red', 'strongS') };
    expect(developHashInput(preset)).toBe(developHashInput(drawn));
    // The other channels and the parametric curve are untouched.
    expect(preset.curve.luma).toEqual(DEVELOP_DEFAULTS.curve.luma);
    expect(preset.curve.parametric).toEqual(DEVELOP_DEFAULTS.curve.parametric);
    // Linear on a default curve leaves the settings at their defaults (the same hash as no curve at all).
    const linear = { ...DEVELOP_DEFAULTS, curve: withCurvePreset(DEVELOP_DEFAULTS.curve, 'luma', 'linear') };
    expect(developHashInput(linear)).toBe(developHashInput(DEVELOP_DEFAULTS));
  });

  it('returns fresh arrays and recognises a preset by its points', () => {
    const a = curvePresetPoints('softS');
    a[1] = [0.3, 0.3];
    expect(curvePresetPoints('softS')[1]).toEqual([0.25, 0.21]);
    for (const { id } of CURVE_PRESETS) expect(matchCurvePreset(curvePresetPoints(id))).toBe(id);
    expect(
      matchCurvePreset([
        [0, 0],
        [0.5, 0.6],
        [1, 1],
      ]),
    ).toBeNull();
  });
});
