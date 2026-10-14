//! Monotone cubic Hermite interpolation (Fritsch & Carlson 1980) and 4096-entry lookup tables.

/// Entries in a baked curve.
pub const LUT_SIZE: usize = 4096;

/// A monotone piecewise-cubic through control points. Outside the first and last point the curve holds
/// their output values (like Lightroom's point curve).
#[derive(Debug, Clone)]
pub struct MonotoneCubic {
    xs: Vec<f64>,
    ys: Vec<f64>,
    ms: Vec<f64>,
}

impl MonotoneCubic {
    /// `points` are `[x, y]`; they are sorted by `x` and points with a repeated `x` keep the last one.
    /// Fewer than two distinct points give the identity.
    pub fn new(points: &[[f64; 2]]) -> Self {
        let mut pts: Vec<[f64; 2]> = points.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()).collect();
        pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut dedup: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
        for p in pts {
            match dedup.last_mut() {
                Some(last) if (last[0] - p[0]).abs() < 1e-9 => *last = p,
                _ => dedup.push(p),
            }
        }
        if dedup.len() < 2 {
            dedup = vec![[0.0, 0.0], [1.0, 1.0]];
        }
        let n = dedup.len();
        let xs: Vec<f64> = dedup.iter().map(|p| p[0]).collect();
        let ys: Vec<f64> = dedup.iter().map(|p| p[1]).collect();
        let d: Vec<f64> = (0..n - 1).map(|k| (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k])).collect();
        let mut ms = vec![0.0; n];
        ms[0] = d[0];
        ms[n - 1] = d[n - 2];
        for k in 1..n - 1 {
            ms[k] = if d[k - 1] * d[k] <= 0.0 { 0.0 } else { (d[k - 1] + d[k]) / 2.0 };
        }
        for k in 0..n - 1 {
            if d[k] == 0.0 {
                ms[k] = 0.0;
                ms[k + 1] = 0.0;
                continue;
            }
            let (a, b) = (ms[k] / d[k], ms[k + 1] / d[k]);
            let s = a * a + b * b;
            if s > 9.0 {
                let tau = 3.0 / s.sqrt();
                ms[k] = tau * a * d[k];
                ms[k + 1] = tau * b * d[k];
            }
        }
        Self { xs, ys, ms }
    }

    pub fn eval(&self, x: f64) -> f64 {
        let n = self.xs.len();
        if x <= self.xs[0] {
            return self.ys[0];
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1];
        }
        let k = self.xs.partition_point(|&v| v <= x) - 1;
        let h = self.xs[k + 1] - self.xs[k];
        let t = (x - self.xs[k]) / h;
        let (t2, t3) = (t * t, t * t * t);
        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;
        h00 * self.ys[k] + h10 * h * self.ms[k] + h01 * self.ys[k + 1] + h11 * h * self.ms[k + 1]
    }

    /// True when the points are exactly the identity `[[0, 0], [1, 1]]` (or degenerate).
    pub fn is_identity(&self) -> bool {
        self.xs == [0.0, 1.0] && self.ys == [0.0, 1.0]
    }
}

/// A function on 0..1 sampled at [`LUT_SIZE`] evenly spaced inputs and read back with linear
/// interpolation; inputs are clamped to 0..1.
#[derive(Debug, Clone, PartialEq)]
pub struct Lut {
    data: Vec<f32>,
}

impl Lut {
    pub fn from_fn(f: impl Fn(f64) -> f64) -> Self {
        let last = (LUT_SIZE - 1) as f64;
        Self { data: (0..LUT_SIZE).map(|i| f(i as f64 / last) as f32).collect() }
    }

    pub fn identity() -> Self {
        Self::from_fn(|x| x)
    }

    pub fn values(&self) -> &[f32] {
        &self.data
    }

    pub fn values_mut(&mut self) -> &mut [f32] {
        &mut self.data
    }

    #[inline]
    pub fn lookup(&self, x: f32) -> f32 {
        let p = x.clamp(0.0, 1.0) * (LUT_SIZE - 1) as f32;
        let i = (p as usize).min(LUT_SIZE - 2);
        let f = p - i as f32;
        self.data[i] + (self.data[i + 1] - self.data[i]) * f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_curve_lut_is_identity() {
        let curve = MonotoneCubic::new(&[[0.0, 0.0], [1.0, 1.0]]);
        assert!(curve.is_identity());
        let lut = Lut::from_fn(|x| curve.eval(x));
        assert_eq!(lut, Lut::identity());
        for i in 0..=1000 {
            let x = i as f32 / 1000.0;
            assert!((lut.lookup(x) - x).abs() < 1e-6);
        }
    }

    #[test]
    fn monotone_and_through_points() {
        let pts = [[0.0, 0.0], [0.2, 0.05], [0.25, 0.5], [0.8, 0.55], [1.0, 1.0]];
        let curve = MonotoneCubic::new(&pts);
        for p in pts {
            assert!((curve.eval(p[0]) - p[1]).abs() < 1e-12);
        }
        let mut prev = -1.0;
        for i in 0..=10_000 {
            let y = curve.eval(i as f64 / 10_000.0);
            assert!(y >= prev - 1e-12, "not monotone at {i}");
            prev = y;
        }
    }

    #[test]
    fn holds_end_values_and_handles_bad_input() {
        let curve = MonotoneCubic::new(&[[0.8, 0.9], [0.2, 0.1]]);
        assert_eq!(curve.eval(0.0), 0.1);
        assert_eq!(curve.eval(1.0), 0.9);
        assert!(MonotoneCubic::new(&[[0.5, 0.5]]).is_identity());
        let halve = MonotoneCubic::new(&[[0.0, 0.0], [1.0, 0.5]]);
        assert!((halve.eval(0.6) - 0.3).abs() < 1e-12);
    }
}
