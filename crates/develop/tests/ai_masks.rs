//! D4.3: AI mask components.
//!
//! The default run covers the model-free parts: preprocessing and the letterbox round trip, the depth range maths,
//! the guided-filter refinement, the PNG cache, the source-grid warp and the render hook (a `Developer` and a
//! one-shot render picking rasters up). Tests that need a model print a note and pass when it is not installed.
//!
//! `cargo test -p photobook-develop --release --test ai_masks -- --ignored --nocapture` runs every model end to end
//! on real photos from `fixtures/lisbon-demo` (models from `PHOTOBOOK_MODELS_DIR`, default the editor's
//! `<appdata>/models`; `download_mask_models` fetches them) and prints coverage, timings and partition counts.

#![cfg(feature = "ai")]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use photobook_develop::ai::depth::{depth_range_mask, normalise_inverse_depth, DepthMap};
use photobook_develop::ai::preprocess::{prepare, remap_exact, unletterbox, Filter, Fit, Norm, IMAGENET_MEAN, IMAGENET_STD};
use photobook_develop::ai::refine::{refine_with, upsample_to};
use photobook_develop::ai::segment::{
    generate, missing_models, nms, required_models, required_models_in, stamp_model_in, GenerateContext, InferenceFrame,
    LastSamEncoding, PersonBox, Sessions, Stage,
};
use photobook_develop::ai::{self, download_model, registry, ModelDir, ModelStatus};
use photobook_develop::geometry::orientation::orientation_matrix;
use photobook_develop::masks::ai_cache::{
    read_png_plane, with_ai_source, write_depth_png, write_mask_png, AiRasterCache, AiRasterSource, ImageRasters,
};
use photobook_develop::masks::{component_hash, MaskPlane};
use photobook_develop::settings::{
    CropAspect, CropRect, Crop, DevelopSettings, Geometry, Mask, MaskComponent, Rotation,
};
use photobook_develop::{decode_file, Developer, GeometryPlan, LinearImage, RenderBackend, RenderOptions};

fn models_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PHOTOBOOK_MODELS_DIR") {
        return dir.into();
    }
    let home = std::env::var_os("HOME").expect("HOME");
    PathBuf::from(home).join("Library/Application Support/com.photobook.editor/models")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lisbon-demo").join(name)
}

fn component(v: serde_json::Value) -> MaskComponent {
    serde_json::from_value(v).unwrap()
}

fn ai_component(id: &str, target: &str) -> MaskComponent {
    component(serde_json::json!({ "id": id, "kind": "ai", "target": target, "model": "", "modelVersion": "" }))
}

/// A linear image from an sRGB-encoded function of the pixel (values 0..1).
fn image_from(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> LinearImage {
    let m = photobook_develop::color::matrix::to_f32(&photobook_develop::color::matrix::srgb_to_rec2020());
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let c = f(x, y).map(photobook_develop::color::transfer::srgb_to_linear);
            data.extend(photobook_develop::color::matrix::apply_f32(&m, c[0], c[1], c[2]));
        }
    }
    LinearImage::new(w, h, data)
}

// ---------- preprocessing ----------

#[test]
fn letterbox_pads_with_the_mean_and_round_trips() {
    // 300 × 200: a left half at 0.2, a right half at 0.8 (sRGB), into a 96² letterbox.
    let img = image_from(300, 200, |x, _| if x < 150 { [0.2; 3] } else { [0.8; 3] });
    let input = prepare(&img, 96, 96, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear).unwrap();
    let f = input.frame;
    assert_eq!((f.content_width, f.content_height), (96, 64));
    assert_eq!(input.tensor.shape(), &[1, 3, 96, 96]);
    // Padding normalises to 0; content is (v − mean) / std.
    assert!(input.tensor[[0, 1, 80, 10]].abs() < 1e-6);
    let left = input.tensor[[0, 0, 30, 10]] * IMAGENET_STD[0] + IMAGENET_MEAN[0];
    let right = input.tensor[[0, 0, 30, 85]] * IMAGENET_STD[0] + IMAGENET_MEAN[0];
    assert!((left - 0.2).abs() < 2e-3 && (right - 0.8).abs() < 2e-3, "{left} {right}");
    // A plane on the model grid comes back to the image: the content box only.
    let plane: Vec<f32> = (0..96 * 96).map(|i| if (i % 96) < 48 && i / 96 < 64 { 1.0 } else { 0.0 }).collect();
    let back = unletterbox(&plane, 96, 96, &f, 300, 200).unwrap();
    assert_eq!((back.width, back.height), (300, 200));
    assert!(back.get(10, 100) > 0.99 && back.get(290, 100) < 0.01);
    assert!(back.get(10, 199) > 0.99, "the padding must not reach the image");
    // A quarter-resolution output (SAM's 256 px masks of its 1024 px input) maps the same way.
    let small: Vec<f32> = (0..24 * 24).map(|i| if (i % 24) < 12 && i / 24 < 16 { 1.0 } else { 0.0 }).collect();
    let back = unletterbox(&small, 24, 24, &f, 300, 200).unwrap();
    assert!(back.get(10, 190) > 0.99 && back.get(290, 10) < 0.01);
    // Stretch fills the input and round-trips.
    let s = prepare(&img, 64, 64, Fit::Stretch, Norm::Unit, Filter::Bicubic).unwrap();
    assert_eq!((s.frame.content_width, s.frame.content_height), (64, 64));
    assert!((s.tensor[[0, 2, 32, 5]] - 0.2).abs() < 2e-3 && (s.tensor[[0, 2, 32, 60]] - 0.8).abs() < 2e-3);
}

#[test]
fn orientation_remap_is_an_exact_permutation() {
    let (w, h) = (5u32, 3u32);
    let src: Vec<f32> = (0..w * h).map(|i| i as f32).collect();
    let mut g = Geometry { rotate: Rotation::R90, flip_h: true, ..Geometry::default() };
    for rotate in [Rotation::R0, Rotation::R90, Rotation::R180, Rotation::R270] {
        g.rotate = rotate;
        let o = orientation_matrix(&g);
        let (ow, oh) = if matches!(rotate, Rotation::R90 | Rotation::R270) { (h, w) } else { (w, h) };
        let turned = remap_exact(&src, 1, (w, h), (ow, oh), &o.invert().unwrap());
        let mut sorted = turned.clone();
        sorted.sort_by(f32::total_cmp);
        assert_eq!(sorted, src, "{rotate:?} must permute");
        let back = remap_exact(&turned, 1, (ow, oh), (w, h), &o);
        assert_eq!(back, src, "{rotate:?} must round-trip");
    }
}

// ---------- depth ----------

#[test]
fn depth_normalisation_and_range_masks() {
    // Inverse depth 10 (near) … 1 (far) across 101 columns.
    let raw: Vec<f32> = (0..101).map(|i| 10.0 - 9.0 * i as f32 / 100.0).collect();
    let d = normalise_inverse_depth(&raw);
    assert!(d[0] < 0.02 && d[100] > 0.98 && (d[50] - 0.5).abs() < 0.02, "{} {} {}", d[0], d[50], d[100]);
    assert!(d.windows(2).all(|w| w[1] >= w[0]), "near → far must increase");
    assert!(normalise_inverse_depth(&[3.0; 10]).iter().all(|&v| v == 0.0));
    let map = DepthMap { depth: MaskPlane::new(101, 1, (0..101).map(|i| i as f32 / 100.0).collect()), raw: Vec::new() };
    let hard = depth_range_mask(&map, [0.2, 0.4], 0.0);
    assert_eq!(hard.data[19], 0.0);
    assert_eq!(hard.data[20], 1.0);
    assert_eq!(hard.data[39], 1.0);
    assert_eq!(hard.data[41], 0.0);
    let soft = depth_range_mask(&map, [0.4, 0.2], 0.1);
    assert_eq!(soft.data[30], 1.0);
    assert!((soft.data[15] - 0.5).abs() < 1e-3, "midway down the feather: {}", soft.data[15]);
    assert!((soft.data[45] - 0.5).abs() < 1e-3, "{}", soft.data[45]);
    assert_eq!(soft.data[9], 0.0);
    assert_eq!(soft.data[51], 0.0);
}

// ---------- refinement ----------

#[test]
fn refinement_snaps_a_blurry_mask_onto_a_step_edge() {
    let (w, h) = (240u32, 160u32);
    // The picture: a step at x = 130. The mask: a soft ramp centred at x = 120 at quarter resolution.
    let guide: Vec<f32> = (0..w * h).map(|i| if i % w < 130 { 0.15 } else { 0.85 }).collect();
    let low = MaskPlane::new(60, 40, (0..60 * 40).map(|i| (((i % 60) as f32 - 30.0) / 6.0 + 0.5).clamp(0.0, 1.0)).collect());
    let up = upsample_to(&low, w, h);
    let refined = refine_with(&low, &guide, w, h, 8.0, 1e-3);
    assert!(refined.data.iter().all(|v| (0.0..=1.0).contains(v)));
    for y in [20u32, 80, 140] {
        let row: Vec<f32> = (0..w).map(|x| refined.get(x, y)).collect();
        // The biggest one-pixel step of the refined mask sits on the picture's edge (129 → 130), and it is several
        // times the plain upsample's slope (1/24 per pixel).
        let (at, step) = (1..w as usize).map(|x| (x, row[x] - row[x - 1])).max_by(|a, b| a.1.total_cmp(&b.1)).unwrap();
        assert_eq!(at, 130, "row {y}: the transition is on the edge");
        assert!(step > 0.25 && step > 5.0 * (up.get(130, y) - up.get(129, y)), "row {y}: step {step}");
        assert!(row[20] < 0.05 && row[220] > 0.95, "flats stay put: {} {}", row[20], row[220]);
    }
}

// ---------- the cache ----------

#[test]
fn png_cache_round_trips_and_follows_the_component_hash() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("develop/masks");
    let plane = MaskPlane::new(64, 48, (0..64 * 48).map(|i| (i % 64) as f32 / 63.0).collect());
    write_mask_png(&dir.join("x.png"), &plane).unwrap();
    let back = read_png_plane(&dir.join("x.png")).unwrap();
    assert_eq!((back.width, back.height), (64, 48));
    assert!(back.data.iter().zip(&plane.data).all(|(a, b)| (a - b).abs() <= 0.5 / 255.0 + 1e-6));
    write_depth_png(&dir.join("d.png"), &plane).unwrap();
    let back = read_png_plane(&dir.join("d.png")).unwrap();
    assert!(back.data.iter().zip(&plane.data).all(|(a, b)| (a - b).abs() <= 0.5 / 65535.0 + 1e-6));

    let cache = Arc::new(AiRasterCache::new(1 << 20));
    let sky = ai_component("a", "sky");
    assert!(!cache.exists(&dir, &sky));
    assert!(cache.get(&dir, &sky).is_none());
    let path = cache.put(&dir, &sky, &plane).unwrap();
    assert_eq!(path, dir.join(format!("{}.png", component_hash(&sky))));
    assert!(cache.exists(&dir, &sky));
    // Same content under another id: the same raster. Another target: none.
    let same = ai_component("b", "sky");
    assert!(Arc::ptr_eq(&cache.get(&dir, &sky).unwrap(), &cache.get(&dir, &same).unwrap()));
    assert!(cache.get(&dir, &ai_component("c", "subject")).is_none());
    // A fresh cache reads the file.
    let fresh = AiRasterCache::default();
    let p = fresh.get(&dir, &same).unwrap();
    assert!(p.data.iter().zip(&plane.data).all(|(a, b)| (a - b).abs() <= 0.5 / 255.0 + 1e-6));

    // Depth: one map, any range.
    let depth = component(serde_json::json!({
        "id": "d", "kind": "ai", "target": "depth", "model": "depth-anything-v2-small", "modelVersion": "v", "depthRange": [0.0, 0.25]
    }));
    assert!(!cache.exists(&dir, &depth));
    cache.put_depth(&dir, "depth-anything-v2-small", "v", &plane).unwrap();
    assert!(cache.exists(&dir, &depth));
    let near = cache.get(&dir, &depth).unwrap();
    assert!(near.get(0, 0) > 0.99 && near.get(63, 0) < 0.01);
    let mut far = depth.clone();
    if let photobook_develop::settings::MaskShape::Ai { depth_range, .. } = &mut far.shape {
        *depth_range = Some([0.75, 1.0]);
    }
    let far = cache.get(&dir, &far).unwrap();
    assert!(far.get(0, 0) < 0.01 && far.get(63, 0) > 0.99);
}

// ---------- the render hook ----------

#[derive(Debug)]
struct Fixed(Arc<MaskPlane>);

impl AiRasterSource for Fixed {
    fn raster(&self, _: &MaskComponent) -> Option<Arc<MaskPlane>> {
        Some(self.0.clone())
    }
}

fn same(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(&b).all(|(x, y)| x.abs_diff(*y) <= 2)
}

fn masked_settings(geometry: Geometry) -> DevelopSettings {
    let mut s = DevelopSettings::default();
    s.geometry = geometry;
    let mask: Mask = serde_json::from_value(serde_json::json!({
        "id": "m", "name": "AI", "components": [
            { "id": "c", "kind": "ai", "target": "subject", "model": "birefnet-lite", "modelVersion": "x" }
        ],
        "adjustments": { "exposure": 2.0 }
    }))
    .unwrap();
    s.masks = vec![mask];
    s
}

#[test]
fn rasters_follow_the_content_through_the_geometry() {
    // A mid-grey picture whose AI raster marks its left quarter (source grid, at half resolution).
    let (w, h) = (400u32, 300u32);
    let img = image_from(w, h, |_, _| [0.5; 3]);
    let raster = MaskPlane::new(200, 150, (0..200 * 150).map(|i| if i % 200 < 50 { 1.0 } else { 0.0 }).collect());
    let source: Arc<dyn AiRasterSource> = Arc::new(Fixed(Arc::new(raster.clone())));
    let cpu = RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() };

    // Identity: the left quarter is brighter.
    let dev = Developer::new(img.clone());
    let plain = dev.render_with(&masked_settings(Geometry::default()), &cpu);
    assert!(same(plain.pixel(20, 150), plain.pixel(380, 150)), "no source yet: the component counts as 0");
    dev.set_ai_rasters(Some(source.clone()));
    let out = dev.render_with(&masked_settings(Geometry::default()), &cpu);
    assert!(out.pixel(20, 150)[0] > out.pixel(380, 150)[0] + 40, "{:?} {:?}", out.pixel(20, 150), out.pixel(380, 150));

    // Rotate 90° clockwise: the source's left quarter is now the top quarter of a 300 × 400 render.
    let turned = Geometry { rotate: Rotation::R90, ..Geometry::default() };
    let out = dev.render_with(&masked_settings(turned.clone()), &cpu);
    assert_eq!((out.width, out.height), (300, 400));
    assert!(out.pixel(150, 20)[0] > out.pixel(150, 380)[0] + 40);
    // The warp maps exactly what the plan maps: compare with MaskPlane::warp_into.
    let plan = GeometryPlan::new(&turned, w, h, None);
    let warped = raster.warp_into(&plan);
    assert!(warped.get(150, 20) > 0.99 && warped.get(150, 380) < 0.01);

    // Crop to the right half: the raster's quarter is outside, nothing is brightened.
    let crop = Geometry {
        crop: Some(Crop {
            rect: CropRect { x: 0.5, y: 0.0, w: 0.5, h: 1.0 },
            angle: 0.0,
            aspect: CropAspect::default(),
        }),
        ..Geometry::default()
    };
    let out = dev.render_with(&masked_settings(crop.clone()), &cpu);
    assert!(same(out.pixel(5, 150), out.pixel(195, 150)));
    // Crop to the left half: its left half is brightened (the quarter of the whole frame).
    let left = Geometry {
        crop: Some(Crop { rect: CropRect { x: 0.0, y: 0.0, w: 0.5, h: 1.0 }, angle: 0.0, aspect: CropAspect::default() }),
        ..Geometry::default()
    };
    let out = dev.render_with(&masked_settings(left), &cpu);
    assert!(out.pixel(20, 150)[0] > out.pixel(180, 150)[0] + 40);

    // One-shot renders read the scoped source; without it the component counts as 0.
    let settings = masked_settings(turned);
    let without = photobook_develop::render::render_full_with_options(&img, &settings, photobook_develop::Quality::Preview, &cpu).unwrap();
    assert!(same(without.pixel(150, 20), without.pixel(150, 380)));
    let with = with_ai_source(Some(source), || {
        photobook_develop::render::render_full_with_options(&img, &settings, photobook_develop::Quality::Preview, &cpu).unwrap()
    });
    assert!(with.pixel(150, 20)[0] > with.pixel(150, 380)[0] + 40);
}

#[test]
fn a_raster_written_after_a_render_is_picked_up() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let img = image_from(120, 80, |_, _| [0.5; 3]);
    let cache = Arc::new(AiRasterCache::default());
    let dev = Developer::new(img);
    dev.set_ai_rasters(Some(Arc::new(ImageRasters::new(cache.clone(), dir.clone()))));
    let settings = masked_settings(Geometry::default());
    let cpu = RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() };
    let before = dev.render_with(&settings, &cpu);
    assert!(same(before.pixel(10, 40), before.pixel(110, 40)));
    let comp = &settings.masks[0].components[0];
    let raster = MaskPlane::new(120, 80, (0..120 * 80).map(|i| if i % 120 < 60 { 1.0 } else { 0.0 }).collect());
    cache.put(&dir, comp, &raster).unwrap();
    let after = dev.render_with(&settings, &cpu);
    assert!(after.pixel(10, 40)[0] > after.pixel(110, 40)[0] + 40);
    // And the overlay shows it.
    let (_, _, overlay) = dev.mask_overlay(&settings, "m").unwrap();
    assert!(overlay[40 * 120 + 10] > 0.99 && overlay[40 * 120 + 110] < 0.01);
}

#[test]
fn required_models_and_nms() {
    let names = |c: &MaskComponent| required_models(c).iter().map(|m| m.name.as_str()).collect::<Vec<_>>();
    assert_eq!(names(&ai_component("a", "subject")), ["birefnet-lite"]);
    assert_eq!(names(&ai_component("a", "background")), ["birefnet-lite"]);
    assert_eq!(names(&ai_component("a", "sky")), ["skywater-seg"]);
    assert_eq!(names(&ai_component("a", "depth")), ["depth-anything-v2-small"]);
    assert_eq!(names(&ai_component("a", "people")), ["rtdetr-v2-r50", "sam2.1-tiny-encoder", "sam2.1-tiny-decoder"]);
    let prompted = component(serde_json::json!({
        "id": "p", "kind": "ai", "target": "subject", "model": "", "modelVersion": "",
        "prompts": [{ "kind": "point", "point": [0.5, 0.5] }]
    }));
    assert_eq!(names(&prompted), ["sam2.1-tiny-encoder", "sam2.1-tiny-decoder"]);
    let kept = nms(
        vec![
            PersonBox { bbox: [0.0, 0.0, 0.5, 0.5], score: 0.9 },
            PersonBox { bbox: [0.02, 0.0, 0.52, 0.5], score: 0.8 },
            PersonBox { bbox: [0.6, 0.6, 0.9, 0.9], score: 0.7 },
        ],
        0.5,
    );
    assert_eq!(kept.len(), 2);
    assert_eq!(kept[1].score, 0.7);
}

/// Subject and Background run U²-Netp (`subject-fast`) only when BiRefNet lite is missing and U²-Netp is installed;
/// the download prompt never offers it. Installs are faked with sparse files of the manifest sizes.
#[test]
fn subject_falls_back_to_u2netp_only_when_birefnet_is_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    let install = |name: &str| {
        let entry = registry().get(name).unwrap();
        for file in &entry.files {
            let path = dir.file_path(entry, file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::File::create(&path).unwrap().set_len(file.bytes).unwrap();
        }
    };
    let names = |c: &MaskComponent| required_models_in(c, Some(&dir)).iter().map(|m| m.name.clone()).collect::<Vec<_>>();
    let missing = |c: &MaskComponent| missing_models(c, &dir).iter().map(|m| m.name.clone()).collect::<Vec<_>>();
    let model_of = |c: &MaskComponent| match &c.shape {
        photobook_develop::settings::MaskShape::Ai { model, model_version, .. } => (model.clone(), model_version.clone()),
        _ => unreachable!(),
    };
    let (subject, background) = (ai_component("s", "subject"), ai_component("b", "background"));
    // Nothing installed: BiRefNet lite is the one to download.
    assert_eq!(names(&subject), ["birefnet-lite"]);
    assert_eq!(missing(&subject), ["birefnet-lite"]);
    assert_eq!(missing(&background), ["birefnet-lite"]);

    install("u2netp");
    assert_eq!(names(&subject), ["u2netp"]);
    assert_eq!(names(&background), ["u2netp"]);
    assert!(missing(&subject).is_empty());
    let fast = stamp_model_in(&subject, Some(&dir));
    let u2netp = registry().get("u2netp").unwrap();
    assert_eq!(model_of(&fast), (u2netp.name.clone(), u2netp.version.clone()));
    assert_ne!(component_hash(&fast), component_hash(&stamp_model_in(&subject, None)));
    // Other targets and prompted components are unaffected.
    assert_eq!(names(&ai_component("k", "sky")), ["skywater-seg"]);
    let prompted = component(serde_json::json!({
        "id": "p", "kind": "ai", "target": "subject", "model": "", "modelVersion": "",
        "prompts": [{ "kind": "point", "point": [0.5, 0.5] }]
    }));
    assert_eq!(names(&prompted), ["sam2.1-tiny-encoder", "sam2.1-tiny-decoder"]);

    install("birefnet-lite");
    assert_eq!(names(&subject), ["birefnet-lite"]);
    // A component made with U²-Netp goes back to BiRefNet lite (the UI shows it as outdated).
    assert_eq!(names(&fast), ["birefnet-lite"]);
    assert_eq!(model_of(&stamp_model_in(&fast, Some(&dir))).0, "birefnet-lite");
}

#[test]
fn prompts_map_from_the_transformed_frame() {
    let img = image_from(40, 20, |_, _| [0.5; 3]);
    let g = Geometry { rotate: Rotation::R90, ..Geometry::default() };
    let frame = InferenceFrame::new(&img, &g);
    assert_eq!((frame.image.width, frame.image.height), (20, 40));
    // No perspective: the transformed frame is the oriented frame.
    let p: Vec<photobook_develop::settings::MaskPrompt> = serde_json::from_value(serde_json::json!([
        { "kind": "point", "point": [0.25, 0.75] }, { "kind": "box", "box": [[0.1, 0.2], [0.3, 0.4]], "positive": false }
    ]))
    .unwrap();
    let q = frame.prompts_in(&p);
    assert_eq!(q[0].point, Some([0.25, 0.75]));
    assert_eq!(q[1].bbox, Some([[0.1, 0.2], [0.3, 0.4]]));
    assert!(!q[1].positive);
    let b = frame.box_to_prompt_frame([0.1, 0.2, 0.3, 0.4]);
    assert_eq!(b, [[0.1, 0.2], [0.3, 0.4]]);
}

// ---------- models (skip when not installed) ----------

fn installed(names: &[&str]) -> Option<ModelDir> {
    let dir = ModelDir::new(models_dir());
    for n in names {
        let entry = registry().get(n).unwrap();
        if ai::status(entry, &dir) != ModelStatus::Installed {
            println!("note: {n} is not installed in {}; skipping", dir.root().display());
            return None;
        }
    }
    Some(dir)
}

#[test]
#[ignore = "downloads every mask model (about 390 MB)"]
fn download_mask_models() {
    let dir = ModelDir::new(models_dir());
    let mut total = 0;
    for name in ["birefnet-lite", "skywater-seg", "rtdetr-v2-r50", "sam2.1-tiny-encoder", "sam2.1-tiny-decoder", "depth-anything-v2-small"] {
        let entry = registry().get(name).unwrap();
        let t = Instant::now();
        download_model(entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
        println!("{name}: {} bytes in {:.1} s", entry.total_bytes(), t.elapsed().as_secs_f64());
        total += entry.total_bytes();
        assert_eq!(ai::status(entry, &dir), ModelStatus::Installed);
    }
    println!("total {total} bytes");
}

/// Print `log` records (the `[photobook:ai]` lines) to stderr.
fn logger() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("{} {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

fn coverage(p: &MaskPlane) -> f64 {
    p.data.iter().filter(|&&v| v >= 0.5).count() as f64 / p.data.len().max(1) as f64 * 100.0
}

/// Mean of a rectangle given in fractions.
fn mean_in(p: &MaskPlane, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let (w, h) = (p.width as f64, p.height as f64);
    let mut s = 0.0;
    let mut n = 0.0;
    for y in (y0 * h) as u32..(y1 * h) as u32 {
        for x in (x0 * w) as u32..(x1 * w) as u32 {
            s += p.get(x, y) as f64;
            n += 1.0;
        }
    }
    s / f64::max(n, 1.0)
}

fn dump(p: &MaskPlane, name: &str) {
    if let Some(dir) = std::env::var_os("PHOTOBOOK_AI_DUMP") {
        write_mask_png(&PathBuf::from(dir).join(format!("{name}.png")), p).unwrap();
    }
}

fn run(target: &str, file: &str, geometry: &Geometry, sessions: &Sessions, sam: &LastSamEncoding, dir: &ModelDir) -> MaskPlane {
    run_component(&ai_component("c", target), file, geometry, sessions, sam, dir)
}

fn run_component(
    c: &MaskComponent,
    file: &str,
    geometry: &Geometry,
    sessions: &Sessions,
    sam: &LastSamEncoding,
    dir: &ModelDir,
) -> MaskPlane {
    let img = decode_file(&fixture(file), Some(1600)).unwrap();
    let stages = std::sync::Mutex::new(Vec::new());
    let progress = |s: Stage| stages.lock().unwrap().push(s.as_str());
    let ctx = GenerateContext { image: &img, image_id: file, geometry, models: dir, sessions, sam: Some(sam), progress: &progress };
    let t = Instant::now();
    let g = generate(c, &ctx).unwrap();
    let total = t.elapsed();
    let runs: Vec<String> = g.timings.iter().map(|(n, d)| format!("{n} {:.0} ms", d.as_secs_f64() * 1000.0)).collect();
    let target = match &c.shape {
        photobook_develop::settings::MaskShape::Ai { target, .. } => format!("{target:?}"),
        _ => unreachable!(),
    };
    println!(
        "{target:<10} {file} {}x{}: coverage {:.1} %, total {:.0} ms (runs: {}), stages {:?}{}",
        g.raster.width,
        g.raster.height,
        coverage(&g.raster),
        total.as_secs_f64() * 1000.0,
        runs.join(", "),
        stages.lock().unwrap(),
        if g.people.is_empty() { String::new() } else { format!(", {} people", g.people.len()) }
    );
    dump(&g.raster, &format!("{target}-{file}"));
    assert_eq!((g.raster.width, g.raster.height), (img.width, img.height));
    g.raster
}

fn print_sessions(sessions: &Sessions, dir: &ModelDir, names: &[&str]) {
    for n in names {
        let s = sessions.get(registry().get(n).unwrap(), dir).unwrap();
        let i = s.info();
        println!("  {n}: {} (load {:.1} s)", i.provider_summary(), i.load_time.as_secs_f64());
    }
}

#[test]
#[ignore = "runs BiRefNet lite on real photos"]
fn subject_on_real_photos() {
    logger();
    let Some(dir) = installed(&["birefnet-lite"]) else { return };
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let g = Geometry::default();
    // The pastry on a plate: a centred, well separated subject.
    let m = run("subject", "IMG_10.jpg", &g, &sessions, &sam, &dir);
    assert!(mean_in(&m, 0.45, 0.4, 0.55, 0.6) > 0.8, "the pastry is the subject");
    assert!(mean_in(&m, 0.0, 0.0, 0.1, 0.1) < 0.1, "the corner is not");
    for f in ["IMG_01.jpg", "IMG_09.jpg", "IMG_13.jpg"] {
        run("subject", f, &g, &sessions, &sam, &dir);
    }
    // Again, warm.
    run("subject", "IMG_10.jpg", &g, &sessions, &sam, &dir);
    // Rotated: the same mask comes back on the source grid.
    let turned = run("subject", "IMG_10.jpg", &Geometry { rotate: Rotation::R90, ..g.clone() }, &sessions, &sam, &dir);
    let diff = m.data.iter().zip(&turned.data).map(|(a, b)| (a - b).abs() as f64).sum::<f64>() / m.data.len() as f64;
    println!("  rotate 90 vs upright: mean abs difference {diff:.4}");
    run("background", "IMG_10.jpg", &g, &sessions, &sam, &dir);
    print_sessions(&sessions, &dir, &["birefnet-lite"]);
}

#[test]
#[ignore = "runs SkyWater-Seg on real photos"]
fn sky_on_real_photos() {
    logger();
    let Some(dir) = installed(&["skywater-seg"]) else { return };
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let g = Geometry::default();
    // The arch square: blue sky with white clouds over a pale stone building.
    let m = run("sky", "IMG_02.jpg", &g, &sessions, &sam, &dir);
    assert!(mean_in(&m, 0.0, 0.0, 1.0, 0.15) > 0.8, "the top is sky");
    assert!(mean_in(&m, 0.0, 0.75, 1.0, 1.0) < 0.05, "the square is not");
    // The arch itself (pale stone against the sky) must be excluded.
    println!("  IMG_02 arch top (0.45..0.55 × 0.3..0.4) sky mean {:.3}", mean_in(&m, 0.45, 0.3, 0.55, 0.4));
    for f in ["IMG_03.jpg", "IMG_04.jpg", "IMG_11.jpg", "IMG_16.jpg"] {
        run("sky", f, &g, &sessions, &sam, &dir);
    }
    print_sessions(&sessions, &dir, &["skywater-seg"]);
}

#[test]
#[ignore = "runs RT-DETR and SAM 2.1 on real photos"]
fn people_on_real_photos() {
    logger();
    let Some(dir) = installed(&["rtdetr-v2-r50", "sam2.1-tiny-encoder", "sam2.1-tiny-decoder"]) else { return };
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let g = Geometry::default();
    for f in ["IMG_02.jpg", "IMG_12.jpg", "IMG_10.jpg"] {
        run("people", f, &g, &sessions, &sam, &dir);
    }
    // Click-to-refine on the cached encoding: a point on the pastry.
    let click = component(serde_json::json!({
        "id": "p", "kind": "ai", "target": "subject", "model": "", "modelVersion": "",
        "prompts": [{ "kind": "point", "point": [0.5, 0.5] }]
    }));
    let m = run_component(&click, "IMG_10.jpg", &g, &sessions, &sam, &dir);
    let again = run_component(&click, "IMG_10.jpg", &g, &sessions, &sam, &dir);
    assert_eq!(m, again);
    assert!(mean_in(&m, 0.47, 0.45, 0.53, 0.55) > 0.8, "the clicked pastry is selected");
    let boxed = component(serde_json::json!({
        "id": "b", "kind": "ai", "target": "subject", "model": "", "modelVersion": "",
        "prompts": [{ "kind": "box", "box": [[0.3, 0.2], [0.7, 0.8]] }]
    }));
    run_component(&boxed, "IMG_10.jpg", &g, &sessions, &sam, &dir);
    print_sessions(&sessions, &dir, &["rtdetr-v2-r50", "sam2.1-tiny-encoder", "sam2.1-tiny-decoder"]);
}

#[test]
#[ignore = "runs Depth Anything V2 on real photos"]
fn depth_on_real_photos() {
    logger();
    let Some(dir) = installed(&["depth-anything-v2-small"]) else { return };
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let g = Geometry::default();
    let near = component(serde_json::json!({
        "id": "d", "kind": "ai", "target": "depth", "model": "", "modelVersion": "", "depthRange": [0.0, 0.3]
    }));
    for f in ["IMG_12.jpg", "IMG_06.jpg", "IMG_05.jpg"] {
        let m = run_component(&near, f, &g, &sessions, &sam, &dir);
        println!("  near third: bottom-centre mean {:.2}, top-centre mean {:.2}", mean_in(&m, 0.4, 0.85, 0.6, 1.0), mean_in(&m, 0.4, 0.0, 0.6, 0.15));
    }
    print_sessions(&sessions, &dir, &["depth-anything-v2-small"]);
}

#[test]
#[ignore = "compares BiRefNet's execution providers"]
fn birefnet_providers() {
    logger();
    let Some(dir) = installed(&["birefnet-lite"]) else { return };
    let entry = registry().get("birefnet-lite").unwrap();
    let img = decode_file(&fixture("IMG_10.jpg"), Some(1600)).unwrap();
    let input = prepare(&img, 1024, 1024, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear).unwrap();
    let which = std::env::var("PHOTOBOOK_EP").unwrap_or_else(|_| "nn".into());
    let mut opts = ai::SessionOptions::for_model(entry, &dir);
    match which.as_str() {
        "nn" => {
            opts.ml_program = false;
            opts.cache_dir = Some(std::env::temp_dir().join("photobook-birefnet-nn"));
        }
        "cpu" => opts = opts.cpu(),
        _ => {}
    }
    let t = Instant::now();
    let s = ai::Session::load(&dir.primary_path(entry), &opts).unwrap();
    println!("{which}: load {:.1} s, {}", t.elapsed().as_secs_f64(), s.info().provider_summary());
    for _ in 0..3 {
        let t = Instant::now();
        s.run(&[("input_image", ai::runtime::Tensor::F32(input.tensor.view().into_dyn()))]).unwrap();
        println!("{which}: run {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
    }
}

#[test]
#[ignore = "downloads BiRefNet lite and compares CoreML with the fp16 CPU reference"]
fn birefnet_coreml_probe() {
    logger();
    let dir = ModelDir::new(models_dir());
    let entry = registry().get("birefnet-lite").unwrap();
    download_model(entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(ai::status(entry, &dir), ModelStatus::Installed);
    // Updating the model removes the old version folder, and the `coreml-unsupported` marker with it.
    let siblings: Vec<_> = std::fs::read_dir(dir.model_root(entry)).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(siblings, [std::ffi::OsString::from(entry.version.as_str())], "older versions are pruned");
    let marker = dir.version_dir(entry).join(photobook_develop::ai::segment::COREML_UNSUPPORTED);
    println!("marker for {}: {}", entry.version, marker.is_file());

    // CoreML on the pinned model (load_session also writes the marker when CoreML falls back).
    let t = Instant::now();
    let session = photobook_develop::ai::segment::load_session(entry, &dir).unwrap();
    println!("coreml load {:.1} s: {}", t.elapsed().as_secs_f64(), session.info().provider_summary());
    session.log_compute_plan();
    println!("unsupported ops: {:?}", session.info().unsupported_ops);
    println!("marker written: {}", marker.is_file());

    let synthetic = image_from(1024, 1024, |x, y| if (256..768).contains(&x) && (256..768).contains(&y) { [0.8, 0.3, 0.2] } else { [0.2, 0.4, 0.7] });
    let synth_in = prepare(&synthetic, 1024, 1024, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear).unwrap();
    let photo = decode_file(&fixture("IMG_10.jpg"), Some(1600)).unwrap();
    let photo_in = prepare(&photo, 1024, 1024, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear).unwrap();
    let go = |s: &ai::Session, t: &ai::preprocess::ModelInput| {
        let started = Instant::now();
        let out = s.run(&[("input_image", ai::runtime::Tensor::F32(t.tensor.view().into_dyn()))]).unwrap();
        (started.elapsed(), out.first().unwrap().clone())
    };
    for i in 0..4 {
        let (d, _) = go(&session, &synth_in);
        println!("synthetic 1024 run {i}: {:.0} ms ({})", d.as_secs_f64() * 1000.0, session.info().provider_summary());
    }
    let (d, coreml) = go(&session, &photo_in);
    println!("photo run on {}: {:.0} ms", session.info().provider_summary(), d.as_secs_f64() * 1000.0);

    // The fp16 CPU reference (PHOTOBOOK_BIREFNET_REF = path to the old model_fp16.onnx).
    let Some(reference) = std::env::var_os("PHOTOBOOK_BIREFNET_REF") else { return };
    let cpu = ai::Session::load(std::path::Path::new(&reference), &ai::SessionOptions::for_model(entry, &dir).cpu()).unwrap();
    let mut last = (std::time::Duration::ZERO, Default::default());
    for _ in 0..2 {
        last = go(&cpu, &photo_in);
    }
    println!("fp16 CPU photo run: {:.0} ms", last.0.as_secs_f64() * 1000.0);
    let sig = |v: f32| 1.0 / (1.0 + (-v).exp());
    let n = coreml.len() as f64;
    let mad = coreml.iter().zip(last.1.iter()).map(|(a, b)| (sig(*a) - sig(*b)).abs() as f64).sum::<f64>() / n;
    let flips = coreml.iter().zip(last.1.iter()).filter(|(a, b)| (sig(**a) >= 0.5) != (sig(**b) >= 0.5)).count() as f64 / n * 100.0;
    println!("mask difference vs fp16 CPU (1024 sigmoid): mean abs {mad:.4}, {flips:.2} % of pixels change side of 0.5");
}

/// Subject through `generate` in a model folder holding only U²-Netp (linked from the real one): the fallback runs the
/// fast model end to end and stamps it, and the mask agrees with BiRefNet lite's when that one is installed too.
#[test]
#[ignore = "needs U2-Netp installed; runs it through generate on a real photo"]
fn subject_fast_through_generate() {
    logger();
    let Some(real) = installed(&["u2netp"]) else { return };
    let tmp = tempfile::tempdir().unwrap();
    let only = ModelDir::new(tmp.path());
    let entry = registry().get("u2netp").unwrap();
    std::fs::create_dir_all(only.version_dir(entry).parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(real.version_dir(entry), only.version_dir(entry)).unwrap();
    let img = decode_file(&fixture("IMG_10.jpg"), Some(1600)).unwrap();
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let progress = |_: Stage| {};
    let g = Geometry::default();
    let ctx = GenerateContext { image: &img, image_id: "IMG_10", geometry: &g, models: &only, sessions: &sessions, sam: Some(&sam), progress: &progress };
    let t = Instant::now();
    let out = generate(&ai_component("c", "subject"), &ctx).unwrap();
    println!("u2netp subject via generate: {:.0} ms, coverage {:.1} %", t.elapsed().as_secs_f64() * 1000.0, coverage(&out.raster));
    match &out.component.shape {
        photobook_develop::settings::MaskShape::Ai { model, .. } => assert_eq!(model, "u2netp"),
        _ => unreachable!(),
    }
    assert_eq!((out.raster.width, out.raster.height), (img.width, img.height));
    let cov = coverage(&out.raster);
    assert!(cov > 2.0 && cov < 90.0, "coverage {cov}");
    if registry().get("birefnet-lite").is_some_and(|e| ai::status(e, &real) == ModelStatus::Installed) {
        let reference = run("subject", "IMG_10.jpg", &g, &Sessions::default(), &LastSamEncoding::default(), &real);
        let (mut inter, mut union) = (0.0, 0.0);
        for (a, b) in out.raster.data.iter().zip(&reference.data) {
            let (a, b) = (*a >= 0.5, *b >= 0.5);
            inter += (a && b) as u8 as f64;
            union += (a || b) as u8 as f64;
        }
        let iou = inter / union.max(1.0);
        println!("IoU with BiRefNet lite: {iou:.3}");
        assert!(iou > 0.8, "IoU {iou}");
    }
}

#[test]
#[ignore = "downloads U2-Netp (4.7 MB) and times it against BiRefNet lite on a real photo"]
fn u2netp_probe() {
    logger();
    let dir = ModelDir::new(models_dir());
    let entry = registry().get("u2netp").unwrap();
    download_model(entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    let t = Instant::now();
    let session = photobook_develop::ai::segment::load_session(entry, &dir).unwrap();
    println!("u2netp load {:.1} s: {}", t.elapsed().as_secs_f64(), session.info().provider_summary());
    session.log_compute_plan();
    println!("outputs {:?}", session.info().outputs);
    println!("marker written: {}", dir.version_dir(entry).join(photobook_develop::ai::segment::COREML_UNSUPPORTED).is_file());
    let photo = decode_file(&fixture("IMG_10.jpg"), Some(1600)).unwrap();
    let input = prepare(&photo, 320, 320, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear).unwrap();
    let mut last = Default::default();
    for i in 0..5 {
        let t = Instant::now();
        let out = session.run(&[("input.1", ai::runtime::Tensor::F32(input.tensor.view().into_dyn()))]).unwrap();
        println!("u2netp run {i}: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        last = out.first().unwrap().clone();
    }
    let (lo, hi) = last.iter().fold((f32::MAX, f32::MIN), |(l, h), &v| (l.min(v), h.max(v)));
    println!("u2netp output shape {:?}, range {lo:.3} .. {hi:.3}", last.shape());
    // The same photo through BiRefNet lite (when installed): agreement of the two masks on the picture.
    let Some(dir) = installed(&["birefnet-lite"]) else { return };
    let (sessions, sam) = (Sessions::default(), LastSamEncoding::default());
    let reference = run("subject", "IMG_10.jpg", &Geometry::default(), &sessions, &sam, &dir);
    let fast = photobook_develop::ai::preprocess::unletterbox(last.as_slice().unwrap(), 320, 320, &input.frame, photo.width, photo.height).unwrap();
    let n = fast.data.len() as f64;
    let mad = fast.data.iter().zip(&reference.data).map(|(a, b)| (a - b).abs() as f64).sum::<f64>() / n;
    let (mut inter, mut union) = (0.0, 0.0);
    for (a, b) in fast.data.iter().zip(&reference.data) {
        let (a, b) = (*a >= 0.5, *b >= 0.5);
        inter += (a && b) as u8 as f64;
        union += (a || b) as u8 as f64;
    }
    println!("u2netp vs BiRefNet lite on IMG_10: mean abs {mad:.4}, IoU at 0.5 {:.3}; coverage {:.1} % vs {:.1} %", inter / union.max(1.0), coverage(&fast), coverage(&reference));
}
