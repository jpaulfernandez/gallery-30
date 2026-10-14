import { createDevelop, DEVELOP_DEFAULTS, type DevelopSettings, developHashInput } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  allLooks,
  appliedAfterCopy,
  applyLook,
  BUILT_IN_LOOKS,
  chosenLookId,
  isLook,
  lookAmountOf,
  lookBase,
  lookIntact,
  lookThumbKey,
  makeLook,
  makeLutLook,
  NO_LOOK,
  removeLook,
  replaceLook,
  setLookLookup,
  stepLookId,
  untouchedLookSections,
} from './looks';
import { PRESET_BW, type Preset } from './presets';
import { applySections } from './sync';

const LUT = 'a'.repeat(64);

const WARM: Preset = {
  id: '01J9ZK3Y8M0Q4R5T6V7W8X9YAB',
  name: 'Warm film',
  sections: ['curve', 'color', 'effects', 'look'],
  settings: {
    curve: {
      parametric: { shadows: 20 },
      luma: [
        [0, 0.1],
        [0.5, 0.6],
        [1, 0.9],
      ],
    },
    color: { saturation: -20, mix: { orange: { hue: 10 } } },
    effects: {
      grain: { amount: 40, size: 45 },
      grading: { shadows: { hue: 200, saturation: 30 } },
      vignette: { amount: -30 },
    },
    look: { lut: null },
  },
  builtIn: false,
  look: true,
};

const FILM_LUT: Preset = {
  id: '01J9ZK3Y8M0Q4R5T6V7W8X9YCD',
  name: 'Film LUT',
  sections: ['look'],
  settings: { look: { lut: { id: LUT, name: 'Film', strength: 80 } } },
  builtIn: false,
  look: true,
};

const lookup = (id: string) => [WARM, FILM_LUT].find((p) => p.id === id);

function photo(): DevelopSettings {
  const s = createDevelop();
  s.light.exposure = 0.7;
  s.color.vibrance = 15;
  return s;
}

describe('applyLook', () => {
  it('scales every value linearly from the defaults', () => {
    const half = applyLook(photo(), WARM, 50);
    expect(half.curve.parametric.shadows).toBe(10);
    expect(half.color.saturation).toBe(-10);
    expect(half.color.mix.orange.hue).toBe(5);
    expect(half.effects.grain.amount).toBe(20);
    // Size defaults to 25: 25 + 0.5 × (45 − 25).
    expect(half.effects.grain.size).toBe(35);
    expect(half.effects.vignette.amount).toBe(-15);
    // A grading wheel keeps its hue and scales its saturation.
    expect(half.effects.grading.shadows).toEqual({ hue: 200, saturation: 15, luminance: 0 });
    // A point curve moves towards the identity.
    expect(half.curve.luma).toEqual([
      [0, 0.05],
      [0.5, 0.55],
      [1, 0.95],
    ]);
    // Sections the look does not list stay; the look's own sections drop what the photo had there.
    expect(half.light.exposure).toBe(0.7);
    expect(half.color.vibrance).toBe(0);
    expect(half.look.applied).toEqual({ presetId: WARM.id, amount: 50 });
  });

  it('plan 55: the Global wheel keeps its hue, and luminance offsets scale to whole steps', () => {
    const look = {
      ...WARM,
      settings: { ...WARM.settings, effects: { grading: { global: { hue: 120, saturation: 30, luminance: -25 } } } },
    } as typeof WARM;
    const half = applyLook(photo(), look, 50);
    expect(half.effects.grading.global).toEqual({ hue: 120, saturation: 15, luminance: -12 });
  });

  it('is the look as saved at 100 and the defaults at 0', () => {
    const full = applyLook(photo(), WARM, 100);
    expect(full.effects.grain).toEqual({ amount: 40, size: 45, roughness: 50 });
    expect(full.curve.luma).toEqual(WARM.settings.curve?.luma);
    const none = applyLook(photo(), WARM, 0);
    for (const key of ['curve', 'effects'] as const) expect(none[key]).toEqual(DEVELOP_DEFAULTS[key]);
    expect(none.look.applied?.amount).toBe(0);
  });

  it('parity: a look at 100 then 50 equals the look applied at 50 directly', () => {
    const direct = applyLook(photo(), WARM, 50);
    const stepped = applyLook(applyLook(photo(), WARM, 100), WARM, 50);
    expect(stepped).toEqual(direct);
    expect(developHashInput(stepped)).toBe(developHashInput(direct));
    // Every amount, including the way back up.
    for (const a of [0, 13, 37, 50, 99, 100]) {
      expect(applyLook(applyLook(applyLook(photo(), WARM, 100), WARM, 7), WARM, a)).toEqual(
        applyLook(photo(), WARM, a),
      );
    }
  });

  it('a LUT look sets the strength from the Amount', () => {
    const s = applyLook(photo(), FILM_LUT, 50);
    expect(s.look.lut).toEqual({ id: LUT, name: 'Film', strength: 40 });
    expect(applyLook(photo(), FILM_LUT, 100).look.lut?.strength).toBe(80);
    expect(applyLook(photo(), FILM_LUT, 0).look.lut).toBeNull();
    expect(lookAmountOf(s, FILM_LUT)).toBe(50);
    // Without the record, the amount is read back from the strength.
    expect(lookAmountOf({ ...s, look: { ...s.look, applied: null } }, FILM_LUT)).toBe(50);
    // Only the LUT section changed.
    expect(s.light.exposure).toBe(0.7);
    expect(s.color.vibrance).toBe(15);
  });

  it('keeps fractions where the setting is not a whole-step slider (exposure, radius, curve points)', () => {
    const look: Preset = {
      id: '01J9ZK3Y8M0Q4R5T6V7W8X9YGH',
      name: 'Bright',
      sections: ['light', 'detail', 'curve', 'effects', 'look'],
      settings: {
        light: { exposure: 1, contrast: 15 },
        detail: { sharpen: { radius: 2, amount: 60 } },
        curve: {
          red: [
            [0, 0],
            [1, 0],
          ],
        },
      },
      builtIn: false,
      look: true,
    };
    const half = applyLook(createDevelop(), look, 50);
    expect(half.light.exposure).toBe(0.5);
    // Whole-step sliders still round: 0 + 0.5 × 15.
    expect(half.light.contrast).toBe(8);
    // Radius defaults to 1: 1 + 0.5 × (2 − 1).
    expect(half.detail.sharpen.radius).toBe(1.5);
    expect(half.detail.sharpen.amount).toBe(50);
    expect(half.curve.red).toEqual([
      [0, 0],
      [1, 0.5],
    ]);
    expect(applyLook(createDevelop(), look, 33).light.exposure).toBe(0.33);
  });

  it('clamps the Amount', () => {
    expect(applyLook(photo(), WARM, 150).look.applied?.amount).toBe(100);
    expect(applyLook(photo(), WARM, -5).look.applied?.amount).toBe(0);
  });
});

describe('switching and removing', () => {
  it('replaceLook puts the previous look’s sections back first', () => {
    const warm = applyLook(photo(), WARM, 100);
    const lut = replaceLook(warm, FILM_LUT, 100, lookup);
    expect(lut.curve).toEqual(DEVELOP_DEFAULTS.curve);
    expect(lut.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(lut.look.lut?.id).toBe(LUT);
    expect(chosenLookId(lut)).toBe(FILM_LUT.id);
    // Unknown previous look: its values stay (only the new look's sections are written).
    const kept = replaceLook(warm, FILM_LUT, 100, () => undefined);
    expect(kept.curve.parametric.shadows).toBe(20);
  });

  it('removeLook clears the applied look and the LUT', () => {
    const removed = removeLook(applyLook(photo(), WARM, 60), lookup);
    expect(removed.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(removed.look).toEqual(DEVELOP_DEFAULTS.look);
    expect(removed.light.exposure).toBe(0.7);
    expect(chosenLookId(removed)).toBe(NO_LOOK);
    expect(replaceLook(applyLook(photo(), FILM_LUT, 60), null, 0, lookup).look.lut).toBeNull();
  });

  it('lookBase leaves the look out, so every look shares one base hash', () => {
    // A photo edited outside the looks' sections (a look that lists Color replaces the photo's Color).
    const lit = () => ({ ...createDevelop(), light: { ...DEVELOP_DEFAULTS.light, exposure: 0.7 } });
    const base = lookBase(lit());
    expect(developHashInput(lookBase(applyLook(lit(), WARM, 70), lookup))).toBe(developHashInput(base));
    expect(developHashInput(lookBase(applyLook(lit(), FILM_LUT, 70), lookup))).toBe(developHashInput(base));
    expect(base.light.exposure).toBe(0.7);
  });
});

describe('edits made after a look (plan 20 review)', () => {
  it('A: an edit to a look section locks the Amount; untouched, it reads back', () => {
    const s = applyLook(photo(), WARM, 60);
    expect(lookAmountOf(s, WARM)).toBe(60);
    expect(lookIntact(s, WARM, 60)).toBe(true);
    // Sections the look does not list are free.
    expect(lookAmountOf({ ...s, light: { ...s.light, exposure: 2 } }, WARM)).toBe(60);
    const edited = { ...s, effects: { ...s.effects, grain: { ...s.effects.grain, amount: 5 } } };
    expect(lookAmountOf(edited, WARM)).toBeNull();
    expect(untouchedLookSections(edited, WARM, 60)).toEqual(['curve', 'color', 'look']);
    // A LUT changed by hand counts too.
    const lut = applyLook(photo(), FILM_LUT, 50);
    expect(
      lookAmountOf({ ...lut, look: { ...lut.look, lut: { id: LUT, name: 'Film', strength: 70 } } }, FILM_LUT),
    ).toBeNull();
  });

  it('C: switching or removing keeps sections edited since and resets the untouched ones', () => {
    const s = applyLook(photo(), WARM, 100);
    const edited = { ...s, effects: { ...s.effects, vignette: { ...s.effects.vignette, amount: -80 } } };
    const switched = replaceLook(edited, FILM_LUT, 100, lookup);
    expect(switched.effects.vignette.amount).toBe(-80);
    expect(switched.effects.grain.amount).toBe(40);
    expect(switched.curve).toEqual(DEVELOP_DEFAULTS.curve);
    expect(switched.color).toEqual(DEVELOP_DEFAULTS.color);
    expect(switched.look.applied).toEqual({ presetId: FILM_LUT.id, amount: 100 });
    const removed = removeLook(edited, lookup);
    expect(removed.effects.vignette.amount).toBe(-80);
    expect(removed.curve).toEqual(DEVELOP_DEFAULTS.curve);
    expect(removed.look.applied).toBeNull();
  });

  it('without an applied look, removing resets hand-set effects and the LUT', () => {
    const s = photo();
    s.effects.grain.amount = 30;
    s.look.lut = { id: LUT, name: 'Film', strength: 50 };
    const removed = removeLook(s, lookup);
    expect(removed.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(removed.look).toEqual(DEVELOP_DEFAULTS.look);
    expect(removed.light.exposure).toBe(0.7);
  });

  it('Sync keeps look.applied only with every section the look lists', () => {
    setLookLookup(lookup);
    const s = applyLook(photo(), WARM, 70);
    const all = applySections(s, createDevelop(), ['curve', 'color', 'effects', 'look']);
    expect(all.look.applied).toEqual({ presetId: WARM.id, amount: 70 });
    const some = applySections(s, createDevelop(), ['effects', 'look']);
    expect(some.look.applied).toBeNull();
    expect(appliedAfterCopy({ presetId: 'unknown', amount: 10 }, ['look'])).toBeNull();
    setLookLookup(() => undefined);
  });
});

describe('lists, steps and making looks', () => {
  it('isLook and allLooks keep plain presets out', () => {
    expect(isLook(WARM)).toBe(true);
    expect(isLook(PRESET_BW)).toBe(false);
    expect(allLooks([WARM, { ...PRESET_BW, builtIn: false }, FILM_LUT]).map((l) => l.id)).toEqual([
      ...BUILT_IN_LOOKS.map((l) => l.id),
      WARM.id,
      FILM_LUT.id,
    ]);
    expect(lookThumbKey('builtin:warm-negative')).toBe('builtin_warm-negative');
  });

  it('stepLookId walks None then the looks, and stops at the ends', () => {
    const looks = [WARM, FILM_LUT];
    expect(stepLookId(looks, NO_LOOK, 1)).toBe(WARM.id);
    expect(stepLookId(looks, WARM.id, 1)).toBe(FILM_LUT.id);
    expect(stepLookId(looks, FILM_LUT.id, 1)).toBeNull();
    expect(stepLookId(looks, WARM.id, -1)).toBe(NO_LOOK);
    expect(stepLookId(looks, NO_LOOK, -1)).toBeNull();
    expect(stepLookId(looks, null, 1)).toBe(WARM.id);
    expect(stepLookId([], NO_LOOK, 1)).toBeNull();
  });

  it('makeLook always carries effects and look, never applied', () => {
    const s = applyLook(photo(), FILM_LUT, 50);
    const look = makeLook('  Mine ', s, ['color']);
    expect(look.look).toBe(true);
    expect(look.name).toBe('Mine');
    expect(look.sections).toEqual(['color', 'effects', 'look']);
    expect(look.settings.look).toEqual({ lut: { id: LUT, name: 'Film', strength: 40 } });
    expect(makeLutLook('', { id: LUT, name: 'Film' })).toMatchObject({
      name: 'Film',
      sections: ['look'],
      look: true,
      settings: { look: { lut: { id: LUT, name: 'Film', strength: 100 } } },
    });
  });
});
