//! Sharpening: a two-scale unsharp mask on `log2 Y` ([`crate::local::prepass::sharpen_planes`]), applied
//! as a luminance gain on RGB.
//!
//! - **Amount** 0..150 scales the gain: `g = amount/100 · SHARPEN_STRENGTH · d · mask`.
//! - **Radius** (reference px, 0.5..3) sets σ of the fine term `log2 Y − G(σ)`; the coarse term uses 2σ.
//! - **Detail** 0..100 mixes them: `d = m·fine + (1 − m)·coarse`, `m = detail/100`. Low values favour the
//!   wider, edge-like term (fewer halos on texture), high values the fine one (crisp texture and noise).
//! - **Masking** 0..100 thresholds the smoothed Sobel magnitude of `G(σ)` (stops per reference pixel):
//!   0 sharpens everywhere; above, the mask is `smoothstep(0.5·T, 1.5·T, edge)` with
//!   `T = masking/100 · MASK_EDGE_MAX`, so at 100 only strong edges are sharpened.
//! - **Halo limiter**: `g` is soft-clipped to ±[`HALO_LIMIT`] stops by `tanh`.
//!
//! [`mask_visualisation`] returns the mask plane for the UI's Alt-drag view.

use super::smoothstep;
use crate::settings::Sharpen;

/// Gain on the detail at amount 100.
pub const SHARPEN_STRENGTH: f32 = 1.0;
/// Soft limit on the sharpening gain, stops.
pub const HALO_LIMIT: f32 = 0.35;
/// Edge threshold at masking 100, stops per reference pixel.
pub const MASK_EDGE_MAX: f32 = 0.2;

#[derive(Debug, Clone)]
pub struct SharpenParams {
    /// Gain on the detail (amount/100 · strength).
    pub amount: f32,
    /// The radius slider value (reference px): the key of the cached planes.
    pub radius: f32,
    /// Fine/coarse mix, 0..1.
    pub detail: f32,
    /// 0..1.
    pub masking: f32,
}

impl SharpenParams {
    /// `None` at amount 0. (Whether the default 40 applies at all is decided by
    /// [`super::detail::DetailParams`].)
    pub fn new(s: &Sharpen) -> Option<Self> {
        let amount = (s.amount / 100.0).clamp(0.0, 1.5) as f32 * SHARPEN_STRENGTH;
        (amount > 0.0).then(|| Self {
            amount,
            radius: s.radius.clamp(0.5, 3.0) as f32,
            detail: (s.detail / 100.0).clamp(0.0, 1.0) as f32,
            masking: (s.masking / 100.0).clamp(0.0, 1.0) as f32,
        })
    }
}

/// The edge mask value for an edge strength and masking 0..1.
#[inline]
pub fn mask_value(edge: f32, masking: f32) -> f32 {
    if masking <= 0.0 {
        return 1.0;
    }
    let t = masking * MASK_EDGE_MAX;
    smoothstep(0.5 * t, 1.5 * t, edge)
}

/// The sharpening mask (0 = not sharpened, 1 = fully) for the edge plane of
/// [`crate::local::SharpenPlanes`] and the Masking slider (0..100): what Alt-drag on Masking shows,
/// white where sharpening applies.
pub fn mask_visualisation(edges: &[f32], masking: f64) -> Vec<f32> {
    let m = (masking / 100.0).clamp(0.0, 1.0) as f32;
    edges.iter().map(|&e| mask_value(e, m)).collect()
}

/// `fine`, `coarse` and `edges` hold one value per pixel of `row`.
pub fn sharpen(row: &mut [f32], fine: &[f32], coarse: &[f32], edges: &[f32], p: &SharpenParams) {
    for (((px, &f), &c), &e) in row.chunks_exact_mut(3).zip(fine).zip(coarse).zip(edges) {
        sharpen_px(px, f, c, e, p.amount, p.detail, p.masking);
    }
}

/// Sharpening on one RGB triple: `amount` is the gain (amount/100 · strength), `detail` and `masking` 0..1.
#[inline]
pub fn sharpen_px(px: &mut [f32], f: f32, c: f32, e: f32, amount: f32, detail: f32, masking: f32) {
    let mask = mask_value(e, masking);
    if mask == 0.0 {
        return;
    }
    let d = detail * f + (1.0 - detail) * c;
    let g = (HALO_LIMIT * (amount * d * mask / HALO_LIMIT).tanh()).exp2();
    px[0] *= g;
    px[1] *= g;
    px[2] *= g;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_and_limiter() {
        assert_eq!(mask_value(0.0, 0.0), 1.0);
        assert_eq!(mask_value(0.01, 1.0), 0.0);
        assert_eq!(mask_value(1.0, 1.0), 1.0);
        let p = SharpenParams::new(&Sharpen { amount: 150.0, ..Sharpen::default() }).unwrap();
        let mut row = [0.2f32; 3];
        sharpen(&mut row, &[10.0], &[10.0], &[1.0], &p);
        assert!(row[0] <= 0.2 * HALO_LIMIT.exp2() + 1e-6);
        assert!(SharpenParams::new(&Sharpen { amount: 0.0, ..Sharpen::default() }).is_none());
    }
}
