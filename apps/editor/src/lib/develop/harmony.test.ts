import { createDevelop, type Grading } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  alignToHarmony,
  dragWheel,
  FREE_SNAP_ANGLES,
  HARMONY_CHOICES,
  harmonyOf,
  hueDistance,
  normHue,
  SNAP_DEGREES,
  snapHue,
  snapTargets,
  spokes,
  tiedWith,
} from './harmony';

function grading(patch: (g: Grading) => void = () => {}): Grading {
  const g = createDevelop().effects.grading;
  patch(g);
  return g;
}

describe('harmony lock (plan 55)', () => {
  it('offers Free and the six locks in the Layout plan order; absent is Free', () => {
    expect(HARMONY_CHOICES.map((c) => c.label)).toEqual([
      'Free',
      'Monochromatic',
      'Complementary',
      'Split complementary',
      'Triadic',
      'Tetradic',
      'Analogous',
    ]);
    expect(harmonyOf(grading())).toBe('free');
    expect(harmonyOf(grading((g) => (g.harmony = 'triadic')))).toBe('triadic');
  });

  it('normalises hues and measures the short way round', () => {
    expect(normHue(-30)).toBe(330);
    expect(normHue(360)).toBe(0);
    expect(normHue(725.04)).toBe(5);
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
  });

  it('Free writes only the dragged wheel', () => {
    expect(dragWheel('free', 'shadows', { hue: 200, saturation: 30 })).toEqual({
      shadows: { hue: 200, saturation: 30 },
    });
  });

  it('Complementary ties shadows to highlights + 180° and leaves the midtones free', () => {
    expect(dragWheel('complementary', 'highlights', { hue: 40, saturation: 50 })).toEqual({
      highlights: { hue: 40, saturation: 50 },
      shadows: { hue: 220 },
    });
    expect(dragWheel('complementary', 'shadows', { hue: 10, saturation: 20 })).toEqual({
      shadows: { hue: 10, saturation: 20 },
      highlights: { hue: 190 },
    });
    expect(dragWheel('complementary', 'midtones', { hue: 90, saturation: 5 })).toEqual({
      midtones: { hue: 90, saturation: 5 },
    });
  });

  it('Triadic, tetradic, split complementary and analogous keep their angles from any wheel', () => {
    const angles = (patch: ReturnType<typeof dragWheel>) => [
      patch.shadows?.hue,
      patch.midtones?.hue,
      patch.highlights?.hue,
    ];
    expect(angles(dragWheel('triadic', 'midtones', { hue: 150, saturation: 10 }))).toEqual([270, 150, 30]);
    expect(angles(dragWheel('tetradic', 'highlights', { hue: 300, saturation: 10 }))).toEqual([120, 30, 300]);
    expect(angles(dragWheel('splitComplementary', 'highlights', { hue: 30, saturation: 10 }))).toEqual([180, 240, 30]);
    expect(angles(dragWheel('analogous', 'shadows', { hue: 10, saturation: 10 }))).toEqual([10, 40, 70]);
    expect(angles(dragWheel('monochromatic', 'midtones', { hue: 77, saturation: 10 }))).toEqual([77, 77, 77]);
  });

  it('never ties the Global wheel, and the saturation of a tied wheel stays its own', () => {
    expect(dragWheel('triadic', 'global', { hue: 10, saturation: 40 })).toEqual({
      global: { hue: 10, saturation: 40 },
    });
    expect(tiedWith('triadic', 'global')).toEqual([]);
    for (const [, p] of Object.entries(dragWheel('monochromatic', 'shadows', { hue: 5, saturation: 80 })))
      if (p !== undefined && !('saturation' in p)) expect(p).toEqual({ hue: 5 });
  });

  it('choosing a lock aligns the tied wheels around the most saturated one', () => {
    const g = grading((x) => {
      x.shadows = { hue: 200, saturation: 60, luminance: 0 };
      x.highlights = { hue: 40, saturation: 20, luminance: 0 };
      x.midtones = { hue: 90, saturation: 0, luminance: 0 };
    });
    expect(alignToHarmony(g, 'complementary')).toEqual({ highlights: { hue: 20 } });
    expect(alignToHarmony(g, 'triadic')).toEqual({ midtones: { hue: 80 }, highlights: { hue: 320 } });
    expect(alignToHarmony(g, 'free')).toEqual({});
    // Already on the angles: nothing to write.
    expect(
      alignToHarmony(
        grading((x) => (x.shadows.hue = 180)),
        'complementary',
      ),
    ).toEqual({});
  });

  it('draws the other tied angles as spokes and snaps to the wheels that stay put', () => {
    const g = grading((x) => {
      x.shadows.hue = 220;
      x.midtones.hue = 90;
      x.highlights.hue = 40;
      x.global = { hue: 300, saturation: 10, luminance: 0 };
    });
    expect(spokes(g, 'complementary', 'highlights')).toEqual([220]);
    expect(spokes(g, 'complementary', 'midtones')).toEqual([220, 40]);
    expect(spokes(g, 'free', 'shadows')).toEqual([]);
    // Dragging the free midtones snaps to the tied pair; dragging a tied wheel snaps to the midtones and Global.
    expect(snapTargets(g, 'complementary', 'midtones')).toEqual([220, 40, 300]);
    expect(snapTargets(g, 'complementary', 'highlights')).toEqual([90, 300]);
    // Free: the harmonic angles from every other tinted wheel (here only the Global wheel has a tint).
    expect(snapTargets(g, 'free', 'midtones')).toEqual(FREE_SNAP_ANGLES.map((a) => normHue(300 + a)));
    expect(
      snapTargets(
        grading((x) => (x.midtones.hue = 90)),
        'complementary',
        'shadows',
      ),
    ).toEqual([90]);
  });

  it('snaps within SNAP_DEGREES, across 0°, to the nearest target', () => {
    expect(snapHue(43, [40, 45])).toEqual({ hue: 45, snapped: 45 });
    expect(snapHue(358, [1])).toEqual({ hue: 1, snapped: 1 });
    expect(snapHue(40 + SNAP_DEGREES + 0.5, [40])).toEqual({ hue: 44.5, snapped: null });
    expect(snapHue(100, [])).toEqual({ hue: 100, snapped: null });
  });

  it('Free: a drag snaps to 180°, ±120°, ±90° and ±30° from each tinted wheel, and never without one', () => {
    const tinted = grading((x) => {
      x.shadows = { hue: 200, saturation: 30, luminance: 0 };
    });
    const targets = snapTargets(tinted, 'free', 'highlights');
    expect(targets).toEqual([20, 320, 80, 290, 110, 230, 170]);
    expect(snapHue(23, targets)).toEqual({ hue: 20, snapped: 20 });
    // Every other wheel at saturation 0 (a hue alone is not a tint): nothing to snap to.
    const untinted = grading((x) => {
      x.shadows.hue = 200;
      x.global.hue = 90;
    });
    expect(snapTargets(untinted, 'free', 'highlights')).toEqual([]);
    expect(snapHue(20, snapTargets(untinted, 'free', 'highlights'))).toEqual({ hue: 20, snapped: null });
    // The dragged wheel's own tint never counts.
    expect(snapTargets(tinted, 'free', 'shadows')).toEqual([]);
  });
});
