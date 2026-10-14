//! Synthetic pairs: a "camera JPEG" is made by applying a known LUT to the neutral render of a lisbon fixture,
//! moved and scaled a little, quantised and JPEG-encoded; the fit must find the LUT again. There is no sample RAF in
//! the repo, so the source is a JPEG (any decoded source takes the same path after the decode).

use std::path::PathBuf;

use super::*;
use crate::decode::decode_jpeg;
use crate::render::encode_jpeg;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lisbon-demo").join(name)
}

/// A film-like look: 15 % less saturation, an S-curve, warmer shadows and a slight green push in the mid-tones.
fn look(rgb: [f32; 3]) -> [f32; 3] {
    let y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let tone = |c: f32| c - 0.05 * (2.0 * std::f32::consts::PI * c).sin();
    let shadow = (1.0 - y).powi(2);
    let mid = 4.0 * y * (1.0 - y);
    let mixed = rgb.map(|c| y + 0.85 * (c - y));
    [tone(mixed[0]) + 0.03 * shadow, tone(mixed[1]) + 0.015 * mid, tone(mixed[2]) - 0.04 * shadow].map(|v| v.clamp(0.0, 1.0))
}

fn known_lut() -> Lut3d {
    let mut lut = Lut3d::identity(17);
    for v in &mut lut.data {
        *v = look(*v);
    }
    lut
}

fn developed(name: &str) -> SrgbImage {
    neutral_render(&decode_file(&fixture(name), Some(900)).unwrap()).unwrap()
}

/// The "camera JPEG" of `source`: `lut` applied, scaled by `scale` about the centre and moved by `shift`, 8-bit,
/// JPEG at quality 92, decoded back to sRGB.
fn camera_jpeg(source: &SrgbImage, lut: &Lut3d, scale: f32, shift: [f32; 2]) -> SrgbImage {
    let looked = SrgbImage { data: source.data.iter().map(|p| lut.apply(*p)).collect(), ..source.clone() };
    let (w, h) = (source.width, source.height);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let data = (0..w * h)
        .map(|i| {
            let (x, y) = ((i % w) as f32 + 0.5, (i / w) as f32 + 0.5);
            // Target pixel (x, y) shows the source at the inverse of q = c + s(p − c) + shift.
            let (sx, sy) = (cx + (x - cx - shift[0]) / scale, cy + (y - cy - shift[1]) / scale);
            looked.sample(sx.clamp(0.5, w as f32 - 0.5), sy.clamp(0.5, h as f32 - 0.5)).unwrap()
        })
        .collect();
    let moved = SrgbImage { width: w, height: h, data };
    let jpeg = encode_jpeg(&moved.to_rgb8(), 92).unwrap();
    SrgbImage::from_linear(&decode_jpeg(&jpeg, None).unwrap())
}

fn never() -> bool {
    false
}

/// A deterministic noise source (xorshift), roughly uniform in −1..1.
fn noise(seed: u64) -> impl FnMut() -> f32 {
    let mut state = seed | 1;
    move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        ((state >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// A harder "camera JPEG": the look, then local contrast (an unsharp mask, amount 0.6 over a 3×3 blur, as in-camera
/// sharpening), barrel distortion that moves the corners by about `corner_px` (the lens correction our RAW decode
/// does not make), a small scale and shift, noise of ±`noise_amp` per channel, JPEG at quality 92.
fn camera_jpeg_hard(source: &SrgbImage, lut: &Lut3d, corner_px: f32, noise_amp: f32, seed: u64) -> SrgbImage {
    let looked = SrgbImage { data: source.data.iter().map(|p| lut.apply(*p)).collect(), ..source.clone() };
    let blurred = looked.blur3();
    let sharp = SrgbImage {
        data: looked
            .data
            .iter()
            .zip(&blurred.data)
            .map(|(p, b)| std::array::from_fn(|c| (p[c] + 0.6 * (p[c] - b[c])).clamp(0.0, 1.0)))
            .collect(),
        ..looked
    };
    let (w, h) = (source.width, source.height);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let half_diagonal = (cx * cx + cy * cy).sqrt();
    let k = corner_px / half_diagonal;
    let (scale, shift) = (1.004f32, [1.5f32, -1.0]);
    let mut rnd = noise(seed);
    let data = (0..w * h)
        .map(|i| {
            let (x, y) = ((i % w) as f32 + 0.5, (i / w) as f32 + 0.5);
            let (dx, dy) = ((x - cx - shift[0]) / scale, (y - cy - shift[1]) / scale);
            let r2 = (dx * dx + dy * dy) / (half_diagonal * half_diagonal);
            let d = 1.0 + k * r2;
            let (sx, sy) = (cx + dx * d, cy + dy * d);
            let p = sharp.sample(sx.clamp(0.5, w as f32 - 0.5), sy.clamp(0.5, h as f32 - 0.5)).unwrap();
            p.map(|v| (v + noise_amp * rnd()).clamp(0.0, 1.0))
        })
        .collect();
    let moved = SrgbImage { width: w, height: h, data };
    let jpeg = encode_jpeg(&moved.to_rgb8(), 92).unwrap();
    SrgbImage::from_linear(&decode_jpeg(&jpeg, None).unwrap())
}

/// Mean ΔE of `lut` over every pixel of a pair but a 3 % border (not only the flat ones the fit samples).
fn mean_delta_e_all_pixels(lut: &Lut3d, source: &SrgbImage, target: &SrgbImage, alignment: &Alignment) -> f32 {
    let (w, h) = (source.width, source.height);
    let (mx, my) = ((w as f32 * 0.03) as usize, (h as f32 * 0.03) as usize);
    let (mut sum, mut n) = (0.0f64, 0usize);
    for y in my..h - my {
        for x in mx..w - mx {
            let (qx, qy) = alignment.map(x as f32 + 0.5, y as f32 + 0.5);
            if let Some(t) = target.sample(qx, qy) {
                sum += delta_e(lut.apply(source.data[y * w + x]), t) as f64;
                n += 1;
            }
        }
    }
    (sum / n.max(1) as f64) as f32
}

#[test]
fn lutfit_tetra_weights_match_apply() {
    let mut lut = Lut3d::identity(5);
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    for v in &mut lut.data {
        *v = [rnd(), rnd(), rnd()];
    }
    for _ in 0..5000 {
        let p = [rnd(), rnd(), rnd()];
        let (corners, w) = solve::tetra(p, 5);
        let mut got = [0.0f32; 3];
        for k in 0..4 {
            let v = lut.at(corners[k][0], corners[k][1], corners[k][2]);
            for c in 0..3 {
                got[c] += w[k] * v[c];
            }
        }
        let want = lut.apply(p);
        assert!((0..3).all(|c| (got[c] - want[c]).abs() < 1e-5), "{p:?}: {got:?} vs {want:?}");
    }
}

#[test]
fn lutfit_delta_e_is_cie76() {
    let red = srgb_to_lab([1.0, 0.0, 0.0]);
    assert!((red[0] - 53.24).abs() < 0.05 && (red[1] - 80.09).abs() < 0.1 && (red[2] - 67.20).abs() < 0.1, "{red:?}");
    let white = srgb_to_lab([1.0; 3]);
    assert!((white[0] - 100.0).abs() < 1e-3 && white[1].abs() < 1e-3 && white[2].abs() < 1e-3, "{white:?}");
    assert_eq!(delta_e([0.3, 0.4, 0.5], [0.3, 0.4, 0.5]), 0.0);
    assert!(delta_e([0.5; 3], [0.51, 0.5, 0.5]) > 0.5);
}

/// The solver alone: pairs spread over the whole cube recover the LUT, and the identity stays the identity.
#[test]
fn lutfit_solver_recovers_a_lut_from_scattered_pairs() {
    let truth = known_lut();
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 40) as f32 / (1u64 << 24) as f32
    };
    let source: Vec<[f32; 3]> = (0..200_000).map(|_| [rnd(), rnd(), rnd()]).collect();
    let target: Vec<[f32; 3]> = source.iter().map(|p| truth.apply(*p)).collect();
    let pair = PairSamples { source, target, alignment: Alignment::default() };
    let fitted = fit_samples(std::slice::from_ref(&pair), &FitOptions::default(), &never, &mut |_| {}).unwrap();
    assert!(fitted.converged, "residual {}", fitted.residual);
    let (lut, coverage) = (fitted.lut, fitted.coverage);
    assert_eq!(lut.size, FIT_SIZE);
    assert!(coverage > 0.95, "coverage {coverage}");
    let de = mean_delta_e(&lut, &pair);
    assert!(de < 0.5, "mean ΔE {de}");
    let identity = PairSamples {
        target: pair.source.clone(),
        source: pair.source,
        alignment: Alignment::default(),
    };
    let lut = fit_samples(std::slice::from_ref(&identity), &FitOptions::default(), &never, &mut |_| {}).unwrap().lut;
    let worst = Lut3d::identity(FIT_SIZE)
        .data
        .iter()
        .zip(&lut.data)
        .map(|(a, b)| (0..3).map(|c| (a[c] - b[c]).abs()).fold(0.0, f32::max))
        .fold(0.0, f32::max);
    assert!(worst < 2e-3, "identity fit is off by {worst}");
}

/// The Check of plan 22: fitted on three pairs, the LUT is within mean ΔE 2 of the "camera JPEG" on each of them and
/// under ΔE 4 on a fourth photo it never saw.
#[test]
fn lutfit_synthetic_pairs_fit_within_delta_e_2_and_4_held_out() {
    let truth = known_lut();
    let moves = [(1.012, [3.0, -2.0]), (0.994, [-1.5, 2.5]), (1.0, [0.0, 0.0]), (1.006, [2.0, 1.0])];
    let names = ["IMG_01.jpg", "IMG_03.jpg", "IMG_05.jpg", "IMG_08.jpg"];
    let mut pairs = Vec::new();
    for (name, (scale, shift)) in names.iter().zip(moves) {
        let source = developed(name);
        let target = camera_jpeg(&source, &truth, scale, shift);
        let samples = sample_pair(&source, &target).unwrap();
        let a = &samples.alignment;
        assert!(a.score > 0.9, "{name}: score {}", a.score);
        assert!((a.scale - scale).abs() < 0.002, "{name}: scale {} for {scale}", a.scale);
        for c in 0..2 {
            assert!((a.offset[c] - shift[c]).abs() < 0.75, "{name}: offset {:?} for {shift:?}", a.offset);
        }
        pairs.push(samples);
    }
    let held_out = pairs.pop().unwrap();
    let mut steps = 0;
    let fitted = fit_samples(&pairs, &FitOptions::default(), &never, &mut |_| steps += 1).unwrap();
    let (lut, coverage) = (fitted.lut, fitted.coverage);
    assert!(steps > 2);
    for (name, pair) in names.iter().zip(&pairs) {
        let de = mean_delta_e(&lut, pair);
        let before = mean_delta_e(&Lut3d::identity(2), pair);
        eprintln!("{name}: mean ΔE {de:.2} (unfitted {before:.2}), {} samples", pair.source.len());
        assert!(de < 2.0, "{name}: mean ΔE {de}");
        assert!(before > 4.0, "{name}: the look is too weak to test ({before})");
    }
    let de = mean_delta_e(&lut, &held_out);
    eprintln!("held out {}: mean ΔE {de:.2}, coverage {coverage:.3}", names[3]);
    assert!(de < 4.0, "held-out mean ΔE {de}");
}

#[test]
fn lutfit_refuses_pairs_that_do_not_line_up() {
    let a = developed("IMG_01.jpg");
    let b = camera_jpeg(&developed("IMG_02.jpg"), &known_lut(), 1.0, [0.0, 0.0]);
    let err = sample_pair(&a, &b).unwrap_err().to_string();
    assert!(err.contains("line up") || err.contains("aspect ratio"), "{err}");
    // Turned 90°: refused by its shape.
    let turned = SrgbImage {
        width: a.height,
        height: a.width,
        data: (0..a.width * a.height).map(|i| a.data[(i % a.height) * a.width + i / a.height]).collect(),
    };
    if a.width != a.height {
        assert!(sample_pair(&a, &turned).unwrap_err().to_string().contains("turned"));
    }
}

#[test]
fn lutfit_files_report_progress_and_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let source = developed("IMG_01.jpg");
    let raw = dir.path().join("DSCF0001.png");
    image::RgbImage::from_raw(source.width as u32, source.height as u32, source.to_rgb8().data)
        .unwrap()
        .save(&raw)
        .unwrap();
    let jpeg = dir.path().join("DSCF0001.JPG");
    let target = camera_jpeg(&source, &known_lut(), 1.0, [1.0, 0.0]);
    std::fs::write(&jpeg, encode_jpeg(&target.to_rgb8(), 95).unwrap()).unwrap();
    let broken = dir.path().join("DSCF0002.JPG");
    std::fs::write(&broken, b"not a jpeg").unwrap();
    let pairs = vec![(raw.clone(), jpeg.clone()), (raw.clone(), broken)];
    let mut seen = Vec::new();
    let report = fit_files(&pairs, &FitOptions::default(), &never, &mut |done, total, detail| {
        seen.push((done, total, detail.to_string()))
    })
    .unwrap();
    assert_eq!(report.pairs.len(), 2);
    assert!(report.pairs[0].mean_delta_e.unwrap() < 2.0, "{:?}", report.pairs[0]);
    assert!(report.pairs[1].error.is_some() && report.pairs[1].samples == 0);
    assert!(report.mean_delta_e < 2.0);
    let total = 2 * 2 + 20;
    assert!(seen.iter().all(|(d, t, _)| *t == total && *d <= total));
    assert_eq!(seen.last().map(|s| s.0), Some(total));
    // Cancelled: the error is the editor's "Cancelled".
    let err = fit_files(&pairs, &FitOptions::default(), &|| true, &mut |_, _, _| {}).unwrap_err();
    assert_eq!(err.to_string(), CANCELLED);
    // Nothing usable: one message naming the reasons.
    let only_broken = vec![(raw, dir.path().join("DSCF0002.JPG"))];
    let err = fit_files(&only_broken, &FitOptions::default(), &never, &mut |_, _, _| {}).unwrap_err();
    assert!(err.to_string().contains("No pair could be used"), "{err}");
}

/// Lens distortion (corners moved by about 1.5 px), in-camera sharpening and noise: the tile refinement has
/// something to do, and the plan's thresholds still hold on the flat pixels the fit uses; every non-border pixel of
/// the held-out pair is reported too (edges carry the sharpening and noise, which no LUT can match).
#[test]
fn lutfit_distortion_sharpening_and_noise_stay_within_the_thresholds() {
    let truth = known_lut();
    let names = ["IMG_02.jpg", "IMG_04.jpg", "IMG_06.jpg", "IMG_10.jpg"];
    let mut pairs = Vec::new();
    let mut images = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let source = developed(name);
        let target = camera_jpeg_hard(&source, &truth, 2.0, 0.008, 17 + i as u64);
        let samples = sample_pair(&source, &target).unwrap();
        let a = &samples.alignment;
        let moved = a.tile_offsets.iter().filter(|t| t[0].abs() + t[1].abs() > 0.2).count();
        eprintln!("{name}: score {:.3}, scale {:.4}, {moved} of {} tiles moved", a.score, a.scale, a.tile_offsets.len());
        assert!(a.score > MIN_SCORE, "{name}: score {}", a.score);
        assert!(moved > 0, "{name}: the tile refinement did nothing");
        pairs.push(samples);
        images.push((source, target));
    }
    let held_out = pairs.pop().unwrap();
    let fitted = fit_samples(&pairs, &FitOptions::default(), &never, &mut |_| {}).unwrap();
    for (name, pair) in names.iter().zip(&pairs) {
        let de = mean_delta_e(&fitted.lut, pair);
        eprintln!("{name}: mean ΔE {de:.2} on flat pixels");
        assert!(de < 2.0, "{name}: mean ΔE {de}");
    }
    let flat = mean_delta_e(&fitted.lut, &held_out);
    let (source, target) = &images[3];
    let all = mean_delta_e_all_pixels(&fitted.lut, source, target, &held_out.alignment);
    let unfitted = mean_delta_e_all_pixels(&Lut3d::identity(2), source, target, &held_out.alignment);
    eprintln!(
        "held out {}: mean ΔE {flat:.2} flat, {all:.2} all pixels ({unfitted:.2} unfitted), residual {:.1e}",
        names[3], fitted.residual
    );
    assert!(flat < 4.0, "held-out mean ΔE {flat}");
    assert!(all < 4.0, "held-out mean ΔE over all pixels {all}");
}

/// Samples clustered in about 15 % of the cube (muted mid-tones): the solve converges, and the corners no pixel
/// reached are filled by the smooth continuation, in range and in order along the grey axis.
#[test]
fn lutfit_clustered_samples_converge_and_extrapolate_in_range() {
    let truth = known_lut();
    let mut rnd = noise(99);
    // A box of side 0.53 around mid-grey: 0.53³ ≈ 15 % of the cube.
    let source: Vec<[f32; 3]> = (0..150_000).map(|_| [0.5 + 0.265 * rnd(), 0.5 + 0.265 * rnd(), 0.5 + 0.265 * rnd()]).collect();
    let target: Vec<[f32; 3]> = source.iter().map(|p| truth.apply(*p)).collect();
    let pair = PairSamples { source, target, alignment: Alignment::default() };
    let fitted = fit_samples(std::slice::from_ref(&pair), &FitOptions::default(), &never, &mut |_| {}).unwrap();
    eprintln!("clustered: residual {:.2e}, converged {}, coverage {:.3}", fitted.residual, fitted.converged, fitted.coverage);
    assert!(fitted.converged && fitted.residual < 1e-5, "residual {}", fitted.residual);
    assert!(fitted.coverage > 0.1 && fitted.coverage < 0.25, "coverage {}", fitted.coverage);
    assert!(mean_delta_e(&fitted.lut, &pair) < 1.0);
    let lut = &fitted.lut;
    let last = lut.size - 1;
    for corner in 0..8 {
        let at = lut.at(if corner & 1 == 1 { last } else { 0 }, if corner & 2 == 2 { last } else { 0 }, if corner & 4 == 4 { last } else { 0 });
        assert!(at.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "corner {corner}: {at:?}");
    }
    let luma = |p: [f32; 3]| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    let greys: Vec<f32> = (0..=32).map(|i| luma(lut.apply([i as f32 / 32.0; 3]))).collect();
    assert!(greys.windows(2).all(|w| w[1] >= w[0] - 1e-3), "grey axis not in order: {greys:?}");
    assert!(greys[32] - greys[0] > 0.6, "grey axis collapsed: {greys:?}");
}
