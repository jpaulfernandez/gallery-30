//! Inscribed-rectangle maths for crop and straighten.
//!
//! Written to be transliterated to TypeScript as is (the crop overlay computes the same numbers; parity
//! fixtures in `tests/fixtures/geometry/` pin them to 1e-9): plain `f64`, degrees in, no clever types.
//!
//! **The crop model.** The crop rectangle is axis-aligned and stored in fractions of the *transformed,
//! uncropped* frame (after rotate/flip, Upright and the manual Transform). The straighten angle turns the
//! image (not the frame) about the crop centre, clockwise for a positive angle. So the frame stays square
//! to the screen and the picture rotates behind it, as in Lightroom. Working in frame units where the
//! frame is `image_aspect` wide and 1 high keeps rotations metric.

use crate::settings::CropRect;

fn rad(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

/// (a) The classic maximum-area axis-aligned rectangle inside a `w × h` rectangle rotated by
/// `angle_deg`, both centred on the same point. Returns `(width, height)`. The aspect is free (this is
/// the max-area answer); use [`fixed_aspect_half_width`] to keep an aspect.
///
/// When the short side is at most `2·sinθ·cosθ·long` the solution is half-constrained: two opposite
/// corners touch the long sides only.
pub fn max_area_rect_in_rotated(w: f64, h: f64, angle_deg: f64) -> (f64, f64) {
    if w <= 0.0 || h <= 0.0 {
        return (0.0, 0.0);
    }
    let width_is_longer = w >= h;
    let (long, short) = if width_is_longer { (w, h) } else { (h, w) };
    let a = rad(angle_deg);
    let sin_a = a.sin().abs();
    let cos_a = a.cos().abs();
    if short <= 2.0 * sin_a * cos_a * long || (sin_a - cos_a).abs() < 1e-10 {
        let x = 0.5 * short;
        if width_is_longer {
            (x / sin_a, x / cos_a)
        } else {
            (x / cos_a, x / sin_a)
        }
    } else {
        let cos_2a = cos_a * cos_a - sin_a * sin_a;
        ((w * cos_a - h * sin_a) / cos_2a, (h * cos_a - w * sin_a) / cos_2a)
    }
}

/// (b) The fixed-aspect zoom factor `p(φ) = min(a / (cosφ + sinφ/r), b / (sinφ + cosφ/r))`: the half width
/// of the largest rectangle of aspect `r` (width / height) centred on a point whose distances to the
/// nearest vertical and horizontal edges of the (unrotated) image are `a` and `b`, when the image is
/// rotated by `angle_deg` about that point. The half height is `p / r`.
pub fn fixed_aspect_half_width(a: f64, b: f64, r: f64, angle_deg: f64) -> f64 {
    let phi = rad(angle_deg);
    let s = phi.sin().abs();
    let c = phi.cos().abs();
    let p1 = a / (c + s / r);
    let p2 = b / (s + c / r);
    p1.min(p2).max(0.0)
}

/// Whether `p` is inside (or on) the convex polygon `quad` (either winding).
pub fn point_in_convex_quad(quad: &[[f64; 2]; 4], p: [f64; 2]) -> bool {
    let mut pos = false;
    let mut neg = false;
    for i in 0..4 {
        let a = quad[i];
        let b = quad[(i + 1) % 4];
        let cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if cross > 0.0 {
            pos = true;
        } else if cross < 0.0 {
            neg = true;
        }
    }
    !(pos && neg)
}

/// Bisection steps in [`largest_rect_in_quad`]: fixed so the TS twin gives identical numbers.
pub const QUAD_SEARCH_STEPS: u32 = 64;

/// (c) The largest axis-aligned rectangle of aspect `aspect` (width / height) centred on `center` inside
/// the convex quad `quad` (e.g. the warped image outline after perspective), by bisection on the half
/// width with point-in-polygon tests on the four corners. Returns `(half_width, half_height)`; `(0, 0)`
/// when the centre is outside the quad.
pub fn largest_rect_in_quad(quad: &[[f64; 2]; 4], center: [f64; 2], aspect: f64) -> (f64, f64) {
    if !(aspect > 0.0) || !point_in_convex_quad(quad, center) {
        return (0.0, 0.0);
    }
    let fits = |hw: f64| {
        let hh = hw / aspect;
        let [cx, cy] = center;
        [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]]
            .iter()
            .all(|&p| point_in_convex_quad(quad, p))
    };
    let xs = quad.iter().map(|p| p[0]);
    let ys = quad.iter().map(|p| p[1]);
    let span_x = xs.clone().fold(f64::NEG_INFINITY, f64::max) - xs.fold(f64::INFINITY, f64::min);
    let span_y = ys.clone().fold(f64::NEG_INFINITY, f64::max) - ys.fold(f64::INFINITY, f64::min);
    let mut lo = 0.0;
    let mut hi = span_x.max(span_y * aspect);
    for _ in 0..QUAD_SEARCH_STEPS {
        let mid = 0.5 * (lo + hi);
        if fits(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo, lo / aspect)
}

/// Make a crop valid for a straighten angle: the rectangle `rect` (fractions of a frame whose width /
/// height is `image_aspect`) is
///
/// 1. narrowed to `aspect` (width / height, in frame pixels) when given, keeping its centre: the largest
///    rectangle of that aspect inside it;
/// 2. at angle 0, intersected with the frame (`aspect` is then re-applied about the new centre);
/// 3. shrunk about its centre (centre clamped into the frame) until it fits inside the image rotated by
///    `angle_deg` about that centre.
///
/// A rectangle that already fits (and has the aspect, to 1e-12 relative) is returned exactly as given
/// (never enlarged, no float round trip), so the render can re-apply this to stored crops. For "fill the frame at this angle" start from the full rectangle ([`max_crop`]).
pub fn constrain_crop(rect: CropRect, aspect: Option<f64>, angle_deg: f64, image_aspect: f64) -> CropRect {
    let fw = image_aspect;
    let mut changed = false;
    let mut x0 = rect.x * fw;
    let mut y0 = rect.y;
    let mut x1 = (rect.x + rect.w) * fw;
    let mut y1 = rect.y + rect.h;
    if angle_deg == 0.0 && (x0 < 0.0 || y0 < 0.0 || x1 > fw || y1 > 1.0) {
        changed = true;
        x0 = x0.max(0.0);
        y0 = y0.max(0.0);
        x1 = x1.min(fw);
        y1 = y1.min(1.0);
    }
    let mut cx = 0.5 * (x0 + x1);
    let mut cy = 0.5 * (y0 + y1);
    let mut hw = (0.5 * (x1 - x0)).max(0.0);
    let mut hh = (0.5 * (y1 - y0)).max(0.0);
    if let Some(r) = aspect.filter(|r| *r > 0.0 && r.is_finite()) {
        // Only when the aspect is off by more than rounding, so a locked rect comes back unchanged.
        if hh > 0.0 && (hw / hh - r).abs() > 1e-12 * r {
            changed = true;
            if hw / hh > r {
                hw = hh * r;
            } else {
                hh = hw / r;
            }
        }
    }
    if cx < 0.0 || cx > fw || cy < 0.0 || cy > 1.0 {
        changed = true;
        cx = cx.clamp(0.0, fw);
        cy = cy.clamp(0.0, 1.0);
    }
    let phi = rad(angle_deg);
    let s = phi.sin().abs();
    let c = phi.cos().abs();
    let ex = hw * c + hh * s;
    let ey = hw * s + hh * c;
    let a = cx.min(fw - cx);
    let b = cy.min(1.0 - cy);
    let mut k = 1.0f64;
    if ex > a {
        k = k.min(a / ex);
    }
    if ey > b {
        k = k.min(b / ey);
    }
    if k < 1.0 {
        changed = true;
        hw *= k;
        hh *= k;
    }
    if !changed {
        return rect;
    }
    CropRect { x: (cx - hw) / fw, y: cy - hh, w: 2.0 * hw / fw, h: 2.0 * hh }
}

/// The largest crop of `aspect` (width / height in frame pixels; `None` keeps the frame's own aspect)
/// centred in the frame, for the straighten angle: what the crop becomes when constrain-to-image is on
/// and the user rotates an uncropped photo.
pub fn max_crop(aspect: Option<f64>, angle_deg: f64, image_aspect: f64) -> CropRect {
    constrain_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, aspect, angle_deg, image_aspect)
}

/// Whether `p` is inside (or on) the convex polygon `poly` (either winding, any vertex count ≥ 3).
pub fn point_in_convex_polygon(poly: &[[f64; 2]], p: [f64; 2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut pos = false;
    let mut neg = false;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if cross > 0.0 {
            pos = true;
        } else if cross < 0.0 {
            neg = true;
        }
    }
    !(pos && neg)
}

/// Sutherland–Hodgman clip of the convex polygon `poly` to the frame `[0, frame_w] × [0, frame_h]`.
/// The result is convex (possibly empty). Clip order: left, right, top, bottom.
pub fn clip_to_frame(poly: &[[f64; 2]], frame_w: f64, frame_h: f64) -> Vec<[f64; 2]> {
    // Each edge: (axis, bound, keep_greater).
    let edges = [(0usize, 0.0, true), (0, frame_w, false), (1, 0.0, true), (1, frame_h, false)];
    let mut out: Vec<[f64; 2]> = poly.to_vec();
    for (axis, bound, keep_greater) in edges {
        if out.is_empty() {
            break;
        }
        let inside = |p: &[f64; 2]| if keep_greater { p[axis] >= bound } else { p[axis] <= bound };
        let input = std::mem::take(&mut out);
        let n = input.len();
        for i in 0..n {
            let cur = input[i];
            let prev = input[(i + n - 1) % n];
            let (ci, pi) = (inside(&cur), inside(&prev));
            if ci != pi {
                let t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
                let mut q = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
                q[axis] = bound;
                out.push(q);
            }
            if ci {
                out.push(cur);
            }
        }
    }
    out
}

/// [`constrain_crop`] for a warped image: the valid region is the convex polygon `poly` (frame units, the
/// frame `image_aspect` wide and 1 high; typically the warped image outline clipped to the frame,
/// before straighten). The rectangle is
///
/// 1. narrowed to `aspect` about its centre when given (as in [`constrain_crop`]);
/// 2. re-centred on the polygon's vertex average if its centre lies outside the polygon;
/// 3. shrunk about its centre (never enlarged) until its corners lie inside the polygon turned by
///    `angle_deg` (clockwise) about that centre, by bisection on the scale ([`QUAD_SEARCH_STEPS`] steps).
///
/// A rectangle that already fits is returned exactly as given.
pub fn constrain_crop_in_polygon(
    rect: CropRect,
    aspect: Option<f64>,
    angle_deg: f64,
    image_aspect: f64,
    poly: &[[f64; 2]],
) -> CropRect {
    let fw = image_aspect;
    if poly.len() < 3 {
        return rect;
    }
    let mut changed = false;
    let (x0, y0, x1, y1) = (rect.x * fw, rect.y, (rect.x + rect.w) * fw, rect.y + rect.h);
    let mut cx = 0.5 * (x0 + x1);
    let mut cy = 0.5 * (y0 + y1);
    let mut hw = (0.5 * (x1 - x0)).max(0.0);
    let mut hh = (0.5 * (y1 - y0)).max(0.0);
    if let Some(r) = aspect.filter(|r| *r > 0.0 && r.is_finite()) {
        if hh > 0.0 && (hw / hh - r).abs() > 1e-12 * r {
            changed = true;
            if hw / hh > r {
                hw = hh * r;
            } else {
                hh = hw / r;
            }
        }
    }
    if !point_in_convex_polygon(poly, [cx, cy]) {
        changed = true;
        let n = poly.len() as f64;
        cx = poly.iter().map(|p| p[0]).sum::<f64>() / n;
        cy = poly.iter().map(|p| p[1]).sum::<f64>() / n;
    }
    // The picture turns by +angle about the crop centre.
    let k = fit_scale_in_polygon(poly, [cx, cy], hw, hh, angle_deg);
    if k < 1.0 {
        changed = true;
        hw *= k;
        hh *= k;
    }
    if !changed {
        return rect;
    }
    CropRect { x: (cx - hw) / fw, y: cy - hh, w: 2.0 * hw / fw, h: 2.0 * hh }
}

/// Largest scale `k ∈ [0, 1]` such that the rectangle of half extents `k·hw × k·hh` centred on `center`
/// fits inside the convex polygon `poly` turned by `angle_deg` (clockwise) about `center`; bisection with
/// [`QUAD_SEARCH_STEPS`] steps. 0 when the centre is outside.
pub fn fit_scale_in_polygon(poly: &[[f64; 2]], center: [f64; 2], hw: f64, hh: f64, angle_deg: f64) -> f64 {
    if poly.len() < 3 || !point_in_convex_polygon(poly, center) {
        return 0.0;
    }
    let [cx, cy] = center;
    let (s, c) = rad(angle_deg).sin_cos();
    let turned: Vec<[f64; 2]> = poly
        .iter()
        .map(|p| {
            let (dx, dy) = (p[0] - cx, p[1] - cy);
            [cx + c * dx - s * dy, cy + s * dx + c * dy]
        })
        .collect();
    let fits = |k: f64| {
        let (w, h) = (hw * k, hh * k);
        [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]]
            .iter()
            .all(|&p| point_in_convex_polygon(&turned, p))
    };
    if fits(1.0) {
        return 1.0;
    }
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..QUAD_SEARCH_STEPS {
        let mid = 0.5 * (lo + hi);
        if fits(mid) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Nelder–Mead settings of [`max_rect_in_polygon`]'s centre search.
pub const MAX_RECT_STEP: f64 = 0.05;
pub const MAX_RECT_F_TOL: f64 = 1e-12;
pub const MAX_RECT_X_TOL: f64 = 1e-9;
/// Weight of the squared distance to the frame centre in the centre search (a tie-break).
pub const MAX_RECT_CENTRE_PULL: f64 = 1e-3;

/// The largest rectangle of `aspect` (width / height; `None` keeps the frame's) inside the convex
/// polygon `poly` (frame units, the frame `image_aspect` wide and 1 high) turned by `angle_deg` about the
/// rectangle's centre, at most the frame's size. The centre is free: Nelder–Mead over it (step
/// [`MAX_RECT_STEP`]) maximising [`fit_scale_in_polygon`] (concave in the
/// centre for a convex polygon) minus [`MAX_RECT_CENTRE_PULL`] times the squared distance to the frame
/// centre, starting from the frame centre (or the polygon's vertex average when that is outside); the
/// frame centre itself wins when it fits as large a rectangle.
pub fn max_rect_in_polygon(poly: &[[f64; 2]], aspect: Option<f64>, angle_deg: f64, image_aspect: f64) -> CropRect {
    let fw = image_aspect;
    let (mut hw, mut hh) = (0.5 * fw, 0.5);
    if let Some(r) = aspect.filter(|r| *r > 0.0 && r.is_finite()) {
        if hw / hh > r {
            hw = hh * r;
        } else {
            hh = hw / r;
        }
    }
    if poly.len() < 3 {
        return CropRect { x: 0.5 - hw / fw, y: 0.5 - hh, w: 2.0 * hw / fw, h: 2.0 * hh };
    }
    let middle = [0.5 * fw, 0.5];
    let start = if point_in_convex_polygon(poly, middle) {
        middle
    } else {
        let n = poly.len() as f64;
        [poly.iter().map(|p| p[0]).sum::<f64>() / n, poly.iter().map(|p| p[1]).sum::<f64>() / n]
    };
    // Ties (a rectangle with slack along one axis) go to the centre closest to the frame centre.
    let (c, _) = super::nelder_mead::minimize(
        |p: &[f64; 2]| {
            let k = fit_scale_in_polygon(poly, *p, hw, hh, angle_deg);
            -k + MAX_RECT_CENTRE_PULL * ((p[0] - middle[0]).powi(2) + (p[1] - middle[1]).powi(2))
        },
        start,
        MAX_RECT_STEP,
        MAX_RECT_F_TOL,
        MAX_RECT_X_TOL,
    );
    let mut best = (c, fit_scale_in_polygon(poly, c, hw, hh, angle_deg));
    let k_mid = fit_scale_in_polygon(poly, middle, hw, hh, angle_deg);
    if k_mid >= best.1 {
        best = (middle, k_mid);
    }
    let ([cx, cy], k) = best;
    let (w, h) = (hw * k, hh * k);
    CropRect { x: (cx - w) / fw, y: cy - h, w: 2.0 * w / fw, h: 2.0 * h }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_area_at_zero_and_small_angles() {
        assert_eq!(max_area_rect_in_rotated(4.0, 3.0, 0.0), (4.0, 3.0));
        let (w, h) = max_area_rect_in_rotated(4.0, 3.0, 10.0);
        assert!(w < 4.0 && h < 3.0);
        // Half-constrained: a thin strip at 30°.
        let (w, h) = max_area_rect_in_rotated(10.0, 1.0, 30.0);
        assert!((h - 0.5 / 30f64.to_radians().cos()).abs() < 1e-12, "{w} {h}");
    }

    #[test]
    fn fixed_aspect_matches_constrain() {
        let p = fixed_aspect_half_width(0.75, 0.5, 1.5, 10.0);
        let r = max_crop(Some(1.5), 10.0, 1.5);
        assert!((r.w * 1.5 / 2.0 - p).abs() < 1e-12);
        assert!((r.x + r.w / 2.0 - 0.5).abs() < 1e-12);
    }

    #[test]
    fn constrain_keeps_valid_rects_and_shrinks_invalid_ones() {
        let small = CropRect { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
        assert_eq!(constrain_crop(small.clone(), None, 5.0, 1.5), small);
        let full = constrain_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, None, 0.0, 1.5);
        assert_eq!(full, CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 });
        let sq = constrain_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, Some(1.0), 0.0, 1.5);
        assert!((sq.w * 1.5 - sq.h).abs() < 1e-12 && (sq.h - 1.0).abs() < 1e-12);
    }

    #[test]
    fn quad_search_agrees_with_the_closed_form() {
        // Frame 1.5 × 1 rotated by 10° about its centre, as a quad in frame units.
        let (cx, cy) = (0.75, 0.5);
        let a = 10f64.to_radians();
        let quad = [[0.0, 0.0], [1.5, 0.0], [1.5, 1.0], [0.0, 1.0]].map(|[x, y]: [f64; 2]| {
            let (dx, dy) = (x - cx, y - cy);
            [cx + dx * a.cos() - dy * a.sin(), cy + dx * a.sin() + dy * a.cos()]
        });
        let (hw, _) = largest_rect_in_quad(&quad, [cx, cy], 1.5);
        let p = fixed_aspect_half_width(0.75, 0.5, 1.5, 10.0);
        assert!((hw - p).abs() < 1e-12, "{hw} vs {p}");
        assert_eq!(largest_rect_in_quad(&quad, [5.0, 5.0], 1.0), (0.0, 0.0));
    }

    #[test]
    fn polygon_constrain_agrees_with_the_rotated_frame() {
        // The unwarped frame as the polygon gives the same answer as the closed form.
        let frame = [[0.0, 0.0], [1.5, 0.0], [1.5, 1.0], [0.0, 1.0]];
        let full = CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        let a = constrain_crop_in_polygon(full.clone(), None, 10.0, 1.5, &frame);
        let b = constrain_crop(full.clone(), None, 10.0, 1.5);
        for (u, v) in [(a.x, b.x), (a.y, b.y), (a.w, b.w), (a.h, b.h)] {
            assert!((u - v).abs() < 1e-12, "{a:?} vs {b:?}");
        }
        assert_eq!(constrain_crop_in_polygon(full.clone(), None, 0.0, 1.5, &frame), full);
    }

    #[test]
    fn clipping_to_the_frame() {
        let quad = [[-0.5, 0.2], [1.0, -0.2], [1.2, 1.4], [0.1, 0.9]];
        let clipped = clip_to_frame(&quad, 1.0, 1.0);
        assert!(clipped.iter().all(|p| (0.0..=1.0).contains(&p[0]) && (0.0..=1.0).contains(&p[1])));
        assert!(clipped.len() >= 4);
        assert!(clip_to_frame(&[[2.0, 2.0], [3.0, 2.0], [3.0, 3.0]], 1.0, 1.0).is_empty());
    }
}
