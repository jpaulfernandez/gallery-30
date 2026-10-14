//! 3×3 matrices between linear RGB spaces and CIE XYZ, all with a D65 white (no adaptation needed
//! between them). Built from the primaries' chromaticities by the usual normalised primary matrix (NPM)
//! derivation, so every pair is exactly consistent.

pub type Mat3 = [[f64; 3]; 3];
pub type Mat3f = [[f32; 3]; 3];

/// CIE 1931 xy of D65 (the white of sRGB, Display P3 and Rec.2020).
pub const D65_XY: [f64; 2] = [0.3127, 0.3290];
/// CIE 1931 xy of D50 (the ICC profile connection space white).
pub const D50_XY: [f64; 2] = [0.3457, 0.3585];

/// xy of the red, green and blue primaries.
pub type Primaries = [[f64; 2]; 3];
pub const SRGB_PRIMARIES: Primaries = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]];
pub const P3_PRIMARIES: Primaries = [[0.680, 0.320], [0.265, 0.690], [0.150, 0.060]];
pub const REC2020_PRIMARIES: Primaries = [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]];

/// Luminance weights of linear Rec.2020 (the middle row of [`rec2020_to_xyz`], rounded as in BT.2020).
pub const REC2020_LUMA: [f32; 3] = [0.2627, 0.6780, 0.0593];

pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// XYZ of a chromaticity with `Y = 1`.
pub fn xy_to_xyz([x, y]: [f64; 2]) -> [f64; 3] {
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// CIE 1931 xy of an XYZ triple.
pub fn xyz_to_xy([x, y, z]: [f64; 3]) -> [f64; 2] {
    let sum = x + y + z;
    [x / sum, y / sum]
}

pub fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

pub fn apply(m: &Mat3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[inline(always)]
pub fn apply_f32(m: &Mat3f, r: f32, g: f32, b: f32) -> [f32; 3] {
    [
        m[0][0] * r + m[0][1] * g + m[0][2] * b,
        m[1][0] * r + m[1][1] * g + m[1][2] * b,
        m[2][0] * r + m[2][1] * g + m[2][2] * b,
    ]
}

pub fn diag(d: [f64; 3]) -> Mat3 {
    [[d[0], 0.0, 0.0], [0.0, d[1], 0.0], [0.0, 0.0, d[2]]]
}

/// Inverse by the adjugate. Panics on a singular matrix (every matrix here is well conditioned).
pub fn inv(m: &Mat3) -> Mat3 {
    let c = |r0: usize, c0: usize, r1: usize, c1: usize| m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0];
    let cof = [
        [c(1, 1, 2, 2), -c(1, 0, 2, 2), c(1, 0, 2, 1)],
        [-c(0, 1, 2, 2), c(0, 0, 2, 2), -c(0, 0, 2, 1)],
        [c(0, 1, 1, 2), -c(0, 0, 1, 2), c(0, 0, 1, 1)],
    ];
    let det = m[0][0] * cof[0][0] + m[0][1] * cof[0][1] + m[0][2] * cof[0][2];
    assert!(det.abs() > 1e-12, "singular matrix");
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = cof[j][i] / det;
        }
    }
    out
}

pub fn to_f32(m: &Mat3) -> Mat3f {
    m.map(|row| row.map(|v| v as f32))
}

/// Linear RGB → XYZ for the given primaries and white (the normalised primary matrix).
pub fn rgb_to_xyz_matrix(primaries: &Primaries, white: [f64; 2]) -> Mat3 {
    let cols = primaries.map(xy_to_xyz);
    let p = [
        [cols[0][0], cols[1][0], cols[2][0]],
        [cols[0][1], cols[1][1], cols[2][1]],
        [cols[0][2], cols[1][2], cols[2][2]],
    ];
    let s = apply(&inv(&p), xy_to_xyz(white));
    mul(&p, &diag(s))
}

pub fn srgb_to_xyz() -> Mat3 {
    rgb_to_xyz_matrix(&SRGB_PRIMARIES, D65_XY)
}
pub fn xyz_to_srgb() -> Mat3 {
    inv(&srgb_to_xyz())
}
pub fn p3_to_xyz() -> Mat3 {
    rgb_to_xyz_matrix(&P3_PRIMARIES, D65_XY)
}
pub fn xyz_to_p3() -> Mat3 {
    inv(&p3_to_xyz())
}
pub fn rec2020_to_xyz() -> Mat3 {
    rgb_to_xyz_matrix(&REC2020_PRIMARIES, D65_XY)
}
pub fn xyz_to_rec2020() -> Mat3 {
    inv(&rec2020_to_xyz())
}
pub fn srgb_to_rec2020() -> Mat3 {
    mul(&xyz_to_rec2020(), &srgb_to_xyz())
}
pub fn rec2020_to_srgb() -> Mat3 {
    mul(&xyz_to_srgb(), &rec2020_to_xyz())
}
pub fn p3_to_rec2020() -> Mat3 {
    mul(&xyz_to_rec2020(), &p3_to_xyz())
}
pub fn rec2020_to_p3() -> Mat3 {
    mul(&xyz_to_p3(), &rec2020_to_xyz())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: &Mat3, b: &Mat3, tol: f64) {
        for i in 0..3 {
            for j in 0..3 {
                assert!((a[i][j] - b[i][j]).abs() < tol, "[{i}][{j}]: {} vs {}\n{a:?}\n{b:?}", a[i][j], b[i][j]);
            }
        }
    }

    #[test]
    fn published_matrices() {
        // IEC 61966-2-1 / Lindbloom (D65 = 0.95047, 1, 1.08883, hence the 1e-3 tolerance).
        let srgb = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
        close(&srgb_to_xyz(), &srgb, 1e-3);
        // ITU-R BT.2087 / SMPTE RP 177 derivation.
        let rec2020 = [[0.6369580, 0.1446169, 0.1688810], [0.2627002, 0.6779981, 0.0593017], [0.0, 0.0280727, 1.0609851]];
        close(&rec2020_to_xyz(), &rec2020, 1e-6);
        let p3 = [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0.0, 0.0451134, 1.0439444]];
        close(&p3_to_xyz(), &p3, 1e-6);
        // BT.2087 Table 1: linear BT.709 → BT.2020.
        let to2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
        close(&srgb_to_rec2020(), &to2020, 1e-4);
    }

    #[test]
    fn srgb_white_is_y1_and_rec2020_white() {
        let xyz = apply(&srgb_to_xyz(), [1.0, 1.0, 1.0]);
        assert!((xyz[1] - 1.0).abs() < 1e-12);
        let xy = xyz_to_xy(xyz);
        assert!((xy[0] - D65_XY[0]).abs() < 1e-12 && (xy[1] - D65_XY[1]).abs() < 1e-12);
        let rec = apply(&srgb_to_rec2020(), [1.0, 1.0, 1.0]);
        for c in rec {
            assert!((c - 1.0).abs() < 1e-12, "{rec:?}");
        }
    }

    #[test]
    fn inverse_round_trips() {
        close(&mul(&rec2020_to_srgb(), &srgb_to_rec2020()), &IDENTITY, 1e-12);
        close(&mul(&rec2020_to_p3(), &p3_to_rec2020()), &IDENTITY, 1e-12);
    }
}
