//! Highlights / shadows and whites / blacks.
//!
//! **Highlights / shadows** key on the *base* lightness `t` (the edge-preserving guided-filter base of
//! `log2 Y` from [`crate::local::prepass::hs_base`], as `Y^(1/2.4)`), not the pixel's own, so texture
//! inside a highlight survives while its level moves, and a bright sky beside a dark subject keeps its
//! own level instead of borrowing the subject's. The gain, in EV, is
//! `highlights · HIGHLIGHTS_EV · smoothstep(0.25, 1, t) + shadows · SHADOWS_EV · w(t)` with
//! `w(t) = t·(1−t)^3` normalised to peak at 1 (at `t = 0.25`), and multiplies the pixel's RGB. The
//! constants keep the base tone curve monotone at every slider extreme (tested).
//!
//! **Whites / blacks** are an end-point stretch per channel on the encoded value `u = c^(1/2.4)`:
//! blacks moves the left end with the right fixed, with the DNG SDK `exposure_ramp` quadratic toe when
//! crushing; whites moves the right end with the left fixed, shaped `u + k·u²` so the shadows barely
//! move (continued linearly above 1).

use super::smoothstep;
use crate::settings::Light;

pub const HIGHLIGHTS_EV: f32 = 1.25;
pub const SHADOWS_LIFT_EV: f32 = 1.5;
pub const SHADOWS_DEEPEN_EV: f32 = 1.0;
/// `w(t) = t·(1−t)^3` peaks at `t = 0.25` with this value.
pub(crate) const SHADOW_PEAK: f32 = 0.25 * 0.75 * 0.75 * 0.75;
/// Encoded black point at blacks = ∓100.
pub const BLACKS_RANGE: f32 = 0.12;
/// Encoded white point moves by this at whites = ±100.
pub const WHITES_RANGE: f32 = 0.2;
pub(crate) const GAIN_LUT_SIZE: usize = 1024;

/// The highlights/shadows gain in EV for base lightness `t` and sliders in -1..1.
pub fn tone_gain_ev(t: f32, highlights: f32, shadows: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let wh = smoothstep(0.25, 1.0, t);
    let ws = t * (1.0 - t).powi(3) / SHADOW_PEAK;
    let s_ev = if shadows > 0.0 { SHADOWS_LIFT_EV } else { SHADOWS_DEEPEN_EV };
    highlights * HIGHLIGHTS_EV * wh + shadows * s_ev * ws
}

#[derive(Debug, Clone)]
pub struct HighlightsShadowsParams {
    /// Linear gain by base lightness 0..1.
    pub(crate) lut: Vec<f32>,
    /// Multiplies the cached base so it matches the image after white balance and exposure.
    pub base_scale: f32,
}

impl HighlightsShadowsParams {
    pub fn new(light: &Light, base_scale: f32) -> Option<Self> {
        if light.highlights == 0.0 && light.shadows == 0.0 {
            return None;
        }
        let (h, s) = ((light.highlights / 100.0).clamp(-1.0, 1.0) as f32, (light.shadows / 100.0).clamp(-1.0, 1.0) as f32);
        let lut = (0..GAIN_LUT_SIZE).map(|i| tone_gain_ev(i as f32 / (GAIN_LUT_SIZE - 1) as f32, h, s).exp2()).collect();
        Some(Self { lut, base_scale })
    }

    #[inline]
    fn gain(&self, t: f32) -> f32 {
        self.gain_scaled(t, self.base_scale)
    }

    /// The gain for cached base lightness `t` rescaled by `scale` instead of [`Self::base_scale`] (a pixel whose
    /// local exposure or white balance differs from the global one).
    #[inline]
    pub fn gain_scaled(&self, t: f32, scale: f32) -> f32 {
        let p = (t * scale).clamp(0.0, 1.0) * (GAIN_LUT_SIZE - 1) as f32;
        let i = (p as usize).min(GAIN_LUT_SIZE - 2);
        let f = p - i as f32;
        self.lut[i] + (self.lut[i + 1] - self.lut[i]) * f
    }
}

/// The exact highlights/shadows gain (no table) for base lightness `t` (already rescaled) and sliders in
/// −1..1: what a pixel with local highlights or shadows uses.
#[inline]
pub fn tone_gain(t: f32, highlights: f32, shadows: f32) -> f32 {
    tone_gain_ev(t, highlights, shadows).exp2()
}

/// `base` holds one lightness value per pixel of `row`.
pub fn highlights_shadows(row: &mut [f32], base: &[f32], p: &HighlightsShadowsParams) {
    for (px, &t) in row.chunks_exact_mut(3).zip(base) {
        let g = p.gain(t);
        px[0] *= g;
        px[1] *= g;
        px[2] *= g;
    }
}

#[derive(Debug, Clone)]
pub struct WhitesBlacksParams {
    pub(crate) black: f32,
    pub(crate) slope: f32,
    pub(crate) radius: f32,
    pub(crate) qscale: f32,
    /// `k` in `u + k·u²`.
    pub(crate) white_k: f32,
}

impl WhitesBlacksParams {
    pub fn new(light: &Light) -> Option<Self> {
        if light.whites == 0.0 && light.blacks == 0.0 {
            return None;
        }
        let black = -(light.blacks / 100.0).clamp(-1.0, 1.0) as f32 * BLACKS_RANGE;
        let slope = 1.0 / (1.0 - black);
        // DNG SDK: radius = min(kMaxCurveX · black, kMaxCurveY / slope) with 0.5 and 1/16.
        let radius = if black > 0.0 { (0.5 * black).min(1.0 / 16.0 / slope) } else { 0.0 };
        let qscale = if radius > 0.0 { slope / (4.0 * radius) } else { 0.0 };
        let white = 1.0 - (light.whites / 100.0).clamp(-1.0, 1.0) as f32 * WHITES_RANGE;
        Some(Self { black, slope, radius, qscale, white_k: 1.0 / white - 1.0 })
    }

    /// From the sliders as unit values (−1..1, already clamped), in `f32`; `None` when both are 0. For
    /// per-pixel (masked) values.
    pub fn from_unit(whites: f32, blacks: f32) -> Option<Self> {
        if whites == 0.0 && blacks == 0.0 {
            return None;
        }
        let black = -blacks * BLACKS_RANGE;
        let slope = 1.0 / (1.0 - black);
        let radius = if black > 0.0 { (0.5 * black).min(1.0 / 16.0 / slope) } else { 0.0 };
        let qscale = if radius > 0.0 { slope / (4.0 * radius) } else { 0.0 };
        let white = 1.0 - whites * WHITES_RANGE;
        Some(Self { black, slope, radius, qscale, white_k: 1.0 / white - 1.0 })
    }

    /// The tone curve on the encoded value.
    #[inline]
    pub fn curve(&self, u: f32) -> f32 {
        let u = if self.radius > 0.0 {
            if u <= self.black - self.radius {
                0.0
            } else if u >= self.black + self.radius {
                (u - self.black) * self.slope
            } else {
                let y = u - (self.black - self.radius);
                self.qscale * y * y
            }
        } else {
            (u - self.black) * self.slope
        };
        let k = self.white_k;
        if u <= 0.0 {
            u
        } else if u <= 1.0 {
            u + k * u * u
        } else {
            (1.0 + k) + (1.0 + 2.0 * k) * (u - 1.0)
        }
    }
}

pub fn whites_blacks(row: &mut [f32], p: &WhitesBlacksParams) {
    for v in row.iter_mut() {
        *v = whites_blacks_value(*v, p);
    }
}

/// Whites/blacks on one linear channel value.
#[inline]
pub fn whites_blacks_value(v: f32, p: &WhitesBlacksParams) -> f32 {
    const ENC: f32 = 1.0 / 2.4;
    let u = v.abs().powf(ENC).copysign(v);
    let u = p.curve(u);
    u.abs().powf(2.4).copysign(u)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base tone curve `Y → Y·2^ev(t(Y))` must be monotone at every slider extreme.
    #[test]
    fn base_tone_curve_is_monotone() {
        for (h, s) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0)] {
            let mut prev = 0.0f32;
            for i in 1..=4000 {
                let y = i as f32 / 4000.0 * 1.2;
                let out = y * tone_gain_ev(y.powf(1.0 / 2.4), h, s).exp2();
                assert!(out > prev, "h={h} s={s} not monotone at Y={y}");
                prev = out;
            }
        }
    }

    #[test]
    fn highlights_and_shadows_move_the_right_tones() {
        assert!(tone_gain_ev(0.95, -1.0, 0.0) < -1.0);
        assert!(tone_gain_ev(0.1, -1.0, 0.0).abs() < 1e-6);
        assert!(tone_gain_ev(0.25, 0.0, 1.0) > 1.4);
        assert!(tone_gain_ev(0.95, 0.0, 1.0) < 0.01);
        assert_eq!(tone_gain_ev(0.5, 0.0, 0.0), 0.0);
    }

    #[test]
    fn whites_blacks_curves() {
        let light = |whites: f64, blacks: f64| Light { whites, blacks, ..Light::default() };
        assert!(WhitesBlacksParams::new(&light(0.0, 0.0)).is_none());
        for (w, b) in [(100.0, 0.0), (-100.0, 0.0), (0.0, 100.0), (0.0, -100.0), (100.0, -100.0), (-100.0, 100.0)] {
            let p = WhitesBlacksParams::new(&light(w, b)).unwrap();
            let mut prev = f32::MIN;
            for i in 0..=3000 {
                let y = p.curve(i as f32 / 1000.0);
                assert!(y >= prev, "w={w} b={b} at {i}");
                prev = y;
            }
        }
        let crush = WhitesBlacksParams::new(&light(0.0, -100.0)).unwrap();
        assert_eq!(crush.curve(0.05), 0.0);
        assert!((crush.curve(1.0) - 1.0).abs() < 1e-6);
        let lift = WhitesBlacksParams::new(&light(0.0, 100.0)).unwrap();
        assert!(lift.curve(0.0) > 0.1);
        let brighter = WhitesBlacksParams::new(&light(100.0, 0.0)).unwrap();
        assert!((brighter.curve(1.0) - 1.25).abs() < 1e-6);
        assert!(brighter.curve(0.1) - 0.1 < 0.01);
    }
}
