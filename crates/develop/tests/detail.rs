//! D3.1 checks of the Detail operators (clarity, texture, dehaze, sharpening) on synthetic linear images,
//! the pre-pass cache, the default-sharpening rule and resolution independence.
//!
//! Fixtures are built straight as `LinearImage`s (neutral greys and colours given in sRGB and
//! linearised), with a 1080 px short side where a test depends on the radii, so reference px = px.
//! Operator tests set sharpening to 0 so each control is seen on its own (any non-default Detail turns
//! on the baseline sharpening; see `ops::detail`).

use std::time::Instant;

use fast_image_resize as fr;
use photobook_develop::color::transfer;
use photobook_develop::settings::Detail;
use photobook_develop::{render_full, DevelopSettings, Developer, Rgb8Image};

mod common;
use common::*;

// ---------- helpers ----------

/// sRGB 0..255 → linear.
fn lin(v: f32) -> f32 {
    transfer::srgb_to_linear((v / 255.0).clamp(0.0, 1.0))
}

/// Settings with only these detail values (sharpening off unless given).
fn detail(f: impl FnOnce(&mut Detail)) -> DevelopSettings {
    let mut s = DevelopSettings::default();
    s.detail.sharpen.amount = 0.0;
    f(&mut s.detail);
    s
}

/// Green channel (sRGB 8-bit) of row `y`.
fn row(img: &Rgb8Image, y: u32) -> Vec<f32> {
    (0..img.width).map(|x| img.pixel(x, y)[1] as f32).collect()
}

/// Mean and standard deviation of the green channel in a rectangle.
fn stats(img: &Rgb8Image, x0: u32, y0: u32, x1: u32, y1: u32) -> (f64, f64) {
    let v: Vec<f64> = (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| img.pixel(x, y)[1] as f64).collect();
    let m = v.iter().sum::<f64>() / v.len() as f64;
    (m, (v.iter().map(|a| (a - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt())
}

fn max_diff_in(a: &Rgb8Image, b: &Rgb8Image, x0: u32, y0: u32, x1: u32, y1: u32) -> u8 {
    (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).flat_map(|(x, y)| (0..3).map(move |c| a.pixel(x, y)[c].abs_diff(b.pixel(x, y)[c]))).max().unwrap()
}

/// Largest step between neighbouring pixels along a row.
fn max_slope(r: &[f32]) -> f32 {
    r.windows(2).map(|p| (p[1] - p[0]).abs()).fold(0.0, f32::max)
}

// ---------- operators ----------

#[test]
fn clarity_keeps_halos_small_and_adds_local_contrast() {
    let dev = Developer::new(backlit_edge());
    let out = dev.render(&detail(|d| d.clarity = 50.0));
    let base = dev.render(&detail(|_| {}));
    let mid = H / 2;
    let (r, b) = (row(&out, mid), row(&base, mid));
    let c = (W / 2) as usize;
    // The plateaus far from the edge do not move.
    assert!((r[100] - b[100]).abs() <= 1.0 && (r[W as usize - 100] - b[W as usize - 100]).abs() <= 1.0);
    // Overshoot past the plateaus next to the edge stays below 4 levels.
    let bright = r[W as usize - 100];
    let dark = r[100];
    let over = r[c..].iter().fold(0.0f32, |m, &v| m.max(v - bright));
    let under = r[..c].iter().fold(0.0f32, |m, &v| m.max(dark - v));
    eprintln!("clarity +50 backlit edge: overshoot {over}, undershoot {under}");
    assert!(over < 4.0 && under < 4.0, "halo {over} / {under}");

    // A textured midtone patch gains local contrast and keeps its mean.
    let tex = image(W, H, |x, y| grey(118.0 + 40.0 * value_noise(x, y, 14.0, 1)));
    let dev = Developer::new(tex);
    let base = dev.render(&detail(|_| {}));
    let out = dev.render(&detail(|d| d.clarity = 50.0));
    let (m0, s0) = stats(&base, 200, 200, 1200, 900);
    let (m1, s1) = stats(&out, 200, 200, 1200, 900);
    eprintln!("clarity +50 texture: std {s0:.2} -> {s1:.2}, mean {m0:.1} -> {m1:.1}");
    assert!(s1 > s0 * 1.15, "std {s0} -> {s1}");
    assert!((m1 - m0).abs() < 2.0);
    // Negative clarity softens.
    let soft = dev.render(&detail(|d| d.clarity = -100.0));
    assert!(stats(&soft, 200, 200, 1200, 900).1 < s0 * 0.85);
}

#[test]
fn texture_lifts_fine_detail_and_leaves_gradients() {
    // Top half: fine noise on mid grey; bottom half: a smooth horizontal gradient.
    let img = image(W, H, |x, y| {
        if y < H / 2 {
            grey(120.0 + 30.0 * value_noise(x, y, 5.0, 7))
        } else {
            grey(60.0 + 140.0 * x as f32 / W as f32)
        }
    });
    let dev = Developer::new(img);
    let base = dev.render(&detail(|_| {}));
    let out = dev.render(&detail(|d| d.texture = 100.0));
    let (_, s0) = stats(&base, 100, 100, 1300, 440);
    let (_, s1) = stats(&out, 100, 100, 1300, 440);
    eprintln!("texture +100 noise: std {s0:.2} -> {s1:.2}");
    assert!(s1 * s1 > s0 * s0 * 1.4, "variance {} -> {}", s0 * s0, s1 * s1);
    let (g0, _) = stats(&base, 100, 640, 1300, 1000);
    let (g1, _) = stats(&out, 100, 640, 1300, 1000);
    assert!((g1 - g0).abs() < 0.5, "gradient mean {g0} -> {g1}");
    assert!(max_diff_in(&base, &out, 100, 640, 1300, 1000) <= 1);
    // Negative texture smooths the noise.
    let smooth = dev.render(&detail(|d| d.texture = -100.0));
    assert!(stats(&smooth, 100, 100, 1300, 440).1 < s0 * 0.8);
}

#[test]
fn dehaze_adds_contrast_and_keeps_a_white_sky() {
    // Top 200 rows: pure white sky. Below: a coloured scene with structure, hazed toward white.
    let img = image(W, H, |x, y| {
        if y < 200 {
            return grey(255.0);
        }
        let n = value_noise(x, y, 40.0, 3);
        let scene = [90.0 + 160.0 * n, 110.0 + 120.0 * n, 70.0 - 100.0 * n];
        let haze = 0.45f32;
        scene.map(|c| {
            let l = lin(c.clamp(0.0, 255.0));
            255.0 * transfer::linear_to_srgb(l * (1.0 - haze) + haze)
        })
    });
    let dev = Developer::new(img);
    let base = dev.render(&detail(|_| {}));
    let out = dev.render(&detail(|d| d.dehaze = 50.0));
    let (m0, s0) = stats(&base, 100, 400, 1300, 1000);
    let (m1, s1) = stats(&out, 100, 400, 1300, 1000);
    eprintln!("dehaze +50: std {s0:.2} -> {s1:.2}, mean {m0:.1} -> {m1:.1}");
    assert!(s1 > s0 * 1.3, "contrast {s0} -> {s1}");
    assert!(m1 < m0, "haze removed darkens the veil");
    // The sky stays within a few levels.
    let sky = max_diff_in(&base, &out, 50, 20, 1390, 150);
    assert!(sky <= 3, "sky moved {sky}");
    // Negative dehaze lowers contrast.
    let hazier = dev.render(&detail(|d| d.dehaze = -100.0));
    assert!(stats(&hazier, 100, 400, 1300, 1000).1 < s0 * 0.85);
}

#[test]
fn sharpening_steepens_edges_and_masking_spares_flats() {
    // Left: a soft vertical edge (100 → 170 over 6 px); right: a flat noisy patch.
    let img = image(W, H, |x, y| {
        if x < W / 2 {
            grey(100.0 + 70.0 * smoothstep(W as f32 / 4.0 - 3.0, W as f32 / 4.0 + 3.0, x as f32))
        } else {
            grey(128.0 + 6.0 * hash(x, y, 5))
        }
    });
    let dev = Developer::new(img);
    let base = dev.render(&detail(|_| {}));
    let sharp = dev.render(&detail(|d| {
        d.sharpen.amount = 150.0;
        d.sharpen.radius = 1.0;
    }));
    let (s0, s1) = (max_slope(&row(&base, H / 2)[200..520]), max_slope(&row(&sharp, H / 2)[200..520]));
    eprintln!("sharpen 150: edge slope {s0} -> {s1}");
    assert!(s1 > s0 * 1.25, "slope {s0} -> {s1}");
    // Without masking the noise is sharpened too; with masking 100 the flat patch is untouched while
    // the edge still sharpens.
    assert!(max_diff_in(&base, &sharp, 800, 100, 1400, 1000) > 2);
    let (_, _, mask) = dev.sharpen_mask(&detail(|d| d.sharpen.masking = 100.0));
    eprintln!("masking 100: mask at the edge {}, on the noise {}", mask[(H / 2 * W + W / 4) as usize], mask[(H / 2 * W + 1000) as usize]);
    let masked = dev.render(&detail(|d| {
        d.sharpen.amount = 150.0;
        d.sharpen.masking = 100.0;
    }));
    let flat = max_diff_in(&base, &masked, 800, 100, 1400, 1000);
    assert!(flat <= 1, "flat patch moved {flat}");
    assert!(max_slope(&row(&masked, H / 2)[200..520]) > s0 * 1.2);

    // The Alt-drag mask: all ones at masking 0, edge-only at 100.
    let mut s = detail(|d| d.sharpen.masking = 0.0);
    let (mw, mh, mask) = dev.sharpen_mask(&s);
    assert_eq!((mw, mh), (W, H));
    assert!(mask.iter().all(|&m| m == 1.0));
    s.detail.sharpen.masking = 100.0;
    let (_, _, mask) = dev.sharpen_mask(&s);
    let at = |x: u32, y: u32| mask[(y * W + x) as usize];
    assert!(at(W / 4, H / 2) > 0.9 && at(1000, H / 2) == 0.0 && at(100, H / 2) == 0.0);
}

// ---------- pipeline rules ----------

#[test]
fn default_detail_is_skipped_and_any_edit_adds_baseline_sharpening() {
    let dev = Developer::new(backlit_edge());
    let plain = dev.render(&DevelopSettings::default());
    // Detail at its default (sharpening 40) renders like no sharpening at all.
    assert_eq!(plain, dev.render(&detail(|_| {})));
    assert_eq!(dev.prepass_count(), 0, "no pre-pass is computed for a default render");
    // Touching any detail control brings the baseline sharpening 40 in.
    let mut s = DevelopSettings::default();
    s.detail.texture = 1.0;
    let touched = dev.render(&s);
    let unsharpened = dev.render(&detail(|d| d.texture = 1.0));
    let near_edge = max_diff_in(&touched, &unsharpened, W / 2 - 20, 100, W / 2 + 20, H - 100);
    assert!(near_edge >= 1, "baseline sharpening missing");
    // Flats far from the edge are untouched by it.
    assert_eq!(max_diff_in(&touched, &unsharpened, 50, 100, 300, H - 100), 0);
}

#[test]
fn prepasses_are_cached_across_slider_changes() {
    let dev = Developer::new(backlit_edge());
    let mut s = detail(|d| {
        d.clarity = 30.0;
        d.texture = 20.0;
        d.dehaze = 10.0;
        d.sharpen.amount = 60.0;
    });
    s.light.shadows = 30.0;
    let a = dev.render(&s);
    // log Y, the highlights/shadows base, clarity, texture, haze, sharpening planes.
    assert_eq!(dev.prepass_count(), 6);
    for v in [10.0, 50.0, 80.0] {
        s.detail.clarity = v;
        s.detail.sharpen.amount = v;
        s.detail.sharpen.masking = v;
        s.light.exposure = v / 100.0;
        let _ = dev.render(&s);
    }
    assert_eq!(dev.prepass_count(), 6, "sliders reuse the pre-passes");
    s.detail.sharpen.radius = 2.0;
    let _ = dev.render(&s);
    assert_eq!(dev.prepass_count(), 7, "a new radius recomputes only the sharpening planes");
    // Same settings, same pixels; the one-shot export path agrees.
    let mut s0 = detail(|d| {
        d.clarity = 30.0;
        d.texture = 20.0;
        d.dehaze = 10.0;
        d.sharpen.amount = 60.0;
    });
    s0.light.shadows = 30.0;
    assert_eq!(dev.render(&s0), a);
    assert_eq!(render_full(dev.image(), &s0).unwrap(), a);
}

// ---------- resolution independence ----------

#[test]
fn proxy_and_full_resolution_agree() {
    let s = {
        let mut s = DevelopSettings::default();
        s.detail.clarity = 50.0;
        s.detail.texture = 50.0;
        s.detail.sharpen.amount = 80.0;
        s
    };
    let (w, h) = (1600u32, 1060u32);
    let small = Developer::new(scene(w, h)).render(&s);
    let big = Developer::new(scene(w * 3, h * 3)).render(&s);
    let src = fr::images::Image::from_vec_u8(big.width, big.height, big.data, fr::PixelType::U8x3).unwrap();
    let mut dst = fr::images::Image::new(w, h, fr::PixelType::U8x3);
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3));
    fr::Resizer::new().resize(&src, &mut dst, &options).unwrap();
    let down = dst.buffer();
    let mad = small.data.iter().zip(down).map(|(a, b)| a.abs_diff(*b) as f64).sum::<f64>() / small.data.len() as f64;
    // For scale: the same comparison without any detail control.
    let plain = DevelopSettings::default();
    let small0 = Developer::new(scene(w, h)).render(&plain);
    let big0 = Developer::new(scene(w * 3, h * 3)).render(&plain);
    let src0 = fr::images::Image::from_vec_u8(big0.width, big0.height, big0.data, fr::PixelType::U8x3).unwrap();
    let mut dst0 = fr::images::Image::new(w, h, fr::PixelType::U8x3);
    fr::Resizer::new().resize(&src0, &mut dst0, &options).unwrap();
    let mad0 = small0.data.iter().zip(dst0.buffer()).map(|(a, b)| a.abs_diff(*b) as f64).sum::<f64>() / small0.data.len() as f64;
    let detail_effect =
        small.data.iter().zip(&small0.data).map(|(a, b)| a.abs_diff(*b) as f64).sum::<f64>() / small.data.len() as f64;
    eprintln!("1600 vs 4800↓: MAD {mad:.3} levels (no detail {mad0:.3}; detail moves the proxy by {detail_effect:.2})");
    assert!(detail_effect > 1.0, "the detail controls should visibly change the scene");
    assert!(mad < 2.0, "MAD {mad}");
}

// ---------- timing ----------

/// A 24 MP render with every detail control set. Run with
/// `cargo test -p photobook-develop --release --test detail -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_24mp_detail() {
    let (w, h) = (6000u32, 4000u32);
    let t = Instant::now();
    let img = scene(w, h);
    eprintln!("synthesise 24 MP: {:?}", t.elapsed());
    let dev = Developer::new(img);
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.2;
    s.light.highlights = -40.0;
    s.light.shadows = 30.0;
    s.light.contrast = 10.0;
    s.detail.clarity = 30.0;
    s.detail.texture = 25.0;
    s.detail.dehaze = 15.0;
    s.detail.sharpen.amount = 60.0;
    s.detail.sharpen.masking = 30.0;
    s.color.vibrance = 20.0;
    let t = Instant::now();
    let _ = dev.render(&s);
    eprintln!("render 24 MP, every detail control, first (computes the pre-passes): {:?}", t.elapsed());
    let t = Instant::now();
    let _ = dev.render(&s);
    eprintln!("render 24 MP, every detail control, cached pre-passes: {:?}", t.elapsed());
    s.detail.sharpen.radius = 1.5;
    let t = Instant::now();
    let _ = dev.render(&s);
    eprintln!("render 24 MP, new sharpening radius: {:?}", t.elapsed());

    let proxy = Developer::new(scene(1600, 1067));
    let t = Instant::now();
    let _ = proxy.render(&s);
    eprintln!("proxy 1600 px, first: {:?}", t.elapsed());
    for _ in 0..3 {
        s.detail.clarity += 5.0;
        let t = Instant::now();
        let _ = proxy.render(&s);
        eprintln!("proxy 1600 px, slider change: {:?}", t.elapsed());
    }
}
