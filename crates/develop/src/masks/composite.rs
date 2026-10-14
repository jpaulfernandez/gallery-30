//! Combining a mask's components into one plane.
//!
//! Order (the composition model the plan's section 4.1 describes, written from that description):
//!
//! 1. each component is rasterised ([`rasterise_component`]), then inverted when its `invert` is set;
//! 2. components combine **in order**: `add` = max, `subtract` = saturating subtract (`max(0, acc − c)`),
//!    `intersect` = min. The first component always acts as `add` (subtracting from or intersecting with
//!    nothing would always be empty);
//! 3. the mask-level `invert` (`1 − v`);
//! 4. the mask-level `feather`: a Gaussian with σ = `feather/100 · 2 %` of the frame's short side in output
//!    pixels ([`feather_sigma_px`]), so the same softness at preview and export resolution;
//! 5. `opacity/100` scales the result.
//!
//! [`grow`] (dilate/erode up to 1 % of the short side) is exported for when a schema field uses it; no
//! field does yet, so [`rasterise_mask`] does not call it.

use std::sync::Arc;

use rayon::prelude::*;

use super::hash::MaskCache;
use super::raster::{
    luminance_plane, rasterise_brush, rasterise_color, rasterise_linear, rasterise_luminance, rasterise_radial,
    FrameGrid, MaskPlane,
};
use crate::geometry::Homography;
use crate::image::LinearImage;
use crate::local::blur::{gaussian_blur, min_filter};
use crate::settings::{Mask, MaskComponent, MaskMode, MaskShape};

/// Everything the rasterisers need for one output grid.
#[derive(Clone, Copy)]
pub struct MaskContext<'a> {
    /// The output (crop) grid.
    pub width: u32,
    pub height: u32,
    /// Normalised transformed, uncropped frame → output pixels
    /// ([`crate::GeometryPlan::frame_to_output_matrix`]).
    pub frame_to_output: &'a Homography,
    /// [`luminance_plane`] of the input image on this grid (`width * height`). May be empty: it is then
    /// derived from `input_rgb` when a luminance component needs it.
    pub input_luma: &'a [f32],
    /// The input image (decoded, warped, before any develop adjustment) on this grid, for colour ranges.
    pub input_rgb: &'a LinearImage,
    /// The raster of an AI component by component id, at any size (resized bilinearly to the grid).
    pub ai_rasters: &'a (dyn Fn(&str) -> Option<Arc<MaskPlane>> + Sync),
}

impl MaskContext<'_> {
    /// The frame's short side in output pixels (the unit of brush size, feather and grow); 0 when the map
    /// is singular.
    pub fn short_side_px(&self) -> f64 {
        FrameGrid::new(self.width, self.height, self.frame_to_output).map_or(0.0, |g| g.short_side_px())
    }
}

/// A mask's plane and the ids of AI components that had no raster (they contributed 0).
#[derive(Debug, Clone, PartialEq)]
pub struct MaskResult {
    pub plane: MaskPlane,
    pub missing_ai: Vec<String>,
}

/// One component's own raster (before its `invert` and `mode`), and whether it is an AI component whose
/// raster was missing (then the plane is empty).
pub fn rasterise_component(component: &MaskComponent, ctx: &MaskContext) -> (MaskPlane, bool) {
    let (w, h, m) = (ctx.width, ctx.height, ctx.frame_to_output);
    let plane = match &component.shape {
        MaskShape::Brush { strokes } => rasterise_brush(w, h, m, strokes),
        MaskShape::Linear { from, to } => rasterise_linear(w, h, m, *from, *to),
        MaskShape::Radial { center, radii, angle, feather } => rasterise_radial(w, h, m, *center, *radii, *angle, *feather),
        MaskShape::Luminance { range, feather } => {
            if ctx.input_luma.len() == w as usize * h as usize {
                rasterise_luminance(w, h, ctx.input_luma, *range, *feather)
            } else {
                assert_eq!((ctx.input_rgb.width, ctx.input_rgb.height), (w, h), "input image is not on the mask grid");
                rasterise_luminance(w, h, &luminance_plane(ctx.input_rgb), *range, *feather)
            }
        }
        MaskShape::Color { samples, tolerance } => {
            assert_eq!((ctx.input_rgb.width, ctx.input_rgb.height), (w, h), "input image is not on the mask grid");
            rasterise_color(ctx.input_rgb, samples, *tolerance)
        }
        MaskShape::Ai { .. } => match (ctx.ai_rasters)(&component.id) {
            Some(p) => p.resized(w, h),
            None => return (MaskPlane::zeros(w, h), true),
        },
    };
    (plane, false)
}

/// Fold component raster `c` into `acc` with `mode` (`invert` applies to `c` first): add = max, subtract =
/// saturating subtract, intersect = min.
pub fn combine(acc: &mut MaskPlane, c: &MaskPlane, mode: MaskMode, invert: bool) {
    assert_eq!((acc.width, acc.height), (c.width, c.height), "mask planes differ in size");
    acc.data.par_iter_mut().zip(c.data.par_iter()).for_each(|(a, &v)| {
        let v = if invert { 1.0 - v } else { v };
        *a = match mode {
            MaskMode::Add => a.max(v),
            MaskMode::Subtract => (*a - v).max(0.0),
            MaskMode::Intersect => a.min(v),
        };
    });
}

/// Mask feather σ in output pixels: `feather/100 · 0.02 · short_side_px` (feather 100 = 2 % of the
/// frame's short side).
pub fn feather_sigma_px(feather: f64, short_side_px: f64) -> f32 {
    ((feather / 100.0).clamp(0.0, 1.0) * 0.02 * short_side_px) as f32
}

/// Maximum over the `(2r+1)²` window (separable), edges clamped: `1 − min(1 − v)` with
/// [`min_filter`]. Values are assumed to be in 0..1.
pub fn max_filter(plane: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 {
        return;
    }
    plane.par_iter_mut().for_each(|v| *v = 1.0 - *v);
    min_filter(plane, w, h, r);
    plane.par_iter_mut().for_each(|v| *v = 1.0 - *v);
}

/// Grow (`amount > 0`, dilate) or shrink (`amount < 0`, erode) a plane. `amount` −100..100; the square
/// window's radius is `|amount|/100 · 1 %` of the frame's short side in output pixels, rounded.
pub fn grow(plane: &mut MaskPlane, amount: f64, short_side_px: f64) {
    let r = ((amount.abs() / 100.0).min(1.0) * 0.01 * short_side_px).round() as usize;
    let (w, h) = (plane.width as usize, plane.height as usize);
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    if amount > 0.0 {
        max_filter(&mut plane.data, w, h, r);
    } else {
        min_filter(&mut plane.data, w, h, r);
    }
}

/// Composite `mask` onto `ctx`'s grid (see the module docs for the order). `enabled` is not looked at:
/// the caller decides whether a disabled mask is drawn (an overlay may still want it); [`super::MaskLayers`]
/// skips disabled masks.
pub fn rasterise_mask(mask: &Mask, ctx: &MaskContext) -> MaskResult {
    composite_with(mask, ctx, |c| {
        let (p, missing) = rasterise_component(c, ctx);
        (Arc::new(p), missing)
    })
}

/// [`rasterise_mask`] with component rasters from (and into) `cache`.
pub fn rasterise_mask_cached(mask: &Mask, ctx: &MaskContext, cache: &mut MaskCache) -> MaskResult {
    composite_with(mask, ctx, |c| cache.get_or_rasterise(c, ctx))
}

fn composite_with(
    mask: &Mask,
    ctx: &MaskContext,
    mut raster: impl FnMut(&MaskComponent) -> (Arc<MaskPlane>, bool),
) -> MaskResult {
    let (w, h) = (ctx.width, ctx.height);
    let mut acc = MaskPlane::zeros(w, h);
    let mut missing_ai = Vec::new();
    for (i, component) in mask.components.iter().enumerate() {
        let (plane, missing) = raster(component);
        if missing {
            missing_ai.push(component.id.clone());
        }
        let mode = if i == 0 { MaskMode::Add } else { component.mode };
        combine(&mut acc, &plane, mode, component.invert);
    }
    if mask.invert {
        acc.data.par_iter_mut().for_each(|v| *v = 1.0 - *v);
    }
    let sigma = feather_sigma_px(mask.feather, ctx.short_side_px());
    if sigma > 0.0 && w > 0 && h > 0 {
        gaussian_blur(&mut acc.data, w as usize, h as usize, sigma);
    }
    let opacity = (mask.opacity / 100.0).clamp(0.0, 1.0) as f32;
    acc.data.par_iter_mut().for_each(|v| *v = (*v * opacity).clamp(0.0, 1.0));
    MaskResult { plane: acc, missing_ai }
}
