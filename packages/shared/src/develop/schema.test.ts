import { describe, expect, it } from 'vitest';
import {
  createDevelop,
  DEVELOP_DEFAULTS,
  DEVELOP_ENGINE_VERSION,
  DevelopSchema,
  developHash,
  developHashInput,
  HUE_BANDS,
  isDefaultDevelop,
} from './index.js';

describe('DevelopSchema', () => {
  it('fills the full default tree from just a version', () => {
    const d = DevelopSchema.parse({ version: 1 });
    expect(d.light).toEqual({ exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
    expect(d.whiteBalance).toEqual({ mode: 'asShot' });
    expect(d.curve.parametric.splits).toEqual([0.25, 0.5, 0.75]);
    expect(d.curve.luma).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(Object.keys(d.color.mix)).toEqual([...HUE_BANDS]);
    expect(d.color.mix.aqua).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect(d.detail.sharpen).toEqual({ amount: 40, radius: 1, detail: 25, masking: 0 });
    expect(d.detail.denoise).toBeNull();
    expect(d.geometry).toMatchObject({ rotate: 0, flipH: false, flipV: false, constrainCrop: true, crop: null });
    expect(d.geometry.upright).toEqual({ mode: 'off', guides: [], transform: null, focal: null });
    expect(d.geometry.transform.scale).toBe(100);
    expect(d.masks).toEqual([]);
  });

  it('fills mask, component and local adjustment defaults', () => {
    const d = DevelopSchema.parse({
      version: 1,
      masks: [{ id: 'm', name: 'Sky', components: [{ id: 'c', kind: 'linear', from: [0, 0], to: [0, 1] }] }],
    });
    const [mask] = d.masks;
    expect(mask).toMatchObject({ enabled: true, invert: false, opacity: 100, feather: 0 });
    expect(mask?.components[0]).toEqual({
      id: 'c',
      kind: 'linear',
      from: [0, 0],
      to: [0, 1],
      mode: 'add',
      invert: false,
    });
    expect(mask?.adjustments.exposure).toBe(0);
    expect(Object.keys(mask?.adjustments ?? {})).toHaveLength(15);
  });

  it('rejects out-of-range sliders, an empty mask and a wrong version', () => {
    expect(() => DevelopSchema.parse({ version: 1, light: { exposure: 6 } })).toThrow();
    expect(() => DevelopSchema.parse({ version: 1, geometry: { rotate: 45 } })).toThrow();
    expect(() => DevelopSchema.parse({ version: 1, masks: [{ id: 'm', name: 'x', components: [] }] })).toThrow();
    expect(() => DevelopSchema.parse({ version: 2 })).toThrow();
  });
});

describe('defaults', () => {
  it('DEVELOP_DEFAULTS is frozen and createDevelop returns an independent copy', () => {
    expect(Object.isFrozen(DEVELOP_DEFAULTS.light)).toBe(true);
    const a = createDevelop();
    a.light.exposure = 1;
    a.curve.luma.push([0.5, 0.6]);
    // Nested default tuples too: Zod shares them between parses, and DEVELOP_DEFAULTS froze them.
    (a.curve.red[0] as [number, number])[1] = 0.1;
    expect(DEVELOP_DEFAULTS.light.exposure).toBe(0);
    expect(createDevelop()).toEqual(DEVELOP_DEFAULTS);
  });

  it('isDefaultDevelop compares structurally', () => {
    expect(isDefaultDevelop(undefined)).toBe(true);
    expect(isDefaultDevelop({ version: 1 })).toBe(true);
    expect(isDefaultDevelop(createDevelop())).toBe(true);
    expect(isDefaultDevelop({ version: 1, light: { exposure: 0, contrast: -0 } })).toBe(true);
    expect(isDefaultDevelop({ version: 1, light: { exposure: 0.01 } })).toBe(false);
    expect(isDefaultDevelop({ version: 1, geometry: { flipH: true } })).toBe(false);
    expect(isDefaultDevelop({ version: 1, whiteBalance: { mode: 'incremental' } })).toBe(false);
    // Plan 55: a harmony lock alone is not an edit (it changes no pixel); a lock with a tint is.
    expect(isDefaultDevelop({ version: 1, effects: { grading: { harmony: 'triadic' } } })).toBe(true);
    expect(
      isDefaultDevelop({ version: 1, effects: { grading: { harmony: 'triadic', shadows: { saturation: 5 } } } }),
    ).toBe(false);
    expect(isDefaultDevelop({ version: 1, effects: { grading: { midtones: { luminance: 1 } } } })).toBe(false);
  });
});

describe('developHash', () => {
  it('hashes the fully parsed settings plus the engine version', async () => {
    const input = developHashInput({ version: 1 });
    expect(input.endsWith(`\n${DEVELOP_ENGINE_VERSION}`)).toBe(true);
    expect(input).toBe(developHashInput(createDevelop()));
    expect(input).toContain('"sharpen":{"amount":40,');
    expect(await developHash({ version: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of key order and changes with any setting', async () => {
    const a = await developHash({ version: 1, light: { exposure: 1, contrast: 5 } });
    const b = await developHash({ light: { contrast: 5, exposure: 1 }, version: 1 });
    expect(a).toBe(b);
    expect(await developHash({ version: 1, light: { exposure: 1, contrast: 6 } })).not.toBe(a);
  });

  it('leaves default effects out, so an untouched photo hashes as before the section existed', async () => {
    const plain = developHashInput({ version: 1, light: { exposure: 0.5 } });
    expect(plain).not.toContain('"effects"');
    const explicit = {
      version: 1 as const,
      light: { exposure: 0.5 },
      effects: structuredClone(DEVELOP_DEFAULTS.effects),
    };
    expect(developHashInput(explicit)).toBe(plain);
    expect(DevelopSchema.parse({ version: 1 }).effects.grain).toEqual({ amount: 0, size: 25, roughness: 50 });
    const grained = developHashInput({ version: 1, light: { exposure: 0.5 }, effects: { grain: { amount: 10 } } });
    expect(grained).toContain('"effects":{"grading":');
    expect(grained).not.toBe(plain);
    // A field put back to its default drops the section again.
    expect(developHashInput({ ...explicit, effects: { vignette: { amount: 0 } } })).toBe(plain);
  });

  it('leaves a look without a LUT out of the hash and keys a LUT by its id (plan 18)', async () => {
    const plain = developHashInput({ version: 1, light: { exposure: 0.5 } });
    expect(plain).not.toContain('"look"');
    expect(developHashInput({ version: 1, light: { exposure: 0.5 }, look: { lut: null } })).toBe(plain);
    expect(DevelopSchema.parse({ version: 1 }).look).toEqual({ lut: null, applied: null });
    const id = 'a'.repeat(64);
    const lut = { version: 1 as const, light: { exposure: 0.5 }, look: { lut: { id, name: 'Warm' } } };
    expect(DevelopSchema.parse(lut).look.lut?.strength).toBe(100);
    expect(developHashInput(lut)).toContain(`"look":{"lut":{"id":"${id}","name":"Warm","strength":100}}`);
    const other = { ...lut, look: { lut: { id: 'b'.repeat(64), name: 'Warm' } } };
    expect(await developHash(other)).not.toBe(await developHash(lut));
    expect(() => DevelopSchema.parse({ version: 1, look: { lut: { id: 'nope', name: 'x' } } })).toThrow();
    expect(() => DevelopSchema.parse({ version: 1, look: { lut: { id, name: 'x', strength: 120 } } })).toThrow();
  });

  it('never hashes look.applied, which look wrote the values (plan 20)', () => {
    const plain = developHashInput({ version: 1, light: { exposure: 0.5 } });
    const applied = { presetId: '01J9ZK3Y8M0Q4R5T6V7W8X9YAB', amount: 40 };
    expect(developHashInput({ version: 1, light: { exposure: 0.5 }, look: { applied } })).toBe(plain);
    const id = 'a'.repeat(64);
    const lut = { version: 1 as const, look: { lut: { id, name: 'Warm', strength: 40 } } };
    const withApplied = { ...lut, look: { ...lut.look, applied } };
    expect(developHashInput(withApplied)).toBe(developHashInput(lut));
    expect(developHashInput(withApplied)).not.toContain('applied');
    expect(DevelopSchema.parse(withApplied).look.applied).toEqual(applied);
    expect(() => DevelopSchema.parse({ version: 1, look: { applied: { presetId: '', amount: 10 } } })).toThrow();
    expect(() => DevelopSchema.parse({ version: 1, look: { applied: { presetId: 'x', amount: 101 } } })).toThrow();
  });

  it('hashes the grading of plan 55 only when used: luminance 0, a default Global wheel and the lock are left out', async () => {
    const old = {
      version: 1 as const,
      effects: { grading: { shadows: { hue: 200, saturation: 30 }, highlights: { hue: 40, saturation: 20 } } },
    };
    const parsed = DevelopSchema.parse(old).effects.grading;
    // Settings written before plan 55 parse unchanged: luminance 0, the Global wheel at its defaults, no lock.
    expect(parsed.shadows).toEqual({ hue: 200, saturation: 30, luminance: 0 });
    expect(parsed.global).toEqual({ hue: 0, saturation: 0, luminance: 0 });
    expect('harmony' in parsed).toBe(false);
    const plain = developHashInput(old);
    const hashedGrading = JSON.stringify(JSON.parse(plain.split('\n')[0] ?? '').effects.grading);
    for (const field of ['luminance', 'global', 'harmony']) expect(hashedGrading).not.toContain(field);
    expect(plain.endsWith(`\n${DEVELOP_ENGINE_VERSION}`)).toBe(true);
    // Written explicitly at their defaults, and with a harmony lock, the hash is the same.
    const explicit = structuredClone(old) as typeof old & { effects: { grading: Record<string, unknown> } };
    explicit.effects.grading.midtones = { hue: 0, saturation: 0, luminance: 0 };
    explicit.effects.grading.global = { hue: 0, saturation: 0, luminance: 0 };
    explicit.effects.grading.harmony = 'complementary';
    expect(DevelopSchema.parse(explicit).effects.grading.harmony).toBe('complementary');
    expect(developHashInput(explicit)).toBe(plain);
    expect(await developHash(explicit)).toBe(await developHash(old));
    // The lock alone never brings the effects section into the hash.
    const base = developHashInput({ version: 1, light: { exposure: 0.5 } });
    expect(
      developHashInput({ version: 1, light: { exposure: 0.5 }, effects: { grading: { harmony: 'triadic' } } }),
    ).toBe(base);
    // A luminance offset or a Global wheel is hashed.
    const lifted = developHashInput({
      ...old,
      effects: { grading: { ...old.effects.grading, midtones: { luminance: 10 } } },
    });
    expect(lifted).toContain('"midtones":{"hue":0,"luminance":10,"saturation":0}');
    const global = developHashInput({ version: 1, effects: { grading: { global: { hue: 30, saturation: 15 } } } });
    expect(global).toContain('"global":{"hue":30,"saturation":15}');
    expect(() => DevelopSchema.parse({ version: 1, effects: { grading: { harmony: 'rainbow' } } })).toThrow();
    expect(() => DevelopSchema.parse({ version: 1, effects: { grading: { shadows: { luminance: 101 } } } })).toThrow();
  });
});
