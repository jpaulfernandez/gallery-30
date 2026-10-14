//! Clarity: local contrast on the clarity detail `d = log2 Y − GF(log2 Y)` (the guided-filter base from
//! [`crate::local::prepass::clarity_detail`]), applied as a luminance gain on RGB so hue stays put.
//!
//! Positive: `gain = 2^(k · halo_shape(d) · w(t))`, the halo shaper taming large deviations next to
//! strong edges (which the guided base mostly keeps anyway), `w` the midtone weight times the noise-floor
//! and near-white gate on the current lightness. Negative: `gain = 2^(k · d · w(t))`, pulling each pixel
//! toward its edge-preserving base (k = −0.7 at −100: softening, not flattening).

use super::detail::{detail_gate, halo_shape, midtone_weight};
use crate::color::matrix::REC2020_LUMA;
use crate::local::lightness;

/// Gain on the shaped detail at +100.
pub const CLARITY_STRENGTH: f32 = 1.6;
/// Fraction of the detail removed at −100.
pub const SOFTEN_STRENGTH: f32 = 0.7;
/// `s` of the halo shaper, in stops.
pub const HALO_SCALE: f32 = 0.5;

#[derive(Debug, Clone)]
pub struct ClarityParams {
    /// Signed strength.
    pub k: f32,
}

impl ClarityParams {
    pub fn new(clarity: f64) -> Option<Self> {
        let c = (clarity / 100.0).clamp(-1.0, 1.0) as f32;
        Self::from_unit(c)
    }

    /// From the slider as a unit value (−1..1, already clamped); `None` at 0. For per-pixel (masked) values.
    pub fn from_unit(c: f32) -> Option<Self> {
        (c != 0.0).then(|| Self { k: if c > 0.0 { c * CLARITY_STRENGTH } else { c * SOFTEN_STRENGTH } })
    }
}

/// `detail` holds one value per pixel of `row`.
pub fn clarity(row: &mut [f32], detail: &[f32], p: &ClarityParams) {
    for (px, &d) in row.chunks_exact_mut(3).zip(detail) {
        clarity_px(px, d, p.k);
    }
}

/// Clarity on one RGB triple with detail `d` and signed strength `k`.
#[inline]
pub fn clarity_px(px: &mut [f32], d: f32, k: f32) {
    let y = REC2020_LUMA[0] * px[0] + REC2020_LUMA[1] * px[1] + REC2020_LUMA[2] * px[2];
    if y <= 0.0 {
        return;
    }
    let t = lightness(y);
    let w = midtone_weight(t) * detail_gate(t);
    if w == 0.0 {
        return;
    }
    let shaped = if k > 0.0 { halo_shape(d, HALO_SCALE) } else { d };
    let g = (k * shaped * w).exp2();
    px[0] *= g;
    px[1] *= g;
    px[2] *= g;
}
