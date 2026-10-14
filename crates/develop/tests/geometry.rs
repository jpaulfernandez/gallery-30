//! D2.1 geometry: exact orientation/crop copies, straighten quality, constrain, the Developer's warp
//! cache, and the parity fixtures for the TypeScript crop overlay.
//!
//! Regenerate the fixtures with
//! `UPDATE_GEOMETRY_FIXTURES=1 cargo test -p photobook-develop --test geometry`.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use photobook_develop::color::transfer;
use photobook_develop::decode::resize_linear;
use photobook_develop::geometry::crop::{
    constrain_crop, fixed_aspect_half_width, largest_rect_in_quad, max_area_rect_in_rotated, max_crop,
};
use photobook_develop::geometry::warp::{resample, warp_with_stats, Quality, WarpPath};
use photobook_develop::geometry::{GeometryPlan, Homography};
use photobook_develop::geometry::remap::{remap_geometry_vectors, remap_matrix, remap_points};
use photobook_develop::geometry::transform::{
    centred_units, conjugate_rotation, from_centred_units, manual_matrix, manual_matrix_with_focal, max_crop_in_warped,
    pitch_yaw, pre_crop_matrix, recentre_and_rescale,
};
use photobook_develop::geometry::upright::{solve_guided, GuidedCorrection, UprightError, DEFAULT_FOCAL};
use photobook_develop::settings::{
    AspectPreset, BrushStroke, Crop, CropAspect, CropRect, Geometry, GuideKind, ManualTransform, Mask, MaskComponent,
    MaskMode, MaskShape, Rotation, Upright, UprightGuide, UprightMode,
};
use photobook_develop::{render_full, render_preview, DevelopSettings, Developer, LinearImage};
use serde_json::{json, Value};

// ---------- helpers ----------

/// Every pixel distinct: R = x, G = y, B = a hash.
fn tagged(w: u32, h: u32) -> LinearImage {
    let data = (0..h).flat_map(|y| (0..w).flat_map(move |x| [x as f32, y as f32, ((x * 31 + y * 17) % 97) as f32])).collect();
    LinearImage::new(w, h, data)
}

fn geometry_with_crop(rect: CropRect, angle: f64) -> Geometry {
    Geometry { crop: Some(Crop { rect, angle, aspect: CropAspect::default() }), ..Geometry::default() }
}

fn to8(v: f32) -> u8 {
    (transfer::linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8
}

// ---------- exact paths ----------

#[test]
fn rotate_90_is_an_exact_transposition() {
    let src = tagged(7, 5);
    for rot in [Rotation::R90, Rotation::R180, Rotation::R270] {
        let g = Geometry { rotate: rot, ..Geometry::default() };
        let plan = GeometryPlan::new(&g, 7, 5, None);
        let (out, stats) = warp_with_stats(&src, &plan, Quality::Export);
        assert_eq!(stats.path, WarpPath::Copy);
        for y in 0..out.height {
            for x in 0..out.width {
                let expect = match rot {
                    Rotation::R90 => src.pixel(y, 4 - x),
                    Rotation::R180 => src.pixel(6 - x, 4 - y),
                    _ => src.pixel(6 - y, x),
                };
                assert_eq!(out.pixel(x, y), expect, "{rot:?} at {x},{y}");
            }
        }
    }
    let g = Geometry { rotate: Rotation::R90, ..Geometry::default() };
    let plan = GeometryPlan::new(&g, 7, 5, None);
    assert_eq!((plan.output_width, plan.output_height), (5, 7));
}

#[test]
fn flips_mirror_exactly() {
    let src = tagged(6, 4);
    let g = Geometry { flip_h: true, ..Geometry::default() };
    let out = warp_with_stats(&src, &GeometryPlan::new(&g, 6, 4, None), Quality::Preview).0;
    for y in 0..4 {
        for x in 0..6 {
            assert_eq!(out.pixel(x, y), src.pixel(5 - x, y));
        }
    }
    let g = Geometry { flip_v: true, rotate: Rotation::R90, ..Geometry::default() };
    let out = warp_with_stats(&src, &GeometryPlan::new(&g, 6, 4, None), Quality::Preview).0;
    // Rotate 90 (out(x, y) = src(y, 3 - x)), then mirror top/bottom in the rotated frame.
    for y in 0..6 {
        for x in 0..4 {
            assert_eq!(out.pixel(x, y), src.pixel(5 - y, 3 - x));
        }
    }
}

#[test]
fn centre_half_crop_returns_the_centre_pixels() {
    let src = tagged(100, 80);
    let g = geometry_with_crop(CropRect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0.0);
    let plan = GeometryPlan::new(&g, 100, 80, None);
    let (out, stats) = warp_with_stats(&src, &plan, Quality::Export);
    assert_eq!(stats.path, WarpPath::Copy);
    assert_eq!((out.width, out.height), (50, 40));
    for y in 0..40 {
        for x in 0..50 {
            assert_eq!(out.pixel(x, y), src.pixel(25 + x, 20 + y));
        }
    }
    // Crop + rotate together, still exact.
    let g = Geometry { rotate: Rotation::R270, ..g };
    let (out, stats) = warp_with_stats(&src, &GeometryPlan::new(&g, 100, 80, None), Quality::Export);
    assert_eq!(stats.path, WarpPath::Copy);
    assert_eq!((out.width, out.height), (40, 50));
    // A downscaled crop goes through the exact copy and then the Lanczos resize.
    let g = geometry_with_crop(CropRect { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0.0);
    let (out, stats) = warp_with_stats(&src, &GeometryPlan::new(&g, 100, 80, Some(25)), Quality::Export);
    assert_eq!(stats.path, WarpPath::CopyResize);
    assert_eq!((out.width, out.height), (25, 20));
}

// ---------- resampling ----------

/// Dark image with a bright horizontal line (Gaussian profile, σ = 1.5 px) through `y0`.
fn line_image(w: u32, h: u32, y0: f64) -> LinearImage {
    let data = (0..h)
        .flat_map(|y| {
            let d = (y as f64 + 0.5 - y0) / 1.5;
            let v = (0.05 + 0.8 * (-0.5 * d * d).exp()) as f32;
            (0..w).flat_map(move |_| [v, v, v])
        })
        .collect();
    LinearImage::new(w, h, data)
}

#[test]
fn straighten_keeps_lines_straight() {
    let (w, h) = (400u32, 300u32);
    let src = line_image(w, h, 150.0);
    let angle = 5.0f64;
    let g = geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, angle);
    let plan = GeometryPlan::new(&g, w, h, None);
    for quality in [Quality::Preview, Quality::Export] {
        let (out, stats) = warp_with_stats(&src, &plan, quality);
        assert_eq!(stats.out_of_bounds, 0);
        // Intensity centroid of the line per column, over the middle 80 % of the width.
        let mut pts = Vec::new();
        for x in (out.width / 10)..(out.width * 9 / 10) {
            let (mut sw, mut sy) = (0.0f64, 0.0f64);
            for y in 0..out.height {
                let v = (out.pixel(x, y)[1] as f64 - 0.05).max(0.0);
                if v > 0.01 {
                    sw += v;
                    sy += v * (y as f64 + 0.5);
                }
            }
            pts.push((x as f64 + 0.5, sy / sw));
        }
        let n = pts.len() as f64;
        let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
        let slope = sxy / sxx;
        let var = pts.iter().map(|p| (p.1 - (my + slope * (p.0 - mx))).powi(2)).sum::<f64>() / n;
        eprintln!("{quality:?}: slope {slope:.6} (tan 5° = {:.6}), residual variance {var:.2e} px²", angle.to_radians().tan());
        assert!((slope - angle.to_radians().tan()).abs() < 1e-3, "slope {slope}");
        assert!(var < 1e-3, "residual variance {var}");
    }
}

#[test]
fn constrained_crops_never_sample_outside_the_image() {
    let src = tagged(300, 200);
    for &(w, h) in &[(300u32, 200u32), (200, 300)] {
        let src = if w == 300 { src.clone() } else { tagged(200, 300) };
        for angle in [-45.0, -30.0, -12.5, -5.0, 0.7, 5.0, 30.0, 45.0] {
            for rect in [
                CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
                CropRect { x: 0.1, y: 0.05, w: 0.6, h: 0.8 },
                CropRect { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
            ] {
                let g = geometry_with_crop(rect.clone(), angle);
                let plan = GeometryPlan::new(&g, w, h, None);
                let (_, stats) = resample(&src, &plan, Quality::Preview);
                assert_eq!(stats.out_of_bounds, 0, "{w}x{h} angle {angle} rect {rect:?}");
            }
        }
    }
    // Without constrain, a full-frame crop at an angle shows the clamped corners.
    let mut g = geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 10.0);
    g.constrain_crop = false;
    let (_, stats) = resample(&src, &GeometryPlan::new(&g, 300, 200, None), Quality::Preview);
    assert!(stats.out_of_bounds > 0);
}

/// Smooth texture with detail at a few frequencies (all well below Nyquist after the downscale).
fn texture(w: u32, h: u32) -> LinearImage {
    let data = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                let (fx, fy) = (x as f32, y as f32);
                let r = 0.4 + 0.3 * (fx * 0.031).sin() * (fy * 0.023).cos();
                let g = 0.35 + 0.25 * (fx * 0.05 + fy * 0.04).sin();
                let b = 0.3 + 0.2 * ((fx - fy) * 0.017).cos() + 0.1 * (fy * 0.08).sin();
                [r * r, g * g, b * b]
            })
        })
        .collect();
    LinearImage::new(w, h, data)
}

#[test]
fn lanczos_downscale_matches_fast_image_resize() {
    let src = texture(600, 400);
    for target in [520u32, 400, 200] {
        let plan = GeometryPlan::new(&Geometry::default(), 600, 400, Some(target));
        let (ours, stats) = resample(&src, &plan, Quality::Export);
        let theirs = resize_linear(src.clone(), plan.output_width, plan.output_height).unwrap();
        // Ignore a 3 px border, where edge handling differs.
        let mut worst = 0u8;
        for y in 3..ours.height - 3 {
            for x in 3..ours.width - 3 {
                let (a, b) = (ours.pixel(x, y), theirs.pixel(x, y));
                for c in 0..3 {
                    worst = worst.max(to8(a[c]).abs_diff(to8(b[c])));
                }
            }
        }
        eprintln!("downscale to {target}: {:?}, max difference {worst} levels", stats.path);
        assert!(worst <= 3, "target {target}: {worst} levels");
    }
}

// ---------- pipeline integration ----------

#[test]
fn developer_caches_the_warp() {
    let src = texture(320, 240);
    let dev = Developer::new(src.clone());
    let mut s = DevelopSettings::default();
    let plain = dev.render(&s);
    assert_eq!(dev.warp_count(), 0);

    s.geometry = geometry_with_crop(CropRect { x: 0.1, y: 0.1, w: 0.7, h: 0.6 }, 4.0);
    let a = dev.render(&s);
    assert_eq!((a.width, a.height), dev.developed_size(&s.geometry));
    s.light.exposure = 0.5;
    s.light.shadows = 30.0; // needs the base of the warped image
    let b = dev.render(&s);
    assert_eq!(dev.warp_count(), 1, "a light change must not re-warp");
    assert_ne!(a, b);
    // Same result as the one-shot export path.
    assert_eq!(render_full(&src, &s).unwrap(), b);

    // The crop lives in the rotated frame, so a 90° turn re-reads the same fractions there.
    s.geometry.rotate = Rotation::R90;
    let c = dev.render(&s);
    assert_eq!(dev.warp_count(), 2);
    assert_eq!((c.width, c.height), dev.developed_size(&s.geometry));
    assert!(c.height > c.width);

    // Back to no geometry: no warp, same pixels as before.
    let back = dev.render(&DevelopSettings::default());
    assert_eq!(dev.warp_count(), 2);
    assert_eq!(back, plain);
}

#[test]
fn preview_has_the_cropped_aspect() {
    let src = texture(600, 400);
    let mut s = DevelopSettings::default();
    s.geometry = geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 0.5, h: 1.0 }, 0.0);
    let jpeg = render_preview(&src, &s, 200, 85).unwrap();
    let header = turbojpeg::read_header(&jpeg).unwrap();
    // 300 × 400 crop fitted to a 200 px long edge.
    assert_eq!((header.width, header.height), (150, 200));
}

// ---------- parity fixtures ----------

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/geometry")
}

const TOLERANCE: f64 = 1e-9;

/// Numbers within `tol` (relative above 1), everything else equal.
fn close_json(a: &Value, b: &Value, path: &str, tol: f64) -> Result<(), String> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            if (x - y).abs() <= tol * y.abs().max(1.0) {
                Ok(())
            } else {
                Err(format!("{path}: {x} vs {y}"))
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            x.iter().zip(y).enumerate().try_for_each(|(i, (x, y))| close_json(x, y, &format!("{path}[{i}]"), tol))
        }
        (Value::Object(x), Value::Object(y)) if x.len() == y.len() => x.iter().try_for_each(|(k, v)| {
            y.get(k).ok_or_else(|| format!("{path}.{k} missing")).and_then(|w| close_json(v, w, &format!("{path}.{k}"), tol))
        }),
        _ if a == b => Ok(()),
        _ => Err(format!("{path}: {a} vs {b}")),
    }
}

fn check_fixture(name: &str, function: &str, cases: Vec<Value>) {
    check_fixture_with(name, function, TOLERANCE, cases)
}

fn check_fixture_with(name: &str, function: &str, tolerance: f64, cases: Vec<Value>) {
    let doc = json!({ "function": function, "tolerance": tolerance, "cases": cases });
    let path = fixtures_dir().join(format!("{name}.json"));
    if std::env::var_os("UPDATE_GEOMETRY_FIXTURES").is_some() {
        fs::create_dir_all(fixtures_dir()).unwrap();
        fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        return;
    }
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run with UPDATE_GEOMETRY_FIXTURES=1)", path.display()));
    let stored: Value = serde_json::from_str(&text).unwrap();
    if let Err(e) = close_json(&doc, &stored, name, tolerance) {
        panic!("{name}.json disagrees: {e}");
    }
}

const ANGLES: [f64; 7] = [0.0, 5.0, -5.0, 30.0, -30.0, 45.0, -45.0];
/// Landscape 3:2 and portrait 2:3 frames.
const IMAGE_ASPECTS: [f64; 2] = [1.5, 2.0 / 3.0];

fn rect_json(r: &CropRect) -> Value {
    json!({ "x": r.x, "y": r.y, "w": r.w, "h": r.h })
}

/// `free`, `original`, 1:1 and 16:9, as the aspect argument for a frame of `image_aspect`.
fn aspects(image_aspect: f64) -> [(&'static str, Option<f64>); 4] {
    [("free", None), ("original", Some(image_aspect)), ("1:1", Some(1.0)), ("16:9", Some(16.0 / 9.0))]
}

#[test]
fn fixture_max_area_rect() {
    let mut cases = Vec::new();
    for (w, h) in [(1.5, 1.0), (1.0, 1.5), (10.0, 1.0), (1.0, 1.0)] {
        for angle in ANGLES {
            let (rw, rh) = max_area_rect_in_rotated(w, h, angle);
            cases.push(json!({ "input": { "w": w, "h": h, "angle": angle }, "output": { "w": rw, "h": rh } }));
        }
    }
    check_fixture("max-area-rect", "maxAreaRectInRotated", cases);
}

#[test]
fn fixture_fixed_aspect() {
    let mut cases = Vec::new();
    for ia in IMAGE_ASPECTS {
        for (label, r) in aspects(ia) {
            let r = r.unwrap_or(ia);
            for angle in ANGLES {
                // Centred in the frame: a, b are the half extents.
                let (a, b) = (ia / 2.0, 0.5);
                let p = fixed_aspect_half_width(a, b, r, angle);
                cases.push(json!({
                    "aspectLabel": label,
                    "input": { "a": a, "b": b, "r": r, "angle": angle },
                    "output": { "halfWidth": p },
                }));
            }
        }
    }
    check_fixture("fixed-aspect", "fixedAspectHalfWidth", cases);
}

#[test]
fn fixture_constrain_crop() {
    let rects = [
        CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
        CropRect { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
        CropRect { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
        CropRect { x: -0.05, y: 0.1, w: 0.6, h: 0.95 },
        CropRect { x: 0.7, y: 0.0, w: 0.3, h: 0.4 },
    ];
    let mut cases = Vec::new();
    for ia in IMAGE_ASPECTS {
        for (label, aspect) in aspects(ia) {
            for angle in ANGLES {
                for rect in &rects {
                    let out = constrain_crop(rect.clone(), aspect, angle, ia);
                    cases.push(json!({
                        "aspectLabel": label,
                        "input": { "rect": rect_json(rect), "aspect": aspect, "angle": angle, "imageAspect": ia },
                        "output": rect_json(&out),
                    }));
                }
                let out = max_crop(aspect, angle, ia);
                cases.push(json!({
                    "aspectLabel": label,
                    "maxCrop": true,
                    "input": { "rect": rect_json(&CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }), "aspect": aspect, "angle": angle, "imageAspect": ia },
                    "output": rect_json(&out),
                }));
            }
        }
    }
    check_fixture("constrain-crop", "constrainCrop", cases);
}

#[test]
fn fixture_rect_in_quad() {
    let rotated = |w: f64, h: f64, deg: f64| -> [[f64; 2]; 4] {
        let (s, c) = deg.to_radians().sin_cos();
        let (cx, cy) = (w / 2.0, h / 2.0);
        [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]].map(|[x, y]| {
            let (dx, dy) = (x - cx, y - cy);
            [cx + c * dx - s * dy, cy + s * dx + c * dy]
        })
    };
    let quads = [
        ("rotated-5", rotated(1.5, 1.0, 5.0)),
        ("rotated-30", rotated(1.5, 1.0, 30.0)),
        ("portrait-rotated-45", rotated(2.0 / 3.0, 1.0, -45.0)),
        ("keystone", [[0.1, 0.0], [1.4, 0.0], [1.5, 1.0], [0.0, 1.0]]),
        ("perspective", Homography([1.0, 0.05, 0.0, 0.02, 1.0, 0.0, 0.08, -0.05, 1.0]).map_rect_corners(0.0, 0.0, 1.5, 1.0)),
    ];
    let mut cases = Vec::new();
    for (name, quad) in quads {
        let cx = quad.iter().map(|p| p[0]).sum::<f64>() / 4.0;
        let cy = quad.iter().map(|p| p[1]).sum::<f64>() / 4.0;
        for center in [[cx, cy], [cx * 0.8, cy * 1.1]] {
            for aspect in [1.5, 1.0, 16.0 / 9.0, 2.0 / 3.0] {
                let (hw, hh) = largest_rect_in_quad(&quad, center, aspect);
                cases.push(json!({
                    "quadLabel": name,
                    "input": { "quad": quad, "center": center, "aspect": aspect },
                    "output": { "halfWidth": hw, "halfHeight": hh },
                }));
            }
        }
    }
    check_fixture("rect-in-quad", "largestRectInQuad", cases);
}

#[test]
fn fixture_geometry_plan() {
    let geometries: Vec<(&str, Geometry)> = vec![
        ("default", Geometry::default()),
        ("rotate-90-flip-h", Geometry { rotate: Rotation::R90, flip_h: true, ..Geometry::default() }),
        ("rotate-270-flip-v", Geometry { rotate: Rotation::R270, flip_v: true, ..Geometry::default() }),
        ("crop", geometry_with_crop(CropRect { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, 0.0)),
        ("straighten-5", geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 5.0)),
        ("straighten-minus-30-offset", geometry_with_crop(CropRect { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, -30.0)),
        (
            "straighten-45-square-rotate-180",
            Geometry {
                rotate: Rotation::R180,
                crop: Some(Crop {
                    rect: CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
                    angle: 45.0,
                    aspect: CropAspect::Ratio(1.0, 1.0),
                }),
                ..Geometry::default()
            },
        ),
        (
            "original-aspect-unconstrained",
            Geometry {
                constrain_crop: false,
                crop: Some(Crop {
                    rect: CropRect { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
                    angle: -5.0,
                    aspect: CropAspect::Preset(AspectPreset::Original),
                }),
                ..Geometry::default()
            },
        ),
        // D2.2: appended so the cases above stay byte-identical.
        ("manual-vertical-minus-30", manual_geometry(ManualTransform { vertical: -30.0, ..ManualTransform::default() })),
        (
            "manual-all-sliders-crop-4",
            Geometry {
                transform: ManualTransform {
                    vertical: 20.0,
                    horizontal: -15.0,
                    rotate: 3.0,
                    aspect: 25.0,
                    scale: 110.0,
                    offset_x: 5.0,
                    offset_y: -4.0,
                },
                crop: Some(Crop {
                    rect: CropRect { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
                    angle: 4.0,
                    aspect: CropAspect::Ratio(4.0, 5.0),
                }),
                ..Geometry::default()
            },
        ),
        (
            "manual-unconstrained",
            Geometry {
                constrain_crop: false,
                ..manual_geometry(ManualTransform { horizontal: 40.0, scale: 90.0, ..ManualTransform::default() })
            },
        ),
        ("upright-guided", upright_geometry(UprightMode::Guided, Some(sample_upright()), None)),
        (
            "upright-full-rotate-90-crop",
            Geometry {
                rotate: Rotation::R90,
                crop: Some(Crop { rect: CropRect { x: 0.2, y: 0.1, w: 0.6, h: 0.7 }, angle: -3.0, aspect: CropAspect::default() }),
                transform: ManualTransform { vertical: -10.0, ..ManualTransform::default() },
                ..upright_geometry(UprightMode::Full, Some(sample_upright()), Some(0.9))
            },
        ),
        ("upright-off-ignores-transform", upright_geometry(UprightMode::Off, Some(sample_upright()), None)),
        (
            // Every stage at once: rotate, both flips, Upright, every manual slider, a fixed-aspect straightened crop.
            "everything-rotate-270-flips-upright-manual-crop",
            Geometry {
                rotate: Rotation::R270,
                flip_h: true,
                flip_v: true,
                crop: Some(Crop {
                    rect: CropRect { x: 0.15, y: 0.12, w: 0.6, h: 0.7 },
                    angle: 6.5,
                    aspect: CropAspect::Ratio(4.0, 5.0),
                }),
                transform: ManualTransform {
                    vertical: -18.0,
                    horizontal: 7.0,
                    rotate: -2.5,
                    aspect: 12.0,
                    scale: 95.0,
                    offset_x: 3.0,
                    offset_y: -2.0,
                },
                ..upright_geometry(UprightMode::Full, Some(sample_upright()), Some(0.9))
            },
        ),
    ];
    let mut cases = Vec::new();
    for (name, g) in &geometries {
        for (w, h, target) in [(6000u32, 4000u32, None), (4000, 6000, None), (6000, 4000, Some(1600u32))] {
            let p = GeometryPlan::new(g, w, h, target);
            cases.push(json!({
                "label": name,
                "input": { "geometry": g, "sourceWidth": w, "sourceHeight": h, "targetLongEdge": target },
                "output": {
                    "outputWidth": p.output_width,
                    "outputHeight": p.output_height,
                    "developedWidth": p.developed_size.0,
                    "developedHeight": p.developed_size.1,
                    "crop": rect_json(&p.crop),
                    "angle": p.angle,
                    "forward": p.forward.0,
                    "inverse": p.inverse.0,
                },
            }));
        }
    }
    check_fixture("geometry-plan", "geometryPlan", cases);
}

// ---------- timing ----------

/// A 24 MP export warp (3° straighten, Lanczos3). Run with
/// `cargo test -p photobook-develop --release --test geometry -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_24mp_warp() {
    let (w, h) = (6000u32, 4000u32);
    let src = texture(w, h);
    let g = geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 3.0);
    let plan = GeometryPlan::new(&g, w, h, None);
    for quality in [Quality::Export, Quality::Preview] {
        for _ in 0..2 {
            let t = Instant::now();
            let (out, stats) = warp_with_stats(&src, &plan, quality);
            eprintln!("24 MP straighten 3°, {quality:?}: {:?} -> {}x{} ({:?})", t.elapsed(), out.width, out.height, stats.path);
        }
    }
    let crop = geometry_with_crop(CropRect { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 0.0);
    let t = Instant::now();
    let (_, stats) = warp_with_stats(&src, &GeometryPlan::new(&crop, w, h, None), Quality::Export);
    eprintln!("24 MP crop only: {:?} ({:?})", t.elapsed(), stats.path);
    let t = Instant::now();
    let (_, stats) = warp_with_stats(&src, &GeometryPlan::new(&g, w, h, Some(2048)), Quality::Preview);
    eprintln!("24 MP straighten 3° into a 2048 px preview: {:?} ({:?})", t.elapsed(), stats.path);
}

// ---------- D2.2: manual Transform and guided Upright ----------

fn manual_geometry(transform: ManualTransform) -> Geometry {
    Geometry { transform, ..Geometry::default() }
}

fn upright_geometry(mode: UprightMode, transform: Option<[f64; 9]>, focal: Option<f64>) -> Geometry {
    Geometry { upright: Upright { mode, guides: Vec::new(), transform, focal }, ..Geometry::default() }
}

/// A camera rotation `K · R_z(roll) · R_x(pitch) · R_y(yaw) · K⁻¹` in normalised coordinates of a
/// `fw × fh` frame (not recentred): what a tilted camera does to an upright scene.
fn camera(pitch_deg: f64, yaw_deg: f64, roll_deg: f64, focal: f64, fw: f64, fh: f64) -> Homography {
    let h = conjugate_rotation(pitch_yaw(pitch_deg.to_radians(), yaw_deg.to_radians()), focal)
        .then(&Homography::rotate(roll_deg.to_radians()));
    centred_units(fw, fh).then(&h).then(&from_centred_units(fw, fh)).normalized()
}

/// A stored Upright matrix for fixtures and the timing test: a recentred 8° pitch, −5° yaw, 1° roll
/// correction on a 3:2 frame.
fn sample_upright() -> [f64; 9] {
    let h = conjugate_rotation(pitch_yaw(8f64.to_radians(), -5f64.to_radians()), DEFAULT_FOCAL)
        .then(&Homography::rotate(1f64.to_radians()));
    let h = recentre_and_rescale(&h, (1.0, 2.0 / 3.0));
    centred_units(1.5, 1.0).then(&h).then(&from_centred_units(1.5, 1.0)).normalized().0
}

fn guide(id: &str, kind: GuideKind, from: [f64; 2], to: [f64; 2]) -> UprightGuide {
    UprightGuide { id: id.into(), kind, from, to }
}

/// An image of Gaussian lines (σ = 1.5 px) on a dark background, drawn in *scene* pixel coordinates and
/// seen through `camera` (normalised scene → normalised image): `vertical` are scene x positions and
/// `horizontal` scene y positions, both in fractions.
fn scene_image(w: u32, h: u32, camera: &Homography, vertical: &[f64], horizontal: &[f64]) -> LinearImage {
    let inv = camera.invert().unwrap();
    let (wf, hf) = (w as f64, h as f64);
    let data = (0..h)
        .flat_map(|y| {
            let inv = &inv;
            (0..w).flat_map(move |x| {
                let q = inv.apply([(x as f64 + 0.5) / wf, (y as f64 + 0.5) / hf]);
                let (qx, qy) = (q[0] * wf, q[1] * hf);
                let mut v = 0.05;
                for &lx in vertical {
                    let d = (qx - lx * wf) / 1.5;
                    v += 0.8 * (-0.5 * d * d).exp();
                }
                for &ly in horizontal {
                    let d = (qy - ly * hf) / 1.5;
                    v += 0.8 * (-0.5 * d * d).exp();
                }
                let v = v as f32;
                [v, v, v]
            })
        })
        .collect();
    LinearImage::new(w, h, data)
}

/// Intensity centroid (above the background) of `img` along x for row `y`, within `[x0, x1)`.
fn row_centroid(img: &LinearImage, y: u32, x0: u32, x1: u32) -> Option<f64> {
    let (mut sw, mut sx) = (0.0f64, 0.0f64);
    for x in x0..x1 {
        let v = (img.pixel(x, y)[1] as f64 - 0.06).max(0.0);
        if v > 0.02 {
            sw += v;
            sx += v * (x as f64 + 0.5);
        }
    }
    (sw > 0.0).then(|| sx / sw)
}

/// Intensity centroid along y for column `x`, within `[y0, y1)`.
fn column_centroid(img: &LinearImage, x: u32, y0: u32, y1: u32) -> Option<f64> {
    let (mut sw, mut sy) = (0.0f64, 0.0f64);
    for y in y0..y1 {
        let v = (img.pixel(x, y)[1] as f64 - 0.06).max(0.0);
        if v > 0.02 {
            sw += v;
            sy += v * (y as f64 + 0.5);
        }
    }
    (sw > 0.0).then(|| sy / sw)
}

/// Least-squares slope of `b` against `a`.
fn slope(pts: &[(f64, f64)]) -> f64 {
    let n = pts.len() as f64;
    let (ma, mb) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
    let sab: f64 = pts.iter().map(|p| (p.0 - ma) * (p.1 - mb)).sum();
    let saa: f64 = pts.iter().map(|p| (p.0 - ma).powi(2)).sum();
    sab / saa
}

fn assert_close(a: &Homography, b: &Homography, eps: f64) {
    let (a, b) = (a.normalized(), b.normalized());
    for (x, y) in a.0.iter().zip(b.0.iter()) {
        assert!((x - y).abs() <= eps, "{a:?}\nvs\n{b:?}");
    }
}

#[test]
fn manual_sliders_basic_properties() {
    let (fw, fh) = (600.0, 400.0);
    assert_eq!(manual_matrix(&ManualTransform::default(), fw, fh), Homography::identity());
    let one = |t: ManualTransform| manual_matrix(&t, fw, fh);
    // Rotate about the centre, clockwise: the right-middle point moves down.
    let r = one(ManualTransform { rotate: 10.0, ..ManualTransform::default() });
    let c = r.apply([0.5, 0.5]);
    assert!((c[0] - 0.5).abs() < 1e-12 && (c[1] - 0.5).abs() < 1e-12);
    assert!(r.apply([1.0, 0.5])[1] > 0.5);
    // Scale 150: a corner moves out by 1.5 from the centre.
    let s = one(ManualTransform { scale: 150.0, ..ManualTransform::default() });
    let p = s.apply([1.0, 1.0]);
    assert!((p[0] - 1.25).abs() < 1e-12 && (p[1] - 1.25).abs() < 1e-12);
    // Aspect +100: x stretched by 2^0.137, y squeezed by the same.
    let a = one(ManualTransform { aspect: 100.0, ..ManualTransform::default() });
    let p = a.apply([1.0, 1.0]);
    assert!((p[0] - (0.5 + 0.5 * 0.137f64.exp2())).abs() < 1e-12);
    assert!((p[1] - (0.5 + 0.5 * (-0.137f64).exp2())).abs() < 1e-12);
    // Offsets are in long edges: +50 X moves the centre by half the width (the long edge) right; +50 Y
    // by 0.75 of the height down.
    let o = one(ManualTransform { offset_x: 50.0, offset_y: 50.0, ..ManualTransform::default() });
    let p = o.apply([0.5, 0.5]);
    assert!((p[0] - 1.0).abs() < 1e-12 && (p[1] - 1.25).abs() < 1e-12, "{p:?}");
    // Keystone keeps the centre fixed.
    for (v, h) in [(30.0, 0.0), (0.0, -50.0), (100.0, 100.0)] {
        let k = one(ManualTransform { vertical: v, horizontal: h, ..ManualTransform::default() });
        let c = k.apply([0.5, 0.5]);
        assert!((c[0] - 0.5).abs() < 1e-12 && (c[1] - 0.5).abs() < 1e-12, "{v} {h}: {c:?}");
    }
    // Positive Horizontal enlarges the right side.
    let k = one(ManualTransform { horizontal: 30.0, ..ManualTransform::default() });
    let right = k.apply([1.0, 1.0])[1] - k.apply([1.0, 0.0])[1];
    let left = k.apply([0.0, 1.0])[1] - k.apply([0.0, 0.0])[1];
    assert!(right > left * 1.05, "{right} vs {left}");
}

/// Width between the two vertical lines in rows near the top and bottom of a keystoned render.
fn keystone_widths(vertical: f64) -> (f64, f64) {
    let (w, h) = (600u32, 400u32);
    let src = scene_image(w, h, &Homography::identity(), &[0.25, 0.75], &[]);
    let g = Geometry {
        constrain_crop: false,
        ..manual_geometry(ManualTransform { vertical, ..ManualTransform::default() })
    };
    let plan = GeometryPlan::new(&g, w, h, None);
    let (out, _) = resample(&src, &plan, Quality::Export);
    let width = |y: u32| {
        let half = out.width / 2;
        row_centroid(&out, y, 0, half).unwrap() - row_centroid(&out, y, half, out.width).unwrap()
    };
    (-width(20), -width(out.height - 21))
}

#[test]
fn vertical_minus_30_widens_the_top_and_plus_30_the_bottom() {
    let (top, bottom) = keystone_widths(-30.0);
    eprintln!("Vertical −30: top {top:.1} px, bottom {bottom:.1} px");
    assert!(top > bottom * 1.05, "−30: top {top} bottom {bottom}");
    let (top, bottom) = keystone_widths(30.0);
    eprintln!("Vertical +30: top {top:.1} px, bottom {bottom:.1} px");
    assert!(bottom > top * 1.05, "+30: top {top} bottom {bottom}");
}

#[test]
fn two_vertical_guides_make_a_building_upright() {
    let (w, h) = (600u32, 400u32);
    // Camera tilted up (the top narrows) and rolled 2°, with the 28 mm default focal.
    let cam = camera(-12.0, 0.0, 2.0, DEFAULT_FOCAL, w as f64, h as f64);
    let src = scene_image(w, h, &cam, &[0.3, 0.7], &[]);
    let edge = |x: f64| [cam.apply([x, 0.15]), cam.apply([x, 0.85])];
    let [a0, a1] = edge(0.3);
    let [b0, b1] = edge(0.7);
    let guides = [guide("l", GuideKind::Vertical, a0, a1), guide("r", GuideKind::Vertical, b0, b1)];
    let sol = solve_guided(&guides, w as f64, h as f64, None).unwrap();
    assert_eq!(sol.correction, GuidedCorrection::Vertical);
    assert!(sol.residual < 1e-6, "residual {}", sol.residual);
    let mut g = upright_geometry(UprightMode::Guided, Some(sol.transform), Some(sol.focal));
    g.upright.guides = guides.to_vec();
    let plan = GeometryPlan::new(&g, w, h, None);
    let (out, stats) = resample(&src, &plan, Quality::Export);
    assert_eq!(stats.out_of_bounds, 0, "constrained crop must stay inside the warped image");
    let half = out.width / 2;
    let mut worst = 0.0f64;
    for (x0, x1) in [(0, half), (half, out.width)] {
        let pts: Vec<(f64, f64)> = (out.height / 10..out.height * 9 / 10)
            .filter_map(|y| row_centroid(&out, y, x0, x1).map(|x| (y as f64 + 0.5, x)))
            .collect();
        assert!(pts.len() > (out.height / 2) as usize);
        let angle = slope(&pts).atan().to_degrees();
        eprintln!("building edge in [{x0}, {x1}): {angle:.4}° from vertical");
        worst = worst.max(angle.abs());
    }
    assert!(worst < 0.2, "edges {worst}° from vertical");
    // The input really was keystoned.
    let before: Vec<(f64, f64)> =
        (40..360).filter_map(|y| row_centroid(&src, y, 0, w / 2).map(|x| (y as f64 + 0.5, x))).collect();
    assert!(slope(&before).atan().to_degrees().abs() > 2.0);
}

#[test]
fn two_horizontal_guides_level_a_tilted_horizon() {
    let (w, h) = (600u32, 400u32);
    let cam = camera(0.0, 0.0, 4.0, DEFAULT_FOCAL, w as f64, h as f64);
    let src = scene_image(w, h, &cam, &[], &[0.4, 0.62]);
    let line = |y: f64| [cam.apply([0.1, y]), cam.apply([0.9, y])];
    let [a0, a1] = line(0.4);
    let [b0, b1] = line(0.62);
    let guides = [guide("sea", GuideKind::Horizontal, a0, a1), guide("shore", GuideKind::Horizontal, b0, b1)];
    let sol = solve_guided(&guides, w as f64, h as f64, Some(1.2)).unwrap();
    assert_eq!(sol.correction, GuidedCorrection::Level);
    assert_eq!(sol.focal, 1.2);
    let plan = GeometryPlan::new(&upright_geometry(UprightMode::Guided, Some(sol.transform), None), w, h, None);
    let (out, _) = resample(&src, &plan, Quality::Export);
    let split = (out.height as f64 * 0.51) as u32;
    for (y0, y1) in [(0, split), (split, out.height)] {
        let pts: Vec<(f64, f64)> = (out.width / 10..out.width * 9 / 10)
            .filter_map(|x| column_centroid(&out, x, y0, y1).map(|y| (x as f64 + 0.5, y)))
            .collect();
        let angle = slope(&pts).atan().to_degrees();
        eprintln!("horizon in rows [{y0}, {y1}): {angle:.4}°");
        assert!(angle.abs() < 0.1, "{angle}°");
    }
}

#[test]
fn full_guides_recover_the_focal_and_the_rotation() {
    let (fw, fh) = (600.0, 400.0);
    let cam = camera(-10.0, 14.0, 1.5, 0.9, fw, fh);
    let v = |x: f64| [cam.apply([x, 0.2]), cam.apply([x, 0.8])];
    let hz = |y: f64| [cam.apply([0.2, y]), cam.apply([0.8, y])];
    let g = |id: &str, k, [a, b]: [[f64; 2]; 2]| guide(id, k, a, b);
    let four = [
        g("v1", GuideKind::Vertical, v(0.25)),
        g("v2", GuideKind::Vertical, v(0.75)),
        g("h1", GuideKind::Horizontal, hz(0.3)),
        g("h2", GuideKind::Horizontal, hz(0.7)),
    ];
    let sol = solve_guided(&four, fw, fh, None).unwrap();
    assert!((sol.focal - 0.9).abs() < 1e-9, "focal {}", sol.focal);
    assert!(sol.residual < 1e-6, "{}", sol.residual);
    // Each three- and two-guide full combination makes its own guides axis-aligned exactly.
    for set in [&four[..3], &[four[0].clone(), four[2].clone(), four[3].clone()][..], &[four[1].clone(), four[2].clone()][..]] {
        let sol = solve_guided(set, fw, fh, Some(0.9)).unwrap_or_else(|e| panic!("{set:?}: {e}"));
        assert_eq!(sol.correction, GuidedCorrection::Full);
        assert!(sol.residual < 1e-6, "{} guides: {}", set.len(), sol.residual);
    }
    // With the wrong focal 2H+2V cannot be a pure rotation; the quad DLT still makes all four straight.
    let mut skewed = four.clone();
    skewed[3].to = [skewed[3].to[0], skewed[3].to[1] + 0.03];
    let sol = solve_guided(&skewed, fw, fh, None).unwrap();
    assert!(sol.residual < 1e-6, "{}", sol.residual);
}

#[test]
fn invalid_and_unstable_guides_are_rejected() {
    let v = |x: f64| guide("v", GuideKind::Vertical, [x, 0.1], [x + 0.02, 0.9]);
    let h = |y: f64| guide("h", GuideKind::Horizontal, [0.1, y], [0.9, y + 0.01]);
    let invalid: Vec<Vec<UprightGuide>> = vec![
        vec![],
        vec![v(0.3)],
        vec![h(0.3)],
        vec![v(0.2), v(0.5), v(0.8)],
        vec![h(0.2), h(0.5), h(0.8), v(0.4)],
        vec![v(0.2), v(0.4), v(0.6), h(0.5), h(0.7)],
        // The same line twice.
        vec![v(0.3), v(0.3)],
        // A zero-length guide.
        vec![guide("dot", GuideKind::Vertical, [0.5, 0.5], [0.5, 0.5]), v(0.3)],
    ];
    for set in invalid {
        let r = solve_guided(&set, 600.0, 400.0, None);
        assert!(matches!(r, Err(UprightError::InvalidGuides(_))), "{set:?}: {r:?}");
    }
    // "Verticals" crossing in the middle of the frame: the correction would be a 90° turn.
    let x = [
        guide("a", GuideKind::Vertical, [0.2, 0.1], [0.8, 0.9]),
        guide("b", GuideKind::Vertical, [0.8, 0.1], [0.2, 0.9]),
    ];
    let r = solve_guided(&x, 600.0, 400.0, None);
    assert!(matches!(r, Err(UprightError::Unstable(_))), "{r:?}");
}

#[test]
fn renders_use_the_stored_transform_only() {
    let (w, h) = (600u32, 400u32);
    let t = sample_upright();
    // Invalid guides are stored, but renders never look at them.
    let mut g = upright_geometry(UprightMode::Guided, Some(t), None);
    g.upright.guides = vec![guide("a", GuideKind::Vertical, [0.2, 0.1], [0.2, 0.9])];
    g.constrain_crop = false;
    let p = GeometryPlan::new(&g, w, h, None);
    assert_close(&p.forward, &Homography(t), 1e-12);
    // Off ignores the matrix; no matrix (not analysed yet) means no correction.
    for mode_transform in [(UprightMode::Off, Some(t)), (UprightMode::Guided, None), (UprightMode::Auto, None)] {
        let mut g2 = g.clone();
        g2.upright.mode = mode_transform.0;
        g2.upright.transform = mode_transform.1;
        assert!(GeometryPlan::new(&g2, w, h, None).is_identity(), "{mode_transform:?}");
    }
    // A degenerate stored matrix is ignored rather than producing garbage.
    let mut g3 = g.clone();
    g3.upright.transform = Some([0.0; 9]);
    assert_close(&GeometryPlan::new(&g3, w, h, None).forward, &Homography::identity(), 1e-12);
}

#[test]
fn constrained_crops_stay_inside_the_warped_image() {
    let src = tagged(300, 200);
    let transforms = [
        ManualTransform { vertical: -60.0, ..ManualTransform::default() },
        ManualTransform { horizontal: 80.0, rotate: -7.0, ..ManualTransform::default() },
        ManualTransform { scale: 70.0, offset_x: 10.0, offset_y: -8.0, aspect: -40.0, ..ManualTransform::default() },
        ManualTransform { vertical: 25.0, horizontal: -25.0, rotate: 4.0, aspect: 30.0, scale: 120.0, offset_x: -5.0, offset_y: 5.0 },
    ];
    for t in &transforms {
        for upright in [None, Some(sample_upright())] {
            for (rect, angle) in [
                (CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 0.0),
                (CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 12.0),
                (CropRect { x: 0.05, y: 0.6, w: 0.5, h: 0.4 }, -5.0),
            ] {
                let mut g = geometry_with_crop(rect.clone(), angle);
                g.transform = t.clone();
                if let Some(u) = upright {
                    g.upright = Upright { mode: UprightMode::Guided, transform: Some(u), ..Upright::default() };
                }
                let plan = GeometryPlan::new(&g, 300, 200, None);
                let (_, stats) = resample(&src, &plan, Quality::Preview);
                assert_eq!(stats.out_of_bounds, 0, "{t:?} upright {} rect {rect:?} angle {angle}", upright.is_some());
                // The auto-fit rectangle (for this angle) stays inside even without constrain.
                let fit = max_crop_in_warped(&g, 300.0, 200.0);
                g.crop = Some(Crop { rect: fit, angle, aspect: CropAspect::default() });
                g.constrain_crop = false;
                let (_, stats) = resample(&src, &GeometryPlan::new(&g, 300, 200, None), Quality::Preview);
                assert_eq!(stats.out_of_bounds, 0, "auto-fit leaks");
                // No crop at all: the full-frame default shrinks too.
                g.crop = None;
                g.constrain_crop = true;
                let (_, stats) = resample(&src, &GeometryPlan::new(&g, 300, 200, None), Quality::Preview);
                assert_eq!(stats.out_of_bounds, 0);
            }
        }
    }
}

fn brush_mask(points: Vec<[f64; 2]>) -> Mask {
    Mask {
        id: "m".into(),
        name: "window".into(),
        enabled: true,
        invert: false,
        opacity: 100.0,
        feather: 0.0,
        components: vec![
            MaskComponent {
                id: "b".into(),
                mode: MaskMode::Add,
                invert: false,
                shape: MaskShape::Brush {
                    strokes: vec![BrushStroke { points, size: 10.0, feather: 50.0, flow: 100.0, erase: false }],
                },
            },
            MaskComponent {
                id: "l".into(),
                mode: MaskMode::Add,
                invert: false,
                shape: MaskShape::Linear { from: [0.2, 0.2], to: [0.4, 0.5] },
            },
            MaskComponent {
                id: "r".into(),
                mode: MaskMode::Add,
                invert: false,
                shape: MaskShape::Radial { center: [0.6, 0.4], radii: [0.1, 0.15], angle: 20.0, feather: 50.0 },
            },
        ],
        adjustments: Default::default(),
    }
}

#[test]
fn masks_and_guides_follow_the_content() {
    let (w, h) = (600u32, 400u32);
    let old = Geometry::default();
    let mut new = upright_geometry(UprightMode::Guided, Some(sample_upright()), None);
    new.transform = ManualTransform { rotate: 3.0, vertical: -20.0, ..ManualTransform::default() };
    // A "window" at these source fractions: after the change it must be where the new map sends it.
    let window = vec![[0.62, 0.3], [0.66, 0.31], [0.65, 0.36]];
    let mut masks = vec![brush_mask(window.clone())];
    let mut guides = vec![guide("g", GuideKind::Vertical, [0.3, 0.2], [0.31, 0.8])];
    let original = (masks.clone(), guides.clone());
    remap_geometry_vectors(&old, &new, w, h, &mut masks, &mut guides);
    let fwd = pre_crop_matrix(&new, w, h);
    let MaskShape::Brush { strokes } = &masks[0].components[0].shape else { panic!() };
    for (p, q) in window.iter().zip(&strokes[0].points) {
        let expect = fwd.apply(*p);
        assert!((expect[0] - q[0]).abs() < 1e-12 && (expect[1] - q[1]).abs() < 1e-12);
    }
    assert_ne!(guides, original.1);
    // And back: everything returns (radii and angle approximately, through the Jacobian).
    remap_geometry_vectors(&new, &old, w, h, &mut masks, &mut guides);
    for (a, b) in guides[0].from.iter().chain(&guides[0].to).zip(original.1[0].from.iter().chain(&original.1[0].to)) {
        assert!((a - b).abs() < 1e-12);
    }
    let shapes = |m: &Mask| m.components.iter().map(|c| c.shape.clone()).collect::<Vec<_>>();
    for (a, b) in shapes(&masks[0]).iter().zip(shapes(&original.0[0]).iter()) {
        match (a, b) {
            (MaskShape::Brush { strokes: s1 }, MaskShape::Brush { strokes: s2 }) => {
                for (p, q) in s1[0].points.iter().zip(&s2[0].points) {
                    assert!((p[0] - q[0]).abs() < 1e-12 && (p[1] - q[1]).abs() < 1e-12);
                }
            }
            (MaskShape::Linear { from: f1, to: t1 }, MaskShape::Linear { from: f2, to: t2 }) => {
                assert!((f1[0] - f2[0]).abs() < 1e-12 && (t1[1] - t2[1]).abs() < 1e-12);
            }
            (
                MaskShape::Radial { center: c1, radii: r1, angle: a1, .. },
                MaskShape::Radial { center: c2, radii: r2, angle: a2, .. },
            ) => {
                assert!((c1[0] - c2[0]).abs() < 1e-12 && (c1[1] - c2[1]).abs() < 1e-12);
                assert!((r1[0] - r2[0]).abs() < 0.01 && (r1[1] - r2[1]).abs() < 0.01, "{r1:?} vs {r2:?}");
                assert!((a1 - a2).abs() < 2.0, "{a1} vs {a2}");
            }
            _ => panic!("shape changed kind"),
        }
    }
    // remap_points round-trips through any two invertible maps.
    let (ha, hb) = (Homography(sample_upright()), manual_matrix(&ManualTransform { horizontal: 50.0, ..ManualTransform::default() }, 3.0, 2.0));
    let pts = vec![[0.0, 0.0], [0.3, 0.7], [1.0, 0.5]];
    let there = remap_points(&pts, &ha, &hb);
    let back = remap_points(&there, &hb, &ha);
    for (p, q) in pts.iter().zip(&back) {
        assert!((p[0] - q[0]).abs() < 1e-12 && (p[1] - q[1]).abs() < 1e-12);
    }
    assert!(remap_matrix(&Homography([0.0; 9]), &ha).is_none());
}

// ---------- D2.2 parity fixtures ----------

/// Looser than the closed-form files: the Upright solver and the auto-fit centre search run Nelder–Mead, where
/// one-ulp differences in `sin`/`atan2` between platforms may move the last digits.
const SOLVER_TOLERANCE: f64 = 1e-6;

fn manual_json(t: &ManualTransform) -> Value {
    json!({
        "vertical": t.vertical, "horizontal": t.horizontal, "rotate": t.rotate, "aspect": t.aspect,
        "scale": t.scale, "offsetX": t.offset_x, "offsetY": t.offset_y,
    })
}

#[test]
fn fixture_manual_matrix() {
    let d = ManualTransform::default;
    let mut sets: Vec<(&str, ManualTransform)> = vec![("default", d())];
    for v in [-100.0, -30.0, 30.0, 100.0] {
        sets.push(("vertical", ManualTransform { vertical: v, ..d() }));
        sets.push(("horizontal", ManualTransform { horizontal: v, ..d() }));
    }
    for r in [-10.0, -2.5, 10.0] {
        sets.push(("rotate", ManualTransform { rotate: r, ..d() }));
    }
    for a in [-100.0, 50.0, 100.0] {
        sets.push(("aspect", ManualTransform { aspect: a, ..d() }));
    }
    for s in [50.0, 75.0, 150.0] {
        sets.push(("scale", ManualTransform { scale: s, ..d() }));
    }
    for o in [-100.0, 50.0, 100.0] {
        sets.push(("offsetX", ManualTransform { offset_x: o, ..d() }));
        sets.push(("offsetY", ManualTransform { offset_y: o, ..d() }));
    }
    sets.push(("vertical+horizontal", ManualTransform { vertical: -40.0, horizontal: 25.0, ..d() }));
    sets.push(("keystone+rotate", ManualTransform { vertical: 60.0, rotate: -6.0, ..d() }));
    sets.push((
        "all",
        ManualTransform { vertical: 20.0, horizontal: -15.0, rotate: 3.0, aspect: 25.0, scale: 110.0, offset_x: 5.0, offset_y: -4.0 },
    ));
    sets.push((
        "all-extreme",
        ManualTransform { vertical: -100.0, horizontal: 100.0, rotate: 10.0, aspect: -100.0, scale: 50.0, offset_x: 100.0, offset_y: -100.0 },
    ));
    let mut cases = Vec::new();
    for (label, t) in &sets {
        for (fw, fh, focal) in [(6000.0, 4000.0, None), (4000.0, 6000.0, None), (6000.0, 4000.0, Some(0.6))] {
            // The portrait and focal variants only for the combinations and the keystones.
            let primary = fw == 6000.0 && focal.is_none();
            if !primary && !(label.contains('+') || label.starts_with("all") || label.starts_with("vertical") || label.starts_with("horizontal")) {
                continue;
            }
            let m = manual_matrix_with_focal(t, fw, fh, focal);
            let mut input = manual_json(t);
            input["frameW"] = json!(fw);
            input["frameH"] = json!(fh);
            input["focal"] = json!(focal);
            cases.push(json!({ "label": label, "input": input, "output": { "matrix": m.0 } }));
        }
    }
    assert!(cases.len() >= 30, "{}", cases.len());
    check_fixture("manual-matrix", "manualMatrix", cases);
}

#[test]
fn fixture_guided_solve() {
    let (fw, fh) = (6000.0, 4000.0);
    let synth = |pitch, yaw, roll, f, fw, fh| camera(pitch, yaw, roll, f, fw, fh);
    let v = |c: &Homography, id: &str, x: f64| guide(id, GuideKind::Vertical, c.apply([x, 0.2]), c.apply([x, 0.85]));
    let h = |c: &Homography, id: &str, y: f64| guide(id, GuideKind::Horizontal, c.apply([0.15, y]), c.apply([0.8, y]));
    let up = synth(-12.0, 0.0, 2.0, DEFAULT_FOCAL, fw, fh);
    let full = synth(-10.0, 14.0, 1.5, 0.9, fw, fh);
    let tilted = synth(0.0, 0.0, -3.0, DEFAULT_FOCAL, fw, fh);
    let portrait = synth(8.0, -6.0, 0.0, 1.1, fh, fw);
    let mut skewed = vec![v(&full, "v1", 0.25), v(&full, "v2", 0.75), h(&full, "h1", 0.3), h(&full, "h2", 0.7)];
    skewed[3].to[1] += 0.03;
    let sets: Vec<(&str, Vec<UprightGuide>, f64, f64, Option<f64>)> = vec![
        ("2V building", vec![v(&up, "a", 0.3), v(&up, "b", 0.7)], fw, fh, None),
        ("2V parallel", vec![guide("a", GuideKind::Vertical, [0.3, 0.1], [0.3, 0.9]), guide("b", GuideKind::Vertical, [0.7, 0.2], [0.7, 0.8])], fw, fh, None),
        ("2H level", vec![h(&tilted, "a", 0.4), h(&tilted, "b", 0.6)], fw, fh, None),
        ("2H+2V calibrated", vec![v(&full, "v1", 0.25), v(&full, "v2", 0.75), h(&full, "h1", 0.3), h(&full, "h2", 0.7)], fw, fh, None),
        ("2H+2V skewed (DLT)", skewed, fw, fh, None),
        ("2V+1H", vec![v(&full, "v1", 0.25), v(&full, "v2", 0.75), h(&full, "h1", 0.3)], fw, fh, Some(0.9)),
        ("2H+1V", vec![h(&full, "h1", 0.3), h(&full, "h2", 0.7), v(&full, "v1", 0.4)], fw, fh, Some(0.9)),
        ("1V+1H", vec![v(&full, "v1", 0.6), h(&full, "h1", 0.5)], fw, fh, None),
        ("1V+1H focal", vec![v(&full, "v1", 0.6), h(&full, "h1", 0.5)], fw, fh, Some(0.9)),
        ("portrait 2V", vec![v(&portrait, "a", 0.2), v(&portrait, "b", 0.8)], fh, fw, Some(1.1)),
        ("portrait 2H+2V", vec![v(&portrait, "a", 0.2), v(&portrait, "b", 0.8), h(&portrait, "c", 0.25), h(&portrait, "d", 0.75)], fh, fw, None),
        ("invalid 1V", vec![v(&up, "a", 0.3)], fw, fh, None),
        ("invalid 3V", vec![v(&up, "a", 0.3), v(&up, "b", 0.5), v(&up, "c", 0.7)], fw, fh, None),
        ("invalid 3H+1V", vec![h(&up, "a", 0.3), h(&up, "b", 0.5), h(&up, "c", 0.7), v(&up, "d", 0.5)], fw, fh, None),
        ("invalid same line", vec![v(&up, "a", 0.3), v(&up, "b", 0.3)], fw, fh, None),
        (
            "unstable crossing",
            vec![guide("a", GuideKind::Vertical, [0.2, 0.1], [0.8, 0.9]), guide("b", GuideKind::Vertical, [0.8, 0.1], [0.2, 0.9])],
            fw,
            fh,
            None,
        ),
    ];
    let mut cases = Vec::new();
    for (label, guides, w, hgt, focal) in &sets {
        let output = match solve_guided(guides, *w, *hgt, *focal) {
            Ok(s) => json!({ "transform": s.transform, "focal": s.focal, "residual": s.residual, "correction": format!("{:?}", s.correction).to_lowercase() }),
            Err(UprightError::InvalidGuides(_)) => json!({ "error": "invalidGuides" }),
            Err(UprightError::Unstable(_)) => json!({ "error": "unstable" }),
            // Never returned by the guided solver (automatic Upright only).
            Err(UprightError::NoStructure(_)) => json!({ "error": "noStructure" }),
        };
        cases.push(json!({
            "label": label,
            "input": { "guides": guides, "frameW": w, "frameH": hgt, "focal": focal },
            "output": output,
        }));
    }
    check_fixture_with("guided-solve", "solveGuided", SOLVER_TOLERANCE, cases);
}

#[test]
fn fixture_max_crop_warped() {
    let geometries: Vec<(&str, Geometry)> = vec![
        ("vertical-minus-30", manual_geometry(ManualTransform { vertical: -30.0, ..ManualTransform::default() })),
        ("horizontal-60-rotate-5", manual_geometry(ManualTransform { horizontal: 60.0, rotate: 5.0, ..ManualTransform::default() })),
        ("scale-70-offset", manual_geometry(ManualTransform { scale: 70.0, offset_x: 20.0, offset_y: 10.0, ..ManualTransform::default() })),
        ("aspect-50", manual_geometry(ManualTransform { aspect: 50.0, ..ManualTransform::default() })),
        ("upright", upright_geometry(UprightMode::Guided, Some(sample_upright()), None)),
        (
            "upright-manual-square-angle",
            Geometry {
                crop: Some(Crop { rect: CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, angle: 6.0, aspect: CropAspect::Ratio(1.0, 1.0) }),
                transform: ManualTransform { vertical: 15.0, ..ManualTransform::default() },
                ..upright_geometry(UprightMode::Vertical, Some(sample_upright()), Some(0.9))
            },
        ),
        (
            "free-aspect-angle",
            Geometry {
                crop: Some(Crop { rect: CropRect { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: -8.0, aspect: CropAspect::default() }),
                ..manual_geometry(ManualTransform { vertical: -50.0, horizontal: 20.0, ..ManualTransform::default() })
            },
        ),
        ("no-perspective-angle", geometry_with_crop(CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 10.0)),
    ];
    let mut cases = Vec::new();
    for (label, g) in &geometries {
        for (fw, fh) in [(6000.0, 4000.0), (4000.0, 6000.0)] {
            let r = max_crop_in_warped(g, fw, fh);
            cases.push(json!({
                "label": label,
                "input": { "geometry": g, "frameW": fw, "frameH": fh },
                "output": rect_json(&r),
            }));
        }
    }
    check_fixture_with("max-crop-warped", "maxCropInWarped", SOLVER_TOLERANCE, cases);
}

#[test]
fn fixture_remap_points() {
    let maps: Vec<(&str, Homography, Homography)> = vec![
        ("identity-to-upright", Homography::identity(), Homography(sample_upright())),
        ("upright-to-identity", Homography(sample_upright()), Homography::identity()),
        (
            "manual-to-manual",
            manual_matrix(&ManualTransform { vertical: -30.0, ..ManualTransform::default() }, 1.5, 1.0),
            manual_matrix(&ManualTransform { vertical: 20.0, rotate: 4.0, scale: 120.0, ..ManualTransform::default() }, 1.5, 1.0),
        ),
        (
            "upright-to-upright-plus-manual",
            Homography(sample_upright()),
            Homography(sample_upright()).then(&manual_matrix(&ManualTransform { horizontal: 35.0, offset_x: 10.0, ..ManualTransform::default() }, 1.5, 1.0)),
        ),
    ];
    let points = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.5, 0.5], [0.25, 0.8], [0.9, 0.1]];
    let mut cases = Vec::new();
    for (label, a, b) in &maps {
        let out = remap_points(&points, a, b);
        cases.push(json!({
            "label": label,
            "input": { "hOld": a.0, "hNew": b.0, "points": points },
            "output": { "points": out },
        }));
    }
    check_fixture("remap-points", "remapPoints", cases);
}

/// A 24 MP warp with Upright and every manual slider set, constrained crop at 2°. Run with
/// `cargo test -p photobook-develop --release --test geometry -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_24mp_perspective_warp() {
    let (w, h) = (6000u32, 4000u32);
    let src = texture(w, h);
    let mut g = upright_geometry(UprightMode::Guided, Some(sample_upright()), None);
    g.transform = ManualTransform { vertical: -20.0, horizontal: 10.0, rotate: 3.0, aspect: 10.0, scale: 105.0, offset_x: 2.0, offset_y: -2.0 };
    g.crop = Some(Crop { rect: CropRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, angle: 2.0, aspect: CropAspect::default() });
    let t = Instant::now();
    let plan = GeometryPlan::new(&g, w, h, None);
    eprintln!("plan: {:?} -> {}x{}", t.elapsed(), plan.output_width, plan.output_height);
    for quality in [Quality::Export, Quality::Preview] {
        for _ in 0..2 {
            let t = Instant::now();
            let (_, stats) = warp_with_stats(&src, &plan, quality);
            eprintln!("24 MP upright + manual, {quality:?}: {:?} ({:?}, {} clamped)", t.elapsed(), stats.path, stats.out_of_bounds);
        }
    }
    let t = Instant::now();
    let (_, stats) = warp_with_stats(&src, &GeometryPlan::new(&g, w, h, Some(2048)), Quality::Preview);
    eprintln!("24 MP upright + manual into a 2048 px preview: {:?} ({:?})", t.elapsed(), stats.path);
    let guides = [
        guide("a", GuideKind::Vertical, [0.3, 0.1], [0.32, 0.9]),
        guide("b", GuideKind::Vertical, [0.7, 0.1], [0.68, 0.9]),
        guide("c", GuideKind::Horizontal, [0.2, 0.3], [0.8, 0.32]),
        guide("d", GuideKind::Horizontal, [0.2, 0.7], [0.8, 0.69]),
    ];
    let t = Instant::now();
    for _ in 0..100 {
        solve_guided(&guides, 6000.0, 4000.0, None).unwrap();
    }
    eprintln!("solve_guided (2H+2V): {:?} per solve", t.elapsed() / 100);
}

// ---------- D2.3 automatic Upright: procedural scenes ----------

use photobook_develop::geometry::auto::{analyse, solve_auto, Analysis, AutoSolution};
use photobook_develop::geometry::perspective_matrix;
use rayon::prelude::*;

const SCENE_W: u32 = 1280;
const SCENE_H: u32 = 960;
/// The facade: camera tilted up 10° (converging verticals) and rolled 2° clockwise.
const FACADE_PITCH: f64 = -10.0;
const FACADE_ROLL: f64 = 2.0;
const INTERIOR_ROLL: f64 = 1.5;
/// The horizon rises 3.5° to the right (−3.5° in y-down degrees).
const HORIZON_TILT: f64 = -3.5;

/// SplitMix64 hash of three values, as a uniform in [0, 1).
fn hash01(a: u64, b: u64, c: u64) -> f64 {
    let mut z = a.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ b.wrapping_mul(0xc2b2_ae3d_27d4_eb4f) ^ c.wrapping_add(0x1656_67b1_9e37_79f9);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^= z >> 31;
    (z >> 11) as f64 / (1u64 << 53) as f64
}

/// Roughly Gaussian (σ = 1) from four hashed uniforms.
fn hash_gauss(seed: u64, x: u64, y: u64) -> f64 {
    let s: f64 = (0..4).map(|k| hash01(seed.wrapping_add(k), x, y)).sum();
    (s - 2.0) * 3f64.sqrt()
}

/// A grey linear image of `f` (centred long-edge units of the frame → linear luminance), averaged over
/// `ss × ss` samples per pixel, plus Gaussian noise of σ `noise`.
fn scene(w: u32, h: u32, ss: usize, noise: f64, seed: u64, f: impl Fn(f64, f64) -> f64 + Sync) -> LinearImage {
    let to_c = centred_units(w as f64, h as f64);
    let mut data = vec![0.0f32; (w * h * 3) as usize];
    data.par_chunks_mut(w as usize * 3).enumerate().for_each(|(y, row)| {
        for x in 0..w as usize {
            let mut s = 0.0;
            for sy in 0..ss {
                for sx in 0..ss {
                    let u = (x as f64 + (sx as f64 + 0.5) / ss as f64) / w as f64;
                    let v = (y as f64 + (sy as f64 + 0.5) / ss as f64) / h as f64;
                    let c = to_c.apply([u, v]);
                    s += f(c[0], c[1]);
                }
            }
            let v = (s / (ss * ss) as f64 + noise * hash_gauss(seed, x as u64, y as u64)).max(0.0) as f32;
            row[x * 3..x * 3 + 3].copy_from_slice(&[v, v, v]);
        }
    });
    LinearImage::new(w, h, data)
}

/// Scene (centred long-edge units) → image (centred long-edge units) for the facade camera.
fn facade_camera() -> Homography {
    facade_camera_with(FACADE_PITCH, 0.0, FACADE_ROLL)
}

fn facade_camera_with(pitch: f64, yaw: f64, roll: f64) -> Homography {
    let (s, c) = roll.to_radians().sin_cos();
    let rz = [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]];
    let px = pitch_yaw(pitch.to_radians(), yaw.to_radians());
    let r: [[f64; 3]; 3] =
        std::array::from_fn(|i| std::array::from_fn(|j| rz[i][0] * px[0][j] + rz[i][1] * px[1][j] + rz[i][2] * px[2][j]));
    // A pure camera rotation (principal point at the centre), with the facade placed so that its origin
    // lands on the frame centre.
    let cam = conjugate_rotation(r, DEFAULT_FOCAL);
    let c = cam.invert().unwrap().apply([0.0, 0.0]);
    Homography::translate(c[0], c[1]).then(&cam)
}

/// Sky above a dark cornice at y = −0.27, a wall with a grid of windows (0.15 apart, 0.08 × 0.09).
fn facade_pattern(x: f64, y: f64) -> f64 {
    if y < -0.30 {
        return 0.7;
    }
    if y < -0.27 {
        return 0.08;
    }
    let col = ((x + 0.6) / 0.15).floor();
    let cx = -0.6 + (col + 0.5) * 0.15;
    let row = ((y + 0.26) / 0.13).floor();
    let cy = -0.26 + (row + 0.5) * 0.13;
    if (0.0..=4.0).contains(&row) && (x - cx).abs() < 0.04 && (y - cy).abs() < 0.045 {
        0.05
    } else {
        0.32
    }
}

fn facade(w: u32, h: u32, ss: usize) -> LinearImage {
    facade_with(facade_camera(), w, h, ss)
}

fn facade_with(camera: Homography, w: u32, h: u32, ss: usize) -> LinearImage {
    let inv = camera.invert().unwrap();
    scene(w, h, ss, 0.004, 1, move |x, y| {
        let p = inv.apply([x, y]);
        facade_pattern(p[0], p[1])
    })
}

/// One-point perspective room (back wall with a window, ceiling, a planked floor, a door on each side
/// wall), rolled 1.5° clockwise.
fn interior() -> LinearImage {
    let (s, c) = (-INTERIOR_ROLL).to_radians().sin_cos();
    scene(SCENE_W, SCENE_H, 3, 0.004, 2, move |x, y| {
        let (x, y) = (c * x - s * y, s * x + c * y);
        let (bw, bh) = (0.22, 0.16);
        if x.abs() <= bw && y.abs() <= bh {
            return if (x - 0.05).abs() <= 0.08 && (y + 0.02).abs() <= 0.06 { 0.85 } else { 0.5 };
        }
        if y.abs() / bh > x.abs() / bw {
            if y < 0.0 {
                return 0.62;
            }
            let plank = ((x / y).atan().to_degrees() + 90.0) / 9.0;
            return if (plank.floor() as i64) % 2 == 0 { 0.2 } else { 0.14 };
        }
        let half = bh * x.abs() / bw;
        if (0.34..=0.44).contains(&x.abs()) && y >= -0.3 * half {
            0.1
        } else if x < 0.0 {
            0.36
        } else {
            0.3
        }
    })
}

/// Sky over sea, split by a straight horizon at −3.5°, with noise.
fn sea_horizon() -> LinearImage {
    let (s, c) = HORIZON_TILT.to_radians().sin_cos();
    scene(SCENE_W, SCENE_H, 2, 0.01, 3, move |x, y| {
        let d = -s * x + c * (y - 0.05);
        if d < 0.0 {
            0.55 - 0.3 * y
        } else {
            0.1 + 0.02 * (x * 9.0).sin()
        }
    })
}

/// Soft blobs and a soft-edged face ellipse: no straight lines.
fn portrait() -> LinearImage {
    let blobs = [(-0.3, -0.2, 0.12, 0.25), (0.25, 0.1, 0.09, -0.15), (0.0, 0.25, 0.15, 0.2), (0.35, -0.25, 0.06, 0.3)];
    scene(SCENE_W, SCENE_H, 2, 0.004, 4, move |x, y| {
        let mut v = 0.25;
        for (bx, by, s, a) in blobs {
            v += a * (-((x - bx).powi(2) + (y - by).powi(2)) / (2.0 * s * s)).exp();
        }
        // Ellipse 0.17 × 0.24 with a 5 px soft edge.
        let r = ((x / 0.17).powi(2) + ((y - 0.02) / 0.24).powi(2)).sqrt();
        let edge = 1.0 / (1.0 + ((r - 1.0) * 0.2 * 1280.0 / 5.0).exp());
        v * (1.0 - 0.4 * edge) + 0.45 * 0.4 * edge
    })
}

/// Many short dark strokes at random angles on a mottled background.
fn forest() -> LinearImage {
    let (w, h) = (SCENE_W, SCENE_H);
    let mut img = scene(w, h, 1, 0.006, 5, |x, y| 0.3 + 0.05 * (x * 7.0).sin() * (y * 5.0).cos());
    for k in 0..500u64 {
        let cx = hash01(10, k, 0) * w as f64;
        let cy = hash01(11, k, 0) * h as f64;
        let len = 20.0 + 50.0 * hash01(12, k, 0);
        let a = hash01(13, k, 0) * std::f64::consts::PI;
        let lum = 0.04 + 0.08 * hash01(14, k, 0);
        let (dx, dy) = (0.5 * len * a.cos(), 0.5 * len * a.sin());
        let (p, q) = ([cx - dx, cy - dy], [cx + dx, cy + dy]);
        let half_width = 1.3;
        let (x0, x1) = ((p[0].min(q[0]) - 3.0).max(0.0) as u32, ((p[0].max(q[0]) + 3.0) as u32).min(w - 1));
        let (y0, y1) = ((p[1].min(q[1]) - 3.0).max(0.0) as u32, ((p[1].max(q[1]) + 3.0) as u32).min(h - 1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let mut cover = 0.0;
                for sy in 0..3 {
                    for sx in 0..3 {
                        let pt = [x as f64 + (sx as f64 + 0.5) / 3.0, y as f64 + (sy as f64 + 0.5) / 3.0];
                        let (vx, vy) = (q[0] - p[0], q[1] - p[1]);
                        let t = (((pt[0] - p[0]) * vx + (pt[1] - p[1]) * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
                        let d = (pt[0] - p[0] - t * vx).hypot(pt[1] - p[1] - t * vy);
                        if d <= half_width {
                            cover += 1.0 / 9.0;
                        }
                    }
                }
                let i = ((y * w + x) * 3) as usize;
                let v = img.data[i] as f64 * (1.0 - cover) + lum * cover;
                img.data[i..i + 3].copy_from_slice(&[v as f32; 3]);
            }
        }
    }
    img
}

fn describe(name: &str, a: &Analysis) {
    eprintln!(
        "{name}: {} segments ({} used), level {:?}, vertical vp {:?} ({} inliers), horizontal vp {:?} ({} inliers), focal {:.3} ({:?}), {:.1} ms",
        a.segments.len(),
        a.used.iter().filter(|u| **u).count(),
        a.level.as_ref().map(|l| (l.angle_deg, l.confidence)),
        a.vertical_vp.as_ref().map(|v| v.point),
        a.vertical_vp.as_ref().map_or(0, |v| v.inliers.len()),
        a.horizontal_vp.as_ref().map(|v| v.point),
        a.horizontal_vp.as_ref().map_or(0, |v| v.inliers.len()),
        a.focal,
        a.focal_source,
        a.elapsed_ms,
    );
}

/// Angle (degrees) of the segment `a → b` from the vertical (positive clockwise), and from the horizontal.
fn tilt_from_vertical(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    -(dx.atan2(dy)).to_degrees()
}

fn tilt_from_horizontal(a: [f64; 2], b: [f64; 2]) -> f64 {
    (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees()
}

#[test]
fn auto_level_on_scenes_with_lines() {
    let (fw, fh) = (SCENE_W as f64, SCENE_H as f64);
    for (name, img, expected) in [
        ("facade", facade(SCENE_W, SCENE_H, 3), -FACADE_ROLL),
        ("interior", interior(), -INTERIOR_ROLL),
        ("sea horizon", sea_horizon(), -HORIZON_TILT),
    ] {
        let a = analyse(&img, None);
        describe(name, &a);
        let s = solve_auto(&a, UprightMode::Level, fw, fh).unwrap();
        eprintln!("{name}: Level {:.3}° (expected {expected}°), confidence {:.2}", s.angle, s.confidence);
        assert_eq!(s.correction, GuidedCorrection::Level);
        assert!((s.angle - expected).abs() < 0.5, "{name}: {} vs {expected}", s.angle);
        assert!((a.level.as_ref().unwrap().angle_deg - s.angle).abs() < 1e-9);
        // The transform is that rotation about the centre: a line at −expected becomes level.
        let t = Homography(s.transform);
        let to_px = |p: [f64; 2]| {
            let q = t.apply([p[0] / fw, p[1] / fh]);
            [q[0] * fw, q[1] * fh]
        };
        let (sn, cs) = (-s.angle).to_radians().sin_cos();
        let (p, q) = ([640.0 - 300.0 * cs, 480.0 - 300.0 * sn], [640.0 + 300.0 * cs, 480.0 + 300.0 * sn]);
        assert!(tilt_from_horizontal(to_px(p), to_px(q)).abs() < 1e-9);
        // Auto picks a correction too.
        let auto = solve_auto(&a, UprightMode::Auto, fw, fh).unwrap();
        eprintln!("{name}: Auto → {:?}, angle {:.3}°, confidence {:.2}", auto.correction, auto.angle, auto.confidence);
        assert!((auto.angle - expected).abs() < 0.5, "{name}: Auto angle {}", auto.angle);
    }
}

/// The facade's ground-truth verticals (window edges) and cornice, through the camera and `t`, in pixels.
fn facade_lines_after(t: &AutoSolution) -> (Vec<f64>, f64) {
    let (fw, fh) = (SCENE_W as f64, SCENE_H as f64);
    let cam = facade_camera().then(&from_centred_units(fw, fh)).then(&Homography(t.transform));
    let px = |p: [f64; 2]| {
        let q = cam.apply(p);
        [q[0] * fw, q[1] * fh]
    };
    let verticals = (-4..=3)
        .flat_map(|k| [k as f64 * 0.15 + 0.035, k as f64 * 0.15 + 0.115])
        .map(|x| tilt_from_vertical(px([x, -0.25]), px([x, 0.36])))
        .collect();
    (verticals, tilt_from_horizontal(px([-0.45, -0.27]), px([0.45, -0.27])))
}

#[test]
fn full_upright_on_the_facade() {
    let (fw, fh) = (SCENE_W as f64, SCENE_H as f64);
    let img = facade(SCENE_W, SCENE_H, 3);
    let a = analyse(&img, None);
    describe("facade", &a);
    let s = solve_auto(&a, UprightMode::Full, fw, fh).unwrap();
    assert_eq!(s.correction, GuidedCorrection::Full);
    let (verticals, cornice) = facade_lines_after(&s);
    eprintln!("facade Full: verticals {verticals:.3?}, cornice {cornice:.3}°, residual {:.3}°, focal {:.3}", s.residual, s.focal);
    let (lo, hi) = verticals.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), v| (l.min(*v), h.max(*v)));
    assert!(hi - lo < 0.3, "verticals not parallel: {verticals:?}");
    assert!(verticals.iter().all(|v| v.abs() < 0.3), "verticals not vertical: {verticals:?}");
    assert!(cornice.abs() < 0.3, "cornice {cornice}");
    // Before: the outer verticals lean by several degrees.
    let none = AutoSolution { transform: Homography::identity().0, ..s.clone() };
    let (before, _) = facade_lines_after(&none);
    assert!(before.iter().fold(0.0f64, |m, v| m.max(v.abs())) > 3.0, "{before:?}");

    // Vertical alone also straightens the verticals; Auto picks it (no horizontal convergence to fix).
    let v = solve_auto(&a, UprightMode::Vertical, fw, fh).unwrap();
    assert_eq!(v.correction, GuidedCorrection::Vertical);
    let (verticals, cornice) = facade_lines_after(&v);
    eprintln!("facade Vertical: verticals {verticals:.3?}, cornice {cornice:.3}°");
    assert!(verticals.iter().all(|v| v.abs() < 0.3), "{verticals:?}");
    // The shortest rotation leaves only a second-order roll (about pitch × roll / 2).
    assert!(cornice.abs() < 0.5, "cornice after Vertical {cornice}");
    let auto = solve_auto(&a, UprightMode::Auto, fw, fh).unwrap();
    assert_eq!(auto.correction, GuidedCorrection::Vertical);

    // The auto-fit crop stays inside the corrected image.
    let mut g = upright_geometry(UprightMode::Full, Some(s.transform), Some(s.focal));
    let fit = max_crop_in_warped(&g, fw, fh);
    eprintln!("facade Full crop: {fit:?}");
    assert!(fit.w * fit.h > 0.5, "{fit:?}");
    let back = perspective_matrix(&g, fw, fh).invert().unwrap();
    for p in [[fit.x, fit.y], [fit.x + fit.w, fit.y], [fit.x + fit.w, fit.y + fit.h], [fit.x, fit.y + fit.h]] {
        let q = back.apply(p);
        assert!(q.iter().all(|v| (-1e-6..=1.0 + 1e-6).contains(v)), "{p:?} → {q:?}");
    }
    g.crop = Some(Crop { rect: fit, angle: 0.0, aspect: CropAspect::default() });
    let (_, stats) = resample(&img, &GeometryPlan::new(&g, SCENE_W, SCENE_H, Some(640)), Quality::Preview);
    assert_eq!(stats.out_of_bounds, 0);
}

#[test]
fn auto_chooses_by_the_thresholds() {
    let (fw, fh) = (SCENE_W as f64, SCENE_H as f64);
    // A facade seen 12° from the side as well: horizontal convergence worth correcting → Full.
    let cam = facade_camera_with(-8.0, 12.0, 1.0);
    let a = analyse(&facade_with(cam, SCENE_W, SCENE_H, 3), None);
    describe("yawed facade", &a);
    let s = solve_auto(&a, UprightMode::Auto, fw, fh).unwrap();
    eprintln!("yawed facade: Auto → {:?}, angle {:.3}°, residual {:.3}°, skew {:?}", s.correction, s.angle, s.residual, a.skew_deg());
    assert_eq!(s.correction, GuidedCorrection::Full);
    let t = cam.then(&from_centred_units(fw, fh)).then(&Homography(s.transform));
    let px = |p: [f64; 2]| {
        let q = t.apply(p);
        [q[0] * fw, q[1] * fh]
    };
    for x in [-0.4, -0.1, 0.2, 0.4] {
        let v = tilt_from_vertical(px([x, -0.25]), px([x, 0.36]));
        assert!(v.abs() < 0.3, "vertical at {x}: {v}");
    }
    for y in [-0.27, 0.0, 0.3] {
        let h = tilt_from_horizontal(px([-0.4, y]), px([0.4, y]));
        assert!(h.abs() < 0.3, "horizontal at {y}: {h}");
    }
    // A camera tilted up 28°: too strong a correction for Auto, which levels instead.
    let a = analyse(&facade_with(facade_camera_with(-28.0, 0.0, 2.0), SCENE_W, SCENE_H, 3), None);
    describe("steep facade", &a);
    let s = solve_auto(&a, UprightMode::Auto, fw, fh).unwrap();
    eprintln!("steep facade: Auto → {:?}, angle {:.3}°", s.correction, s.angle);
    assert_eq!(s.correction, GuidedCorrection::Level);
    assert!((s.angle + 2.0).abs() < 0.5, "{}", s.angle);
    // Asked explicitly, Vertical still corrects it.
    assert_eq!(solve_auto(&a, UprightMode::Vertical, fw, fh).unwrap().correction, GuidedCorrection::Vertical);
}

#[test]
fn scenes_without_structure_are_declined() {
    let (fw, fh) = (SCENE_W as f64, SCENE_H as f64);
    for (name, img) in [("portrait", portrait()), ("forest", forest())] {
        let a = analyse(&img, None);
        describe(name, &a);
        for mode in [UprightMode::Auto, UprightMode::Level, UprightMode::Vertical, UprightMode::Full] {
            let r = solve_auto(&a, mode.clone(), fw, fh);
            eprintln!("{name} {mode:?}: {r:?}");
            assert!(matches!(r, Err(UprightError::NoStructure(_))), "{name} {mode:?}: {r:?}");
        }
    }
    // Off and Guided are not automatic modes.
    let a = analyse(&sea_horizon(), None);
    assert!(matches!(solve_auto(&a, UprightMode::Guided, fw, fh), Err(UprightError::InvalidGuides(_))));
}

#[test]
fn analysis_fits_the_time_budget() {
    let img = facade(SCENE_W, SCENE_H, 3);
    // Warm up rayon, then time.
    let _ = analyse(&img, None);
    let t = Instant::now();
    let a = analyse(&img, Some(28.0));
    let elapsed = t.elapsed();
    eprintln!("analyse 1280 × 960 facade: {elapsed:?} ({} segments)", a.segments.len());
    assert!(elapsed.as_secs_f64() < 1.0, "{elapsed:?}");
}

/// Release timing of the whole analysis on a 24 MP frame (luminance, downscale, detection, RANSAC):
/// `cargo test -p photobook-develop --release --test geometry -- --ignored --nocapture timing_auto`.
#[test]
#[ignore]
fn timing_auto_upright_analysis() {
    let img = facade(6000, 4000, 1);
    for _ in 0..3 {
        let t = Instant::now();
        let a = analyse(&img, None);
        eprintln!("analyse 24 MP: {:?} ({} segments, analysis {}×{})", t.elapsed(), a.segments.len(), a.width, a.height);
    }
    let small = facade(SCENE_W, SCENE_H, 3);
    for _ in 0..3 {
        let t = Instant::now();
        let a = analyse(&small, None);
        let s = solve_auto(&a, UprightMode::Full, SCENE_W as f64, SCENE_H as f64).unwrap();
        eprintln!("analyse + Full 1280 px: {:?} ({:?})", t.elapsed(), s.correction);
    }
}

/// Dev aid: analyse the repository's sample photos and print every mode's outcome (no assertions):
/// `cargo test -p photobook-develop --test geometry -- --ignored --nocapture auto_upright_on_sample_photos`.
#[test]
#[ignore]
fn auto_upright_on_sample_photos() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut files: Vec<PathBuf> = ["lisbon-demo", "sample-trip"]
        .iter()
        .filter_map(|d| fs::read_dir(root.join(d)).ok())
        .flat_map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())))
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg")))
        .collect();
    files.sort();
    for path in files {
        let img = photobook_develop::decode_file(&path, Some(1600)).unwrap();
        let a = analyse(&img, None);
        let (fw, fh) = (img.width as f64, img.height as f64);
        let mut line = format!(
            "{}: {} segs, {:.0} ms, level {:?}, vp v/h {}/{} skew {:?}, focal {:.2} {:?}",
            path.file_name().unwrap().to_string_lossy(),
            a.segments.len(),
            a.elapsed_ms,
            a.level.as_ref().map(|l| ((l.angle_deg * 100.0).round() / 100.0, (l.confidence * 100.0).round() / 100.0)),
            a.vertical_vp.as_ref().map_or(0, |v| v.inliers.len()),
            a.horizontal_vp.as_ref().map_or(0, |v| v.inliers.len()),
            a.skew_deg().map(|s| (s * 10.0).round() / 10.0),
            a.focal,
            a.focal_source,
        );
        for mode in [UprightMode::Auto, UprightMode::Vertical, UprightMode::Full] {
            match solve_auto(&a, mode.clone(), fw, fh) {
                Ok(s) => line += &format!(" | {mode:?}: {:?} {:.2}° c{:.2} r{:.2}", s.correction, s.angle, s.confidence, s.residual),
                Err(e) => line += &format!(" | {mode:?}: {e}"),
            }
        }
        eprintln!("{line}");
    }
}
