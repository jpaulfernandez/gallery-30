//! Camera colour for RAW input (D6.1), in the DNG SDK's model without camera profiles:
//!
//! - A camera has one or two *colour matrices* (DNG `ColorMatrix1/2`: XYZ → camera RGB), each calibrated under an
//!   illuminant with a known correlated colour temperature. For a given white they are interpolated linearly in
//!   inverse temperature (mired) and clamped to the two calibration temperatures (`dng_color_spec::FindXYZtoCamera`).
//! - The *camera neutral* of a white (what a grey looks like to the sensor under that light, max channel = 1) is
//!   `ColorMatrix(white) · XYZ(white)`. The inverse, neutral → white chromaticity, is the fixed-point iteration
//!   `dng_color_spec::NeutralToXY` (the matrix depends on the white it is solving for).
//! - Camera → linear Rec.2020 (D65) for a white `w`: `XYZ→Rec2020 · CAT16(w → D65) · ColorMatrix(w)⁻¹`, scaled so the
//!   neutral of `w` lands on `Y = 1`. A neutral that just saturates the brightest raw channel is therefore diffuse
//!   white (DNG's normalisation, before `BaselineExposure`). The DNG SDK adapts with Bradford; this crate uses CAT16
//!   everywhere so the decode and the white balance op agree exactly.
//!
//! White balance is solved *through the matrix*: changing the white changes the neutral (the per-channel multipliers),
//! the interpolated matrix and the adaptation together, so a re-balanced RAW matches a decode with those multipliers.

use super::cat16::adaptation;
use super::matrix::{self, xy_to_xyz, xyz_to_xy, Mat3, D50_XY, D65_XY};
use super::temperature::temperature_from_xy;

/// One calibrated colour matrix.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraMatrix {
    /// Correlated colour temperature of the calibration illuminant, Kelvin.
    pub temperature: f64,
    /// XYZ → camera RGB (DNG `ColorMatrixN`, row-major).
    pub xyz_to_camera: Mat3,
}

/// What white balance and colour conversion of a RAW need: the colour matrices and the as-shot neutral.
#[derive(Debug, Clone, PartialEq)]
pub struct CameraColor {
    /// One or two matrices, sorted by temperature (lowest first).
    pub matrices: Vec<CameraMatrix>,
    /// The as-shot camera neutral (DNG `AsShotNeutral`, the inverse of the camera's WB multipliers), max channel 1.
    pub as_shot_neutral: [f64; 3],
}

/// Correlated colour temperature of an EXIF/DNG `LightSource` / `CalibrationIlluminant` code, as the DNG SDK
/// assigns them (`dng_illuminant` → temperature). `None` for "unknown", "other" and unassigned codes.
pub fn illuminant_temperature(light_source: u16) -> Option<f64> {
    Some(match light_source {
        17 | 3 => 2850.0,                         // standard light A, tungsten
        24 => 3200.0,                             // ISO studio tungsten
        23 => 5000.0,                             // D50
        20 | 1 | 9 | 4 | 18 => 5500.0,           // D55, daylight, fine weather, flash, standard light B
        21 | 19 | 10 => 6500.0,                   // D65, standard light C, cloudy
        22 | 11 => 7500.0,                        // D75, shade
        12 => (5700.0 + 7100.0) * 0.5,            // daylight fluorescent
        13 => (4600.0 + 5500.0) * 0.5,            // day white fluorescent
        14 | 2 => (3800.0 + 4500.0) * 0.5,        // cool white fluorescent, fluorescent
        15 => (3250.0 + 3800.0) * 0.5,            // white fluorescent
        16 => (2600.0 + 3250.0) * 0.5,            // warm white fluorescent
        _ => return None,
    })
}

fn normalize_max(v: [f64; 3]) -> Option<[f64; 3]> {
    let max = v[0].max(v[1]).max(v[2]);
    (max.is_finite() && max > 0.0 && v.iter().all(|c| c.is_finite() && *c > 0.0)).then(|| v.map(|c| c / max))
}

fn lerp(a: &Mat3, b: &Mat3, g: f64) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = g * a[i][j] + (1.0 - g) * b[i][j];
        }
    }
    out
}

fn scale(m: &Mat3, s: f64) -> Mat3 {
    m.map(|row| row.map(|v| v * s))
}

impl CameraColor {
    /// From the file's matrices (any order; with more than two, the lowest and highest temperatures are kept) and
    /// its as-shot neutral (`None` or invalid: the neutral of D65, i.e. a daylight balance). `None` without a
    /// usable matrix.
    pub fn new(mut matrices: Vec<CameraMatrix>, as_shot_neutral: Option<[f64; 3]>) -> Option<Self> {
        matrices.retain(|m| m.temperature.is_finite() && m.temperature > 0.0 && m.xyz_to_camera.iter().flatten().all(|v| v.is_finite()));
        matrices.sort_by(|a, b| a.temperature.total_cmp(&b.temperature));
        if matrices.len() > 2 {
            let last = matrices.pop().expect("more than two");
            matrices.truncate(1);
            matrices.push(last);
        }
        if matrices.is_empty() {
            return None;
        }
        let mut color = Self { matrices, as_shot_neutral: [1.0; 3] };
        color.as_shot_neutral = as_shot_neutral.and_then(normalize_max).unwrap_or_else(|| color.xy_to_neutral(D65_XY));
        Some(color)
    }

    /// The XYZ → camera matrix for a white of chromaticity `xy`.
    pub fn matrix_for_xy(&self, xy: [f64; 2]) -> Mat3 {
        match self.matrices.as_slice() {
            [only] => only.xyz_to_camera,
            [low, high, ..] => {
                let (t1, t2) = (low.temperature, high.temperature);
                if (t1 - t2).abs() < 1e-6 {
                    return low.xyz_to_camera;
                }
                let t = temperature_from_xy(xy).0;
                let g = if t <= t1 {
                    1.0
                } else if t >= t2 {
                    0.0
                } else {
                    (1.0 / t - 1.0 / t2) / (1.0 / t1 - 1.0 / t2)
                };
                lerp(&low.xyz_to_camera, &high.xyz_to_camera, g)
            }
            [] => matrix::IDENTITY,
        }
    }

    /// The camera neutral (max channel 1) of a white of chromaticity `xy`.
    pub fn xy_to_neutral(&self, xy: [f64; 2]) -> [f64; 3] {
        let n = matrix::apply(&self.matrix_for_xy(xy), xy_to_xyz(xy));
        normalize_max(n).unwrap_or([1.0; 3])
    }

    /// The white chromaticity whose camera neutral is `neutral` (DNG SDK `NeutralToXY`). D65 when the neutral does
    /// not map to a physical white.
    pub fn neutral_to_xy(&self, neutral: [f64; 3]) -> [f64; 2] {
        const PASSES: usize = 30;
        let mut last = D50_XY;
        for pass in 0..PASSES {
            let xyz = matrix::apply(&matrix::inv(&self.matrix_for_xy(last)), neutral);
            let sum = xyz[0] + xyz[1] + xyz[2];
            if !(sum.is_finite() && sum > 0.0 && xyz[1] > 0.0) {
                return D65_XY;
            }
            let mut next = xyz_to_xy(xyz);
            if (next[0] - last[0]).abs() + (next[1] - last[1]).abs() < 1e-7 {
                return next;
            }
            // Not converging (an oscillation between the two matrices): settle between the last two guesses.
            if pass == PASSES - 1 {
                next = [(last[0] + next[0]) * 0.5, (last[1] + next[1]) * 0.5];
            }
            last = next;
        }
        last
    }

    /// Chromaticity of the as-shot white.
    pub fn as_shot_xy(&self) -> [f64; 2] {
        self.neutral_to_xy(self.as_shot_neutral)
    }

    /// `(Kelvin, tint)` of the as-shot white (Robertson, Lightroom's tint scale).
    pub fn as_shot_temperature(&self) -> (f64, f64) {
        temperature_from_xy(self.as_shot_xy())
    }

    /// Camera RGB → XYZ for the white `xy` whose neutral is `neutral`: the inverse colour matrix, scaled so
    /// `neutral` maps to `Y = 1`.
    fn camera_to_xyz(&self, xy: [f64; 2], neutral: [f64; 3]) -> Mat3 {
        let m = matrix::inv(&self.matrix_for_xy(xy));
        let y = matrix::apply(&m, neutral)[1];
        if y.is_finite() && y > 0.0 {
            scale(&m, 1.0 / y)
        } else {
            m
        }
    }

    /// Camera RGB (black-subtracted, white-level normalised, *not* white balanced) → linear Rec.2020 (D65), for a
    /// scene lit by the white `xy` whose camera neutral is `neutral`.
    pub fn camera_to_rec2020(&self, xy: [f64; 2], neutral: [f64; 3]) -> Mat3 {
        let cat = adaptation(xy_to_xyz(xy), xy_to_xyz(D65_XY));
        matrix::mul(&matrix::xyz_to_rec2020(), &matrix::mul(&cat, &self.camera_to_xyz(xy, neutral)))
    }

    /// The decode matrix at the as-shot white, applied to **white-balanced** camera RGB (the raw values multiplied
    /// by `1 / as_shot_neutral`): WB-balanced `(1, 1, 1)` → Rec.2020 `(1, 1, 1)`.
    pub fn balanced_to_rec2020(&self) -> Mat3 {
        let n = self.as_shot_neutral;
        matrix::mul(&self.camera_to_rec2020(self.as_shot_xy(), n), &matrix::diag(n))
    }

    /// The Rec.2020 → Rec.2020 matrix that re-balances an image decoded at the as-shot white to the white `xy`
    /// (`camera_to_rec2020(xy) · camera_to_rec2020(as shot)⁻¹`). Identity at the as-shot white.
    pub fn rebalance_rec2020(&self, xy: [f64; 2]) -> Mat3 {
        let shot = self.camera_to_rec2020(self.as_shot_xy(), self.as_shot_neutral);
        let new = self.camera_to_rec2020(xy, self.xy_to_neutral(xy));
        matrix::mul(&new, &matrix::inv(&shot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::temperature::xy_from_temperature;

    /// A plausible camera: XYZ → camera with crosstalk, different under A and D65 (numbers of the shape Adobe
    /// publishes for a Bayer body).
    fn camera() -> CameraColor {
        let d65 = [[0.6722, -0.0635, -0.0963], [-0.4287, 1.2460, 0.2028], [-0.0908, 0.2162, 0.5668]];
        let a = [[0.7000, -0.1600, -0.0300], [-0.3900, 1.1200, 0.3000], [-0.0500, 0.1200, 0.7000]];
        CameraColor::new(
            vec![CameraMatrix { temperature: 6500.0, xyz_to_camera: d65 }, CameraMatrix { temperature: 2850.0, xyz_to_camera: a }],
            Some([0.45, 1.0, 0.70]),
        )
        .unwrap()
    }

    #[test]
    fn neutral_round_trips_through_xy() {
        let cam = camera();
        assert_eq!(cam.matrices[0].temperature, 2850.0);
        for (k, t) in [(2850.0, 0.0), (3200.0, 5.0), (4500.0, -10.0), (5500.0, 0.0), (7500.0, 20.0)] {
            let xy = xy_from_temperature(k, t);
            let back = cam.neutral_to_xy(cam.xy_to_neutral(xy));
            assert!((back[0] - xy[0]).abs() < 1e-6 && (back[1] - xy[1]).abs() < 1e-6, "{k}: {xy:?} vs {back:?}");
        }
    }

    #[test]
    fn white_maps_to_white() {
        let cam = camera();
        let out = matrix::apply(&cam.balanced_to_rec2020(), [1.0, 1.0, 1.0]);
        for c in out {
            assert!((c - 1.0).abs() < 1e-6, "{out:?}");
        }
        // The as-shot neutral itself, unbalanced, through camera_to_rec2020.
        let out = matrix::apply(&cam.camera_to_rec2020(cam.as_shot_xy(), cam.as_shot_neutral), cam.as_shot_neutral);
        for c in out {
            assert!((c - 1.0).abs() < 1e-6, "{out:?}");
        }
    }

    #[test]
    fn rebalance_at_as_shot_is_identity() {
        let cam = camera();
        let m = cam.rebalance_rec2020(cam.as_shot_xy());
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-6, "{m:?}");
            }
        }
        // And through (Kelvin, tint), as the UI sends it.
        let (k, t) = cam.as_shot_temperature();
        let m = cam.rebalance_rec2020(xy_from_temperature(k, t));
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 2e-3, "{m:?}");
            }
        }
    }

    #[test]
    fn single_matrix_and_default_neutral() {
        let d65 = camera().matrices[1].xyz_to_camera;
        let cam = CameraColor::new(vec![CameraMatrix { temperature: 6500.0, xyz_to_camera: d65 }], None).unwrap();
        let xy = cam.as_shot_xy();
        assert!((xy[0] - D65_XY[0]).abs() < 1e-9 && (xy[1] - D65_XY[1]).abs() < 1e-9, "{xy:?}");
        assert!(CameraColor::new(vec![], None).is_none());
    }

    #[test]
    fn light_sources() {
        assert_eq!(illuminant_temperature(21), Some(6500.0));
        assert_eq!(illuminant_temperature(17), Some(2850.0));
        assert_eq!(illuminant_temperature(0), None);
    }
}
