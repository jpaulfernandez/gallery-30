//! Colour grading (workflow plan 17): three wheels (shadows, midtones, highlights), each adding an Oklab chroma
//! vector to the pixels of its tonal range, plus Blending (how much the ranges overlap) and Balance (where shadows
//! end and highlights begin). The "split tone" of most film looks.
//!
//! Display-referred: it runs in [`crate::ops::output`] on the sRGB-encoded output values after the tone curves
//! (and after the LUT of workflow plan 18), decoding them to linear output RGB for an Oklab round trip, then gamut
//! mapping and re-encoding.
//!
//! **Bands.** Oklab `L` is remapped piecewise-linearly so the pivot `0.5 − BALANCE_SHIFT · balance` lands at 0.5;
//! shadows fade out around 1/3 and highlights fade in around 2/3 of the remapped range over a smoothstep of width
//! `lerp(MIN_BAND_WIDTH, MAX_BAND_WIDTH, blending)`; midtones take what is left. Near black and near white the
//! tint fades out, so pure black and white stay neutral.
//!
//! **Wheels.** Hue is a position on the familiar colour wheel (sRGB HSV hue: 0 red, 60 yellow, 120 green, 180 cyan,
//! 240 blue, 300 magenta), turned into an Oklab direction through the fully saturated sRGB colour of that hue.
//! Saturation 100 adds [`GRADING_CHROMA`] of Oklab chroma at full band weight.
//!
//! **Plan 55.** Each wheel's `luminance` (−100..100) moves Oklab `L` by up to [`GRADING_LUMINANCE`] at full band
//! weight, and the Global wheel tints and lifts every tone (weight 1), both under the same fade at black and white.
//! Settings without them (every `luminance` 0, the Global wheel at its defaults) take the engine 3 arithmetic
//! unchanged ([`GradingParams::extra`] is `None`), so they render byte-identical to `develop-engine/3`.

use super::smoothstep;
use crate::color::matrix;
use crate::color::oklab::Oklab;
use crate::color::transfer::srgb_to_linear;
use crate::ops::color::hsv_to_rgb;
use crate::settings::{Grading, GradingWheel};

/// Oklab chroma a wheel adds at saturation 100 and full band weight.
pub const GRADING_CHROMA: f32 = 0.06;
/// How far Balance ±100 moves the shadows / highlights pivot on Oklab `L` (from 0.5).
pub const BALANCE_SHIFT: f32 = 0.25;
/// Smoothstep width of a band edge at Blending 0 and 100 (in remapped `L`).
pub const MIN_BAND_WIDTH: f32 = 0.08;
pub const MAX_BAND_WIDTH: f32 = 0.6;
/// Oklab `L` a wheel's luminance ±100 moves at full band weight (plan 55).
pub const GRADING_LUMINANCE: f32 = 0.1;

#[derive(Debug, Clone)]
pub struct GradingParams {
    /// Oklab `(a, b)` offset of each wheel at full weight: shadows, midtones, highlights.
    pub(crate) offsets: [[f32; 2]; 3],
    /// Oklab `L` that maps to the middle of the bands.
    pub(crate) pivot: f32,
    /// Band edge width.
    pub(crate) width: f32,
    /// Plan 55: the Global wheel and the luminance offsets; `None` when they are all at their defaults.
    pub(crate) extra: Option<GradingExtra>,
}

/// Plan 55's additions to a grading.
#[derive(Debug, Clone)]
pub struct GradingExtra {
    /// The Global wheel's Oklab `(a, b)` offset (weight 1 on every tone).
    pub(crate) global: [f32; 2],
    /// Oklab `L` offsets at full weight: shadows, midtones, highlights, global.
    pub(crate) luminance: [f32; 4],
}

/// Fades the grading out at black and white, so both stay neutral.
#[inline]
fn fade(l: f32) -> f32 {
    smoothstep(0.0, 0.05, l) * (1.0 - smoothstep(0.98, 1.0, l))
}

/// Unit Oklab `(a, b)` direction of a colour-wheel hue in degrees.
pub fn wheel_direction(hue: f32) -> [f32; 2] {
    let ok = Oklab::for_space(&matrix::srgb_to_xyz());
    let rgb = hsv_to_rgb(hue.rem_euclid(360.0)).map(srgb_to_linear);
    let [_, a, b] = ok.to_lab(rgb);
    let c = a.hypot(b).max(1e-6);
    [a / c, b / c]
}

impl GradingParams {
    /// `None` when no wheel has saturation or a luminance offset (Blending and Balance alone change nothing).
    pub fn new(g: &Grading) -> Option<Self> {
        let wheels = [&g.shadows, &g.midtones, &g.highlights];
        let all = [&g.shadows, &g.midtones, &g.highlights, &g.global];
        if all.iter().all(|w| w.saturation <= 0.0 && w.luminance == 0.0) {
            return None;
        }
        let offset = |w: &GradingWheel| {
            let s = (w.saturation / 100.0).clamp(0.0, 1.0) as f32 * GRADING_CHROMA;
            let [a, b] = wheel_direction(w.hue as f32);
            [a * s, b * s]
        };
        let balance = (g.balance / 100.0).clamp(-1.0, 1.0) as f32;
        let blending = (g.blending / 100.0).clamp(0.0, 1.0) as f32;
        let extra = (g.global.saturation > 0.0 || all.iter().any(|w| w.luminance != 0.0)).then(|| GradingExtra {
            global: if g.global.saturation > 0.0 { offset(&g.global) } else { [0.0; 2] },
            luminance: all.map(|w| (w.luminance / 100.0).clamp(-1.0, 1.0) as f32 * GRADING_LUMINANCE),
        });
        Some(Self {
            offsets: wheels.map(offset),
            pivot: 0.5 - BALANCE_SHIFT * balance,
            width: MIN_BAND_WIDTH + (MAX_BAND_WIDTH - MIN_BAND_WIDTH) * blending,
            extra,
        })
    }

    /// Band weights `[shadows, midtones, highlights]` at Oklab lightness `l`; they sum to 1.
    #[inline]
    pub fn weights(&self, l: f32) -> [f32; 3] {
        let l = l.clamp(0.0, 1.0);
        let p = self.pivot;
        let t = if l < p { 0.5 * l / p } else { 0.5 + 0.5 * (l - p) / (1.0 - p) };
        let half = 0.5 * self.width;
        let shadows = 1.0 - smoothstep(1.0 / 3.0 - half, 1.0 / 3.0 + half, t);
        let highlights = smoothstep(2.0 / 3.0 - half, 2.0 / 3.0 + half, t);
        let sum = shadows + highlights;
        if sum > 1.0 {
            [shadows / sum, 0.0, highlights / sum]
        } else {
            [shadows, 1.0 - sum, highlights]
        }
    }

    /// The Oklab `(a, b)` offset at lightness `l`, faded out at black and white.
    #[inline]
    pub fn offset(&self, l: f32) -> [f32; 2] {
        let [da, db, _] = self.shift(l);
        [da, db]
    }

    /// The Oklab `(a, b)` offset and the `L` offset at lightness `l`, faded out at black and white. Without
    /// [`GradingParams::extra`] the `L` offset is 0 and the `(a, b)` arithmetic is engine 3's.
    #[inline]
    pub fn shift(&self, l: f32) -> [f32; 3] {
        let w = self.weights(l);
        let fade = fade(l);
        let o = &self.offsets;
        let mut da = (w[0] * o[0][0] + w[1] * o[1][0] + w[2] * o[2][0]) * fade;
        let mut db = (w[0] * o[0][1] + w[1] * o[1][1] + w[2] * o[2][1]) * fade;
        let mut dl = 0.0;
        if let Some(x) = &self.extra {
            let y = &x.luminance;
            da += x.global[0] * fade;
            db += x.global[1] * fade;
            dl = (w[0] * y[0] + w[1] * y[1] + w[2] * y[2] + y[3]) * fade;
        }
        [da, db, dl]
    }
}

/// Grade one linear RGB triple of the space `oklab` converts (not gamut mapped).
#[inline]
pub fn grade(lin: [f32; 3], oklab: &Oklab, p: &GradingParams) -> [f32; 3] {
    let [l, a, b] = oklab.to_lab(lin);
    let [da, db, dl] = p.shift(l);
    if p.extra.is_none() {
        return oklab.to_rgb([l, a + da, b + db]);
    }
    oklab.to_rgb([(l + dl).clamp(0.0, 1.0), a + da, b + db])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(hue: f64, wheel: usize) -> GradingParams {
        let mut g = Grading::default();
        let w = GradingWheel { hue, saturation: 100.0, ..GradingWheel::default() };
        match wheel {
            0 => g.shadows = w,
            1 => g.midtones = w,
            _ => g.highlights = w,
        }
        GradingParams::new(&g).unwrap()
    }

    #[test]
    fn default_is_skipped() {
        assert!(GradingParams::new(&Grading::default()).is_none());
        let g = Grading { blending: 90.0, balance: -40.0, ..Grading::default() };
        assert!(GradingParams::new(&g).is_none(), "blending and balance alone do nothing");
    }

    #[test]
    fn weights_sum_to_one_and_follow_lightness() {
        for blending in [0.0, 50.0, 100.0] {
            for balance in [-100.0, 0.0, 100.0] {
                let g = Grading {
                    shadows: GradingWheel { hue: 0.0, saturation: 10.0, ..GradingWheel::default() },
                    blending,
                    balance,
                    ..Grading::default()
                };
                let p = GradingParams::new(&g).unwrap();
                for i in 0..=100 {
                    let w = p.weights(i as f32 / 100.0);
                    assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5, "{w:?}");
                    assert!(w.iter().all(|v| (0.0..=1.0).contains(v)), "{w:?}");
                }
                let (dark, light) = (p.weights(0.02), p.weights(0.98));
                assert!(dark[0] > 0.9 && light[2] > 0.9, "{dark:?} {light:?}");
            }
        }
        // Positive balance gives the highlights wheel more of the range.
        let mk = |balance| GradingParams::new(&Grading { balance, ..grading_with_sat() }).unwrap().weights(0.6)[2];
        assert!(mk(100.0) > mk(0.0) && mk(0.0) > mk(-100.0));
    }

    fn grading_with_sat() -> Grading {
        Grading { highlights: GradingWheel { hue: 40.0, saturation: 50.0, ..GradingWheel::default() }, ..Grading::default() }
    }

    #[test]
    fn hue_wheel_at_0_is_red_and_at_180_is_cyan() {
        let [a0, b0] = wheel_direction(0.0);
        assert!(a0 > 0.8 && b0.abs() < 0.6, "red direction {a0} {b0}");
        let [a180, b180] = wheel_direction(180.0);
        assert!(a180 < -0.6, "cyan direction {a180} {b180}");
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        let grey = [0.05f32; 3]; // a shadow
        let red = grade(grey, &ok, &params(0.0, 0));
        assert!(red[0] > red[1] && red[0] > red[2], "{red:?}");
        let cyan = grade(grey, &ok, &params(180.0, 0));
        assert!(cyan[1] > cyan[0] && cyan[2] > cyan[0], "{cyan:?}");
        // The shadows wheel leaves a highlight nearly alone.
        let light = grade([0.8; 3], &ok, &params(0.0, 0));
        assert!((light[0] - light[1]).abs() < 0.01, "{light:?}");
        // Lightness is kept.
        let l = |rgb| ok.to_lab(rgb)[0];
        assert!((l(red) - l(grey)).abs() < 1e-4);
    }

    #[test]
    fn black_and_white_stay_neutral() {
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        let p = params(200.0, 2);
        for v in [0.0f32, 1.0] {
            let out = grade([v; 3], &ok, &p);
            assert!(out.iter().all(|c| (c - v).abs() < 1e-4), "{v}: {out:?}");
        }
    }

    #[test]
    fn luminance_and_global_are_none_at_their_defaults() {
        let g = grading_with_sat();
        assert!(GradingParams::new(&g).unwrap().extra.is_none(), "engine 3 settings keep the engine 3 maths");
        let lum = Grading { shadows: GradingWheel { luminance: 30.0, ..GradingWheel::default() }, ..Grading::default() };
        let p = GradingParams::new(&lum).expect("a luminance offset alone grades");
        assert!(p.extra.is_some());
        let global = Grading { global: GradingWheel { hue: 30.0, saturation: 20.0, ..GradingWheel::default() }, ..Grading::default() };
        assert!(GradingParams::new(&global).is_some(), "the Global wheel alone grades");
    }

    #[test]
    fn luminance_moves_lightness_in_its_band_only() {
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        let l = |rgb| ok.to_lab(rgb)[0];
        let shadows_up = Grading { shadows: GradingWheel { luminance: 100.0, ..GradingWheel::default() }, ..Grading::default() };
        let p = GradingParams::new(&shadows_up).unwrap();
        let dark = [0.02f32; 3];
        let lifted = grade(dark, &ok, &p);
        assert!(l(lifted) > l(dark) + 0.05, "shadows lifted: {} -> {}", l(dark), l(lifted));
        assert!((lifted[0] - lifted[1]).abs() < 1e-4, "a luminance offset adds no colour: {lifted:?}");
        let bright = [0.7f32; 3];
        assert!((l(grade(bright, &ok, &p)) - l(bright)).abs() < 0.01, "highlights nearly untouched");
        // Negative darkens; black and white stay put.
        let down = Grading { highlights: GradingWheel { luminance: -100.0, ..GradingWheel::default() }, ..Grading::default() };
        let p = GradingParams::new(&down).unwrap();
        assert!(l(grade(bright, &ok, &p)) < l(bright) - 0.05);
        for v in [0.0f32, 1.0] {
            let out = grade([v; 3], &ok, &p);
            assert!(out.iter().all(|c| (c - v).abs() < 1e-4), "{v}: {out:?}");
        }
    }

    #[test]
    fn luminance_offsets_are_exact_at_full_weight() {
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        let grey = |l: f32| ok.to_rgb([l, 0.0, 0.0]);
        let l = |rgb| ok.to_lab(rgb)[0];
        // Global +100 at L 0.5: fade 1, weight 1, so L moves by exactly GRADING_LUMINANCE.
        let global = Grading { global: GradingWheel { luminance: 100.0, ..GradingWheel::default() }, ..Grading::default() };
        let p = GradingParams::new(&global).unwrap();
        assert!((l(grade(grey(0.5), &ok, &p)) - 0.6).abs() < 1e-5, "{}", l(grade(grey(0.5), &ok, &p)));
        // Shadows +100 at L 0.1: the shadows weight is 1 there (below the band edge at Blending 50) and the fade 1.
        let shadows = Grading { shadows: GradingWheel { luminance: 100.0, ..GradingWheel::default() }, ..Grading::default() };
        let p = GradingParams::new(&shadows).unwrap();
        assert_eq!(p.weights(0.1), [1.0, 0.0, 0.0]);
        assert!((l(grade(grey(0.1), &ok, &p)) - 0.2).abs() < 1e-5, "{}", l(grade(grey(0.1), &ok, &p)));
    }

    #[test]
    fn global_wheel_tints_every_tone() {
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        let g = Grading { global: GradingWheel { hue: 0.0, saturation: 100.0, luminance: 50.0 }, ..Grading::default() };
        let p = GradingParams::new(&g).unwrap();
        for v in [0.03f32, 0.2, 0.6] {
            let out = grade([v; 3], &ok, &p);
            assert!(out[0] > out[1] && out[0] > out[2], "{v}: red everywhere {out:?}");
            assert!(ok.to_lab(out)[0] > ok.to_lab([v; 3])[0], "{v}: lighter");
        }
    }
}
