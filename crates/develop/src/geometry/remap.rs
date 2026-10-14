//! Re-mapping vector masks and Upright guides when the perspective changes (plan section 2, "Masks and
//! geometry"): they are stored in fractions of the transformed, uncropped frame, so a new geometry moves
//! them through `H_new · H_old⁻¹` and they stay on the image content they were drawn on. Pure functions;
//! the UI/store calls them when it changes the geometry. AI mask rasters are regenerated instead.

use super::homography::Homography;
use super::transform::pre_crop_matrix;
use crate::settings::{Geometry, Mask, MaskShape, Point, UprightGuide};

/// `H_new · H_old⁻¹`, or `None` when `h_old` is singular.
pub fn remap_matrix(h_old: &Homography, h_new: &Homography) -> Option<Homography> {
    Some(h_old.invert()?.then(h_new).normalized())
}

/// Map `points` (normalised coordinates of the frame `h_old` maps into) through `H_new · H_old⁻¹`.
/// Returns them unchanged when `h_old` is singular.
pub fn remap_points(points: &[Point], h_old: &Homography, h_new: &Homography) -> Vec<Point> {
    match remap_matrix(h_old, h_new) {
        Some(m) => points.iter().map(|&p| m.apply(p)).collect(),
        None => points.to_vec(),
    }
}

/// Re-map every vector mask component and guide from the transformed frame of `old` to that of `new`,
/// for a decoded `source_width × source_height` image. Both maps are the full pre-crop map
/// ([`pre_crop_matrix`]: orientation, Upright, manual Transform), so rotate and flip changes are
/// followed too. Brush stroke points, linear `from`/`to`, radial `center` and guide endpoints are mapped
/// exactly; a radial's radii and angle follow the local Jacobian at its centre (in pixel-proportional
/// units, radii as fractions of the frame width and height), which is approximate under perspective.
/// Brush sizes, luminance/colour ranges and AI prompts are left alone.
pub fn remap_geometry_vectors(
    old: &Geometry,
    new: &Geometry,
    source_width: u32,
    source_height: u32,
    masks: &mut [Mask],
    guides: &mut [UprightGuide],
) {
    let h_old = pre_crop_matrix(old, source_width, source_height);
    let h_new = pre_crop_matrix(new, source_width, source_height);
    let Some(m) = remap_matrix(&h_old, &h_new) else { return };
    // Frame aspects (width / height) before and after (90/270 swap them).
    let aspect = |g: &Geometry| {
        let (w, h) = super::orientation::oriented_size(g.rotate, source_width.max(1), source_height.max(1));
        w as f64 / h as f64
    };
    let (a_old, a_new) = (aspect(old), aspect(new));
    for mask in masks.iter_mut() {
        for component in mask.components.iter_mut() {
            match &mut component.shape {
                MaskShape::Brush { strokes } => {
                    for stroke in strokes.iter_mut() {
                        for p in stroke.points.iter_mut() {
                            *p = m.apply(*p);
                        }
                    }
                }
                MaskShape::Linear { from, to } => {
                    *from = m.apply(*from);
                    *to = m.apply(*to);
                }
                MaskShape::Radial { center, radii, angle, .. } => {
                    // Jacobian in units proportional to pixels: x scaled by the frame aspect.
                    let [a, b, c, d] = m.jacobian(*center);
                    let jm = [a * a_new / a_old, b * a_new, c / a_old, d];
                    let (s, co) = angle.to_radians().sin_cos();
                    let e1 = [radii[0] * a_old * co, radii[0] * a_old * s];
                    let e2 = [-radii[1] * s, radii[1] * co];
                    let map = |e: [f64; 2]| [jm[0] * e[0] + jm[1] * e[1], jm[2] * e[0] + jm[3] * e[1]];
                    let (f1, f2) = (map(e1), map(e2));
                    let r1 = f1[0].hypot(f1[1]);
                    let r2 = f2[0].hypot(f2[1]);
                    if r1.is_finite() && r2.is_finite() && r1 > 0.0 && r2 > 0.0 {
                        *angle = f1[1].atan2(f1[0]).to_degrees();
                        *radii = [r1 / a_new, r2];
                    }
                    *center = m.apply(*center);
                }
                MaskShape::Luminance { .. } | MaskShape::Color { .. } | MaskShape::Ai { .. } => {}
            }
        }
    }
    for g in guides.iter_mut() {
        g.from = m.apply(g.from);
        g.to = m.apply(g.to);
    }
}
