//! The Effects section (workflow plan 17): colour grading, grain, vignette and halation ([`EffectsParams`]).
//!
//! Where they run: halation then vignette in linear light, after the colour passes and before the optional display
//! look ([`LinearEffects`], called by both the global and the masked row paths); grading then grain on the
//! display-referred output after the tone curves (and the LUT of plan 18), before the dither ([`DisplayEffects`],
//! inside [`crate::ops::output::encode_row_with`]). Every control at its default is skipped, so the section at its
//! defaults renders exactly as before it existed.
//!
//! The GPU runs the same passes in the same places (workflow plan 19, `gpu/shaders/chain.wgsl`; halation's glow is a
//! whole-image pre-pass there too), matched against this reference by `tests/gpu.rs`.

use super::grading::GradingParams;
use super::grain::GrainParams;
use super::halation::{halation, HalationParams};
use super::vignette::{vignette, VignetteFrame, VignetteParams};
use crate::local::prepass::HalationPlane;
use crate::local::Needs;
use crate::settings::Effects;

/// The effect passes of one render; a `None` pass is skipped.
#[derive(Debug, Clone)]
pub struct EffectsParams {
    pub grading: Option<GradingParams>,
    pub grain: Option<GrainParams>,
    pub vignette: Option<VignetteParams>,
    pub halation: Option<HalationParams>,
}

impl EffectsParams {
    /// `None` when every pass is off. `grey` is the render's exposure × white-balance grey gain (halation's
    /// threshold follows it).
    pub fn new(effects: &Effects, grey: f32) -> Option<Self> {
        if effects.is_default() {
            return None;
        }
        let p = Self {
            grading: GradingParams::new(&effects.grading),
            grain: GrainParams::new(&effects.grain),
            vignette: VignetteParams::new(&effects.vignette),
            halation: HalationParams::new(&effects.halation, grey),
        };
        (p.grading.is_some() || p.grain.is_some() || p.vignette.is_some() || p.halation.is_some()).then_some(p)
    }

    /// Adds the pre-passes these passes read (the halation glow).
    pub fn add_needs(&self, needs: &mut Needs) {
        if let Some(h) = &self.halation {
            needs.halation = Some(h.key());
        }
    }

    /// The linear-light passes for a `w × h` render, with the halation glow when it is available.
    pub fn linear<'a>(&'a self, w: u32, h: u32, glow: Option<&'a HalationPlane>) -> Option<LinearEffects<'a>> {
        let fx = LinearEffects {
            halation: self.halation.as_ref().zip(glow),
            vignette: self.vignette.as_ref().map(|v| (v, v.frame(w, h))),
        };
        (fx.halation.is_some() || fx.vignette.is_some()).then_some(fx)
    }

    /// The display-referred passes for a `w × h` render.
    pub fn display(&self, w: u32, h: u32) -> Option<DisplayEffects<'_>> {
        let fx = DisplayEffects {
            grading: self.grading.as_ref(),
            grain: self.grain.as_ref().map(|g| (g, GrainParams::scale_for(w, h))),
        };
        (fx.grading.is_some() || fx.grain.is_some()).then_some(fx)
    }
}

/// Halation and vignette for one render.
#[derive(Debug, Clone, Copy)]
pub struct LinearEffects<'a> {
    pub halation: Option<(&'a HalationParams, &'a HalationPlane)>,
    pub vignette: Option<(&'a VignetteParams, VignetteFrame)>,
}

impl LinearEffects<'_> {
    /// Run on row `y` of linear Rec.2020 triples; `scratch` is reused between rows.
    pub fn apply(&self, row: &mut [f32], y: u32, scratch: &mut Vec<f32>) {
        if let Some((p, plane)) = self.halation {
            halation(row, y, plane, p, scratch);
        }
        if let Some((p, frame)) = &self.vignette {
            vignette(row, y, p, frame);
        }
    }
}

/// Grading and grain for one render; `grain` carries the reference px per pixel.
#[derive(Debug, Clone, Copy)]
pub struct DisplayEffects<'a> {
    pub grading: Option<&'a GradingParams>,
    pub grain: Option<(&'a GrainParams, f32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_section_is_skipped() {
        assert!(EffectsParams::new(&Effects::default(), 1.0).is_none());
        let mut e = Effects::default();
        e.grading.blending = 80.0; // changes nothing without a wheel
        assert!(EffectsParams::new(&e, 1.0).is_none());
        e.grain.amount = 10.0;
        let p = EffectsParams::new(&e, 1.0).unwrap();
        assert!(p.grain.is_some() && p.grading.is_none() && p.linear(10, 10, None).is_none());
    }
}
