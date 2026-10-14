//! Texture: the mid-frequency band `G(1.5) − G(6)` (reference px) of `log2 Y`
//! ([`crate::local::prepass::texture_band`]), between sharpening and clarity, applied as a luminance
//! gain `2^(k · b · gate(t))`. Positive values shape the band with the halo shaper (so edges, whose band
//! is large, are barely touched); negative values subtract it, smoothing skin and foliage.

use super::detail::{detail_gate, halo_shape};
use crate::color::matrix::REC2020_LUMA;
use crate::local::lightness;

/// Gain on the shaped band at +100 (the band roughly doubles).
pub const TEXTURE_STRENGTH: f32 = 1.2;
/// Fraction of the band removed at −100.
pub const SMOOTH_STRENGTH: f32 = 0.8;
/// `s` of the halo shaper, in stops.
pub const TEXTURE_HALO_SCALE: f32 = 0.3;

#[derive(Debug, Clone)]
pub struct TextureParams {
    pub k: f32,
}

impl TextureParams {
    pub fn new(texture: f64) -> Option<Self> {
        let c = (texture / 100.0).clamp(-1.0, 1.0) as f32;
        Self::from_unit(c)
    }

    /// From the slider as a unit value (−1..1, already clamped); `None` at 0. For per-pixel (masked) values.
    pub fn from_unit(c: f32) -> Option<Self> {
        (c != 0.0).then(|| Self { k: if c > 0.0 { c * TEXTURE_STRENGTH } else { c * SMOOTH_STRENGTH } })
    }
}

pub fn texture(row: &mut [f32], band: &[f32], p: &TextureParams) {
    for (px, &b) in row.chunks_exact_mut(3).zip(band) {
        texture_px(px, b, p.k);
    }
}

/// Texture on one RGB triple with band value `b` and signed strength `k`.
#[inline]
pub fn texture_px(px: &mut [f32], b: f32, k: f32) {
    let y = REC2020_LUMA[0] * px[0] + REC2020_LUMA[1] * px[1] + REC2020_LUMA[2] * px[2];
    if y <= 0.0 {
        return;
    }
    let w = detail_gate(lightness(y));
    if w == 0.0 {
        return;
    }
    let shaped = if k > 0.0 { halo_shape(b, TEXTURE_HALO_SCALE) } else { b };
    let g = (k * shaped * w).exp2();
    px[0] *= g;
    px[1] *= g;
    px[2] *= g;
}
