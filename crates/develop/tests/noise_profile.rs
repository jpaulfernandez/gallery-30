//! Workflow plan 23: the self-profile on JPEGs (what the editor measures for a camera JPEG) and on the repo's
//! fixture photos.
//!
//! `cargo test -p photobook-develop --test noise_profile` runs the checks. `-- --ignored --nocapture` also prints the
//! measurement of every JPEG under `fixtures/` (the numbers `suggestedAmount` in `apps/editor/src/lib/denoise.ts`
//! was checked against).
#![cfg(feature = "ai")]

use std::path::Path;

use photobook_develop::ai::noise_profile::{measure, NoiseFit, MID_GREY};
use photobook_develop::color::transfer::linear_to_srgb;
use photobook_develop::decode::decode_jpeg;
use photobook_develop::{decode_file, encode_jpeg, Rgb8Image};

/// xorshift64* with Box-Muller.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        ((self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.next(), self.next());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

/// A 1600 × 1066 scene of grey bands and a soft gradient (linear light), Gaussian noise of variance `a·μ + b` per
/// channel, sRGB-encoded to 8 bits and saved as a quality-90 JPEG, then decoded as the editor decodes a photo.
fn noisy_jpeg(a: f64, b: f64, seed: u64) -> photobook_develop::LinearImage {
    let (w, h) = (1600u32, 1066u32);
    let mut rng = Rng(seed);
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let band = [0.02, 0.05, 0.1, 0.18, 0.3, 0.45, 0.65][(x as usize * 7) / w as usize];
            let level = band * (0.85 + 0.3 * y as f64 / h as f64);
            for _ in 0..3 {
                let v = level + (a * level + b).sqrt() * rng.gauss();
                data.push((linear_to_srgb(v.clamp(0.0, 1.0) as f32) * 255.0).round().clamp(0.0, 255.0) as u8);
            }
        }
    }
    let jpeg = encode_jpeg(&Rgb8Image::new(w, h, data), 90).unwrap();
    decode_jpeg(&jpeg, None).unwrap()
}

/// σ at mid-grey relative to mid-grey: the number `suggestedAmount` maps.
fn relative(fit: &NoiseFit) -> f64 {
    fit.sigma / MID_GREY
}

#[test]
fn a_clean_low_iso_jpeg_measures_low() {
    // About ISO 200 at the working size: 0.3 % noise at mid-grey before 8-bit quantisation.
    let fit = measure(&noisy_jpeg(1.5e-6, 2e-8, 3));
    println!("ISO 200-like: {:.4} ({} patches, confidence {:.2})", relative(&fit), fit.patches, fit.confidence);
    // The vertical gradient quantises into bands, which are not noise: fewer flat blocks, but enough.
    assert!(fit.confidence > 0.3, "{fit:?}");
    // `suggestedAmount` reads anything under about 0.9 % as "Not needed"; 8-bit quantisation alone is about 0.3 %.
    assert!(relative(&fit) < 0.006, "{fit:?}");
}

#[test]
fn a_high_iso_jpeg_measures_high() {
    // About ISO 12800 at the working size: 5 % noise at mid-grey.
    let (a, b) = (4e-4, 1e-5);
    let fit = measure(&noisy_jpeg(a, b, 9));
    let truth = (a * MID_GREY + b).sqrt() / MID_GREY;
    println!("ISO 12800-like: {:.4} (truth {truth:.4}, {} patches)", relative(&fit), fit.patches);
    assert!(fit.confidence > 0.9, "{fit:?}");
    // `suggestedAmount` maps this to about 60.
    assert!(relative(&fit) > 0.02, "{fit:?}");
    // 4:2:0 chroma subsampling averages most of the (independent per channel) chroma noise away and quality 90
    // quantises some of the rest, as a camera JPEG does: about half of the variance is left.
    assert!(relative(&fit) > 0.35 * truth && relative(&fit) < 1.2 * truth, "{fit:?}");
}

#[test]
fn noise_ranks_by_level() {
    let levels = [(1e-5, 2e-7), (5e-5, 1e-6), (2e-4, 4e-6), (8e-4, 2e-5)];
    let sigmas: Vec<f64> = levels.iter().enumerate().map(|(i, &(a, b))| measure(&noisy_jpeg(a, b, i as u64 + 1)).sigma).collect();
    assert!(sigmas.windows(2).all(|w| w[0] < w[1]), "{sigmas:?}");
}

#[test]
#[ignore = "prints the fixture photos' measurements"]
fn fixture_photos() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths: Vec<_> = walk(&root).into_iter().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg"))).collect();
    paths.sort();
    for path in paths {
        let image = decode_file(&path, Some(1600)).unwrap();
        let start = std::time::Instant::now();
        let fit = measure(&image);
        println!(
            "{}: σ/0.18 = {:.4}, {} patches, confidence {:.2}, {} ms",
            path.strip_prefix(&root).unwrap().display(),
            relative(&fit),
            fit.patches,
            fit.confidence,
            start.elapsed().as_millis()
        );
    }
}

#[test]
#[ignore = "prints the measurements of the sample RAWs (PHOTOBOOK_RAW_DIR, default ~/Pictures/ON1 Samples)"]
fn sample_raws() {
    let dir = std::env::var_os("PHOTOBOOK_RAW_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(&std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples"));
    let mut paths: Vec<_> = walk(&dir).into_iter().filter(|p| photobook_develop::decode::is_raw_path(p)).collect();
    paths.sort();
    for path in paths {
        let exif = photobook_develop::decode::camera_exif(&path);
        let Ok(image) = decode_file(&path, Some(1600)) else { continue };
        let fit = measure(&image);
        println!(
            "{} ({} ISO {:?}): σ/0.18 = {:.4}, {} patches, confidence {:.2}",
            path.file_name().unwrap().to_string_lossy(),
            exif.camera_name().unwrap_or_default(),
            exif.iso,
            relative(&fit),
            fit.patches,
            fit.confidence
        );
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if path.is_dir() && !hidden {
            out.extend(walk(&path));
        } else if path.is_file() {
            out.push(path);
        }
    }
    out
}
