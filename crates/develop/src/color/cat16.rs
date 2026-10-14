//! CAT16 chromatic adaptation (Li et al. 2017, the CAM16 transform) as a von Kries scaling in its LMS
//! space, with complete adaptation (D = 1).

use super::matrix::{self, Mat3};

/// XYZ → CAT16 LMS.
pub const M16: Mat3 = [
    [0.401288, 0.650173, -0.051461],
    [-0.250268, 1.204414, 0.045854],
    [-0.002079, 0.048952, 0.953127],
];

/// XYZ → XYZ matrix that maps colours seen under `src_white` to their appearance under `dst_white`
/// (both XYZ, normally with `Y = 1`).
pub fn adaptation(src_white: [f64; 3], dst_white: [f64; 3]) -> Mat3 {
    let src = matrix::apply(&M16, src_white);
    let dst = matrix::apply(&M16, dst_white);
    let scale = matrix::diag([dst[0] / src[0], dst[1] / src[1], dst[2] / src[2]]);
    matrix::mul(&matrix::inv(&M16), &matrix::mul(&scale, &M16))
}

/// The same adaptation expressed on linear Rec.2020 values.
pub fn adaptation_rec2020(src_white: [f64; 3], dst_white: [f64; 3]) -> Mat3 {
    let cat = adaptation(src_white, dst_white);
    matrix::mul(&matrix::xyz_to_rec2020(), &matrix::mul(&cat, &matrix::rec2020_to_xyz()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::matrix::{xy_to_xyz, D50_XY, D65_XY};

    #[test]
    fn d65_white_goes_to_d50() {
        let m = adaptation(xy_to_xyz(D65_XY), xy_to_xyz(D50_XY));
        let out = matrix::apply(&m, [0.95047, 1.0, 1.08883]);
        // ASTM E308 D50 white.
        for (a, b) in out.iter().zip([0.96422, 1.0, 0.82521]) {
            assert!((a - b).abs() < 2e-3, "{out:?}");
        }
        // Greys scale linearly and the inverse undoes it.
        let grey = matrix::apply(&m, [0.95047 * 0.2, 0.2, 1.08883 * 0.2]);
        assert!((grey[1] - 0.2).abs() < 1e-3);
        let back = matrix::mul(&adaptation(xy_to_xyz(D50_XY), xy_to_xyz(D65_XY)), &m);
        for i in 0..3 {
            for j in 0..3 {
                assert!((back[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn same_white_is_identity_in_rec2020() {
        let w = xy_to_xyz(D65_XY);
        let m = adaptation_rec2020(w, w);
        for i in 0..3 {
            for j in 0..3 {
                assert!((m[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
    }
}
