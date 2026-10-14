import type { Grading, GradingHarmony, GradingWheel } from '@photobook/shared';

/**
 * Plan 55 (ODDHALLS_LAYOUT_PLAN 4.2): the harmony lock of the grading wheels. Pure. A lock ties the three tonal
 * wheels' hues by fixed angles; it never changes the maths, it only decides what a drag on a wheel writes. Saturation
 * and luminance stay free under every lock, and the Global wheel is never tied.
 *
 * - `dragWheel` is what a drag (or a typed hue) writes: the dragged wheel's new values, and the hues of the wheels the
 *   lock ties to it turned by the same amount.
 * - `alignToHarmony` is what choosing a lock writes: the tied wheels put on the lock's angles around the most
 *   saturated tied wheel (the highlights on a tie).
 * - `spokes` are the angles the lock draws on a ring (the other tied wheels' hues); `snapTargets` are the hues a drag
 *   snaps to (under a lock the wheels that stay put while it moves; under Free the harmonic angles from every other
 *   tinted wheel), within `SNAP_DEGREES`; the wheel ticks once per snap.
 */

export type TonalWheelKey = 'shadows' | 'midtones' | 'highlights';
export type WheelKey = TonalWheelKey | 'global';
/** A lock, or `free` (no lock: `grading.harmony` absent). */
export type HarmonyChoice = GradingHarmony | 'free';

export const TONAL_WHEELS: readonly TonalWheelKey[] = ['shadows', 'midtones', 'highlights'];

/** The lock menu, in the Layout plan's order. */
export const HARMONY_CHOICES: ReadonlyArray<{ id: HarmonyChoice; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: 'monochromatic', label: 'Monochromatic' },
  { id: 'complementary', label: 'Complementary' },
  { id: 'splitComplementary', label: 'Split complementary' },
  { id: 'triadic', label: 'Triadic' },
  { id: 'tetradic', label: 'Tetradic' },
  { id: 'analogous', label: 'Analogous' },
];

/**
 * Each tonal wheel's hue relative to a common base, per lock; `null` is a wheel the lock leaves free.
 * Complementary: shadows = highlights + 180°, midtones free. Split complementary: the two neighbours of the
 * complement (±30°). Triadic: 120° apart. Tetradic: three corners of a square (90° apart). Analogous: ±30° around the
 * midtones. Monochromatic: one hue.
 */
const OFFSETS: Record<GradingHarmony, Record<TonalWheelKey, number | null>> = {
  monochromatic: { shadows: 0, midtones: 0, highlights: 0 },
  complementary: { shadows: 180, midtones: null, highlights: 0 },
  splitComplementary: { shadows: 150, midtones: 210, highlights: 0 },
  triadic: { shadows: 240, midtones: 120, highlights: 0 },
  tetradic: { shadows: 180, midtones: 90, highlights: 0 },
  analogous: { shadows: -30, midtones: 0, highlights: 30 },
};

/** How close (degrees) a dragged hue must come to a snap target to land on it. */
export const SNAP_DEGREES = 4;

/** A hue in 0..360 (360 itself folds to 0), rounded to 0.1°. */
export function normHue(hue: number): number {
  const h = Math.round((((hue % 360) + 360) % 360) * 10) / 10;
  return h === 360 ? 0 : h;
}

/** The shortest angle between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(normHue(a) - normHue(b));
  return Math.min(d, 360 - d);
}

/** The lock of a grading (`free` when absent). */
export const harmonyOf = (grading: Pick<Grading, 'harmony'>): HarmonyChoice => grading.harmony ?? 'free';

/** The lock's offset of `wheel`, or null when the lock leaves it free (always for `global` and under `free`). */
function offsetOf(harmony: HarmonyChoice, wheel: WheelKey): number | null {
  if (harmony === 'free' || wheel === 'global') return null;
  return OFFSETS[harmony][wheel];
}

/** The wheels that turn with `wheel` under `harmony` (not `wheel` itself). */
export function tiedWith(harmony: HarmonyChoice, wheel: WheelKey): TonalWheelKey[] {
  if (offsetOf(harmony, wheel) === null) return [];
  return TONAL_WHEELS.filter((k) => k !== wheel && offsetOf(harmony, k) !== null);
}

type WheelPatch = Partial<Pick<GradingWheel, 'hue' | 'saturation'>>;
/** What a drag or a lock writes: a hue / saturation patch per wheel. */
export type GradingPatch = Partial<Record<WheelKey, WheelPatch>>;

/**
 * What a drag on `wheel` to `next` writes under `harmony`: `wheel` gets `next`; each wheel tied to it gets the hue
 * at its own offset from the new base (its saturation unchanged).
 */
export function dragWheel(
  harmony: HarmonyChoice,
  wheel: WheelKey,
  next: Pick<GradingWheel, 'hue' | 'saturation'>,
): GradingPatch {
  const patch: GradingPatch = { [wheel]: { hue: normHue(next.hue), saturation: next.saturation } };
  const own = offsetOf(harmony, wheel);
  if (own === null) return patch;
  const base = next.hue - own;
  for (const k of tiedWith(harmony, wheel)) patch[k] = { hue: normHue(base + (offsetOf(harmony, k) ?? 0)) };
  return patch;
}

/**
 * What choosing `harmony` writes: the tied wheels on the lock's angles around the anchor (the most saturated tied
 * wheel; the highlights, then the shadows, on a tie). Empty for `free` and when the wheels already sit on the angles.
 */
export function alignToHarmony(grading: Grading, harmony: HarmonyChoice): GradingPatch {
  if (harmony === 'free') return {};
  const tied = TONAL_WHEELS.filter((k) => offsetOf(harmony, k) !== null);
  const order: TonalWheelKey[] = ['highlights', 'shadows', 'midtones'];
  const anchor = order
    .filter((k) => tied.includes(k))
    .reduce((best, k) => (grading[k].saturation > grading[best].saturation ? k : best));
  const patch: GradingPatch = {};
  const moved = dragWheel(harmony, anchor, grading[anchor]);
  for (const k of tiedWith(harmony, anchor)) {
    const hue = moved[k]?.hue;
    if (hue !== undefined && hue !== grading[k].hue) patch[k] = { hue };
  }
  return patch;
}

/** The angles `harmony` draws as spokes on `wheel`'s ring: the hues of the other wheels the lock ties. */
export function spokes(grading: Grading, harmony: HarmonyChoice, wheel: WheelKey): number[] {
  return TONAL_WHEELS.filter((k) => k !== wheel && offsetOf(harmony, k) !== null).map((k) => grading[k].hue);
}

/** Free mode's harmonic angles from another wheel's hue: complementary, triadic, tetradic and analogous. */
export const FREE_SNAP_ANGLES: readonly number[] = [180, 120, -120, 90, -90, 30, -30];

/**
 * The hues a drag on `wheel` snaps to. Under a lock: the hues of the wheels that stay put while it moves (the tonal
 * wheels the lock leaves untied from it, and the Global wheel while it has a tint). Under Free: the harmonic angles
 * (`FREE_SNAP_ANGLES`) from every other wheel that has a tint (saturation > 0; the Global wheel too), so a free drag
 * clicks into complementary, triadic, tetradic and analogous relations; none when no other wheel has a tint.
 */
export function snapTargets(grading: Grading, harmony: HarmonyChoice, wheel: WheelKey): number[] {
  if (harmony === 'free') {
    const others = (['shadows', 'midtones', 'highlights', 'global'] as const).filter(
      (k) => k !== wheel && grading[k].saturation > 0,
    );
    return others.flatMap((k) => FREE_SNAP_ANGLES.map((a) => normHue(grading[k].hue + a)));
  }
  const moving = new Set<WheelKey>([wheel, ...tiedWith(harmony, wheel)]);
  const still = (['shadows', 'midtones', 'highlights', 'global'] as const).filter((k) => !moving.has(k));
  return still.filter((k) => k !== 'global' || grading.global.saturation > 0).map((k) => grading[k].hue);
}

/** `hue` snapped to the nearest target within `tolerance` degrees; `snapped` is the target it landed on, or null. */
export function snapHue(
  hue: number,
  targets: readonly number[],
  tolerance = SNAP_DEGREES,
): { hue: number; snapped: number | null } {
  let best: number | null = null;
  for (const t of targets) {
    const d = hueDistance(hue, t);
    if (d <= tolerance && (best === null || d < hueDistance(hue, best))) best = t;
  }
  return best === null ? { hue: normHue(hue), snapped: null } : { hue: normHue(best), snapped: normHue(best) };
}
