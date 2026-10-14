//! A 3×3 projective transform of the plane.
//!
//! `Homography([h0..h8])` is row-major and acts on column vectors `[x, y, 1]ᵀ`:
//! `x' = (h0·x + h1·y + h2) / (h6·x + h7·y + h8)`, `y' = (h3·x + h4·y + h5) / (h6·x + h7·y + h8)`.
//!
//! Composition: `a.then(&b)` applies `a` first, then `b` (the matrix product `B·A`); `a.compose(&b)` and
//! `a * b` are the plain matrix product `A·B` (apply `b` first). Everything is plain `f64` so the TypeScript twin can be a
//! direct transliteration.

use std::ops::Mul;

use nalgebra::{SMatrix, SVector};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Homography(pub [f64; 9]);

impl Default for Homography {
    fn default() -> Self {
        Self::identity()
    }
}

impl Homography {
    pub const fn identity() -> Self {
        Homography([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0])
    }

    pub const fn translate(tx: f64, ty: f64) -> Self {
        Homography([1.0, 0.0, tx, 0.0, 1.0, ty, 0.0, 0.0, 1.0])
    }

    pub const fn scale(sx: f64, sy: f64) -> Self {
        Homography([sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0])
    }

    /// Rotation by `radians` about the origin. In image coordinates (y down) a positive angle turns
    /// clockwise on screen.
    pub fn rotate(radians: f64) -> Self {
        let (s, c) = radians.sin_cos();
        Homography([c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0])
    }

    /// Rotation by `radians` about `(cx, cy)`.
    pub fn rotate_about(radians: f64, cx: f64, cy: f64) -> Self {
        Self::translate(-cx, -cy).then(&Self::rotate(radians)).then(&Self::translate(cx, cy))
    }

    /// Function composition `self ∘ other`, i.e. the matrix product `self · other` (applies `other`
    /// first).
    pub fn compose(&self, other: &Homography) -> Homography {
        let (a, b) = (&self.0, &other.0);
        let mut m = [0.0; 9];
        for r in 0..3 {
            for c in 0..3 {
                m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
        }
        Homography(m)
    }

    /// `self` first, then `next`: the matrix `next · self`.
    pub fn then(&self, next: &Homography) -> Homography {
        next.compose(self)
    }

    pub fn determinant(&self) -> f64 {
        let m = &self.0;
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    }

    /// The inverse, or `None` when the matrix is singular (relative determinant below 1e-12).
    pub fn invert(&self) -> Option<Homography> {
        let m = &self.0;
        let det = self.determinant();
        let norm = m.iter().fold(0.0f64, |acc, v| acc.max(v.abs()));
        if !det.is_finite() || norm == 0.0 || det.abs() <= 1e-12 * norm * norm * norm {
            return None;
        }
        let inv = 1.0 / det;
        Some(Homography([
            (m[4] * m[8] - m[5] * m[7]) * inv,
            (m[2] * m[7] - m[1] * m[8]) * inv,
            (m[1] * m[5] - m[2] * m[4]) * inv,
            (m[5] * m[6] - m[3] * m[8]) * inv,
            (m[0] * m[8] - m[2] * m[6]) * inv,
            (m[2] * m[3] - m[0] * m[5]) * inv,
            (m[3] * m[7] - m[4] * m[6]) * inv,
            (m[1] * m[6] - m[0] * m[7]) * inv,
            (m[0] * m[4] - m[1] * m[3]) * inv,
        ]))
    }

    /// Divide through by `h8` (when it is not ~0), so equal maps compare equal.
    pub fn normalized(&self) -> Homography {
        let d = self.0[8];
        if d.abs() < 1e-300 {
            return *self;
        }
        Homography(self.0.map(|v| v / d))
    }

    /// Map a point (homogeneous divide).
    #[inline]
    pub fn apply(&self, [x, y]: [f64; 2]) -> [f64; 2] {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
    }

    /// Whether the bottom row is `[0, 0, 1]` (after normalising), within `eps`.
    pub fn is_affine(&self, eps: f64) -> bool {
        let n = self.normalized().0;
        n[6].abs() <= eps && n[7].abs() <= eps
    }

    /// The images of the rectangle's corners, clockwise from the top-left: `(x, y)`, `(x + w, y)`,
    /// `(x + w, y + h)`, `(x, y + h)`.
    pub fn map_rect_corners(&self, x: f64, y: f64, w: f64, h: f64) -> [[f64; 2]; 4] {
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(|p| self.apply(p))
    }

    /// Jacobian `[[∂x'/∂x, ∂x'/∂y], [∂y'/∂x, ∂y'/∂y]]` at `p` (row-major `[a, b, c, d]`).
    pub fn jacobian(&self, [x, y]: [f64; 2]) -> [f64; 4] {
        let m = &self.0;
        let w = m[6] * x + m[7] * y + m[8];
        let u = m[0] * x + m[1] * y + m[2];
        let v = m[3] * x + m[4] * y + m[5];
        let w2 = w * w;
        [
            (m[0] * w - u * m[6]) / w2,
            (m[1] * w - u * m[7]) / w2,
            (m[3] * w - v * m[6]) / w2,
            (m[4] * w - v * m[7]) / w2,
        ]
    }

    /// The homography sending each `src[i]` to `dst[i]` (direct linear transform with Hartley
    /// normalisation, null vector by SVD). `None` when three points are collinear or the fit degenerates.
    pub fn from_four_points(src: [[f64; 2]; 4], dst: [[f64; 2]; 4]) -> Option<Homography> {
        let (ns, src_n) = hartley(&src)?;
        let (nd, dst_n) = hartley(&dst)?;
        // 8 equations; a zero ninth row makes the matrix square so the full V is returned.
        let mut a = SMatrix::<f64, 9, 9>::zeros();
        for i in 0..4 {
            let [x, y] = src_n[i];
            let [u, v] = dst_n[i];
            let r = 2 * i;
            a.row_mut(r).copy_from(&SVector::<f64, 9>::from([-x, -y, -1.0, 0.0, 0.0, 0.0, u * x, u * y, u]).transpose());
            a.row_mut(r + 1)
                .copy_from(&SVector::<f64, 9>::from([0.0, 0.0, 0.0, -x, -y, -1.0, v * x, v * y, v]).transpose());
        }
        let svd = a.svd(false, true);
        let v_t = svd.v_t?;
        let (k, _) = svd.singular_values.iter().enumerate().fold((0, f64::INFINITY), |best, (i, &s)| {
            if s < best.1 {
                (i, s)
            } else {
                best
            }
        });
        let h: [f64; 9] = std::array::from_fn(|j| v_t[(k, j)]);
        let hn = Homography(h);
        // Undo the normalisations: H = Nd⁻¹ · Hn · Ns.
        let full = nd.invert()?.compose(&hn).compose(&ns);
        let out = if full.0[8].abs() < 1e-14 { full } else { full.normalized() };
        // Reject degenerate fits (three collinear points give a singular map that cannot hit all four).
        out.invert()?;
        let ok = src.iter().zip(dst.iter()).all(|(s, d)| {
            let p = out.apply(*s);
            let scale = 1.0 + d[0].abs().max(d[1].abs());
            (p[0] - d[0]).abs() <= 1e-6 * scale && (p[1] - d[1]).abs() <= 1e-6 * scale
        });
        ok.then_some(out)
    }
}

impl Mul for Homography {
    type Output = Homography;
    /// `a * b` = `A·B`: applies `b` first, then `a`.
    fn mul(self, rhs: Homography) -> Homography {
        self.compose(&rhs)
    }
}

impl Mul<&Homography> for &Homography {
    type Output = Homography;
    fn mul(self, rhs: &Homography) -> Homography {
        self.compose(rhs)
    }
}

/// Hartley normalisation: centroid to the origin, mean distance √2. Returns the normalising transform and
/// the normalised points.
fn hartley(pts: &[[f64; 2]; 4]) -> Option<(Homography, [[f64; 2]; 4])> {
    let cx = pts.iter().map(|p| p[0]).sum::<f64>() / 4.0;
    let cy = pts.iter().map(|p| p[1]).sum::<f64>() / 4.0;
    let mean = pts.iter().map(|p| ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt()).sum::<f64>() / 4.0;
    if !(mean > 1e-300) || !mean.is_finite() {
        return None;
    }
    let s = std::f64::consts::SQRT_2 / mean;
    let n = Homography([s, 0.0, -s * cx, 0.0, s, -s * cy, 0.0, 0.0, 1.0]);
    Some((n, pts.map(|p| n.apply(p))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f64; 2], b: [f64; 2], eps: f64) -> bool {
        (a[0] - b[0]).abs() <= eps && (a[1] - b[1]).abs() <= eps
    }

    const SAMPLE: Homography = Homography([1.2, 0.1, 3.0, -0.05, 0.9, -2.0, 0.0004, -0.0002, 1.0]);

    #[test]
    fn identity_maps_points_to_themselves() {
        let h = Homography::identity();
        assert_eq!(h.apply([3.5, -2.0]), [3.5, -2.0]);
        assert_eq!(h * SAMPLE, SAMPLE);
        assert_eq!(SAMPLE.then(&h), SAMPLE);
    }

    #[test]
    fn inverse_round_trips() {
        let inv = SAMPLE.invert().unwrap();
        for p in [[0.0, 0.0], [100.0, 50.0], [-30.0, 700.0]] {
            assert!(close(inv.apply(SAMPLE.apply(p)), p, 1e-9));
        }
        let id = (SAMPLE * inv).normalized();
        for (a, b) in id.0.iter().zip(Homography::identity().0.iter()) {
            assert!((a - b).abs() < 1e-12);
        }
        assert!(Homography([1.0, 2.0, 0.0, 2.0, 4.0, 0.0, 0.0, 0.0, 1.0]).invert().is_none());
    }

    #[test]
    fn then_applies_in_order() {
        let a = Homography::translate(10.0, 0.0);
        let b = Homography::rotate(std::f64::consts::FRAC_PI_2);
        // Translate first, then rotate 90° (clockwise in y-down): (1, 0) → (11, 0) → (0, 11).
        assert!(close(a.then(&b).apply([1.0, 0.0]), [0.0, 11.0], 1e-12));
        assert!(close((b * a).apply([1.0, 0.0]), [0.0, 11.0], 1e-12));
        let r = Homography::rotate_about(std::f64::consts::PI, 5.0, 5.0);
        assert!(close(r.apply([0.0, 0.0]), [10.0, 10.0], 1e-12));
    }

    #[test]
    fn dlt_reproduces_a_projective_map() {
        let src = [[0.0, 0.0], [640.0, 0.0], [640.0, 480.0], [0.0, 480.0]];
        let dst = src.map(|p| SAMPLE.apply(p));
        let h = Homography::from_four_points(src, dst).unwrap();
        for (a, b) in h.0.iter().zip(SAMPLE.normalized().0.iter()) {
            assert!((a - b).abs() < 1e-9, "{h:?}");
        }
        for p in [[17.0, 300.0], [600.0, 3.0]] {
            assert!(close(h.apply(p), SAMPLE.apply(p), 1e-7));
        }
        // Three collinear points.
        assert!(Homography::from_four_points([[0.0, 0.0], [1.0, 1.0], [2.0, 2.0], [0.0, 1.0]], dst).is_none());
    }

    #[test]
    fn dlt_matches_imageproc() {
        use imageproc::geometric_transformations::Projection;
        let src = [[10.0, 20.0], [300.0, 15.0], [320.0, 250.0], [5.0, 260.0]];
        let dst = [[0.0, 0.0], [310.0, 0.0], [310.0, 240.0], [0.0, 240.0]];
        let ours = Homography::from_four_points(src, dst).unwrap();
        let f = |p: [[f64; 2]; 4]| p.map(|q| (q[0] as f32, q[1] as f32));
        let theirs = Projection::from_control_points(f(src), f(dst)).unwrap();
        for p in [[10.0, 20.0], [150.0, 150.0], [320.0, 250.0], [77.0, 31.0]] {
            let a = ours.apply(p);
            let b = theirs * (p[0] as f32, p[1] as f32);
            assert!(close(a, [b.0 as f64, b.1 as f64], 2e-3), "{a:?} vs {b:?}");
        }
    }

    #[test]
    fn jacobian_of_scale_and_rect_corners() {
        let h = Homography::scale(2.0, 3.0).then(&Homography::translate(1.0, 1.0));
        assert_eq!(h.jacobian([5.0, 5.0]), [2.0, 0.0, 0.0, 3.0]);
        assert_eq!(h.map_rect_corners(0.0, 0.0, 1.0, 1.0), [[1.0, 1.0], [3.0, 1.0], [3.0, 4.0], [1.0, 4.0]]);
    }
}
