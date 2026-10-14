//! Edge refinement of model masks against the picture (plan section 4.8: "refined against the image with a guided
//! filter so edges snap, then upsampled to the working resolution").
//!
//! The model's plane is upsampled bilinearly to the working size, then guided-filtered with the working image's
//! luminance as the guide ([`crate::local::guided`], the fast form): inside each window the mask becomes the
//! least-squares affine function of the luminance, so where the picture has an edge the mask's transition moves
//! onto it, and where the picture is flat the mask is smoothed. The radius is [`REFINE_RADIUS_1080`] px at a 1080 px
//! short side, scaled with the picture; `eps` [`REFINE_EPS`] is in sRGB-encoded luminance squared (an edge of about
//! 0.03 in luminance is enough to steer the mask). The result is clamped to 0..1.

use super::preprocess::to_srgb;
use crate::image::LinearImage;
use crate::local::guided::guided_filter;
use crate::masks::MaskPlane;

/// Guided-filter radius at a 1080 px short side.
pub const REFINE_RADIUS_1080: f32 = 8.0;
/// Guided-filter regulariser (sRGB-encoded luminance units squared).
pub const REFINE_EPS: f32 = 1e-3;

/// The refinement guide: sRGB-encoded luminance (Rec.709 weights on the sRGB-primaries picture the models see),
/// `width × height` values in 0..1.
pub fn guide_luma(image: &LinearImage) -> Vec<f32> {
    to_srgb(image).chunks_exact(3).map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).collect()
}

/// The radius for a `w × h` picture: [`REFINE_RADIUS_1080`] scaled by the short side / 1080, at least 2 px.
pub fn refine_radius(w: u32, h: u32) -> f32 {
    (REFINE_RADIUS_1080 * w.min(h) as f32 / 1080.0).max(2.0)
}

/// Bilinear resize to `w × h` (pixel centres aligned; a clone when the size matches).
pub fn upsample_to(plane: &MaskPlane, w: u32, h: u32) -> MaskPlane {
    plane.resized(w, h)
}

/// `mask` (any size) upsampled to the guide's `w × h` and guided-filtered against it with `radius` px and `eps`,
/// clamped to 0..1.
pub fn refine_with(mask: &MaskPlane, guide: &[f32], w: u32, h: u32, radius: f32, eps: f32) -> MaskPlane {
    assert_eq!(guide.len(), w as usize * h as usize, "guide has the wrong size");
    let up = upsample_to(mask, w, h);
    if w == 0 || h == 0 {
        return up;
    }
    let mut data = guided_filter(guide, Some(&up.data), w as usize, h as usize, radius, eps);
    for v in &mut data {
        *v = v.clamp(0.0, 1.0);
    }
    MaskPlane::new(w, h, data)
}

/// [`refine_with`] at the defaults, against `image`'s luminance at its own size.
pub fn refine(mask: &MaskPlane, image: &LinearImage) -> MaskPlane {
    let guide = guide_luma(image);
    refine_with(mask, &guide, image.width, image.height, refine_radius(image.width, image.height), REFINE_EPS)
}
