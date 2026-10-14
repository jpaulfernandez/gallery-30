//! White balance: temperature and tint → an illuminant chromaticity (Robertson), then a CAT16 von
//! Kries adaptation from that illuminant to the working white, as one 3×3 matrix on linear Rec.2020.
//!
//! Setting a *higher* temperature says the light was bluer, so the image is compensated warmer, as in
//! Lightroom.
//! - `absolute` (RAW-style): source = (Kelvin, tint), destination = D65.
//! - `incremental` (rendered files): the -100..100 sliders shift the illuminant around a 6500 K / 0
//!   reference by [`MIRED_PER_UNIT`] mired and [`TINT_PER_UNIT`] tint units; destination = that same
//!   reference, so 0/0 is exactly a no-op.
//! - `asShot`: no-op.
//!
//! For a RAW ([`ImageMeta`] from the RAW decoder) `absolute` is relative to the as-shot white instead, so the
//! as-shot `(Kelvin, tint)` is a no-op: with the camera's matrices it re-solves the white balance through the
//! camera matrix ([`CameraColor::rebalance_rec2020`](crate::color::camera::CameraColor::rebalance_rec2020)),
//! otherwise it adapts with CAT16 from `(Kelvin, tint)` to the as-shot white.

use crate::color::cat16::adaptation_rec2020;
use crate::color::matrix::{self, apply_f32, xy_to_xyz, Mat3, Mat3f, D65_XY, REC2020_LUMA};
use crate::color::temperature::xy_from_temperature;
use crate::image::ImageMeta;
use crate::settings::WhiteBalance;

/// Reference illuminant of the incremental sliders.
pub const NEUTRAL_KELVIN: f64 = 6500.0;
/// Mired shift per incremental temperature unit (±100 → about 3940 K .. 18600 K).
pub const MIRED_PER_UNIT: f64 = 1.0;
/// Absolute tint units per incremental tint unit.
pub const TINT_PER_UNIT: f64 = 1.0;

#[derive(Debug, Clone)]
pub struct WhiteBalanceParams {
    pub matrix: Mat3f,
    /// Luminance the matrix gives a neutral of luminance 1 (used to rescale the cached base).
    pub grey_gain: f32,
}

impl WhiteBalanceParams {
    pub fn new(wb: &WhiteBalance) -> Option<Self> {
        let (src, dst) = match *wb {
            WhiteBalance::AsShot => return None,
            WhiteBalance::Incremental { temperature, tint } => {
                if temperature == 0.0 && tint == 0.0 {
                    return None;
                }
                let mired = (1.0e6 / NEUTRAL_KELVIN - temperature * MIRED_PER_UNIT).max(10.0);
                (xy_from_temperature(1.0e6 / mired, tint * TINT_PER_UNIT), xy_from_temperature(NEUTRAL_KELVIN, 0.0))
            }
            WhiteBalance::Absolute { temperature, tint } => {
                (xy_from_temperature(temperature.clamp(1000.0, 100_000.0), tint), D65_XY)
            }
        };
        Some(Self::from_matrix(&adaptation_rec2020(xy_to_xyz(src), xy_to_xyz(dst))))
    }

    /// [`new`](Self::new) for an image with source metadata: `absolute` on a RAW is relative to its as-shot white
    /// (see the module notes); everything else is as [`new`](Self::new).
    pub fn for_image(wb: &WhiteBalance, meta: &ImageMeta) -> Option<Self> {
        let WhiteBalance::Absolute { temperature, tint } = *wb else {
            return Self::new(wb);
        };
        let xy = xy_from_temperature(temperature.clamp(1000.0, 100_000.0), tint);
        let m = if let Some(camera) = &meta.camera {
            camera.rebalance_rec2020(xy)
        } else if let Some((kelvin, tint)) = meta.as_shot {
            adaptation_rec2020(xy_to_xyz(xy), xy_to_xyz(xy_from_temperature(kelvin, tint)))
        } else {
            return Self::new(wb);
        };
        Some(Self::from_matrix(&m))
    }

    fn from_matrix(m: &Mat3) -> Self {
        let grey = matrix::apply(m, [1.0, 1.0, 1.0]);
        let grey_gain = (0..3).map(|c| REC2020_LUMA[c] as f64 * grey[c]).sum::<f64>() as f32;
        Self { matrix: matrix::to_f32(m), grey_gain }
    }
}

/// The white balance with local incremental offsets added (a mask's Temperature and Tint, −100..100 units):
/// `incremental` and `asShot` (as incremental 0/0) add them to the sliders, clamped to −100..100; `absolute`
/// shifts the source illuminant by `temperature ·` [`MIRED_PER_UNIT`] mired (Kelvin kept within 1000..100000)
/// and `tint ·` [`TINT_PER_UNIT`] tint units (within −150..150), then [`WhiteBalanceParams::for_image`]. `None`
/// when the result is a no-op.
pub fn with_local_offsets(wb: &WhiteBalance, meta: &ImageMeta, temperature: f64, tint: f64) -> Option<WhiteBalanceParams> {
    let effective = match *wb {
        WhiteBalance::AsShot => WhiteBalance::Incremental {
            temperature: temperature.clamp(-100.0, 100.0),
            tint: tint.clamp(-100.0, 100.0),
        },
        WhiteBalance::Incremental { temperature: t, tint: ti } => WhiteBalance::Incremental {
            temperature: (t + temperature).clamp(-100.0, 100.0),
            tint: (ti + tint).clamp(-100.0, 100.0),
        },
        WhiteBalance::Absolute { temperature: k, tint: ti } => {
            let mired = (1.0e6 / k.clamp(1000.0, 100_000.0) - temperature * MIRED_PER_UNIT).clamp(10.0, 1000.0);
            WhiteBalance::Absolute { temperature: 1.0e6 / mired, tint: (ti + tint * TINT_PER_UNIT).clamp(-150.0, 150.0) }
        }
    };
    WhiteBalanceParams::for_image(&effective, meta)
}

pub fn white_balance(row: &mut [f32], p: &WhiteBalanceParams) {
    for px in row.chunks_exact_mut(3) {
        px.copy_from_slice(&apply_f32(&p.matrix, px[0], px[1], px[2]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wb(temperature: f64, tint: f64) -> WhiteBalanceParams {
        WhiteBalanceParams::new(&WhiteBalance::Incremental { temperature, tint }).unwrap()
    }

    #[test]
    fn defaults_are_skipped() {
        assert!(WhiteBalanceParams::new(&WhiteBalance::AsShot).is_none());
        assert!(WhiteBalanceParams::new(&WhiteBalance::Incremental { temperature: 0.0, tint: 0.0 }).is_none());
    }

    #[test]
    fn warmer_and_magenta() {
        let mut px = [0.2f32, 0.2, 0.2];
        white_balance(&mut px, &wb(50.0, 0.0));
        assert!(px[0] > px[2] * 1.05, "{px:?}");
        let mut px = [0.2f32, 0.2, 0.2];
        white_balance(&mut px, &wb(-50.0, 0.0));
        assert!(px[2] > px[0] * 1.05, "{px:?}");
        let mut px = [0.2f32, 0.2, 0.2];
        white_balance(&mut px, &wb(0.0, 50.0));
        assert!(px[1] < px[0] && px[1] < px[2], "positive tint is magenta: {px:?}");
    }

    #[test]
    fn absolute_is_relative_to_as_shot_on_raw() {
        // Without camera matrices: CAT16 from (K, tint) to the as-shot white.
        let meta = ImageMeta { is_raw: true, as_shot: Some((4200.0, 8.0)), camera: None, noise_sigma: None };
        let p = WhiteBalanceParams::for_image(&WhiteBalance::Absolute { temperature: 4200.0, tint: 8.0 }, &meta).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                assert!((p.matrix[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-5, "{:?}", p.matrix);
            }
        }
        let mut px = [0.2f32, 0.2, 0.2];
        white_balance(&mut px, &WhiteBalanceParams::for_image(&WhiteBalance::Absolute { temperature: 6000.0, tint: 8.0 }, &meta).unwrap());
        assert!(px[0] > px[2] * 1.05, "a higher Kelvin than as-shot warms: {px:?}");
        // Rendered files keep the old meaning.
        let plain = WhiteBalanceParams::for_image(&WhiteBalance::Absolute { temperature: 4200.0, tint: 8.0 }, &ImageMeta::default()).unwrap();
        assert_eq!(plain.matrix, WhiteBalanceParams::new(&WhiteBalance::Absolute { temperature: 4200.0, tint: 8.0 }).unwrap().matrix);
    }

    #[test]
    fn absolute_d65_is_near_identity() {
        let p = WhiteBalanceParams::new(&WhiteBalance::Absolute { temperature: 6504.0, tint: 9.5 }).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                assert!((p.matrix[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 5e-3, "{:?}", p.matrix);
            }
        }
    }
}
