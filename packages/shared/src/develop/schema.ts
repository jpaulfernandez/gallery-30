import { z } from 'zod';
import { canonicalJson } from '../publish/canonical.js';
import { sha256Hex } from '../publish/password.js';

/**
 * Develop settings: the non-destructive photo edits stored on `Asset.develop` (see
 * docs/design/archive/DEVELOP_PLAN.md, section 5). This file is the source of truth; the Rust mirror is
 * `crates/develop/src/settings.rs`, kept in step by the parity fixtures in
 * `crates/develop/tests/fixtures/` (written by `parity.test.ts`).
 *
 * Every nested object has a default (`.prefault({})`), so `DevelopSchema.parse({ version: 1 })` is the
 * full default tree. Slider units follow Lightroom: most are -100..100, exposure is in EV. Points are
 * `[x, y]` fractions of the transformed, uncropped image unless noted.
 */

/** Develop settings format version, independent of the book version. */
export const DEVELOP_VERSION = 1 as const;

/**
 * Engine version mixed into `developHash`. Bump it when the render maths changes so every cached render
 * (and the file names keyed on the hash) is invalidated. Must equal `ENGINE_VERSION` in Rust.
 */
// develop-engine/3 (workflow plan 19): the one bump for the looks work (Effects, LUT, their GPU port).
// develop-engine/4 (plan 55): the grading wheels' luminance offsets and the Global wheel. Settings without them render
// byte-identical to /3 (checked on the ON1 samples, `crates/develop/tests/engine_bump.rs`); only the hash changes.
export const DEVELOP_ENGINE_VERSION = 'develop-engine/4';

const Slider = (min: number, max: number, def = 0) => z.number().min(min).max(max).default(def);

const id = z.string().min(1);

/** `[x, y]`, fractions of the transformed, uncropped image. */
export const DevelopPointSchema = z.tuple([z.number(), z.number()]);

export const DevelopLightSchema = z.object({
  /** EV. */
  exposure: Slider(-5, 5),
  contrast: Slider(-100, 100),
  highlights: Slider(-100, 100),
  shadows: Slider(-100, 100),
  whites: Slider(-100, 100),
  blacks: Slider(-100, 100),
});

export const WhiteBalanceSchema = z.discriminatedUnion('mode', [
  /** The camera's white balance (for JPEGs: leave the colours as they are). */
  z.object({ mode: z.literal('asShot') }),
  /** Kelvin and tint, for RAW files. */
  z.object({ mode: z.literal('absolute'), temperature: z.number().min(2000).max(50000), tint: Slider(-150, 150) }),
  /** Relative shifts, for rendered files (JPEG, PNG, HEIC). */
  z.object({ mode: z.literal('incremental'), temperature: Slider(-100, 100), tint: Slider(-100, 100) }),
]);

/** `[input, output]`, both 0..1. */
export const CurvePointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

const pointCurve = () =>
  z.array(CurvePointSchema).default([
    [0, 0],
    [1, 1],
  ]);

export const ParametricCurveSchema = z.object({
  highlights: Slider(-100, 100),
  lights: Slider(-100, 100),
  darks: Slider(-100, 100),
  shadows: Slider(-100, 100),
  /** Region boundaries on the input axis, 0..1 and increasing. */
  splits: z.tuple([z.number(), z.number(), z.number()]).default([0.25, 0.5, 0.75]),
});

export const DevelopCurveSchema = z.object({
  parametric: ParametricCurveSchema.prefault({}),
  luma: pointCurve(),
  red: pointCurve(),
  green: pointCurve(),
  blue: pointCurve(),
});

/** The eight hue bands of the colour mixer, in hue order. */
export const HUE_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export const HueBandSchema = z.enum(HUE_BANDS);

export const HueMixSchema = z.object({
  hue: Slider(-100, 100),
  saturation: Slider(-100, 100),
  luminance: Slider(-100, 100),
});

/** One entry per band; spelled out (rather than a record) so missing bands get their defaults. */
export const ColorMixSchema = z.object({
  red: HueMixSchema.prefault({}),
  orange: HueMixSchema.prefault({}),
  yellow: HueMixSchema.prefault({}),
  green: HueMixSchema.prefault({}),
  aqua: HueMixSchema.prefault({}),
  blue: HueMixSchema.prefault({}),
  purple: HueMixSchema.prefault({}),
  magenta: HueMixSchema.prefault({}),
});

export const DevelopColorSchema = z.object({
  vibrance: Slider(-100, 100),
  saturation: Slider(-100, 100),
  mix: ColorMixSchema.prefault({}),
});

export const SharpenSchema = z.object({
  amount: Slider(0, 150, 40),
  /** Pixels at the 1080 px short-side reference. */
  radius: Slider(0.5, 3, 1),
  detail: Slider(0, 100, 25),
  masking: Slider(0, 100),
});

export const DENOISE_MODELS = ['nafnet-w32', 'nafnet-w64', 'scunet'] as const;

/**
 * Where denoise's colour comes from (workflow plan 24): `filter` (default) is the classical guided filter on Oklab a/b
 * at render time, guided by the denoised L, so the Colour slider never waits for the model; `model` blends the
 * network's own a/b into the intermediate.
 */
export const CHROMA_MODES = ['filter', 'model'] as const;

export const DenoiseSchema = z.object({
  model: z.enum(DENOISE_MODELS),
  luminance: Slider(0, 100, 50),
  chroma: Slider(0, 100, 75),
  sharpen: Slider(0, 100, 25),
  chromaMode: z.enum(CHROMA_MODES).default('filter'),
});

export const DevelopDetailSchema = z.object({
  clarity: Slider(-100, 100),
  texture: Slider(-100, 100),
  dehaze: Slider(-100, 100),
  sharpen: SharpenSchema.prefault({}),
  /** AI denoise; null when off. */
  denoise: DenoiseSchema.nullable().default(null),
});

/** A line the user drew for guided Upright. */
export const UprightGuideSchema = z.object({
  id,
  kind: z.enum(['vertical', 'horizontal']),
  from: DevelopPointSchema,
  to: DevelopPointSchema,
});

export const UPRIGHT_MODES = ['off', 'auto', 'level', 'vertical', 'full', 'guided'] as const;

export const UprightSchema = z.object({
  mode: z.enum(UPRIGHT_MODES).default('off'),
  guides: z.array(UprightGuideSchema).max(4).default([]),
  /**
   * Row-major forward homography in 0..1 coordinates of the oriented image, stored by the analysis (like
   * Lightroom's UprightTransform_N) so renders never re-run line detection; null until analysed.
   */
  transform: z.array(z.number()).length(9).nullable().default(null),
  /** Focal length in long-edge units the analysis assumed (EXIF 35 mm-equivalent or the 28 mm default). */
  focal: z.number().positive().nullable().default(null),
});

/** Manual Transform sliders, applied after Upright. */
export const ManualTransformSchema = z.object({
  vertical: Slider(-100, 100),
  horizontal: Slider(-100, 100),
  /** Degrees. */
  rotate: Slider(-10, 10),
  aspect: Slider(-100, 100),
  /** Percent. */
  scale: Slider(50, 150, 100),
  offsetX: Slider(-100, 100),
  offsetY: Slider(-100, 100),
});

export const DevelopCropSchema = z.object({
  /** Fractions of the transformed, uncropped image. */
  rect: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
  /** Straighten angle in degrees, about the crop centre, positive clockwise. */
  angle: Slider(-45, 45),
  /** `free`, the source's aspect, or a `[width, height]` ratio. */
  aspect: z
    .union([z.literal('free'), z.literal('original'), z.tuple([z.number().positive(), z.number().positive()])])
    .default('free'),
});

export const DevelopGeometrySchema = z.object({
  /** User rotation in degrees clockwise, on top of the EXIF orientation. */
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false),
  upright: UprightSchema.prefault({}),
  transform: ManualTransformSchema.prefault({}),
  /** Keep the crop inside the warped image: recompute the largest inscribed rectangle after every geometry change. */
  constrainCrop: z.boolean().default(true),
  /** Null: no crop. */
  crop: DevelopCropSchema.nullable().default(null),
});

/** One brush stroke; `points` are image fractions. */
export const BrushStrokeSchema = z.object({
  points: z.array(DevelopPointSchema),
  /** Brush diameter as a percentage of the image's short side. */
  size: Slider(0, 100, 25),
  feather: Slider(0, 100, 50),
  flow: Slider(0, 100, 100),
  /** Erase from the mask instead of painting into it. */
  erase: z.boolean().default(false),
});

/** A click or box prompt for a promptable AI mask; `positive: false` excludes the region. */
export const MaskPromptSchema = z.object({
  kind: z.enum(['point', 'box']),
  point: DevelopPointSchema.optional(),
  box: z.tuple([DevelopPointSchema, DevelopPointSchema]).optional(),
  positive: z.boolean().default(true),
});

export const MASK_COMPONENT_KINDS = ['brush', 'linear', 'radial', 'luminance', 'color', 'ai'] as const;
export const AI_MASK_TARGETS = ['subject', 'background', 'sky', 'people', 'depth'] as const;

/** Fields every mask component has: how it combines with the components before it. */
const maskComponentBase = {
  id,
  mode: z.enum(['add', 'subtract', 'intersect']).default('add'),
  invert: z.boolean().default(false),
};

export const MaskComponentSchema = z.discriminatedUnion('kind', [
  z.object({ ...maskComponentBase, kind: z.literal('brush'), strokes: z.array(BrushStrokeSchema) }),
  z.object({ ...maskComponentBase, kind: z.literal('linear'), from: DevelopPointSchema, to: DevelopPointSchema }),
  z.object({
    ...maskComponentBase,
    kind: z.literal('radial'),
    center: DevelopPointSchema,
    radii: DevelopPointSchema,
    /** Degrees. */
    angle: z.number(),
    feather: Slider(0, 100, 50),
  }),
  z.object({
    ...maskComponentBase,
    kind: z.literal('luminance'),
    /** Luminance range, 0..1. */
    range: z.tuple([z.number(), z.number()]),
    feather: Slider(0, 100),
  }),
  z.object({
    ...maskComponentBase,
    kind: z.literal('color'),
    /** Sampled colours as hex strings. */
    samples: z.array(z.string()),
    tolerance: Slider(0, 100, 50),
  }),
  z.object({
    ...maskComponentBase,
    kind: z.literal('ai'),
    target: z.enum(AI_MASK_TARGETS),
    model: z.string(),
    modelVersion: z.string(),
    prompts: z.array(MaskPromptSchema).default([]),
    /** For `depth`: the near and far bounds, 0..1. */
    depthRange: z.tuple([z.number(), z.number()]).optional(),
  }),
]);

/** The Lightroom local-adjustment subset a mask applies. */
export const LocalAdjustmentsSchema = z.object({
  /** EV. */
  exposure: Slider(-4, 4),
  contrast: Slider(-100, 100),
  highlights: Slider(-100, 100),
  shadows: Slider(-100, 100),
  whites: Slider(-100, 100),
  blacks: Slider(-100, 100),
  temperature: Slider(-100, 100),
  tint: Slider(-100, 100),
  texture: Slider(-100, 100),
  clarity: Slider(-100, 100),
  dehaze: Slider(-100, 100),
  saturation: Slider(-100, 100),
  sharpness: Slider(-100, 100),
  noise: Slider(0, 100),
  hue: Slider(-100, 100),
});

export const DevelopMaskSchema = z.object({
  id,
  name: z.string(),
  enabled: z.boolean().default(true),
  invert: z.boolean().default(false),
  opacity: Slider(0, 100, 100),
  feather: Slider(0, 100),
  components: z.array(MaskComponentSchema).min(1),
  adjustments: LocalAdjustmentsSchema.prefault({}),
});

// --- Effects (workflow plan 17): colour grading, grain, vignette, halation. Every field defaults to a no-op, and the
// hash leaves the whole section out while it is at its defaults (`HASH_OPTIONAL_SECTIONS`), so adding it changed no
// existing photo's develop hash.

/** One colour-grading wheel: a hue on the colour wheel (0 red, 120 green, 240 blue) and how strongly it tints. */
export const GradingWheelSchema = z.object({
  hue: Slider(0, 360),
  saturation: Slider(0, 100),
  /**
   * Plan 55: a lightness offset over the wheel's tonal range (−100 darker, +100 lighter). The hash leaves it out at 0
   * (`hashableDevelop`), so settings written before it hash as they did, apart from the engine version.
   */
  luminance: Slider(-100, 100),
});

/**
 * Plan 55: the harmony lock of the grading wheels (ODDHALLS_LAYOUT_PLAN 4.2). It only decides what a drag on a wheel
 * writes (`apps/editor/src/lib/develop/harmony.ts`); the maths never reads it, and the hash always leaves it out.
 * Absent is *Free*.
 */
export const GRADING_HARMONIES = [
  'monochromatic',
  'complementary',
  'splitComplementary',
  'triadic',
  'tetradic',
  'analogous',
] as const;

export const GradingSchema = z.object({
  shadows: GradingWheelSchema.prefault({}),
  midtones: GradingWheelSchema.prefault({}),
  highlights: GradingWheelSchema.prefault({}),
  /** Plan 55: a wheel over every tone (the Global wheel in Advanced). Left out of the hash at its defaults. */
  global: GradingWheelSchema.prefault({}),
  /** How much the three tonal ranges overlap. */
  blending: Slider(0, 100, 50),
  /** Moves the shadows / highlights split: positive gives the highlights wheel more of the tonal range. */
  balance: Slider(-100, 100),
  /** Plan 55: the harmony lock; UI state saved with the settings, never hashed. */
  harmony: z.enum(GRADING_HARMONIES).optional(),
});

export const GrainSchema = z.object({
  amount: Slider(0, 100),
  /** Grain size in reference pixels (long edge 2048), so a proxy and a full render show the same grain. */
  size: Slider(0, 100, 25),
  /** Weight of the fine octave. */
  roughness: Slider(0, 100, 50),
});

/** Post-crop vignette on lightness: negative darkens the corners, positive lightens them. */
export const VignetteSchema = z.object({
  amount: Slider(-100, 100),
  /** Where the falloff sits: higher keeps it in the corners. */
  midpoint: Slider(0, 100, 50),
  feather: Slider(0, 100, 50),
  /** −100 a rounded rectangle, 0 an ellipse following the frame, +100 a circle. */
  roundness: Slider(-100, 100),
});

/** The warm glow film gives highlights. */
export const HalationSchema = z.object({
  amount: Slider(0, 100),
  /** Lightness above which highlights glow. */
  threshold: Slider(0, 100, 75),
  radius: Slider(0, 100, 30),
});

export const DevelopEffectsSchema = z.object({
  grading: GradingSchema.prefault({}),
  grain: GrainSchema.prefault({}),
  vignette: VignetteSchema.prefault({}),
  halation: HalationSchema.prefault({}),
});

export type GradingWheel = z.infer<typeof GradingWheelSchema>;
export type Grading = z.infer<typeof GradingSchema>;
export type GradingHarmony = (typeof GRADING_HARMONIES)[number];
export type Grain = z.infer<typeof GrainSchema>;
export type Vignette = z.infer<typeof VignetteSchema>;
export type Halation = z.infer<typeof HalationSchema>;
export type DevelopEffects = z.infer<typeof DevelopEffectsSchema>;

// --- end effects

// --- Look (workflow plan 18): a user 3D LUT, referenced by the SHA-256 of `<appdata>/luts/<id>.cube`. The hash leaves
// the section out while it has no LUT (`HASH_OPTIONAL_SECTIONS`), and names the id when it has one, so a render with a
// LUT is keyed by it even when the file is missing on this machine.

export const LUT_ID_PATTERN = /^[0-9a-f]{64}$/;

export const LutRefSchema = z.object({
  id: z.string().regex(LUT_ID_PATTERN),
  /** What the editor shows, also when the file is missing ("LUT missing: name"). */
  name: z.string(),
  /** Blend of the LUT's output with its input. */
  strength: Slider(0, 100, 100),
});

// Workflow plan 20 (Looks): which look preset wrote the scaled values and at what Amount, so the slider can re-scale
// later. Metadata only: the written settings are the scaled values, so `hashableDevelop` always leaves `applied` out
// (the Rust mirror does not carry it; serde ignores the field) and a missing preset only locks the slider.
export const AppliedLookSchema = z.object({
  /** A saved look's ULID, or a built-in look's `builtin:` id. */
  presetId: z.string().min(1).max(80),
  /** Percent: 0 is the defaults, 100 the look as saved. */
  amount: Slider(0, 100, 100),
});

export const DevelopLookSchema = z.object({
  lut: LutRefSchema.nullable().default(null),
  applied: AppliedLookSchema.nullable().default(null),
});

export type LutRef = z.infer<typeof LutRefSchema>;
export type AppliedLook = z.infer<typeof AppliedLookSchema>;
export type DevelopLook = z.infer<typeof DevelopLookSchema>;

// --- end look

export const DevelopSchema = z.object({
  version: z.literal(DEVELOP_VERSION),
  light: DevelopLightSchema.prefault({}),
  whiteBalance: WhiteBalanceSchema.default({ mode: 'asShot' }),
  curve: DevelopCurveSchema.prefault({}),
  color: DevelopColorSchema.prefault({}),
  detail: DevelopDetailSchema.prefault({}),
  geometry: DevelopGeometrySchema.prefault({}),
  masks: z.array(DevelopMaskSchema).default([]),
  effects: DevelopEffectsSchema.prefault({}),
  look: DevelopLookSchema.prefault({}),
});

export type DevelopSettings = z.infer<typeof DevelopSchema>;
/** What `DevelopSchema` accepts: any subset of the tree, with `version`. */
export type DevelopSettingsInput = z.input<typeof DevelopSchema>;
export type DevelopPoint = z.infer<typeof DevelopPointSchema>;
export type DevelopLight = z.infer<typeof DevelopLightSchema>;
export type WhiteBalance = z.infer<typeof WhiteBalanceSchema>;
export type CurvePoint = z.infer<typeof CurvePointSchema>;
export type ParametricCurve = z.infer<typeof ParametricCurveSchema>;
export type DevelopCurve = z.infer<typeof DevelopCurveSchema>;
export type HueBand = z.infer<typeof HueBandSchema>;
export type HueMix = z.infer<typeof HueMixSchema>;
export type ColorMix = z.infer<typeof ColorMixSchema>;
export type DevelopColor = z.infer<typeof DevelopColorSchema>;
export type Sharpen = z.infer<typeof SharpenSchema>;
export type DenoiseModel = (typeof DENOISE_MODELS)[number];
export type Denoise = z.infer<typeof DenoiseSchema>;

/** What turning denoise on starts from: the recommended model at the default strengths (Lightroom's Enhance Denoise). */
export const DEFAULT_DENOISE: Denoise = Object.freeze({
  model: 'nafnet-w32',
  luminance: 50,
  chroma: 75,
  sharpen: 25,
  chromaMode: 'filter',
});
export type ChromaMode = (typeof CHROMA_MODES)[number];
export type DevelopDetail = z.infer<typeof DevelopDetailSchema>;
export type UprightMode = (typeof UPRIGHT_MODES)[number];
export type UprightGuide = z.infer<typeof UprightGuideSchema>;
export type Upright = z.infer<typeof UprightSchema>;
export type ManualTransform = z.infer<typeof ManualTransformSchema>;
export type DevelopCrop = z.infer<typeof DevelopCropSchema>;
export type DevelopGeometry = z.infer<typeof DevelopGeometrySchema>;
export type BrushStroke = z.infer<typeof BrushStrokeSchema>;
export type MaskPrompt = z.infer<typeof MaskPromptSchema>;
export type MaskComponentKind = (typeof MASK_COMPONENT_KINDS)[number];
export type AiMaskTarget = (typeof AI_MASK_TARGETS)[number];
export type DevelopMaskComponent = z.infer<typeof MaskComponentSchema>;
export type LocalAdjustments = z.infer<typeof LocalAdjustmentsSchema>;
export type DevelopMask = z.infer<typeof DevelopMaskSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The default settings (every slider at zero, no crop, no masks). Frozen; use `createDevelop` for a copy. */
export const DEVELOP_DEFAULTS: DevelopSettings = deepFreeze(DevelopSchema.parse({ version: DEVELOP_VERSION }));

/** Fresh default settings, safe to mutate (deep copy: Zod shares nested default values between parses). */
export function createDevelop(): DevelopSettings {
  return structuredClone(DevelopSchema.parse({ version: DEVELOP_VERSION }));
}

const DEFAULTS_CANONICAL = canonicalJson(DEVELOP_DEFAULTS);
const DEFAULT_WHEEL = DEVELOP_DEFAULTS.effects.grading.global;

/**
 * True when `settings` (absent counts) renders exactly like the defaults, i.e. the photo is unedited. The grading's
 * harmony lock (plan 55) is left out, as the hash leaves it out: a lock alone changes no pixel, so it is not an edit.
 */
export function isDefaultDevelop(settings: DevelopSettingsInput | undefined | null): boolean {
  if (settings == null) return true;
  const parsed = DevelopSchema.parse(settings);
  const { harmony: _lock, ...grading } = parsed.effects.grading;
  return canonicalJson({ ...parsed, effects: { ...parsed.effects, grading } }) === DEFAULTS_CANONICAL;
}

/**
 * Sections added after the first hashed format that the hash leaves out while they are at their defaults (serde's
 * `skip_serializing_if` in Rust), so adding one never changes the hash of a photo that does not use it.
 */
export const HASH_OPTIONAL_SECTIONS = ['effects', 'look'] as const;

/** The look section without its `applied` metadata (plan 20). */
function withoutApplied(look: DevelopLook): Record<string, unknown> {
  const { applied: _applied, ...rest } = look;
  return rest;
}

/** A grading wheel as the hash sees it: `luminance` left out at 0 (plan 55, serde's `skip_serializing_if`). */
function hashableWheel(wheel: GradingWheel): Record<string, unknown> {
  const { luminance, ...rest } = wheel;
  return luminance === 0 ? rest : wheel;
}

/**
 * The effects as the hash sees them (plan 55): the harmony lock left out (it never changes the picture), each wheel's
 * `luminance` left out at 0 and the Global wheel left out at its defaults, so settings written before plan 55 hash as
 * they did apart from the engine version.
 */
function hashableEffects(effects: DevelopEffects): Record<string, unknown> {
  const { harmony: _lock, global, ...grading } = effects.grading;
  const out: Record<string, unknown> = {
    ...grading,
    shadows: hashableWheel(grading.shadows),
    midtones: hashableWheel(grading.midtones),
    highlights: hashableWheel(grading.highlights),
  };
  if (canonicalJson(global) !== canonicalJson(DEFAULT_WHEEL)) out.global = hashableWheel(global);
  return { ...effects, grading: out };
}

/**
 * Parsed settings as the hash sees them: every field, except the `HASH_OPTIONAL_SECTIONS` that equal their defaults
 * and `look.applied` (plan 20: which look wrote the values is metadata, never part of the hash), and the grading's
 * plan 55 additions at their defaults plus its harmony lock (`hashableEffects`).
 * Equal to what `serde_json::to_value` writes for the same settings in Rust.
 */
export function hashableDevelop(settings: DevelopSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  if (settings.look) out.look = withoutApplied(settings.look);
  if (settings.effects) out.effects = hashableEffects(settings.effects);
  for (const key of HASH_OPTIONAL_SECTIONS) {
    if (key === 'look') {
      if (canonicalJson(out.look) === canonicalJson(withoutApplied(DEVELOP_DEFAULTS.look))) delete out.look;
      continue;
    }
    if (canonicalJson(out[key]) === canonicalJson(hashableEffects(DEVELOP_DEFAULTS.effects))) delete out[key];
  }
  // Workflow plan 24: `detail.denoise.chromaMode` is left out at its default (`filter`, serde's `skip_serializing_if`),
  // so the new field changes no hash.
  const denoise = settings.detail.denoise;
  if (denoise?.chromaMode === 'filter') {
    const { chromaMode: _default, ...rest } = denoise;
    out.detail = { ...settings.detail, denoise: rest };
  }
  return out;
}

/**
 * The exact string `developHash` hashes: the canonical JSON of the fully parsed settings (so the whole
 * default tree is included, as serde writes it in Rust, minus the default `HASH_OPTIONAL_SECTIONS`), a newline, and
 * `DEVELOP_ENGINE_VERSION`.
 */
export function developHashInput(settings: DevelopSettingsInput): string {
  return `${canonicalJson(hashableDevelop(DevelopSchema.parse(settings)))}\n${DEVELOP_ENGINE_VERSION}`;
}

/**
 * SHA-256 hex identifying a render of these settings with this engine: the key for cached renders
 * (`proxy-<developHash>.jpg`). Equal to `develop_hash` in `crates/develop`.
 */
export function developHash(settings: DevelopSettingsInput): Promise<string> {
  return sha256Hex(developHashInput(settings));
}
