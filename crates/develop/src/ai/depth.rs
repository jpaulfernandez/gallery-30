//! Depth (D4.3): Depth Anything V2 Small → a normalised depth map → depth-range masks.
//!
//! The model returns **relative inverse depth** (larger = nearer, no unit, an arbitrary scale and shift per
//! picture). [`depth`] resizes it to the picture and normalises it to `0` = nearest … `1` = farthest between the
//! 1st and 99th percentiles (so a few extreme pixels, a bright lamp or the sky's infinity, do not squash the rest),
//! clamped. Being inverse depth, steps are finer near the camera, which is where a range mask needs them.
//!
//! A depth component's raster is [`depth_range_mask`] of that map: 1 between `lo` and `hi`, falling to 0 over
//! `feather` depth units outside each end (smoothstep). The map itself is what the cache stores (16-bit), so moving
//! the range never re-runs the model.

use rayon::prelude::*;

use super::preprocess::{prepare, unletterbox, Filter, Fit, Norm};
use super::runtime::{Session, Tensor};
use super::{Error, Result};
use crate::image::LinearImage;
use crate::masks::MaskPlane;

/// Depth Anything V2's input side (a multiple of its 14 px patch).
pub const DEPTH_INPUT: u32 = 518;
/// Default feather of a depth range, in normalised depth units.
pub const DEPTH_FEATHER: f64 = crate::masks::ai_cache::DEPTH_RANGE_FEATHER;

/// A normalised depth map on the picture's grid.
#[derive(Debug, Clone, PartialEq)]
pub struct DepthMap {
    /// `0` nearest … `1` farthest, `width × height`.
    pub depth: MaskPlane,
    /// The model's raw relative inverse depth resized to the same grid (larger = nearer). Empty for a map read
    /// back from the cache.
    pub raw: Vec<f32>,
}

impl DepthMap {
    pub fn width(&self) -> u32 {
        self.depth.width
    }

    pub fn height(&self) -> u32 {
        self.depth.height
    }
}

/// Normalise relative inverse depth to `0` near … `1` far between its 1st and 99th percentiles (clamped). A flat
/// input gives all zeros.
pub fn normalise_inverse_depth(raw: &[f32]) -> Vec<f32> {
    let mut finite: Vec<f32> = raw.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() {
        return vec![0.0; raw.len()];
    }
    let n = finite.len();
    let (lo_i, hi_i) = ((n - 1) / 100, (n - 1) - (n - 1) / 100);
    finite.select_nth_unstable_by(lo_i, f32::total_cmp);
    let lo = finite[lo_i];
    finite.select_nth_unstable_by(hi_i, f32::total_cmp);
    let hi = finite[hi_i];
    let span = hi - lo;
    if !(span > 1e-12) {
        return vec![0.0; raw.len()];
    }
    // Larger raw = nearer, so near (hi) → 0, far (lo) → 1.
    raw.par_iter().map(|&v| if v.is_finite() { ((hi - v) / span).clamp(0.0, 1.0) } else { 1.0 }).collect()
}

/// Run Depth Anything on `image` (518 × 518 stretched, ImageNet, bicubic) and return its map at the image's size.
pub fn depth(session: &Session, image: &LinearImage) -> Result<DepthMap> {
    let input = prepare(image, DEPTH_INPUT, DEPTH_INPUT, Fit::Stretch, Norm::ImageNet, Filter::Bicubic)?;
    let out = session.run(&[("pixel_values", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let pred = out.get("predicted_depth").or_else(|| out.first()).ok_or_else(|| Error::Runtime("depth: no output".into()))?;
    let shape = pred.shape().to_vec();
    let (h, w) = match shape.as_slice() {
        [_, h, w] | [_, _, h, w] => (*h as u32, *w as u32),
        other => return Err(Error::Runtime(format!("depth: unexpected output shape {other:?}"))),
    };
    let data: Vec<f32> = pred.iter().copied().collect();
    let raw = unletterbox(&data, w, h, &input.frame, image.width, image.height)?.data;
    let depth = MaskPlane::new(image.width, image.height, normalise_inverse_depth(&raw));
    Ok(DepthMap { depth, raw })
}

/// 1 for `lo <= d <= hi` (`range` swapped when reversed), falling to 0 over `feather` depth units outside each end
/// (smoothstep); `feather <= 0` is a hard range.
pub fn depth_range_mask(map: &DepthMap, range: [f64; 2], feather: f64) -> MaskPlane {
    depth_range_plane(&map.depth, range, feather)
}

/// [`depth_range_mask`] on a bare normalised depth plane.
pub use crate::masks::ai_cache::depth_range_plane;
