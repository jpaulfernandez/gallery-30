/**
 * Parity fixtures for `crates/develop`: each case is written to `crates/develop/tests/fixtures/<name>.json` as
 * `{ settings, canonical, hash }`, and `crates/develop/tests/parity.rs` checks that the Rust mirror reads the
 * settings and produces the same canonical string and hash byte for byte.
 *
 * Regenerate after a schema change with `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test`;
 * otherwise this test fails when the files on disk differ from what it would write.
 */
import { describe, expect, it } from 'vitest';
import {
  createDevelop,
  DevelopSchema,
  type DevelopSettingsInput,
  developHash,
  developHashInput,
  hashableDevelop,
} from './index.js';

// Shared's tsconfig has no Node types on purpose (the package runs in the browser), so type the few
// Node APIs this test needs by hand.
interface Fs {
  existsSync(path: URL): boolean;
  mkdirSync(path: URL, options: { recursive: true }): void;
  readFileSync(path: URL, encoding: 'utf8'): string;
  writeFileSync(path: URL, data: string): void;
}
const fs = (await import('node:fs' as string)) as Fs;
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const FIXTURES = new URL('../../../../crates/develop/tests/fixtures/', import.meta.url);

const P1 = '01JDEVELOPFIXTURE000000001';
const P2 = '01JDEVELOPFIXTURE000000002';

const CASES: Record<string, DevelopSettingsInput> = {
  defaults: { version: 1 },
  'light-only': { version: 1, light: { exposure: 0.75, contrast: 20, highlights: -40, shadows: 35 } },
  everything: {
    version: 1,
    light: { exposure: -1.25, contrast: 15, highlights: -60, shadows: 45, whites: 10, blacks: -12 },
    whiteBalance: { mode: 'incremental', temperature: 12, tint: -4 },
    curve: {
      parametric: { highlights: -10, lights: 5, darks: 8, shadows: -3, splits: [0.2, 0.55, 0.8] },
      luma: [
        [0, 0.02],
        [0.3, 0.25],
        [0.7, 0.78],
        [1, 0.98],
      ],
      red: [
        [0, 0],
        [0.5, 0.52],
        [1, 1],
      ],
      green: [
        [0, 0],
        [1, 0.97],
      ],
      blue: [
        [0, 0.03],
        [1, 1],
      ],
    },
    color: {
      vibrance: 25,
      saturation: -5,
      mix: {
        red: { hue: 5, saturation: -10, luminance: 3 },
        orange: { saturation: -15, luminance: 12 },
        blue: { hue: -20, saturation: 30, luminance: -25 },
        magenta: { hue: 100 },
      },
    },
    detail: {
      clarity: 18,
      texture: 12,
      dehaze: 7,
      sharpen: { amount: 60, radius: 1.2, detail: 30, masking: 40 },
      denoise: { model: 'nafnet-w32', luminance: 40, chroma: 60, sharpen: 10 },
    },
    geometry: {
      rotate: 90,
      flipH: true,
      flipV: false,
      upright: {
        mode: 'guided',
        guides: [
          { id: P1, kind: 'vertical', from: [0.12, 0.1], to: [0.15, 0.9] },
          { id: P2, kind: 'horizontal', from: [0.1, 0.62], to: [0.9, 0.58] },
        ],
        transform: [1.02, 0.01, -0.015, 0.003, 0.98, 0.012, 0.0004, -0.0002, 1],
        focal: 1.25,
      },
      transform: { vertical: -12, horizontal: 4, rotate: 1.5, aspect: -8, scale: 104, offsetX: 2, offsetY: -3 },
      constrainCrop: false,
      crop: { rect: { x: 0.05, y: 0.08, w: 0.9, h: 0.84 }, angle: -2.4, aspect: [4, 5] },
    },
    masks: [
      {
        id: '01JDEVELOPFIXTUREMASK00001',
        name: 'Sky',
        opacity: 80,
        feather: 10,
        components: [
          { id: '01JDEVELOPFIXTURECOMP00001', kind: 'ai', target: 'sky', model: 'sam2-tiny', modelVersion: '2.1' },
          {
            id: '01JDEVELOPFIXTURECOMP00002',
            kind: 'ai',
            mode: 'intersect',
            target: 'depth',
            model: 'depth-anything-v2-small',
            modelVersion: '2.0',
            prompts: [
              { kind: 'point', point: [0.4, 0.3] },
              {
                kind: 'box',
                box: [
                  [0.1, 0.1],
                  [0.6, 0.5],
                ],
                positive: false,
              },
            ],
            depthRange: [0.6, 1],
          },
          { id: '01JDEVELOPFIXTURECOMP00003', kind: 'linear', mode: 'subtract', from: [0.5, 0.2], to: [0.5, 0.6] },
        ],
        adjustments: { exposure: -0.5, highlights: -30, temperature: -8, dehaze: 15, saturation: 10 },
      },
      {
        id: '01JDEVELOPFIXTUREMASK00002',
        name: 'Face',
        enabled: false,
        invert: true,
        components: [
          {
            id: '01JDEVELOPFIXTURECOMP00004',
            kind: 'brush',
            strokes: [
              {
                points: [
                  [0.3, 0.4],
                  [0.32, 0.41],
                  [0.35, 0.43],
                ],
                size: 8,
              },
              { points: [[0.33, 0.42]], size: 4, feather: 0, flow: 60, erase: true },
            ],
          },
          {
            id: '01JDEVELOPFIXTURECOMP00005',
            kind: 'radial',
            center: [0.5, 0.45],
            radii: [0.2, 0.3],
            angle: 12.5,
            invert: true,
          },
          { id: '01JDEVELOPFIXTURECOMP00006', kind: 'luminance', range: [0.2, 0.75], feather: 20, mode: 'intersect' },
          {
            id: '01JDEVELOPFIXTURECOMP00007',
            kind: 'color',
            samples: ['#c8a080', '#d0a888'],
            tolerance: 35,
            mode: 'subtract',
          },
        ],
        adjustments: { clarity: -20, texture: -15, sharpness: -10, noise: 25, hue: 5, tint: 3 },
      },
    ],
  },
  'white-balance-absolute': {
    version: 1,
    whiteBalance: { mode: 'absolute', temperature: 5450, tint: 7 },
    geometry: { rotate: 270, crop: { rect: { x: 0, y: 0, w: 1, h: 0.75 }, aspect: 'original' } },
  },
  // Number formatting edge cases (shortest round-trip digits, exponents, integral floats, negative zero).
  numbers: {
    version: 1,
    // highlights and crop.rect.y are exact ties between two shortest digit strings (JS picks the even one).
    light: { exposure: 0.1 + 0.2, contrast: -0, highlights: 1 + 2 ** -17 },
    geometry: {
      upright: {
        mode: 'full',
        transform: [1, 0.1, -0.000001, 1e-7, 1.5e21, 123456789012345680000, 2.5e-300, -1234.5678, 1 / 3],
        focal: 1e-6,
      },
      crop: {
        rect: { x: 1e-7, y: 1063639691336433 + 0.25, w: 0.999999, h: 5e-324 },
        angle: 44.99999999999999,
        aspect: [1.5, 1],
      },
    },
  },
  // Workflow plan 17: every effect away from its defaults (the other sections at theirs).
  effects: {
    version: 1,
    effects: {
      grading: {
        shadows: { hue: 200, saturation: 30 },
        midtones: { hue: 35.5, saturation: 8 },
        highlights: { hue: 50 },
        blending: 70,
        balance: -25,
      },
      grain: { amount: 35, size: 40, roughness: 65 },
      vignette: { amount: -30, midpoint: 40, feather: 75, roundness: 20 },
      halation: { amount: 45, threshold: 80, radius: 55 },
    },
  },
  // Workflow plan 18: a LUT look. The id is the SHA-256 of `crates/develop/tests/fixtures/luts/<id>.cube` (committed),
  // which `crates/develop/tests/lut.rs` renders on the CPU and the GPU.
  look: {
    version: 1,
    light: { exposure: 0.2 },
    look: {
      lut: {
        id: '2a09ead054896e77573e0d00b6bbc5405467ad7a45afde4a4bdd9c532c0c34b4',
        name: 'Fixture warm fade',
        strength: 60,
      },
    },
  },
  // Plan 55: per-wheel luminance and the Global wheel (written only away from their defaults); the harmony lock is
  // never hashed, so it is not in the fixture's settings.
  'grading-wheels': {
    version: 1,
    effects: {
      grading: {
        shadows: { hue: 210, saturation: 40, luminance: 25 },
        midtones: { hue: 30, saturation: 0, luminance: -12.5 },
        highlights: { hue: 30, saturation: 35 },
        global: { hue: 45, saturation: 10, luminance: 5 },
        blending: 60,
        balance: 15,
        harmony: 'complementary',
      },
    },
  },
  // Workflow plan 24: denoise with the model's own colour (`chromaMode` is written only away from its default).
  'denoise-model-colour': {
    version: 1,
    detail: { denoise: { model: 'nafnet-w32', luminance: 35, chroma: 55, sharpen: 20, chromaMode: 'model' } },
  },
};

async function fixtureText(input: DevelopSettingsInput): Promise<string> {
  const settings = DevelopSchema.parse(input);
  // Sections the hash skips at their defaults are left out of `settings` too, as serde writes them in Rust.
  const fixture = {
    settings: hashableDevelop(settings),
    canonical: developHashInput(settings),
    hash: await developHash(settings),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

describe('develop parity fixtures', () => {
  const update = Boolean(env.UPDATE_DEVELOP_FIXTURES);
  if (update) fs.mkdirSync(FIXTURES, { recursive: true });

  for (const [name, input] of Object.entries(CASES)) {
    it(`${name}.json matches the schema and hash`, async () => {
      const file = new URL(`${name}.json`, FIXTURES);
      const text = await fixtureText(input);
      if (update) fs.writeFileSync(file, text);
      expect(fs.existsSync(file), `${name}.json is missing; run with UPDATE_DEVELOP_FIXTURES=1`).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
  }

  it('the defaults fixture is the default tree', async () => {
    const text = fs.readFileSync(new URL('defaults.json', FIXTURES), 'utf8');
    expect(DevelopSchema.parse(JSON.parse(text).settings)).toEqual(createDevelop());
  });
});
