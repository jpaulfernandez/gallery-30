//! The whole geometry as one homography, and the output framing.
//!
//! In normalised coordinates (0..1 of each frame) the forward map is
//!
//! `H = T_crop · R(straighten, about the crop centre) · M_manual · H_upright · O_orientation`
//!
//! (the plan's "Geometry model" row; rightmost applies first). `O` is the user rotate/flip
//! ([`super::orientation`]), `H_upright` the stored Upright homography ([`upright_matrix`]), `M_manual` the
//! seven Transform sliders ([`manual_matrix_with_focal`]), `R` turns the picture about the crop centre in
//! frame *pixels* (so the rotation is metric), and `T_crop` maps the crop rectangle onto the output.
//! The transformed frame keeps the oriented frame's size; with a perspective part and `constrainCrop`,
//! the crop is shrunk to the warped outline ([`warped_region`], [`constrain_crop_in_polygon`]). [`GeometryPlan::inverse`] is the same map in pixels, output → source,
//! which is what [`super::warp`] needs.

use super::crop::{clip_to_frame, constrain_crop, constrain_crop_in_polygon, max_crop, max_rect_in_polygon};
use super::homography::Homography;
use super::orientation::{orientation_matrix, oriented_size};
use crate::decode::fit;
use crate::settings::{AspectPreset, CropAspect, CropRect, Geometry, ManualTransform, Upright, UprightMode};

/// How to warp one image for one [`Geometry`]: the output size and the per-pixel inverse map.
#[derive(Debug, Clone, PartialEq)]
pub struct GeometryPlan {
    /// Size of the image the plan was made for (the decoded, EXIF-upright image).
    pub source_width: u32,
    pub source_height: u32,
    /// Size of the warped output (the crop, fitted to `target_long_edge` when one was given).
    pub output_width: u32,
    pub output_height: u32,
    /// Output pixel → source pixel, continuous coordinates where pixel `i` spans `[i, i + 1)` (so pixel
    /// centres sit at `i + 0.5`). Normalised so `h8 = 1`.
    pub inverse: Homography,
    /// Source normalised (0..1) → output normalised (0..1): the plan's `H`.
    pub forward: Homography,
    /// Size of the crop at the source's own resolution (before any `target_long_edge`): what a full-size
    /// render of this source outputs. Write it to the cache meta.
    pub developed_size: (u32, u32),
    /// The crop actually used, fractions of the transformed frame (after constrain and pixel snapping).
    pub crop: CropRect,
    /// Straighten angle used, degrees clockwise (clamped to −45..45).
    pub angle: f64,
    /// Size of the transformed, uncropped frame in source pixels (= the oriented size).
    pub frame_size: (u32, u32),
}

/// `H_upright` in normalised coordinates of the oriented image (applied after `O`): the stored
/// `upright.transform` when the mode is not `off` and the matrix is finite and invertible, else identity.
/// Renders never run the solver; the UI writes [`super::upright::solve_guided`]'s result (already
/// recentred and rescaled) into `upright.transform`. Mode `off` ignores a stored transform.
pub fn upright_matrix(upright: &Upright) -> Homography {
    match (&upright.mode, &upright.transform) {
        (UprightMode::Off, _) | (_, None) => Homography::identity(),
        (_, Some(t)) => {
            let h = Homography(*t);
            if t.iter().all(|v| v.is_finite()) && h.invert().is_some() {
                h
            } else {
                Homography::identity()
            }
        }
    }
}

/// Keystone angle at ±100 on the Vertical and Horizontal sliders, degrees.
pub const KEYSTONE_MAX_DEGREES: f64 = 30.0;
/// Aspect slider: each axis scales by `2^(±ASPECT_LOG2 · aspect / 100)`.
pub const ASPECT_LOG2: f64 = 0.137;

/// Normalised (0..1) frame coordinates → centred long-edge units (the frame centre at the origin, the
/// long edge 1 long), for a `frame_w × frame_h` frame (any unit; only the aspect matters).
pub fn centred_units(frame_w: f64, frame_h: f64) -> Homography {
    let long = frame_w.max(frame_h);
    let (ax, ay) = (frame_w / long, frame_h / long);
    Homography([ax, 0.0, -0.5 * ax, 0.0, ay, -0.5 * ay, 0.0, 0.0, 1.0])
}

/// Inverse of [`centred_units`].
pub fn from_centred_units(frame_w: f64, frame_h: f64) -> Homography {
    let long = frame_w.max(frame_h);
    let (ax, ay) = (frame_w / long, frame_h / long);
    Homography([1.0 / ax, 0.0, 0.5, 0.0, 1.0 / ay, 0.5, 0.0, 0.0, 1.0])
}

/// A 3×3 rotation (row-major) as a homography.
fn rotation_3d(r: [[f64; 3]; 3]) -> Homography {
    Homography([r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]])
}

/// The conjugate rotation `K · R · K⁻¹` with `K = diag(f, f, 1)` (centred units, principal point at the
/// origin). `r` is row-major.
pub fn conjugate_rotation(r: [[f64; 3]; 3], focal: f64) -> Homography {
    let k = Homography::scale(focal, focal);
    let k_inv = Homography::scale(1.0 / focal, 1.0 / focal);
    k * rotation_3d(r) * k_inv
}

/// `R = R_x(pitch) · R_y(yaw)` (radians, row-major; yaw applies first). With y pointing down, a positive
/// pitch widens the top of the image under `K R K⁻¹`, a positive yaw enlarges the right side.
pub fn pitch_yaw(pitch: f64, yaw: f64) -> [[f64; 3]; 3] {
    let (sp, cp) = pitch.sin_cos();
    let (sy, cy) = yaw.sin_cos();
    // R_x = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]], R_y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]].
    [[cy, 0.0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]]
}

/// Recentre and rescale a map in centred long-edge units: translate so the frame centre (the origin)
/// maps to itself, then scale uniformly so the two centre lines (horizontal across the frame width,
/// vertical across its height, `extent = (width, height)` in the same units) keep their lengths on
/// geometric average. Translation and uniform scale keep lines straight and angles unchanged.
pub fn recentre_and_rescale(h: &Homography, extent: (f64, f64)) -> Homography {
    let (hw, hh) = (0.5 * extent.0, 0.5 * extent.1);
    let c = h.apply([0.0, 0.0]);
    let len = |a: [f64; 2], b: [f64; 2]| ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let lh = len(h.apply([-hw, 0.0]), h.apply([hw, 0.0])) / extent.0;
    let lv = len(h.apply([0.0, -hh]), h.apply([0.0, hh])) / extent.1;
    let k = 1.0 / (lh * lv).sqrt();
    if !(k.is_finite() && k > 0.0 && c[0].is_finite() && c[1].is_finite()) {
        return *h;
    }
    h.then(&Homography::translate(-c[0], -c[1])).then(&Homography::scale(k, k))
}

/// `M_manual` in normalised (0..1) coordinates of a `frame_w × frame_h` frame (any unit), with the
/// keystone focal at the long edge. See [`manual_matrix_with_focal`].
pub fn manual_matrix(transform: &ManualTransform, frame_w: f64, frame_h: f64) -> Homography {
    manual_matrix_with_focal(transform, frame_w, frame_h, None)
}

/// `M_manual = offset · scale · aspect · keystone · rotate` (rotate applies first), built in centred
/// long-edge units (origin at the frame centre, long edge 1) and returned in normalised (0..1) frame
/// coordinates, applied after `H_upright`. Exactly the identity when every slider is at its default.
///
/// - **Rotate** (−10..10): degrees about the centre, positive clockwise on screen (as straighten).
/// - **Vertical / Horizontal** (−100..100): keystone as a virtual camera rotation `K · R · K⁻¹`,
///   `K = diag(f, f, 1)`, `R = R_x(pitch) · R_y(yaw)`, `pitch = −vertical / 100 · 30°`,
///   `yaw = horizontal / 100 · 30°`; `f` is `focal` (long-edge units, when finite and positive) or 1
///   (the long edge). Negative Vertical widens the top (corrects converging verticals), positive widens
///   the bottom; positive Horizontal enlarges the right side, negative the left. Then
///   [`recentre_and_rescale`] keeps the centre fixed and the centre lines' length.
/// - **Aspect** (−100..100): x scales by `2^(0.137 · a / 100)`, y by `2^(−0.137 · a / 100)` (positive
///   stretches horizontally).
/// - **Scale** (50..150): uniform `scale / 100` about the centre.
/// - **Offset X / Y** (−100..100): translation by `offset / 100` long edges; positive X moves the
///   picture right, positive Y moves it down.
pub fn manual_matrix_with_focal(transform: &ManualTransform, frame_w: f64, frame_h: f64, focal: Option<f64>) -> Homography {
    if *transform == ManualTransform::default() {
        return Homography::identity();
    }
    let t = transform;
    let finite = |v: f64, d: f64| if v.is_finite() { v } else { d };
    let long = frame_w.max(frame_h);
    let extent = (frame_w / long, frame_h / long);

    let rotate = Homography::rotate(finite(t.rotate, 0.0).to_radians());
    let (v, hz) = (finite(t.vertical, 0.0), finite(t.horizontal, 0.0));
    let keystone = if v == 0.0 && hz == 0.0 {
        Homography::identity()
    } else {
        let f = focal.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(1.0);
        let max = KEYSTONE_MAX_DEGREES.to_radians();
        let r = pitch_yaw(-v / 100.0 * max, hz / 100.0 * max);
        recentre_and_rescale(&conjugate_rotation(r, f), extent)
    };
    let e = ASPECT_LOG2 * finite(t.aspect, 0.0) / 100.0;
    let aspect = Homography::scale(e.exp2(), (-e).exp2());
    let s = finite(t.scale, 100.0) / 100.0;
    let scale = Homography::scale(s, s);
    let offset = Homography::translate(finite(t.offset_x, 0.0) / 100.0, finite(t.offset_y, 0.0) / 100.0);
    let centred = rotate.then(&keystone).then(&aspect).then(&scale).then(&offset);
    centred_units(frame_w, frame_h).then(&centred).then(&from_centred_units(frame_w, frame_h)).normalized()
}

/// Whether the geometry has a perspective part (an active Upright transform or a non-default manual
/// Transform), i.e. whether `H_upright · M_manual` can differ from the identity.
pub fn has_perspective(geometry: &Geometry) -> bool {
    let upright = geometry.upright.mode != UprightMode::Off && geometry.upright.transform.is_some();
    upright || geometry.transform != ManualTransform::default()
}

/// `M_manual · H_upright` in normalised coordinates: the oriented frame → the transformed frame, for a
/// `frame_w × frame_h` oriented frame. The manual keystone uses `upright.focal` when it is set.
pub fn perspective_matrix(geometry: &Geometry, frame_w: f64, frame_h: f64) -> Homography {
    let u = upright_matrix(&geometry.upright);
    let m = manual_matrix_with_focal(&geometry.transform, frame_w, frame_h, geometry.upright.focal);
    u.then(&m)
}

/// `M_manual · H_upright · O` in normalised coordinates: the decoded source → the transformed, uncropped
/// frame (everything before straighten and crop). Masks and guides live in its output frame.
pub fn pre_crop_matrix(geometry: &Geometry, source_width: u32, source_height: u32) -> Homography {
    let (fw, fh) = oriented_size(geometry.rotate, source_width.max(1), source_height.max(1));
    orientation_matrix(geometry).then(&perspective_matrix(geometry, fw as f64, fh as f64))
}

/// The valid region of the transformed frame in frame units (`frame_w / frame_h` wide, 1 high): the
/// outline of the image after `perspective` (normalised map), clipped to the frame. `None` when a corner
/// maps through infinity.
pub fn warped_region(perspective: &Homography, frame_w: f64, frame_h: f64) -> Option<Vec<[f64; 2]>> {
    let ia = frame_w / frame_h;
    let m = &perspective.0;
    let corners = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let w0 = m[6] * corners[0][0] + m[7] * corners[0][1] + m[8];
    let same_side = corners.iter().all(|p| {
        let w = m[6] * p[0] + m[7] * p[1] + m[8];
        w * w0 > 0.0 && w.abs() > 1e-12
    });
    if !same_side {
        return None;
    }
    let quad: Vec<[f64; 2]> = corners
        .iter()
        .map(|&p| {
            let q = perspective.apply(p);
            [q[0] * ia, q[1]]
        })
        .collect();
    if !quad.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
        return None;
    }
    Some(clip_to_frame(&quad, ia, 1.0))
}

/// The largest crop for the geometry's crop aspect (the frame's aspect when free or original) and
/// straighten angle that fits inside the warped image (Upright + manual Transform) clipped to the frame,
/// its centre placed by [`max_rect_in_polygon`]: the UI's auto-fit (store it as the crop rect; the render
/// then keeps it as is).
/// `frame_w × frame_h` is the oriented frame (any unit). Without a perspective part this is
/// [`max_crop`](super::crop::max_crop).
pub fn max_crop_in_warped(geometry: &Geometry, frame_w: f64, frame_h: f64) -> CropRect {
    let ia = frame_w / frame_h;
    let (angle, aspect) = match &geometry.crop {
        Some(c) => (
            if c.angle.is_finite() { c.angle.clamp(-45.0, 45.0) } else { 0.0 },
            crop_aspect_ratio(&c.aspect, (frame_w, frame_h)),
        ),
        None => (0.0, None),
    };
    if !has_perspective(geometry) {
        return max_crop(aspect, angle, ia);
    }
    match warped_region(&perspective_matrix(geometry, frame_w, frame_h), frame_w, frame_h) {
        Some(poly) if poly.len() >= 3 => max_rect_in_polygon(&poly, aspect, angle, ia),
        _ => max_crop(aspect, angle, ia),
    }
}

/// The aspect lock as width / height in frame pixels (`None` for free).
pub fn crop_aspect_ratio(aspect: &CropAspect, frame_size: (f64, f64)) -> Option<f64> {
    match aspect {
        CropAspect::Preset(AspectPreset::Free) => None,
        CropAspect::Preset(AspectPreset::Original) => Some(frame_size.0 / frame_size.1),
        CropAspect::Ratio(w, h) => (*w > 0.0 && *h > 0.0 && (w / h).is_finite()).then(|| w / h),
    }
}

impl GeometryPlan {
    /// Plan the warp of a `source_width × source_height` image (EXIF orientation already applied).
    /// `target_long_edge` fits the output inside that long edge (never upscales); `None` keeps the
    /// source resolution.
    ///
    /// No crop means the full frame. With `constrain_crop` the stored crop is shrunk (never enlarged)
    /// until it fits inside the image straightened by the crop angle ([`constrain_crop`]; after an Upright
    /// or manual Transform warp, inside the warped outline clipped to the frame,
    /// [`constrain_crop_in_polygon`]); without it,
    /// an angled crop is used as stored and its corners clamp to the image edge when sampled. At angle 0
    /// the crop is snapped to whole source pixels so crop-only renders are exact copies.
    pub fn new(geometry: &Geometry, source_width: u32, source_height: u32, target_long_edge: Option<u32>) -> GeometryPlan {
        let (sw, sh) = (source_width.max(1), source_height.max(1));
        let (fw_u, fh_u) = oriented_size(geometry.rotate, sw, sh);
        let (fw, fh) = (fw_u as f64, fh_u as f64);

        // Normalised source → normalised transformed frame.
        let o = orientation_matrix(geometry);
        let perspective = has_perspective(geometry).then(|| perspective_matrix(geometry, fw, fh));
        let pre_crop = match &perspective {
            Some(p) => o.then(p),
            None => o,
        };

        let (rect, angle, aspect) = match &geometry.crop {
            Some(c) => {
                let angle = if c.angle.is_finite() { c.angle.clamp(-45.0, 45.0) } else { 0.0 };
                (c.rect.clone(), angle, crop_aspect_ratio(&c.aspect, (fw, fh)))
            }
            None => (CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 0.0, None),
        };
        let valid = [rect.x, rect.y, rect.w, rect.h].iter().all(|v| v.is_finite()) && rect.w > 0.0 && rect.h > 0.0;
        let rect = if valid { rect } else { CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 } };
        let image_aspect = fw / fh;
        let region = perspective.as_ref().and_then(|p| warped_region(p, fw, fh)).filter(|r| r.len() >= 3);
        let rect = if geometry.constrain_crop {
            match &region {
                // After a warp the valid region is the warped outline (clipped to the frame).
                Some(poly) => constrain_crop_in_polygon(rect, aspect, angle, image_aspect, poly),
                None => constrain_crop(rect, aspect, angle, image_aspect),
            }
        } else if angle == 0.0 {
            constrain_crop(rect, None, 0.0, image_aspect)
        } else {
            rect
        };

        // Crop in frame pixels.
        // Snap to whole pixels only without a perspective part: rounding outwards could leave a warped outline.
        let axis_aligned = angle == 0.0 && perspective.is_none() && pre_crop.is_affine(0.0);
        let (x0, y0, cw, ch, developed) = if axis_aligned {
            let snap = |a: f64, b: f64, size: f64| {
                let lo = (a * size).round().clamp(0.0, size - 1.0);
                let hi = (b * size).round().clamp(lo + 1.0, size);
                (lo, hi)
            };
            let (x0, x1) = snap(rect.x, rect.x + rect.w, fw);
            let (y0, y1) = snap(rect.y, rect.y + rect.h, fh);
            (x0, y0, x1 - x0, y1 - y0, ((x1 - x0) as u32, (y1 - y0) as u32))
        } else {
            let (cw, ch) = (rect.w * fw, rect.h * fh);
            (rect.x * fw, rect.y * fh, cw, ch, ((cw.round() as u32).max(1), (ch.round() as u32).max(1)))
        };
        let crop = CropRect { x: x0 / fw, y: y0 / fh, w: cw / fw, h: ch / fh };
        let (ow, oh) = match target_long_edge {
            Some(edge) if edge > 0 => fit(developed.0, developed.1, edge),
            _ => developed,
        };

        // Pixel-space forward map: source px → output px.
        let (ccx, ccy) = (x0 + cw / 2.0, y0 + ch / 2.0);
        let forward_px = Homography::scale(1.0 / sw as f64, 1.0 / sh as f64)
            .then(&pre_crop)
            .then(&Homography::scale(fw, fh))
            .then(&Homography::rotate_about(angle.to_radians(), ccx, ccy))
            .then(&Homography::translate(-x0, -y0))
            .then(&Homography::scale(ow as f64 / cw, oh as f64 / ch));
        let inverse = forward_px.invert().unwrap_or_default().normalized();
        let forward = Homography::scale(sw as f64, sh as f64)
            .then(&forward_px)
            .then(&Homography::scale(1.0 / ow as f64, 1.0 / oh as f64))
            .normalized();

        GeometryPlan {
            source_width: sw,
            source_height: sh,
            output_width: ow,
            output_height: oh,
            inverse,
            forward,
            developed_size: developed,
            crop,
            angle,
            frame_size: (fw_u, fh_u),
        }
    }

    /// Normalised transformed, uncropped frame (0..1, where mask vectors live) → output pixel coordinates
    /// (pixel `i` spans `[i, i + 1)`): `scale(frame) · R(straighten, about the crop centre) · T(−crop
    /// origin) · scale(output / crop)`, the tail of the forward map. A similarity of frame pixels, so its
    /// Jacobian columns are the frame width and height in output pixels. Used by `masks`.
    pub fn frame_to_output_matrix(&self) -> Homography {
        let (fw, fh) = (self.frame_size.0 as f64, self.frame_size.1 as f64);
        let (x0, y0, cw, ch) = (self.crop.x * fw, self.crop.y * fh, self.crop.w * fw, self.crop.h * fh);
        Homography::scale(fw, fh)
            .then(&Homography::rotate_about(self.angle.to_radians(), x0 + cw / 2.0, y0 + ch / 2.0))
            .then(&Homography::translate(-x0, -y0))
            .then(&Homography::scale(self.output_width as f64 / cw, self.output_height as f64 / ch))
            .normalized()
    }

    /// True when the warp would return the source unchanged (same size, identity map).
    pub fn is_identity(&self) -> bool {
        (self.output_width, self.output_height) == (self.source_width, self.source_height)
            && self.inverse.0.iter().zip(Homography::identity().0.iter()).all(|(a, b)| (a - b).abs() <= 1e-9)
    }
}

/// Size of a full-resolution render of a `width × height` source with this geometry (the cropped size).
pub fn developed_size(geometry: &Geometry, width: u32, height: u32) -> (u32, u32) {
    GeometryPlan::new(geometry, width, height, None).developed_size
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Crop, Rotation};

    #[test]
    fn default_geometry_is_identity() {
        let p = GeometryPlan::new(&Geometry::default(), 640, 427, None);
        assert!(p.is_identity());
        assert_eq!(p.developed_size, (640, 427));
        let p = GeometryPlan::new(&Geometry::default(), 640, 427, Some(320));
        assert_eq!((p.output_width, p.output_height), (320, 214));
        assert!(!p.is_identity());
    }

    #[test]
    fn rotation_swaps_the_size_and_maps_corners() {
        let g = Geometry { rotate: Rotation::R90, ..Geometry::default() };
        let p = GeometryPlan::new(&g, 40, 30, None);
        assert_eq!((p.output_width, p.output_height), (30, 40));
        // Output top-left pixel centre comes from the source's bottom-left pixel centre.
        let s = p.inverse.apply([0.5, 0.5]);
        assert!((s[0] - 0.5).abs() < 1e-12 && (s[1] - 29.5).abs() < 1e-12, "{s:?}");
    }

    #[test]
    fn crop_is_snapped_at_angle_zero() {
        let g = Geometry {
            crop: Some(Crop {
                rect: CropRect { x: 0.2501, y: 0.25, w: 0.5, h: 0.5 },
                angle: 0.0,
                aspect: CropAspect::default(),
            }),
            ..Geometry::default()
        };
        let p = GeometryPlan::new(&g, 100, 80, None);
        assert_eq!(p.developed_size, (50, 40));
        assert_eq!(p.inverse.apply([0.5, 0.5]), [25.5, 20.5]);
    }

    #[test]
    fn straighten_shrinks_the_crop() {
        let g = Geometry {
            crop: Some(Crop { rect: CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, angle: 5.0, aspect: CropAspect::default() }),
            ..Geometry::default()
        };
        let p = GeometryPlan::new(&g, 600, 400, None);
        assert!(p.developed_size.0 < 600 && p.developed_size.1 < 400);
        let r = p.developed_size.0 as f64 / p.developed_size.1 as f64;
        assert!((r - 1.5).abs() < 0.01);
    }
}
