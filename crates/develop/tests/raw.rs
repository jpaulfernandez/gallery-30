//! D6.1 RAW input. No binary fixtures: a tiny DNG (uncompressed 16-bit RGGB mosaic, 64×48, dual-illuminant
//! colour matrices, `AsShotNeutral`, black/white levels, `BaselineExposure`, `Orientation`) is written by the
//! minimal TIFF writer below. The `#[ignore]` test runs on real files when there are any (read only):
//! `PHOTOBOOK_RAW_DIR` or `~/Pictures/ON1 Samples`.
//!
//! `cargo test -p photobook-develop --test raw` (add `--release -- --ignored --nocapture` for the real files).
#![cfg(feature = "raw")]

use std::path::{Path, PathBuf};
use std::time::Instant;

use photobook_develop::color::camera::{CameraColor, CameraMatrix};
use photobook_develop::color::matrix::{self, REC2020_LUMA};
use photobook_develop::color::temperature::{temperature_from_xy, xy_from_temperature};
use photobook_develop::color::transfer;
use photobook_develop::decode::raw::{embedded_preview as raw_preview, raw_info, DEFAULT_BASELINE_EXPOSURE};
use photobook_develop::decode::{camera_as_shot_kelvin_tint, decode_raw, is_raw_path, RawDecoded};
use photobook_develop::gpu::RenderBackend;
use photobook_develop::ops::white_balance::{white_balance, WhiteBalanceParams};
use photobook_develop::settings::WhiteBalance;
use photobook_develop::{
    decode_file, render_full, render_full_with_options, render_preview, render_preview_with, DevelopSettings, Developer,
    ImageMeta, LinearImage, Quality, RenderOptions,
};

// ---------- a minimal little-endian TIFF/DNG writer ----------

struct Tag {
    code: u16,
    kind: u16,
    count: u32,
    bytes: Vec<u8>,
}

fn byte(code: u16, v: &[u8]) -> Tag {
    Tag { code, kind: 1, count: v.len() as u32, bytes: v.to_vec() }
}
fn ascii(code: u16, s: &str) -> Tag {
    let mut bytes = s.as_bytes().to_vec();
    bytes.push(0);
    Tag { code, kind: 2, count: bytes.len() as u32, bytes }
}
fn short(code: u16, v: &[u16]) -> Tag {
    Tag { code, kind: 3, count: v.len() as u32, bytes: v.iter().flat_map(|x| x.to_le_bytes()).collect() }
}
fn long(code: u16, v: &[u32]) -> Tag {
    Tag { code, kind: 4, count: v.len() as u32, bytes: v.iter().flat_map(|x| x.to_le_bytes()).collect() }
}
fn rational(code: u16, v: &[f64]) -> Tag {
    let bytes = v.iter().flat_map(|x| [((x * 1e6).round() as u32).to_le_bytes(), 1_000_000u32.to_le_bytes()].concat()).collect();
    Tag { code, kind: 5, count: v.len() as u32, bytes }
}
fn srational(code: u16, v: &[f64]) -> Tag {
    let bytes = v.iter().flat_map(|x| [((x * 1e4).round() as i32).to_le_bytes(), 10_000i32.to_le_bytes()].concat()).collect();
    Tag { code, kind: 10, count: v.len() as u32, bytes }
}

/// One IFD (the raw image), the strip right after the header.
fn write_tiff(mut tags: Vec<Tag>, strip: &[u8]) -> Vec<u8> {
    tags.sort_by_key(|t| t.code);
    let ifd_offset = 8 + strip.len() as u32 + (strip.len() as u32 & 1);
    let mut out = b"II*\0".to_vec();
    out.extend(ifd_offset.to_le_bytes());
    out.extend(strip);
    if out.len() % 2 == 1 {
        out.push(0);
    }
    let mut extra_offset = ifd_offset + 2 + 12 * tags.len() as u32 + 4;
    let mut extra = Vec::new();
    out.extend((tags.len() as u16).to_le_bytes());
    for t in &tags {
        out.extend(t.code.to_le_bytes());
        out.extend(t.kind.to_le_bytes());
        out.extend(t.count.to_le_bytes());
        if t.bytes.len() <= 4 {
            let mut v = t.bytes.clone();
            v.resize(4, 0);
            out.extend(v);
        } else {
            out.extend(extra_offset.to_le_bytes());
            extra.extend(&t.bytes);
            if t.bytes.len() % 2 == 1 {
                extra.push(0);
            }
            extra_offset = ifd_offset + 2 + 12 * tags.len() as u32 + 4 + extra.len() as u32;
        }
    }
    out.extend(0u32.to_le_bytes());
    out.extend(extra);
    out
}

// ---------- the synthetic camera and scene ----------

const W: usize = 64;
const H: usize = 48;
const BLACK: f64 = 256.0;
const WHITE: f64 = 16383.0;
const SHOT_KELVIN: f64 = 3200.0;
/// Reflectance of the grey patch, i.e. its value after white balance.
const GREY: f64 = 0.4;

/// XYZ → camera, with the shape of published Bayer matrices (4 decimals, as written to the file).
const CM_A: [[f64; 3]; 3] = [[0.7000, -0.1600, -0.0300], [-0.3900, 1.1200, 0.3000], [-0.0500, 0.1200, 0.7000]];
const CM_D65: [[f64; 3]; 3] = [[0.6722, -0.0635, -0.0963], [-0.4287, 1.2460, 0.2028], [-0.0908, 0.2162, 0.5668]];

fn camera() -> CameraColor {
    let matrices = vec![
        CameraMatrix { temperature: 2850.0, xyz_to_camera: CM_A },
        CameraMatrix { temperature: 6500.0, xyz_to_camera: CM_D65 },
    ];
    let probe = CameraColor::new(matrices.clone(), None).unwrap();
    let neutral = probe.xy_to_neutral(xy_from_temperature(SHOT_KELVIN, 0.0));
    CameraColor::new(matrices, Some(neutral)).unwrap()
}

/// Camera RGB (0..1 of the white level) of the three vertical bands: a grey card lit by the as-shot light, a
/// warm-coloured patch and a blown highlight.
fn scene(x: usize, neutral: [f64; 3]) -> [f64; 3] {
    match x {
        0..21 => neutral.map(|n| GREY * n),
        21..42 => [0.30, 0.15, 0.04],
        _ => [1.0, 1.0, 1.0],
    }
}

struct Dng {
    orientation: u16,
    baseline_exposure: f64,
}

fn write_dng(dir: &Path, name: &str, opts: Dng) -> PathBuf {
    let neutral = camera().as_shot_neutral;
    let mut strip = Vec::with_capacity(W * H * 2);
    for y in 0..H {
        for x in 0..W {
            // RGGB
            let c = match (y % 2, x % 2) {
                (0, 0) => 0,
                (1, 1) => 2,
                _ => 1,
            };
            let v = scene(x, neutral)[c];
            let raw = (BLACK + v * (WHITE - BLACK)).round().clamp(0.0, 65535.0) as u16;
            strip.extend(raw.to_le_bytes());
        }
    }
    let flat = |m: [[f64; 3]; 3]| m.iter().flatten().copied().collect::<Vec<_>>();
    let mut tags = vec![
        long(254, &[0]),
        long(256, &[W as u32]),
        long(257, &[H as u32]),
        short(258, &[16]),
        short(259, &[1]),
        short(262, &[32803]),
        ascii(271, "Photobook"),
        ascii(272, "Synthetic"),
        long(273, &[8]),
        short(274, &[opts.orientation]),
        short(277, &[1]),
        long(278, &[H as u32]),
        long(279, &[(W * H * 2) as u32]),
        short(284, &[1]),
        short(33421, &[2, 2]),
        byte(33422, &[0, 1, 1, 2]),
        byte(50706, &[1, 4, 0, 0]),
        ascii(50708, "Photobook Synthetic"),
        short(50714, &[BLACK as u16]),
        short(50717, &[WHITE as u16]),
        srational(50721, &flat(CM_A)),
        srational(50722, &flat(CM_D65)),
        rational(50728, &neutral),
        short(50778, &[17]),
        short(50779, &[21]),
    ];
    // NaN leaves the tag out.
    if !opts.baseline_exposure.is_nan() {
        tags.push(srational(50730, &[opts.baseline_exposure]));
    }
    let path = dir.join(name);
    std::fs::write(&path, write_tiff(tags, &strip)).unwrap();
    path
}

fn decode(dir: &Path, opts: Dng, max_long_edge: Option<u32>) -> RawDecoded {
    let path = write_dng(dir, "synthetic.dng", opts);
    decode_raw(&path, max_long_edge).unwrap()
}

fn plain() -> Dng {
    Dng { orientation: 1, baseline_exposure: 0.0 }
}

/// Mean of a 5×5 block centred on `(x, y)`.
fn mean(img: &LinearImage, x: u32, y: u32) -> [f32; 3] {
    let mut sum = [0.0f32; 3];
    for dy in 0..5 {
        for dx in 0..5 {
            let p = img.pixel(x + dx - 2, y + dy - 2);
            for c in 0..3 {
                sum[c] += p[c] / 25.0;
            }
        }
    }
    sum
}

fn assert_neutral(p: [f32; 3], level: f32, what: &str) {
    for c in 0..3 {
        assert!((p[c] - level).abs() / level < 0.01, "{what}: {p:?}, expected {level} on every channel");
    }
}

// Band centres in source columns: grey 10, colour 31, highlight 53; rows are uniform (sample row 24).

#[test]
fn synthetic_dng_decodes_neutral_and_upright() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), Dng { orientation: 6, baseline_exposure: 0.0 }, None);
    let img = &raw.image;
    // Orientation 6 (rotate 90° clockwise to view): 64×48 → 48×64, source columns become rows.
    assert_eq!((img.width, img.height), (H as u32, W as u32));
    assert_eq!(raw.camera.orientation, 6);
    assert!(img.meta.is_raw);
    assert_eq!((raw.camera.make.as_str(), raw.camera.model.as_str()), ("Photobook", "Synthetic"));
    assert_eq!(raw.camera.color_matrices.len(), 2);
    assert_eq!(raw.camera.black_level[0], BLACK as f32);
    assert_eq!(raw.camera.white_level[0], WHITE as f32);

    // The grey card is neutral after the as-shot white balance, at its reflectance.
    assert_neutral(mean(img, 24, 10), GREY as f32, "grey card");
    // The blown highlight is clipped to white, not magenta.
    assert_neutral(mean(img, 24, 53), 1.0, "highlight");
    // The warm patch stays warm.
    let warm = mean(img, 24, 31);
    assert!(warm[0] > warm[1] && warm[1] > warm[2], "{warm:?}");

    // decode_file dispatches on the extension and returns the same image.
    let via_file = decode_file(&dir.path().join("synthetic.dng"), None).unwrap();
    assert_eq!(&via_file, img);
}

#[test]
fn as_shot_temperature_is_recovered_through_the_matrix() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), plain(), None);
    let (k, tint) = camera_as_shot_kelvin_tint(&raw.camera);
    assert!((k - SHOT_KELVIN).abs() < 15.0, "{k}");
    assert!(tint.abs() < 0.5, "{tint}");
    assert_eq!(raw.image.meta.as_shot, Some((k, tint)));
    // The multipliers are the inverse neutral, smallest 1.
    let n = raw.camera.as_shot_neutral;
    let m = raw.camera.wb_multipliers;
    assert!((m.iter().copied().fold(f32::MAX, f32::min) - 1.0).abs() < 1e-6);
    for c in 0..3 {
        assert!((m[c] * n[c] - 1.0).abs() < 1e-5, "{m:?} {n:?}");
    }
}

#[test]
fn baseline_exposure_plus_one_doubles() {
    let dir = tempfile::tempdir().unwrap();
    let base = decode(dir.path(), plain(), None);
    let plus = decode(dir.path(), Dng { orientation: 1, baseline_exposure: 1.0 }, None);
    assert_eq!(plus.camera.baseline_exposure, 1.0);
    let (a, b) = (mean(&base.image, 10, 24), mean(&plus.image, 10, 24));
    for c in 0..3 {
        assert!((b[c] / a[c] - 2.0).abs() < 0.01, "{a:?} → {b:?}");
    }
    assert_neutral(b, 2.0 * GREY as f32, "grey at +1 EV");
}

#[test]
fn a_raw_without_baseline_exposure_gets_the_default() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), Dng { orientation: 1, baseline_exposure: f64::NAN }, None);
    assert_eq!(raw.camera.baseline_exposure, DEFAULT_BASELINE_EXPOSURE);
    let gain = 2f32.powf(DEFAULT_BASELINE_EXPOSURE);
    assert_neutral(mean(&raw.image, 10, 24), gain * GREY as f32, "grey at the default baseline");
}

#[test]
fn raw_renders_with_the_display_look_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), plain(), None);
    assert!(RenderOptions::for_image(&raw.image.meta).look);
    assert!(!RenderOptions::for_image(&ImageMeta::default()).look);
    let cpu = |look| RenderOptions { look, backend: RenderBackend::Cpu, ..RenderOptions::default() };
    let settings = DevelopSettings::default();
    let with_look = render_full_with_options(&raw.image, &settings, Quality::Export, &cpu(true)).unwrap();
    let without = render_full_with_options(&raw.image, &settings, Quality::Export, &cpu(false)).unwrap();
    assert_ne!(with_look, without);
    // The defaults pick the look for RAW (backend Auto: compare against the same backend).
    let auto = RenderOptions { look: true, ..RenderOptions::default() };
    assert_eq!(render_full(&raw.image, &settings).unwrap(), render_full_with_options(&raw.image, &settings, Quality::for_size(raw.image.width, raw.image.height), &auto).unwrap());
    let preview = render_preview(&raw.image, &settings, 32, 90).unwrap();
    assert_eq!(preview, render_preview_with(&raw.image, &settings, 32, 90, &auto).unwrap());
    // A rendered file keeps the look off.
    let plain_image = LinearImage::new(raw.image.width, raw.image.height, raw.image.data.clone());
    let off = RenderOptions { look: false, ..RenderOptions::default() };
    assert_eq!(
        render_full(&plain_image, &settings).unwrap(),
        render_full_with_options(&plain_image, &settings, Quality::for_size(plain_image.width, plain_image.height), &off).unwrap()
    );
    // So does a `Developer` without explicit options: the look for the RAW, not for the rendered file.
    assert_eq!(Developer::new(raw.image.clone()).render(&settings), Developer::new(raw.image.clone()).render_with(&settings, &auto));
    assert_eq!(Developer::new(plain_image.clone()).render(&settings), Developer::new(plain_image).render_with(&settings, &off));
}

#[test]
fn absolute_white_balance_is_relative_to_as_shot() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), plain(), None);
    let img = &raw.image;
    let (k, tint) = img.meta.as_shot.unwrap();
    let at = |temperature: f64, tint: f64| {
        WhiteBalanceParams::for_image(&WhiteBalance::Absolute { temperature, tint }, &img.meta).unwrap()
    };

    // At the as-shot values: a no-op within 1 %.
    let same = at(k, tint);
    for (x, y) in [(10, 24), (31, 24), (53, 24)] {
        let p = mean(img, x, y);
        let mut q = p;
        white_balance(&mut q, &same);
        for c in 0..3 {
            assert!((q[c] - p[c]).abs() <= 0.01 * p[c].abs().max(0.01), "({x}, {y}): {p:?} → {q:?}");
        }
    }

    // Warmer: a higher Kelvin than as-shot says the light was bluer, so the picture warms (R/B up), and cooler
    // the other way.
    let grey = mean(img, 10, 24);
    let ratio = |p: [f32; 3]| p[0] / p[2];
    let mut warm = grey;
    white_balance(&mut warm, &at(k + 2000.0, tint));
    let mut cool = grey;
    white_balance(&mut cool, &at(k - 800.0, tint));
    assert!(ratio(warm) > ratio(grey) * 1.1, "{grey:?} → {warm:?}");
    assert!(ratio(cool) < ratio(grey) / 1.1, "{grey:?} → {cool:?}");

    // Re-balancing to another white matches a camera that recorded that white as its neutral: the grey card
    // shot under 3200 K and balanced for 3200 K is neutral; balanced instead for D65 it must match what the
    // matrix predicts for a 3200 K grey seen with D65 multipliers.
    let cam = camera();
    let d65 = xy_from_temperature(6500.0, 0.0);
    let rebalance = cam.rebalance_rec2020(d65);
    let predicted = matrix::apply(&cam.camera_to_rec2020(d65, cam.xy_to_neutral(d65)), cam.as_shot_neutral.map(|v| v * GREY));
    let actual = matrix::apply(&rebalance, [GREY; 3]);
    for c in 0..3 {
        assert!((predicted[c] - actual[c]).abs() < 1e-7, "{predicted:?} vs {actual:?}");
    }

    // End to end through the Developer (CPU): Absolute at the as-shot values renders like As Shot.
    let dev = Developer::new(img.clone());
    let options = RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() };
    let shot = dev.render_with(&DevelopSettings::default(), &options);
    let mut settings = DevelopSettings::default();
    settings.white_balance = WhiteBalance::Absolute { temperature: k, tint };
    let absolute = dev.render_with(&settings, &options);
    let max_diff = shot.data.iter().zip(&absolute.data).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
    assert!(max_diff <= 2, "max 8-bit difference {max_diff}");
}

#[test]
fn downscale_respects_max_long_edge() {
    let dir = tempfile::tempdir().unwrap();
    let raw = decode(dir.path(), Dng { orientation: 6, baseline_exposure: 0.0 }, Some(32));
    assert_eq!((raw.image.width, raw.image.height), (24, 32));
    assert!(raw.image.meta.is_raw && raw.image.meta.camera.is_some());
    // Still neutral after the linear-light resize (grey band: output rows 0..10 at this scale).
    assert_neutral(mean(&raw.image, 12, 4), GREY as f32, "downscaled grey");
    // Larger than the image: untouched.
    let full = decode(dir.path(), plain(), Some(4000));
    assert_eq!((full.image.width, full.image.height), (W as u32, H as u32));
}

#[test]
fn unknown_and_broken_files_are_errors() {
    let dir = tempfile::tempdir().unwrap();
    let junk = dir.path().join("junk.cr3");
    std::fs::write(&junk, b"not a raw file at all").unwrap();
    assert!(decode_raw(&junk, None).is_err());
    assert!(decode_file(&junk, None).is_err());
    assert!(is_raw_path(Path::new("a/B.ARW")) && is_raw_path(Path::new("x.dng")) && !is_raw_path(Path::new("x.jpg")));
}

// ---------- real files (read only, never copied) ----------

/// Mean linear Rec.2020 of an sRGB 8-bit buffer and of a render, for a rough comparison with the camera JPEG.
fn srgb8_mean_linear(data: &[u8]) -> [f64; 3] {
    let m = matrix::srgb_to_rec2020();
    let mut sum = [0.0f64; 3];
    for p in data.chunks_exact(3) {
        let rgb = [0, 1, 2].map(|c| transfer::srgb_to_linear(p[c] as f32 / 255.0) as f64);
        let rec = matrix::apply(&m, rgb);
        for c in 0..3 {
            sum[c] += rec[c];
        }
    }
    let n = (data.len() / 3).max(1) as f64;
    sum.map(|v| v / n)
}

fn grey_world_kelvin(mean: [f64; 3]) -> f64 {
    temperature_from_xy(matrix::xyz_to_xy(matrix::apply(&matrix::rec2020_to_xyz(), mean))).0
}

#[test]
#[ignore = "needs real RAW files: PHOTOBOOK_RAW_DIR or ~/Pictures/ON1 Samples; run with --release"]
fn real_raw_files() {
    let dir = std::env::var_os("PHOTOBOOK_RAW_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples"));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("no RAW directory at {}", dir.display());
        return;
    };
    let mut files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| is_raw_path(p)).collect();
    files.sort();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let t0 = Instant::now();
        let full = match decode_raw(&path, None) {
            Ok(r) => r,
            Err(err) => {
                eprintln!("{name}: FAILED {err}");
                continue;
            }
        };
        let full_ms = t0.elapsed().as_millis();
        // The scan's metadata-only read agrees with the decode.
        let t2 = Instant::now();
        let info = raw_info(&path).unwrap();
        let info_ms = t2.elapsed().as_millis();
        assert_eq!((info.width, info.height), (full.image.width, full.image.height), "{name}: raw_info size");
        assert_eq!(info.orientation, full.camera.orientation, "{name}");
        assert_eq!(Some(info.as_shot), full.image.meta.as_shot, "{name}");
        let t3 = Instant::now();
        let preview = raw_preview(&path, 1024).map(|p| (p.width, p.height));
        let preview_ms = t3.elapsed().as_millis();
        eprintln!("{name}: raw_info {info_ms} ms; embedded preview {preview:?} in {preview_ms} ms");
        let t1 = Instant::now();
        let small = decode_raw(&path, Some(1600)).unwrap();
        let small_ms = t1.elapsed().as_millis();
        let cam = &full.camera;
        let (k, tint) = camera_as_shot_kelvin_tint(cam);
        let finite = full.image.data.iter().all(|v| v.is_finite());
        let y: f64 = full.image.data.chunks_exact(3).map(|p| (0..3).map(|c| REC2020_LUMA[c] as f64 * p[c] as f64).sum::<f64>()).sum::<f64>()
            / (full.image.data.len() / 3) as f64;

        // Compare with the camera's embedded JPEG: render with the display look, then mean exposure and
        // grey-world temperature of both (rough: different tone curves and crops).
        let mut cmp = String::from("no embedded preview");
        if let Some(preview) = embedded_preview(&path) {
            let dev = Developer::new(small.image.clone());
            let options = RenderOptions { look: true, backend: RenderBackend::Cpu, ..RenderOptions::default() };
            let ours = srgb8_mean_linear(&dev.render_with(&DevelopSettings::default(), &options).data);
            let theirs = srgb8_mean_linear(&preview);
            let luma = |m: [f64; 3]| (0..3).map(|c| REC2020_LUMA[c] as f64 * m[c]).sum::<f64>();
            cmp = format!(
                "vs camera JPEG: {:+.2} EV, grey world {:.0} K vs {:.0} K",
                (luma(ours) / luma(theirs)).log2(),
                grey_world_kelvin(ours),
                grey_world_kelvin(theirs)
            );
        }
        eprintln!(
            "{name}: {} {} | {}x{} orient {} | as shot {:.0} K tint {:+.1} | BE {:+.2} | ISO {:?} | {} matrices | mean Y {:.3} finite {} | full {} ms, 1600px {} ms | {}",
            cam.make,
            cam.model,
            full.image.width,
            full.image.height,
            cam.orientation,
            k,
            tint,
            cam.baseline_exposure,
            cam.iso,
            cam.color_matrices.len(),
            y,
            finite,
            full_ms,
            small_ms,
            cmp
        );
        assert!(finite, "{name}: non-finite values");
    }
}

/// The largest embedded JPEG (full-size or preview) as 8-bit RGB, through rawler.
fn embedded_preview(path: &Path) -> Option<Vec<u8>> {
    use rawler::decoders::RawDecodeParams;
    let source = rawler::rawsource::RawSource::new(path).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let params = RawDecodeParams::default();
    let img = decoder
        .full_image(&source, &params)
        .ok()
        .flatten()
        .or_else(|| decoder.preview_image(&source, &params).ok().flatten())?;
    Some(img.to_rgb8().into_raw())
}

/// Workflow plan 36 (platform budgets): full render time of a 24 MP RAW, the way the editor's `render_full_file` runs
/// it (full decode, `render_full_with_options` with the display look, JPEG q95). Peak memory is the process's, so run
/// it alone under `/usr/bin/time -l` (see `scripts/measure/README.md`):
/// `cargo test -p photobook-develop --release --test raw -- --ignored --nocapture budget_full_render_24mp`.
/// `PHOTOBOOK_BUDGET_RAW` picks the file (else the first 22–26 MP RAW in `PHOTOBOOK_RAW_DIR` or
/// `~/Pictures/ON1 Samples`); `PHOTOBOOK_BUDGET_SETTINGS` names a settings fixture in `tests/fixtures` (default: no
/// edit); `PHOTOBOOK_FORCE_CPU=1` takes the CPU path.
#[test]
#[ignore = "needs a real 24 MP RAW; timing; run with --release under /usr/bin/time -l"]
fn budget_full_render_24mp() {
    let path = match std::env::var_os("PHOTOBOOK_BUDGET_RAW") {
        Some(p) => PathBuf::from(p),
        None => {
            let dir = std::env::var_os("PHOTOBOOK_RAW_DIR").map(PathBuf::from).unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples")
            });
            let Ok(entries) = std::fs::read_dir(&dir) else {
                eprintln!("no RAW directory at {}", dir.display());
                return;
            };
            let mut files: Vec<PathBuf> =
                entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| is_raw_path(p)).collect();
            files.sort();
            let Some(found) = files.into_iter().find(|p| {
                raw_info(p).is_ok_and(|i| (22_000_000..=26_000_000).contains(&(i.width as u64 * i.height as u64)))
            }) else {
                eprintln!("no 22–26 MP RAW in {}", dir.display());
                return;
            };
            found
        }
    };
    let settings: DevelopSettings = match std::env::var("PHOTOBOOK_BUDGET_SETTINGS") {
        Ok(name) => {
            let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
            photobook_develop::lut::set_lut_dir(Some(dir.join("luts")));
            let json: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join(&name)).unwrap()).unwrap();
            serde_json::from_value(json["settings"].clone()).unwrap()
        }
        Err(_) => DevelopSettings::default(),
    };
    let t0 = Instant::now();
    let image = decode_file(&path, None).expect("decode");
    let decode_ms = t0.elapsed().as_millis();
    let (w, h) = (image.width, image.height);
    let t1 = Instant::now();
    let options = RenderOptions::for_image(&image.meta);
    let rendered = render_full_with_options(&image, &settings, Quality::for_size(w, h), &options).expect("render");
    let render_ms = t1.elapsed().as_millis();
    drop(image);
    let t2 = Instant::now();
    let bytes = photobook_develop::encode_jpeg_as(&rendered, 95, options.output).expect("encode");
    let encode_ms = t2.elapsed().as_millis();
    eprintln!(
        "[budget] {} {w}x{h} ({:.1} MP) out {}x{} | decode {decode_ms} ms, render {render_ms} ms ({}), encode {encode_ms} ms ({} KB) | total {} ms",
        path.file_name().unwrap().to_string_lossy(),
        (w as f64 * h as f64) / 1e6,
        rendered.width,
        rendered.height,
        if std::env::var_os("PHOTOBOOK_FORCE_CPU").is_some() { "CPU" } else { "GPU when available" },
        bytes.len() / 1024,
        t0.elapsed().as_millis()
    );
}
