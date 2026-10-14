//! D3.2: the GPU path against the CPU reference. Every fixture of `pipeline.rs` and `detail.rs` (plus
//! geometry cases) is rendered with every slider set on both backends; the 8-bit outputs must agree
//! within 2 levels per channel at most and 0.3 levels on average. Without a GPU adapter each test prints
//! `SKIP` and returns.
//!
//! Timings: `cargo test -p photobook-develop --release --test gpu -- --ignored --nocapture`.

use std::time::Instant;

use photobook_develop::gpu::{GpuContext, Tiling};
use photobook_develop::settings::{Crop, CropAspect, CropRect, Geometry, HueMix, Rotation, WhiteBalance};
use photobook_develop::{
    decode_file, encode_jpeg, gpu, render_full, render_preview, DevelopSettings, Developer, LinearImage, Quality,
    RenderBackend, RenderOptions, Rgb8Image,
};

mod common;
use common::*;

// ---------- helpers ----------

fn have_gpu(test: &str) -> bool {
    match GpuContext::get() {
        Some(ctx) => {
            eprintln!("{test}: GPU {} ({:?})", ctx.info.name, ctx.info.backend);
            true
        }
        None => {
            eprintln!("SKIP {test}: no GPU adapter (or PHOTOBOOK_FORCE_CPU / crash flag); nothing was compared");
            false
        }
    }
}

fn opts(backend: RenderBackend) -> RenderOptions {
    RenderOptions { backend, ..RenderOptions::default() }
}

#[derive(Debug, Clone, Copy)]
struct Diff {
    max: u8,
    mean: f64,
    /// Channels more than one level apart.
    over1: usize,
}

fn diff(a: &Rgb8Image, b: &Rgb8Image) -> Diff {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut max = 0;
    let mut sum = 0u64;
    let mut over1 = 0;
    for (x, y) in a.data.iter().zip(&b.data) {
        let d = x.abs_diff(*y);
        max = max.max(d);
        sum += d as u64;
        over1 += (d > 1) as usize;
    }
    Diff { max, mean: sum as f64 / a.data.len().max(1) as f64, over1 }
}

/// Both backends on fresh `Developer`s; asserts the GPU really ran.
fn both(img: &LinearImage, s: &DevelopSettings, options: &RenderOptions) -> (Rgb8Image, Rgb8Image) {
    let cpu = Developer::new(img.clone()).render_with(s, &RenderOptions { backend: RenderBackend::Cpu, ..options.clone() });
    let dev = Developer::new(img.clone());
    let gpu = dev.render_with(s, &RenderOptions { backend: RenderBackend::Gpu, ..options.clone() });
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu), "the GPU path did not run");
    (cpu, gpu)
}

const MAX_LEVELS: u8 = 2;
const MAX_MEAN: f64 = 0.3;

fn check(name: &str, img: &LinearImage, s: &DevelopSettings) -> Diff {
    check_with(name, img, s, &RenderOptions::default())
}

fn check_with(name: &str, img: &LinearImage, s: &DevelopSettings, options: &RenderOptions) -> Diff {
    let (cpu, gpu) = both(img, s, options);
    let d = diff(&cpu, &gpu);
    eprintln!(
        "  {name:<40} {:>4}x{:<4} max {} mean {:.4} (>1: {})",
        cpu.width, cpu.height, d.max, d.mean, d.over1
    );
    assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{name}: CPU vs GPU {d:?}");
    d
}

/// Every slider of the Light, White balance, Colour and Curve sections.
fn every_slider() -> DevelopSettings {
    let mut s = DevelopSettings::default();
    s.white_balance = WhiteBalance::Incremental { temperature: 20.0, tint: 5.0 };
    s.light.exposure = 0.3;
    s.light.highlights = -60.0;
    s.light.shadows = 40.0;
    s.light.whites = 10.0;
    s.light.blacks = -10.0;
    s.light.contrast = 25.0;
    s.color.vibrance = 30.0;
    s.color.saturation = 10.0;
    s.color.mix.blue = HueMix { hue: -10.0, saturation: 20.0, luminance: -20.0 };
    s.color.mix.red = HueMix { hue: 15.0, saturation: -10.0, luminance: 10.0 };
    s.color.mix.green = HueMix { hue: 5.0, saturation: 30.0, luminance: 5.0 };
    s.curve.parametric.lights = 20.0;
    s.curve.parametric.shadows = -15.0;
    s.curve.luma = vec![[0.0, 0.02], [0.5, 0.52], [1.0, 1.0]];
    s.curve.red = vec![[0.0, 0.0], [0.6, 0.63], [1.0, 1.0]];
    s
}

/// [`every_slider`] plus every Detail control.
fn everything() -> DevelopSettings {
    let mut s = every_slider();
    s.detail.clarity = 30.0;
    s.detail.texture = 25.0;
    s.detail.dehaze = 15.0;
    s.detail.sharpen.amount = 60.0;
    s.detail.sharpen.masking = 30.0;
    s
}

/// A list of named settings covering each control at both signs, and the extremes.
fn variants() -> Vec<(&'static str, DevelopSettings)> {
    let mut v = vec![("defaults", DevelopSettings::default()), ("every slider", every_slider()), ("everything", everything())];
    let mut s = DevelopSettings::default();
    s.light.exposure = 1.0;
    s.light.contrast = 100.0;
    s.light.shadows = 100.0;
    s.light.highlights = -100.0;
    s.light.whites = 100.0;
    s.light.blacks = -100.0;
    v.push(("light extremes", s));
    let mut s = DevelopSettings::default();
    s.light.contrast = -100.0;
    s.light.shadows = -100.0;
    s.light.highlights = 100.0;
    s.light.whites = -100.0;
    s.light.blacks = 100.0;
    s.white_balance = WhiteBalance::Absolute { temperature: 3200.0, tint: -20.0 };
    v.push(("light negative, absolute WB", s));
    let mut s = DevelopSettings::default();
    s.color.saturation = 100.0;
    s.color.vibrance = -60.0;
    s.color.mix.orange = HueMix { hue: 100.0, saturation: 100.0, luminance: -100.0 };
    s.color.mix.aqua = HueMix { hue: -100.0, saturation: -100.0, luminance: 100.0 };
    v.push(("colour extremes", s));
    let mut s = DevelopSettings::default();
    s.detail.clarity = 100.0;
    s.detail.texture = 100.0;
    s.detail.dehaze = 100.0;
    s.detail.sharpen.amount = 150.0;
    s.detail.sharpen.radius = 3.0;
    s.detail.sharpen.detail = 80.0;
    v.push(("detail +100", s));
    let mut s = DevelopSettings::default();
    s.detail.clarity = -100.0;
    s.detail.texture = -100.0;
    s.detail.dehaze = -100.0;
    s.detail.sharpen.amount = 40.0;
    s.detail.sharpen.radius = 0.5;
    s.detail.sharpen.masking = 100.0;
    v.push(("detail -100, masking 100", s));
    v
}

fn crop(x: f64, y: f64, w: f64, h: f64, angle: f64) -> Option<Crop> {
    Some(Crop { rect: CropRect { x, y, w, h }, angle, aspect: CropAspect::default() })
}

// ---------- CPU vs GPU ----------

#[test]
fn pipeline_fixtures_match_the_cpu() {
    if !have_gpu("pipeline_fixtures_match_the_cpu") {
        return;
    }
    let f = fixtures();
    let mut worst = 0.0f64;
    for (file, path) in [("ramp", &f.ramp), ("chart", &f.chart), ("photo", &f.photo)] {
        let img = decode_file(path, None).unwrap();
        for (name, s) in variants() {
            worst = worst.max(check(&format!("{file}: {name}"), &img, &s).mean);
        }
        let look = RenderOptions { look: true, ..RenderOptions::default() };
        check_with(&format!("{file}: everything + look"), &img, &everything(), &look);
    }
    eprintln!("worst mean {worst:.4}");
}

#[test]
fn detail_fixtures_match_the_cpu() {
    if !have_gpu("detail_fixtures_match_the_cpu") {
        return;
    }
    let textured = image(W, H, |x, y| grey(118.0 + 40.0 * value_noise(x, y, 14.0, 1)));
    let hazy = image(W, H, |x, y| {
        if y < 200 {
            return grey(255.0);
        }
        let n = value_noise(x, y, 40.0, 3);
        let scene = [90.0 + 160.0 * n, 110.0 + 120.0 * n, 70.0 - 100.0 * n];
        scene.map(|c| {
            let l = lin8(c.clamp(0.0, 255.0));
            255.0 * photobook_develop::color::transfer::linear_to_srgb(l * 0.55 + 0.45)
        })
    });
    let edge_noise = image(W, H, |x, y| {
        if x < W / 2 {
            grey(100.0 + 70.0 * smoothstep(W as f32 / 4.0 - 3.0, W as f32 / 4.0 + 3.0, x as f32))
        } else {
            grey(128.0 + 6.0 * hash(x, y, 5))
        }
    });
    for (file, img) in [("backlit edge", backlit_edge()), ("texture", textured), ("haze", hazy), ("edge + noise", edge_noise), ("scene 1600", scene(1600, 1060))] {
        for (name, s) in variants() {
            check(&format!("{file}: {name}"), &img, &s);
        }
    }
}

#[test]
fn geometry_matches_the_cpu() {
    if !have_gpu("geometry_matches_the_cpu") {
        return;
    }
    let f = fixtures();
    let photo = decode_file(&f.photo, None).unwrap();
    let mut keystone = Geometry::default();
    keystone.transform.vertical = -40.0;
    keystone.transform.horizontal = 20.0;
    keystone.transform.rotate = 3.0;
    keystone.crop = crop(0.15, 0.15, 0.7, 0.7, 0.0);
    let cases = [
        ("rotate 90 + flip (copy)", Geometry { rotate: Rotation::R90, flip_h: true, ..Geometry::default() }),
        ("whole-pixel crop (copy)", Geometry { crop: crop(0.25, 0.25, 0.5, 0.5, 0.0), ..Geometry::default() }),
        ("straighten 4° + crop", Geometry { crop: crop(0.1, 0.1, 0.7, 0.6, 4.0), ..Geometry::default() }),
        ("keystone + rotate + crop", keystone),
    ];
    for (name, g) in cases {
        let mut s = everything();
        s.geometry = g;
        for quality in [Quality::Preview, Quality::Export] {
            let cpu = Developer::new(photo.clone()).render_with_quality(&s, &opts(RenderBackend::Cpu), quality);
            let dev = Developer::new(photo.clone());
            let gpu = dev.render_with_quality(&s, &opts(RenderBackend::Gpu), quality);
            assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
            assert_eq!(dev.warp_count(), 1);
            let d = diff(&cpu, &gpu);
            eprintln!("  photo: {name} ({quality:?}) {}x{} max {} mean {:.4} (>1: {})", cpu.width, cpu.height, d.max, d.mean, d.over1);
            assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{name} {quality:?}: {d:?}");
        }
    }
    // Previews: the Mitchell prefilter (straighten into a small preview) and a plain resize (no geometry,
    // and a downscaled whole-pixel crop: copy + Lanczos3 resize).
    for (name, g) in [
        ("preview of a straighten", Geometry { crop: crop(0.1, 0.1, 0.8, 0.8, -6.0), ..Geometry::default() }),
        ("preview, no geometry", Geometry::default()),
        ("preview of a crop", Geometry { crop: crop(0.25, 0.25, 0.5, 0.5, 0.0), ..Geometry::default() }),
    ] {
        let mut s = every_slider();
        s.geometry = g;
        let gpu = render_preview(&photo, &s, 200, 100).unwrap();
        let cpu_img = {
            // The CPU reference of the same preview: warp/resize on the CPU then develop.
            let plan = photobook_develop::GeometryPlan::new(&s.geometry, photo.width, photo.height, None);
            let small = if plan.is_identity() {
                // `decode::fit` to a 200 px long edge (the photo is landscape).
                let (w, h) = (200, ((photo.height as f64 * 200.0 / photo.width as f64).round() as u32).max(1));
                photobook_develop::decode::resize_linear(photo.clone(), w, h).unwrap()
            } else {
                let plan = photobook_develop::GeometryPlan::new(&s.geometry, photo.width, photo.height, Some(200));
                photobook_develop::geometry::warp(&photo, &plan, Quality::Preview)
            };
            let mut flat = s.clone();
            flat.geometry = Geometry::default();
            Developer::new(small).render_with(&flat, &opts(RenderBackend::Cpu))
        };
        let gpu_img = decode_back(&gpu);
        let cpu_jpeg = decode_back(&encode_jpeg(&cpu_img, 100).unwrap());
        let d = diff(&cpu_jpeg, &gpu_img);
        eprintln!("  photo: {name} {}x{} max {} mean {:.4} (JPEG q100 both)", gpu_img.width, gpu_img.height, d.max, d.mean);
        // Both went through a q100 JPEG, which adds its own rounding.
        assert!(d.max <= MAX_LEVELS + 2 && d.mean <= MAX_MEAN, "{name}: {d:?}");
    }
}

fn decode_back(jpeg: &[u8]) -> Rgb8Image {
    let img = turbojpeg::decompress(jpeg, turbojpeg::PixelFormat::RGB).unwrap();
    Rgb8Image::new(img.width as u32, img.height as u32, img.pixels)
}

/// The export entry point agrees with the cached `Developer` bit for bit (same GPU code), and the
/// Developer caches on the GPU like on the CPU.
#[test]
fn render_full_and_developer_agree_and_cache() {
    if !have_gpu("render_full_and_developer_agree_and_cache") {
        return;
    }
    let img = scene(1440, 1080);
    let dev = Developer::new(img.clone());
    let mut s = everything();
    let a = dev.render(&s);
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    // log Y, highlights/shadows, clarity, texture, haze, sharpening: as `PrePasses` counts them.
    assert_eq!(dev.prepass_count(), 6);
    for v in [10.0, 50.0] {
        s.light.exposure = v / 100.0;
        s.detail.clarity = v;
        s.detail.sharpen.amount = v;
        let _ = dev.render(&s);
    }
    assert_eq!(dev.prepass_count(), 6, "slider changes reuse the GPU planes");
    s.detail.sharpen.radius = 2.0;
    let _ = dev.render(&s);
    assert_eq!(dev.prepass_count(), 7, "a new radius recomputes the sharpening planes only");
    let s0 = everything();
    assert_eq!(dev.render(&s0), a);
    assert_eq!(render_full(&img, &s0).unwrap(), a);
}

/// Tiled rendering (2048 px tiles by default, here smaller and odd so tiles cut through everything)
/// gives the whole-image result, and both match the CPU.
#[test]
fn tiles_match_the_whole_image() {
    if !have_gpu("tiles_match_the_whole_image") {
        return;
    }
    let img = scene(3000, 2000);
    let mut s = everything();
    s.detail.sharpen.radius = 2.5;
    let whole = gpu::render_tiled(&img, &s, Tiling::Size(4096)).unwrap();
    for tile in [2048, 1000, 777] {
        let tiled = gpu::render_tiled(&img, &s, Tiling::Size(tile)).unwrap();
        let d = diff(&whole, &tiled);
        eprintln!("  3000x2000, tiles of {tile}: max {} mean {:.6}", d.max, d.mean);
        assert_eq!(d.max, 0, "tiles of {tile} differ from the whole image: {d:?}");
    }
    let cpu = Developer::new(img.clone()).render_with(&s, &opts(RenderBackend::Cpu));
    let d = diff(&cpu, &whole);
    eprintln!("  3000x2000 vs CPU: max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
    assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{d:?}");
    // The automatic choice for an image above the tile size is tiled, and agrees too.
    let auto = Developer::new(img).render(&s);
    assert_eq!(diff(&auto, &whole).max, 0);
}

// ---------- timing ----------

/// Proxy slider drag and 24 MP export on the GPU. Run with
/// `cargo test -p photobook-develop --release --test gpu -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_gpu() {
    if !have_gpu("timing_gpu") {
        return;
    }
    eprintln!("GPU startup (device + kernels): {:.0} ms", GpuContext::get().unwrap().startup_ms);
    let s = everything();
    // A 1600 px proxy, as the editor keeps it.
    let proxy = Developer::new(scene(1600, 1067));
    let t = Instant::now();
    let _ = proxy.render(&s);
    eprintln!("proxy 1600 px, first render (upload + pre-passes): {:?}", t.elapsed());
    let mut s2 = s.clone();
    let mut times = Vec::new();
    for i in 0..30 {
        s2.light.exposure = 0.3 + i as f64 * 0.01;
        s2.detail.clarity = 30.0 + i as f64;
        let t = Instant::now();
        let out = proxy.render(&s2);
        times.push(t.elapsed().as_secs_f64() * 1e3);
        assert_eq!(out.width, 1600);
    }
    times.sort_by(f64::total_cmp);
    eprintln!(
        "proxy 1600 px, slider change (every control set): median {:.2} ms, min {:.2} ms, max {:.2} ms",
        times[times.len() / 2],
        times[0],
        times[times.len() - 1]
    );
    let cpu = Developer::new(scene(1600, 1067));
    let _ = cpu.render_with(&s, &opts(RenderBackend::Cpu));
    let t = Instant::now();
    let out = cpu.render_with(&s2, &opts(RenderBackend::Cpu));
    eprintln!("proxy 1600 px, slider change on the CPU for comparison: {:?}", t.elapsed());
    let t = Instant::now();
    let _ = encode_jpeg(&out, 85).unwrap();
    eprintln!("(JPEG q85 encode, not included above: {:?})", t.elapsed());

    let big = scene(6000, 4000);
    for (name, settings) in [("every control", s.clone()), ("every control + straighten 3°", {
        let mut g = s.clone();
        g.geometry.crop = crop(0.05, 0.05, 0.9, 0.9, 3.0);
        g
    })] {
        let t = Instant::now();
        let out = render_full(&big, &settings).unwrap();
        let gpu_t = t.elapsed();
        eprintln!("24 MP export, {name}: GPU {gpu_t:?} ({}x{})", out.width, out.height);
    }
    let t = Instant::now();
    let _ = Developer::new(big.clone()).render_with(&s, &opts(RenderBackend::Cpu));
    eprintln!("24 MP export, every control: CPU {:?} for comparison", t.elapsed());
}

// ---------- masks (D4.1) ----------

fn mask_json(components: serde_json::Value, extra: serde_json::Value) -> photobook_develop::settings::Mask {
    let mut m = serde_json::json!({ "id": "m", "name": "Mask", "components": components });
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    serde_json::from_value(m).unwrap()
}

/// The masked cases of the D4.1 check, each on top of `base`.
fn masked_variants(base: &DevelopSettings) -> Vec<(&'static str, DevelopSettings)> {
    use serde_json::json;
    let radial = mask_json(
        json!([{"id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.3, 0.35], "angle": 15, "feather": 60}]),
        json!({"id": "vignette", "invert": true, "feather": 30, "adjustments": {"exposure": -2}}),
    );
    let linear = mask_json(
        json!([{"id": "l", "kind": "linear", "from": [0.5, 0.1], "to": [0.5, 0.5]}]),
        json!({"id": "grad", "invert": true, "adjustments": {"saturation": 60}}),
    );
    let brush = mask_json(
        json!([{"id": "b", "kind": "brush", "strokes": [
            {"points": [[0.15, 0.6], [0.4, 0.7], [0.7, 0.55]], "size": 15, "feather": 50},
            {"points": [[0.3, 0.3], [0.32, 0.31]], "size": 30, "feather": 80, "flow": 60}
        ]}]),
        json!({"id": "brush", "adjustments": {"clarity": 80}}),
    );
    let shadows = mask_json(
        json!([{"id": "y", "kind": "luminance", "range": [0.0, 0.35], "feather": 50}]),
        json!({"id": "darks", "opacity": 80, "adjustments": {"shadows": 70}}),
    );
    let every_local = mask_json(
        json!([
            {"id": "r2", "kind": "radial", "center": [0.4, 0.6], "radii": [0.4, 0.4], "angle": 0, "feather": 40},
            {"id": "c", "kind": "color", "mode": "subtract", "samples": ["#5a8cdc"], "tolerance": 40}
        ]),
        json!({"id": "all", "adjustments": {
            "exposure": 0.6, "contrast": 30, "highlights": -40, "shadows": 25, "whites": 20, "blacks": -15,
            "temperature": 25, "tint": -10, "texture": 40, "clarity": -30, "dehaze": 35, "saturation": -20,
            "sharpness": 50, "hue": 40
        }}),
    );
    let with = |masks: Vec<photobook_develop::settings::Mask>| DevelopSettings { masks, ..base.clone() };
    vec![
        ("radial exposure -2", with(vec![radial.clone()])),
        ("linear saturation +60", with(vec![linear.clone()])),
        ("brush clarity +80", with(vec![brush.clone()])),
        ("luminance-range shadows +70", with(vec![shadows.clone()])),
        ("every local slider", with(vec![every_local.clone()])),
        ("five overlapping masks", with(vec![radial, linear, brush, shadows, every_local])),
    ]
}

#[test]
fn masks_match_the_cpu() {
    if !have_gpu("masks_match_the_cpu") {
        return;
    }
    let f = fixtures();
    let photo = decode_file(&f.photo, None).unwrap();
    let mut worst = Diff { max: 0, mean: 0.0, over1: 0 };
    for (file, img) in [("photo", photo.clone()), ("scene 1600", scene(1600, 1060))] {
        for (base_name, base) in [("defaults", DevelopSettings::default()), ("everything", everything())] {
            for (name, s) in masked_variants(&base) {
                let d = check(&format!("{file}: {base_name} + {name}"), &img, &s);
                worst.max = worst.max.max(d.max);
                worst.mean = worst.mean.max(d.mean);
            }
        }
    }
    // Absolute white balance (the local temperature is a mired shift) and a geometry (the range masks read
    // the warped input; the layers are on the cropped grid).
    let mut s = masked_variants(&everything()).pop().unwrap().1;
    s.white_balance = WhiteBalance::Absolute { temperature: 4800.0, tint: 6.0 };
    let d = check("photo: absolute WB + five masks", &photo, &s);
    worst.max = worst.max.max(d.max);
    s.geometry.crop = crop(0.1, 0.05, 0.8, 0.85, 3.5);
    for quality in [Quality::Preview, Quality::Export] {
        let cpu = Developer::new(photo.clone()).render_with_quality(&s, &opts(RenderBackend::Cpu), quality);
        let dev = Developer::new(photo.clone());
        let gpu = dev.render_with_quality(&s, &opts(RenderBackend::Gpu), quality);
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
        let d = diff(&cpu, &gpu);
        eprintln!("  photo: five masks + straighten ({quality:?}) max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
        assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{quality:?}: {d:?}");
        worst.max = worst.max.max(d.max);
    }
    eprintln!("masks: worst max {} worst mean {:.4}", worst.max, worst.mean);
}

/// Tiled renders sample the mask layers at the tile offset: identical to the whole image; a `Developer`
/// reuses the uploaded layers across slider changes and matches a fresh render.
#[test]
fn masked_tiles_match_the_whole_image() {
    if !have_gpu("masked_tiles_match_the_whole_image") {
        return;
    }
    let img = scene(3000, 2000);
    let (_, s) = masked_variants(&everything()).pop().unwrap();
    let whole = gpu::render_tiled(&img, &s, Tiling::Size(4096)).unwrap();
    for tile in [2048, 777] {
        let tiled = gpu::render_tiled(&img, &s, Tiling::Size(tile)).unwrap();
        let d = diff(&whole, &tiled);
        eprintln!("  masked 3000x2000, tiles of {tile}: max {} mean {:.6}", d.max, d.mean);
        assert_eq!(d.max, 0, "tiles of {tile}: {d:?}");
    }
    let cpu = Developer::new(img.clone()).render_with(&s, &opts(RenderBackend::Cpu));
    let d = diff(&cpu, &whole);
    eprintln!("  masked 3000x2000 vs CPU: max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
    assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{d:?}");

    let small = scene(1200, 800);
    let dev = Developer::new(small.clone());
    let mut s2 = s.clone();
    let _ = dev.render(&s2);
    s2.light.exposure = 0.7;
    s2.masks[0].adjustments.exposure = -1.0;
    let again = dev.render(&s2);
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    assert_eq!(dev.mask_build_count(), 1, "slider changes reuse the layers");
    assert_eq!(again, Developer::new(small).render(&s2), "cached layers render like fresh ones");
}

// ---------- effects (workflow plan 19) ----------

use photobook_develop::settings::{Effects, GradingWheel, Look, LutRef};

/// The committed fixture LUT (`fixtures/luts/<sha256>.cube`, 9³), named by `look.json`.
const FIXTURE_LUT: &str = "2a09ead054896e77573e0d00b6bbc5405467ad7a45afde4a4bdd9c532c0c34b4";

fn fixture_settings(name: &str) -> DevelopSettings {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    photobook_develop::lut::set_lut_dir(Some(dir.join("luts")));
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap();
    serde_json::from_value(json["settings"].clone()).unwrap()
}

fn with_effects(base: &DevelopSettings, f: impl FnOnce(&mut Effects)) -> DevelopSettings {
    let mut s = base.clone();
    f(&mut s.effects);
    s
}

/// Every effect at once (the slider-latency case too).
fn all_effects(e: &mut Effects) {
    e.grading.shadows = GradingWheel { hue: 200.0, saturation: 40.0, ..GradingWheel::default() };
    e.grading.midtones = GradingWheel { hue: 120.0, saturation: 15.0, ..GradingWheel::default() };
    e.grading.highlights = GradingWheel { hue: 40.0, saturation: 35.0, ..GradingWheel::default() };
    e.grading.balance = -20.0;
    e.grain.amount = 35.0;
    e.grain.size = 40.0;
    e.grain.roughness = 60.0;
    e.vignette.amount = -35.0;
    e.vignette.roundness = -20.0;
    e.halation.amount = 60.0;
    e.halation.threshold = 60.0;
}

/// Each op on its own at both signs and the shape extremes, then all of them, alone and on top of every other control.
fn effect_variants() -> Vec<(&'static str, DevelopSettings)> {
    let d = DevelopSettings::default();
    vec![
        ("grading: split tone", with_effects(&d, |e| {
            e.grading.shadows = GradingWheel { hue: 210.0, saturation: 70.0, ..GradingWheel::default() };
            e.grading.highlights = GradingWheel { hue: 35.0, saturation: 70.0, ..GradingWheel::default() };
        })),
        ("grading: midtones, blending 0, balance +100", with_effects(&d, |e| {
            e.grading.midtones = GradingWheel { hue: 300.0, saturation: 100.0, ..GradingWheel::default() };
            e.grading.shadows = GradingWheel { hue: 60.0, saturation: 30.0, ..GradingWheel::default() };
            e.grading.blending = 0.0;
            e.grading.balance = 100.0;
        })),
        ("grading: blending 100, balance -100", with_effects(&d, |e| {
            e.grading.highlights = GradingWheel { hue: 180.0, saturation: 100.0, ..GradingWheel::default() };
            e.grading.blending = 100.0;
            e.grading.balance = -100.0;
        })),
        ("grain: amount 100, size 0", with_effects(&d, |e| {
            e.grain.amount = 100.0;
            e.grain.size = 0.0;
        })),
        ("grain: size 100, roughness 0", with_effects(&d, |e| {
            e.grain.amount = 60.0;
            e.grain.size = 100.0;
            e.grain.roughness = 0.0;
        })),
        ("grain: roughness 100", with_effects(&d, |e| {
            e.grain.amount = 50.0;
            e.grain.roughness = 100.0;
        })),
        ("vignette: -100", with_effects(&d, |e| e.vignette.amount = -100.0)),
        ("vignette: +60, roundness +100", with_effects(&d, |e| {
            e.vignette.amount = 60.0;
            e.vignette.roundness = 100.0;
        })),
        ("vignette: -70, roundness -100, feather 0", with_effects(&d, |e| {
            e.vignette.amount = -70.0;
            e.vignette.roundness = -100.0;
            e.vignette.feather = 0.0;
            e.vignette.midpoint = 20.0;
        })),
        ("vignette: +100, midpoint 100, feather 100", with_effects(&d, |e| {
            e.vignette.amount = 100.0;
            e.vignette.midpoint = 100.0;
            e.vignette.feather = 100.0;
        })),
        ("halation: default shape", with_effects(&d, |e| e.halation.amount = 80.0)),
        ("halation: threshold 0", with_effects(&d, |e| {
            e.halation.amount = 60.0;
            e.halation.threshold = 0.0;
        })),
        ("halation: threshold 100", with_effects(&d, |e| {
            e.halation.amount = 100.0;
            e.halation.threshold = 100.0;
        })),
        ("halation: threshold 30, radius 100", with_effects(&d, |e| {
            e.halation.amount = 100.0;
            e.halation.threshold = 30.0;
            e.halation.radius = 100.0;
        })),
        ("halation: radius 0", with_effects(&d, |e| {
            e.halation.amount = 70.0;
            e.halation.threshold = 50.0;
            e.halation.radius = 0.0;
        })),
        ("all effects", with_effects(&d, all_effects)),
        ("all effects + everything", with_effects(&everything(), all_effects)),
        ("effects.json fixture", fixture_settings("effects.json")),
    ]
}

#[test]
fn effects_match_the_cpu() {
    if !have_gpu("effects_match_the_cpu") {
        return;
    }
    let f = fixtures();
    let photo = decode_file(&f.photo, None).unwrap();
    let chart = decode_file(&f.chart, None).unwrap();
    let mut worst = Diff { max: 0, mean: 0.0, over1: 0 };
    for (file, img) in [("photo", photo.clone()), ("chart", chart), ("scene 1600", scene(1600, 1060)), ("backlit edge", backlit_edge())] {
        for (name, s) in effect_variants() {
            let d = check(&format!("{file}: {name}"), &img, &s);
            worst.max = worst.max.max(d.max);
            worst.mean = worst.mean.max(d.mean);
        }
    }
    // The display look (RAW) between the linear and the display-referred effects, and Display P3 output.
    let all = with_effects(&everything(), all_effects);
    check_with("photo: all effects + look", &photo, &all, &RenderOptions { look: true, ..RenderOptions::default() });
    let p3 = RenderOptions { output: photobook_develop::OutputProfile::DisplayP3, ..RenderOptions::default() };
    check_with("photo: all effects, Display P3", &photo, &all, &p3);
    // Masked pixels get the effects too, on both paths.
    for (name, s) in masked_variants(&all) {
        check(&format!("photo: all effects + {name}"), &photo, &s);
    }
    // A geometry: the effects run on the cropped grid (vignette frame, grain scale, the glow of the warped input).
    let mut s = all.clone();
    s.geometry.crop = crop(0.1, 0.05, 0.8, 0.85, 3.5);
    for quality in [Quality::Preview, Quality::Export] {
        let cpu = Developer::new(photo.clone()).render_with_quality(&s, &opts(RenderBackend::Cpu), quality);
        let dev = Developer::new(photo.clone());
        let gpu = dev.render_with_quality(&s, &opts(RenderBackend::Gpu), quality);
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
        let d = diff(&cpu, &gpu);
        eprintln!("  photo: all effects + straighten ({quality:?}) max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
        assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{quality:?}: {d:?}");
    }
    eprintln!("effects: worst max {} worst mean {:.4}", worst.max, worst.mean);
}

/// Plan 55: the per-wheel luminance offsets and the Global wheel, each at both signs and together, alone and over
/// every other control, on the GPU as on the CPU.
#[test]
fn grading_wheels_match_the_cpu() {
    if !have_gpu("grading_wheels_match_the_cpu") {
        return;
    }
    let lum = |hue: f64, saturation: f64, luminance: f64| GradingWheel { hue, saturation, luminance };
    let d = DevelopSettings::default();
    let variants: Vec<(&str, DevelopSettings)> = vec![
        ("shadows luminance +100", with_effects(&d, |e| e.grading.shadows = lum(0.0, 0.0, 100.0))),
        ("midtones luminance -100", with_effects(&d, |e| e.grading.midtones = lum(0.0, 0.0, -100.0))),
        ("highlights luminance -60, tinted", with_effects(&d, |e| e.grading.highlights = lum(40.0, 50.0, -60.0))),
        ("global wheel", with_effects(&d, |e| e.grading.global = lum(200.0, 60.0, 0.0))),
        ("global luminance +100", with_effects(&d, |e| e.grading.global = lum(0.0, 0.0, 100.0))),
        ("every wheel and luminance, blending 0, balance +60", with_effects(&d, |e| {
            e.grading.shadows = lum(210.0, 70.0, 40.0);
            e.grading.midtones = lum(300.0, 30.0, -25.0);
            e.grading.highlights = lum(35.0, 70.0, -50.0);
            e.grading.global = lum(60.0, 20.0, 15.0);
            e.grading.blending = 0.0;
            e.grading.balance = 60.0;
        })),
        ("all effects + every wheel + everything", with_effects(&everything(), |e| {
            all_effects(e);
            e.grading.shadows.luminance = 30.0;
            e.grading.highlights.luminance = -30.0;
            e.grading.global = lum(30.0, 25.0, -10.0);
        })),
    ];
    let f = fixtures();
    let photo = decode_file(&f.photo, None).unwrap();
    let chart = decode_file(&f.chart, None).unwrap();
    let mut worst = Diff { max: 0, mean: 0.0, over1: 0 };
    for (file, img) in [("photo", photo), ("chart", chart), ("scene 1600", scene(1600, 1060))] {
        for (name, s) in &variants {
            let d = check(&format!("{file}: {name}"), &img, s);
            worst.max = worst.max.max(d.max);
            worst.mean = worst.mean.max(d.mean);
        }
    }
    eprintln!("grading wheels: worst max {} worst mean {:.4}", worst.max, worst.mean);
}

/// Every effect with the look's LUT (plan 18): curves → LUT → grading → grain on the GPU as on the CPU.
#[test]
fn effects_with_a_lut_match_the_cpu() {
    if !have_gpu("effects_with_a_lut_match_the_cpu") {
        return;
    }
    let look = fixture_settings("look.json");
    assert_eq!(look.look.lut.as_ref().map(|l| l.id.as_str()), Some(FIXTURE_LUT));
    let f = fixtures();
    let photo = decode_file(&f.photo, None).unwrap();
    let mut s = with_effects(&look, all_effects);
    s.curve.luma = vec![[0.0, 0.03], [0.5, 0.55], [1.0, 0.97]];
    for (file, img) in [("photo", photo.clone()), ("scene 1600", scene(1600, 1060))] {
        check(&format!("{file}: LUT + all effects"), &img, &s);
        check(&format!("{file}: LUT + everything + all effects"), &img, &DevelopSettings { look: s.look.clone(), ..with_effects(&everything(), all_effects) });
    }
    let half = DevelopSettings { look: Look { lut: Some(LutRef { id: FIXTURE_LUT.into(), name: "Fixture".into(), strength: 40.0 }) }, ..s.clone() };
    check("photo: LUT at 40 % + all effects", &photo, &half);
    // The LUT really runs (the GPU render without it differs).
    let dev = Developer::new(photo.clone());
    let with_lut = dev.render_with(&s, &opts(RenderBackend::Gpu));
    let without = dev.render_with(&DevelopSettings { look: Look::default(), ..s.clone() }, &opts(RenderBackend::Gpu));
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    assert!(diff(&with_lut, &without).max > 5);
}

/// Tiles cut through the vignette, the grain field and the glow: identical to the whole image.
#[test]
fn effects_tiles_match_the_whole_image() {
    if !have_gpu("effects_tiles_match_the_whole_image") {
        return;
    }
    let img = scene(3000, 2000);
    let s = with_effects(&everything(), all_effects);
    let whole = gpu::render_tiled(&img, &s, Tiling::Size(4096)).unwrap();
    for tile in [2048, 777] {
        let tiled = gpu::render_tiled(&img, &s, Tiling::Size(tile)).unwrap();
        let d = diff(&whole, &tiled);
        eprintln!("  effects 3000x2000, tiles of {tile}: max {} mean {:.6}", d.max, d.mean);
        assert_eq!(d.max, 0, "tiles of {tile}: {d:?}");
    }
    let cpu = Developer::new(img).render_with(&s, &opts(RenderBackend::Cpu));
    let d = diff(&cpu, &whole);
    eprintln!("  effects 3000x2000 vs CPU: max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
    assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{d:?}");
}

/// The glow is cached like the CPU's (an LRU of one by key): amount and the other effects reuse it; threshold, radius
/// and exposure (which moves the threshold in the decoded image's units) recompute it.
#[test]
fn halation_glow_is_cached_on_the_gpu() {
    if !have_gpu("halation_glow_is_cached_on_the_gpu") {
        return;
    }
    let img = scene(1200, 800);
    let dev = Developer::new(img.clone());
    let mut s = with_effects(&DevelopSettings::default(), |e| e.halation.amount = 50.0);
    let _ = dev.render(&s);
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    let base = dev.prepass_count();
    assert_eq!(base, 1, "the glow only");
    s.effects.halation.amount = 90.0;
    s.effects.vignette.amount = -40.0;
    s.effects.grain.amount = 20.0;
    let _ = dev.render(&s);
    assert_eq!(dev.prepass_count(), base, "amount and other effects reuse the glow");
    s.effects.halation.threshold = 50.0;
    let _ = dev.render(&s);
    assert_eq!(dev.prepass_count(), base + 1);
    s.light.exposure = 0.5;
    let again = dev.render(&s);
    assert_eq!(dev.prepass_count(), base + 2, "exposure moves the threshold");
    assert_eq!(again, Developer::new(img).render(&s), "a cached glow renders like a fresh one");
}

/// A scene-referred input far above 1.0 (specular highlights at 6–20, as a bright RAW gives): the glow's excess is
/// capped at `MAX_EXCESS` (4) on both paths, at thresholds 0, 30 and 100 (100 = linear 1.0, which only such an input
/// passes), alone and with the other effects.
#[test]
fn halation_cap_on_an_hdr_input_matches_the_cpu() {
    if !have_gpu("halation_cap_on_an_hdr_input_matches_the_cpu") {
        return;
    }
    let (w, h) = (900u32, 600u32);
    let base = scene(w, h);
    let data: Vec<f32> = base
        .data
        .chunks_exact(3)
        .enumerate()
        .flat_map(|(i, p)| {
            let (x, y) = (i as u32 % w, i as u32 / w);
            let d = ((x as f32 - 600.0).powi(2) + (y as f32 - 200.0).powi(2)).sqrt();
            let gain = if d < 40.0 { 20.0 } else if (100..180).contains(&x) && (380..460).contains(&y) { 6.0 } else { 1.0 };
            [p[0] * gain + if gain > 1.0 { gain } else { 0.0 }, p[1] * gain + if gain > 1.0 { 0.8 * gain } else { 0.0 }, p[2] * gain]
        })
        .collect();
    let hdr = LinearImage::new(w, h, data);
    assert!(hdr.data.iter().any(|v| *v > 4.0 + 1.0), "the input goes past the cap");
    for threshold in [0.0, 30.0, 100.0] {
        for radius in [10.0, 80.0] {
            let s = with_effects(&DevelopSettings::default(), |e| {
                e.halation.amount = 100.0;
                e.halation.threshold = threshold;
                e.halation.radius = radius;
            });
            check(&format!("hdr: halation threshold {threshold}, radius {radius}"), &hdr, &s);
        }
    }
    let mut s = with_effects(&everything(), all_effects);
    s.effects.halation.threshold = 0.0;
    check("hdr: all effects, halation threshold 0", &hdr, &s);
}

/// The glow of a warped (straightened) input is cached with that warp: slider changes reuse the warp, and after an
/// amount, threshold or exposure change the cached `Developer` renders exactly like a fresh one (no stale glow).
#[test]
fn halation_glow_on_a_warped_input() {
    if !have_gpu("halation_glow_on_a_warped_input") {
        return;
    }
    let photo = decode_file(&fixtures().photo, None).unwrap();
    let mut s = with_effects(&DevelopSettings::default(), |e| {
        e.halation.amount = 70.0;
        e.halation.threshold = 55.0;
        e.vignette.amount = -30.0;
    });
    s.geometry.crop = crop(0.1, 0.05, 0.8, 0.85, 3.5);
    let dev = Developer::new(photo.clone());
    let fresh = |s: &DevelopSettings| Developer::new(photo.clone()).render_with(s, &opts(RenderBackend::Gpu));
    let first = dev.render_with(&s, &opts(RenderBackend::Gpu));
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    let cpu = Developer::new(photo.clone()).render_with(&s, &opts(RenderBackend::Cpu));
    let d = diff(&cpu, &first);
    eprintln!("  photo: halation + straighten max {} mean {:.4} (>1: {})", d.max, d.mean, d.over1);
    assert!(d.max <= MAX_LEVELS && d.mean <= MAX_MEAN, "{d:?}");
    for step in ["amount", "threshold", "exposure"] {
        match step {
            "amount" => s.effects.halation.amount = 95.0,
            "threshold" => s.effects.halation.threshold = 35.0,
            _ => s.light.exposure = 0.6,
        }
        let cached = dev.render_with(&s, &opts(RenderBackend::Gpu));
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
        assert_eq!(cached, fresh(&s), "after the {step} change the cached glow renders like a fresh one");
    }
    assert_eq!(dev.warp_count(), 1, "slider changes never re-warp");
}

/// Slider latency on the 1600 px proxy with every effect on (plan 19 records it). Run with
/// `cargo test -p photobook-develop --release --test gpu -- --ignored --nocapture timing_effects`.
#[test]
#[ignore]
fn timing_effects_proxy() {
    if !have_gpu("timing_effects_proxy") {
        return;
    }
    let median = |dev: &Developer, base: &DevelopSettings, backend: RenderBackend, vary: &dyn Fn(&mut DevelopSettings, f64)| {
        let _ = dev.render_with(base, &opts(backend)); // upload and pre-passes
        let mut times: Vec<f64> = (0..30)
            .map(|i| {
                let mut s = base.clone();
                vary(&mut s, i as f64);
                let t = Instant::now();
                let out = dev.render_with(&s, &opts(backend));
                assert_eq!(dev.last_backend(), Some(backend));
                assert_eq!(out.width, 1600);
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        times.sort_by(f64::total_cmp);
        (times[times.len() / 2], times[0], times[times.len() - 1])
    };
    let none = everything();
    let all = with_effects(&everything(), all_effects);
    let exposure = |s: &mut DevelopSettings, i: f64| s.light.exposure = 0.3 + i * 0.01;
    let grain = |s: &mut DevelopSettings, i: f64| s.effects.grain.amount = 20.0 + i;
    let threshold = |s: &mut DevelopSettings, i: f64| s.effects.halation.threshold = 40.0 + i;
    for (label, base, vary) in [
        ("every control, no effects: exposure drag", &none, &exposure as &dyn Fn(&mut DevelopSettings, f64)),
        ("every control + all effects: exposure drag (glow recomputed)", &all, &exposure),
        ("every control + all effects: grain amount drag", &all, &grain),
        ("every control + all effects: halation threshold drag (glow recomputed)", &all, &threshold),
    ] {
        let img = scene(1600, 1067);
        let (gm, gmin, gmax) = median(&Developer::new(img.clone()), base, RenderBackend::Gpu, vary);
        let (cm, _, _) = median(&Developer::new(img), base, RenderBackend::Cpu, vary);
        eprintln!("proxy 1600 px, {label}: GPU median {gm:.2} ms (min {gmin:.2}, max {gmax:.2}); CPU median {cm:.1} ms");
    }
}
