//! Contrast: a power about the 0.18 fulcrum on luminance, `Y' = f·(Y/f)^(1+c)`, with RGB rescaled by
//! `Y'/Y` so hue and chroma stay put. 0.18 grey never moves.

use crate::color::matrix::REC2020_LUMA;

pub const FULCRUM: f32 = 0.18;
/// `c` at slider ±100 (exponent 0.4 .. 1.6).
pub const STRENGTH: f32 = 0.6;

#[derive(Debug, Clone)]
pub struct ContrastParams {
    /// `c` in the exponent `1 + c`.
    pub c: f32,
}

impl ContrastParams {
    pub fn new(contrast: f64) -> Option<Self> {
        (contrast != 0.0).then(|| Self { c: (contrast / 100.0).clamp(-1.0, 1.0) as f32 * STRENGTH })
    }
}

impl ContrastParams {
    /// From the slider as a unit value (−1..1, already clamped); `None` at 0. For per-pixel (masked) values.
    pub fn from_unit(c: f32) -> Option<Self> {
        (c != 0.0).then(|| Self { c: c * STRENGTH })
    }
}

pub fn contrast(row: &mut [f32], p: &ContrastParams) {
    for px in row.chunks_exact_mut(3) {
        contrast_px(px, p.c);
    }
}

/// Contrast on one RGB triple with exponent offset `c`.
#[inline]
pub fn contrast_px(px: &mut [f32], c: f32) {
    let y = REC2020_LUMA[0] * px[0] + REC2020_LUMA[1] * px[1] + REC2020_LUMA[2] * px[2];
    if y <= 1e-7 {
        return;
    }
    // Y'/Y = (Y/f)^c.
    let ratio = (y / FULCRUM).powf(c);
    px[0] *= ratio;
    px[1] *= ratio;
    px[2] *= ratio;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fulcrum_is_fixed_and_contrast_spreads() {
        let p = ContrastParams::new(100.0).unwrap();
        let mut row = [0.18f32, 0.18, 0.18, 0.05, 0.05, 0.05, 0.6, 0.6, 0.6];
        contrast(&mut row, &p);
        assert!((row[0] - 0.18).abs() < 1e-6);
        assert!(row[3] < 0.05 && row[6] > 0.6);
    }
}
