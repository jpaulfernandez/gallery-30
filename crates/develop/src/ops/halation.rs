//! Halation (workflow plan 17): the warm glow film gives highlights, from light scattering back through the
//! emulsion. Highlights above Threshold are blurred wide and added back with a red-orange tint, in linear light
//! after the colour passes and before the vignette and grain.
//!
//! The glow is a cached pre-pass ([`crate::local::prepass::halation_plane`]) computed from the decoded (warped)
//! image like the other local planes: the excess `max(0, Y − t_in)` of the luminance over the threshold mapped back
//! through the render's exposure and white-balance grey gain (`t_in = t / gain`, since `max(0, gain·Y − t) =
//! gain · max(0, Y − t/gain)`), at a reduced size, Gaussian-blurred, sampled bilinearly per row. Other tone
//! sliders do not move the source; only exposure and white balance do (they change the cache key).
//!
//! Threshold 0..100 is encoded lightness (`t = srgb_to_linear(threshold / 100)`, 0.52 linear at the default 75);
//! Radius 0..100 is σ [`MIN_SIGMA_REF`]..[`MAX_SIGMA_REF`] reference px (1080 px short side, like every radius);
//! Amount 100 adds [`HALATION_STRENGTH`] × glow × [`HALATION_TINT`].

use crate::color::transfer::srgb_to_linear;
use crate::local::prepass::{HalationKey, HalationPlane};
use crate::settings::Halation;

/// Glow added at Amount 100, per unit of blurred excess luminance.
pub const HALATION_STRENGTH: f32 = 1.5;
/// Linear Rec.2020 tint of the glow (red-orange, like the red-sensitive layer it re-exposes).
pub const HALATION_TINT: [f32; 3] = [1.0, 0.3, 0.1];
/// Blur σ at Radius 0 and 100, reference px.
pub const MIN_SIGMA_REF: f32 = 3.0;
pub const MAX_SIGMA_REF: f32 = 60.0;
/// The excess is capped here so a specular highlight of a RAW does not flood the frame.
pub const MAX_EXCESS: f32 = 4.0;

#[derive(Debug, Clone)]
pub struct HalationParams {
    /// Strength × amount.
    pub(crate) gain: f32,
    /// Linear luminance threshold (after exposure and white balance).
    pub(crate) threshold: f32,
    pub(crate) sigma_ref: f32,
    /// Exposure and white balance's grey gain, mapping the decoded image's luminance to this render's.
    pub(crate) grey: f32,
}

impl HalationParams {
    /// `None` at Amount 0. `grey` is the render's exposure × white-balance grey gain.
    pub fn new(h: &Halation, grey: f32) -> Option<Self> {
        if h.amount <= 0.0 {
            return None;
        }
        let unit = |x: f64| (x / 100.0).clamp(0.0, 1.0) as f32;
        Some(Self {
            gain: unit(h.amount) * HALATION_STRENGTH,
            threshold: srgb_to_linear(unit(h.threshold)),
            sigma_ref: MIN_SIGMA_REF + (MAX_SIGMA_REF - MIN_SIGMA_REF) * unit(h.radius),
            grey: grey.max(1e-6),
        })
    }

    /// The pre-pass this render reads.
    pub fn key(&self) -> HalationKey {
        HalationKey { threshold: self.threshold / self.grey, sigma_ref: self.sigma_ref }
    }
}

/// Add the glow to one row `y` of linear RGB triples. `glow` holds the plane's row (input units); `scratch` is
/// reused between rows.
pub fn halation(row: &mut [f32], y: u32, plane: &HalationPlane, p: &HalationParams, scratch: &mut Vec<f32>) {
    let w = row.len() / 3;
    scratch.resize(w, 0.0);
    plane.sample_row(y as usize, scratch);
    let k = p.gain * p.grey;
    for (px, g) in row.chunks_exact_mut(3).zip(scratch.iter()) {
        let add = k * g;
        if add > 0.0 {
            px[0] += add * HALATION_TINT[0];
            px[1] += add * HALATION_TINT[1];
            px[2] += add * HALATION_TINT[2];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::LinearImage;
    use crate::local::prepass::halation_plane;

    #[test]
    fn identity_at_default() {
        assert!(HalationParams::new(&Halation::default(), 1.0).is_none());
    }

    #[test]
    fn glows_around_highlights_only() {
        // A dark frame with one bright square in the middle.
        let (w, h) = (240u32, 160u32);
        let data: Vec<f32> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                if (110..130).contains(&x) && (70..90).contains(&y) { [1.0; 3] } else { [0.02; 3] }
            })
            .collect();
        let img = LinearImage::new(w, h, data);
        let p = HalationParams::new(&Halation { amount: 80.0, ..Halation::default() }, 1.0).unwrap();
        let plane = halation_plane(&img, p.key());
        let mut scratch = Vec::new();
        let mut row = img.row(80).to_vec();
        halation(&mut row, 80, &plane, &p, &mut scratch);
        // Next to the square: a warm glow (red gains more than blue).
        let (dr, db) = (row[105 * 3] - 0.02, row[105 * 3 + 2] - 0.02);
        assert!(dr > 0.01 && dr > 3.0 * db, "{dr} {db}");
        // Far away: nothing.
        let mut far = img.row(5).to_vec();
        halation(&mut far, 5, &plane, &p, &mut scratch);
        assert!((far[3 * 3] - 0.02).abs() < 1e-4, "{}", far[9]);
        // A frame without highlights does not glow at all.
        let dark = LinearImage::new(w, h, vec![0.3; (w * h * 3) as usize]);
        let plane = halation_plane(&dark, p.key());
        let mut row = dark.row(10).to_vec();
        halation(&mut row, 10, &plane, &p, &mut scratch);
        assert!(row.iter().all(|v| *v == 0.3));
    }

    #[test]
    fn exposure_moves_the_threshold() {
        let p1 = HalationParams::new(&Halation { amount: 50.0, ..Halation::default() }, 1.0).unwrap();
        let p2 = HalationParams::new(&Halation { amount: 50.0, ..Halation::default() }, 2.0).unwrap();
        assert!((p2.key().threshold - p1.key().threshold / 2.0).abs() < 1e-6);
    }
}
