import { createDevelop, DevelopSchema } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  allPresets,
  applyPreset,
  BUILT_IN_PRESETS,
  makePreset,
  PRESET_BW,
  PRESET_FADED,
  presetSections,
  presetValues,
} from './presets';

const edited = () =>
  DevelopSchema.parse({
    ...createDevelop(),
    light: { exposure: 0.8, contrast: -20, shadows: 30 },
    color: { vibrance: 25, saturation: 10, mix: { orange: { hue: 12 } } },
    curve: {
      luma: [
        [0, 0],
        [0.5, 0.6],
        [1, 1],
      ],
    },
    geometry: { rotate: 90, crop: { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' } },
  });

describe('built-in presets', () => {
  it('are the equivalents of the bw and fade element filters', () => {
    expect(BUILT_IN_PRESETS.map((p) => [p.id, p.name, p.builtIn])).toEqual([
      ['builtin:bw', 'Black & white', true],
      ['builtin:fade', 'Faded', true],
    ]);
    expect(PRESET_BW.settings).toEqual({ light: { contrast: 10 }, color: { saturation: -100 } });
    expect(PRESET_FADED.settings).toEqual({
      curve: {
        luma: [
          [0, 0.08],
          [1, 0.96],
        ],
      },
      color: { saturation: -20 },
    });
  });

  it('only name the tone and colour sections, never geometry or masks', () => {
    for (const p of BUILT_IN_PRESETS) {
      expect(Object.keys(p.settings).every((k) => p.sections.includes(k as never))).toBe(true);
      expect(Object.keys(p.settings)).not.toContain('geometry');
      expect(Object.keys(p.settings)).not.toContain('masks');
    }
  });
});

describe('applyPreset', () => {
  it('Black & white sets saturation and contrast and leaves everything else of the photo alone', () => {
    const before = edited();
    const after = applyPreset(before, PRESET_BW);
    expect(after.color.saturation).toBe(-100);
    expect(after.light.contrast).toBe(10);
    // Only the named sliders moved.
    expect(after.light.exposure).toBe(0.8);
    expect(after.light.shadows).toBe(30);
    expect(after.color.vibrance).toBe(25);
    expect(after.color.mix.orange.hue).toBe(12);
    expect(after.curve).toEqual(before.curve);
    expect(after.geometry).toEqual(before.geometry);
    expect(after.masks).toEqual(before.masks);
    // And the input is untouched.
    expect(before.color.saturation).toBe(10);
    expect(DevelopSchema.safeParse(after).success).toBe(true);
  });

  it('Faded lifts the blacks with a luma curve and mutes the colour', () => {
    const after = applyPreset(edited(), PRESET_FADED);
    expect(after.curve.luma).toEqual([
      [0, 0.08],
      [1, 0.96],
    ]);
    expect(after.curve.red).toEqual(edited().curve.red);
    expect(after.color.saturation).toBe(-20);
    expect(after.color.vibrance).toBe(25);
    expect(after.light).toEqual(edited().light);
  });

  it('skips sections the preset does not list, even when its settings carry them', () => {
    const preset = { sections: ['color' as const], settings: { color: { saturation: 5 }, light: { exposure: 4 } } };
    const after = applyPreset(edited(), preset);
    expect(after.color.saturation).toBe(5);
    expect(after.light.exposure).toBe(0.8);
  });

  it('a saved preset holds whole sections and replaces them', () => {
    const source = edited();
    const preset = makePreset('Look', source, ['light', 'color']);
    const target = createDevelop();
    const after = applyPreset(target, preset);
    expect(after.light).toEqual(source.light);
    expect(after.color).toEqual(source.color);
    expect(after.curve).toEqual(target.curve);
    // Applying onto a photo with other values replaces the section, including sliders the preset has at 0.
    const busy = DevelopSchema.parse({ ...createDevelop(), light: { highlights: -50, exposure: 2 } });
    expect(applyPreset(busy, preset).light).toEqual(source.light);
  });

  it('a white balance in a preset is a whole value, not merged field by field', () => {
    const custom = DevelopSchema.parse({
      ...createDevelop(),
      whiteBalance: { mode: 'incremental', temperature: 20, tint: 5 },
    });
    const preset = makePreset('Neutral', createDevelop(), ['whiteBalance']);
    expect(applyPreset(custom, preset).whiteBalance).toEqual({ mode: 'asShot' });
    const warm = makePreset('Warm', custom, ['whiteBalance']);
    expect(applyPreset(createDevelop(), warm).whiteBalance).toEqual({ mode: 'incremental', temperature: 20, tint: 5 });
  });
});

describe('makePreset', () => {
  it('copies the chosen sections in the schema order, trims the name and mints a ULID', () => {
    const source = edited();
    const p = makePreset('  Warm look ', source, ['color', 'light']);
    expect(p.name).toBe('Warm look');
    expect(p.sections).toEqual(['light', 'color']);
    expect(Object.keys(p.settings)).toEqual(['light', 'color']);
    expect(p.builtIn).toBe(false);
    expect(p.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // A copy: editing the source later does not change it.
    source.light.exposure = -3;
    expect(p.settings.light?.exposure).toBe(0.8);
  });

  it('presetValues leaves out geometry and masks even if asked for them', () => {
    const values = presetValues(edited(), ['light', 'geometry' as never, 'masks' as never]);
    expect(Object.keys(values)).toEqual(['light']);
  });

  it('presetSections ignores sections this version does not know', () => {
    expect(presetSections({ sections: ['detail', 'bogus' as never, 'light'] })).toEqual(['light', 'detail']);
  });

  it('lists the built-in presets before the saved ones', () => {
    const mine = makePreset('Mine', createDevelop(), ['light']);
    expect(allPresets([mine]).map((p) => p.name)).toEqual(['Black & white', 'Faded', 'Mine']);
  });
});
