//! Output encoding: linear Rec.2020 → linear output RGB (matrix: sRGB or Display P3, [`OutputProfile`]), gamut
//! mapping by chroma reduction in Oklab, the sRGB transfer function (Display P3 uses it too), the tone curves,
//! ordered dither and 8-bit quantisation.
//!
//! Gamut mapping keeps Oklab `L` and hue and scales chroma down (bisection) until every channel is in
//! 0..1; `L ≥ 1` becomes white and `L ≤ 0` black. Pixels already in gamut (within 1e-4) pass through
//! untouched, so an unedited sRGB image round-trips exactly.
//!
//! The dither is deterministic (a hash of x, y and channel) so a render is reproducible and its hash
//! stable; it is scaled to 0.98 LSB so values that are already exact 8-bit levels never move.

use crate::color::matrix::{self, apply_f32, Mat3f};
use crate::color::oklab::Oklab;
use crate::color::output::OutputProfile;
use crate::color::transfer::{linear_to_srgb, srgb_to_linear};
use crate::ops::curves::CurveParams;
use crate::ops::effects::DisplayEffects;
use crate::ops::grading::grade;
use crate::ops::lut::LutParams;

pub(crate) const GAMUT_EPS: f32 = 1e-4;
pub(crate) const GAMUT_STEPS: usize = 12;

#[derive(Debug, Clone)]
pub struct OutputParams {
    /// The output space; the GPU builds its gamut mapper's matrices from it.
    pub(crate) profile: OutputProfile,
    /// Linear Rec.2020 → linear output RGB.
    pub(crate) to_output: Mat3f,
    oklab: Oklab,
    pub curves: Option<CurveParams>,
    /// The look's 3D LUT (workflow plan 18), after the curves; set by `cpu::Params::for_image`.
    pub lut: Option<LutParams>,
}

impl OutputParams {
    /// sRGB output.
    pub fn new(curves: Option<CurveParams>) -> Self {
        Self::for_profile(OutputProfile::Srgb, curves)
    }

    pub fn for_profile(profile: OutputProfile, curves: Option<CurveParams>) -> Self {
        Self {
            profile,
            to_output: matrix::to_f32(&profile.from_rec2020()),
            oklab: Oklab::for_space(&profile.to_xyz()),
            curves,
            lut: None,
        }
    }

    /// These parameters with the look's LUT (plan 18).
    pub fn with_lut(self, lut: Option<LutParams>) -> Self {
        Self { lut, ..self }
    }

    pub fn profile(&self) -> OutputProfile {
        self.profile
    }
}

#[inline]
fn in_gamut(rgb: &[f32; 3]) -> bool {
    rgb.iter().all(|&v| (-GAMUT_EPS..=1.0 + GAMUT_EPS).contains(&v))
}

/// Bring a linear RGB triple into 0..1 by reducing Oklab chroma at constant `L` and hue. `oklab` must be
/// the converter for the same RGB space.
pub fn gamut_map(rgb: [f32; 3], oklab: &Oklab) -> [f32; 3] {
    if in_gamut(&rgb) {
        return rgb.map(|v| v.clamp(0.0, 1.0));
    }
    let [l, a, b] = oklab.to_lab(rgb);
    if !(l < 1.0) {
        return [1.0; 3];
    }
    if !(l > 0.0) {
        return [0.0; 3];
    }
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..GAMUT_STEPS {
        let mid = 0.5 * (lo + hi);
        if in_gamut(&oklab.to_rgb([l, a * mid, b * mid])) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    oklab.to_rgb([l, a * lo, b * lo]).map(|v| v.clamp(0.0, 1.0))
}

/// Uniform noise in -0.5..0.5 from a pixel position and channel.
#[inline]
fn dither(x: u32, y: u32, c: u32) -> f32 {
    let mut h = x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ c.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    (h >> 8) as f32 / (1u32 << 24) as f32 - 0.5
}

/// An output sample: an encoded value (0..1, sRGB transfer) quantised at pixel `x, y`, channel `c`.
pub trait OutputSample: Copy + Default + Send + Sync + 'static {
    fn quantise(encoded: f32, x: u32, y: u32, c: u32) -> Self;
}

impl OutputSample for u8 {
    /// With the deterministic 0.98 LSB dither.
    #[inline]
    fn quantise(encoded: f32, x: u32, y: u32, c: u32) -> u8 {
        let v = encoded * 255.0 + 0.5 + 0.98 * dither(x, y, c);
        v.clamp(0.0, 255.0) as u8
    }
}

impl OutputSample for u16 {
    /// Rounded, no dither (16 bits leave no banding to hide; workflow plan 12's TIFF and HEIC export).
    #[inline]
    fn quantise(encoded: f32, _x: u32, _y: u32, _c: u32) -> u16 {
        (encoded * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16
    }
}

/// Encode one row of linear Rec.2020 (row index `y`) into 8-bit output RGB (sRGB or Display P3).
pub fn encode_row(row: &[f32], y: u32, out: &mut [u8], p: &OutputParams) {
    encode_row_with(row, y, out, p, None);
}

/// [`encode_row`] with the look's LUT (plan 18, [`OutputParams::lut`]) and the display-referred effects (workflow
/// plan 17) after the curves: colour grading (an Oklab
/// round trip through linear output RGB, gamut mapped again) and grain, before the dither.
/// Generic over the output sample ([`OutputSample`]): 8-bit (dithered) for every render, 16-bit for the export's
/// TIFF and HEIC (workflow plan 12); the values before quantisation are the same.
pub fn encode_row_with<T: OutputSample>(row: &[f32], y: u32, out: &mut [T], p: &OutputParams, fx: Option<&DisplayEffects<'_>>) {
    for (x, (px, o)) in row.chunks_exact(3).zip(out.chunks_exact_mut(3)).enumerate() {
        let lin = gamut_map(apply_f32(&p.to_output, px[0], px[1], px[2]), &p.oklab);
        let mut enc = lin.map(linear_to_srgb);
        if let Some(curves) = &p.curves {
            enc = curves.apply(enc);
        }
        if let Some(lut) = &p.lut {
            enc = lut.apply(enc);
        }
        if let Some(fx) = fx {
            if let Some(g) = fx.grading {
                let graded = grade(enc.map(srgb_to_linear), &p.oklab, g);
                enc = gamut_map(graded, &p.oklab).map(linear_to_srgb);
            }
            if let Some((grain, scale)) = fx.grain {
                grain.apply(&mut enc, x as u32, y, scale);
            }
        }
        for c in 0..3 {
            o[c] = T::quantise(enc[c], x as u32, y, c as u32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamut_map_keeps_in_gamut_and_reduces_chroma() {
        let ok = Oklab::for_space(&matrix::srgb_to_xyz());
        assert_eq!(gamut_map([0.2, 0.5, 0.9], &ok), [0.2, 0.5, 0.9]);
        let mapped = gamut_map([1.2, -0.1, 0.05], &ok);
        assert!(mapped.iter().all(|v| (0.0..=1.0).contains(v)), "{mapped:?}");
        let (l0, l1) = (ok.to_lab([1.2, -0.1, 0.05])[0], ok.to_lab(mapped)[0]);
        assert!((l0 - l1).abs() < 0.01, "L {l0} vs {l1}");
        assert!(mapped[0] > mapped[1] && mapped[0] > mapped[2], "still red: {mapped:?}");
        assert_eq!(gamut_map([3.0, 3.0, 2.0], &ok), [1.0; 3]);
    }

    #[test]
    fn exact_levels_survive_dither() {
        let p = OutputParams::new(None);
        let m = matrix::to_f32(&matrix::srgb_to_rec2020());
        let lut = crate::color::transfer::srgb_u8_lut();
        let row: Vec<f32> = (0..=255usize).flat_map(|v| apply_f32(&m, lut[v], lut[v], lut[255 - v])).collect();
        let mut out = vec![0u8; 256 * 3];
        for y in 0..16 {
            encode_row(&row, y, &mut out, &p);
            for v in 0..=255usize {
                assert_eq!(out[v * 3..v * 3 + 3], [v as u8, v as u8, 255 - v as u8]);
            }
        }
    }

    #[test]
    fn dither_is_uniform_ish() {
        let mean: f32 = (0..10_000).map(|i| dither(i % 100, i / 100, 0)).sum::<f32>() / 10_000.0;
        assert!(mean.abs() < 0.02);
    }
}
