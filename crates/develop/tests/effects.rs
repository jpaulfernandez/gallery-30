//! Workflow plan 17: the Effects section (grading, grain, vignette, halation) in the CPU pipeline.
//!
//! - every effect at its default is a no-op (renders and hashes unchanged);
//! - each effect changes the render the way it should;
//! - grain matches between a proxy and a render at twice the size (a crop compare on the same reference points);
//! - the GPU renders every effect since plan 19 (no CPU fallback; the parity cases are in `tests/gpu.rs`);
//! - masked rows get the effects too.
//!
//! Halation full-render timing (24 MP): `cargo test -p photobook-develop --release --test effects -- --ignored
//! --nocapture`.

use std::time::Instant;

use photobook_develop::settings::{Effects, GradingWheel};
use photobook_develop::{
    develop_hash, gpu, render_full_with_options, DevelopSettings, Developer, LinearImage, Quality, RenderBackend,
    RenderOptions, Rgb8Image,
};

mod common;
use common::*;

fn cpu() -> RenderOptions {
    RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() }
}

fn render(img: &LinearImage, s: &DevelopSettings) -> Rgb8Image {
    Developer::new(img.clone()).render_with(s, &cpu())
}

fn px(img: &Rgb8Image, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * img.width + x) * 3) as usize;
    [img.data[i], img.data[i + 1], img.data[i + 2]]
}

fn mean_luma(img: &Rgb8Image, x0: u32, y0: u32, x1: u32, y1: u32) -> f64 {
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let [r, g, b] = px(img, x, y);
            sum += 0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64;
        }
    }
    sum / ((x1 - x0) * (y1 - y0)) as f64
}

fn with(f: impl FnOnce(&mut Effects)) -> DevelopSettings {
    let mut s = DevelopSettings::default();
    f(&mut s.effects);
    s
}

#[test]
fn defaults_are_a_no_op_and_keep_the_hash() {
    let img = scene(320, 214);
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.3;
    let plain = render(&img, &s);
    let mut explicit = s.clone();
    explicit.effects = Effects::default();
    // Blending and balance without a wheel change nothing either.
    explicit.effects.grading.blending = 80.0;
    explicit.effects.grading.balance = 40.0;
    assert_eq!(render(&img, &explicit).data, plain.data);
    assert_eq!(develop_hash(&s), develop_hash(&DevelopSettings { effects: Effects::default(), ..s.clone() }));
    let json = serde_json::to_value(&s).unwrap();
    assert!(json.get("effects").is_none(), "default effects are left out of the JSON and the hash");
    assert!(serde_json::to_value(&with(|e| e.grain.amount = 1.0)).unwrap().get("effects").is_some());
}

#[test]
fn vignette_darkens_the_corners_symmetrically() {
    let img = image(300, 200, |_, _| grey(150.0));
    let out = render(&img, &with(|e| e.vignette.amount = -60.0));
    let centre = px(&out, 150, 100);
    assert!(centre[0].abs_diff(150) <= 1, "{centre:?}");
    let corner = px(&out, 0, 0);
    assert!(corner[0] < 110, "{corner:?}");
    // Mirrored corners match (within the dither) on average.
    let quad = |x0, y0| mean_luma(&out, x0, y0, x0 + 20, y0 + 20);
    for (x0, y0) in [(280, 0), (0, 180), (280, 180)] {
        assert!((quad(x0, y0) - quad(0, 0)).abs() < 0.3, "{x0} {y0}: {} vs {}", quad(x0, y0), quad(0, 0));
    }
    // Lightening goes the other way.
    let light = render(&img, &with(|e| e.vignette.amount = 60.0));
    assert!(px(&light, 0, 0)[0] > 180);
}

#[test]
fn grading_tints_shadows_and_highlights() {
    // Left half dark, right half light.
    let img = image(200, 100, |x, _| grey(if x < 100 { 50.0 } else { 210.0 }));
    let s = with(|e| {
        e.grading.shadows = GradingWheel { hue: 210.0, saturation: 60.0, ..GradingWheel::default() };
        e.grading.highlights = GradingWheel { hue: 35.0, saturation: 60.0, ..GradingWheel::default() };
    });
    let out = render(&img, &s);
    let [r, _, b] = px(&out, 50, 50);
    assert!(b > r + 4, "teal shadows: {:?}", px(&out, 50, 50));
    let [r, _, b] = px(&out, 150, 50);
    assert!(r > b + 4, "warm highlights: {:?}", px(&out, 150, 50));
}

#[test]
fn halation_glows_red_next_to_highlights() {
    let (w, h) = (400u32, 260u32);
    let img = image(w, h, |x, y| if (190..210).contains(&x) && (120..140).contains(&y) { grey(255.0) } else { grey(40.0) });
    let out = render(&img, &with(|e| e.halation.amount = 80.0));
    let base = render(&img, &DevelopSettings::default());
    let (glow, before) = (px(&out, 180, 130), px(&base, 180, 130));
    assert!(glow[0] > before[0] + 5 && glow[0] > glow[2] + 5, "{glow:?} vs {before:?}");
    assert_eq!(px(&out, 5, 5), px(&base, 5, 5), "far from the highlight nothing changes");
}

#[test]
fn grain_is_deterministic_and_spares_black() {
    let img = image(256, 128, |x, _| grey(if x < 128 { 0.0 } else { 128.0 }));
    let s = with(|e| e.grain.amount = 60.0);
    let a = render(&img, &s);
    assert_eq!(a.data, render(&img, &s).data);
    // Mid-grey half is noisy, black half clean.
    let spread = |x0: u32| {
        let vals: Vec<f64> = (0..128).flat_map(|y| (x0..x0 + 128).map(move |x| (x, y))).map(|(x, y)| px(&a, x, y)[1] as f64).collect();
        let m = vals.iter().sum::<f64>() / vals.len() as f64;
        (vals.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / vals.len() as f64).sqrt()
    };
    assert!(spread(128) > 2.0, "grain spread {}", spread(128));
    assert!(spread(0) < 0.5, "black stays clean: {}", spread(0));
}

/// Grain is a function of the reference position (long edge 2048): on a flat grey, a render at twice the proxy's
/// size shows at its even pixels exactly the grain the proxy shows (within the 8-bit dither), over a crop of both.
#[test]
fn grain_matches_between_proxy_and_full_render() {
    let s = with(|e| {
        e.grain.amount = 70.0;
        e.grain.size = 60.0;
    });
    let full = render(&image(2048, 1366, |_, _| grey(120.0)), &s);
    let proxy = render(&image(1024, 683, |_, _| grey(120.0)), &s);
    let mut over1 = 0;
    let mut spread = 0.0f64;
    for y in 300..400u32 {
        for x in 500..700u32 {
            let (a, b) = (px(&proxy, x, y), px(&full, 2 * x, 2 * y));
            for c in 0..3 {
                assert!(a[c].abs_diff(b[c]) <= 1, "({x}, {y}): proxy {a:?} full {b:?}");
                over1 += (a[c] != b[c]) as usize;
            }
            spread += (a[1] as f64 - 120.0).abs();
        }
    }
    assert!(spread / 20_000.0 > 1.0, "the crop has visible grain");
    eprintln!("grain crop compare: {over1} of 60000 channels one level apart (dither)");
}

#[test]
fn masked_rows_get_the_effects() {
    use photobook_develop::settings::{LocalAdjustments, Mask, MaskComponent, MaskMode, MaskShape};
    let img = image(200, 120, |_, _| grey(150.0));
    let mut s = with(|e| e.vignette.amount = -80.0);
    s.masks.push(Mask {
        id: "m".into(),
        name: "m".into(),
        enabled: true,
        invert: false,
        opacity: 100.0,
        feather: 0.0,
        components: vec![MaskComponent {
            id: "c".into(),
            mode: MaskMode::Add,
            invert: false,
            shape: MaskShape::Linear { from: [0.0, 0.0], to: [0.0, 0.01] },
        }],
        adjustments: LocalAdjustments { exposure: 0.01, ..LocalAdjustments::default() },
    });
    let out = render(&img, &s);
    // The mask covers the whole frame (a linear gradient finished at the top); the corners still darken.
    assert!(px(&out, 0, 119)[0] < 120, "{:?}", px(&out, 0, 119));
}

/// A mask over the whole frame (a linear gradient finished at the top) with a negligible local exposure, so every
/// row takes the masked path while the pixels match the global path.
fn whole_frame_mask() -> photobook_develop::settings::Mask {
    use photobook_develop::settings::{LocalAdjustments, Mask, MaskComponent, MaskMode, MaskShape};
    Mask {
        id: "m".into(),
        name: "m".into(),
        enabled: true,
        invert: false,
        opacity: 100.0,
        feather: 0.0,
        components: vec![MaskComponent {
            id: "c".into(),
            mode: MaskMode::Add,
            invert: false,
            shape: MaskShape::Linear { from: [0.0, 0.0], to: [0.0, 0.01] },
        }],
        adjustments: LocalAdjustments { exposure: 0.001, ..LocalAdjustments::default() },
    }
}

#[test]
fn masked_rows_get_grading_and_grain() {
    let img = image(200, 120, |x, _| grey(if x < 100 { 50.0 } else { 210.0 }));
    for effects in [
        with(|e| {
            e.grading.shadows = GradingWheel { hue: 210.0, saturation: 60.0, ..GradingWheel::default() };
            e.grading.highlights = GradingWheel { hue: 35.0, saturation: 60.0, ..GradingWheel::default() };
        }),
        with(|e| e.grain.amount = 70.0),
    ] {
        let global = render(&img, &effects);
        let mut masked = effects.clone();
        masked.masks.push(whole_frame_mask());
        let out = render(&img, &masked);
        let plain = render(&img, &DevelopSettings { masks: masked.masks.clone(), ..DevelopSettings::default() });
        let max_diff = |a: &Rgb8Image, b: &Rgb8Image| a.data.iter().zip(&b.data).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
        // The masked rows match the global path with the effect (within the dither) and differ from no effect.
        assert!(max_diff(&out, &global) <= 2, "masked vs global: {}", max_diff(&out, &global));
        assert!(max_diff(&out, &plain) >= 5, "the effect is missing on masked rows");
    }
}

#[test]
fn halation_follows_exposure_and_white_balance() {
    use photobook_develop::cpu::Params;
    use photobook_develop::settings::WhiteBalance;
    let key = |s: &DevelopSettings| Params::new(s, &cpu()).needs().halation.expect("halation needs its glow");
    let base = with(|e| e.halation.amount = 60.0);
    let mut brighter = base.clone();
    brighter.light.exposure = 1.0;
    let (k0, k1) = (key(&base), key(&brighter));
    assert!((k1.threshold - k0.threshold / 2.0).abs() < 1e-6, "{k0:?} {k1:?}");
    assert_eq!(k0.sigma_ref, k1.sigma_ref);
    let mut warmer = base.clone();
    warmer.white_balance = WhiteBalance::Incremental { temperature: 60.0, tint: 0.0 };
    assert_ne!(key(&warmer).threshold, k0.threshold, "white balance's grey gain moves the threshold");
    // A tone slider other than exposure leaves the glow source alone.
    let mut contrast = base.clone();
    contrast.light.contrast = 40.0;
    assert_eq!(key(&contrast), k0);

    // Rendered: a mid-grey patch below the threshold does not glow until exposure lifts it over.
    let img = image(240, 160, |x, y| if (110..130).contains(&x) && (70..90).contains(&y) { grey(170.0) } else { grey(30.0) });
    let dev = Developer::new(img);
    let glow = |s: &DevelopSettings, without: &DevelopSettings| {
        let (a, b) = (dev.render_with(s, &cpu()), dev.render_with(without, &cpu()));
        px(&a, 106, 80)[0] as i32 - px(&b, 106, 80)[0] as i32
    };
    let plain = |s: &DevelopSettings| DevelopSettings { effects: Effects::default(), ..s.clone() };
    assert!(glow(&base, &plain(&base)) <= 1, "170/255 is below threshold 75");
    assert!(glow(&brighter, &plain(&brighter)) >= 5, "one stop up it glows");
}

/// Settings that differ from the defaults but change no pixel (a grain Size with Amount 0, a wheel hue at saturation
/// 0, shape sliders with Amount 0) are still in the hash; with a GPU they render there, exactly like the defaults.
#[test]
fn inactive_effects_render_on_the_gpu() {
    let size_only = with(|e| e.grain.size = 60.0);
    assert!(!size_only.effects.is_default(), "still part of the hash");
    let hue_only = with(|e| e.grading.shadows = GradingWheel { hue: 200.0, saturation: 0.0, ..GradingWheel::default() });
    let shapes = with(|e| {
        e.vignette.midpoint = 20.0;
        e.halation.radius = 80.0;
    });
    if gpu::GpuContext::get().is_none() {
        eprintln!("SKIP inactive_effects_render_on_the_gpu: no GPU adapter (or PHOTOBOOK_FORCE_CPU)");
        return;
    }
    let img = scene(320, 214);
    let gpu_opts = RenderOptions { backend: RenderBackend::Gpu, ..RenderOptions::default() };
    let dev = Developer::new(img.clone());
    let plain = dev.render_with(&DevelopSettings::default(), &gpu_opts);
    for s in [size_only, hue_only, shapes] {
        let out = dev.render_with(&s, &gpu_opts);
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
        assert_eq!(out.data, plain.data);
    }
}

/// Plan 19: active effects no longer fall back to the CPU; with a GPU the render runs there and stays within the
/// GPU tolerance of the CPU reference (2 levels; the full parity set is in `tests/gpu.rs`).
#[test]
fn gpu_renders_active_effects() {
    let s = with(|e| e.grain.amount = 20.0);
    if gpu::GpuContext::get().is_none() {
        eprintln!("SKIP gpu_renders_active_effects: no GPU adapter");
        return;
    }
    let img = scene(320, 214);
    let dev = Developer::new(img.clone());
    let out = dev.render_with(&s, &RenderOptions { backend: RenderBackend::Gpu, ..RenderOptions::default() });
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    let cpu_out = render(&img, &s);
    assert!(out.data.iter().zip(&cpu_out.data).all(|(a, b)| a.abs_diff(*b) <= 2));
    let full = render_full_with_options(&img, &s, Quality::for_size(320, 214), &RenderOptions::default()).unwrap();
    assert_eq!(full.data, out.data);
}

/// Full-resolution render times (24 MP, CPU), recorded in the plan's status line:
/// `cargo test -p photobook-develop --release --test effects -- --ignored --nocapture`. The base darkens the scene
/// half a stop so no pixel takes the gamut mapper's cheap clip-to-white path, which would flatter a glowing render.
#[test]
#[ignore]
fn timing_effects_24mp() {
    use photobook_develop::local::prepass::{halation_plane, HalationKey};
    let img = scene(6000, 4000);
    let options = cpu();
    let quality = Quality::for_size(6000, 4000);
    let time = |f: &dyn Fn()| {
        (0..3)
            .map(|_| {
                let t = Instant::now();
                f();
                t.elapsed()
            })
            .min()
            .unwrap()
    };
    let _ = render_full_with_options(&img, &DevelopSettings::default(), quality, &options).unwrap(); // warm-up
    let mut base = DevelopSettings::default();
    base.light.exposure = -0.5;
    let mut halo = base.clone();
    halo.effects.halation.amount = 50.0;
    halo.effects.halation.threshold = 60.0;
    let mut all = halo.clone();
    all.effects.grain.amount = 40.0;
    all.effects.vignette.amount = -30.0;
    all.effects.grading.shadows = GradingWheel { hue: 200.0, saturation: 30.0, ..GradingWheel::default() };
    all.effects.grading.highlights = GradingWheel { hue: 40.0, saturation: 30.0, ..GradingWheel::default() };
    for round in 0..2 {
        for (label, s) in [("base (exposure -0.5)", &base), ("halation", &halo), ("all effects", &all)] {
            let best = time(&|| {
                let _ = render_full_with_options(&img, s, quality, &options).unwrap();
            });
            eprintln!("24 MP full render, round {round}, {label}: {best:?}");
        }
    }
    for radius in [30.0f32, 100.0] {
        let key = HalationKey { threshold: 0.32, sigma_ref: 3.0 + 57.0 * radius / 100.0 };
        let best = time(&|| {
            let _ = halation_plane(&img, key);
        });
        eprintln!("24 MP halation pre-pass alone, radius {radius}: {best:?}");
    }
}

// --- Built-in looks (workflow plan 21). `tests/fixtures/looks/<id>.json` holds each look at full strength in the parity
// format, written by `packages/shared/src/develop/looks.test.ts` (`UPDATE_DEVELOP_FIXTURES=1`).

fn look_fixtures() -> Vec<(String, DevelopSettings, String)> {
    look_fixtures_in("tests/fixtures/looks")
}

/// `{ settings, canonical, hash }` files of `dir` (relative to the crate), as `(id, settings, hash)`, by file name.
fn look_fixtures_in(dir: &str) -> Vec<(String, DevelopSettings, String)> {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(dir);
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let id = path.file_stem().unwrap().to_string_lossy().into_owned();
            let settings: DevelopSettings = serde_json::from_value(json["settings"].clone()).unwrap();
            (id, settings, json["hash"].as_str().unwrap().to_string())
        })
        .collect()
}

#[test]
fn built_in_looks_parse_hash_and_render() {
    let looks = look_fixtures();
    assert!(looks.len() >= 10, "{} look fixtures", looks.len());
    let img = scene(320, 214);
    let plain = render(&img, &DevelopSettings::default());
    for (id, settings, hash) in &looks {
        assert_eq!(&develop_hash(settings), hash, "{id}: the Rust mirror hashes the look like TS");
        let out = render(&img, settings);
        let changed = out.data.iter().zip(&plain.data).filter(|(a, b)| a != b).count();
        assert!(changed * 4 > out.data.len(), "{id} changes most of the picture ({changed} of {})", out.data.len());
    }
}

/// Each look at its starting Amount as the editor scales it (`applyLook`), written by the editor's
/// `builtInLooks.test.ts` to `tests/fixtures/looks/start/`: Rust reads the scaled settings and reproduces the hash.
#[test]
fn built_in_looks_at_their_starting_amount_hash_like_the_editor() {
    let looks = look_fixtures_in("tests/fixtures/looks/start");
    assert_eq!(looks.len(), look_fixtures().len(), "one starting-Amount fixture per look");
    let img = scene(160, 107);
    for (id, settings, hash) in &looks {
        assert_eq!(&develop_hash(settings), hash, "{id} at its starting Amount");
        let text = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/looks/start/{id}.json")),
        )
        .unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(photobook_develop::develop_hash_input(settings), json["canonical"].as_str().unwrap(), "{id}");
        let _ = render(&img, settings);
    }
}

/// The visual review set of plan 21: every look on the review fixtures at proxy size (1600 px long edge) through the
/// real render (`render_preview`, the GPU when there is one), written as `<look>-<fixture>.jpg` plus
/// `none-<fixture>.jpg`. `PHOTOBOOK_LOOKS_OUT` is the output directory (required); `PHOTOBOOK_LOOKS_JSON` may name a
/// `{ "looks": [{ "id", "settings" }] }` file to render instead of the full-strength fixtures (the editor's settings
/// at each look's default Amount); `PHOTOBOOK_LOOKS_FIXTURES` a comma-separated list of photos (default: lisbon IMG_01
/// and IMG_11, which are git-ignored stock photos, and the committed synthetic portrait). Missing photos are skipped.
///
/// `PHOTOBOOK_LOOKS_OUT=/tmp/looks cargo test -p photobook-develop --test effects -- --ignored look_review --nocapture`
#[test]
#[ignore]
fn look_review() {
    let Ok(out) = std::env::var("PHOTOBOOK_LOOKS_OUT") else {
        eprintln!("SKIP: set PHOTOBOOK_LOOKS_OUT");
        return;
    };
    let out = std::path::PathBuf::from(out);
    std::fs::create_dir_all(&out).unwrap();
    let looks: Vec<(String, DevelopSettings)> = match std::env::var("PHOTOBOOK_LOOKS_JSON") {
        Ok(path) => {
            let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            json["looks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    (l["id"].as_str().unwrap().to_string(), serde_json::from_value(l["settings"].clone()).unwrap())
                })
                .collect()
        }
        Err(_) => look_fixtures().into_iter().map(|(id, s, _)| (id, s)).collect(),
    };
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let photos: Vec<std::path::PathBuf> = match std::env::var("PHOTOBOOK_LOOKS_FIXTURES") {
        Ok(list) => list.split(',').map(std::path::PathBuf::from).collect(),
        Err(_) => ["fixtures/lisbon-demo/IMG_01.jpg", "fixtures/lisbon-demo/IMG_11.jpg", "fixtures/portrait/portrait-01.jpg"]
            .iter()
            .map(|p| root.join(p))
            .collect(),
    };
    for photo in photos {
        if !photo.is_file() {
            eprintln!("SKIP: {} is missing", photo.display());
            continue;
        }
        let name = photo.file_stem().unwrap().to_string_lossy().to_lowercase();
        let img = photobook_develop::decode_file(&photo, Some(1600)).unwrap();
        let start = Instant::now();
        let before = photobook_develop::render_preview(&img, &DevelopSettings::default(), 1600, 85).unwrap();
        std::fs::write(out.join(format!("none-{name}.jpg")), before).unwrap();
        for (id, settings) in &looks {
            let jpeg = photobook_develop::render_preview(&img, settings, 1600, 85).unwrap();
            std::fs::write(out.join(format!("{id}-{name}.jpg")), jpeg).unwrap();
        }
        eprintln!("{name}: {} looks in {:?} ({}x{})", looks.len(), start.elapsed(), img.width, img.height);
    }
}
