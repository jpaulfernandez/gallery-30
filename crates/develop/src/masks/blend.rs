//! The per-pixel blending contract between masks and the pipeline (plan section 4.2, "Masks").
//!
//! Every mask is composited to one plane on the working (output) grid ([`MaskLayers`]). Then, per pixel
//! `i`, the local slider values are the **mask-weighted sum** over masks, `Σ wₘ(i) · adjₘ`
//! ([`LocalParams::at`]), and they are **added to the global slider values** before the operator runs, in
//! the slider's own units (exposure in EV, the rest in their −100..100 steps). Overlapping masks therefore
//! add up, like RapidRAW's parameter accumulation and Lightroom's stacked masks; the pipeline clamps the
//! sum to each slider's global range.
//!
//! All [`LocalAdjustments`] fields are "linear-ish" sliders that blend as parameters: exposure,
//! temperature, tint, saturation, clarity, dehaze, texture, sharpness (the plan's list) and the tonal
//! ones, contrast, highlights, shadows, whites, blacks, which are per-pixel operators already (their local
//! base is shared), `hue`, and `noise` (read by `ops::noise`, workflow plan 24). Curves and colour
//! grading, if masks gain them, render once per mask and mix by the mask value instead.

use super::composite::{rasterise_mask, rasterise_mask_cached, MaskContext};
use super::hash::MaskCache;
use super::raster::MaskPlane;
use crate::settings::{LocalAdjustments, Mask};

/// The composited planes of the active masks, in the masks' order, with their adjustments. `planes[k]`
/// and `adjustments[k]` belong to `ids[k]`; every plane is `width × height`. Data layout: one `f32` plane
/// per mask (row-major, 0..1), not interleaved, so the GPU path can upload them as an `R8Unorm`/`R16Float`
/// array texture layer by layer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaskLayers {
    pub width: u32,
    pub height: u32,
    pub ids: Vec<String>,
    pub planes: Vec<MaskPlane>,
    pub adjustments: Vec<LocalAdjustments>,
}

impl MaskLayers {
    /// Composite every enabled mask whose adjustments are not all zero (the others cannot change a pixel).
    /// Returns the layers and the ids of AI components that had no raster (they counted as 0).
    pub fn build(masks: &[Mask], ctx: &MaskContext, mut cache: Option<&mut MaskCache>) -> (MaskLayers, Vec<String>) {
        let mut layers = MaskLayers { width: ctx.width, height: ctx.height, ..Default::default() };
        let mut missing = Vec::new();
        for mask in masks.iter().filter(|m| m.enabled && m.adjustments != LocalAdjustments::default()) {
            let result = match cache.as_deref_mut() {
                Some(c) => rasterise_mask_cached(mask, ctx, c),
                None => rasterise_mask(mask, ctx),
            };
            missing.extend(result.missing_ai);
            layers.ids.push(mask.id.clone());
            layers.planes.push(result.plane);
            layers.adjustments.push(mask.adjustments.clone());
        }
        (layers, missing)
    }

    pub fn len(&self) -> usize {
        self.planes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.planes.is_empty()
    }
}

/// `(weight, adjustments)` of every mask covering pixel `idx` (`y * width + x`) with a non-zero weight.
pub fn local_weights(layers: &MaskLayers, idx: usize) -> impl Iterator<Item = (f32, &LocalAdjustments)> + '_ {
    layers.planes.iter().zip(&layers.adjustments).filter_map(move |(p, a)| {
        let w = p.data[idx];
        (w > 0.0).then_some((w, a))
    })
}

/// The local slider values at one pixel, in the sliders' own units, to add to the global ones.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LocalParams {
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub temperature: f32,
    pub tint: f32,
    pub texture: f32,
    pub clarity: f32,
    pub dehaze: f32,
    pub saturation: f32,
    pub sharpness: f32,
    pub noise: f32,
    pub hue: f32,
}

impl LocalParams {
    /// One mask's adjustments at full weight.
    pub fn from_adjustments(a: &LocalAdjustments) -> Self {
        let mut p = Self::default();
        p.add_weighted(1.0, a);
        p
    }

    /// `self += w · a`.
    pub fn add_weighted(&mut self, w: f32, a: &LocalAdjustments) {
        self.exposure += w * a.exposure as f32;
        self.contrast += w * a.contrast as f32;
        self.highlights += w * a.highlights as f32;
        self.shadows += w * a.shadows as f32;
        self.whites += w * a.whites as f32;
        self.blacks += w * a.blacks as f32;
        self.temperature += w * a.temperature as f32;
        self.tint += w * a.tint as f32;
        self.texture += w * a.texture as f32;
        self.clarity += w * a.clarity as f32;
        self.dehaze += w * a.dehaze as f32;
        self.saturation += w * a.saturation as f32;
        self.sharpness += w * a.sharpness as f32;
        self.noise += w * a.noise as f32;
        self.hue += w * a.hue as f32;
    }

    /// `Σ wₘ · adjₘ` at pixel `idx`.
    pub fn at(layers: &MaskLayers, idx: usize) -> Self {
        let mut p = Self::default();
        for (w, a) in local_weights(layers, idx) {
            p.add_weighted(w, a);
        }
        p
    }

    pub fn is_zero(&self) -> bool {
        *self == Self::default()
    }
}
