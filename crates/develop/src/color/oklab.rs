//! Oklab and OKLCH (Björn Ottosson, 2020), reached from linear Rec.2020 through XYZ with Ottosson's
//! published XYZ → LMS (M1) and LMS' → Lab (M2) matrices.

use super::matrix::{self, apply_f32, Mat3, Mat3f};

/// XYZ (D65) → LMS.
pub const M1: Mat3 = [
    [0.8189330101, 0.3618667424, -0.1288597137],
    [0.0329845436, 0.9293118715, 0.0361456387],
    [0.0482003018, 0.2643662691, 0.6338517070],
];
/// Cube-rooted LMS → Lab.
pub const M2: Mat3 = [
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
];

/// XYZ → Oklab, in `f64` (for tests and table building).
pub fn xyz_to_oklab(xyz: [f64; 3]) -> [f64; 3] {
    let lms = matrix::apply(&M1, xyz).map(f64::cbrt);
    matrix::apply(&M2, lms)
}

pub fn oklab_to_xyz(lab: [f64; 3]) -> [f64; 3] {
    let lms = matrix::apply(&matrix::inv(&M2), lab).map(|v| v * v * v);
    matrix::apply(&matrix::inv(&M1), lms)
}

/// `[L, a, b]` → `[L, C, h]` with `h` in degrees, 0..360.
pub fn oklab_to_oklch([l, a, b]: [f32; 3]) -> [f32; 3] {
    let h = b.atan2(a).to_degrees();
    [l, a.hypot(b), if h < 0.0 { h + 360.0 } else { h }]
}

pub fn oklch_to_oklab([l, c, h]: [f32; 3]) -> [f32; 3] {
    let (s, co) = h.to_radians().sin_cos();
    [l, c * co, c * s]
}

/// Precomputed `f32` matrices for a linear RGB space ↔ Oklab, the per-pixel path. [`Oklab::new`] is
/// for the linear Rec.2020 working space.
#[derive(Debug, Clone)]
pub struct Oklab {
    to_lms: Mat3f,
    from_lms: Mat3f,
    m2: Mat3f,
    m2_inv: Mat3f,
}

impl Default for Oklab {
    fn default() -> Self {
        Self::new()
    }
}

impl Oklab {
    /// The four `f32` matrices (RGB → LMS, LMS → RGB, M2, M2⁻¹), for shaders that mirror [`Self::to_lab`] and
    /// [`Self::to_rgb`] (workflow plan 24's `gpu::noise`).
    pub fn matrices(&self) -> [Mat3f; 4] {
        [self.to_lms, self.from_lms, self.m2, self.m2_inv]
    }

    /// Linear Rec.2020 ↔ Oklab.
    pub fn new() -> Self {
        Self::for_space(&matrix::rec2020_to_xyz())
    }

    /// Linear RGB with the given RGB → XYZ (D65) matrix ↔ Oklab. The LMS rows are renormalised so the
    /// space's white maps to LMS (1, 1, 1) exactly (M1 assumes a D65 white that differs from the
    /// xy-derived one in the fifth decimal), which keeps greys at a = b = 0 and makes a chroma of 0 an
    /// exact neutral.
    pub fn for_space(rgb_to_xyz: &Mat3) -> Self {
        let mut to_lms = matrix::mul(&M1, rgb_to_xyz);
        for row in &mut to_lms {
            let sum: f64 = row.iter().sum();
            for v in row.iter_mut() {
                *v /= sum;
            }
        }
        Self {
            to_lms: matrix::to_f32(&to_lms),
            from_lms: matrix::to_f32(&matrix::inv(&to_lms)),
            m2: matrix::to_f32(&M2),
            m2_inv: matrix::to_f32(&matrix::inv(&M2)),
        }
    }

    #[inline]
    pub fn to_lab(&self, [r, g, b]: [f32; 3]) -> [f32; 3] {
        let [l, m, s] = apply_f32(&self.to_lms, r, g, b);
        apply_f32(&self.m2, l.cbrt(), m.cbrt(), s.cbrt())
    }

    #[inline]
    pub fn to_rgb(&self, [l, a, b]: [f32; 3]) -> [f32; 3] {
        let [l_, m_, s_] = apply_f32(&self.m2_inv, l, a, b);
        apply_f32(&self.from_lms, l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f64; 3], b: [f64; 3], tol: f64) {
        for i in 0..3 {
            assert!((a[i] - b[i]).abs() < tol, "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn ottosson_test_vectors() {
        // From "A perceptual color space for image processing" (2020), table of XYZ → Oklab.
        close(xyz_to_oklab([0.950, 1.000, 1.089]), [1.000, 0.000, 0.000], 1e-3);
        close(xyz_to_oklab([1.000, 0.000, 0.000]), [0.450, 1.236, -0.019], 1e-3);
        close(xyz_to_oklab([0.000, 1.000, 0.000]), [0.922, -0.671, 0.263], 1e-3);
        close(xyz_to_oklab([0.000, 0.000, 1.000]), [0.153, -1.415, -0.449], 1e-3);
        close(oklab_to_xyz(xyz_to_oklab([0.3, 0.4, 0.5])), [0.3, 0.4, 0.5], 1e-9);
    }

    #[test]
    fn srgb_white_is_l1() {
        let ok = Oklab::new();
        // sRGB white is Rec.2020 (1, 1, 1).
        assert!(Oklab::for_space(&matrix::srgb_to_xyz()).to_lab([1.0, 1.0, 1.0])[0] > 0.999);
        let [l, a, b] = ok.to_lab([1.0, 1.0, 1.0]);
        assert!((l - 1.0).abs() < 1e-3 && a.abs() < 1e-3 && b.abs() < 1e-3, "{l} {a} {b}");
        let back = ok.to_rgb(ok.to_lab([0.2, 0.5, 0.05]));
        for (x, y) in back.iter().zip([0.2, 0.5, 0.05]) {
            assert!((x - y).abs() < 1e-5, "{back:?}");
        }
    }

    #[test]
    fn oklch_of_srgb_primaries() {
        // Published OKLCH hues: sRGB red ≈ 29.2°, green ≈ 142.5°, blue ≈ 264.1°.
        let ok = Oklab::new();
        let m = matrix::to_f32(&matrix::srgb_to_rec2020());
        for (rgb, hue) in [([1.0, 0.0, 0.0], 29.23), ([0.0, 1.0, 0.0], 142.5), ([0.0, 0.0, 1.0], 264.05)] {
            let rec = apply_f32(&m, rgb[0], rgb[1], rgb[2]);
            let [_, _, h] = oklab_to_oklch(ok.to_lab(rec));
            assert!((h - hue).abs() < 0.3, "{rgb:?}: {h}");
        }
    }
}
