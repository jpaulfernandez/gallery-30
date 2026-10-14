//! D4.1 masks: the rasterisers, composition, the output-grid mapping, the component LRU and the blend
//! contract. Timing: `cargo test -p photobook-develop --release --test masks -- --nocapture timing`.

use std::sync::Arc;
use std::time::Instant;

use photobook_develop::color::matrix;
use photobook_develop::color::transfer::srgb_to_linear;
use photobook_develop::geometry::remap::{remap_geometry_vectors, remap_matrix};
use photobook_develop::geometry::transform::pre_crop_matrix;
use photobook_develop::geometry::{GeometryPlan, Homography};
use photobook_develop::masks::{
    color_sigma, combine, component_hash, grow, local_weights, luminance_plane, rasterise_brush, rasterise_color,
    rasterise_linear, rasterise_luminance, rasterise_mask, rasterise_mask_cached, rasterise_radial, LocalParams,
    MaskCache, MaskContext, MaskLayers, MaskPlane,
};
use photobook_develop::settings::{
    BrushStroke, Crop, CropAspect, CropRect, Geometry, Mask, MaskComponent, MaskMode, Rotation,
};
use photobook_develop::LinearImage;
use serde_json::json;

// ---------- helpers ----------

/// Frame `w × h` pixels onto an output grid of the same size, with pixel centres on whole frame pixels:
/// output pixel `x`'s centre is frame pixel `x` (so `x = 50` is exactly frame fraction `50 / w`).
fn grid(w: f64, h: f64) -> Homography {
    Homography::scale(w, h).then(&Homography::translate(0.5, 0.5))
}

fn stroke(points: &[[f64; 2]], size: f64, feather: f64, flow: f64, erase: bool) -> BrushStroke {
    BrushStroke { points: points.to_vec(), size, feather, flow, erase }
}

fn component(v: serde_json::Value) -> MaskComponent {
    serde_json::from_value(v).unwrap()
}

fn mask(components: serde_json::Value, extra: serde_json::Value) -> Mask {
    let mut m = json!({ "id": "m1", "name": "Mask", "components": components });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    serde_json::from_value(m).unwrap()
}

fn no_ai(_: &str) -> Option<Arc<MaskPlane>> {
    None
}

fn flat_image(w: u32, h: u32, rgb: [f32; 3]) -> LinearImage {
    LinearImage::new(w, h, (0..w * h).flat_map(|_| rgb).collect())
}

/// sRGB 8-bit hex → linear Rec.2020.
fn rec2020(srgb: [u8; 3]) -> [f32; 3] {
    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    let l = srgb.map(|v| srgb_to_linear(v as f32 / 255.0));
    matrix::apply_f32(&m, l[0], l[1], l[2])
}

fn crop_geometry(rotate: Rotation, rect: CropRect) -> Geometry {
    straightened(rotate, rect, 0.0)
}

fn straightened(rotate: Rotation, rect: CropRect, angle: f64) -> Geometry {
    Geometry {
        rotate,
        constrain_crop: angle == 0.0,
        crop: Some(Crop { rect, angle, aspect: CropAspect::default() }),
        ..Geometry::default()
    }
}

// ---------- linear ----------

#[test]
fn linear_gradient_endpoints_and_midpoint() {
    let m = grid(200.0, 100.0);
    let p = rasterise_linear(200, 100, &m, [0.25, 0.5], [0.75, 0.5]);
    for y in [0, 50, 99] {
        assert_eq!(p.get(10, y), 0.0);
        assert_eq!(p.get(50, y), 0.0, "0 at `from`");
        assert_eq!(p.get(150, y), 1.0, "1 at `to`");
        assert_eq!(p.get(190, y), 1.0);
        assert!((p.get(100, y) - 0.5).abs() < 1e-6, "middle line is 50 %: {}", p.get(100, y));
    }
    for x in 50..150 {
        assert!(p.get(x + 1, 0) >= p.get(x, 0));
    }
    // Lines are perpendicular to from → to in frame-metric units: a 45° gradient on a 2:1 frame.
    let p = rasterise_linear(200, 100, &m, [0.25, 0.25], [0.375, 0.75]); // (50,25) → (75,75) px
    let mid = [62.5, 50.0];
    let along = [25.0f64, 50.0];
    let perp = [-along[1], along[0]];
    let n = perp[0].hypot(perp[1]);
    let a = p.sample(mid[0] + 0.5 + 20.0 * perp[0] / n, mid[1] + 0.5 + 20.0 * perp[1] / n);
    assert!((a - 0.5).abs() < 0.02, "the 50 % line runs perpendicular on screen: {a}");
    assert_eq!(rasterise_linear(20, 10, &m, [0.3, 0.3], [0.3, 0.3]).max_value(), 0.0);
}

// ---------- radial ----------

#[test]
fn radial_centre_outside_and_feather_band() {
    let m = grid(200.0, 100.0);
    // radii 0.25 × 200 = 50 px and 0.5 × 100 = 50 px: a circle on screen.
    let p = rasterise_radial(200, 100, &m, [0.5, 0.5], [0.25, 0.5], 0.0, 50.0);
    assert_eq!(p.get(100, 50), 1.0);
    assert_eq!(p.get(160, 50), 0.0);
    assert_eq!(p.get(5, 5), 0.0);
    assert_eq!(p.get(100 + 24, 50), 1.0, "full strength inside the feather band (half the radius)");
    assert!((p.get(100 + 30, 50) - p.get(100, 50 + 30)).abs() < 1e-6, "round in frame-metric units");
    let ray: Vec<f32> = (0..60).map(|d| p.get(100 + d, 50)).collect();
    assert!(ray.windows(2).all(|w| w[1] <= w[0]), "monotone from centre to edge");
    assert!(ray[37] > 0.0 && ray[37] < 1.0);
    assert_eq!(ray[50], 0.0, "0 at the ellipse edge");
    // Feather 0: hard edge.
    let hard = rasterise_radial(200, 100, &m, [0.5, 0.5], [0.25, 0.5], 0.0, 0.0);
    assert_eq!(hard.get(100 + 49, 50), 1.0);
    assert_eq!(hard.get(100 + 51, 50), 0.0);
    // Angle: an ellipse 60 × 20 px turned 90° clockwise is tall.
    let m = grid(200.0, 200.0);
    let e = rasterise_radial(200, 200, &m, [0.5, 0.5], [0.3, 0.1], 90.0, 0.0);
    assert_eq!(e.get(100, 100 + 50), 1.0);
    assert_eq!(e.get(100 + 50, 100), 0.0);
    // 30° clockwise: the long axis points down-right on screen.
    let e = rasterise_radial(200, 200, &m, [0.5, 0.5], [0.3, 0.1], 30.0, 0.0);
    let (s, c) = 30f64.to_radians().sin_cos();
    assert_eq!(e.sample(100.5 + 50.0 * c, 100.5 + 50.0 * s), 1.0);
    assert_eq!(e.sample(100.5 + 50.0 * c, 100.5 - 50.0 * s), 0.0);
}

// ---------- brush ----------

#[test]
fn brush_covers_its_polyline_with_the_right_radius() {
    let m = grid(400.0, 200.0);
    // Short side 200 px, size 10 % → diameter 20 px, radius 10 px.
    let p = rasterise_brush(400, 200, &m, &[stroke(&[[0.25, 0.5], [0.75, 0.5]], 10.0, 0.0, 100.0, false)]);
    for x in 100..=300 {
        assert_eq!(p.get(x, 100), 1.0, "on the polyline at x = {x}");
        assert_eq!(p.get(x, 100 + 9), 1.0, "inside the radius at x = {x}");
        assert_eq!(p.get(x, 100 - 9), 1.0);
        assert_eq!(p.get(x, 100 + 11), 0.0, "outside the radius at x = {x}");
    }
    assert_eq!(p.get(100 - 9, 100), 1.0, "round cap");
    assert_eq!(p.get(100 - 11, 100), 0.0);
    // Feather: soft edge over the outer half of the radius.
    let soft = rasterise_brush(400, 200, &m, &[stroke(&[[0.5, 0.5]], 10.0, 50.0, 100.0, false)]);
    assert_eq!(soft.get(200 + 4, 100), 1.0);
    let edge = soft.get(200 + 7, 100);
    assert!(edge > 0.0 && edge < 1.0, "{edge}");
    assert_eq!(soft.get(200 + 10, 100), 0.0);
}

#[test]
fn brush_erase_and_flow() {
    let m = grid(400.0, 200.0);
    let paint = stroke(&[[0.25, 0.5], [0.75, 0.5]], 10.0, 0.0, 100.0, false);
    let erase = stroke(&[[0.5, 0.25], [0.5, 0.75]], 4.0, 0.0, 100.0, true);
    let p = rasterise_brush(400, 200, &m, &[paint.clone(), erase.clone()]);
    assert_eq!(p.get(200, 100), 0.0, "erased");
    assert_eq!(p.get(150, 100), 1.0, "kept away from the eraser");
    // Partial erase: flow 25 removes a quarter.
    let p = rasterise_brush(400, 200, &m, &[paint.clone(), BrushStroke { flow: 25.0, ..erase }]);
    assert!((p.get(200, 100) - 0.75).abs() < 1e-6);
    // Flow accumulates by max: overlapping dabs and a second identical stroke stay at the flow.
    let half = stroke(&[[0.25, 0.5], [0.75, 0.5], [0.25, 0.5]], 10.0, 0.0, 50.0, false);
    let p = rasterise_brush(400, 200, &m, &[half.clone(), half.clone()]);
    assert_eq!(p.get(200, 100), 0.5);
    assert_eq!(p.get(200, 105), 0.5);
    let p = rasterise_brush(400, 200, &m, &[paint, half]);
    assert_eq!(p.get(200, 100), 1.0, "a weaker stroke never lowers a stronger one");
}

// ---------- ranges ----------

#[test]
fn luminance_range_picks_a_ramp() {
    let luma: Vec<f32> = (0..256).map(|x| x as f32 / 255.0).collect();
    let p = rasterise_luminance(256, 1, &luma, [0.25, 0.75], 0.0);
    for x in 0..256 {
        let y = x as f64 / 255.0;
        let expect = if (0.25..=0.75).contains(&y) { 1.0 } else { 0.0 };
        assert_eq!(p.data[x], expect, "x = {x}");
    }
    // Feather 40: 0.1 wide edges outside the range.
    let p = rasterise_luminance(256, 1, &luma, [0.75, 0.25], 40.0);
    assert_eq!(p.data[128], 1.0);
    assert_eq!(p.data[(0.1f32 * 255.0) as usize], 0.0);
    let e = p.data[(0.2f32 * 255.0).round() as usize];
    assert!(e > 0.0 && e < 1.0);
    // The plane: mid grey 0.18 sits near 0.46.
    let grey = luminance_plane(&flat_image(1, 1, [0.18, 0.18, 0.18]));
    assert!((grey[0] - 0.4613).abs() < 1e-3, "{}", grey[0]);
}

#[test]
fn colour_range_selects_red_not_green() {
    let (red, green, dark_red) = (rec2020([230, 20, 20]), rec2020([20, 200, 40]), rec2020([150, 10, 10]));
    let data = (0..30).flat_map(|x| if x < 10 { red } else if x < 20 { green } else { dark_red }).collect();
    let img = LinearImage::new(30, 1, data);
    let p = rasterise_color(&img, &["#e61414".into(), "not a colour".into()], 50.0);
    assert!(p.data[0] > 0.99, "{}", p.data[0]);
    assert_eq!(p.data[15], 0.0);
    assert!(p.data[25] > 0.0, "a darker red is still partly picked: {}", p.data[25]);
    assert!(p.data[25] < p.data[0]);
    // Tolerance widens the pick.
    let wide = rasterise_color(&img, &["#e61414".into()], 100.0);
    assert!(wide.data[25] > p.data[25]);
    assert!(color_sigma(0.0) < color_sigma(50.0));
    assert_eq!(rasterise_color(&img, &[], 50.0).max_value(), 0.0);
}

// ---------- composition ----------

#[test]
fn composition_modes() {
    let a = MaskPlane::new(4, 1, vec![0.0, 0.3, 0.6, 1.0]);
    let b = MaskPlane::new(4, 1, vec![0.5, 0.5, 0.5, 0.5]);
    let mut acc = a.clone();
    combine(&mut acc, &b, MaskMode::Add, false);
    assert_eq!(acc.data, vec![0.5, 0.5, 0.6, 1.0]);
    let mut acc = a.clone();
    combine(&mut acc, &b, MaskMode::Subtract, false);
    assert!(acc.data.iter().zip([0.0, 0.0, 0.1, 0.5]).all(|(v, e)| (v - e).abs() < 1e-6), "{:?}", acc.data);
    let mut acc = a.clone();
    combine(&mut acc, &b, MaskMode::Intersect, false);
    assert_eq!(acc.data, vec![0.0, 0.3, 0.5, 0.5]);
    let mut acc = a.clone();
    combine(&mut acc, &MaskPlane::new(4, 1, vec![1.0, 0.0, 1.0, 0.0]), MaskMode::Add, true);
    assert_eq!(acc.data, vec![0.0, 1.0, 0.6, 1.0]);

    // Through rasterise_mask: left half (hard linear) minus a centre circle, intersected with the top half.
    let m = grid(100.0, 100.0);
    let img = flat_image(100, 100, [0.5; 3]);
    let ctx = MaskContext {
        width: 100,
        height: 100,
        frame_to_output: &m,
        input_luma: &[],
        input_rgb: &img,
        ai_rasters: &no_ai,
    };
    let left = json!({"id": "a", "kind": "linear", "from": [0.51, 0.5], "to": [0.49, 0.5]});
    let circle = json!({"id": "b", "kind": "radial", "mode": "subtract", "center": [0.3, 0.5], "radii": [0.1, 0.1], "angle": 0, "feather": 0});
    let top = json!({"id": "c", "kind": "linear", "mode": "intersect", "from": [0.5, 0.51], "to": [0.5, 0.49]});
    let r = rasterise_mask(&mask(json!([left, circle, top]), json!({})), &ctx);
    assert!(r.missing_ai.is_empty());
    assert_eq!(r.plane.get(10, 10), 1.0);
    assert_eq!(r.plane.get(90, 10), 0.0, "right half not added");
    assert_eq!(r.plane.get(10, 90), 0.0, "bottom half not intersected");
    assert_eq!(r.plane.get(30, 45), 0.0, "circle subtracted");
    // The first component acts as add whatever its mode.
    let first_subtract = json!({"id": "a", "kind": "linear", "mode": "subtract", "from": [0.51, 0.5], "to": [0.49, 0.5]});
    let r = rasterise_mask(&mask(json!([first_subtract]), json!({})), &ctx);
    assert_eq!(r.plane.get(10, 10), 1.0);
    // Component invert.
    let inv = json!({"id": "a", "kind": "linear", "invert": true, "from": [0.51, 0.5], "to": [0.49, 0.5]});
    let r = rasterise_mask(&mask(json!([inv]), json!({})), &ctx);
    assert_eq!((r.plane.get(10, 10), r.plane.get(90, 10)), (0.0, 1.0));
}

#[test]
fn invert_opacity_feather_and_grow() {
    let m = grid(200.0, 200.0);
    let img = flat_image(200, 200, [0.5; 3]);
    let ctx = MaskContext {
        width: 200,
        height: 200,
        frame_to_output: &m,
        input_luma: &[],
        input_rgb: &img,
        ai_rasters: &no_ai,
    };
    let disc = json!([{"id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.25, 0.25], "angle": 0, "feather": 0}]);
    let plain = rasterise_mask(&mask(disc.clone(), json!({})), &ctx).plane;
    assert_eq!((plain.get(100, 100), plain.get(5, 5)), (1.0, 0.0));
    let inv = rasterise_mask(&mask(disc.clone(), json!({"invert": true})), &ctx).plane;
    assert_eq!((inv.get(100, 100), inv.get(5, 5)), (0.0, 1.0));
    let half = rasterise_mask(&mask(disc.clone(), json!({"opacity": 50})), &ctx).plane;
    assert_eq!((half.get(100, 100), half.max_value()), (0.5, 0.5));
    // Feather 100: σ = 2 % of 200 px = 4 px. The hard edge at 50 px becomes a ramp; the centre stays 1.
    let soft = rasterise_mask(&mask(disc.clone(), json!({"feather": 100})), &ctx).plane;
    assert!((soft.get(100, 100) - 1.0).abs() < 1e-4);
    assert!((soft.get(150, 100) - 0.5).abs() < 0.1, "{}", soft.get(150, 100));
    assert!(soft.get(146, 100) > 0.75 && soft.get(154, 100) < 0.25);
    // Same feather at twice the resolution: the same profile at doubled coordinates.
    let m2 = grid(400.0, 400.0);
    let img2 = flat_image(400, 400, [0.5; 3]);
    let ctx2 = MaskContext { width: 400, height: 400, frame_to_output: &m2, input_luma: &[], input_rgb: &img2, ai_rasters: &no_ai };
    let soft2 = rasterise_mask(&mask(disc, json!({"feather": 100})), &ctx2).plane;
    for d in [-8i32, -4, 0, 4, 8] {
        let (a, b) = (soft.get((150 + d) as u32, 100), soft2.sample(300.5 + 2.0 * d as f64, 200.5));
        assert!((a - b).abs() < 0.05, "d = {d}: {a} vs {b}");
    }
    // Grow / shrink: ±100 = 1 % of the short side = 2 px here.
    let mut g = plain.clone();
    grow(&mut g, 100.0, 200.0);
    assert_eq!(g.get(100 + 51, 100), 1.0);
    let mut s = plain.clone();
    grow(&mut s, -100.0, 200.0);
    assert_eq!(s.get(100 + 48, 100), 0.0);
    assert_eq!(s.get(100, 100), 1.0);
}

#[test]
fn ai_components_use_the_supplied_raster_or_flag_it() {
    let m = grid(64.0, 32.0);
    let img = flat_image(64, 32, [0.5; 3]);
    let ai = json!({"id": "sky", "kind": "ai", "target": "sky", "model": "u2net-sky", "modelVersion": "1"});
    let msk = mask(json!([ai]), json!({}));
    let ctx = MaskContext { width: 64, height: 32, frame_to_output: &m, input_luma: &[], input_rgb: &img, ai_rasters: &no_ai };
    let r = rasterise_mask(&msk, &ctx);
    assert_eq!(r.missing_ai, vec!["sky".to_string()]);
    assert_eq!(r.plane.max_value(), 0.0);
    // A 16 × 8 raster (top half 1) is resized to the grid.
    let raster = Arc::new(MaskPlane::new(16, 8, (0..128).map(|i| if i < 64 { 1.0 } else { 0.0 }).collect()));
    let supply = move |id: &str| (id == "sky").then(|| raster.clone());
    let ctx = MaskContext { ai_rasters: &supply, ..ctx };
    let r = rasterise_mask(&msk, &ctx);
    assert!(r.missing_ai.is_empty());
    assert_eq!((r.plane.get(10, 2), r.plane.get(10, 30)), (1.0, 0.0));
}

// ---------- the output-grid mapping ----------

#[test]
fn frame_to_output_matches_the_forward_map() {
    for (rotate, angle) in [(Rotation::R0, 0.0), (Rotation::R90, 7.5), (Rotation::R270, -12.0)] {
        let g = Geometry {
            rotate,
            flip_h: true,
            crop: Some(Crop { rect: CropRect { x: 0.1, y: 0.15, w: 0.7, h: 0.6 }, angle, aspect: CropAspect::default() }),
            constrain_crop: false,
            ..Geometry::default()
        };
        let plan = GeometryPlan::new(&g, 640, 427, Some(300));
        let f2o = plan.frame_to_output_matrix();
        let pre = pre_crop_matrix(&g, 640, 427);
        for s in [[0.2, 0.3], [0.5, 0.5], [0.9, 0.1]] {
            let a = f2o.apply(pre.apply(s));
            let b = plan.forward.apply(s);
            let b = [b[0] * plan.output_width as f64, b[1] * plan.output_height as f64];
            assert!((a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6, "{rotate:?}: {a:?} vs {b:?}");
        }
    }
}

#[test]
fn crop_is_a_window_onto_the_full_frame_raster() {
    let (w, h) = (400u32, 300u32);
    let full = GeometryPlan::new(&Geometry::default(), w, h, None);
    let cropped = GeometryPlan::new(&crop_geometry(Rotation::R0, CropRect { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }), w, h, None);
    let (x0, y0) = ((cropped.crop.x * w as f64) as u32, (cropped.crop.y * h as f64) as u32);
    let strokes = vec![stroke(&[[0.2, 0.3], [0.6, 0.6], [0.4, 0.65]], 8.0, 50.0, 80.0, false)];
    let a = rasterise_brush(w, h, &full.frame_to_output_matrix(), &strokes);
    let b = rasterise_brush(cropped.output_width, cropped.output_height, &cropped.frame_to_output_matrix(), &strokes);
    let ra = rasterise_radial(w, h, &full.frame_to_output_matrix(), [0.4, 0.5], [0.2, 0.15], 25.0, 60.0);
    let rb = rasterise_radial(
        cropped.output_width,
        cropped.output_height,
        &cropped.frame_to_output_matrix(),
        [0.4, 0.5],
        [0.2, 0.15],
        25.0,
        60.0,
    );
    let mut max = 0.0f32;
    for y in 0..cropped.output_height {
        for x in 0..cropped.output_width {
            max = max.max((a.get(x + x0, y + y0) - b.get(x, y)).abs());
            max = max.max((ra.get(x + x0, y + y0) - rb.get(x, y)).abs());
        }
    }
    assert!(max < 1e-5, "{max}");
}

#[test]
fn masks_follow_the_content_through_a_crop_and_a_90_degree_rotation() {
    // Straight (exact pixel transposition) and with a 6° straighten (resampled grids).
    for angle in [0.0, 6.0] {
        follow_through_rotation(angle);
    }
}

fn follow_through_rotation(angle: f64) {
    let (sw, sh) = (400u32, 300u32);
    let ga = straightened(Rotation::R0, CropRect { x: 0.1, y: 0.2, w: 0.6, h: 0.5 }, angle);
    // The same crop seen after a 90° clockwise rotation: map its corners into the rotated frame.
    let gb0 = Geometry { rotate: Rotation::R90, ..Geometry::default() };
    let m = remap_matrix(&pre_crop_matrix(&ga, sw, sh), &pre_crop_matrix(&gb0, sw, sh)).unwrap();
    let corners = m.map_rect_corners(0.1, 0.2, 0.6, 0.5);
    let (xs, ys): (Vec<f64>, Vec<f64>) = corners.iter().map(|p| (p[0], p[1])).unzip();
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let rect_b = CropRect { x: min(&xs), y: min(&ys), w: max(&xs) - min(&xs), h: max(&ys) - min(&ys) };
    let gb = straightened(Rotation::R90, rect_b, angle);

    let mut masks = vec![mask(
        json!([
            {"id": "r", "kind": "radial", "center": [0.4, 0.45], "radii": [0.2, 0.15], "angle": 20, "feather": 60},
            {"id": "l", "kind": "linear", "mode": "intersect", "from": [0.15, 0.3], "to": [0.65, 0.6]},
            {"id": "b", "kind": "brush", "strokes": [{"points": [[0.2, 0.6], [0.6, 0.35]], "size": 6, "feather": 60}]}
        ]),
        json!({}),
    )];
    let mask_a = masks[0].clone();
    remap_geometry_vectors(&ga, &gb, sw, sh, &mut masks, &mut []);
    let mask_b = masks.pop().unwrap();

    let raster = |g: &Geometry, msk: &Mask| {
        let plan = GeometryPlan::new(g, sw, sh, None);
        let f2o = plan.frame_to_output_matrix();
        let img = flat_image(plan.output_width, plan.output_height, [0.5; 3]);
        let ctx = MaskContext {
            width: plan.output_width,
            height: plan.output_height,
            frame_to_output: &f2o,
            input_luma: &[],
            input_rgb: &img,
            ai_rasters: &no_ai,
        };
        (rasterise_mask(msk, &ctx).plane, plan)
    };
    let (pa, plan_a) = raster(&ga, &mask_a);
    let (pb, plan_b) = raster(&gb, &mask_b);
    assert_eq!((plan_a.output_width, plan_a.output_height), (plan_b.output_height, plan_b.output_width));
    assert!(pa.max_value() > 0.9, "the mask is visible");
    let b_forward = plan_b.inverse.invert().unwrap();
    let (mut worst, mut n) = (0.0f32, 0);
    for y in 0..plan_a.output_height {
        for x in 0..plan_a.output_width {
            let src = plan_a.inverse.apply([x as f64 + 0.5, y as f64 + 0.5]);
            let q = b_forward.apply(src);
            if q[0] < 1.0 || q[1] < 1.0 || q[0] > plan_b.output_width as f64 - 1.0 || q[1] > plan_b.output_height as f64 - 1.0 {
                continue;
            }
            worst = worst.max((pa.get(x, y) - pb.sample(q[0], q[1])).abs());
            n += 1;
        }
    }
    assert!(n > 30_000, "{n}");
    assert!(worst < 0.03, "angle {angle}: same content, same mask value: worst {worst}");
}

// ---------- hash and LRU ----------

#[test]
fn component_hash_ignores_id_mode_and_invert() {
    let a = component(json!({"id": "a", "kind": "radial", "center": [0.5, 0.5], "radii": [0.2, 0.2], "angle": 0}));
    let b = component(json!({"id": "b", "mode": "subtract", "invert": true, "kind": "radial", "center": [0.5, 0.5], "radii": [0.2, 0.2], "angle": 0, "feather": 50}));
    let c = component(json!({"id": "a", "kind": "radial", "center": [0.5, 0.5], "radii": [0.2, 0.21], "angle": 0}));
    assert_eq!(component_hash(&a).len(), 64);
    assert_eq!(component_hash(&a), component_hash(&b));
    assert_ne!(component_hash(&a), component_hash(&c));
}

#[test]
fn lru_returns_the_same_arc() {
    let m = grid(100.0, 80.0);
    let img = flat_image(100, 80, [0.5; 3]);
    let ctx = MaskContext { width: 100, height: 80, frame_to_output: &m, input_luma: &[], input_rgb: &img, ai_rasters: &no_ai };
    let c = component(json!({"id": "a", "kind": "linear", "from": [0.1, 0.1], "to": [0.9, 0.9]}));
    let mut cache = MaskCache::default();
    let (p1, _) = cache.get_or_rasterise(&c, &ctx);
    let (p2, _) = cache.get_or_rasterise(&c, &ctx);
    assert!(Arc::ptr_eq(&p1, &p2));
    assert_eq!(cache.len(), 1);
    // Another grid map misses.
    let m2 = grid(100.0, 81.0);
    let ctx2 = MaskContext { frame_to_output: &m2, ..ctx };
    let (p3, _) = cache.get_or_rasterise(&c, &ctx2);
    assert!(!Arc::ptr_eq(&p1, &p3));
    // Missing AI rasters are not cached.
    let ai = component(json!({"id": "s", "kind": "ai", "target": "subject", "model": "m", "modelVersion": "1"}));
    let (_, missing) = cache.get_or_rasterise(&ai, &ctx);
    assert!(missing);
    assert_eq!(cache.len(), 2);
    // A budget of two planes evicts the least recently used.
    let plane_bytes = 100 * 80 * 4;
    let mut small = MaskCache::new(2 * plane_bytes);
    let d = component(json!({"id": "d", "kind": "linear", "from": [0.2, 0.1], "to": [0.9, 0.9]}));
    let e = component(json!({"id": "e", "kind": "linear", "from": [0.3, 0.1], "to": [0.9, 0.9]}));
    let (pc, _) = small.get_or_rasterise(&c, &ctx);
    small.get_or_rasterise(&d, &ctx);
    small.get_or_rasterise(&c, &ctx); // c is now the most recent
    small.get_or_rasterise(&e, &ctx); // evicts d
    assert_eq!(small.len(), 2);
    assert!(small.bytes() <= 2 * plane_bytes);
    assert!(Arc::ptr_eq(&pc, &small.get_or_rasterise(&c, &ctx).0));
    // Cached composite equals the uncached one.
    let msk = mask(json!([{"id": "a", "kind": "linear", "from": [0.1, 0.1], "to": [0.9, 0.9]}]), json!({"feather": 30}));
    assert_eq!(rasterise_mask_cached(&msk, &ctx, &mut cache).plane, rasterise_mask(&msk, &ctx).plane);
}

// ---------- blend contract ----------

#[test]
fn layers_and_local_weights() {
    let m = grid(100.0, 100.0);
    let img = flat_image(100, 100, [0.5; 3]);
    let ctx = MaskContext { width: 100, height: 100, frame_to_output: &m, input_luma: &[], input_rgb: &img, ai_rasters: &no_ai };
    let left = json!([{"id": "a", "kind": "linear", "from": [0.51, 0.5], "to": [0.49, 0.5]}]);
    let all = json!([{"id": "a", "kind": "linear", "from": [-1.0, 0.5], "to": [-0.5, 0.5]}]);
    let masks = vec![
        mask(left.clone(), json!({"id": "exp", "adjustments": {"exposure": 1.0, "clarity": 20}})),
        mask(all.clone(), json!({"id": "half", "opacity": 50, "adjustments": {"exposure": -0.5}})),
        mask(all.clone(), json!({"id": "off", "enabled": false, "adjustments": {"exposure": 3}})),
        mask(all, json!({"id": "noop"})),
    ];
    let (layers, missing) = MaskLayers::build(&masks, &ctx, None);
    assert!(missing.is_empty());
    assert_eq!(layers.ids, vec!["exp".to_string(), "half".to_string()], "disabled and no-op masks are skipped");
    let left_px = 50 * 100 + 10;
    let right_px = 50 * 100 + 90;
    assert_eq!(local_weights(&layers, left_px).count(), 2);
    assert_eq!(local_weights(&layers, right_px).count(), 1);
    let p = LocalParams::at(&layers, left_px);
    assert!((p.exposure - 0.75).abs() < 1e-6 && (p.clarity - 20.0).abs() < 1e-6, "{p:?}");
    let p = LocalParams::at(&layers, right_px);
    assert!((p.exposure + 0.25).abs() < 1e-6 && p.clarity == 0.0);
    let mut cache = MaskCache::default();
    let (cached, _) = MaskLayers::build(&masks, &ctx, Some(&mut cache));
    assert_eq!(cached, layers);
    assert_eq!(cache.len(), 2, "the two identical `all` components share one entry");
}

// ---------- timing ----------

#[test]
fn timing_1600px() {
    let (w, h) = (1600u32, 1067u32);
    let m = grid(w as f64, h as f64);
    let img = LinearImage::new(
        w,
        h,
        (0..h).flat_map(|y| (0..w).flat_map(move |x| [x as f32 / w as f32, y as f32 / h as f32, 0.3])).collect(),
    );
    let t = Instant::now();
    let luma = luminance_plane(&img);
    let t_luma = t.elapsed();
    let ctx = MaskContext { width: w, height: h, frame_to_output: &m, input_luma: &luma, input_rgb: &img, ai_rasters: &no_ai };
    let msk = mask(
        json!([
            {"id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.3, 0.4], "angle": 15, "feather": 50},
            {"id": "l", "kind": "linear", "mode": "intersect", "from": [0.1, 0.1], "to": [0.9, 0.6]},
            {"id": "b", "kind": "brush", "strokes": [
                {"points": [[0.1, 0.8], [0.3, 0.7], [0.5, 0.85], [0.8, 0.7]], "size": 5, "feather": 50},
                {"points": [[0.2, 0.2], [0.7, 0.3]], "size": 20, "feather": 80, "flow": 60}
            ]},
            {"id": "y", "kind": "luminance", "mode": "subtract", "range": [0.0, 0.2], "feather": 30},
            {"id": "c", "kind": "color", "samples": ["#c08040", "#4080c0"], "tolerance": 40}
        ]),
        json!({"feather": 40}),
    );
    let t = Instant::now();
    let r = rasterise_mask(&msk, &ctx);
    let t_mask = t.elapsed();
    let mut cache = MaskCache::default();
    rasterise_mask_cached(&msk, &ctx, &mut cache);
    let t = Instant::now();
    rasterise_mask_cached(&msk, &ctx, &mut cache);
    let t_cached = t.elapsed();
    assert!(r.plane.max_value() > 0.0);
    println!(
        "masks at {w}×{h}: luminance plane {:.1} ms, five-component mask + feather {:.1} ms, again with cached components {:.1} ms",
        t_luma.as_secs_f64() * 1e3,
        t_mask.as_secs_f64() * 1e3,
        t_cached.as_secs_f64() * 1e3
    );
}

// ---------- applied in the pipeline (D4.1, pipeline half) ----------

mod common;

use photobook_develop::settings::WhiteBalance;
use photobook_develop::{
    render_full, render_preview, DevelopSettings, Developer, RenderBackend, RenderOptions, Rgb8Image,
};

fn cpu() -> RenderOptions {
    RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() }
}

fn with_masks(masks: Vec<Mask>) -> DevelopSettings {
    DevelopSettings { masks, ..DevelopSettings::default() }
}

/// A linear mask at full strength everywhere.
fn everywhere() -> serde_json::Value {
    json!([{"id": "all", "kind": "linear", "from": [-1.0, 0.5], "to": [-0.5, 0.5]}])
}

fn px(img: &Rgb8Image, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * img.width + x) * 3) as usize;
    [img.data[i], img.data[i + 1], img.data[i + 2]]
}

/// Mean 8-bit value of the pixel block `x0..x1 × y0..y1`, channel `c`.
fn block_mean(img: &Rgb8Image, x0: u32, y0: u32, x1: u32, y1: u32, c: usize) -> f64 {
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            sum += px(img, x, y)[c] as f64;
        }
    }
    sum / ((x1 - x0) * (y1 - y0)) as f64
}

fn decode_jpeg_rgb(bytes: &[u8]) -> Rgb8Image {
    let img = turbojpeg::decompress(bytes, turbojpeg::PixelFormat::RGB).unwrap();
    Rgb8Image::new(img.width as u32, img.height as u32, img.pixels)
}

/// Rows `y0..y1` of two renders are identical.
fn rows_equal(a: &Rgb8Image, b: &Rgb8Image, y0: u32, y1: u32) -> bool {
    let stride = a.width as usize * 3;
    a.data[y0 as usize * stride..y1 as usize * stride] == b.data[y0 as usize * stride..y1 as usize * stride]
}

/// A smooth colour gradient with a little texture (so detail sliders have something to act on).
fn textured(w: u32, h: u32) -> LinearImage {
    common::image(w, h, |x, y| {
        let n = 30.0 * common::value_noise(x, y, 6.0, 7);
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        [90.0 + 80.0 * fx + n, 120.0 + 40.0 * fy + n, 140.0 - 60.0 * fx + n]
    })
}

/// The corners of a vignette mask (an inverted radial with exposure −2) darken while the centre stays
/// exactly as without the mask, and the preview (a resized render) matches the full render at the same
/// normalised positions.
#[test]
fn radial_mask_darkens_corners_in_full_and_preview() {
    // Smooth, so that the preview's resize changes nothing but the sampling.
    let img = common::image(900, 600, |x, y| {
        let (fx, fy) = (x as f32 / 900.0, y as f32 / 600.0);
        [90.0 + 80.0 * fx, 120.0 + 40.0 * fy, 140.0 - 60.0 * fx]
    });
    let vignette = mask(
        json!([{"id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.3, 0.3], "angle": 0, "feather": 50}]),
        json!({"id": "vignette", "invert": true, "adjustments": {"exposure": -2}}),
    );
    let s = with_masks(vec![vignette]);
    let plain = render_full(&img, &DevelopSettings::default()).unwrap();
    let full = render_full(&img, &s).unwrap();
    for (x, y) in [(20, 20), (880, 20), (20, 580), (880, 580)] {
        for c in 0..3 {
            assert!((px(&full, x, y)[c] as f32) < 0.6 * px(&plain, x, y)[c] as f32, "corner ({x}, {y}) not darker: {:?} vs {:?}", px(&full, x, y), px(&plain, x, y));
        }
    }
    // The centre (weight exactly 0) is bit-identical, as is every pixel of a CPU render the mask leaves alone.
    assert_eq!(block_mean(&full, 400, 250, 500, 350, 0), block_mean(&plain, 400, 250, 500, 350, 0));
    for x in 400..500 {
        assert_eq!(px(&full, x, 300), px(&plain, x, 300));
    }
    let dev = Developer::new(img.clone());
    let a = dev.render_with(&s, &cpu());
    let b = dev.render_with(&DevelopSettings::default(), &cpu());
    for x in 400..500 {
        assert_eq!(px(&a, x, 300), px(&b, x, 300), "untouched pixels go through the global path unchanged");
    }

    // Preview at half size, compared at matching normalised positions (2×2 blocks of the full render), with
    // the same comparison without the mask as the baseline (the JPEG round trip and the resize).
    let worst = |s: &DevelopSettings| {
        let full = render_full(&img, s).unwrap();
        let preview = decode_jpeg_rgb(&render_preview(&img, s, 450, 100).unwrap());
        assert_eq!((preview.width, preview.height), (450, 300));
        let mut worst = 0.0f64;
        for py in (5..300).step_by(10) {
            for pxx in (5..450).step_by(10) {
                for c in 0..3 {
                    let f = block_mean(&full, 2 * pxx, 2 * py, 2 * pxx + 2, 2 * py + 2, c);
                    worst = worst.max((f - px(&preview, pxx, py)[c] as f64).abs());
                }
            }
        }
        worst
    };
    let (masked, baseline) = (worst(&s), worst(&DevelopSettings::default()));
    eprintln!("radial vignette: preview vs full at matching positions, worst {masked:.2} levels (without the mask {baseline:.2})");
    assert!(masked <= baseline.max(2.0) + 1.0, "preview and full render disagree by {masked} levels");
}

/// Clarity through a brush stroke changes the pixels under the stroke and nothing far from it.
#[test]
fn brush_clarity_changes_only_inside_the_stroke() {
    let img = textured(600, 400);
    let brush = mask(
        json!([{"id": "b", "kind": "brush", "strokes": [{"points": [[0.2, 0.5], [0.8, 0.5]], "size": 10, "feather": 0}]}]),
        json!({"id": "brush", "adjustments": {"clarity": 100}}),
    );
    let dev = Developer::new(img);
    let plain = dev.render_with(&DevelopSettings::default(), &cpu());
    let out = dev.render_with(&with_masks(vec![brush]), &cpu());
    // The stroke is 10 % of the short side across (40 px): rows 180..220 between x 120 and 480.
    assert!(rows_equal(&out, &plain, 0, 170), "rows above the stroke changed");
    assert!(rows_equal(&out, &plain, 230, 400), "rows below the stroke changed");
    let row = |img: &Rgb8Image, y: u32, x0: u32, x1: u32| (x0..x1).map(move |x| px(img, x, y)).collect::<Vec<_>>();
    assert_eq!(row(&out, 200, 0, 100), row(&plain, 200, 0, 100), "left of the stroke changed");
    let changed = (130..470).filter(|&x| px(&out, x, 200) != px(&plain, x, 200)).count();
    assert!(changed > 200, "clarity barely acted inside the stroke ({changed} of 340 pixels changed)");
}

/// Opacity 50 gives half the effect of opacity 100: exposure −2 at 50 % is −1 EV in linear light.
#[test]
fn half_opacity_is_half_the_effect() {
    let img = LinearImage::new(64, 64, [0.18f32; 3].repeat(64 * 64));
    let level = |opacity: f64| {
        let m = mask(everywhere(), json!({"opacity": opacity, "adjustments": {"exposure": -2}}));
        let out = Developer::new(img.clone()).render_with(&with_masks(vec![m]), &cpu());
        let v = block_mean(&out, 0, 0, 64, 64, 1);
        srgb_to_linear(v as f32 / 255.0)
    };
    let (full, half) = (level(100.0), level(50.0));
    let (ev_full, ev_half) = ((full / 0.18).log2(), (half / 0.18).log2());
    eprintln!("exposure −2: opacity 100 → {ev_full:.3} EV, opacity 50 → {ev_half:.3} EV");
    assert!((ev_full + 2.0).abs() < 0.03 && (ev_half + 1.0).abs() < 0.03, "{ev_full} {ev_half}");
}

/// The mask-level invert swaps the affected side.
#[test]
fn invert_flips_the_affected_side() {
    let img = textured(200, 100);
    let left = json!([{"id": "l", "kind": "linear", "from": [0.45, 0.5], "to": [0.35, 0.5]}]);
    let plain = Developer::new(img.clone()).render_with(&DevelopSettings::default(), &cpu());
    for invert in [false, true] {
        let m = mask(left.clone(), json!({"invert": invert, "adjustments": {"exposure": -1}}));
        let out = Developer::new(img.clone()).render_with(&with_masks(vec![m]), &cpu());
        let (dark, same) = if invert { (190, 10) } else { (10, 190) };
        assert!(block_mean(&out, dark, 0, dark + 5, 100, 1) < block_mean(&plain, dark, 0, dark + 5, 100, 1) - 20.0);
        assert_eq!(block_mean(&out, same, 0, same + 5, 100, 1), block_mean(&plain, same, 0, same + 5, 100, 1));
    }
}

/// Subtract cuts a hole into a mask, intersect keeps only the overlap.
#[test]
fn subtract_and_intersect_in_renders() {
    let img = LinearImage::new(200, 200, [0.18f32; 3].repeat(200 * 200));
    let ring = mask(
        json!([
            {"id": "big", "kind": "radial", "center": [0.5, 0.5], "radii": [0.4, 0.4], "angle": 0, "feather": 0},
            {"id": "small", "kind": "radial", "mode": "subtract", "center": [0.5, 0.5], "radii": [0.2, 0.2], "angle": 0, "feather": 0}
        ]),
        json!({"adjustments": {"exposure": -1}}),
    );
    let out = Developer::new(img.clone()).render_with(&with_masks(vec![ring]), &cpu());
    let plain = Developer::new(img.clone()).render_with(&DevelopSettings::default(), &cpu());
    let g = |img: &Rgb8Image, x, y| px(img, x, y)[1];
    assert_eq!(g(&out, 100, 100), g(&plain, 100, 100), "the subtracted centre is untouched");
    assert!(g(&out, 100, 40) < g(&plain, 100, 40) - 20, "the ring is darker");
    assert_eq!(g(&out, 5, 5), g(&plain, 5, 5), "outside the ring is untouched");
    let overlap = mask(
        json!([
            {"id": "left", "kind": "linear", "from": [0.55, 0.5], "to": [0.45, 0.5]},
            {"id": "top", "kind": "linear", "mode": "intersect", "from": [0.5, 0.55], "to": [0.5, 0.45]}
        ]),
        json!({"adjustments": {"exposure": -1}}),
    );
    let out = Developer::new(img).render_with(&with_masks(vec![overlap]), &cpu());
    assert!(g(&out, 20, 20) < g(&plain, 20, 20) - 20, "top-left (both) is darker");
    for (x, y) in [(180, 20), (20, 180), (180, 180)] {
        assert_eq!(g(&out, x, y), g(&plain, x, y), "({x}, {y}) lies outside the intersection");
    }
}

/// A luminance range reads the input image, so dragging exposure moves neither its plane nor the cached
/// layers, and local and global slider changes reuse the composited planes.
#[test]
fn luminance_range_is_stable_under_exposure() {
    let img = textured(300, 200);
    let lum = mask(
        json!([{"id": "y", "kind": "luminance", "range": [0.6, 1.0], "feather": 20}]),
        json!({"id": "bright", "adjustments": {"shadows": 50}}),
    );
    let mut s = with_masks(vec![lum]);
    let dev = Developer::new(img);
    let (w, h, before) = dev.mask_overlay(&s, "bright").unwrap();
    let _ = dev.render(&s);
    s.light.exposure = 2.0;
    let (_, _, after) = dev.mask_overlay(&s, "bright").unwrap();
    let bytes = |v: &[f32]| v.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<u8>>();
    assert_eq!(bytes(&before), bytes(&after), "the mask moved with exposure");
    assert_eq!((w, h), (300, 200));
    assert!(before.iter().any(|&v| v > 0.9) && before.iter().any(|&v| v == 0.0), "a partial selection");
    let _ = dev.render(&s);
    s.masks[0].adjustments.shadows = 80.0;
    let _ = dev.render(&s);
    assert_eq!(dev.mask_build_count(), 1, "global and local slider changes reuse the composited planes");
    s.masks[0].opacity = 60.0;
    let _ = dev.render(&s);
    assert_eq!(dev.mask_build_count(), 2, "a mask edit re-composites");
}

/// `mask_overlay` returns the composited plane at the render's size, also for a disabled mask, and `None`
/// for an unknown id.
#[test]
fn mask_overlay_returns_the_plane() {
    let img = textured(300, 200);
    let m = mask(
        json!([{"id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.25, 0.25], "angle": 0, "feather": 30}]),
        json!({"id": "m", "enabled": false, "invert": true, "opacity": 80, "feather": 20}),
    );
    let mut s = with_masks(vec![m.clone()]);
    let dev = Developer::new(img.clone());
    let (w, h, plane) = dev.mask_overlay(&s, "m").unwrap();
    let f2o = GeometryPlan::new(&s.geometry, 300, 200, None).frame_to_output_matrix();
    let ctx = MaskContext { width: 300, height: 200, frame_to_output: &f2o, input_luma: &[], input_rgb: &img, ai_rasters: &no_ai };
    assert_eq!((w, h), (300, 200));
    assert_eq!(plane, rasterise_mask(&m, &ctx).plane.data);
    assert!((plane[0] - 0.8).abs() < 1e-6 && plane[100 * 300 + 150] == 0.0, "inverted, opacity 80");
    assert!(dev.mask_overlay(&s, "nope").is_none());
    // With a crop the overlay has the cropped render's size.
    s.geometry = crop_geometry(Rotation::R0, CropRect { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
    let (w, h, _) = dev.mask_overlay(&s, "m").unwrap();
    assert_eq!((w, h), dev.developed_size(&s.geometry));
}

/// Local white balance, saturation and hue move colour only where the mask is.
#[test]
fn local_colour_sliders() {
    let img = textured(200, 100);
    let left = json!([{"id": "l", "kind": "linear", "from": [0.45, 0.5], "to": [0.35, 0.5]}]);
    let plain = Developer::new(img.clone()).render_with(&DevelopSettings::default(), &cpu());
    let render = |adj: serde_json::Value, wb: WhiteBalance| {
        let mut s = with_masks(vec![mask(left.clone(), json!({"adjustments": adj}))]);
        s.white_balance = wb;
        Developer::new(img.clone()).render_with(&s, &cpu())
    };
    let warm = render(json!({"temperature": 60}), WhiteBalance::AsShot);
    let (r, b) = (block_mean(&warm, 0, 0, 20, 100, 0), block_mean(&warm, 0, 0, 20, 100, 2));
    let (r0, b0) = (block_mean(&plain, 0, 0, 20, 100, 0), block_mean(&plain, 0, 0, 20, 100, 2));
    assert!(r > r0 + 3.0 && b < b0 - 3.0, "warmer on the left: {r} {b} vs {r0} {b0}");
    assert!(rows_equal(&warm, &plain, 0, 0) && block_mean(&warm, 150, 0, 200, 100, 0) == block_mean(&plain, 150, 0, 200, 100, 0));
    // Absolute white balance adds a mired shift too (higher temperature = warmer).
    let abs = WhiteBalance::Absolute { temperature: 5500.0, tint: 0.0 };
    let base = render(json!({"saturation": 0.0001}), abs.clone());
    let warm = render(json!({"temperature": 60}), abs);
    assert!(block_mean(&warm, 0, 0, 20, 100, 0) > block_mean(&base, 0, 0, 20, 100, 0) + 3.0);
    let grey = render(json!({"saturation": -100}), WhiteBalance::AsShot);
    let p = px(&grey, 5, 50);
    assert!(p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1, "saturation −100 is grey: {p:?}");
    let shifted = render(json!({"hue": 100}), WhiteBalance::AsShot);
    assert_ne!(px(&shifted, 5, 50), px(&plain, 5, 50));
    assert_eq!(px(&shifted, 195, 50), px(&plain, 195, 50));
}

/// Masked renders, CPU and GPU: a 1600 px proxy with three masks (first render and a slider change) and a
/// 24 MP export. `cargo test -p photobook-develop --release --test masks -- --ignored --nocapture timing_masked`.
#[test]
#[ignore]
fn timing_masked_renders() {
    let three = vec![
        mask(
            json!([{"id": "r", "kind": "radial", "center": [0.5, 0.45], "radii": [0.35, 0.4], "angle": 10, "feather": 60}]),
            json!({"id": "vignette", "invert": true, "adjustments": {"exposure": -0.7, "contrast": 10}}),
        ),
        mask(
            json!([{"id": "l", "kind": "linear", "from": [0.5, 0.0], "to": [0.5, 0.4]}]),
            json!({"id": "sky", "invert": true, "adjustments": {"saturation": 30, "temperature": -15, "highlights": -40}}),
        ),
        mask(
            json!([{"id": "b", "kind": "brush", "strokes": [{"points": [[0.2, 0.7], [0.5, 0.75], [0.8, 0.7]], "size": 12, "feather": 50}]}]),
            json!({"id": "brush", "adjustments": {"clarity": 40, "shadows": 30}}),
        ),
    ];
    let mut s = with_masks(three);
    s.light.exposure = 0.2;
    s.detail.texture = 10.0;
    let _ = photobook_develop::gpu::GpuContext::get(); // device and kernels up before timing
    for backend in [RenderBackend::Cpu, RenderBackend::Auto] {
        let options = RenderOptions { backend, ..RenderOptions::default() };
        let dev = Developer::new(common::scene(1600, 1067));
        let t = Instant::now();
        let _ = dev.render_with(&s, &options);
        let first = t.elapsed();
        let mut s2 = s.clone();
        let mut times = Vec::new();
        for i in 0..10 {
            s2.light.exposure = 0.2 + i as f64 * 0.01;
            s2.masks[0].adjustments.exposure = -0.7 - i as f64 * 0.02;
            let t = Instant::now();
            let _ = dev.render_with(&s2, &options);
            times.push(t.elapsed().as_secs_f64() * 1e3);
        }
        times.sort_by(f64::total_cmp);
        let plain_t = {
            let mut p = s.clone();
            p.masks.clear();
            let _ = dev.render_with(&p, &options);
            let t = Instant::now();
            let _ = dev.render_with(&p, &options);
            t.elapsed().as_secs_f64() * 1e3
        };
        eprintln!(
            "1600 px, three masks, {:?}: first render {first:?}, slider change median {:.1} ms (without masks {plain_t:.1} ms)",
            dev.last_backend().unwrap(),
            times[times.len() / 2]
        );
    }
    let big = common::scene(6000, 4000);
    let t = Instant::now();
    let _ = render_full(&big, &s).unwrap();
    eprintln!("24 MP export, three masks (GPU when available): {:?}", t.elapsed());
    let t = Instant::now();
    let _ = Developer::new(big).render_with(&s, &cpu());
    eprintln!("24 MP render, three masks, CPU: {:?}", t.elapsed());
}
