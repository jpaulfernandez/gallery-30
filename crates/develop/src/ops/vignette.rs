//! Post-crop vignette (workflow plan 17): a radial falloff applied as an exposure gain on linear RGB, so it moves
//! lightness and leaves hue and the chroma ratio alone. It runs on the render's own grid, which is already the
//! crop, after the colour passes and halation.
//!
//! Position: `u, v` in −1..1 across the frame (pixel centres). Shape: Roundness 0 is an ellipse that follows the
//! frame; towards +100 it becomes a circle in pixels (the axes rescaled by the frame's aspect); towards −100 a
//! rounded rectangle (a superellipse with exponent up to `2 + ROUNDNESS_SQUARENESS`). Midpoint sets the distance
//! `d0` at the middle of the falloff (higher keeps it in the corners), Feather the smoothstep width around it.
//! Amount ±100 is ±[`VIGNETTE_EV`] stops at full weight.

use super::smoothstep;
use crate::settings::Vignette;

/// Exposure change at the corners at Amount ±100.
pub const VIGNETTE_EV: f32 = 2.0;
/// Falloff middle at Midpoint 0 and 100 (in the normalised distance, where the frame's edge midpoints sit at 1).
pub const MIDPOINT_NEAR: f32 = 0.35;
pub const MIDPOINT_FAR: f32 = 1.25;
/// Falloff width at Feather 0 and 100.
pub const FEATHER_MIN: f32 = 0.03;
pub const FEATHER_MAX: f32 = 1.3;
/// Extra superellipse exponent at Roundness −100.
pub const ROUNDNESS_SQUARENESS: f32 = 6.0;

#[derive(Debug, Clone)]
pub struct VignetteParams {
    /// Signed stops at full weight.
    pub(crate) ev: f32,
    pub(crate) mid: f32,
    pub(crate) width: f32,
    /// Roundness, −1..1.
    pub(crate) round: f32,
}

impl VignetteParams {
    /// `None` at Amount 0.
    pub fn new(v: &Vignette) -> Option<Self> {
        if v.amount == 0.0 {
            return None;
        }
        let unit = |x: f64| (x / 100.0).clamp(0.0, 1.0) as f32;
        Some(Self {
            ev: (v.amount / 100.0).clamp(-1.0, 1.0) as f32 * VIGNETTE_EV,
            mid: MIDPOINT_NEAR + (MIDPOINT_FAR - MIDPOINT_NEAR) * unit(v.midpoint),
            width: FEATHER_MIN + (FEATHER_MAX - FEATHER_MIN) * unit(v.feather),
            round: (v.roundness / 100.0).clamp(-1.0, 1.0) as f32,
        })
    }

    /// The per-frame part: axis scales and the exponent for a `w × h` frame.
    pub fn frame(&self, w: u32, h: u32) -> VignetteFrame {
        let long = w.max(h).max(1) as f32;
        let r = self.round.max(0.0);
        let (sx, sy) = (1.0 + (w as f32 / long - 1.0) * r, 1.0 + (h as f32 / long - 1.0) * r);
        let exponent = 2.0 + ROUNDNESS_SQUARENESS * (-self.round).max(0.0);
        VignetteFrame { w: w.max(1) as f32, h: h.max(1) as f32, sx, sy, exponent }
    }

    /// The gain at pixel `(x, y)` of `frame`.
    #[inline]
    pub fn gain(&self, frame: &VignetteFrame, x: u32, y: u32) -> f32 {
        // (2x + 1 − w) / w is exactly odd-symmetric about the centre, so mirrored pixels get the same gain.
        let u = ((2 * x + 1) as f32 - frame.w) / frame.w * frame.sx;
        let v = ((2 * y + 1) as f32 - frame.h) / frame.h * frame.sy;
        let d = if frame.exponent == 2.0 {
            (u * u + v * v).sqrt()
        } else {
            (u.abs().powf(frame.exponent) + v.abs().powf(frame.exponent)).powf(1.0 / frame.exponent)
        };
        let weight = smoothstep(self.mid - 0.5 * self.width, self.mid + 0.5 * self.width, d);
        (self.ev * weight).exp2()
    }
}

/// [`VignetteParams::frame`]: the shape for one frame size.
#[derive(Debug, Clone, Copy)]
pub struct VignetteFrame {
    pub(crate) w: f32,
    pub(crate) h: f32,
    pub(crate) sx: f32,
    pub(crate) sy: f32,
    pub(crate) exponent: f32,
}

/// Vignette one row `y` of linear RGB triples.
pub fn vignette(row: &mut [f32], y: u32, p: &VignetteParams, frame: &VignetteFrame) {
    for (x, px) in row.chunks_exact_mut(3).enumerate() {
        let g = p.gain(frame, x as u32, y);
        px[0] *= g;
        px[1] *= g;
        px[2] *= g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(amount: f64, roundness: f64) -> VignetteParams {
        VignetteParams::new(&Vignette { amount, roundness, ..Vignette::default() }).unwrap()
    }

    #[test]
    fn identity_at_default() {
        assert!(VignetteParams::new(&Vignette::default()).is_none());
    }

    #[test]
    fn darkens_corners_not_the_centre() {
        let p = params(-100.0, 0.0);
        let f = p.frame(300, 200);
        assert!((p.gain(&f, 150, 100) - 1.0).abs() < 1e-4);
        assert!(p.gain(&f, 0, 0) < 0.3, "{}", p.gain(&f, 0, 0));
        let lighten = params(60.0, 0.0);
        assert!(lighten.gain(&lighten.frame(300, 200), 0, 0) > 1.5);
    }

    #[test]
    fn symmetric() {
        for roundness in [-100.0, -30.0, 0.0, 50.0, 100.0] {
            let p = params(-70.0, roundness);
            let (w, h) = (301u32, 200u32);
            let f = p.frame(w, h);
            for y in (0..h).step_by(7) {
                for x in (0..w).step_by(5) {
                    let g = p.gain(&f, x, y);
                    assert_eq!(g, p.gain(&f, w - 1 - x, y), "{roundness} x {x} {y}");
                    assert_eq!(g, p.gain(&f, x, h - 1 - y), "{roundness} y {x} {y}");
                }
            }
        }
    }

    #[test]
    fn roundness_100_is_a_circle_in_pixels() {
        let p = params(-50.0, 100.0);
        let (w, h) = (400u32, 200u32);
        let f = p.frame(w, h);
        // Two pixels 80 px from the centre, one along x and one along y, darken the same.
        let (a, b) = (p.gain(&f, 200 + 80, 100), p.gain(&f, 200, 100 + 80));
        assert!((a - b).abs() < 0.02, "{a} vs {b}");
    }
}
