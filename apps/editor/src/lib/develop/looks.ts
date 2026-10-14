/**
 * Looks (workflow plan 20): a look is a develop preset flagged `look: true` whose sections include `effects` and `look`
 * (`DevelopPreset` in `lib/tauri.ts`, `Preset` in `commands/presets.rs`). It is applied with an Amount: every value of
 * the sections it lists is scaled linearly from the defaults, `value = default + amount × (preset − default)`, and the
 * LUT's strength is scaled the same way (`preset strength × amount`), so a LUT look's Amount is its strength. The
 * written settings are those scaled values; `look.applied { presetId, amount }` records which look wrote them so the
 * Amount slider can re-scale later (a missing preset only locks it). Pure functions; the store actions are
 * `applyDevelopLook` in `store/book.ts`.
 *
 * Built-in looks (plan 21) plug in through `BUILT_IN_LOOKS`: read-only presets with `builtIn: true`, `look: true` and a
 * `builtin:` id, listed before the user's. Thumbnails are keyed by preset id (`render_look_thumbs`), so a built-in id
 * must stay stable once shipped.
 */
import {
  BUILT_IN_LOOK_DEFS,
  BUILT_IN_LOOK_SECTIONS,
  type BuiltInLook,
  builtInLookPresetId,
  DEVELOP_DEFAULTS,
  type DevelopSettings,
  newId,
} from '@photobook/shared';
import { deepEqual, deepMerge } from './merge';
import { type Preset, presetSections, presetValues } from './presets';
import { DEVELOP_SECTION_KEYS, type DevelopSectionKey } from './sections';

/** A built-in look (plan 21, `packages/shared/src/develop/looks.ts`) as a read-only look preset. */
const builtInPreset = (look: BuiltInLook): Preset => ({
  id: builtInLookPresetId(look.id),
  name: look.name,
  sections: [...BUILT_IN_LOOK_SECTIONS],
  settings: structuredClone(look.settings) as Preset['settings'],
  builtIn: true,
  look: true,
});

/** The built-in looks (plan 21): the shared looks as read-only presets with `builtin:<bird>` ids. */
export const BUILT_IN_LOOKS: readonly Preset[] = Object.freeze(BUILT_IN_LOOK_DEFS.map(builtInPreset));

const BUILT_IN_BY_PRESET_ID = new Map(BUILT_IN_LOOK_DEFS.map((l) => [builtInLookPresetId(l.id), l]));

/** The shared definition of a built-in look preset (its `about` and default Amount); undefined for a saved look. */
export const builtInLookDef = (presetId: string): BuiltInLook | undefined => BUILT_IN_BY_PRESET_ID.get(presetId);

/** The Amount a look starts at when picked: a built-in look's own default, 100 for a saved look. */
export const lookDefaultAmount = (look: Pick<Preset, 'id'> | null | undefined): number =>
  (look && builtInLookDef(look.id)?.amount) ?? 100;

/** Sections every look carries (WORKFLOW_PLAN 4.2): the effects and the LUT. */
export const LOOK_SECTIONS: readonly DevelopSectionKey[] = ['effects', 'look'];

/** The other sections a saved look may add (geometry and masks never). */
export const LOOK_OPTIONAL_SECTIONS: readonly DevelopSectionKey[] = [
  'light',
  'whiteBalance',
  'curve',
  'color',
  'detail',
];

/** Id of the "None" cell in the strip (and of its thumbnail). */
export const NO_LOOK = 'none';

export const isLook = (preset: Pick<Preset, 'look'> | null | undefined): boolean => preset?.look === true;

/** Built-in looks first, then the user's saved looks (plain presets left out), each list in its own order. */
export const allLooks = (saved: readonly Preset[]): Preset[] => [...BUILT_IN_LOOKS, ...saved.filter(isLook)];

/** Wire-safe file key of a preset id, as `render_look_thumbs` names the thumbnail (`builtin:x` → `builtin_x`). */
export const lookThumbKey = (presetId: string): string => presetId.replace(/:/g, '_');

/** Paths whose number is an angle that keeps the look's value instead of scaling (a wheel's hue at 50 % is the same hue). */
const KEEP_PATHS = /^effects\.grading\.(shadows|midtones|highlights|global)\.hue$/;
/** Point curves: their default is the identity, so a point `[x, y]` scales its `y` towards `x`. */
const POINT_CURVES = /^curve\.(luma|red|green|blue)$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Settings the UI moves in whole steps (the -100..100 sliders, Kelvin, the effects' sliders): a scaled value is rounded
 * to an integer there. Everything else (exposure in EV, the sharpening radius, curve points and splits) keeps four
 * decimals, so a re-scale always lands on the same numbers.
 */
const INTEGER_PATHS =
  /^(light\.(contrast|highlights|shadows|whites|blacks)|whiteBalance\.(temperature|tint)|color\.(vibrance|saturation|mix\.\w+\.(hue|saturation|luminance))|curve\.parametric\.(highlights|lights|darks|shadows)|detail\.(clarity|texture|dehaze|sharpen\.(amount|detail|masking)|denoise\.(luminance|chroma|sharpen))|effects\.(grading\.(shadows|midtones|highlights|global)\.(hue|saturation|luminance)|grading\.(blending|balance)|grain\.\w+|vignette\.\w+|halation\.\w+))$/;

/** `def` moved `t` of the way to `value`: an integer on `integer` paths, else four decimals. */
function mix(def: number, value: number, t: number, integer: boolean): number {
  const v = def + t * (value - def);
  return integer ? Math.round(v) : Math.round(v * 1e4) / 1e4;
}

/** `def` moved `t` (0..1) of the way to `value`, recursively; values that cannot be scaled switch at `t > 0`. */
function scale(def: unknown, value: unknown, t: number, path: string): unknown {
  if (typeof def === 'number' && typeof value === 'number') {
    if (KEEP_PATHS.test(path)) return t > 0 ? value : def;
    return mix(def, value, t, INTEGER_PATHS.test(path));
  }
  if (Array.isArray(value)) {
    if (POINT_CURVES.test(path)) {
      // At 0 the curve is the default itself, not an identity with extra points.
      if (t === 0) return structuredClone(def);
      return value.map((p) =>
        Array.isArray(p) && p.length === 2 ? [p[0], mix(p[0] as number, p[1] as number, t, false)] : p,
      );
    }
    if (Array.isArray(def) && def.length === value.length)
      return value.map((v, i) => scale(def[i], v, t, `${path}.${i}`));
    return structuredClone(t > 0 ? value : def);
  }
  if (isObject(value) && isObject(def)) {
    // A white balance with another mode is a whole value (the modes have different fields).
    if ('mode' in value && value.mode !== def.mode) return structuredClone(t > 0 ? value : def);
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(def), ...Object.keys(value)])) {
      out[key] = key in value ? scale(def[key], value[key], t, `${path}.${key}`) : structuredClone(def[key]);
    }
    return out;
  }
  return structuredClone(t > 0 ? value : def);
}

/** Clamp an Amount to 0..100 (an integer percent). */
export const clampAmount = (amount: number): number => Math.round(Math.min(100, Math.max(0, amount)));

/**
 * `settings` with `look` applied at `amount` (percent): each section the look lists becomes its defaults moved
 * `amount` of the way to the look's values (the look's section laid over the defaults first, so a partial look is
 * complete), the LUT strength is the look's times `amount`, and `look.applied` names the look. Other sections, the
 * geometry and the masks are untouched. Applying the same look again at another Amount gives exactly what applying
 * it once at that Amount gives (nothing depends on the previous values of those sections). Pure.
 */
export function applyLook(
  settings: DevelopSettings,
  look: Pick<Preset, 'id' | 'sections' | 'settings'>,
  amount: number,
): DevelopSettings {
  const a = clampAmount(amount);
  const t = a / 100;
  const next: DevelopSettings = { ...settings };
  const values = look.settings as Record<string, unknown>;
  for (const key of presetSections(look)) {
    if (key === 'look') continue;
    const defaults = DEVELOP_DEFAULTS[key];
    const patch = values[key];
    const full =
      key === 'whiteBalance' && isObject(patch) && 'mode' in patch
        ? patch
        : deepMerge(defaults as unknown, patch as never);
    (next as Record<string, unknown>)[key] = scale(defaults, full, t, key);
  }
  const lookValues = values.look as { lut?: DevelopSettings['look']['lut'] } | undefined;
  let lut = settings.look.lut;
  if (look.sections.includes('look')) {
    const want = lookValues?.lut ?? null;
    lut = want && t > 0 ? { ...want, strength: mix(0, want.strength ?? 100, t, true) } : null;
  }
  next.look = { ...settings.look, lut, applied: { presetId: look.id, amount: a } };
  return next;
}

/** `settings` with `sections` back to their defaults (`look` loses its LUT and its `applied` too). */
function resetSections(settings: DevelopSettings, sections: readonly DevelopSectionKey[]): DevelopSettings {
  const next: DevelopSettings = { ...settings };
  for (const key of sections) (next as Record<string, unknown>)[key] = structuredClone(DEVELOP_DEFAULTS[key]);
  return next;
}

/**
 * The sections of `look` that `settings` still hold exactly as the look wrote them at `amount` (for `look`, the LUT:
 * `applied` itself is not compared). A section edited by hand since is left out.
 */
export function untouchedLookSections(
  settings: DevelopSettings,
  look: Pick<Preset, 'id' | 'sections' | 'settings'>,
  amount: number,
): DevelopSectionKey[] {
  const wrote = applyLook(DEVELOP_DEFAULTS, look, amount);
  return presetSections(look).filter((key) =>
    key === 'look' ? deepEqual(settings.look.lut, wrote.look.lut) : deepEqual(settings[key], wrote[key]),
  );
}

/** True when every section `look` lists still holds what it wrote at `amount`. */
export function lookIntact(
  settings: DevelopSettings,
  look: Pick<Preset, 'id' | 'sections' | 'settings'>,
  amount: number,
): boolean {
  return untouchedLookSections(settings, look, amount).length === presetSections(look).length;
}

/**
 * `settings` without the applied look: each section it lists goes back to the defaults only while it still holds what
 * the look wrote (a section edited by hand since keeps the edit), and `applied` is cleared. An unknown look leaves the
 * values. With nothing applied, the look sections themselves (`effects` and the LUT) go back to the defaults.
 */
function withoutLook(settings: DevelopSettings, lookup: (presetId: string) => Preset | undefined): DevelopSettings {
  const applied = settings.look.applied;
  if (!applied) return resetSections(settings, LOOK_SECTIONS);
  const previous = lookup(applied.presetId);
  const next = previous ? resetSections(settings, untouchedLookSections(settings, previous, applied.amount)) : settings;
  return { ...next, look: { ...next.look, applied: null } };
}

/**
 * Remove the photo's look (None, Reset): see `withoutLook`. The sections an applied look wrote and nobody changed since
 * go back to the defaults with its LUT; without an applied look, `effects` and the LUT are reset.
 */
export function removeLook(
  settings: DevelopSettings,
  lookup: (presetId: string) => Preset | undefined = () => undefined,
): DevelopSettings {
  return withoutLook(settings, lookup);
}

/**
 * Switch the photo to `look` at `amount` (null: no look). A different look applied before has its untouched sections
 * put back to the defaults first (when `lookup` knows it), so switching from a look with a curve to one without leaves
 * no curve behind, while a section edited by hand since keeps the edit; re-applying the same look only re-scales it.
 */
export function replaceLook(
  settings: DevelopSettings,
  look: Preset | null,
  amount: number,
  lookup: (presetId: string) => Preset | undefined = () => undefined,
): DevelopSettings {
  if (!look) return removeLook(settings, lookup);
  const applied = settings.look.applied;
  if (applied && applied.presetId !== look.id) settings = withoutLook(settings, lookup);
  return applyLook(settings, look, amount);
}

/**
 * The Amount the photo shows `look` at: the recorded `applied.amount` when it names the look and the look's sections
 * still hold what it wrote (null once one was edited by hand: the slider is then locked, "changed since"); for a LUT
 * look whose LUT the photo has, the strength as a share of the look's; otherwise null (not this look).
 */
export function lookAmountOf(
  settings: DevelopSettings,
  look: Pick<Preset, 'id' | 'sections' | 'settings'>,
): number | null {
  const applied = settings.look.applied;
  if (applied) {
    if (applied.presetId !== look.id) return null;
    return lookIntact(settings, look, applied.amount) ? applied.amount : null;
  }
  const want = (look.settings as { look?: { lut?: { id: string; strength?: number } | null } }).look?.lut;
  const lut = settings.look.lut;
  if (!want || !lut || lut.id !== want.id || !look.sections.includes('look')) return null;
  const full = want.strength ?? 100;
  return full > 0 ? clampAmount((lut.strength / full) * 100) : 100;
}

/** The id of the look the strip shows as chosen: the applied one, else None when the look section is untouched. */
export function chosenLookId(settings: DevelopSettings): string | null {
  const applied = settings.look.applied;
  if (applied) return applied.presetId;
  return settings.look.lut === null ? NO_LOOK : null;
}

/**
 * What the look thumbnails are rendered over: the photo's settings without its look (the applied look's sections at
 * their defaults when `lookup` knows it) and with `effects` and `look` at their defaults. Its develop hash is the
 * thumbnail cache's `baseDh`.
 */
export function lookBase(
  settings: DevelopSettings,
  lookup: (presetId: string) => Preset | undefined = () => undefined,
): DevelopSettings {
  const applied = settings.look.applied;
  const previous = applied ? lookup(applied.presetId) : undefined;
  const sections = previous ? presetSections(previous) : [];
  return resetSections(settings, [...new Set<DevelopSectionKey>([...sections, ...LOOK_SECTIONS])]);
}

/** Step `dir` (±1) through None followed by `looks` from the chosen one; null when there is nothing to step to. */
export function stepLookId(looks: readonly Pick<Preset, 'id'>[], chosen: string | null, dir: 1 | -1): string | null {
  const ids = [NO_LOOK, ...looks.map((l) => l.id)];
  if (ids.length === 1) return null;
  const at = chosen === null ? -1 : ids.indexOf(chosen);
  if (at < 0) return dir > 0 ? (ids[1] ?? null) : (ids[ids.length - 1] ?? null);
  const next = at + dir;
  return next < 0 || next >= ids.length ? null : (ids[next] ?? null);
}

/**
 * A new look (fresh ULID) from a photo's settings: `effects` and `look` always, plus the `extra` sections asked for.
 * The photo's `look.applied` is left out (it belongs to the photo).
 */
export function makeLook(
  name: string,
  settings: DevelopSettings,
  extra: readonly DevelopSectionKey[] = [],
  id: string = newId(),
): Preset {
  const sections = DEVELOP_SECTION_KEYS.filter((key) => LOOK_SECTIONS.includes(key) || extra.includes(key));
  return {
    id,
    name: name.trim(),
    sections,
    settings: presetValues(settings, sections),
    builtIn: false,
    look: true,
  };
}

/** A LUT look: the LUT at full strength and nothing else (Import LUT…, a fitted LUT). */
export function makeLutLook(name: string, lut: { id: string; name: string }, id: string = newId()): Preset {
  return {
    id,
    name: name.trim() || lut.name,
    sections: ['look'],
    settings: { look: { lut: { id: lut.id, name: lut.name, strength: 100 } } },
    builtIn: false,
    look: true,
  };
}

// ---------- Look lookup for code below the stores (Sync and Copy) ----------

let registeredLookup: (presetId: string) => Preset | undefined = () => undefined;

/** `store/looks.ts` registers how to find a look by id, so the pure Sync code can ask without importing the store. */
export function setLookLookup(lookup: (presetId: string) => Preset | undefined): void {
  registeredLookup = lookup;
}

/**
 * `look.applied` as it may travel with copied sections (Sync, Copy and Paste): kept only when the look is known and
 * every section it lists is among `copied`, else null (the target would not hold what the look wrote).
 */
export function appliedAfterCopy(
  applied: DevelopSettings['look']['applied'],
  copied: readonly DevelopSectionKey[],
): DevelopSettings['look']['applied'] {
  if (!applied) return null;
  const look = registeredLookup(applied.presetId);
  if (!look) return null;
  return presetSections(look).every((key) => copied.includes(key)) ? { ...applied } : null;
}
