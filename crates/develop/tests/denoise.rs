//! D5.1: tiled inference, the Oklab luminance/chroma blend and the 16-bit intermediate.
//!
//! `cargo test -p photobook-develop --test denoise` runs the offline tests (no models needed).
//! `cargo test -p photobook-develop --release --test denoise -- --ignored --nocapture` downloads NAFNet-SIDD-width32
//! (117 MB) and SCUNet (77 MB) when missing (into `PHOTOBOOK_MODELS_DIR`, default the editor's `<appdata>/models`),
//! then reports PSNR before/after on a synthetic noisy image, per-tile and 24 MP timings and a seam check.
#![cfg(feature = "ai")]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use photobook_develop::ai::denoise::{
    self, denoise_with, finish, read_intermediate, read_intermediate_fit, read_intermediate_meta, write_intermediate,
    DenoiseEngine, DenoiseOptions,
};
use photobook_develop::ai::merge;
use photobook_develop::ai::tiling::{blend_tiles, tile_plan, Blender, TilePlan};
use photobook_develop::ai::{download_model, status, ModelDir, ModelStatus};
use photobook_develop::color::camera::{CameraColor, CameraMatrix};
use photobook_develop::color::oklab::Oklab;
use photobook_develop::color::transfer::{linear_to_srgb, srgb_to_linear};
use photobook_develop::color::matrix;
use photobook_develop::settings::{ChromaMode, Denoise, DenoiseModel};
use photobook_develop::ops::noise::{chroma_filter_image, chroma_sigma};
use photobook_develop::{ImageMeta, LinearImage};

// ---------- helpers ----------

/// Run every tile of `plan` through `model` (planes in, planes out) and blend.
fn tiled(plan: &TilePlan, image: &[f32], model: impl Fn(usize, Vec<f32>) -> Vec<f32>) -> Vec<f32> {
    let outputs: Vec<Vec<f32>> =
        plan.tiles.iter().enumerate().map(|(i, t)| model(i, plan.extract(image, t, |p| p))).collect();
    blend_tiles(&outputs, plan)
}

fn interleaved(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 3]) -> Vec<f32> {
    let mut v = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&f(x, y));
        }
    }
    v
}

/// Max |second difference| along x over the given columns (each `x` with `x − 1` and `x + 1` inside).
fn max_second_diff_x(img: &[f32], w: usize, h: usize, cols: impl Iterator<Item = usize> + Clone) -> f32 {
    let mut m = 0.0f32;
    for y in 0..h {
        for x in cols.clone() {
            for c in 0..3 {
                let at = |x: usize| img[(y * w + x) * 3 + c];
                m = m.max((at(x + 1) - 2.0 * at(x) + at(x - 1)).abs());
            }
        }
    }
    m
}

/// Columns where a tile starts or ends (the blend's seams), inside `1..w-1`.
fn seam_columns(plan: &TilePlan) -> Vec<usize> {
    let mut cols: Vec<usize> = plan
        .tiles
        .iter()
        .flat_map(|t| [t.x, t.x + plan.overlap, t.x + t.size - plan.overlap, t.x + t.size])
        .filter(|&x| x >= 1 && x + 1 < plan.width)
        .collect();
    cols.sort_unstable();
    cols.dedup();
    cols
}

// ---------- tiling ----------

#[test]
fn a_constant_tiles_and_blends_back_exactly() {
    for (w, h) in [(1000, 700), (512, 512), (37, 600), (1300, 1300)] {
        let plan = tile_plan(w, h, 512, 48, 16);
        let img = interleaved(w, h, |_, _| [0.3, 0.71, 0.123_456_7]);
        let out = tiled(&plan, &img, |_, p| p);
        assert_eq!(out, img, "{w}x{h}: {} tiles", plan.tiles.len());
    }
}

#[test]
fn a_gradient_has_no_seams() {
    let (w, h) = (1500, 1100);
    let plan = tile_plan(w, h, 512, 48, 16);
    assert!(plan.tiles.len() >= 9);
    // A smooth 2D field: linear ramps plus a slow curve.
    let img = interleaved(w, h, |x, y| {
        let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
        [u, v, 0.5 + 0.4 * (3.0 * u + 2.0 * v).sin()]
    });
    let out = tiled(&plan, &img, |_, p| p);
    let max_err = out.iter().zip(&img).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(max_err < 1e-6, "identity tiling changed the image by {max_err}");
    let seams = seam_columns(&plan);
    let at_seams = max_second_diff_x(&out, w, h, seams.iter().copied());
    let interior = max_second_diff_x(&img, w, h, 1..w - 1);
    assert!(at_seams <= interior + 1e-6, "second difference at seams {at_seams} vs interior {interior}");
}

#[test]
fn per_tile_offsets_crossfade_smoothly() {
    // A model that shifts each tile by a different constant: the blend must turn every step into a ramp across the
    // overlap (no jump bigger than the offset spread over the ramp).
    let (w, h) = (1200, 600);
    let plan = tile_plan(w, h, 512, 48, 16);
    let img = vec![0.5f32; w * h * 3];
    let out = tiled(&plan, &img, |i, mut p| {
        let off = if i % 2 == 0 { 0.0 } else { 0.1 };
        p.iter_mut().for_each(|v| *v += off);
        p
    });
    let mut max_step = 0.0f32;
    for y in 0..h {
        for x in 1..w {
            max_step = max_step.max((out[(y * w + x) * 3] - out[(y * w + x - 1) * 3]).abs());
        }
    }
    // A raised cosine over 48 px has a steepest slope of π/2 / 48 per px of the offset.
    let bound = 0.1 * std::f32::consts::FRAC_PI_2 / 48.0 * 1.05;
    assert!(max_step <= bound, "step {max_step} > {bound}");
}

#[test]
fn the_streaming_blender_matches_the_batch_one_and_reflects_padding() {
    let (w, h) = (700, 530);
    let plan = tile_plan(w, h, 512, 48, 16);
    assert_eq!((plan.padded_width, plan.padded_height), (704, 544));
    let img = interleaved(w, h, |x, y| [x as f32 / 7.0, y as f32 / 5.0, ((x * y) % 13) as f32]);
    // The padding reflects the last row: padded row h + 2 reads image row h − 3.
    let last = plan.tiles.last().unwrap();
    let plane = plan.extract(&img, last, |p| p);
    let ty = h + 2 - last.y;
    let tx = 10;
    let n = last.size;
    assert_eq!(plane[ty * n + tx], img[((h - 3) * w + last.x + tx) * 3]);
    let mut blender = Blender::new(&plan);
    for (i, t) in plan.tiles.iter().enumerate() {
        blender.add(i, &plan.extract(&img, t, |p| p));
    }
    let a = blender.finish();
    assert!(a.iter().zip(&img).all(|(a, b)| (a - b).abs() <= b.abs() * 1e-6));
}

// ---------- the Oklab blend ----------

#[test]
fn luminance_zero_keeps_l_and_chroma_hundred_takes_ab() {
    let (w, h) = (64u32, 48u32);
    let input = LinearImage::new(w, h, interleaved(w as usize, h as usize, |x, y| {
        [0.05 + x as f32 / 80.0, 0.1 + y as f32 / 60.0, 0.3 + ((x + y) % 7) as f32 / 30.0]
    }));
    let output = LinearImage::new(w, h, interleaved(w as usize, h as usize, |x, y| {
        [0.2 + y as f32 / 90.0, 0.15 + x as f32 / 100.0, 0.25]
    }));
    let settings = Denoise {
        model: DenoiseModel::NafnetW32,
        luminance: 0.0,
        chroma: 100.0,
        sharpen: 0.0,
        chroma_mode: ChromaMode::Model,
    };
    let blended = finish(&input, output.clone(), &settings, &DenoiseOptions::default());
    let ok = Oklab::new();
    let mut worst = [0.0f32; 3];
    for i in 0..(w * h) as usize {
        let px = |img: &LinearImage| ok.to_lab([img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]]);
        let (b, inp, out) = (px(&blended), px(&input), px(&output));
        worst[0] = worst[0].max((b[0] - inp[0]).abs());
        worst[1] = worst[1].max((b[1] - out[1]).abs());
        worst[2] = worst[2].max((b[2] - out[2]).abs());
    }
    // Exact in Lab; what is left is the f32 Oklab → RGB → Oklab round trip.
    assert!(worst.iter().all(|&e| e < 2e-5), "{worst:?}");
    // And the per-pixel formula itself is exact.
    let lab = denoise::blend_lab([0.5, 0.1, -0.2], [0.4, -0.05, 0.03], 0.0, 1.0);
    assert_eq!(lab, [0.5, -0.05, 0.03]);
    let half = denoise::blend_lab([0.5, 0.1, -0.2], [0.3, 0.0, 0.0], 0.5, 0.25);
    assert!(half.iter().zip([0.4, 0.075, -0.15]).all(|(a, b)| (a - b).abs() < 1e-7), "{half:?}");
    // Luminance 100, chroma 100, no sharpening: the output itself.
    let full = Denoise { luminance: 100.0, ..settings };
    let same = finish(&input, output.clone(), &full, &DenoiseOptions::default());
    let err = same.data.iter().zip(&output.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(err < 1e-5, "{err}");
}

#[test]
fn sharpening_touches_edges_not_flat_areas() {
    let (w, h) = (200u32, 100u32);
    // A soft vertical edge on the left half, flat on the right.
    let img = LinearImage::new(w, h, interleaved(w as usize, h as usize, |x, _| {
        let v = if x < 50 { 0.1 } else if x < 54 { 0.1 + 0.15 * (x - 50) as f32 } else { 0.7 };
        [v, v, v]
    }));
    let settings = Denoise {
        model: DenoiseModel::NafnetW32,
        luminance: 100.0,
        chroma: 100.0,
        sharpen: 100.0,
        chroma_mode: ChromaMode::Model,
    };
    let out = finish(&img, img.clone(), &settings, &DenoiseOptions { reference_size: Some((1620, 1080)) });
    let changed = |x: u32| (out.pixel(x, 50)[0] - img.pixel(x, 50)[0]).abs();
    assert!(changed(49) > 1e-3 || changed(54) > 1e-3, "edge not sharpened");
    assert!(changed(150) < 1e-6, "flat area changed by {}", changed(150));
}

// ---------- workflow plan 25: the wavelet L merge ----------

/// The flat blend from before plan 25: `blend_lab` per pixel at the Luminance strength, no sharpening.
fn flat_finish(input: &LinearImage, output: &LinearImage, lum: f32, chroma: f32) -> LinearImage {
    let ok = Oklab::new();
    let data = input
        .data
        .chunks_exact(3)
        .zip(output.data.chunks_exact(3))
        .flat_map(|(i, o)| {
            ok.to_rgb(denoise::blend_lab(ok.to_lab([i[0], i[1], i[2]]), ok.to_lab([o[0], o[1], o[2]]), lum, chroma))
        })
        .collect();
    LinearImage::new(input.width, input.height, data).with_meta(input.meta.clone())
}

/// Luminance 100 (and 0) give the flat blend's result bit for bit, so PSNR at 100 is unchanged; at 50 the wavelet
/// merge leaves less of the noise than the flat blend (the coarse bands are the model's), so its PSNR is higher.
#[test]
fn luminance_100_is_the_flat_blend_bit_for_bit() {
    let (w, h) = (384usize, 256usize);
    let clean = clean_srgb(w, h);
    let noisy_srgb = noisy(&clean, w, h, 0.05, 11);
    let input = srgb_to_image(w, h, &noisy_srgb);
    // A perfect "model": the clean image.
    let output = srgb_to_image(w, h, &clean);
    for mode in [ChromaMode::Model, ChromaMode::Filter] {
        let chroma = if mode == ChromaMode::Model { 0.75 } else { 0.0 };
        let settings = |luminance: f64| Denoise {
            model: DenoiseModel::NafnetW32,
            luminance,
            chroma: 75.0,
            sharpen: 0.0,
            chroma_mode: mode,
        };
        for (lum, t) in [(100.0, 1.0), (0.0, 0.0)] {
            let ours = finish(&input, output.clone(), &settings(lum), &DenoiseOptions::default());
            let flat = flat_finish(&input, &output, t, chroma);
            assert_eq!(ours.data, flat.data, "{mode:?} luminance {lum}");
            assert_eq!(psnr(&image_to_srgb(&ours), &clean), psnr(&image_to_srgb(&flat), &clean));
        }
        let ours = finish(&input, output.clone(), &settings(50.0), &DenoiseOptions::default());
        let flat = flat_finish(&input, &output, 0.5, chroma);
        let (p_ours, p_flat) = (psnr(&image_to_srgb(&ours), &clean), psnr(&image_to_srgb(&flat), &clean));
        println!("{mode:?} luminance 50: PSNR wavelet {p_ours:.2} dB, flat {p_flat:.2} dB");
        assert!(p_ours > p_flat + 0.5, "{mode:?}: wavelet {p_ours} vs flat {p_flat}");
    }
}

// ---------- the intermediate ----------

#[test]
fn intermediate_png_round_trips_within_one_code() {
    let tmp = tempfile::tempdir().unwrap();
    let (w, h) = (97u32, 61u32);
    let img = LinearImage::new(w, h, interleaved(w as usize, h as usize, |x, y| {
        let u = x as f32 / (w - 1) as f32;
        let v = y as f32 / (h - 1) as f32;
        [srgb_to_linear(u), srgb_to_linear(v), srgb_to_linear((u * v).sqrt())]
    }));
    let path = tmp.path().join("develop").join(denoise::intermediate_name("k1"));
    let meta = write_intermediate(&path, &img, "k1").unwrap();
    assert_eq!((meta.width, meta.height, meta.scale), (w, h, 1.0));
    assert!(denoise::intermediate_ready(&path, "k1"));
    assert!(!denoise::intermediate_ready(&path, "k2"));
    let back = read_intermediate(&path).unwrap();
    assert_eq!((back.width, back.height), (w, h));
    let worst = back
        .data
        .iter()
        .zip(&img.data)
        .map(|(a, b)| (linear_to_srgb(*a) - linear_to_srgb(*b)).abs())
        .fold(0.0f32, f32::max);
    assert!(worst <= 1.0 / 65535.0, "max encoded error {worst} (> 1/65535)");
    assert_eq!(back.meta, ImageMeta::default());
    // The PNG carries an ICC profile and decodes through the normal path too (Rec.2020 + sRGB curve).
    let decoded = photobook_develop::decode_file(&path, None).unwrap();
    let err = decoded.data.iter().zip(&img.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
    assert!(err < 2e-3, "decode_file of the intermediate is off by {err}");
    // Downscaled for the proxy.
    let small = read_intermediate_fit(&path, Some(48)).unwrap();
    assert_eq!((small.width, small.height), (48, 30));
}

#[test]
fn intermediate_keeps_highlights_and_raw_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let (w, h) = (16u32, 8u32);
    let img = LinearImage::new(w, h, interleaved(w as usize, h as usize, |x, _| [x as f32 * 0.25, 0.5, 0.01]));
    let camera = CameraColor {
        matrices: vec![CameraMatrix { temperature: 6500.0, xyz_to_camera: [[1.0, 0.1, 0.0], [0.0, 0.9, 0.1], [0.0, 0.0, 1.2]] }],
        as_shot_neutral: [0.5, 1.0, 0.7],
    };
    let img = img.with_meta(ImageMeta { is_raw: true, as_shot: Some((5200.0, 3.0)), camera: Some(Arc::new(camera)), noise_sigma: None });
    let path = tmp.path().join("denoise-k.png");
    let meta = write_intermediate(&path, &img, "k").unwrap();
    assert_eq!(meta.scale, 3.75);
    let back = read_intermediate(&path).unwrap();
    assert_eq!(back.meta, img.meta);
    for (a, b) in back.data.iter().zip(&img.data) {
        assert!((a - b).abs() <= b.abs() * 2e-3 + 1e-5, "{a} vs {b}");
    }
    assert_eq!(read_intermediate_meta(&path).unwrap().key, "k");
}

#[test]
fn a_failed_intermediate_write_leaves_no_file() {
    let names = |dir: &std::path::Path| -> Vec<String> {
        let mut names: Vec<_> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    };
    let img = LinearImage::new(8, 4, vec![0.25; 8 * 4 * 3]);
    // The PNG cannot be renamed into place (a folder is in the way): no temp file is left.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("denoise-k.png");
    std::fs::create_dir_all(path.join("taken")).unwrap();
    assert!(write_intermediate(&path, &img, "k").is_err());
    assert_eq!(names(tmp.path()), vec!["denoise-k.png"]);
    // The sidecar cannot be renamed into place: the PNG it would have marked complete goes too.
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("denoise-k.png");
    std::fs::create_dir_all(denoise::sidecar_path(&path).join("taken")).unwrap();
    assert!(write_intermediate(&path, &img, "k").is_err());
    assert_eq!(names(tmp.path()), vec!["denoise-k.json"]);
    assert!(!denoise::intermediate_ready(&path, "k"));
}

// ---------- end to end with the real models (ignored) ----------

fn models_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PHOTOBOOK_MODELS_DIR") {
        return dir.into();
    }
    let home = std::env::var_os("HOME").expect("HOME");
    PathBuf::from(home).join("Library/Application Support/com.photobook.editor/models")
}

fn ensure_installed(model: DenoiseModel, dir: &ModelDir) {
    let entry = denoise::model_entry(model).unwrap();
    if status(entry, dir) == ModelStatus::Installed {
        return;
    }
    let start = Instant::now();
    download_model(entry, dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    println!("downloaded {} ({} bytes) in {:.1} s", entry.name, entry.total_bytes(), start.elapsed().as_secs_f64());
}

/// xorshift64* and Box–Muller.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn gauss(&mut self) -> f32 {
        let (u, v) = (self.next().max(1e-12), self.next());
        ((-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()) as f32
    }
}

/// The clean scene, sRGB-encoded 0..1: a colour gradient with discs, stripes and a flat sky band on top.
fn clean_srgb(w: usize, h: usize) -> Vec<f32> {
    interleaved(w, h, |x, y| {
        let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
        if v < 0.25 {
            return [0.45, 0.62, 0.85]; // flat sky
        }
        let mut p = [0.2 + 0.6 * u, 0.3 + 0.4 * v, 0.6 - 0.4 * u * v];
        let s = (h as f32 / 8.0).max(8.0);
        let (cx, cy) = ((x as f32 / s).fract() - 0.5, (y as f32 / s).fract() - 0.5);
        if cx * cx + cy * cy < 0.09 {
            p = [0.85 - 0.5 * v, 0.25, 0.2 + 0.3 * u];
        }
        if (x / 3) % 2 == 0 && u > 0.8 {
            p = p.map(|c| c * 0.6);
        }
        p
    })
}

/// Luminance noise σ `sigma` per channel plus blotchy chroma noise (σ 0.03, blurred over ~3 px), sRGB-encoded.
fn noisy(clean: &[f32], w: usize, h: usize, sigma: f32, seed: u64) -> Vec<f32> {
    let mut rng = Rng(seed);
    let mut chroma: Vec<Vec<f32>> = (0..2).map(|_| (0..w * h).map(|_| rng.gauss()).collect()).collect();
    for plane in &mut chroma {
        photobook_develop::local::gaussian_blur(plane, w, h, 3.0);
        // Back to unit variance after the blur (σ 3 px keeps about 1/(2√π·3) of it).
        let k = (2.0 * std::f32::consts::PI.sqrt() * 3.0).sqrt();
        plane.iter_mut().for_each(|v| *v *= k * 0.03);
    }
    let mut out = clean.to_vec();
    for i in 0..w * h {
        let l = rng.gauss() * sigma;
        let (ca, cb) = (chroma[0][i], chroma[1][i]);
        let d = [l + ca, l - 0.5 * ca + cb, l - cb];
        for c in 0..3 {
            out[i * 3 + c] = (out[i * 3 + c] + d[c] + rng.gauss() * sigma * 0.3).clamp(0.0, 1.0);
        }
    }
    out
}

fn srgb_to_image(w: usize, h: usize, srgb: &[f32]) -> LinearImage {
    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    let data = srgb
        .chunks_exact(3)
        .flat_map(|p| matrix::apply_f32(&m, srgb_to_linear(p[0]), srgb_to_linear(p[1]), srgb_to_linear(p[2])))
        .collect();
    LinearImage::new(w as u32, h as u32, data)
}

fn image_to_srgb(img: &LinearImage) -> Vec<f32> {
    let m = matrix::to_f32(&matrix::rec2020_to_srgb());
    img.data
        .chunks_exact(3)
        .flat_map(|p| matrix::apply_f32(&m, p[0], p[1], p[2]).map(|v| linear_to_srgb(v.clamp(0.0, 1.0))))
        .collect()
}

fn psnr(a: &[f32], b: &[f32]) -> f64 {
    let mse = a.iter().zip(b).map(|(x, y)| ((x - y) as f64).powi(2)).sum::<f64>() / a.len() as f64;
    10.0 * (1.0 / mse).log10()
}

fn load(model: DenoiseModel, dir: &ModelDir) -> DenoiseEngine {
    let entry = denoise::model_entry(model).unwrap();
    let start = Instant::now();
    // PHOTOBOOK_DENOISE_CPU=1 forces the CPU EP (to compare with CoreML's fp16 compute).
    let engine = if std::env::var_os("PHOTOBOOK_DENOISE_CPU").is_some() {
        let opts = photobook_develop::ai::SessionOptions::for_model(entry, dir).cpu();
        DenoiseEngine::load_with(entry, dir, &opts).unwrap()
    } else {
        DenoiseEngine::load(entry, dir).unwrap()
    };
    let info = engine.session().info();
    println!(
        "{}: {} in {:.1} s; input {:?}; unsupported ops {:?}",
        entry.name,
        info.provider_summary(),
        start.elapsed().as_secs_f64(),
        info.inputs,
        info.unsupported_ops
    );
    engine
}

/// `PHOTOBOOK_DENOISE_MODELS=nafnet|scunet|all` picks the models of the ignored runs (default: `default`).
/// σ of `image` as the editor keys the filter on it: plan 23's measurement, quantised.
fn measured_sigma(image: &LinearImage) -> f32 {
    let fit = photobook_develop::ai::noise_profile::measure(image);
    chroma_sigma(Some(fit.sigma), None)
}

/// RMS of the Oklab a/b difference between two images.
fn chroma_rms(a: &LinearImage, b: &LinearImage) -> f64 {
    let ok = Oklab::new();
    let sum: f64 = a
        .data
        .chunks_exact(3)
        .zip(b.data.chunks_exact(3))
        .map(|(p, q)| {
            let (p, q) = (ok.to_lab([p[0], p[1], p[2]]), ok.to_lab([q[0], q[1], q[2]]));
            ((p[1] - q[1]) as f64).powi(2) + ((p[2] - q[2]) as f64).powi(2)
        })
        .sum();
    (sum / (a.data.len() / 3) as f64).sqrt()
}

/// Workflow plan 24 without a model: the chroma filter alone (guide = the input's L, as the preview before the model
/// has run) removes most of the synthetic blotchy chroma noise, raises PSNR, and runs in interactive time on a
/// 1600 px image.
#[test]
fn the_chroma_filter_alone_removes_chroma_noise() {
    let (w, h) = (1536usize, 1024usize);
    let clean = clean_srgb(w, h);
    let noisy_srgb = noisy(&clean, w, h, 0.01, 42);
    let input = srgb_to_image(w, h, &noisy_srgb);
    let clean_img = srgb_to_image(w, h, &clean);
    let sigma = measured_sigma(&input);
    let t = Instant::now();
    let out = chroma_filter_image(&input, sigma, 1.0, None);
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let out_srgb = image_to_srgb(&out);
    let (before, after) = (chroma_rms(&input, &clean_img), chroma_rms(&out, &clean_img));
    println!(
        "σ {sigma}: PSNR {:.2} → {:.2} dB, a/b RMS {before:.4} → {after:.4}, {ms:.0} ms",
        psnr(&noisy_srgb, &clean),
        psnr(&out_srgb, &clean)
    );
    // The synthetic scene is mostly edges (a disc every 128 px, 3 px stripes), where the filter steps back.
    assert!(after < before * 0.85, "a/b RMS {before} -> {after}");
    assert!(psnr(&out_srgb, &clean) > psnr(&noisy_srgb, &clean) + 1.0);
}

fn models_to_run(default: &[DenoiseModel]) -> Vec<DenoiseModel> {
    match std::env::var("PHOTOBOOK_DENOISE_MODELS").as_deref() {
        Ok("all") => vec![DenoiseModel::NafnetW32, DenoiseModel::Scunet],
        Ok("scunet") => vec![DenoiseModel::Scunet],
        Ok("nafnet") => vec![DenoiseModel::NafnetW32],
        _ => default.to_vec(),
    }
}

#[test]
#[ignore = "downloads ~194 MB of models and runs them; use --release --nocapture"]
fn denoise_end_to_end_with_nafnet_and_scunet() {
    let dir = ModelDir::new(models_dir());
    let settings = |model| Denoise { model, luminance: 100.0, chroma: 100.0, sharpen: 0.0, chroma_mode: ChromaMode::Model };
    let (w, h) = (1536usize, 1024usize);
    let clean = clean_srgb(w, h);
    let noisy_srgb = noisy(&clean, w, h, 0.05, 42);
    let input = srgb_to_image(w, h, &noisy_srgb);
    let sigma = measured_sigma(&input);
    println!(
        "noisy input: PSNR {:.2} dB against the clean image ({w}x{h}); measured σ {sigma} ({:.2} % of mid-grey)",
        psnr(&noisy_srgb, &clean),
        sigma / 0.18 * 100.0
    );
    let never = AtomicBool::new(false);
    for model in models_to_run(&[DenoiseModel::NafnetW32, DenoiseModel::Scunet]) {
        ensure_installed(model, &dir);
        let engine = load(model, &dir);
        let warm = engine.session().warm_up(2).unwrap();
        println!("  warm-up run {:.0} ms", warm.as_secs_f64() * 1e3);
        let (out, stats) =
            denoise_with(&engine, &input, &settings(model), &DenoiseOptions::default(), &|_, _| {}, &never).unwrap();
        let out_srgb = image_to_srgb(&out);
        // Workflow plan 24: the same run with `chromaMode: filter` (the model's L, the classical filter's a/b, applied
        // as the render does) must be at least as good as the model's own colour.
        let filter = Denoise { chroma_mode: ChromaMode::Filter, ..settings(model) };
        let (l_only, _) = denoise_with(&engine, &input, &filter, &DenoiseOptions::default(), &|_, _| {}, &never).unwrap();
        let t = Instant::now();
        let filtered = chroma_filter_image(&l_only, sigma, 1.0, None);
        let filter_ms = t.elapsed().as_secs_f64() * 1e3;
        let filtered_srgb = image_to_srgb(&filtered);
        println!(
            "  chroma model: PSNR {:.2} dB; chroma filter: PSNR {:.2} dB (filter {filter_ms:.0} ms on the CPU); \
             a/b RMS error vs clean: model {:.4}, filter {:.4}",
            psnr(&out_srgb, &clean),
            psnr(&filtered_srgb, &clean),
            chroma_rms(&out, &srgb_to_image(w, h, &clean)),
            chroma_rms(&filtered, &srgb_to_image(w, h, &clean)),
        );
        assert!(
            psnr(&filtered_srgb, &clean) >= psnr(&out_srgb, &clean) - 0.05,
            "{model:?}: the chroma filter is worse than the model's colour"
        );
        let mut times: Vec<f64> = stats.tile_times.iter().map(|d| d.as_secs_f64() * 1e3).collect();
        times.sort_by(f64::total_cmp);
        println!(
            "  {} tiles of {}: PSNR {:.2} dB after (noisy {:.2}); tile median {:.0} ms (min {:.0}, max {:.0}); \
             inference {:.2} s, post {:.0} ms, total {:.2} s",
            stats.tiles,
            stats.tile_size,
            psnr(&out_srgb, &clean),
            psnr(&noisy_srgb, &clean),
            times[times.len() / 2],
            times[0],
            times[times.len() - 1],
            stats.inference.as_secs_f64(),
            stats.post.as_secs_f64() * 1e3,
            stats.total.as_secs_f64()
        );
        assert!(psnr(&out_srgb, &clean) > psnr(&noisy_srgb, &clean) + 3.0, "{model:?} did not denoise");
        // The partial blends: luminance 30 / chroma 75 keeps some grain.
        let partial = Denoise { model, luminance: 30.0, chroma: 75.0, sharpen: 25.0, chroma_mode: ChromaMode::Model };
        let (p, _) = denoise_with(&engine, &input, &partial, &DenoiseOptions::default(), &|_, _| {}, &never).unwrap();
        println!("  luminance 30 / chroma 75 / sharpen 25: PSNR {:.2} dB", psnr(&image_to_srgb(&p), &clean));

        // Seams at 200 % on the flat sky band (top quarter): across every tile edge the mean of a column must not
        // step by more than one 8-bit level compared with the column before it.
        let plan = tile_plan(w, h, engine.tile, denoise::TILE_OVERLAP, denoise::TILE_MULTIPLE);
        let sky_rows = 16..h / 4 - 16;
        let col_mean = |x: usize, c: usize| {
            sky_rows.clone().map(|y| out_srgb[(y * w + x) * 3 + c] as f64).sum::<f64>() / sky_rows.len() as f64
        };
        let mut worst_seam = 0.0f64;
        for x in seam_columns(&plan) {
            for c in 0..3 {
                worst_seam = worst_seam.max((col_mean(x, c) - col_mean(x - 1, c)).abs() * 255.0);
            }
        }
        let mut worst_px = 0.0f32;
        for y in sky_rows.clone() {
            for x in seam_columns(&plan) {
                for c in 0..3 {
                    let d = (out_srgb[(y * w + x) * 3 + c] - out_srgb[(y * w + x - 1) * 3 + c]).abs() * 255.0;
                    worst_px = worst_px.max(d);
                }
            }
        }
        let mut interior_px = 0.0f32;
        for y in sky_rows.clone() {
            for x in [100usize, 250, 700, 900] {
                for c in 0..3 {
                    let d = (out_srgb[(y * w + x) * 3 + c] - out_srgb[(y * w + x - 1) * 3 + c]).abs() * 255.0;
                    interior_px = interior_px.max(d);
                }
            }
        }
        println!(
            "  seams on the flat sky: column-mean step {worst_seam:.3} levels; max pixel step at seams {worst_px:.2} \
             vs {interior_px:.2} in tile interiors"
        );
        assert!(worst_seam <= 1.0, "visible seam: {worst_seam} levels");
    }
}

#[test]
#[ignore = "needs the NAFNet model; 24 MP timing; use --release --nocapture"]
fn denoise_24_megapixels_timing() {
    let dir = ModelDir::new(models_dir());
    let (w, h) = (6000usize, 4000usize);
    let clean = clean_srgb(w, h);
    let input = srgb_to_image(w, h, &noisy(&clean, w, h, 0.05, 7));
    drop(clean);
    for model in models_to_run(&[DenoiseModel::NafnetW32]) {
        ensure_installed(model, &dir);
        let engine = load(model, &dir);
        engine.session().warm_up(2).unwrap();
        let settings = Denoise { model, luminance: 50.0, chroma: 75.0, sharpen: 25.0, chroma_mode: ChromaMode::Filter };
        let last = std::sync::Mutex::new(Instant::now());
        let (out, stats) = denoise_with(
            &engine,
            &input,
            &settings,
            &DenoiseOptions::default(),
            &|done, total| {
                let mut t = last.lock().unwrap();
                if done % 20 == 0 || done == total {
                    println!("  {done}/{total} tiles");
                }
                *t = Instant::now();
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut times: Vec<f64> = stats.tile_times.iter().map(|d| d.as_secs_f64() * 1e3).collect();
        times.sort_by(f64::total_cmp);
        println!(
            "{model:?} 24 MP ({w}x{h}): {} tiles, median tile {:.0} ms, inference {:.2} s, blend+sharpen {:.2} s, \
             total {:.2} s",
            stats.tiles,
            times[times.len() / 2],
            stats.inference.as_secs_f64(),
            stats.post.as_secs_f64(),
            stats.total.as_secs_f64()
        );
        let t = Instant::now();
        let filtered = chroma_filter_image(&out, 0.004, 0.75, None);
        println!("  chroma filter at 24 MP (CPU): {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
        drop(filtered);
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("denoise-k.png");
        let t = Instant::now();
        write_intermediate(&path, &out, "k").unwrap();
        let write = t.elapsed();
        let bytes = std::fs::metadata(&path).unwrap().len();
        let t = Instant::now();
        let back = read_intermediate_fit(&path, Some(1600)).unwrap();
        println!(
            "  intermediate: {:.1} MB, write {:.2} s, read + 1600 px resize {:.2} s ({}x{})",
            bytes as f64 / 1e6,
            write.as_secs_f64(),
            t.elapsed().as_secs_f64(),
            back.width,
            back.height
        );
    }
}

// ---------- workflow plan 24: crop compare on a real high-ISO JPEG (ignored) ----------

/// Mean Oklab chroma of `img` after a Gaussian blur of σ 8 px per channel: the low-frequency colour, which noise
/// barely moves and a denoiser that washes colour out lowers ("desaturated patches").
fn low_frequency_chroma(img: &LinearImage) -> f64 {
    let (w, h) = (img.width as usize, img.height as usize);
    let mut planes: Vec<Vec<f32>> = (0..3).map(|c| img.data.iter().skip(c).step_by(3).copied().collect()).collect();
    for p in &mut planes {
        photobook_develop::local::gaussian_blur(p, w, h, 8.0);
    }
    let ok = Oklab::new();
    (0..w * h).map(|i| ok.to_lab([planes[0][i], planes[1][i], planes[2][i]])).map(|l| l[1].hypot(l[2]) as f64).sum::<f64>()
        / (w * h) as f64
}

/// `PHOTOBOOK_P24_RAW=<an ISO 12800 RAW> PHOTOBOOK_P24_OUT=<dir> cargo test -p photobook-develop --release --test
/// denoise iso12800 -- --ignored --nocapture`: makes a camera-like JPEG of the RAW (default develop with the look,
/// quality 90, 4:2:0), then for three crops writes `crop-<n>.jpg` with four panels side by side (the JPEG, NAFNet
/// with its own colour at Colour 75, NAFNet with the chroma filter at Colour 75, and the chroma filter alone on the
/// JPEG) and prints the low-frequency chroma of each panel.
#[test]
#[ignore = "needs a RAW sample and the NAFNet model; writes crop compare images"]
fn iso12800_crop_compare() {
    use photobook_develop::{decode_file, encode_jpeg, render_full, DevelopSettings, Developer, RenderOptions};
    let (Some(raw), Some(out)) = (std::env::var_os("PHOTOBOOK_P24_RAW"), std::env::var_os("PHOTOBOOK_P24_OUT")) else {
        eprintln!("SKIP: set PHOTOBOOK_P24_RAW and PHOTOBOOK_P24_OUT");
        return;
    };
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).unwrap();
    let decoded = decode_file(std::path::Path::new(&raw), None).unwrap();
    let mut settings = DevelopSettings::default();
    settings.light.exposure = 0.0;
    let camera = render_full(&decoded, &settings).unwrap();
    drop(decoded);
    let jpeg_path = out.join("iso12800.jpg");
    std::fs::write(&jpeg_path, encode_jpeg(&camera, 90).unwrap()).unwrap();
    let full = decode_file(&jpeg_path, None).unwrap();
    let sigma = measured_sigma(&decode_file(&jpeg_path, Some(1600)).unwrap());
    println!("camera-like JPEG {}x{}: σ {sigma} ({:.2} % of mid-grey)", full.width, full.height, sigma / 0.18 * 100.0);
    let dir = ModelDir::new(models_dir());
    ensure_installed(DenoiseModel::NafnetW32, &dir);
    let engine = load(DenoiseModel::NafnetW32, &dir);
    let never = AtomicBool::new(false);
    let reference = Some((full.width, full.height));
    let model = Denoise { model: DenoiseModel::NafnetW32, luminance: 50.0, chroma: 75.0, sharpen: 25.0, chroma_mode: ChromaMode::Model };
    let filter = Denoise { chroma_mode: ChromaMode::Filter, ..model.clone() };
    let size = 640u32;
    for (n, (cx, cy)) in [(0.5f32, 0.5f32), (0.25, 0.35), (0.75, 0.7)].into_iter().enumerate() {
        let (x0, y0) = (
            ((cx * full.width as f32) as u32).saturating_sub(size / 2).min(full.width - size),
            ((cy * full.height as f32) as u32).saturating_sub(size / 2).min(full.height - size),
        );
        let mut data = Vec::with_capacity((size * size * 3) as usize);
        for y in y0..y0 + size {
            data.extend_from_slice(&full.row(y)[x0 as usize * 3..(x0 + size) as usize * 3]);
        }
        let crop = LinearImage::new(size, size, data);
        let opts = DenoiseOptions { reference_size: reference };
        let (m, _) = denoise_with(&engine, &crop, &model, &opts, &|_, _| {}, &never).unwrap();
        let (l, _) = denoise_with(&engine, &crop, &filter, &opts, &|_, _| {}, &never).unwrap();
        let f = chroma_filter_image(&l, sigma, 0.75, reference);
        let alone = chroma_filter_image(&crop, sigma, 0.75, reference);
        let panels = [&crop, &m, &f, &alone];
        let rendered: Vec<_> = panels.iter().map(|p| Developer::new((*p).clone()).render_with(&DevelopSettings::default(), &RenderOptions::default())).collect();
        let mut strip = vec![0u8; (size * 4 * size * 3) as usize];
        for (k, r) in rendered.iter().enumerate() {
            for y in 0..size as usize {
                let dst = (y * size as usize * 4 + k * size as usize) * 3;
                strip[dst..dst + size as usize * 3].copy_from_slice(&r.data[y * size as usize * 3..(y + 1) * size as usize * 3]);
            }
        }
        let path = out.join(format!("crop-{}.jpg", n + 1));
        std::fs::write(&path, encode_jpeg(&photobook_develop::Rgb8Image::new(size * 4, size, strip), 92).unwrap()).unwrap();
        println!(
            "crop {} at ({x0}, {y0}): low-frequency chroma JPEG {:.4}, model {:.4}, NAFNet + filter {:.4}, filter alone {:.4} -> {}",
            n + 1,
            low_frequency_chroma(&crop),
            low_frequency_chroma(&m),
            low_frequency_chroma(&f),
            low_frequency_chroma(&alone),
            path.display()
        );
    }
}

// ---------- workflow plan 25: grain at Luminance 50 on a real ISO 6400 JPEG (ignored) ----------

/// RMS of the finest à trous band of Oklab L (the grain), of the two coarser bands (blotches) and of the whole of what
/// `img` has on top of `base` (the model's full-strength result).
fn l_band_rms(img: &LinearImage, base: &LinearImage) -> (f64, f64, f64) {
    let (w, h) = (img.width as usize, img.height as usize);
    let ok = Oklab::new();
    let l = |img: &LinearImage| -> Vec<f32> { img.data.chunks_exact(3).map(|p| ok.to_lab([p[0], p[1], p[2]])[0]).collect() };
    let left: Vec<f32> = l(img).iter().zip(l(base)).map(|(a, b)| a - b).collect();
    let d = merge::decompose(&left, w, h);
    let rms = |v: &[f32]| (v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
    let coarse: Vec<f32> = d.bands[1].iter().zip(&d.bands[2]).map(|(a, b)| a + b).collect();
    (rms(&d.bands[0]), rms(&coarse), rms(&left))
}

/// `PHOTOBOOK_P25_JPEG=<an ISO 6400 camera JPEG> PHOTOBOOK_P25_OUT=<dir> cargo test -p photobook-develop --test denoise
/// iso6400 -- --ignored --nocapture`: for three 384 px crops writes `crop-<n>.jpg` (four panels: the JPEG, the flat
/// blend at Luminance 50, the wavelet merge at Luminance 50, the model at 100; all with the chroma filter at Colour 75
/// as the render applies it, no sharpening) and `crop-<n>-2x.jpg` (the middle 192 px of each panel at 200 %), and
/// prints the RMS of the finest and the coarser bands of L left on top of the model's result per panel.
#[test]
#[ignore = "needs an ISO 6400 JPEG and the NAFNet model; writes crop compare images"]
fn iso6400_grain_crop_compare() {
    use photobook_develop::{decode_file, encode_jpeg, DevelopSettings, Developer, RenderOptions, Rgb8Image};
    let (Some(jpeg), Some(out)) = (std::env::var_os("PHOTOBOOK_P25_JPEG"), std::env::var_os("PHOTOBOOK_P25_OUT")) else {
        eprintln!("SKIP: set PHOTOBOOK_P25_JPEG and PHOTOBOOK_P25_OUT");
        return;
    };
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).unwrap();
    let full = decode_file(std::path::Path::new(&jpeg), None).unwrap();
    let sigma = measured_sigma(&decode_file(std::path::Path::new(&jpeg), Some(1600)).unwrap());
    println!("{}x{}: σ {sigma} ({:.2} % of mid-grey)", full.width, full.height, sigma / 0.18 * 100.0);
    let dir = ModelDir::new(models_dir());
    ensure_installed(DenoiseModel::NafnetW32, &dir);
    let engine = load(DenoiseModel::NafnetW32, &dir);
    let never = AtomicBool::new(false);
    let reference = Some((full.width, full.height));
    let at = |luminance: f64| Denoise {
        model: DenoiseModel::NafnetW32,
        luminance,
        chroma: 75.0,
        sharpen: 0.0,
        chroma_mode: ChromaMode::Filter,
    };
    let size = 384u32;
    let render = |img: &LinearImage| Developer::new(img.clone()).render_with(&DevelopSettings::default(), &RenderOptions::default());
    for (n, (cx, cy)) in [(0.5f32, 0.5f32), (0.3, 0.4), (0.7, 0.65)].into_iter().enumerate() {
        let (x0, y0) = (
            ((cx * full.width as f32) as u32).saturating_sub(size / 2).min(full.width - size),
            ((cy * full.height as f32) as u32).saturating_sub(size / 2).min(full.height - size),
        );
        let mut data = Vec::with_capacity((size * size * 3) as usize);
        for y in y0..y0 + size {
            data.extend_from_slice(&full.row(y)[x0 as usize * 3..(x0 + size) as usize * 3]);
        }
        let crop = LinearImage::new(size, size, data);
        let (raw, _) = denoise::infer(&engine, &crop, &|_, _| {}, &never).unwrap();
        let opts = DenoiseOptions { reference_size: reference };
        let flat = flat_finish(&crop, &raw, 0.5, 0.0);
        let wavelet = finish(&crop, raw.clone(), &at(50.0), &opts);
        let model = finish(&crop, raw, &at(100.0), &opts);
        let colour = |img: &LinearImage| chroma_filter_image(img, sigma, 0.75, reference);
        let panels = [crop.clone(), colour(&flat), colour(&wavelet), colour(&model)];
        let bands: Vec<(f64, f64, f64)> = panels.iter().map(|p| l_band_rms(p, &panels[3])).collect();
        let rendered: Vec<Rgb8Image> = panels.iter().map(render).collect();
        let s = size as usize;
        let mut strip = vec![0u8; s * 4 * s * 3];
        for (k, r) in rendered.iter().enumerate() {
            for y in 0..s {
                let dst = (y * s * 4 + k * s) * 3;
                strip[dst..dst + s * 3].copy_from_slice(&r.data[y * s * 3..(y + 1) * s * 3]);
            }
        }
        let path = out.join(format!("crop-{}.jpg", n + 1));
        std::fs::write(&path, encode_jpeg(&Rgb8Image::new(size * 4, size, strip), 95).unwrap()).unwrap();
        // The middle half of each panel at 200 % (nearest neighbour), side by side.
        let half = s / 2;
        let off = s / 4;
        let mut zoom = vec![0u8; (half * 2 * 4) * (half * 2) * 3];
        let zw = half * 2 * 4;
        for (k, r) in rendered.iter().enumerate() {
            for y in 0..half * 2 {
                for x in 0..half * 2 {
                    let src = ((off + y / 2) * s + off + x / 2) * 3;
                    let dst = (y * zw + k * half * 2 + x) * 3;
                    zoom[dst..dst + 3].copy_from_slice(&r.data[src..src + 3]);
                }
            }
        }
        let zpath = out.join(format!("crop-{}-2x.jpg", n + 1));
        std::fs::write(&zpath, encode_jpeg(&Rgb8Image::new(zw as u32, (half * 2) as u32, zoom), 95).unwrap()).unwrap();
        println!(
            "crop {} at ({x0}, {y0}): L over the model's, finest-band / coarse-band / total RMS: JPEG {:.5} / {:.5} / \
             {:.5}, flat 50 {:.5} / {:.5} / {:.5}, wavelet 50 {:.5} / {:.5} / {:.5} -> {}, {}",
            n + 1,
            bands[0].0,
            bands[0].1,
            bands[0].2,
            bands[1].0,
            bands[1].1,
            bands[1].2,
            bands[2].0,
            bands[2].1,
            bands[2].2,
            path.display(),
            zpath.display()
        );
    }
}

/// `cargo test -p photobook-develop --release --test denoise merge_timing -- --ignored --nocapture`: the L merge on a
/// 6000 × 4000 plane at Luminance 50 (one level) and at Luminance 5 (three levels and the residual; workflow plan 25).
#[test]
#[ignore = "24 MP timing; use --release --nocapture"]
fn merge_timing_24_megapixels() {
    let (w, h) = (6000usize, 4000usize);
    let mut rng = Rng(3);
    let l_out: Vec<f32> = (0..w * h).map(|i| 0.3 + 0.4 * ((i % w) as f32 / w as f32)).collect();
    let l_in: Vec<f32> = l_out.iter().map(|v| v + 0.02 * rng.gauss()).collect();
    for t in [0.5f32, 0.05] {
        let weights = merge::BandWeights::for_luminance(t);
        let start = Instant::now();
        let merged = merge::merge_l(&l_in, l_out.clone(), w, h, &weights);
        println!("luminance {}: {} level(s), {:.0} ms", t * 100.0, weights.levels(), start.elapsed().as_secs_f64() * 1e3);
        assert!(merged.iter().all(|v| v.is_finite()));
    }
}

// ---------- workflow plan 26: denoise model evaluation (ignored) ----------
//
// `docs/design/DENOISE_EVAL.md` describes the method and records the results. All three runs are env-driven, write
// into `PHOTOBOOK_P26_OUT` and need `--release --nocapture`:
//
// - `p26_coreml_partitions_and_timing`: `PHOTOBOOK_P26_ONNX=name=path,...` loads each ONNX file with CoreML (or the
//   CPU with `PHOTOBOOK_DENOISE_CPU=1`), prints the partition count and the ops left on the CPU, times tiles and
//   extrapolates to 24 MP (6000 × 4000).
// - `p26_psnr_simulated`: `PHOTOBOOK_P26_CLEAN=<low-ISO RAW>` decoded at half size is the clean reference;
//   `PHOTOBOOK_P26_NOISE=label=<high-ISO RAW>,...` gives the noise curves (plan 23's `measure` on a full-size crop),
//   added as Poisson-Gaussian noise; PSNR of every method on four 512 px crops.
// - `p26_eval_photos`: `PHOTOBOOK_P26_PHOTOS=label=path@cx:cy@cx:cy;...` (a `jpeg:` path prefix first makes a
//   camera-like JPEG of the RAW, as plan 24 did), side-by-side 512 px crops at 100 % at the editor's defaults and at
//   full strength.
//
// Extra 3-channel models (our static exports before they are hosted): `PHOTOBOOK_P26_MODELS=name=path,...`.
// DRUNet (`--features denoise-drunet`): `PHOTOBOOK_P26_DRUNET=path`.

fn p26_out() -> Option<PathBuf> {
    let out = PathBuf::from(std::env::var_os("PHOTOBOOK_P26_OUT")?);
    std::fs::create_dir_all(&out).unwrap();
    Some(out)
}

/// `name=path,name=path` from an env var.
fn p26_list(var: &str) -> Vec<(String, PathBuf)> {
    std::env::var(var)
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            let (name, path) = s.split_once('=').unwrap_or_else(|| panic!("{var}: expected name=path, got {s}"));
            (name.trim().to_owned(), PathBuf::from(path.trim()))
        })
        .collect()
}

fn p26_session(name: &str, path: &std::path::Path, out: &std::path::Path) -> photobook_develop::ai::Session {
    // Symbolic dimensions (ailia's `height`/`width`, Heliosoph's `batch`) fixed as the manifest does.
    let dims = [("batch", 1), ("height", 512), ("width", 512)].map(|(k, v)| (k.to_owned(), v)).to_vec();
    let mut opts = photobook_develop::ai::SessionOptions {
        cache_dir: Some(out.join("coreml-cache").join(name)),
        dims,
        ..Default::default()
    };
    if std::env::var_os("PHOTOBOOK_DENOISE_CPU").is_some() {
        opts = opts.cpu();
    }
    let t = Instant::now();
    let session = photobook_develop::ai::Session::load(path, &opts).unwrap();
    let info = session.info();
    println!(
        "{name}: {} in {:.1} s ({:.1} MB); inputs {:?}; ops left on the CPU {:?}",
        info.provider_summary(),
        t.elapsed().as_secs_f64(),
        std::fs::metadata(path).map(|m| m.len() as f64 / 1e6).unwrap_or(0.0),
        info.inputs,
        info.unsupported_ops
    );
    session
}

/// 3-channel engines: the pinned w32 (installed) and every `PHOTOBOOK_P26_MODELS` file.
fn p26_engines(out: &std::path::Path) -> Vec<(String, DenoiseEngine)> {
    let dir = ModelDir::new(models_dir());
    ensure_installed(DenoiseModel::NafnetW32, &dir);
    let mut engines = vec![("w32".to_owned(), load(DenoiseModel::NafnetW32, &dir))];
    for (name, path) in p26_list("PHOTOBOOK_P26_MODELS") {
        let session = p26_session(&name, &path, out);
        engines.push((name.clone(), DenoiseEngine::from_session(&name, "p26", 512, session).unwrap()));
    }
    engines
}

#[cfg(feature = "denoise-drunet")]
fn p26_drunet(out: &std::path::Path) -> Option<photobook_develop::ai::drunet::DrunetEngine> {
    let path = PathBuf::from(std::env::var_os("PHOTOBOOK_P26_DRUNET")?);
    let mut opts = photobook_develop::ai::SessionOptions {
        cache_dir: Some(out.join("coreml-cache").join("drunet")),
        ..Default::default()
    };
    if std::env::var_os("PHOTOBOOK_DENOISE_CPU").is_some() {
        opts = opts.cpu();
    }
    let engine = photobook_develop::ai::drunet::DrunetEngine::load(&path, &opts).unwrap();
    println!("drunet: {}", engine.session().info().provider_summary());
    Some(engine)
}

fn p26_crop(img: &LinearImage, x0: u32, y0: u32, size: u32) -> LinearImage {
    let mut data = Vec::with_capacity((size * size * 3) as usize);
    for y in y0..y0 + size {
        data.extend_from_slice(&img.row(y)[x0 as usize * 3..(x0 + size) as usize * 3]);
    }
    LinearImage::new(size, size, data).with_meta(img.meta.clone())
}

/// Top-left of a `size` crop centred at fractions (`cx`, `cy`).
fn p26_origin(img: &LinearImage, (cx, cy): (f32, f32), size: u32) -> (u32, u32) {
    (
        ((cx * img.width as f32) as u32).saturating_sub(size / 2).min(img.width - size),
        ((cy * img.height as f32) as u32).saturating_sub(size / 2).min(img.height - size),
    )
}

/// Render panels with `settings` and write them side by side as a JPEG.
fn p26_strip(panels: &[LinearImage], settings: &photobook_develop::DevelopSettings, path: &std::path::Path) {
    use photobook_develop::{encode_jpeg, Developer, RenderOptions, Rgb8Image};
    let size = panels[0].width as usize;
    let mut strip = vec![0u8; size * panels.len() * size * 3];
    for (k, p) in panels.iter().enumerate() {
        let r = Developer::new(p.clone()).render_with(settings, &RenderOptions::default());
        for y in 0..size {
            let dst = (y * size * panels.len() + k * size) * 3;
            strip[dst..dst + size * 3].copy_from_slice(&r.data[y * size * 3..(y + 1) * size * 3]);
        }
    }
    let img = Rgb8Image::new((size * panels.len()) as u32, size as u32, strip);
    std::fs::write(path, encode_jpeg(&img, 92).unwrap()).unwrap();
}

/// Uniform random tile data of the session's first input, timed over `runs` runs (ms each).
fn p26_time(session: &photobook_develop::ai::Session, runs: usize) -> Vec<f64> {
    use photobook_develop::ai::runtime::Tensor;
    let input = &session.info().inputs[0];
    let shape: Vec<usize> =
        input.shape.iter().enumerate().map(|(i, &d)| if d > 0 { d as usize } else if i < 2 { 1 } else { 512 }).collect();
    let n: usize = shape.iter().product();
    let mut rng = Rng(9);
    let data: Vec<f32> = (0..n).map(|_| rng.next() as f32).collect();
    let half: Vec<half::f16> = data.iter().map(|&v| half::f16::from_f32(v)).collect();
    session.warm_up(1).unwrap();
    (0..runs)
        .map(|_| {
            let t = Instant::now();
            let tensor = if input.dtype == "f16" {
                Tensor::F16(ndarray::ArrayViewD::from_shape(ndarray::IxDyn(&shape), &half).unwrap())
            } else {
                Tensor::F32(ndarray::ArrayViewD::from_shape(ndarray::IxDyn(&shape), &data).unwrap())
            };
            session.run(&[(input.name.as_str(), tensor)]).unwrap();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect()
}

#[test]
#[ignore = "plan 26: needs ONNX files in PHOTOBOOK_P26_ONNX; use --release --nocapture"]
fn p26_coreml_partitions_and_timing() {
    let Some(out) = p26_out() else {
        eprintln!("SKIP: set PHOTOBOOK_P26_OUT and PHOTOBOOK_P26_ONNX");
        return;
    };
    let runs: usize = std::env::var("PHOTOBOOK_P26_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(5);
    for (name, path) in p26_list("PHOTOBOOK_P26_ONNX") {
        let session = p26_session(&name, &path, &out);
        let tile = match *session.info().inputs[0].shape.last().unwrap() {
            d if d > 0 => d as usize,
            _ => 512,
        };
        let mut times = p26_time(&session, runs);
        times.sort_by(f64::total_cmp);
        let median = times[times.len() / 2];
        let tiles = tile_plan(6000, 4000, tile, denoise::TILE_OVERLAP, 8).tiles.len();
        println!(
            "  {name}: tile {tile}², median {median:.0} ms (min {:.0}, max {:.0}) over {runs} runs; 24 MP = {tiles} tiles ≈ {:.0} s",
            times[0],
            times[times.len() - 1],
            median * tiles as f64 / 1e3
        );
    }
}

/// Poisson-Gaussian noise from `fit` (per channel, linear) on `clean`.
fn p26_add_noise(clean: &LinearImage, fit: &photobook_develop::ai::noise_profile::NoiseFit, seed: u64) -> LinearImage {
    let mut rng = Rng(seed);
    let data = clean
        .data
        .chunks_exact(3)
        .flat_map(|p| {
            let mut q = [0.0f32; 3];
            for c in 0..3 {
                let var = fit.channels[c].variance_at(p[c].max(0.0) as f64) as f32;
                q[c] = p[c] + rng.gauss() * var.sqrt();
            }
            q
        })
        .collect();
    LinearImage::new(clean.width, clean.height, data).with_meta(clean.meta.clone())
}

#[test]
#[ignore = "plan 26: needs RAW samples and the models; use --release --nocapture"]
fn p26_psnr_simulated() {
    use photobook_develop::ai::noise_profile::measure;
    use photobook_develop::decode::resize_linear;
    use photobook_develop::decode_file;
    let (Some(out), Some(clean_path)) = (p26_out(), std::env::var_os("PHOTOBOOK_P26_CLEAN")) else {
        eprintln!("SKIP: set PHOTOBOOK_P26_OUT, PHOTOBOOK_P26_CLEAN and PHOTOBOOK_P26_NOISE");
        return;
    };
    let full = decode_file(std::path::Path::new(&clean_path), None).unwrap();
    let clean = resize_linear(full.clone(), full.width / 2, full.height / 2).unwrap();
    drop(full);
    let clean_fit = measure(&p26_crop(&clean, clean.width / 2 - 1024, clean.height / 2 - 1024, 2048));
    println!("clean reference {}x{}: own σ {:.5} at mid-grey", clean.width, clean.height, clean_fit.sigma);
    let engines = p26_engines(&out);
    #[cfg(feature = "denoise-drunet")]
    let drunet = p26_drunet(&out);
    let never = AtomicBool::new(false);
    let reference = Some((clean.width, clean.height));
    let full_strength =
        |chroma_mode| Denoise { model: DenoiseModel::NafnetW32, luminance: 100.0, chroma: 100.0, sharpen: 0.0, chroma_mode };
    let srgb_psnr = |a: &LinearImage, b: &LinearImage| psnr(&image_to_srgb(a), &image_to_srgb(b));
    for (label, path) in p26_list("PHOTOBOOK_P26_NOISE") {
        let noisy_raw = decode_file(&path, None).unwrap();
        let fit = measure(&p26_crop(&noisy_raw, noisy_raw.width / 2 - 1024, noisy_raw.height / 2 - 1024, 2048));
        drop(noisy_raw);
        let noisy = p26_add_noise(&clean, &fit, 26);
        let (sw, sh) = if clean.width >= clean.height {
            (1600, 1600 * clean.height / clean.width)
        } else {
            (1600 * clean.width / clean.height, 1600)
        };
        // Estimates from the noisy image itself, as the editor would make them (no oracle): at 1600 px (the
        // chroma filter's σ and, scaled by `for_full_size`, one DRUNet curve) and on a full-size 2048² crop.
        let est_small = measure(&resize_linear(noisy.clone(), sw, sh).unwrap());
        let est_full = measure(&p26_crop(&noisy, noisy.width / 2 - 1024, noisy.height / 2 - 1024, 2048));
        let filter_sigma = chroma_sigma(Some(est_small.sigma), None);
        println!(
            "  estimated σ at mid-grey: full-size crop {:.5}, 1600 px {:.5} (× {:.2} for full size), oracle {:.5}",
            est_full.sigma,
            est_small.sigma,
            noisy.width.max(noisy.height) as f32 / 1600.0,
            fit.sigma
        );
        println!(
            "{label}: full-size σ {:.5} at mid-grey ({:.1} %), curve a {:?} b {:?}; chroma filter σ {filter_sigma}",
            fit.sigma,
            fit.sigma / 0.18 * 100.0,
            fit.channels.map(|c| c.a),
            fit.channels.map(|c| c.b)
        );
        let mut scores: Vec<(String, Vec<f64>)> = Vec::new();
        let mut push = |name: String, v: f64| match scores.iter_mut().find(|(n, _)| *n == name) {
            Some((_, list)) => list.push(v),
            None => scores.push((name, vec![v])),
        };
        for (k, centre) in [(0.3f32, 0.3f32), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7)].into_iter().enumerate() {
            let (x0, y0) = p26_origin(&clean, centre, 512);
            let c = p26_crop(&clean, x0, y0, 512);
            let n = p26_crop(&noisy, x0, y0, 512);
            let opts = DenoiseOptions { reference_size: reference };
            let mut panels = vec![n.clone(), c.clone()];
            push("noisy".into(), srgb_psnr(&n, &c));
            let alone = chroma_filter_image(&n, filter_sigma, 1.0, reference);
            push("chroma filter alone".into(), srgb_psnr(&alone, &c));
            for (name, engine) in &engines {
                let (m, _) = denoise_with(engine, &n, &full_strength(ChromaMode::Model), &opts, &|_, _| {}, &never).unwrap();
                let (l, _) = denoise_with(engine, &n, &full_strength(ChromaMode::Filter), &opts, &|_, _| {}, &never).unwrap();
                let f = chroma_filter_image(&l, filter_sigma, 1.0, reference);
                push(format!("{name} model colour"), srgb_psnr(&m, &c));
                push(format!("{name} + chroma filter"), srgb_psnr(&f, &c));
                panels.push(f);
            }
            #[cfg(feature = "denoise-drunet")]
            if let Some(d) = &drunet {
                use photobook_develop::ai::drunet::{denoise_sigma, SigmaCurve};
                // The curve estimated on a full-size crop of the noisy image (scale 1), at several strengths; then,
                // for reference, the 1600 px estimate scaled to full size and the oracle (the curve that made the
                // noise), at strength 1.
                let estimated = SigmaCurve::from_fit(&est_full);
                let curves = [0.75f32, 1.0, 1.25, 1.5, 2.0]
                    .map(|k| (format!("drunet est. σ×{k}"), estimated, k))
                    .into_iter()
                    .chain([
                        ("drunet 1600 px est. scaled σ×1".to_owned(), SigmaCurve::for_full_size(&est_small, noisy.width, noisy.height), 1.0),
                        ("drunet oracle σ×1".to_owned(), SigmaCurve::from_fit(&fit), 1.0),
                    ]);
                for (name, curve, strength) in curves {
                    let m = denoise_sigma(d, &n, &curve, strength, &full_strength(ChromaMode::Model), &opts, &|_, _| {}, &never)
                        .unwrap();
                    push(format!("{name} model colour"), srgb_psnr(&m, &c));
                    let l = denoise_sigma(d, &n, &curve, strength, &full_strength(ChromaMode::Filter), &opts, &|_, _| {}, &never)
                        .unwrap();
                    let f = chroma_filter_image(&l, filter_sigma, 1.0, reference);
                    push(format!("{name} + chroma filter"), srgb_psnr(&f, &c));
                    if name == "drunet est. σ×1" {
                        panels.push(f);
                    }
                }
            }
            if k == 0 {
                let path = out.join(format!("sim-{label}.jpg"));
                p26_strip(&panels, &photobook_develop::DevelopSettings::default(), &path);
                println!("  crop 1 strip (noisy, clean, then each model + filter) -> {}", path.display());
            }
        }
        for (name, list) in &scores {
            let mean = list.iter().sum::<f64>() / list.len() as f64;
            let each: Vec<String> = list.iter().map(|v| format!("{v:.2}")).collect();
            println!("  {label} {name:<34} PSNR {mean:6.2} dB  [{}]", each.join(", "));
        }
    }
}

#[test]
#[ignore = "plan 26: needs photos and the models; writes crop compare images"]
fn p26_eval_photos() {
    use photobook_develop::ai::noise_profile::measure;
    use photobook_develop::{decode_file, encode_jpeg, render_full, DevelopSettings};
    let (Some(out), Ok(spec)) = (p26_out(), std::env::var("PHOTOBOOK_P26_PHOTOS")) else {
        eprintln!("SKIP: set PHOTOBOOK_P26_OUT and PHOTOBOOK_P26_PHOTOS");
        return;
    };
    let engines = p26_engines(&out);
    #[cfg(feature = "denoise-drunet")]
    let drunet = p26_drunet(&out);
    let never = AtomicBool::new(false);
    for item in spec.split(';').filter(|s| !s.trim().is_empty()) {
        let mut parts = item.trim().split('@');
        let (label, path) = parts.next().unwrap().split_once('=').unwrap();
        let centres: Vec<(f32, f32)> = parts
            .map(|c| {
                let (x, y) = c.split_once(':').unwrap();
                (x.parse().unwrap(), y.parse().unwrap())
            })
            .collect();
        let (path, jpeg) = match path.strip_prefix("jpeg:") {
            Some(p) => (PathBuf::from(p), true),
            None => (PathBuf::from(path), false),
        };
        let path = if jpeg {
            // As plan 24: the RAW at the editor's defaults (with the RAW look), quality 90, 4:2:0.
            let decoded = decode_file(&path, None).unwrap();
            let camera = render_full(&decoded, &DevelopSettings::default()).unwrap();
            let p = out.join(format!("{label}.jpg"));
            std::fs::write(&p, encode_jpeg(&camera, 90).unwrap()).unwrap();
            p
        } else {
            path
        };
        let full = decode_file(&path, None).unwrap();
        let fit = measure(&decode_file(&path, Some(1600)).unwrap());
        let filter_sigma = chroma_sigma(Some(fit.sigma), None);
        let full_fit = measure(&p26_crop(
            &full,
            full.width / 2 - 1024.min(full.width / 2),
            full.height / 2 - 1024.min(full.height / 2),
            2048.min(full.width).min(full.height),
        ));
        println!(
            "{label} ({}x{}): σ {:.2} % of mid-grey at 1600 px (filter σ {filter_sigma}), {:.2} % at full size",
            full.width,
            full.height,
            fit.sigma / 0.18 * 100.0,
            full_fit.sigma / 0.18 * 100.0
        );
        let reference = Some((full.width, full.height));
        let opts = DenoiseOptions { reference_size: reference };
        let defaults = Denoise { model: DenoiseModel::NafnetW32, luminance: 50.0, chroma: 75.0, sharpen: 25.0, chroma_mode: ChromaMode::Filter };
        let strong = Denoise { luminance: 100.0, chroma: 100.0, sharpen: 0.0, ..defaults.clone() };
        let mut names = vec!["input".to_owned(), "w32 model colour".to_owned()];
        for (k, centre) in centres.iter().enumerate() {
            let (x0, y0) = p26_origin(&full, *centre, 512);
            let crop = p26_crop(&full, x0, y0, 512);
            for (tag, s) in [("default", &defaults), ("full", &strong)] {
                let chroma = (s.chroma / 100.0) as f32;
                let mut panels = vec![crop.clone()];
                // Chroma filter off: NAFNet's own colour (`chromaMode: model`), w32 only.
                let model_colour = Denoise { chroma_mode: ChromaMode::Model, ..s.clone() };
                panels.push(denoise_with(&engines[0].1, &crop, &model_colour, &opts, &|_, _| {}, &never).unwrap().0);
                for (name, engine) in &engines {
                    let (l, _) = denoise_with(engine, &crop, s, &opts, &|_, _| {}, &never).unwrap();
                    panels.push(chroma_filter_image(&l, filter_sigma, chroma, reference));
                    if k == 0 && tag == "default" {
                        names.push(format!("{name} + chroma filter"));
                    }
                }
                #[cfg(feature = "denoise-drunet")]
                if let Some(d) = &drunet {
                    use photobook_develop::ai::drunet::{denoise_sigma, SigmaCurve};
                    let curve = SigmaCurve::from_fit(&full_fit);
                    // PHOTOBOOK_P26_DRUNET_STRENGTH scales the σ map (default 1).
                    let strength: f32 =
                        std::env::var("PHOTOBOOK_P26_DRUNET_STRENGTH").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
                    let l = denoise_sigma(d, &crop, &curve, strength, s, &opts, &|_, _| {}, &never).unwrap();
                    panels.push(chroma_filter_image(&l, filter_sigma, chroma, reference));
                    if k == 0 && tag == "default" {
                        names.push("drunet σ-map + chroma filter".into());
                    }
                }
                panels.push(chroma_filter_image(&crop, filter_sigma, chroma, reference));
                if k == 0 && tag == "default" {
                    names.push("chroma filter alone".into());
                }
                let file = out.join(format!("{label}-crop{}-{tag}.jpg", k + 1));
                p26_strip(&panels, &DevelopSettings::default(), &file);
                println!("  crop {} at ({x0}, {y0}) {tag} -> {}", k + 1, file.display());
            }
        }
        println!("  panels: {}", names.join(" | "));
    }
}
