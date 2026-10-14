//! The parametric and point curves, applied to the output-encoded (sRGB) values after the display
//! transform, like Lightroom's tone curve.
//!
//! **Parametric**: four regions split at `splits` (shadows, darks, lights, highlights); each slider adds
//! a raised-cosine bump spanning its region widened by half its width on each side (clipped to 0..1, so
//! the end points stay put), up to ±[`PARAMETRIC_AMPLITUDE`]; the sum is then clamped to 0..1 and made
//! monotone by a running maximum.
//!
//! **Point curves**: `luma` is the composite curve applied to all three channels, then `red`, `green`,
//! `blue` per channel; Fritsch–Carlson monotone cubics. The three stages are baked into one 4096-entry
//! table per channel per render.

use crate::color::curve::{Lut, MonotoneCubic};
use crate::settings::{Curve, ParametricCurve};

/// Output change at the peak of a region's bump for a slider at ±100.
pub const PARAMETRIC_AMPLITUDE: f64 = 0.12;

/// The parametric curve, monotone and within 0..1.
pub fn parametric_lut(p: &ParametricCurve) -> Lut {
    let mut s = p.splits.map(|v| if v.is_finite() { v.clamp(0.05, 0.95) } else { 0.5 });
    s.sort_by(f64::total_cmp);
    let edges = [0.0, s[0], s[1], s[2], 1.0];
    let amounts = [p.shadows, p.darks, p.lights, p.highlights].map(|v| (v / 100.0).clamp(-1.0, 1.0) * PARAMETRIC_AMPLITUDE);
    let bumps: Vec<(f64, f64, f64)> = (0..4)
        .filter(|&i| amounts[i] != 0.0)
        .map(|i| {
            let half = (edges[i + 1] - edges[i]) / 2.0;
            ((edges[i] - half).max(0.0), (edges[i + 1] + half).min(1.0), amounts[i])
        })
        .collect();
    let mut lut = Lut::from_fn(|x| {
        x + bumps
            .iter()
            .filter(|(lo, hi, _)| x > *lo && x < *hi)
            .map(|(lo, hi, amount)| amount * 0.5 * (1.0 - (std::f64::consts::TAU * (x - lo) / (hi - lo)).cos()))
            .sum::<f64>()
    });
    let mut running = 0.0f32;
    for v in lut.values_mut() {
        running = running.max(v.clamp(0.0, 1.0));
        *v = running;
    }
    lut
}

fn is_identity_points(points: &[[f64; 2]]) -> bool {
    MonotoneCubic::new(points).is_identity()
}

#[derive(Debug, Clone)]
pub struct CurveParams {
    pub(crate) luts: [Lut; 3],
}

impl CurveParams {
    pub fn new(curve: &Curve) -> Option<Self> {
        let p = &curve.parametric;
        let parametric_default = p.shadows == 0.0 && p.darks == 0.0 && p.lights == 0.0 && p.highlights == 0.0;
        if parametric_default && [&curve.luma, &curve.red, &curve.green, &curve.blue].iter().all(|c| is_identity_points(c)) {
            return None;
        }
        let parametric = parametric_lut(p);
        let luma = MonotoneCubic::new(&curve.luma);
        let channel = |points: &[[f64; 2]]| {
            let c = MonotoneCubic::new(points);
            Lut::from_fn(|x| c.eval(luma.eval(parametric.lookup(x as f32) as f64)))
        };
        Some(Self { luts: [channel(&curve.red), channel(&curve.green), channel(&curve.blue)] })
    }

    /// Apply to one encoded RGB triple in 0..1.
    #[inline]
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        [self.luts[0].lookup(rgb[0]), self.luts[1].lookup(rgb[1]), self.luts[2].lookup(rgb[2])]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_skipped() {
        assert!(CurveParams::new(&Curve::default()).is_none());
    }

    #[test]
    fn parametric_highlights_darken_brights_only() {
        let p = ParametricCurve { highlights: -100.0, ..ParametricCurve::default() };
        let lut = parametric_lut(&p);
        assert!(lut.lookup(0.85) < 0.80);
        assert_eq!(lut.lookup(0.3), 0.3);
        assert!((lut.lookup(1.0) - 1.0).abs() < 1e-6);
        let v = lut.values();
        assert!(v.windows(2).all(|w| w[1] >= w[0]));
    }

    #[test]
    fn halving_point_curve() {
        let curve = Curve { luma: vec![[0.0, 0.0], [1.0, 0.5]], ..Curve::default() };
        let p = CurveParams::new(&curve).unwrap();
        let out = p.apply([0.8, 0.4, 0.2]);
        assert!((out[0] - 0.4).abs() < 1e-4 && (out[1] - 0.2).abs() < 1e-4 && (out[2] - 0.1).abs() < 1e-4);
    }
}
