//! Match camera JPEG (workflow plan 22): fit a 3D LUT from pairs of a RAW file and the JPEG the camera wrote next
//! to it, so a camera's picture style (a Fujifilm film simulation, another brand's picture profile) becomes a look.
//!
//! 1. [`neutral_render`]: the RAW is developed with neutral settings ([`neutral_settings`]: the defaults without
//!    sharpening; the display look on for RAW, as every RAW render has it) to display-referred sRGB at a working size
//!    ([`FitOptions::work_edge`]), on the CPU in 16 bits. The fitted LUT then maps exactly what the render feeds the
//!    LUT op (output-encoded values after the curves) to what the camera wrote.
//! 2. [`sample_pair`]: the JPEG (decoded at the same size, to sRGB) is lined up with the render ([`align`]: one
//!    scale and offset, then a small offset per tile); a pair whose alignment scores under [`MIN_SCORE`] is
//!    refused. Both are blurred 3×3 and only flat pixels (low local gradient, away from the border) are kept, where
//!    a pixel of misalignment, the camera's sharpening and its lens corrections change nothing.
//! 3. [`fit_samples`]: least squares over every pair at once on a `33³` lattice with a smoothness term
//!    (`solve.rs`), twice: the second pass down-weights the pairs the first one fits badly (residual
//!    `r` gets weight `1 / (1 + (r / 0.03)²)`), which removes most misaligned and clipped pixels.
//!
//! [`fit_files`] runs it on file pairs with progress and cancel; [`mean_delta_e`] (CIE76 ΔE*ab on CIELAB D65) says
//! how close the fitted LUT gets. Any decodable source works: without the `raw` feature RAW files are refused by
//! the decoder, the rest of the module does not depend on it.

mod align;
mod solve;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use rayon::prelude::*;
use serde::Serialize;

pub use align::{align, align_with, Alignment, MIN_SCORE};

use crate::color::{matrix, transfer, OutputProfile};
use crate::cpu::RenderOptions;
use crate::decode::decode_file;
use crate::error::{Error, Result};
use crate::geometry::Quality;
use crate::gpu::RenderBackend;
use crate::image::{LinearImage, Rgb16Image, Rgb8Image};
use crate::lut::Lut3d;
use crate::render::render_full16_with_options;
use crate::settings::DevelopSettings;

/// Lattice points per side of a fitted LUT.
pub const FIT_SIZE: usize = 33;
/// Long edge of the working images.
pub const WORK_EDGE: u32 = 1200;
/// Most pixel pairs kept per image pair.
pub const MAX_SAMPLES_PER_PAIR: usize = 200_000;
/// The error message of a cancelled fit (the editor's `CANCELLED`).
pub const CANCELLED: &str = "Cancelled";
/// Border left out of the samples, as a fraction of each side (vignetting and lens corrections live there).
const MARGIN: f32 = 0.03;
/// The residual (sRGB-encoded, Euclidean) at which the second pass halves a pair's weight.
const ROBUST_SCALE: f32 = 0.03;

/// An sRGB-encoded (display-referred) image, values 0..1, row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct SrgbImage {
    pub width: usize,
    pub height: usize,
    pub data: Vec<[f32; 3]>,
}

impl SrgbImage {
    pub fn from_rgb16(img: &Rgb16Image) -> SrgbImage {
        let data = img.data.chunks_exact(3).map(|p| [0, 1, 2].map(|c| p[c] as f32 / 65535.0)).collect();
        SrgbImage { width: img.width as usize, height: img.height as usize, data }
    }

    pub fn from_rgb8(img: &Rgb8Image) -> SrgbImage {
        let data = img.data.chunks_exact(3).map(|p| [0, 1, 2].map(|c| p[c] as f32 / 255.0)).collect();
        SrgbImage { width: img.width as usize, height: img.height as usize, data }
    }

    /// A decoded image (linear Rec.2020) as sRGB, out-of-gamut values clipped.
    pub fn from_linear(img: &LinearImage) -> SrgbImage {
        let m = matrix::to_f32(&matrix::rec2020_to_srgb());
        let data = img
            .data
            .par_chunks_exact(3)
            .map(|p| matrix::apply_f32(&m, p[0], p[1], p[2]).map(|v| transfer::linear_to_srgb(v.clamp(0.0, 1.0))))
            .collect();
        SrgbImage { width: img.width as usize, height: img.height as usize, data }
    }

    /// 8-bit, rounded (tests and debugging).
    pub fn to_rgb8(&self) -> Rgb8Image {
        let data = self.data.iter().flat_map(|p| p.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)).collect();
        Rgb8Image::new(self.width as u32, self.height as u32, data)
    }

    fn luma(&self) -> Vec<f32> {
        self.data.iter().map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).collect()
    }

    /// 3×3 box blur (edges clamped).
    fn blur3(&self) -> SrgbImage {
        let (w, h) = (self.width, self.height);
        let data = (0..w * h)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let mut acc = [0.0f32; 3];
                let mut n = 0.0;
                for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                    for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                        let p = self.data[yy * w + xx];
                        for c in 0..3 {
                            acc[c] += p[c];
                        }
                        n += 1.0;
                    }
                }
                acc.map(|v| v / n)
            })
            .collect();
        SrgbImage { width: w, height: h, data }
    }

    /// Bilinear sample at continuous `(x, y)` (pixel centres at `i + 0.5`), `None` outside the pixel centres.
    pub fn sample(&self, x: f32, y: f32) -> Option<[f32; 3]> {
        let (w, h) = (self.width, self.height);
        let (u, v) = (x - 0.5, y - 0.5);
        if !(u >= 0.0 && v >= 0.0 && u <= (w - 1) as f32 && v <= (h - 1) as f32) || w < 2 || h < 2 {
            return None;
        }
        let (x0, y0) = ((u as usize).min(w - 2), (v as usize).min(h - 2));
        let (fx, fy) = (u - x0 as f32, v - y0 as f32);
        let at = |xx: usize, yy: usize| self.data[yy * w + xx];
        let (a, b, c, d) = (at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1));
        Some(std::array::from_fn(|k| {
            (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy
        }))
    }
}

/// The settings the RAW is developed with: the defaults (as-shot white balance, no tone or colour change) without
/// output sharpening.
pub fn neutral_settings() -> DevelopSettings {
    let mut settings = DevelopSettings::default();
    settings.detail.sharpen.amount = 0.0;
    settings
}

/// Develop `source` with [`neutral_settings`] to sRGB, 16 bits on the CPU, at its own size; the display look is on
/// for RAW sources ([`RenderOptions::for_image`]).
pub fn neutral_render(source: &LinearImage) -> Result<SrgbImage> {
    let options =
        RenderOptions { look: source.meta.is_raw, backend: RenderBackend::Cpu, output: OutputProfile::Srgb };
    let quality = Quality::for_size(source.width, source.height);
    Ok(SrgbImage::from_rgb16(&render_full16_with_options(source, &neutral_settings(), quality, &options)?))
}

/// The pixel pairs of one RAW/JPEG pair: the developed RAW and the camera JPEG at the same place, sRGB-encoded.
#[derive(Debug, Clone, Default)]
pub struct PairSamples {
    pub source: Vec<[f32; 3]>,
    pub target: Vec<[f32; 3]>,
    pub alignment: Alignment,
}

/// Line up `target` (the camera JPEG) with `source` (the neutral render) and collect pixel pairs from the flat parts
/// of the image. Refuses images of another aspect ratio and pairs that do not line up ([`MIN_SCORE`]).
pub fn sample_pair(source: &SrgbImage, target: &SrgbImage) -> Result<PairSamples> {
    sample_pair_with(source, target, &|| false)
}

/// [`sample_pair`], polling `cancelled` during the alignment and between its stages (the error is [`CANCELLED`]).
pub fn sample_pair_with(
    source: &SrgbImage,
    target: &SrgbImage,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<PairSamples> {
    let (sw, sh, tw, th) = (source.width, source.height, target.width, target.height);
    if sw < 32 || sh < 32 || tw < 32 || th < 32 {
        return Err(Error::Invalid("The images are too small to compare".into()));
    }
    let (sa, ta) = (sw as f32 / sh as f32, tw as f32 / th as f32);
    if (sa / ta - 1.0).abs() > 0.03 {
        let turned = ((sa * ta) - 1.0).abs() < 0.03;
        return Err(Error::Invalid(if turned {
            "The JPEG is turned relative to the RAW".into()
        } else {
            format!("The JPEG has another aspect ratio ({tw}×{th} against {sw}×{sh}); was it cropped in camera?")
        }));
    }
    let alignment = align_with(&source.luma(), sw, sh, &target.luma(), tw, th, cancelled)?;
    if alignment.score < MIN_SCORE {
        return Err(Error::Invalid(format!(
            "The JPEG does not line up with the RAW (match {:.2}, needs {MIN_SCORE}): is it the same shot, uncropped?",
            alignment.score.max(0.0)
        )));
    }
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let (src, tgt) = (source.blur3(), target.blur3());
    let luma = src.luma();
    let gradient: Vec<f32> = (0..sw * sh)
        .into_par_iter()
        .map(|i| {
            let (x, y) = (i % sw, i / sw);
            if x == 0 || y == 0 || x + 1 == sw || y + 1 == sh {
                return f32::MAX;
            }
            let dx = (luma[i + 1] - luma[i - 1]).abs();
            let dy = (luma[i + sw] - luma[i - sw]).abs();
            dx.max(dy)
        })
        .collect();
    // Flat pixels: under the median gradient, and under an absolute bound for busy images.
    let mut sorted: Vec<f32> = gradient.iter().copied().filter(|g| g.is_finite() && *g < f32::MAX).collect();
    sorted.sort_by(f32::total_cmp);
    let median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let limit = median.clamp(0.004, 0.03);
    let (mx, my) = ((sw as f32 * MARGIN) as usize, (sh as f32 * MARGIN) as usize);
    let mut pairs: Vec<([f32; 3], [f32; 3])> = (my..sh - my)
        .into_par_iter()
        .flat_map_iter(|y| {
            let (src, tgt, gradient, alignment) = (&src, &tgt, &gradient, &alignment);
            (mx..sw - mx).filter_map(move |x| {
                let i = y * sw + x;
                if gradient[i] > limit {
                    return None;
                }
                let (qx, qy) = alignment.map(x as f32 + 0.5, y as f32 + 0.5);
                tgt.sample(qx, qy).map(|t| (src.data[i], t))
            })
        })
        .collect();
    if pairs.len() > MAX_SAMPLES_PER_PAIR {
        let step = pairs.len() as f64 / MAX_SAMPLES_PER_PAIR as f64;
        pairs = (0..MAX_SAMPLES_PER_PAIR).map(|k| pairs[(k as f64 * step) as usize]).collect();
    }
    if pairs.len() < 1000 {
        return Err(Error::Invalid("Too few flat areas to compare in this pair".into()));
    }
    let (source, target) = pairs.into_iter().unzip();
    Ok(PairSamples { source, target, alignment })
}

/// [`neutral_render`] of `source`, then [`sample_pair`] against `target` (the decoded JPEG).
pub fn prepare_pair(source: &LinearImage, target: &LinearImage) -> Result<PairSamples> {
    sample_pair(&neutral_render(source)?, &SrgbImage::from_linear(target))
}

/// How a fit runs.
#[derive(Debug, Clone, PartialEq)]
pub struct FitOptions {
    /// Lattice points per side.
    pub size: usize,
    /// Weight of the smoothness term relative to the data.
    pub smoothness: f64,
    /// Long edge of the working images.
    pub work_edge: u32,
}

impl Default for FitOptions {
    fn default() -> Self {
        FitOptions { size: FIT_SIZE, smoothness: 0.02, work_edge: WORK_EDGE }
    }
}

/// A fitted LUT and how the fit went.
#[derive(Debug, Clone)]
pub struct Fitted {
    pub lut: Lut3d,
    /// Share of the lattice the pairs reach (the rest is the smooth continuation).
    pub coverage: f32,
    /// Final relative residual of the last solve (`‖b − Ax‖ / ‖b‖`, worst channel).
    pub residual: f64,
    /// Whether that solve reached its tolerance (else it stopped at its iteration cap; logged).
    pub converged: bool,
}

/// Fit a LUT to every pair's samples at once (see the module docs). `progress` gets the fraction done (0..1).
pub fn fit_samples(
    pairs: &[PairSamples],
    options: &FitOptions,
    cancelled: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(f32),
) -> Result<Fitted> {
    let n = options.size.clamp(crate::lut::MIN_SIZE, 65);
    let mut normal = solve::Normal::new(n);
    for pair in pairs {
        for (s, t) in pair.source.iter().zip(&pair.target) {
            normal.add(*s, *t, 1.0);
        }
    }
    let coverage = normal.coverage();
    let first = solve::solve(&normal, options.smoothness, None, cancelled, &mut |f| progress(f * 0.5))?;
    let lut = Lut3d { size: n, data: first.data, domain_min: [0.0; 3], domain_max: [1.0; 3], title: None };
    // Second pass: down-weight what the first one fits badly.
    let mut robust = solve::Normal::new(n);
    for pair in pairs {
        for (s, t) in pair.source.iter().zip(&pair.target) {
            let fitted = lut.apply(*s);
            let r2: f32 = (0..3).map(|c| (fitted[c] - t[c]).powi(2)).sum();
            robust.add(*s, *t, 1.0 / (1.0 + (r2 / (ROBUST_SCALE * ROBUST_SCALE)) as f64));
        }
    }
    let second = solve::solve(&robust, options.smoothness, Some(&lut.data), cancelled, &mut |f| progress(0.5 + f * 0.5))?;
    if second.converged {
        log::info!(
            "[photobook:develop] LUT fit converged: residual {:.2e} after {} iterations, coverage {coverage:.3}",
            second.residual,
            second.iterations
        );
    } else {
        log::warn!(
            "[photobook:develop] LUT fit did not converge: residual {:.2e} after {} iterations",
            second.residual,
            second.iterations
        );
    }
    Ok(Fitted { lut: Lut3d { data: second.data, ..lut }, coverage, residual: second.residual, converged: second.converged })
}

/// sRGB-encoded → CIELAB (D65 white).
pub fn srgb_to_lab(rgb: [f32; 3]) -> [f32; 3] {
    use std::sync::OnceLock;
    static M: OnceLock<(matrix::Mat3f, [f32; 3])> = OnceLock::new();
    let (m, white) = M.get_or_init(|| {
        let m = matrix::srgb_to_xyz();
        let white = matrix::apply(&m, [1.0; 3]);
        (matrix::to_f32(&m), white.map(|v| v as f32))
    });
    let lin = rgb.map(|v| transfer::srgb_to_linear(v.clamp(0.0, 1.0)));
    let xyz = matrix::apply_f32(m, lin[0], lin[1], lin[2]);
    const E: f32 = 216.0 / 24389.0;
    const K: f32 = 24389.0 / 27.0;
    let f = |t: f32| if t > E { t.cbrt() } else { (K * t + 16.0) / 116.0 };
    let [fx, fy, fz] = [f(xyz[0] / white[0]), f(xyz[1] / white[1]), f(xyz[2] / white[2])];
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIE76 colour difference ΔE*ab of two sRGB-encoded colours.
pub fn delta_e(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (p, q) = (srgb_to_lab(a), srgb_to_lab(b));
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

/// Mean ΔE between `lut` applied to a pair's developed RAW samples and the camera JPEG's.
pub fn mean_delta_e(lut: &Lut3d, pair: &PairSamples) -> f32 {
    if pair.source.is_empty() {
        return 0.0;
    }
    let sum: f64 =
        pair.source.par_iter().zip(pair.target.par_iter()).map(|(s, t)| delta_e(lut.apply(*s), *t) as f64).sum();
    (sum / pair.source.len() as f64) as f32
}

/// What happened to one file pair of [`fit_files`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairReport {
    pub raw: String,
    pub jpeg: String,
    /// Pixel pairs used (0 when the pair was left out).
    pub samples: usize,
    /// Alignment score ([`MIN_SCORE`] and up when used).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    /// Mean ΔE of the fitted LUT on this pair.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mean_delta_e: Option<f32>,
    /// Why the pair was left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The result of [`fit_files`].
#[derive(Debug, Clone)]
pub struct FitReport {
    pub lut: Lut3d,
    pub pairs: Vec<PairReport>,
    /// Mean ΔE over the pairs used (each pair weighs the same).
    pub mean_delta_e: f32,
    /// Share of the lattice the pairs reach.
    pub coverage: f32,
    /// Final relative residual of the solve, and whether it converged.
    pub residual: f64,
    pub converged: bool,
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Fit a LUT from `(raw, jpeg)` file pairs. A pair that cannot be decoded or does not line up is left out (its
/// report says why); the fit fails when none is left. `progress(done, total, detail)` reports two steps per pair
/// and twenty for the solve; `cancelled` is polled between steps and during the solve (the error is [`CANCELLED`]).
pub fn fit_files(
    pairs: &[(PathBuf, PathBuf)],
    options: &FitOptions,
    cancelled: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<FitReport> {
    const SOLVE_STEPS: usize = 20;
    let total = pairs.len() * 2 + SOLVE_STEPS;
    let stop = || if cancelled() { Err(Error::Invalid(CANCELLED.into())) } else { Ok(()) };
    // Only steps that change something are reported (the solve reports the same step many times).
    let mut last: Option<(usize, String)> = None;
    let mut progress = |done: usize, total: usize, detail: &str| {
        if last.as_ref().is_some_and(|(d, t)| *d == done && t == detail) {
            return;
        }
        last = Some((done, detail.to_string()));
        progress(done, total, detail);
    };
    let mut reports = Vec::with_capacity(pairs.len());
    let (mut used, mut samples): (Vec<usize>, Vec<PairSamples>) = (Vec::new(), Vec::new());
    for (i, (raw, jpeg)) in pairs.iter().enumerate() {
        stop()?;
        let (raw_name, jpeg_name) = (file_name(raw), file_name(jpeg));
        progress(2 * i, total, &format!("Developing {raw_name}"));
        let edge = Some(options.work_edge);
        // The render itself cannot stop half way; the decode before it is the slow part, polled after.
        let (developed, camera) = rayon::join(
            || decode_file(raw, edge).and_then(|img| stop().and_then(|_| neutral_render(&img))),
            || decode_file(jpeg, edge),
        );
        stop()?;
        progress(2 * i + 1, total, &format!("Comparing {raw_name} with {jpeg_name}"));
        let mut report =
            PairReport { raw: raw_name, jpeg: jpeg_name, samples: 0, score: None, mean_delta_e: None, error: None };
        match developed.and_then(|d| camera.and_then(|c| sample_pair_with(&d, &SrgbImage::from_linear(&c), cancelled))) {
            Ok(pair) => {
                report.samples = pair.source.len();
                report.score = Some(pair.alignment.score);
                used.push(reports.len());
                samples.push(pair);
            }
            Err(err) if err.to_string() == CANCELLED => return Err(err),
            Err(err) => {
                log::warn!("[photobook:develop] Match camera JPEG left out {} + {}: {err}", report.raw, report.jpeg);
                report.error = Some(err.to_string());
            }
        }
        reports.push(report);
    }
    if used.is_empty() {
        let why: Vec<String> =
            reports.iter().filter_map(|r| r.error.as_ref().map(|e| format!("{}: {e}", r.raw))).collect();
        return Err(Error::Invalid(format!("No pair could be used. {}", why.join(" "))));
    }
    let base = pairs.len() * 2;
    progress(base, total, "Fitting the LUT");
    let fitted = fit_samples(&samples, options, cancelled, &mut |f| {
        progress(base + (f * (SOLVE_STEPS - 1) as f32) as usize, total, "Fitting the LUT")
    })?;
    let lut = fitted.lut;
    let mut sum = 0.0;
    for (index, s) in used.iter().zip(&samples) {
        let de = mean_delta_e(&lut, s);
        reports[*index].mean_delta_e = Some(de);
        sum += de;
    }
    progress(total, total, "Done");
    Ok(FitReport {
        lut,
        pairs: reports,
        mean_delta_e: sum / used.len() as f32,
        coverage: fitted.coverage,
        residual: fitted.residual,
        converged: fitted.converged,
    })
}
