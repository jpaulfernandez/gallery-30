//! D6.2: colour management end to end. The output profiles (sRGB, Display P3) and their ICC tags, renders in
//! either space (CPU and GPU), and HEIC decoded through ImageIO (macOS).
//!
//! Evidence runs (not part of the default suite):
//! `cargo test -p photobook-develop --release --test color -- --ignored --nocapture` compares the ImageIO decode
//! with `sips` (16-bit PNG) and times it; `PHOTOBOOK_HEIC=/path/to/photo.heic` uses that file instead of the fixture.

use moxcms::{ColorProfile, Layout, RenderingIntent, ToneReprCurve, TransformOptions};
use photobook_develop::color::matrix::{self, apply_f32, Mat3};
use photobook_develop::color::oklab::Oklab;
use photobook_develop::color::transfer;
use photobook_develop::gpu::GpuContext;
use photobook_develop::render::{encode_jpeg_as, render_preview_with};
use photobook_develop::settings::HueMix;
use photobook_develop::{
    decode::decode_jpeg, DevelopSettings, Developer, LinearImage, OutputProfile, RenderBackend, RenderOptions, Rgb8Image,
};

mod common;

const APPLE_P3: &str = "/System/Library/ColorSync/Profiles/Display P3.icc";
const APPLE_SRGB: &str = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";

fn options(output: OutputProfile, backend: RenderBackend) -> RenderOptions {
    RenderOptions { output, backend, ..RenderOptions::default() }
}

/// Linear Rec.2020 as a moxcms destination (identity curves), as `decode::icc` builds it.
fn linear_rec2020() -> ColorProfile {
    let mut p = ColorProfile::new_bt2020();
    let linear = ToneReprCurve::Lut(Vec::new());
    p.red_trc = Some(linear.clone());
    p.green_trc = Some(linear.clone());
    p.blue_trc = Some(linear);
    p.cicp = None;
    p
}

/// Encoded RGB under `icc` → XYZ (D65), read back with moxcms: the parsed TRCs (a moxcms transform to the same
/// profile with linear curves), the parsed colorants (D50) and the inverse of the parsed `chad` (D50 → D65).
fn profile_to_xyz(icc: &[u8], encoded: [f32; 3]) -> [f64; 3] {
    let profile = ColorProfile::new_from_slice(icc).expect("profile parses");
    let mut linear_twin = profile.clone();
    let linear = ToneReprCurve::Lut(Vec::new());
    linear_twin.red_trc = Some(linear.clone());
    linear_twin.green_trc = Some(linear.clone());
    linear_twin.blue_trc = Some(linear);
    let opts = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, prefer_fixed_point: false, ..TransformOptions::default() };
    let t = profile.create_transform_f32(Layout::Rgb, &linear_twin, Layout::Rgb, opts).expect("transform");
    let mut lin = [0.0f32; 3];
    t.transform(&encoded, &mut lin).expect("transform runs");
    let c = profile.colorant_matrix().v;
    let chad = profile.chromatic_adaptation.expect("chad tag").v;
    let xyz_d50 = matrix::apply(&c, lin.map(|v| v as f64));
    matrix::apply(&matrix::inv(&chad), xyz_d50)
}

/// Encoded RGB under `icc` → XYZ (D65) through a full moxcms transform into linear Rec.2020 (what the decoder
/// does with an embedded profile). moxcms adapts with its own D50 (from 5003 K), hence a looser tolerance.
fn moxcms_to_xyz(icc: &[u8], encoded: [f32; 3]) -> [f64; 3] {
    let profile = ColorProfile::new_from_slice(icc).expect("profile parses");
    let opts = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, prefer_fixed_point: false, ..TransformOptions::default() };
    let t = profile.create_transform_f32(Layout::Rgb, &linear_rec2020(), Layout::Rgb, opts).expect("transform");
    let mut out = [0.0f32; 3];
    t.transform(&encoded, &mut out).expect("transform runs");
    matrix::apply(&matrix::rec2020_to_xyz(), out.map(|v| v as f64))
}

fn analytic_xyz(to_xyz: &Mat3, encoded: [f32; 3]) -> [f64; 3] {
    matrix::apply(to_xyz, encoded.map(|v| transfer::srgb_to_linear(v) as f64))
}

fn max_abs(a: [f64; 3], b: [f64; 3]) -> f64 {
    (0..3).map(|i| (a[i] - b[i]).abs()).fold(0.0, f64::max)
}

const SAMPLES: [[f32; 3]; 7] =
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.5, 0.5, 0.5], [0.2, 0.4, 0.8], [0.9, 0.3, 0.05]];

// ---------- the ICC profiles ----------

#[test]
fn p3_profile_round_trips_through_moxcms_to_the_analytic_xyz() {
    for (profile, to_xyz) in [(OutputProfile::DisplayP3, matrix::p3_to_xyz()), (OutputProfile::Srgb, matrix::srgb_to_xyz())] {
        let icc = profile.icc();
        let (mut worst, mut worst_full) = (0.0f64, 0.0f64);
        for enc in SAMPLES {
            let want = analytic_xyz(&to_xyz, enc);
            let got = profile_to_xyz(icc, enc);
            let d = max_abs(got, want);
            worst = worst.max(d);
            assert!(d < 1e-3, "{profile:?} {enc:?}: parsed {got:?} vs analytic {want:?}");
            let full = moxcms_to_xyz(icc, enc);
            let d = max_abs(full, want);
            worst_full = worst_full.max(d);
            assert!(d < 2e-3, "{profile:?} {enc:?}: moxcms transform {full:?} vs analytic {want:?}");
        }
        eprintln!(
            "{profile:?}: {} bytes; worst |XYZ - analytic| over {} samples: parsed profile {worst:.2e}, moxcms → Rec.2020 {worst_full:.2e}",
            icc.len(),
            SAMPLES.len()
        );
    }
    // P3 red, spelled out: XYZ (0.4866, 0.2290, 0.0000).
    let red = profile_to_xyz(OutputProfile::DisplayP3.icc(), [1.0, 0.0, 0.0]);
    assert!(max_abs(red, [0.486_571, 0.228_975, 0.0]) < 1e-3, "{red:?}");
}

#[test]
fn p3_profile_matches_apples_display_p3() {
    let Ok(apple) = std::fs::read(APPLE_P3) else {
        eprintln!("SKIP: {APPLE_P3} not found");
        return;
    };
    let ours = ColorProfile::new_from_slice(OutputProfile::DisplayP3.icc()).unwrap();
    let apple = ColorProfile::new_from_slice(&apple).unwrap();
    let mut worst = 0.0f64;
    for (a, b) in [
        (ours.red_colorant, apple.red_colorant),
        (ours.green_colorant, apple.green_colorant),
        (ours.blue_colorant, apple.blue_colorant),
    ] {
        worst = worst.max((a.x - b.x).abs()).max((a.y - b.y).abs()).max((a.z - b.z).abs());
    }
    eprintln!("Display P3 colorants vs Apple's profile: worst difference {worst:.2e}");
    assert!(worst < 2e-4, "colorants differ by {worst}");
    // And the same colours through either profile.
    let apple_bytes = std::fs::read(APPLE_P3).unwrap();
    for enc in SAMPLES {
        let d = max_abs(moxcms_to_xyz(OutputProfile::DisplayP3.icc(), enc), moxcms_to_xyz(&apple_bytes, enc));
        assert!(d < 1e-3, "{enc:?}: {d}");
    }
    if let Ok(apple_srgb) = std::fs::read(APPLE_SRGB) {
        for enc in SAMPLES {
            let d = max_abs(moxcms_to_xyz(OutputProfile::Srgb.icc(), enc), moxcms_to_xyz(&apple_srgb, enc));
            assert!(d < 2e-3, "sRGB {enc:?}: {d}");
        }
    }
}

/// ColorSync (through `sips`) reads our P3 tag the same way: a JPEG of P3 primaries tagged with it, matched to
/// Apple's Display P3 profile, keeps its values.
#[cfg(target_os = "macos")]
#[test]
fn colorsync_reads_the_p3_tag_as_display_p3() {
    if !std::path::Path::new(APPLE_P3).exists() {
        eprintln!("SKIP: {APPLE_P3} not found");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let (w, h) = (64u32, 16u32);
    let colours: [[u8; 3]; 4] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [200, 120, 40]];
    let data: Vec<u8> = (0..w * h).flat_map(|i| colours[((i % w) / 16) as usize]).collect();
    let jpeg = encode_jpeg_as(&Rgb8Image::new(w, h, data), 100, OutputProfile::DisplayP3).unwrap();
    let src = dir.path().join("p3.jpg");
    let out = dir.path().join("matched.png");
    std::fs::write(&src, &jpeg).unwrap();
    let status = std::process::Command::new("sips")
        .args(["--matchTo", APPLE_P3, "-s", "format", "png"])
        .arg(&src)
        .arg("--out")
        .arg(&out)
        .stdout(std::process::Stdio::null())
        .status();
    if !status.is_ok_and(|s| s.success()) {
        eprintln!("SKIP: sips failed");
        return;
    }
    let png = image::open(&out).unwrap().to_rgb8();
    let mut worst = 0u8;
    for (i, c) in colours.iter().enumerate() {
        let px = png.get_pixel(i as u32 * 16 + 8, 8).0;
        for k in 0..3 {
            worst = worst.max(px[k].abs_diff(c[k]));
        }
    }
    eprintln!("sips --matchTo 'Display P3.icc' moved our P3-tagged primaries by at most {worst} levels");
    assert!(worst <= 2, "{worst}");
}

// ---------- renders ----------

/// A linear Rec.2020 image with flat patches: an in-sRGB red, P3 red (outside sRGB) and 18% grey.
fn patches() -> (LinearImage, [[f32; 3]; 3]) {
    let srgb_red = apply_f32(&matrix::to_f32(&matrix::srgb_to_rec2020()), 1.0, 0.0, 0.0);
    let p3_red = apply_f32(&matrix::to_f32(&matrix::p3_to_rec2020()), 1.0, 0.0, 0.0);
    let grey = [0.18f32; 3];
    let cols = [srgb_red, p3_red, grey];
    let (w, h) = (48u32, 16u32);
    let data = (0..w * h).flat_map(|i| cols[((i % w) / 16) as usize]).collect();
    (LinearImage::new(w, h, data), cols)
}

fn px(img: &Rgb8Image, i: usize) -> [u8; 3] {
    let o = ((8 * img.width + i as u32 * 16 + 8) * 3) as usize;
    [img.data[o], img.data[o + 1], img.data[o + 2]]
}

fn near(a: [u8; 3], b: [u8; 3], tol: u8) -> bool {
    (0..3).all(|k| a[k].abs_diff(b[k]) <= tol)
}

#[test]
fn p3_and_srgb_renders_differ_in_the_expected_direction() {
    let (img, cols) = patches();
    let dev = Developer::new(img);
    let s = DevelopSettings::default();
    let srgb = dev.render_with(&s, &options(OutputProfile::Srgb, RenderBackend::Cpu));
    let p3 = dev.render_with(&s, &options(OutputProfile::DisplayP3, RenderBackend::Cpu));
    eprintln!("sRGB red: sRGB {:?} / P3 {:?}; P3 red: sRGB {:?} / P3 {:?}; grey {:?} / {:?}",
        px(&srgb, 0), px(&p3, 0), px(&srgb, 1), px(&p3, 1), px(&srgb, 2), px(&p3, 2));
    // sRGB red is (255, 0, 0) in sRGB and the less extreme (234, 51, 35) in the wider P3.
    assert!(near(px(&srgb, 0), [255, 0, 0], 1));
    assert!(near(px(&p3, 0), [234, 51, 35], 2), "{:?}", px(&p3, 0));
    // P3 red is exactly the P3 primary, and gamut-mapped (red still dominant, less extreme) in sRGB.
    assert!(near(px(&p3, 1), [255, 0, 0], 1));
    let s1 = px(&srgb, 1);
    assert!(s1[0] > 200 && s1[1] < s1[0] / 2 && s1[2] < s1[0] / 2, "{s1:?}");
    // A neutral is the same code value in both spaces (same white, same curve).
    assert_eq!(px(&srgb, 2), px(&p3, 2));

    // Decoded back through the embedded tags, P3 keeps the P3 red; sRGB has lost chroma.
    let ok = Oklab::new();
    let chroma = |v: [f32; 3]| {
        let [_, a, b] = ok.to_lab(v);
        a.hypot(b)
    };
    let back = |img: &Rgb8Image, profile| decode_jpeg(&encode_jpeg_as(img, 100, profile).unwrap(), None).unwrap();
    let at = |img: &LinearImage, i: usize| {
        let o = ((8 * img.width + i as u32 * 16 + 8) * 3) as usize;
        [img.data[o], img.data[o + 1], img.data[o + 2]]
    };
    let (from_p3, from_srgb) = (back(&p3, OutputProfile::DisplayP3), back(&srgb, OutputProfile::Srgb));
    let want = chroma(cols[1]);
    let (c_p3, c_srgb) = (chroma(at(&from_p3, 1)), chroma(at(&from_srgb, 1)));
    eprintln!("P3 red Oklab chroma: source {want:.4}, through P3 {c_p3:.4}, through sRGB {c_srgb:.4}");
    assert!((c_p3 - want).abs() < 0.01 * want, "P3 keeps it: {c_p3} vs {want}");
    assert!(c_srgb < 0.9 * want, "sRGB maps it in: {c_srgb} vs {want}");
    for i in [0, 2] {
        let (a, b) = (at(&from_p3, i), cols[i]);
        assert!((0..3).all(|k| (a[k] - b[k]).abs() < 0.01), "patch {i}: {a:?} vs {b:?}");
    }
}

#[test]
fn preview_jpegs_carry_the_profile_they_were_rendered_in() {
    let (img, _) = patches();
    let s = DevelopSettings::default();
    for profile in [OutputProfile::Srgb, OutputProfile::DisplayP3] {
        let jpeg = render_preview_with(&img, &s, 32, 85, &options(profile, RenderBackend::Cpu)).unwrap();
        let icc = profile.icc();
        assert!(jpeg.windows(icc.len()).any(|w| w == icc), "{profile:?} tag embedded");
        let other = if profile == OutputProfile::Srgb { OutputProfile::DisplayP3 } else { OutputProfile::Srgb };
        assert!(!jpeg.windows(other.icc().len()).any(|w| w == other.icc()));
    }
}

#[test]
fn gpu_matches_the_cpu_in_display_p3() {
    let Some(ctx) = GpuContext::get() else {
        eprintln!("SKIP gpu_matches_the_cpu_in_display_p3: no GPU adapter; nothing was compared");
        return;
    };
    eprintln!("GPU {} ({:?})", ctx.info.name, ctx.info.backend);
    // Saturated content pushed further so both the matrix and the gamut mapper matter.
    let mut img = common::scene(480, 360);
    let to2020 = matrix::to_f32(&matrix::p3_to_rec2020());
    for (i, p) in img.data.chunks_exact_mut(3).enumerate() {
        if (i / 480) % 90 < 30 {
            let t = (i % 480) as f32 / 479.0;
            p.copy_from_slice(&apply_f32(&to2020, t, 1.0 - t, 0.1));
        }
    }
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.3;
    s.light.contrast = 20.0;
    s.color.vibrance = 30.0;
    s.color.saturation = 25.0;
    s.color.mix.red = HueMix { hue: 10.0, saturation: 20.0, luminance: -10.0 };
    for profile in [OutputProfile::DisplayP3, OutputProfile::Srgb] {
        let dev = Developer::new(img.clone());
        let cpu = dev.render_with(&s, &options(profile, RenderBackend::Cpu));
        let gpu = dev.render_with(&s, &options(profile, RenderBackend::Gpu));
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
        let mut max = 0u8;
        let mut sum = 0u64;
        for (a, b) in cpu.data.iter().zip(&gpu.data) {
            let d = a.abs_diff(*b);
            max = max.max(d);
            sum += d as u64;
        }
        let mean = sum as f64 / cpu.data.len() as f64;
        eprintln!("{profile:?}: CPU vs GPU max {max} level(s), mean {mean:.4}");
        assert!(max <= 1, "{profile:?}: max {max}");
    }
}

// ---------- HEIC ----------

/// `tests/fixtures/heic/p3-orient6-10bit.heic`: 64 × 48 stored, 10-bit 4:2:0, Display P3, orientation 6 (90° CW,
/// as HEIF `irot`). Stored left half: four 12-row bands, P3 red, green, blue and grey 0.5 (encoded); right half a
/// ramp. Upright (48 × 64), the bands become 12-column strips in the top half, right to left.
#[cfg(all(target_os = "macos", feature = "heic-imageio"))]
mod heic {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    use photobook_develop::decode_file;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/heic/p3-orient6-10bit.heic")
    }

    /// Mean of a `r`-radius square around (x, y).
    fn mean(img: &LinearImage, x: u32, y: u32, r: u32) -> [f32; 3] {
        let mut acc = [0.0f64; 3];
        let mut n = 0.0;
        for yy in y - r..=y + r {
            for xx in x - r..=x + r {
                let o = ((yy * img.width + xx) * 3) as usize;
                for k in 0..3 {
                    acc[k] += img.data[o + k] as f64;
                }
                n += 1.0;
            }
        }
        acc.map(|v| (v / n) as f32)
    }

    /// Upright centres of the red, green, blue and grey strips.
    const CENTRES: [(u32, u32); 4] = [(42, 16), (30, 16), (18, 16), (6, 16)];

    fn expected() -> [[f32; 3]; 4] {
        let m = matrix::to_f32(&matrix::p3_to_rec2020());
        let g = transfer::srgb_to_linear(0.5);
        [apply_f32(&m, 1.0, 0.0, 0.0), apply_f32(&m, 0.0, 1.0, 0.0), apply_f32(&m, 0.0, 0.0, 1.0), [g, g, g]]
    }

    #[test]
    fn decodes_a_p3_10bit_heic_upright_without_clipping() {
        let img = decode_file(&fixture(), None).unwrap();
        assert_eq!((img.width, img.height), (48, 64), "orientation 6 applied");
        let want = expected();
        let mut worst = 0.0f32;
        for (i, &(x, y)) in CENTRES.iter().enumerate() {
            let got = mean(&img, x, y, 2);
            let d = (0..3).map(|k| (got[k] - want[i][k]).abs()).fold(0.0, f32::max);
            worst = worst.max(d);
            assert!(d < 0.02, "strip {i}: {got:?} vs {:?}", want[i]);
        }
        eprintln!("HEIC strips vs analytic P3 → Rec.2020: worst {worst:.4} (linear)");
        // The P3 red is outside sRGB: in linear sRGB its green and blue are negative, so nothing was clipped.
        let red = mean(&img, CENTRES[0].0, CENTRES[0].1, 2);
        let srgb = apply_f32(&matrix::to_f32(&matrix::rec2020_to_srgb()), red[0], red[1], red[2]);
        assert!(srgb[1] < -0.02 && srgb[2] < -0.01 && srgb[0] > 1.05, "{srgb:?}");
        // A capped decode keeps the aspect and the colours.
        let small = decode_file(&fixture(), Some(32)).unwrap();
        assert_eq!((small.width, small.height), (24, 32));
    }

    /// Evidence: the ImageIO decode against `sips` to a 16-bit PNG (decoded by the PNG path with its iCCP
    /// profile), and the decode time. `PHOTOBOOK_HEIC` picks another file (e.g. an iPhone photo).
    #[test]
    #[ignore]
    fn imageio_matches_sips_and_timing() {
        let path = std::env::var_os("PHOTOBOOK_HEIC").map(PathBuf::from).unwrap_or_else(fixture);
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("ref.png");
        let start = Instant::now();
        let ok = std::process::Command::new("sips")
            .args(["-s", "format", "png"])
            .arg(&path)
            .arg("--out")
            .arg(&png)
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        let sips_ms = start.elapsed().as_millis();
        assert!(ok, "sips failed");
        let start = Instant::now();
        let ours = decode_file(&path, None).unwrap();
        let full_ms = start.elapsed().as_millis();
        let start = Instant::now();
        let proxy = decode_file(&path, Some(1600)).unwrap();
        let proxy_ms = start.elapsed().as_millis();
        let start = Instant::now();
        let mut reference = decode_file(&png, None).unwrap();
        let png_ms = start.elapsed().as_millis();
        if (reference.width, reference.height) != (ours.width, ours.height) {
            // sips keeps the stored frame; orient it like ours.
            let o = exif_orientation_of(&path);
            reference = photobook_develop::decode::orient(reference, o);
        }
        assert_eq!((reference.width, reference.height), (ours.width, ours.height));
        let n = (ours.width * ours.height) as f64;
        let mut mean_a = [0.0f64; 3];
        let mut mean_b = [0.0f64; 3];
        let mut worst = 0.0f32;
        for (a, b) in ours.data.chunks_exact(3).zip(reference.data.chunks_exact(3)) {
            for k in 0..3 {
                mean_a[k] += a[k] as f64 / n;
                mean_b[k] += b[k] as f64 / n;
                worst = worst.max((a[k] - b[k]).abs());
            }
        }
        eprintln!(
            "{}: {}x{}; ImageIO decode {full_ms} ms (proxy 1600: {proxy_ms} ms, {}x{}); sips→PNG {sips_ms} ms + PNG decode {png_ms} ms",
            path.display(),
            ours.width,
            ours.height,
            proxy.width,
            proxy.height
        );
        eprintln!("mean linear Rec.2020: ImageIO {mean_a:.5?} vs sips 16-bit PNG {mean_b:.5?}; worst pixel {worst:.4}");
        for k in 0..3 {
            assert!((mean_a[k] - mean_b[k]).abs() < 0.002, "channel {k}: {} vs {}", mean_a[k], mean_b[k]);
        }
    }

    fn exif_orientation_of(path: &Path) -> u32 {
        let out = std::process::Command::new("sips").args(["-g", "orientation"]).arg(path).output().unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.trim().strip_prefix("orientation:").and_then(|v| v.trim().parse().ok()))
            .unwrap_or(1)
    }
}
