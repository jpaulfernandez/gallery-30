//! Workflow plan 24: the chroma filter and mask noise, CPU against GPU (the CPU is the reference; same tolerance as
//! `gpu.rs`: at most 2 levels per channel and 0.3 on average), the tiled GPU path, and the timing of a Colour slider
//! drag on a working-size image (the coarse coefficients are cached, so only the per-pixel pass reruns).
//! Without a GPU adapter the comparisons print `SKIP` and return.

use std::time::Instant;

use photobook_develop::gpu::{GpuContext, Tiling};
use photobook_develop::settings::{ChromaMode, Denoise, DenoiseModel};
use photobook_develop::{gpu, DevelopSettings, Developer, ImageMeta, LinearImage, RenderBackend, RenderOptions, Rgb8Image};

mod common;
use common::*;

fn have_gpu(test: &str) -> bool {
    if GpuContext::get().is_some() {
        return true;
    }
    eprintln!("SKIP {test}: no GPU adapter (or PHOTOBOOK_FORCE_CPU / crash flag); nothing was compared");
    false
}

fn options(backend: RenderBackend) -> RenderOptions {
    RenderOptions { backend, ..RenderOptions::default() }
}

/// The detail scene with blotchy chroma noise and fine luminance noise, σ known.
fn noisy_scene(w: u32, h: u32) -> LinearImage {
    noisy_scene_sigma(w, h, 0.006)
}

/// [`noisy_scene`] with the σ the filter keys on.
fn noisy_scene_sigma(w: u32, h: u32, sigma: f32) -> LinearImage {
    let base = scene(w, h);
    let mut data = Vec::with_capacity(base.data.len());
    for y in 0..h {
        for x in 0..w {
            let p = base.pixel(x, y);
            let (ca, cb) = (value_noise(x, y, 6.0, 3) - 0.5, value_noise(x, y, 6.0, 9) - 0.5);
            let l = hash(x, y, 17) - 0.5;
            let k = 0.25 * (p[0] + p[1] + p[2]) / 3.0 + 0.002;
            data.extend([
                p[0] + k * (0.5 * ca + 0.2 * l),
                p[1] + k * (0.2 * l - 0.3 * ca + 0.3 * cb),
                p[2] + k * (0.2 * l - 0.5 * cb),
            ]);
        }
    }
    LinearImage::new(w, h, data).with_meta(ImageMeta { noise_sigma: Some(sigma), ..ImageMeta::default() })
}

fn denoise(chroma: f64, mode: ChromaMode) -> Denoise {
    Denoise { model: DenoiseModel::NafnetW32, luminance: 50.0, chroma, sharpen: 25.0, chroma_mode: mode }
}

fn with_noise_mask(mut s: DevelopSettings, noise: f64) -> DevelopSettings {
    s.masks = vec![serde_json::from_value(serde_json::json!({
        "id": "m1",
        "name": "Noise",
        "components": [{ "id": "c1", "kind": "radial", "center": [0.4, 0.5], "radii": [0.3, 0.35], "angle": 0, "feather": 60 }],
        "adjustments": { "noise": noise }
    }))
    .unwrap()];
    s
}

/// CPU vs GPU tolerance for this pass: tighter than `gpu.rs` (the README's claim, "at most 1 level apart").
const MAX_LEVELS: u8 = 1;
const MAX_MEAN: f64 = 0.001;

fn diff(a: &Rgb8Image, b: &Rgb8Image) -> (u8, f64) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut max = 0;
    let mut sum = 0u64;
    for (x, y) in a.data.iter().zip(&b.data) {
        let d = x.abs_diff(*y);
        max = max.max(d);
        sum += d as u64;
    }
    (max, sum as f64 / a.data.len() as f64)
}

fn compare(name: &str, img: &LinearImage, s: &DevelopSettings) {
    let cpu = Developer::new(img.clone()).render_with(s, &options(RenderBackend::Cpu));
    let dev = Developer::new(img.clone());
    let gpu = dev.render_with(s, &options(RenderBackend::Gpu));
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu), "{name}: the GPU path did not run");
    let (max, mean) = diff(&cpu, &gpu);
    eprintln!("  {name:<36} max {max} mean {mean:.4}");
    assert!(max <= MAX_LEVELS && mean <= MAX_MEAN, "{name}: CPU vs GPU max {max} mean {mean}");
}

#[test]
fn the_filter_changes_the_render_and_model_mode_does_not() {
    let img = noisy_scene(320, 213);
    let dev = Developer::new(img.clone());
    let cpu = options(RenderBackend::Cpu);
    let mut s = DevelopSettings::default();
    s.detail.denoise = Some(denoise(75.0, ChromaMode::Model));
    let model = dev.render_with(&s, &cpu);
    s.detail.denoise = Some(denoise(0.0, ChromaMode::Filter));
    assert_eq!(dev.render_with(&s, &cpu), model, "Colour 0 in filter mode is a no-op");
    s.detail.denoise = Some(denoise(75.0, ChromaMode::Filter));
    assert_ne!(dev.render_with(&s, &cpu), model);
    // A mask's noise alone (denoise off) changes the pixels it covers only.
    let masked = dev.render_with(&with_noise_mask(DevelopSettings::default(), 80.0), &cpu);
    let plain = dev.render_with(&DevelopSettings::default(), &cpu);
    let px = |img: &Rgb8Image, x: u32, y: u32| img.data[((y * img.width + x) * 3) as usize..][..3].to_vec();
    assert_eq!(px(&masked, 2, 2), px(&plain, 2, 2), "outside the mask");
    assert_ne!(masked, plain);
}

#[test]
fn gpu_matches_cpu() {
    if !have_gpu("gpu_matches_cpu") {
        return;
    }
    let img = noisy_scene(640, 427);
    let mut s = DevelopSettings::default();
    s.detail.denoise = Some(denoise(75.0, ChromaMode::Filter));
    compare("chroma filter 75", &img, &s);
    s.detail.denoise = Some(denoise(100.0, ChromaMode::Filter));
    s.light.exposure = 0.4;
    s.light.shadows = 30.0;
    s.detail.clarity = 25.0;
    s.detail.dehaze = 10.0;
    compare("chroma filter 100 + tone + clarity", &img, &s);
    compare("+ mask noise 80", &img, &with_noise_mask(s.clone(), 80.0));
    let mut off = DevelopSettings::default();
    off.detail.denoise = Some(denoise(75.0, ChromaMode::Model));
    compare("mask noise only (model mode)", &img, &with_noise_mask(off, 100.0));
    // A crop and rotation: the pass runs on the warped input.
    let mut warped = s.clone();
    warped.geometry.crop = Some(serde_json::from_value(serde_json::json!({
        "rect": { "x": 0.1, "y": 0.1, "w": 0.8, "h": 0.75 },
        "angle": 3
    }))
    .unwrap());
    compare("chroma filter on a warp", &img, &warped);
}

#[test]
fn tiled_gpu_matches_cpu() {
    if !have_gpu("tiled_gpu_matches_cpu") {
        return;
    }
    let img = noisy_scene(900, 600);
    let s = with_noise_mask(
        DevelopSettings {
            detail: photobook_develop::settings::Detail {
                denoise: Some(denoise(80.0, ChromaMode::Filter)),
                ..Default::default()
            },
            ..DevelopSettings::default()
        },
        60.0,
    );
    let cpu = Developer::new(img.clone()).render_with(&s, &options(RenderBackend::Cpu));
    let tiled = gpu::render_tiled(&img, &s, Tiling::Size(256)).expect("GPU render");
    let (max, mean) = diff(&cpu, &tiled);
    eprintln!("  tiled 256: max {max} mean {mean:.4}");
    assert!(max <= MAX_LEVELS && mean <= MAX_MEAN, "tiled: max {max} mean {mean}");
}

/// The coarse grid at 1/2 and 1/4 of the resolution (`guided_subsample` 2 and 4) on an image whose width divides by
/// neither (partial cells at the right edge), whole and in 512 px tiles.
#[test]
fn subsampled_gpu_matches_cpu() {
    if !have_gpu("subsampled_gpu_matches_cpu") {
        return;
    }
    for (sigma, factor) in [(0.006f32, 2usize), (0.02, 4)] {
        let img = noisy_scene_sigma(1601, 1067, sigma);
        let key = photobook_develop::ops::noise::NoiseKey::new(sigma, true);
        assert_eq!(key.factor(1601, 1067), factor, "σ {sigma}");
        let mut s = DevelopSettings::default();
        s.detail.denoise = Some(denoise(80.0, ChromaMode::Filter));
        let s = with_noise_mask(s, 60.0);
        compare(&format!("1601 px, 1/{factor}, whole"), &img, &s);
        let cpu = Developer::new(img.clone()).render_with(&s, &options(RenderBackend::Cpu));
        let tiled = gpu::render_tiled(&img, &s, Tiling::Size(512)).expect("GPU render");
        let (max, mean) = diff(&cpu, &tiled);
        eprintln!("  1601 px, 1/{factor}, tiled 512           max {max} mean {mean:.4}");
        assert!(max <= MAX_LEVELS && mean <= MAX_MEAN, "1/{factor} tiled: max {max} mean {mean}");
    }
}

/// The Colour slider drag on a 1600 × 1067 working image: the first render computes the coarse coefficients, the
/// next ones only rerun the per-pixel passes. Prints the timings (CPU and, when present, GPU).
#[test]
fn colour_slider_drag_timing() {
    let img = noisy_scene(1600, 1067);
    for backend in [RenderBackend::Cpu, RenderBackend::Gpu] {
        if backend == RenderBackend::Gpu && GpuContext::get().is_none() {
            continue;
        }
        let dev = Developer::new(img.clone());
        let mut s = DevelopSettings::default();
        let mut times = Vec::new();
        for chroma in [40.0, 50.0, 60.0, 70.0, 80.0] {
            s.detail.denoise = Some(denoise(chroma, ChromaMode::Filter));
            let t = Instant::now();
            let _ = dev.render_with(&s, &options(backend));
            times.push(t.elapsed().as_secs_f64() * 1e3);
        }
        let mut base = s.clone();
        base.detail.denoise = Some(denoise(80.0, ChromaMode::Model));
        let t = Instant::now();
        let _ = dev.render_with(&base, &options(backend));
        let without = t.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "colour slider drag at 1600x1067 on {backend:?}: first {:.1} ms (coarse stage), then {:?} ms; \
             the same render without the filter {without:.1} ms",
            times[0],
            times[1..].iter().map(|t| (t * 10.0).round() / 10.0).collect::<Vec<_>>()
        );
    }
}
