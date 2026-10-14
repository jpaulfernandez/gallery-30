/**
 * Built-in looks (workflow plan 21): parametric looks we author, as data so the editor and the CLI share them.
 *
 * Each look is a partial develop settings tree over the sections in `BUILT_IN_LOOK_SECTIONS` (tone curve, colour mix,
 * the effects: grading, grain, vignette, halation; the LUT section is listed so applying a look clears a LUT left by
 * another one). The editor turns each into a read-only look preset with the id `builtin:<id>` (`BUILT_IN_LOOKS` in
 * `apps/editor/src/lib/develop/looks.ts`) and applies it with an Amount: every value moves from its default towards
 * the look's, `default + amount × (look − default)`, and a grading wheel keeps its hue while its saturation scales.
 * `amount` is the Amount a look starts at when picked.
 *
 * Names follow the bird taxonomy (docs/design/plans/README.md, *Names*): `id` is the bird, lower-case, and never
 * changes once released (photos record it in `look.applied.presetId`, thumbnails are keyed by it); `name` is the
 * bird as shown; `about` says what the look is in plain words. Never a film brand, anywhere.
 */
import { DEVELOP_VERSION, DevelopSchema, type DevelopSettings, type DevelopSettingsInput } from './schema.js';

/** The sections every built-in look lists (and so resets to its own values when applied). */
export const BUILT_IN_LOOK_SECTIONS = ['curve', 'color', 'effects', 'look'] as const;

export type BuiltInLookSection = (typeof BUILT_IN_LOOK_SECTIONS)[number];

/** A look's values: any subset of the curve, colour and effects sections (as `DevelopSchema` accepts them). */
export type BuiltInLookSettings = Pick<DevelopSettingsInput, 'curve' | 'color' | 'effects'>;

export interface BuiltInLook {
  /** The bird, lower-case. Stable forever. */
  id: string;
  /** The bird as the Looks strip shows it. */
  name: string;
  /** What the look is: a descriptive name and one sentence. */
  about: string;
  /** The Amount (percent) the look is applied at when picked. */
  amount: number;
  settings: BuiltInLookSettings;
}

/** The look preset id the editor gives a built-in look (`look.applied.presetId`, thumbnail keys). */
export const builtInLookPresetId = (id: string): string => `builtin:${id}`;

/**
 * The looks, in the order the strip shows them: colour negatives first, then the slide and print looks, the black
 * and whites, the soft and faded ones, then the special cases (night, high key).
 */
export const BUILT_IN_LOOK_DEFS: readonly BuiltInLook[] = deepFreeze([
  {
    id: 'oriole',
    name: 'Oriole',
    about: 'Warm negative. Golden highlights over soft, slightly lifted shadows, with gentle contrast and calm greens.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0.04],
          [0.25, 0.26],
          [0.75, 0.77],
          [1, 0.97],
        ],
        blue: [
          [0, 0.03],
          [1, 0.94],
        ],
      },
      color: {
        vibrance: 8,
        saturation: -6,
        mix: {
          orange: { saturation: 6 },
          yellow: { hue: -10, saturation: -8 },
          green: { hue: -15, saturation: -22 },
          blue: { saturation: -15 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 25, saturation: 10 },
          midtones: { hue: 38, saturation: 8 },
          highlights: { hue: 45, saturation: 16 },
        },
        grain: { amount: 8, size: 30, roughness: 50 },
        vignette: { amount: -10 },
      },
    },
  },
  {
    id: 'heron',
    name: 'Heron',
    about: 'Cool negative. Clean, slightly cyan shadows and blue-green foliage, with skin kept neutral.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0.03],
          [0.25, 0.25],
          [0.75, 0.77],
          [1, 0.98],
        ],
        red: [
          [0, 0],
          [1, 0.97],
        ],
      },
      color: {
        saturation: -8,
        mix: {
          yellow: { saturation: -15 },
          green: { hue: 18, saturation: -15 },
          aqua: { saturation: 8 },
          blue: { hue: -6, saturation: -6 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 195, saturation: 14 },
          midtones: { hue: 190, saturation: 5 },
          highlights: { hue: 50, saturation: 4 },
        },
        grain: { amount: 7, size: 28, roughness: 50 },
        vignette: { amount: -8 },
      },
    },
  },
  {
    id: 'starling',
    name: 'Starling',
    about: 'Chrome. Dense, muted color with deep blues and reds and firm contrast.',
    amount: 90,
    settings: {
      curve: {
        luma: [
          [0, 0],
          [0.25, 0.21],
          [0.5, 0.49],
          [0.75, 0.78],
          [1, 0.98],
        ],
      },
      color: {
        saturation: -12,
        mix: {
          red: { luminance: -10 },
          orange: { saturation: -8 },
          yellow: { saturation: -15, luminance: -5 },
          green: { saturation: -20, luminance: -10 },
          blue: { saturation: 6, luminance: -15 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 210, saturation: 7 },
          highlights: { hue: 45, saturation: 6 },
        },
        grain: { amount: 6, size: 20, roughness: 50 },
        vignette: { amount: -12 },
      },
    },
  },
  {
    id: 'kingfisher',
    name: 'Kingfisher',
    about: 'Slide. Vivid, saturated color with deep blues and punchy contrast.',
    amount: 75,
    settings: {
      curve: {
        luma: [
          [0, 0],
          [0.25, 0.2],
          [0.5, 0.5],
          [0.75, 0.8],
          [1, 1],
        ],
      },
      color: {
        vibrance: 20,
        saturation: 8,
        mix: {
          red: { saturation: 5 },
          green: { hue: 5, saturation: 5 },
          aqua: { saturation: 10 },
          blue: { saturation: 10, luminance: -15 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 230, saturation: 10 },
          highlights: { hue: 55, saturation: 5 },
        },
        grain: { amount: 4, size: 15, roughness: 40 },
        vignette: { amount: -15 },
      },
    },
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    about: 'Cine print. Teal shadows and warm skin, a soft highlight roll-off and a glow around bright lights.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0.02],
          [0.2, 0.16],
          [0.5, 0.5],
          [0.8, 0.82],
          [1, 0.95],
        ],
      },
      color: {
        vibrance: 5,
        saturation: -5,
        mix: {
          orange: { hue: -5, saturation: 5 },
          yellow: { saturation: -10 },
          green: { hue: 25, saturation: -25 },
          blue: { hue: -15, saturation: -10 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 190, saturation: 25 },
          midtones: { hue: 190, saturation: 5 },
          highlights: { hue: 35, saturation: 18 },
          blending: 60,
          balance: -10,
        },
        grain: { amount: 8, size: 30, roughness: 50 },
        vignette: { amount: -15 },
        halation: { amount: 25, threshold: 85, radius: 40 },
      },
    },
  },
  {
    id: 'rook',
    name: 'Rook',
    about: 'Pushed black and white. Deep blacks, hard contrast, dark skies and coarse grain.',
    amount: 100,
    settings: {
      curve: {
        luma: [
          [0, 0],
          [0.2, 0.12],
          [0.5, 0.5],
          [0.8, 0.88],
          [1, 1],
        ],
      },
      color: {
        saturation: -100,
        mix: {
          yellow: { luminance: 5 },
          green: { luminance: -10 },
          aqua: { luminance: -25 },
          blue: { luminance: -40 },
        },
      },
      effects: {
        grain: { amount: 20, size: 35, roughness: 65 },
        vignette: { amount: -20 },
      },
    },
  },
  {
    id: 'magpie',
    name: 'Magpie',
    about: 'Bleach bypass. Silvery, desaturated color with hard contrast and cold shadows.',
    amount: 85,
    settings: {
      curve: {
        luma: [
          [0, 0],
          [0.25, 0.18],
          [0.5, 0.52],
          [0.75, 0.84],
          [1, 1],
        ],
      },
      color: {
        vibrance: -10,
        saturation: -55,
      },
      effects: {
        grading: {
          shadows: { hue: 210, saturation: 6 },
          highlights: { hue: 50, saturation: 4 },
        },
        grain: { amount: 12, size: 25, roughness: 60 },
        vignette: { amount: -18 },
      },
    },
  },
  {
    id: 'dove',
    name: 'Dove',
    about: 'Faded. Lifted blacks, softened whites and quiet, pastel color.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0.1],
          [0.5, 0.52],
          [1, 0.93],
        ],
      },
      color: {
        vibrance: -5,
        saturation: -25,
      },
      effects: {
        grading: {
          shadows: { hue: 220, saturation: 8 },
          highlights: { hue: 45, saturation: 8 },
        },
        grain: { amount: 6, size: 25, roughness: 50 },
      },
    },
  },
  {
    id: 'sparrow',
    name: 'Sparrow',
    about: 'Matte. A flat, lifted black with the midtone contrast kept and muted, earthy color.',
    amount: 85,
    settings: {
      curve: {
        luma: [
          [0, 0.12],
          [0.15, 0.16],
          [0.5, 0.5],
          [0.85, 0.86],
          [1, 0.97],
        ],
      },
      color: {
        saturation: -15,
        mix: {
          green: { hue: -10, saturation: -15 },
          blue: { saturation: -20 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 30, saturation: 6 },
          highlights: { hue: 40, saturation: 5 },
        },
        grain: { amount: 6, size: 25, roughness: 50 },
        vignette: { amount: -8 },
      },
    },
  },
  {
    id: 'robin',
    name: 'Robin',
    about: 'Portrait soft. Gentle contrast and warm, even skin, with quiet greens and reds.',
    amount: 80,
    settings: {
      curve: {
        parametric: { highlights: -10 },
        luma: [
          [0, 0.03],
          [0.25, 0.26],
          [0.75, 0.77],
          [1, 0.98],
        ],
      },
      color: {
        saturation: -5,
        mix: {
          red: { saturation: -10, luminance: 5 },
          orange: { saturation: -8, luminance: 8 },
          yellow: { saturation: -10 },
          green: { hue: 5, saturation: -20 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 15, saturation: 5 },
          midtones: { hue: 30, saturation: 4 },
          highlights: { hue: 35, saturation: 8 },
        },
        grain: { amount: 4, size: 20, roughness: 30 },
        vignette: { amount: -10, feather: 70 },
      },
    },
  },
  {
    id: 'owl',
    name: 'Owl',
    about: 'Night. Blue shadows, warm street lights that glow, deep contrast and visible grain.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0],
          [0.25, 0.2],
          [0.5, 0.48],
          [0.8, 0.82],
          [1, 1],
        ],
      },
      color: {
        saturation: -5,
        mix: {
          orange: { hue: -5, saturation: 10 },
          yellow: { hue: -10 },
          green: { hue: 20, saturation: -30 },
          blue: { saturation: 10 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 215, saturation: 25 },
          midtones: { hue: 210, saturation: 6 },
          highlights: { hue: 35, saturation: 12 },
          balance: -20,
        },
        grain: { amount: 12, size: 35, roughness: 55 },
        vignette: { amount: -20 },
        halation: { amount: 40, threshold: 80, radius: 40 },
      },
    },
  },
  {
    id: 'egret',
    name: 'Egret',
    about: 'High key. Bright, airy midtones over open shadows, with clean whites and light color.',
    amount: 80,
    settings: {
      curve: {
        luma: [
          [0, 0.06],
          [0.25, 0.36],
          [0.5, 0.62],
          [0.75, 0.84],
          [1, 1],
        ],
      },
      color: {
        vibrance: 5,
        saturation: -15,
        mix: {
          orange: { luminance: 10 },
          green: { luminance: 10 },
          blue: { luminance: 10 },
        },
      },
      effects: {
        grading: {
          shadows: { hue: 210, saturation: 5 },
          highlights: { hue: 200, saturation: 4 },
        },
        grain: { amount: 3, size: 20, roughness: 40 },
        vignette: { amount: 10 },
      },
    },
  },
]);

/** The look's full settings at its full strength (Amount 100) over the defaults. */
export function builtInLookSettings(look: Pick<BuiltInLook, 'settings'>): DevelopSettings {
  return DevelopSchema.parse({ version: DEVELOP_VERSION, ...structuredClone(look.settings) });
}

/** The look list as plain text (`photobook looks`): one line per look, `id  Name  Amount%  about`. */
export function formatLookList(looks: readonly BuiltInLook[] = BUILT_IN_LOOK_DEFS): string {
  const idWidth = Math.max(...looks.map((l) => l.id.length));
  const nameWidth = Math.max(...looks.map((l) => l.name.length));
  return looks
    .map((l) => `${l.id.padEnd(idWidth)}  ${l.name.padEnd(nameWidth)}  ${`${l.amount}%`.padStart(4)}  ${l.about}`)
    .join('\n');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
