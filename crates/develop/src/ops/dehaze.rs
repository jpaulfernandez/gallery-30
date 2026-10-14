//! Dehaze by the dark channel prior (He, Sun, Tang 2009) on linear RGB, with the transmission refined by
//! the guided filter ([`crate::local::prepass::haze_planes`] computes `A` and the density `D` once; the
//! dark channel is morphologically opened and the refinement is guided by the per-pixel dark channel,
//! which keeps the classic halo along object edges small even between colours of equal lightness).
//!
//! Positive: `t = 1 − ω·D` with `ω = 0.95 · strength`, `t ≥ t0 = 0.08`, then the sky-safe clamp: where
//! the pixel is within `K` of the atmospheric light (`K = SKY_TOLERANCE · Y(A)`, smooth bright sky) the
//! transmission is raised by `K / |I − A|` (Li et al.'s tolerance), so skies keep their level instead of
//! going grey-dark. `J = (I − A)/t + A`, clamped at 0. Negative: haze is added, `J = I + (A − I)·m` with
//! `m = |strength| · HAZE_ADD · (0.3 + 0.7·D)` (more where it is already hazy).
//!
//! `A` is measured on the decoded image; the pipeline maps it through white balance and exposure before
//! this pass, so those sliders keep it consistent (the tone sliders in between do not move it).

use crate::color::matrix::REC2020_LUMA;

pub const OMEGA: f32 = 0.95;
pub const T0: f32 = 0.08;
pub const SKY_TOLERANCE: f32 = 0.12;
pub const HAZE_ADD: f32 = 0.6;

#[derive(Debug, Clone)]
pub struct DehazeParams {
    /// -1..1.
    pub strength: f32,
}

impl DehazeParams {
    pub fn new(dehaze: f64) -> Option<Self> {
        let s = (dehaze / 100.0).clamp(-1.0, 1.0) as f32;
        (s != 0.0).then_some(Self { strength: s })
    }
}

/// `density` holds `D` for each pixel of `row`; `airlight` is `A` in the row's current space.
pub fn dehaze(row: &mut [f32], density: &[f32], airlight: [f32; 3], p: &DehazeParams) {
    let a = airlight;
    if p.strength > 0.0 {
        let omega = OMEGA * p.strength;
        let k = sky_tolerance(a);
        for (px, &d) in row.chunks_exact_mut(3).zip(density) {
            dehaze_remove_px(px, d, a, omega, k);
        }
    } else {
        let s = -p.strength * HAZE_ADD;
        for (px, &d) in row.chunks_exact_mut(3).zip(density) {
            dehaze_add_px(px, d, a, s);
        }
    }
}

/// `K`, the sky-safe tolerance for atmospheric light `a`.
#[inline]
pub fn sky_tolerance(a: [f32; 3]) -> f32 {
    SKY_TOLERANCE * (REC2020_LUMA[0] * a[0] + REC2020_LUMA[1] * a[1] + REC2020_LUMA[2] * a[2])
}

/// Dehaze on one RGB triple at strength −1..1 (0 = untouched), for per-pixel (masked) strengths.
#[inline]
pub fn dehaze_px(px: &mut [f32], d: f32, a: [f32; 3], strength: f32) {
    if strength > 0.0 {
        dehaze_remove_px(px, d, a, OMEGA * strength, sky_tolerance(a));
    } else if strength < 0.0 {
        dehaze_add_px(px, d, a, -strength * HAZE_ADD);
    }
}

/// Positive dehaze on one pixel: `omega = OMEGA · strength`, `k` = [`sky_tolerance`].
#[inline]
pub fn dehaze_remove_px(px: &mut [f32], d: f32, a: [f32; 3], omega: f32, k: f32) {
    let mut t = (1.0 - omega * d).max(T0);
    let diff = (px[0] - a[0]).abs().max((px[1] - a[1]).abs()).max((px[2] - a[2]).abs());
    if diff < k {
        t = (t * k / diff.max(1e-6)).min(1.0);
    }
    let inv = 1.0 / t;
    for c in 0..3 {
        px[c] = ((px[c] - a[c]) * inv + a[c]).max(0.0);
    }
}

/// Negative dehaze (added haze) on one pixel: `s = −strength · HAZE_ADD`.
#[inline]
pub fn dehaze_add_px(px: &mut [f32], d: f32, a: [f32; 3], s: f32) {
    let m = s * (0.3 + 0.7 * d);
    for c in 0..3 {
        px[c] += (a[c] - px[c]) * m;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hazy_pixels_gain_contrast_and_the_airlight_holds() {
        let p = DehazeParams::new(60.0).unwrap();
        let a = [0.9f32, 0.9, 0.9];
        let mut row = [0.5f32, 0.55, 0.6, 0.9, 0.9, 0.9, 0.7, 0.7, 0.7];
        dehaze(&mut row, &[0.5, 0.95, 0.6], a, &p);
        assert!(row[0] < 0.5 && row[2] < 0.6);
        assert!((row[3] - 0.9).abs() < 1e-6);
        let mut row = [0.2f32, 0.2, 0.2];
        dehaze(&mut row, &[0.3], a, &DehazeParams::new(-100.0).unwrap());
        assert!(row[0] > 0.2 && row[0] < 0.9);
    }
}
