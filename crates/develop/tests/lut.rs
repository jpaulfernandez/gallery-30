//! Workflow plan 18: the look's 3D LUT in the render.
//!
//! - the committed fixture LUT (`fixtures/luts/<sha256>.cube`, referenced by the `look.json` parity fixture) parses and
//!   is named by its content hash;
//! - an identity 33³ LUT is a no-op on a real photo (`fixtures/lisbon-demo`);
//! - strength 0 and a missing LUT file skip the pass (the hash still names the id);
//! - CPU and GPU agree on the LUT case (whole image and tiles); with an active effect the GPU renders too (plan 19),
//!   with the LUT applied.

use std::path::PathBuf;
use std::sync::Arc;

use photobook_develop::gpu::{GpuContext, Tiling};
use photobook_develop::lut::{self, Lut3d};
use photobook_develop::ops::lut::missing_lut;
use photobook_develop::settings::{Look, LutRef};
use photobook_develop::{
    decode_file, develop_hash, gpu, DevelopSettings, Developer, LinearImage, RenderBackend, RenderOptions, Rgb8Image,
};
use sha2::{Digest, Sha256};

mod common;
use common::*;

const FIXTURE_LUT: &str = "2a09ead054896e77573e0d00b6bbc5405467ad7a45afde4a4bdd9c532c0c34b4";
const IDENTITY: &str = "1d000000000000000000000000000000000000000000000000000000000000d1";

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Every test in this binary reads LUT files from the fixtures (the same directory each time).
fn setup() {
    lut::set_lut_dir(Some(fixtures_dir().join("luts")));
    lut::insert(IDENTITY, Arc::new(Lut3d::identity(33)));
}

fn cpu() -> RenderOptions {
    RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() }
}

fn with_lut(base: &DevelopSettings, id: &str, strength: f64) -> DevelopSettings {
    let mut s = base.clone();
    s.look = Look { lut: Some(LutRef { id: id.to_string(), name: "Test".into(), strength }) };
    s
}

fn render(img: &LinearImage, s: &DevelopSettings, options: &RenderOptions) -> Rgb8Image {
    Developer::new(img.clone()).render_with(s, options)
}

/// (max level difference, channels that differ).
fn diff(a: &Rgb8Image, b: &Rgb8Image) -> (u8, usize, f64) {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let mut max = 0;
    let mut n = 0;
    let mut sum = 0u64;
    for (x, y) in a.data.iter().zip(&b.data) {
        let d = x.abs_diff(*y);
        max = max.max(d);
        n += (d > 0) as usize;
        sum += d as u64;
    }
    (max, n, sum as f64 / a.data.len().max(1) as f64)
}

fn lisbon() -> LinearImage {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lisbon-demo/IMG_01.jpg");
    decode_file(&path, Some(800)).unwrap()
}

fn look_fixture() -> DevelopSettings {
    let text = std::fs::read_to_string(fixtures_dir().join("look.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    serde_json::from_value(json["settings"].clone()).unwrap()
}

#[test]
fn the_fixture_lut_is_named_by_its_hash() {
    let bytes = std::fs::read(lut::lut_file(&fixtures_dir().join("luts"), FIXTURE_LUT)).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&bytes)), FIXTURE_LUT);
    let text = std::str::from_utf8(&bytes).unwrap();
    let parsed = lut::parse_cube(text).unwrap();
    assert_eq!(parsed.size, 9);
    // Stored in the canonical form the editor writes, so its id is also `lut_id` of the parsed LUT.
    assert_eq!(lut::canonical_cube(&parsed), text);
    assert_eq!(lut::lut_id(&parsed), FIXTURE_LUT);
    let s = look_fixture();
    assert_eq!(s.look.lut.as_ref().map(|l| l.id.as_str()), Some(FIXTURE_LUT));
}

#[test]
fn identity_lut_is_a_no_op_on_a_photo() {
    setup();
    let img = lisbon();
    let mut base = DevelopSettings::default();
    base.light.exposure = 0.2;
    let plain = render(&img, &base, &cpu());
    let (max, n, _) = diff(&plain, &render(&img, &with_lut(&base, IDENTITY, 100.0), &cpu()));
    eprintln!("identity LUT on IMG_01 ({}x{}): max {max}, {n} channels differ", plain.width, plain.height);
    // Tetrahedral interpolation reproduces the identity within float rounding, which flips at most one level where a
    // value sits on a rounding edge.
    assert!(max <= 1 && n * 10_000 <= plain.data.len(), "max {max}, {n} of {}", plain.data.len());
}

#[test]
fn strength_zero_and_a_missing_file_skip_the_pass() {
    setup();
    let img = scene(320, 214);
    let base = DevelopSettings::default();
    let plain = render(&img, &base, &cpu());
    assert_eq!(render(&img, &with_lut(&base, FIXTURE_LUT, 0.0), &cpu()).data, plain.data);
    let graded = render(&img, &with_lut(&base, FIXTURE_LUT, 100.0), &cpu());
    let (max, _, _) = diff(&plain, &graded);
    assert!(max >= 10, "the fixture LUT changes the picture (max {max})");
    let half = render(&img, &with_lut(&base, FIXTURE_LUT, 50.0), &cpu());
    let (to_plain, _, _) = diff(&half, &plain);
    let (to_full, _, _) = diff(&half, &graded);
    assert!(to_plain < max && to_full < max, "50 % sits between ({to_plain}, {to_full} vs {max})");

    let gone = with_lut(&base, &"e".repeat(64), 100.0);
    assert_eq!(missing_lut(&gone).map(|l| l.name.as_str()), Some("Test"));
    assert!(missing_lut(&with_lut(&base, FIXTURE_LUT, 100.0)).is_none());
    assert_eq!(render(&img, &gone, &cpu()).data, plain.data, "a missing LUT is skipped");
    assert_ne!(develop_hash(&gone), develop_hash(&base), "the hash still names the LUT");
    assert_ne!(develop_hash(&gone), develop_hash(&with_lut(&base, FIXTURE_LUT, 100.0)));
}

#[test]
fn a_look_without_a_lut_keeps_the_hash() {
    let s = DevelopSettings::default();
    let json = serde_json::to_value(&s).unwrap();
    assert!(json.get("look").is_none());
    let parsed: DevelopSettings = serde_json::from_str(r#"{"version":1,"look":{"lut":null}}"#).unwrap();
    assert_eq!(develop_hash(&parsed), develop_hash(&s));
    let lut: DevelopSettings =
        serde_json::from_str(&format!(r#"{{"version":1,"look":{{"lut":{{"id":"{FIXTURE_LUT}","name":"x"}}}}}}"#)).unwrap();
    assert_eq!(lut.look.lut.unwrap().strength, 100.0);
}

// ---------- CPU vs GPU ----------

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

fn check(name: &str, img: &LinearImage, s: &DevelopSettings) {
    let cpu = render(img, s, &cpu());
    let dev = Developer::new(img.clone());
    let gpu = dev.render_with(s, &RenderOptions { backend: RenderBackend::Gpu, ..RenderOptions::default() });
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu), "{name}: the GPU path did not run");
    let (max, n, mean) = diff(&cpu, &gpu);
    eprintln!("  {name:<36} {}x{} max {max} mean {mean:.4} (differ: {n})", cpu.width, cpu.height);
    assert!(max <= 1 && mean <= 0.001, "{name}: CPU vs GPU max {max} mean {mean}");
}

#[test]
fn gpu_matches_the_cpu_on_the_lut_case() {
    setup();
    if !have_gpu("gpu_matches_the_cpu_on_the_lut_case") {
        return;
    }
    let look = look_fixture();
    let f = fixtures();
    for (file, path) in [("ramp", &f.ramp), ("chart", &f.chart), ("photo", &f.photo)] {
        let img = decode_file(path, None).unwrap();
        check(&format!("{file}: look.json"), &img, &look);
        check(&format!("{file}: fixture LUT 100 %"), &img, &with_lut(&DevelopSettings::default(), FIXTURE_LUT, 100.0));
    }
    let lisbon = lisbon();
    check("IMG_01: look.json", &lisbon, &look);
    let mut curves = look.clone();
    curves.curve.luma = vec![[0.0, 0.03], [0.5, 0.55], [1.0, 0.97]];
    curves.color.saturation = 20.0;
    check("IMG_01: curves + LUT", &lisbon, &curves);
    check("IMG_01: identity 33", &lisbon, &with_lut(&DevelopSettings::default(), IDENTITY, 100.0));
}

/// A random (not smooth) 5³ LUT on a noise image: every tetrahedron of the lattice is hit, so a GPU that sampled or
/// split the cube differently from the CPU would show.
#[test]
fn gpu_matches_the_cpu_with_a_random_lut_on_noise() {
    setup();
    if !have_gpu("gpu_matches_the_cpu_with_a_random_lut_on_noise") {
        return;
    }
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let mut random = Lut3d::identity(5);
    for v in &mut random.data {
        *v = [rnd(), rnd(), rnd()];
    }
    let id = "9".repeat(64);
    lut::insert(&id, Arc::new(random));
    let (w, h) = (300u32, 200u32);
    let img = LinearImage::new(w, h, (0..w * h * 3).map(|_| rnd() * 1.1).collect());
    check("noise: random 5³ LUT", &img, &with_lut(&DevelopSettings::default(), &id, 100.0));
    check("noise: random 5³ LUT at 35 %", &img, &with_lut(&DevelopSettings::default(), &id, 35.0));
}

#[test]
fn gpu_lut_tiles_match_the_whole_image() {
    setup();
    if !have_gpu("gpu_lut_tiles_match_the_whole_image") {
        return;
    }
    let img = scene(1500, 1000);
    let s = look_fixture();
    let whole = gpu::render_tiled(&img, &s, Tiling::Size(4096)).unwrap();
    let tiled = gpu::render_tiled(&img, &s, Tiling::Size(777)).unwrap();
    assert_eq!(diff(&whole, &tiled).0, 0);
}

#[test]
fn effects_with_a_lut_render_on_the_gpu() {
    setup();
    let mut s = look_fixture();
    s.effects.grain.amount = 20.0;
    if !have_gpu("effects_with_a_lut_render_on_the_gpu") {
        return;
    }
    let img = scene(320, 214);
    let dev = Developer::new(img.clone());
    let out = dev.render_with(&s, &RenderOptions { backend: RenderBackend::Gpu, ..RenderOptions::default() });
    assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    assert!(diff(&out, &render(&img, &s, &cpu())).0 <= 2, "within the GPU tolerance of the CPU");
    let mut no_lut = s.clone();
    no_lut.look = Look::default();
    assert!(diff(&out, &render(&img, &no_lut, &cpu())).0 > 2, "the GPU applies the LUT with the effects");
}
