//! The Detail section: clarity, texture, dehaze and sharpening ([`DetailParams`]), and the tone weights
//! they share.
//!
//! **Default sharpening.** The schema's default sharpening is Lightroom's baseline (amount 40, radius 1,
//! detail 25, masking 0), but an unedited photo must render back to its decoded pixels (the D1.2
//! no-op check). So the whole section is skipped while it equals [`Detail::default`]; as soon as any
//! detail field differs (a texture of 1, a denoise model, a sharpening of 41), every detail control runs
//! with its value, including the baseline sharpening at 40. The UI shows "Sharpening 40" as the
//! baseline, so this is what it promises once the user touches the section. Sharpening at amount 0 is
//! always off.

use super::clarity::ClarityParams;
use super::dehaze::DehazeParams;
use super::sharpen::SharpenParams;
use super::smoothstep;
use super::texture::TextureParams;
use crate::local::Needs;
use crate::settings::Detail;

/// The detail passes for one render; a `None` pass is skipped.
#[derive(Debug, Clone)]
pub struct DetailParams {
    pub clarity: Option<ClarityParams>,
    pub texture: Option<TextureParams>,
    pub dehaze: Option<DehazeParams>,
    pub sharpen: Option<SharpenParams>,
}

impl DetailParams {
    /// `None` while the section equals [`Detail::default`] (see the module notes) or every pass is off.
    pub fn new(detail: &Detail) -> Option<Self> {
        if *detail == Detail::default() {
            return None;
        }
        let p = Self {
            clarity: ClarityParams::new(detail.clarity),
            texture: TextureParams::new(detail.texture),
            dehaze: DehazeParams::new(detail.dehaze),
            sharpen: SharpenParams::new(&detail.sharpen),
        };
        (p.clarity.is_some() || p.texture.is_some() || p.dehaze.is_some() || p.sharpen.is_some()).then_some(p)
    }

    /// Adds the pre-passes these passes read.
    pub fn add_needs(&self, needs: &mut Needs) {
        needs.clarity |= self.clarity.is_some();
        needs.texture |= self.texture.is_some();
        needs.haze |= self.dehaze.is_some();
        if let Some(s) = &self.sharpen {
            needs.sharpen_radius = Some(s.radius);
        }
    }
}

/// Keeps local-contrast gains out of the noise floor and off near-white (lightness `t = Y^(1/2.4)`).
#[inline]
pub fn detail_gate(t: f32) -> f32 {
    smoothstep(0.02, 0.10, t) * (1.0 - smoothstep(0.85, 1.0, t))
}

/// Midtone emphasis for clarity: `sqrt(1 − (2t − 1)²)`, 1 at `t = 0.5`, 0 at black and white.
#[inline]
pub fn midtone_weight(t: f32) -> f32 {
    let m = 2.0 * t - 1.0;
    (1.0 - m * m).max(0.0).sqrt()
}

/// Soft halo shaper `d / (1 + (d/s)²)`: linear for small `d`, peaks at `d = s` with `s/2`, then falls
/// away, so large deviations (edges, the source of halos) are boosted least.
#[inline]
pub fn halo_shape(d: f32, s: f32) -> f32 {
    let q = d / s;
    d / (1.0 + q * q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Sharpen;

    #[test]
    fn default_section_is_skipped_and_any_edit_brings_the_baseline_sharpening() {
        assert!(DetailParams::new(&Detail::default()).is_none());
        let p = DetailParams::new(&Detail { texture: 1.0, ..Detail::default() }).unwrap();
        assert!(p.texture.is_some() && p.sharpen.is_some() && p.clarity.is_none());
        let off = Detail { sharpen: Sharpen { amount: 0.0, ..Sharpen::default() }, ..Detail::default() };
        assert!(DetailParams::new(&off).is_none());
    }

    #[test]
    fn weights() {
        assert_eq!(detail_gate(0.0), 0.0);
        assert_eq!(detail_gate(1.0), 0.0);
        assert_eq!(detail_gate(0.5), 1.0);
        assert!((midtone_weight(0.5) - 1.0).abs() < 1e-6);
        assert!((halo_shape(0.5, 0.5) - 0.25).abs() < 1e-6);
        assert!(halo_shape(2.0, 0.5) < halo_shape(0.5, 0.5));
    }
}
