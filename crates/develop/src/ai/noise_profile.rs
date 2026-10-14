//! Noise profiles (workflow plan 23, WORKFLOW_PLAN section 9): measure a photo's noise from the photo itself, and
//! learn a curve per camera, source kind and ISO from the user's own photos over time.
//!
//! **Self-profile** ([`measure`]). On the decoded linear image (the editor passes the 1600 px working size), cut into
//! [`PATCH`]² blocks. Per block and channel: the mean, and the variance about the block's least-squares plane (so a
//! smooth gradient, a sky, still counts as flat), corrected for the three fitted parameters. A block is *flat* when
//! most of that variance is high-frequency: the white-noise-equivalent variance of Immerkær's 3×3 mask
//! `[1 −2 1]ᵀ⊗[1 −2 1]` (`mean(L²)/36`, blind to planes and to edges along either axis) over the plane-detrended
//! variance is about 1 for white noise and near 0 for texture, edges and shading. The threshold adapts to the image
//! (0.6 × the 90th percentile of that ratio, never under [`MIN_HIGH_PASS_SHARE`]), so the spatially correlated noise
//! of a demosaiced or JPEG-compressed file still passes, while an image that is texture everywhere yields no fit.
//! Blocks that are nearly black or touch clipping are skipped.
//!
//! Per channel, `variance = a·mean + b` (Poisson-Gaussian) is fitted on the flat blocks no brighter than
//! [`MAX_FIT_MEAN`] (a camera JPEG's shoulder squeezes highlight noise): quantile bins of the mean, per bin the median
//! mean and the variance read off the lower quartile (texture only adds variance), then a monotone lower envelope
//! (noise never falls as the level rises, so a clean brighter bin caps a textured darker one), weighted least squares
//! with relative weights, one round of outlier rejection and `a, b ≥ 0`. The result carries `σ` at mid-grey (`sqrt` of
//! the mean over channels of `a·0.18 + b`, linear units at the analysed size) and a confidence
//! `1 − exp(−patches / 300)` counted on the fitted blocks only, halved for every two stops mid-grey lies outside the
//! fitted range of means (`extrapolated`). Fewer than [`MIN_PATCHES`] fitted blocks (a bright snow or sky picture),
//! or a channel without noise, give no fit (σ 0, confidence 0), never a zero curve.
//!
//! Measured this way, 8-bit quantisation alone reads about 0.3 % of mid-grey (`σ / 0.18`), a synthetic ISO 12800-like
//! JPEG (5 % before compression) about 2.3 % (4:2:0 chroma subsampling and quantisation remove about half the
//! variance, as in a camera JPEG), and the repo's Lisbon fixtures (2400 px exports with a grain look) 1 to 14 %. RAW
//! decodes carry no noise reduction: the ON1 sample RAWs read 1.1 to 2.1 % at ISO 100 to 200, 2.8 to 4.6 % at ISO 800
//! to 1600 and 12 % at ISO 12800, which is why the editor maps RAW and processed σ on separate scales.
//!
//! σ is measured at the analysed size on purpose: a photobook shows photos near that size, so the same sensor noise
//! matters less on a 45 MP file than on a 12 MP one. Callers that work at full size scale σ themselves.
//!
//! **Learned profiles** ([`ProfileStore`]): `<dir>/<make>-<model>.json` (the editor's dir is
//! `<appdata>/noise-profiles`; both names required, slugged, at most [`MAX_SLUG`] characters), one file per camera,
//! with per-ISO entries kept apart for RAW and processed (JPEG, HEIC, PNG) sources, whose noise differs by an order
//! of magnitude for the same ISO. An entry keeps the newest [`MAX_FITS`] fits `{ a: [3], b: [3], sigma }`, `n` and the
//! learned photos' hash prefixes. Its curve is the component-wise median of the fits that agree (σ within
//! [`AGREE_RATIO`] of the median σ) and is *established*, so used, once [`MIN_AGREEING_FITS`] agree: one bad photo,
//! first or not, never sets it. [`ProfileStore::learn`] stores a fit once per photo hash, refuses invalid fits
//! (σ 0, a channel without noise, NaN or negative parameters) and fits under [`MIN_LEARN_CONFIDENCE`], and, once the
//! entry is established, fits more than [`AGREE_RATIO`] off. A file that is there but not a profile of this version is
//! copied to `.json.bak` before it is replaced. [`profile_at`] returns an ISO's established curve, else one
//! interpolated log-log in ISO between established neighbours, else scaled from the nearest (`a ∝ ISO`, `b ∝ ISO²`),
//! never from more than [`MAX_ISO_STOPS`] away; its confidence halves per stop of distance. [`blend`] mixes a photo's
//! own fit with that curve by their confidences.
//!
//! Pure Rust, no ONNX: it sits in `ai` because it feeds the denoise (plans 24, 27, 28).

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::image::LinearImage;

/// Part of the cached measurement (`noise.json`): bump when [`measure`] changes.
pub const PROFILE_ENGINE: &str = "noise-profile/2";
/// Block size, px.
pub const PATCH: usize = 16;
/// Linear mid-grey, where [`NoiseFit::sigma`] is read off the curve.
pub const MID_GREY: f64 = 0.18;
/// Smallest share of a block's variance the high-pass mask must see for the block to count as flat.
pub const MIN_HIGH_PASS_SHARE: f64 = 0.1;
/// Blocks whose mean (any channel) is below this are skipped (black crush, quantisation).
pub const MIN_MEAN: f64 = 0.002;
/// Blocks brighter than this (per channel) are left out of the fit: a camera JPEG's tone curve shoulder squeezes
/// highlight noise, which would pull the curve down.
pub const MAX_FIT_MEAN: f64 = 0.6;
/// Blocks with a value at or above this are skipped (clipping).
pub const CLIP_HIGH: f32 = 0.95;
/// Every stop the fitted range of means ends short of mid-grey multiplies the confidence by `0.5^(1/2)`: the curve is
/// extrapolated there.
pub const EXTRAPOLATION_HALVING_STOPS: f64 = 2.0;
/// Patches for a confidence of `1 − 1/e`.
pub const CONFIDENCE_PATCHES: f64 = 300.0;
/// Fewer fitted flat blocks than this: no fit (confidence 0).
pub const MIN_PATCHES: usize = 12;
/// Fits below this confidence are not learned.
pub const MIN_LEARN_CONFIDENCE: f64 = 0.3;
/// An ISO entry is *established* (its curve is used) once this many of its fits agree within [`AGREE_RATIO`].
pub const MIN_AGREEING_FITS: usize = 3;
/// Fits whose σ is within this factor of the entry's median σ agree; once established, a new fit outside it is an
/// outlier and is not stored.
pub const AGREE_RATIO: f64 = 2.0;
/// Fits kept per ISO entry (the newest); the curve is their component-wise median.
pub const MAX_FITS: usize = 16;
/// The nearest established ISO may be at most this many stops away for a curve to be read off it.
pub const MAX_ISO_STOPS: f64 = 2.0;
/// Photos (hash prefixes) remembered per ISO entry, so a photo is learned once.
pub const MAX_REMEMBERED_PHOTOS: usize = 1024;
/// Longest file name stem of a profile file (`<make>-<model>`).
pub const MAX_SLUG: usize = 80;
/// Version of the learned profile files.
pub const PROFILES_VERSION: u32 = 2;

/// `variance = a·mean + b` for one channel (linear units).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct ChannelFit {
    pub a: f64,
    pub b: f64,
}

impl ChannelFit {
    pub fn variance_at(&self, mean: f64) -> f64 {
        (self.a * mean + self.b).max(0.0)
    }
}

/// A photo's self-profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseFit {
    /// R, G, B (linear Rec.2020).
    pub channels: [ChannelFit; 3],
    /// σ at mid-grey ([`sigma_of`]), linear units at the analysed size.
    pub sigma: f64,
    /// `1 − exp(−patches / 300)`, times `0.5^(stops / 2)` when mid-grey is `stops` outside `range`; 0 when fewer
    /// than [`MIN_PATCHES`] flat blocks no brighter than [`MAX_FIT_MEAN`] were found (a bright snow or sky picture
    /// gives no fit rather than a zero one).
    pub confidence: f64,
    /// Flat blocks the fit used.
    pub patches: usize,
    /// Lowest and highest block mean (green) the fit used: where the curve is measured.
    pub range: [f64; 2],
    /// Mid-grey is outside `range`, so `sigma` is read off an extrapolated curve (and `confidence` is lowered).
    #[serde(default)]
    pub extrapolated: bool,
    /// Size of the analysed image.
    pub width: u32,
    pub height: u32,
}

impl NoiseFit {
    /// A usable fit: confident, finite, every channel with some noise at mid-grey.
    pub fn is_valid(&self) -> bool {
        self.sigma.is_finite()
            && self.sigma > 0.0
            && self.channels.iter().all(|c| {
                c.a.is_finite() && c.b.is_finite() && c.a >= 0.0 && c.b >= 0.0 && c.variance_at(MID_GREY) > 0.0
            })
    }
}

/// σ at mid-grey of a curve: `sqrt(mean_c(a_c·0.18 + b_c))`.
pub fn sigma_of(channels: &[ChannelFit; 3]) -> f64 {
    (channels.iter().map(|c| c.variance_at(MID_GREY)).sum::<f64>() / 3.0).sqrt()
}

/// One flat-candidate block.
#[derive(Debug, Clone, Copy)]
struct Block {
    mean: [f64; 3],
    var: [f64; 3],
    /// High-pass (Immerkær) variance over the plane-detrended variance, summed over channels: about 1 for white
    /// noise, near 0 for texture and edges.
    share: f64,
}

/// Measure the noise of `image` (see the module notes). Never fails: an image without flat areas gives a fit with
/// confidence 0 and zero curves.
pub fn measure(image: &LinearImage) -> NoiseFit {
    let (w, h) = (image.width as usize, image.height as usize);
    let (bx, by) = (w / PATCH, h / PATCH);
    let blocks: Vec<Block> = (0..bx * by)
        .into_par_iter()
        .filter_map(|i| block_stats(image, (i % bx) * PATCH, (i / bx) * PATCH))
        .collect();
    let empty = NoiseFit {
        channels: [ChannelFit::default(); 3],
        sigma: 0.0,
        confidence: 0.0,
        patches: 0,
        range: [0.0, 0.0],
        extrapolated: false,
        width: image.width,
        height: image.height,
    };
    if blocks.len() < MIN_PATCHES {
        return empty;
    }
    let mut shares: Vec<f64> = blocks.iter().map(|b| b.share).collect();
    shares.sort_by(f64::total_cmp);
    let q90 = shares[shares.len() * 9 / 10];
    let threshold = (0.6 * q90).max(MIN_HIGH_PASS_SHARE);
    // Flat blocks no brighter than MAX_FIT_MEAN in any channel: the ones the curve is fitted on, and what the
    // confidence counts.
    let fitted: Vec<&Block> =
        blocks.iter().filter(|b| b.share >= threshold && b.mean.iter().all(|&m| m <= MAX_FIT_MEAN)).collect();
    if fitted.len() < MIN_PATCHES {
        return empty;
    }
    let channels = [0, 1, 2].map(|c| {
        let points: Vec<(f64, f64)> = fitted.iter().map(|b| (b.mean[c], b.var[c])).collect();
        fit_channel(&points)
    });
    let (lo, hi) =
        fitted.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), b| (lo.min(b.mean[1]), hi.max(b.mean[1])));
    // Stops between mid-grey and the measured range (0 inside it).
    let outside = if MID_GREY < lo {
        (lo / MID_GREY).log2()
    } else if MID_GREY > hi {
        (MID_GREY / hi.max(1e-9)).log2()
    } else {
        0.0
    };
    let fit = NoiseFit {
        channels,
        sigma: sigma_of(&channels),
        confidence: (1.0 - (-(fitted.len() as f64) / CONFIDENCE_PATCHES).exp())
            * 0.5f64.powf(outside / EXTRAPOLATION_HALVING_STOPS),
        patches: fitted.len(),
        range: [lo, hi],
        extrapolated: outside > 0.0,
        width: image.width,
        height: image.height,
    };
    if fit.is_valid() {
        fit
    } else {
        // A channel without measurable noise (perfectly flat synthetic data): no fit, not a zero one.
        NoiseFit { patches: fitted.len(), range: [lo, hi], ..empty }
    }
}

/// Mean, plane-detrended variance and high-pass share of the block at `(x0, y0)`; `None` when it is nearly black,
/// touches clipping or has no variance at all.
fn block_stats(image: &LinearImage, x0: usize, y0: usize) -> Option<Block> {
    const N: usize = PATCH * PATCH;
    let w = image.width as usize;
    let mut planes = [[0f64; N]; 3];
    for y in 0..PATCH {
        let row = &image.data[((y0 + y) * w + x0) * 3..((y0 + y) * w + x0 + PATCH) * 3];
        for x in 0..PATCH {
            for c in 0..3 {
                let v = row[x * 3 + c];
                if !v.is_finite() || v >= CLIP_HIGH {
                    return None;
                }
                planes[c][y * PATCH + x] = v as f64;
            }
        }
    }
    let centre = (PATCH as f64 - 1.0) / 2.0;
    // Σu² over the block (same for v): PATCH · Σ_k (k − centre)².
    let suu: f64 = PATCH as f64 * (0..PATCH).map(|k| (k as f64 - centre).powi(2)).sum::<f64>();
    let mut mean = [0f64; 3];
    let mut var = [0f64; 3];
    let mut high_pass = 0f64;
    let mut var_sum = 0f64;
    for c in 0..3 {
        let p = &planes[c];
        let m = p.iter().sum::<f64>() / N as f64;
        if m < MIN_MEAN {
            return None;
        }
        high_pass += laplacian_variance(p);
        let (mut sx, mut sy) = (0f64, 0f64);
        for y in 0..PATCH {
            for x in 0..PATCH {
                let v = p[y * PATCH + x] - m;
                sx += (x as f64 - centre) * v;
                sy += (y as f64 - centre) * v;
            }
        }
        let (gx, gy) = (sx / suu, sy / suu);
        let mut ss = 0f64;
        for y in 0..PATCH {
            for x in 0..PATCH {
                let e = p[y * PATCH + x] - m - gx * (x as f64 - centre) - gy * (y as f64 - centre);
                ss += e * e;
            }
        }
        let v = ss / (N - 3) as f64;
        mean[c] = m;
        var[c] = v;
        var_sum += v;
    }
    (var_sum > 0.0).then(|| Block { mean, var, share: high_pass / var_sum })
}

/// White-noise-equivalent variance of a block from Immerkær's mask `[1 −2 1]ᵀ⊗[1 −2 1]` (Σw² = 36) over its
/// interior: `mean(L²) / 36`.
fn laplacian_variance(p: &[f64; PATCH * PATCH]) -> f64 {
    let at = |x: usize, y: usize| p[y * PATCH + x];
    let mut sum = 0f64;
    for y in 1..PATCH - 1 {
        for x in 1..PATCH - 1 {
            let l = at(x - 1, y - 1) - 2.0 * at(x, y - 1) + at(x + 1, y - 1) - 2.0 * at(x - 1, y) + 4.0 * at(x, y)
                - 2.0 * at(x + 1, y)
                + at(x - 1, y + 1)
                - 2.0 * at(x, y + 1)
                + at(x + 1, y + 1);
            sum += l * l;
        }
    }
    sum / (36.0 * ((PATCH - 2) * (PATCH - 2)) as f64)
}

/// The mean of a block-variance population read off its lower quartile: texture only ever adds variance, so the low
/// end of a bin is the noise. The 25th percentile of the variance of `PATCH² − 3` white-noise samples sits
/// `0.674·sqrt(2 / (PATCH² − 3))` below its mean, which is divided back out.
fn lower_quartile_mean(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let q25 = values[(values.len() - 1) / 4];
    let dof = (PATCH * PATCH - 3) as f64;
    q25 / (1.0 - 0.674 * (2.0 / dof).sqrt())
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Fit `v = a·μ + b` on `(μ, v)` points: quantile bins of μ, the median μ and [`lower_quartile_mean`] v of each,
/// weighted least squares with relative weights (`count / v²`), one round of outlier rejection, `a, b ≥ 0`. A narrow
/// range of means (one level) gives `a = 0` and `b` the bins' median.
fn fit_channel(points: &[(f64, f64)]) -> ChannelFit {
    let mut sorted = points.to_vec();
    sorted.sort_by(|p, q| p.0.total_cmp(&q.0));
    let bins = (sorted.len() / 12).clamp(1, 16);
    let per = sorted.len() / bins;
    let mut stats: Vec<(f64, f64, f64)> = Vec::with_capacity(bins);
    for k in 0..bins {
        let end = if k + 1 == bins { sorted.len() } else { (k + 1) * per };
        let chunk = &sorted[k * per..end];
        let mut mus: Vec<f64> = chunk.iter().map(|p| p.0).collect();
        let mut vs: Vec<f64> = chunk.iter().map(|p| p.1).collect();
        stats.push((median(&mut mus), lower_quartile_mean(&mut vs), chunk.len() as f64));
    }
    let constant = |stats: &[(f64, f64, f64)]| {
        let mut vs: Vec<f64> = stats.iter().map(|s| s.1).collect();
        ChannelFit { a: 0.0, b: median(&mut vs).max(0.0) }
    };
    let (lo, hi) = (stats.first().map_or(0.0, |s| s.0), stats.last().map_or(0.0, |s| s.0));
    if stats.len() < 3 || hi - lo < 0.02 || hi < 1.25 * lo {
        return constant(&stats);
    }
    // Noise variance never falls as the level rises (a, b ≥ 0), while texture only adds: a brighter bin with less
    // variance caps every darker one (foliage in the shadows under a clean sky).
    for k in (0..stats.len().saturating_sub(1)).rev() {
        stats[k].1 = stats[k].1.min(stats[k + 1].1);
    }
    let mut fit = wls(&stats);
    // One round of outlier rejection on the relative residuals.
    let residual = |fit: &ChannelFit, s: &(f64, f64, f64)| {
        let predicted = fit.variance_at(s.0).max(1e-20);
        (s.1 - predicted).abs() / predicted
    };
    let mut res: Vec<f64> = stats.iter().map(|s| residual(&fit, s)).collect();
    let limit = (3.0 * median(&mut res)).max(0.15);
    let kept: Vec<(f64, f64, f64)> = stats.iter().copied().filter(|s| residual(&fit, s) <= limit).collect();
    if kept.len() >= 3 && kept.len() < stats.len() {
        fit = wls(&kept);
    }
    fit
}

/// Weighted least squares of `v = a·μ + b` with weights `count / v²`, constrained to `a, b ≥ 0`.
fn wls(stats: &[(f64, f64, f64)]) -> ChannelFit {
    let weight = |s: &(f64, f64, f64)| s.2 / s.1.max(1e-20).powi(2);
    let (mut sw, mut sx, mut sy, mut sxx, mut sxy) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for s in stats {
        let w = weight(s);
        sw += w;
        sx += w * s.0;
        sy += w * s.1;
        sxx += w * s.0 * s.0;
        sxy += w * s.0 * s.1;
    }
    let det = sw * sxx - sx * sx;
    if det.abs() < 1e-300 || sw == 0.0 {
        return ChannelFit { a: 0.0, b: if sw > 0.0 { (sy / sw).max(0.0) } else { 0.0 } };
    }
    let a = (sw * sxy - sx * sy) / det;
    let b = (sy - a * sx) / sw;
    if a < 0.0 {
        return ChannelFit { a: 0.0, b: (sy / sw).max(0.0) };
    }
    if b < 0.0 {
        return ChannelFit { a: if sxx > 0.0 { (sxy / sxx).max(0.0) } else { 0.0 }, b: 0.0 };
    }
    ChannelFit { a, b }
}

// ---------------------------------------------------------------------------------------------
// Learned profiles

/// Where a photo's pixels came from: a camera RAW (linear sensor data) or a processed file (JPEG, HEIC, PNG; the
/// camera's own noise reduction and tone curve already applied). Learned separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Raw,
    #[default]
    Processed,
}

/// One photo's curve as stored in an ISO entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredFit {
    pub a: [f64; 3],
    pub b: [f64; 3],
    pub sigma: f64,
}

impl StoredFit {
    pub fn channels(&self) -> [ChannelFit; 3] {
        [0, 1, 2].map(|c| ChannelFit { a: self.a[c], b: self.b[c] })
    }
}

/// One ISO of a learned profile file: the newest [`MAX_FITS`] fits. The curve is the component-wise median of the
/// fits that agree (σ within [`AGREE_RATIO`] of the median σ), used once [`MIN_AGREEING_FITS`] agree, so one bad
/// photo, first or not, never sets the curve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct IsoEntry {
    pub fits: Vec<StoredFit>,
    /// Photos learned at this ISO in all (outliers not counted).
    pub n: u32,
    /// The first 16 hex digits of each learned photo's hash (at most [`MAX_REMEMBERED_PHOTOS`]), so a photo counts once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub photos: Vec<String>,
}

fn median_of(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    median(&mut values)
}

impl IsoEntry {
    /// The fits that agree with the median σ.
    fn agreeing(&self) -> Vec<&StoredFit> {
        let m = median_of(self.fits.iter().map(|f| f.sigma).collect());
        self.fits.iter().filter(|f| m > 0.0 && (m / AGREE_RATIO..=m * AGREE_RATIO).contains(&f.sigma)).collect()
    }

    /// Enough fits agree for the curve to be used.
    pub fn established(&self) -> bool {
        self.agreeing().len() >= MIN_AGREEING_FITS
    }

    /// The component-wise median of the agreeing fits (of every fit while not established), and how many agree.
    pub fn curve(&self) -> ([ChannelFit; 3], usize) {
        let agreeing = self.agreeing();
        let used: Vec<&StoredFit> =
            if agreeing.len() >= MIN_AGREEING_FITS { agreeing.clone() } else { self.fits.iter().collect() };
        let channels = [0, 1, 2].map(|c| ChannelFit {
            a: median_of(used.iter().map(|f| f.a[c]).collect()),
            b: median_of(used.iter().map(|f| f.b[c]).collect()),
        });
        (channels, agreeing.len())
    }
}

/// `<make>-<model>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ProfileFile {
    pub version: u32,
    pub make: String,
    pub model: String,
    #[serde(default)]
    pub raw: BTreeMap<u32, IsoEntry>,
    #[serde(default)]
    pub processed: BTreeMap<u32, IsoEntry>,
}

impl ProfileFile {
    pub fn entries(&self, source: SourceKind) -> &BTreeMap<u32, IsoEntry> {
        match source {
            SourceKind::Raw => &self.raw,
            SourceKind::Processed => &self.processed,
        }
    }

    fn entries_mut(&mut self, source: SourceKind) -> &mut BTreeMap<u32, IsoEntry> {
        match source {
            SourceKind::Raw => &mut self.raw,
            SourceKind::Processed => &mut self.processed,
        }
    }
}

/// A camera's learned curve at one ISO.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraProfile {
    pub make: String,
    pub model: String,
    pub source: SourceKind,
    pub iso: u32,
    pub channels: [ChannelFit; 3],
    /// σ at mid-grey of `channels`.
    pub sigma: f64,
    /// Photos learned at exactly this ISO (0 when there is no entry for it).
    pub photos: u32,
    /// Photos learned at every ISO of this source.
    pub total_photos: u32,
    /// Fits that agree in the entry (or entries) the curve comes from.
    pub agreeing: u32,
    /// The curve comes from established entries (at least [`MIN_AGREEING_FITS`] agreeing fits). An unestablished
    /// curve is only reported (its confidence is 0, nothing blends it in).
    pub established: bool,
    /// Read off other ISOs rather than this one.
    pub interpolated: bool,
    /// Stops from `iso` to the nearest ISO the curve was read from (0 for this ISO's own entry).
    pub distance: f64,
    /// The ISOs with an entry, ascending.
    pub isos: Vec<u32>,
}

impl CameraProfile {
    /// How much to trust the curve: `1 − exp(−agreeing / 3)`, halved for every stop of `distance`, and 0 while not
    /// established.
    pub fn confidence(&self) -> f64 {
        if !self.established {
            return 0.0;
        }
        (1.0 - (-(self.agreeing as f64) / 3.0).exp()) * 0.5f64.powf(self.distance)
    }
}

/// What [`ProfileStore::learn`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Learned {
    /// A new ISO entry.
    Added,
    /// Stored in an existing ISO entry.
    Averaged,
    /// This photo is already part of the entry.
    AlreadyKnown,
    /// Confidence under [`MIN_LEARN_CONFIDENCE`].
    LowConfidence,
    /// σ more than [`AGREE_RATIO`] away from an established entry's.
    Outlier,
    /// Not a usable fit (σ 0, a channel without noise, NaN or negative parameters), no photo hash, or no camera name.
    Invalid,
}

/// A photo's own fit mixed with its camera's learned curve.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blend {
    pub channels: [ChannelFit; 3],
    pub sigma: f64,
    /// `1 − (1 − c_fit)(1 − c_learned)`.
    pub confidence: f64,
    /// Weight of the photo's own fit, 0..1.
    pub own_weight: f64,
}

/// Mix `fit` and `learned` by confidence (`c_fit / (c_fit + c_learned)` for the fit, [`CameraProfile::confidence`]
/// for the curve, which is 0 while it is not established and falls with its ISO distance). Without a learned curve,
/// or with one of confidence 0, it is the fit.
pub fn blend(fit: &NoiseFit, learned: Option<&CameraProfile>) -> Blend {
    let own = fit.confidence;
    let prior = learned.map_or(0.0, CameraProfile::confidence);
    let (Some(learned), true) = (learned, prior > 0.0) else {
        return Blend { channels: fit.channels, sigma: fit.sigma, confidence: own, own_weight: 1.0 };
    };
    let w = if own + prior > 0.0 { own / (own + prior) } else { 0.0 };
    let channels = [0, 1, 2].map(|c| ChannelFit {
        a: w * fit.channels[c].a + (1.0 - w) * learned.channels[c].a,
        b: w * fit.channels[c].b + (1.0 - w) * learned.channels[c].b,
    });
    Blend { channels, sigma: sigma_of(&channels), confidence: 1.0 - (1.0 - own) * (1.0 - prior), own_weight: w }
}

/// Serialises read-modify-write of the profile files in this process.
static LEARN_LOCK: Mutex<()> = Mutex::new(());

/// The learned profiles in a directory (`<appdata>/noise-profiles` in the editor).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileStore {
    dir: PathBuf,
}

/// `fujifilm-x-t5`: lower-case ASCII letters and digits, every other run of characters one `-`, at most `max` bytes.
/// A name with no ASCII letter or digit becomes `x` and 12 hex digits of its SHA-256, so it still gets a file of its own.
pub fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut out = out.trim_matches('-').to_string();
    if out.is_empty() && !text.trim().is_empty() {
        use sha2::{Digest, Sha256};
        out = format!("x{}", &hex::encode(Sha256::digest(text.trim().as_bytes()))[..12]);
    }
    out.truncate(max);
    out.trim_end_matches('-').to_string()
}

/// The profile file read as text, with whether it should be backed up before it is replaced (present, but not a
/// profile of this version).
enum Loaded {
    Missing,
    Current(ProfileFile),
    Foreign,
}

impl ProfileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// `<dir>/<slug(make)>-<slug(model)>.json` (at most [`MAX_SLUG`] characters before `.json`); `None` unless both
    /// the make and the model are given.
    pub fn file_path(&self, make: &str, model: &str) -> Option<PathBuf> {
        if make.trim().is_empty() || model.trim().is_empty() {
            return None;
        }
        let make = slug(make, 32);
        let model = slug(model, MAX_SLUG - make.len() - 1);
        (!make.is_empty() && !model.is_empty()).then(|| self.dir.join(format!("{make}-{model}.json")))
    }

    fn read(&self, path: &Path) -> Loaded {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
            Err(err) => {
                log::info!("[photobook:noise] {} is unreadable ({err})", path.display());
                return Loaded::Foreign;
            }
        };
        match serde_json::from_str::<ProfileFile>(&text) {
            Ok(file) if file.version == PROFILES_VERSION => Loaded::Current(file),
            Ok(file) => {
                log::info!("[photobook:noise] {}: version {} is not {PROFILES_VERSION}", path.display(), file.version);
                Loaded::Foreign
            }
            Err(err) => {
                log::info!("[photobook:noise] {} is not a noise profile ({err})", path.display());
                Loaded::Foreign
            }
        }
    }

    /// The camera's file: empty when missing, unreadable, or of another version (logged).
    pub fn load(&self, make: &str, model: &str) -> ProfileFile {
        let empty = ProfileFile { version: PROFILES_VERSION, make: make.into(), model: model.into(), ..Default::default() };
        match self.file_path(make, model).map(|p| self.read(&p)) {
            Some(Loaded::Current(file)) => file,
            _ => empty,
        }
    }

    /// The camera's curve at `iso` for `source` ([`profile_at`]).
    pub fn lookup(&self, make: &str, model: &str, source: SourceKind, iso: u32) -> Option<CameraProfile> {
        profile_at(&self.load(make, model), source, iso)
    }

    /// Fold `fit` (of the photo with content hash `hash`) into the camera's entry for `iso` and write the file
    /// (temp file + rename; a file that is there but not a profile of this version is first copied to
    /// `<name>.json.bak`). Returns what happened and the camera's curve at `iso` afterwards.
    pub fn learn(
        &self,
        make: &str,
        model: &str,
        source: SourceKind,
        iso: u32,
        hash: &str,
        fit: &NoiseFit,
    ) -> std::io::Result<(Learned, Option<CameraProfile>)> {
        let Some(path) = self.file_path(make, model) else {
            return Ok((Learned::Invalid, None));
        };
        let _guard = LEARN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut file, foreign) = match self.read(&path) {
            Loaded::Current(file) => (file, false),
            Loaded::Missing => (ProfileFile::default(), false),
            Loaded::Foreign => (ProfileFile::default(), true),
        };
        let outcome = fold(&mut file, source, iso, hash, fit);
        if matches!(outcome, Learned::Added | Learned::Averaged) {
            file.version = PROFILES_VERSION;
            file.make = make.to_string();
            file.model = model.to_string();
            fs::create_dir_all(&self.dir)?;
            if foreign {
                let backup = path.with_extension("json.bak");
                fs::copy(&path, &backup)?;
                log::info!("[photobook:noise] kept the previous {} as {}", path.display(), backup.display());
            }
            let json = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
            write_atomic(&path, &json)?;
        }
        Ok((outcome, profile_at(&file, source, iso)))
    }
}

/// [`ProfileStore::learn`] on a file in memory (`hash` must be a hex content hash; only its first 16 digits are kept).
pub fn fold(file: &mut ProfileFile, source: SourceKind, iso: u32, hash: &str, fit: &NoiseFit) -> Learned {
    let id: String = hash.chars().take(16).collect();
    if iso == 0 || id.len() < 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) || !fit.is_valid() {
        return Learned::Invalid;
    }
    if fit.confidence < MIN_LEARN_CONFIDENCE {
        return Learned::LowConfidence;
    }
    let entries = file.entries_mut(source);
    let added = !entries.contains_key(&iso);
    let entry = entries.entry(iso).or_default();
    if entry.photos.contains(&id) {
        return Learned::AlreadyKnown;
    }
    if entry.established() {
        let (curve, _) = entry.curve();
        let current = sigma_of(&curve);
        if current > 0.0 && !(current / AGREE_RATIO..=current * AGREE_RATIO).contains(&fit.sigma) {
            return Learned::Outlier;
        }
    }
    entry.fits.push(StoredFit { a: fit.channels.map(|c| c.a), b: fit.channels.map(|c| c.b), sigma: fit.sigma });
    if entry.fits.len() > MAX_FITS {
        let excess = entry.fits.len() - MAX_FITS;
        entry.fits.drain(..excess);
    }
    entry.n += 1;
    entry.photos.push(id);
    if entry.photos.len() > MAX_REMEMBERED_PHOTOS {
        let excess = entry.photos.len() - MAX_REMEMBERED_PHOTOS;
        entry.photos.drain(..excess);
    }
    if added {
        Learned::Added
    } else {
        Learned::Averaged
    }
}

/// `v` at `t` (0..1) between `lo` and `hi`, interpolated log-log (a power law in ISO, monotone between the two) when
/// both are positive, linearly otherwise.
fn log_lerp(lo: f64, hi: f64, t: f64) -> f64 {
    if lo > 0.0 && hi > 0.0 {
        lo * (hi / lo).powf(t)
    } else {
        lo + t * (hi - lo)
    }
}

/// The curve of `file` at `iso` for `source`, from its established entries: the entry for `iso` itself, else
/// interpolated log-log in ISO between the nearest established entries below and above, else scaled from the
/// nearest one (`a ∝ ISO`, `b ∝ ISO²`); never from an ISO more than [`MAX_ISO_STOPS`] away. When nothing established
/// is near, the unestablished entry for `iso` (if any) is reported with `established: false`. `None` otherwise.
pub fn profile_at(file: &ProfileFile, source: SourceKind, iso: u32) -> Option<CameraProfile> {
    let entries = file.entries(source);
    if entries.is_empty() || iso == 0 {
        return None;
    }
    let isos: Vec<u32> = entries.keys().copied().collect();
    let total_photos = entries.values().map(|e| e.n).sum();
    let photos = entries.get(&iso).map_or(0, |e| e.n);
    let make = |channels: [ChannelFit; 3], agreeing: usize, established: bool, distance: f64| CameraProfile {
        make: file.make.clone(),
        model: file.model.clone(),
        source,
        iso,
        sigma: sigma_of(&channels),
        channels,
        photos,
        total_photos,
        agreeing: agreeing as u32,
        established,
        interpolated: distance > 0.0,
        distance,
        isos: isos.clone(),
    };
    let curves: BTreeMap<u32, ([ChannelFit; 3], usize)> =
        entries.iter().filter(|(_, e)| e.established()).map(|(&k, e)| (k, e.curve())).collect();
    let stops = |other: u32| ((iso as f64) / (other as f64)).log2().abs();
    if let Some(&(channels, agreeing)) = curves.get(&iso) {
        return Some(make(channels, agreeing, true, 0.0));
    }
    let below = curves.range(..iso).next_back();
    let above = curves.range(iso..).next();
    let read = match (below, above) {
        (Some((&lo, (cl, nl))), Some((&hi, (ch, nh)))) => {
            let distance = stops(lo).min(stops(hi));
            let t = ((iso as f64).ln() - (lo as f64).ln()) / ((hi as f64).ln() - (lo as f64).ln());
            let channels =
                [0, 1, 2].map(|c| ChannelFit { a: log_lerp(cl[c].a, ch[c].a, t), b: log_lerp(cl[c].b, ch[c].b, t) });
            (distance <= MAX_ISO_STOPS).then(|| make(channels, (*nl).min(*nh), true, distance))
        }
        (Some((&near, (curve, n))), None) | (None, Some((&near, (curve, n)))) => {
            let distance = stops(near);
            let k = iso as f64 / near as f64;
            let channels = curve.map(|c| ChannelFit { a: c.a * k, b: c.b * k * k });
            (distance <= MAX_ISO_STOPS).then(|| make(channels, *n, true, distance))
        }
        (None, None) => None,
    };
    read.or_else(|| {
        let entry = entries.get(&iso)?;
        let (channels, agreeing) = entry.curve();
        Some(make(channels, agreeing, false, 0.0))
    })
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64* and Box-Muller: deterministic noise without a dependency.
    pub(super) struct Rng(u64);

    impl Rng {
        pub(super) fn new(seed: u64) -> Self {
            Self(seed.max(1))
        }
        fn next_u64(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn uniform(&mut self) -> f64 {
            ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
        }
        pub(super) fn gauss(&mut self) -> f64 {
            let (u, v) = (self.uniform(), self.uniform());
            (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
        }
        /// Poisson(λ): Knuth below 30, the normal approximation above.
        fn poisson(&mut self, lambda: f64) -> f64 {
            if lambda >= 30.0 {
                return (lambda + lambda.sqrt() * self.gauss()).round().max(0.0);
            }
            let l = (-lambda).exp();
            let (mut k, mut p) = (0.0, 1.0);
            loop {
                p *= self.uniform();
                if p <= l {
                    return k;
                }
                k += 1.0;
            }
        }
        /// Poisson-Gaussian: `a·Poisson(μ/a) + N(0, b)`, variance `a·μ + b`.
        pub(super) fn pg(&mut self, mean: f64, a: f64, b: f64) -> f64 {
            let shot = if a > 0.0 { a * self.poisson(mean / a) } else { mean };
            shot + b.sqrt() * self.gauss()
        }
    }

    /// Bands of constant level (not aligned with the blocks), a textured strip across the middle, Poisson-Gaussian
    /// noise with per-channel `(a, b)`.
    fn synthetic(w: u32, h: u32, fits: [(f64, f64); 3], seed: u64) -> LinearImage {
        let levels = [0.008, 0.015, 0.03, 0.05, 0.08, 0.12, 0.18, 0.26, 0.36, 0.48, 0.6, 0.72, 0.85];
        let band = (w as usize).div_ceil(levels.len());
        let mut rng = Rng::new(seed);
        let mut data = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let mut level = levels[(x / band).min(levels.len() - 1)];
                // Texture: a high-contrast pattern over a fifth of the height.
                if y * 5 / h as usize == 2 {
                    level *= 1.0 + 0.6 * ((x as f64 * 0.7).sin() * (y as f64 * 0.9).cos());
                }
                for &(a, b) in &fits {
                    data.push(rng.pg(level, a, b) as f32);
                }
            }
        }
        LinearImage::new(w, h, data)
    }

    fn close(got: f64, want: f64, tol: f64) -> bool {
        (got - want).abs() <= tol * want.abs()
    }

    #[test]
    fn recovers_poisson_gaussian_parameters() {
        let fits = [(2e-4, 4e-6), (1.5e-4, 3e-6), (3e-4, 6e-6)];
        let image = synthetic(1600, 1066, fits, 7);
        let fit = measure(&image);
        assert!(fit.patches > 2000, "{fit:?}");
        assert!(fit.confidence > 0.99, "{fit:?}");
        for (c, &(a, b)) in fits.iter().enumerate() {
            let got = fit.channels[c];
            assert!(close(got.a, a, 0.10) && close(got.b, b, 0.10), "channel {c}: {got:?} vs a {a} b {b}");
        }
        let want = sigma_of(&fits.map(|(a, b)| ChannelFit { a, b }));
        assert!(close(fit.sigma, want, 0.05), "σ {} vs {want}", fit.sigma);
    }

    #[test]
    fn recovers_read_noise_dominated_and_shot_dominated_curves() {
        for (a, b) in [(1e-5, 2e-5), (5e-4, 1e-7)] {
            let image = synthetic(1200, 800, [(a, b); 3], 11);
            let fit = measure(&image);
            let want = a * MID_GREY + b;
            let got = fit.channels[1].variance_at(MID_GREY);
            assert!(close(got, want, 0.10), "a {a} b {b}: {fit:?}");
        }
    }

    #[test]
    fn texture_is_not_taken_for_noise() {
        // A busy image (texture everywhere) with little noise must not report the texture as noise.
        let mut rng = Rng::new(3);
        let (w, h) = (800u32, 600u32);
        let mut data = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let base = 0.2 + 0.15 * ((x as f64 * 0.31).sin() + (y as f64 * 0.23).cos());
                for _ in 0..3 {
                    data.push(rng.pg(base, 1e-5, 1e-7) as f32);
                }
            }
        }
        let fit = measure(&LinearImage::new(w, h, data));
        // The texture's variance per block is around 1e-2; noise at mid grey is 1.9e-6.
        assert!(fit.channels[1].variance_at(MID_GREY) < 1e-4, "{fit:?}");
    }

    #[test]
    fn a_flat_clean_frame_has_a_low_sigma() {
        let mut rng = Rng::new(5);
        let data: Vec<f32> = (0..640 * 480 * 3).map(|_| rng.pg(0.18, 2e-6, 1e-8) as f32).collect();
        let fit = measure(&LinearImage::new(640, 480, data));
        assert!(fit.confidence > 0.9);
        assert!(close(fit.sigma, (2e-6f64 * 0.18 + 1e-8).sqrt(), 0.1), "{fit:?}");
        assert_eq!(fit.channels[0].a, 0.0, "one level: a constant curve");
    }

    #[test]
    fn clipped_and_black_images_give_no_fit() {
        let white = LinearImage::new(256, 256, vec![1.0; 256 * 256 * 3]);
        let black = LinearImage::new(256, 256, vec![0.0; 256 * 256 * 3]);
        for image in [white, black] {
            let fit = measure(&image);
            assert_eq!((fit.patches, fit.confidence, fit.sigma), (0, 0.0, 0.0));
        }
    }

    fn fit_with(sigma_scale: f64, confidence: f64) -> NoiseFit {
        let channels = [ChannelFit { a: 1e-4 * sigma_scale.powi(2), b: 1e-6 * sigma_scale.powi(2) }; 3];
        NoiseFit {
            channels,
            sigma: sigma_of(&channels),
            confidence,
            patches: 500,
            range: [0.01, 0.6],
            extrapolated: false,
            width: 1600,
            height: 1066,
        }
    }

    /// A 64-hex-digit hash whose first 16 digits encode `n`.
    fn h(n: u32) -> String {
        format!("{n:016x}{}", "0".repeat(48))
    }

    #[test]
    fn a_bright_photo_gives_no_fit_rather_than_a_zero_one() {
        // Snow or an overcast sky: every flat block is brighter than MAX_FIT_MEAN.
        let mut rng = Rng::new(13);
        let (w, rows) = (800u32, 600u32);
        let mut data = Vec::new();
        for _ in 0..rows {
            for x in 0..w {
                let level = 0.65 + 0.25 * x as f64 / w as f64;
                for _ in 0..3 {
                    data.push(rng.pg(level, 2e-5, 1e-6) as f32);
                }
            }
        }
        let fit = measure(&LinearImage::new(w, rows, data));
        assert_eq!((fit.confidence, fit.sigma, fit.patches), (0.0, 0.0, 0), "{fit:?}");
        assert!(!fit.is_valid());
        let mut file = ProfileFile::default();
        assert_eq!(fold(&mut file, SourceKind::Raw, 400, &h(1), &fit), Learned::Invalid);
        assert!(file.raw.is_empty());
    }

    #[test]
    fn a_dark_photo_is_extrapolated_with_less_confidence() {
        let mut rng = Rng::new(17);
        let (w, rows) = (800u32, 600u32);
        let mut data = Vec::new();
        for _ in 0..rows {
            for x in 0..w {
                let level = 0.01 + 0.03 * x as f64 / w as f64;
                for _ in 0..3 {
                    data.push(rng.pg(level, 1e-4, 1e-6) as f32);
                }
            }
        }
        let fit = measure(&LinearImage::new(w, rows, data));
        assert!(fit.extrapolated && fit.range[1] < 0.05, "{fit:?}");
        // 1 − exp(−patches/300) would be about 1; mid-grey is over 2 stops above the range.
        assert!(fit.confidence > 0.2 && fit.confidence < 0.55, "{fit:?}");
    }

    #[test]
    fn profiles_grow_per_iso_and_keep_repeats() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path().join("noise-profiles"));
        let (make, model) = ("Fujifilm", "X-T5");
        let path = store.file_path(make, model).unwrap();
        assert!(path.ends_with("noise-profiles/fujifilm-x-t5.json"));
        assert!(store.lookup(make, model, SourceKind::Raw, 6400).is_none());

        let (what, profile) = store.learn(make, model, SourceKind::Raw, 6400, &h(1), &fit_with(1.0, 0.9)).unwrap();
        assert_eq!(what, Learned::Added);
        let profile = profile.unwrap();
        assert_eq!((profile.photos, profile.established, profile.confidence()), (1, false, 0.0));
        let file: ProfileFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((file.raw.len(), file.processed.len()), (1, 0));

        // A new ISO is a new entry; a repeat ISO is stored in its entry; the same photo again changes nothing.
        assert_eq!(store.learn(make, model, SourceKind::Raw, 200, &h(2), &fit_with(0.2, 0.9)).unwrap().0, Learned::Added);
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, &h(3), &fit_with(1.2, 0.9)).unwrap().0, Learned::Averaged);
        let (what, profile) = store.learn(make, model, SourceKind::Raw, 6400, &h(4), &fit_with(1.1, 0.9)).unwrap();
        assert_eq!(what, Learned::Averaged);
        let profile = profile.unwrap();
        assert_eq!((profile.photos, profile.total_photos, profile.isos.clone()), (3, 4, vec![200, 6400]));
        assert!(profile.established && profile.agreeing == 3 && profile.confidence() > 0.6, "{profile:?}");
        // The median of 1.0², 1.2², 1.1².
        assert!(close(profile.channels[0].a, 1e-4 * 1.21, 1e-9), "{profile:?}");
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, &h(4), &fit_with(1.1, 0.9)).unwrap().0, Learned::AlreadyKnown);
        let file: ProfileFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!((file.raw.len(), file.raw[&6400].n, file.raw[&6400].fits.len()), (2, 3, 3));

        // Low confidence, invalid fits and missing hashes are not learned; processed files are kept apart from RAW.
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, &h(5), &fit_with(1.0, 0.1)).unwrap().0, Learned::LowConfidence);
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, "", &fit_with(1.0, 0.9)).unwrap().0, Learned::Invalid);
        let mut nan = fit_with(1.0, 0.9);
        nan.channels[1].a = f64::NAN;
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, &h(6), &nan).unwrap().0, Learned::Invalid);
        let mut negative = fit_with(1.0, 0.9);
        negative.channels[2].b = -1.0;
        assert_eq!(store.learn(make, model, SourceKind::Raw, 6400, &h(7), &negative).unwrap().0, Learned::Invalid);
        assert_eq!(store.learn(make, model, SourceKind::Processed, 6400, &h(8), &fit_with(0.5, 0.9)).unwrap().0, Learned::Added);
        let file = store.load(make, model);
        assert_eq!((file.raw.len(), file.processed.len(), file.raw[&6400].n), (2, 1, 3));
    }

    #[test]
    fn one_bad_first_photo_does_not_poison_an_iso() {
        let mut file = ProfileFile { version: PROFILES_VERSION, ..Default::default() };
        // The first photo of the ISO is way off (a busy picture whose texture passed for noise).
        assert_eq!(fold(&mut file, SourceKind::Raw, 3200, &h(1), &fit_with(4.0, 0.9)), Learned::Added);
        assert!(!profile_at(&file, SourceKind::Raw, 3200).unwrap().established);
        for i in 0..3 {
            let what = fold(&mut file, SourceKind::Raw, 3200, &h(10 + i), &fit_with(1.0 + i as f64 * 0.05, 0.9));
            assert_eq!(what, Learned::Averaged);
        }
        let curve = profile_at(&file, SourceKind::Raw, 3200).unwrap();
        assert!(curve.established && curve.agreeing == 3, "{curve:?}");
        assert!(close(curve.sigma, fit_with(1.05, 0.9).sigma, 0.01), "the bad fit is left out: {curve:?}");
        // Once established, a fit far off is an outlier and is not stored.
        assert_eq!(fold(&mut file, SourceKind::Raw, 3200, &h(20), &fit_with(3.0, 0.9)), Learned::Outlier);
        assert_eq!(fold(&mut file, SourceKind::Raw, 3200, &h(21), &fit_with(1.3, 0.9)), Learned::Averaged);
        assert_eq!(file.raw[&3200].n, 5);
        // Only the newest MAX_FITS fits are kept.
        for i in 0..20 {
            fold(&mut file, SourceKind::Raw, 3200, &h(100 + i), &fit_with(1.0, 0.9));
        }
        assert_eq!(file.raw[&3200].fits.len(), MAX_FITS);
    }

    fn established(file: &mut ProfileFile, iso: u32, scale: f64, seed: u32) {
        for i in 0..3 {
            fold(file, SourceKind::Raw, iso, &h(seed + i), &fit_with(scale, 0.9));
        }
    }

    #[test]
    fn lookup_interpolates_log_log_and_extrapolates_at_most_two_stops() {
        let mut file = ProfileFile { version: PROFILES_VERSION, make: "Sony".into(), model: "A7 IV".into(), ..Default::default() };
        established(&mut file, 800, 1.0, 1);
        established(&mut file, 3200, 2.0, 10);
        let mid = profile_at(&file, SourceKind::Raw, 1600).unwrap();
        assert!(mid.interpolated && mid.photos == 0 && close(mid.distance, 1.0, 1e-9));
        // a goes 1e-4 → 4e-4 over two stops: a power law gives 2e-4 one stop in.
        assert!(close(mid.channels[0].a, 2e-4, 1e-9), "{mid:?}");
        let exact = profile_at(&file, SourceKind::Raw, 800).unwrap();
        assert!(mid.confidence() < exact.confidence());
        let high = profile_at(&file, SourceKind::Raw, 6400).unwrap();
        assert!(close(high.channels[0].a, 4e-4 * 2.0, 1e-9) && close(high.channels[0].b, 4e-6 * 4.0, 1e-9), "{high:?}");
        assert!(close(high.distance, 1.0, 1e-9) && high.confidence() < exact.confidence());
        // More than two stops from anything established: nothing.
        assert!(profile_at(&file, SourceKind::Raw, 25600).is_none());
        assert!(profile_at(&file, SourceKind::Raw, 100).is_none());
        assert!(profile_at(&file, SourceKind::Processed, 1600).is_none());
        // Monotone between the two.
        let sigmas: Vec<f64> = [800, 1000, 1250, 1600, 2000, 2500, 3200]
            .iter()
            .map(|&iso| profile_at(&file, SourceKind::Raw, iso).unwrap().sigma)
            .collect();
        assert!(sigmas.windows(2).all(|w| w[0] <= w[1]), "{sigmas:?}");
    }

    #[test]
    fn blend_weighs_by_confidence() {
        let fit = fit_with(2.0, 0.5);
        assert_eq!(blend(&fit, None).channels, fit.channels);
        let mut file = ProfileFile::default();
        for i in 0..6 {
            fold(&mut file, SourceKind::Processed, 400, &h(i), &fit_with(1.0, 0.9));
        }
        let learned = profile_at(&file, SourceKind::Processed, 400).unwrap();
        let mixed = blend(&fit, Some(&learned));
        assert!(mixed.own_weight > 0.3 && mixed.own_weight < 0.4, "{mixed:?}");
        assert!(mixed.sigma > learned.sigma && mixed.sigma < fit.sigma);
        assert!(mixed.confidence > fit.confidence);
        // An unestablished curve is not blended in.
        let mut one = ProfileFile::default();
        fold(&mut one, SourceKind::Processed, 400, &h(1), &fit_with(1.0, 0.9));
        let unestablished = profile_at(&one, SourceKind::Processed, 400).unwrap();
        assert_eq!(blend(&fit, Some(&unestablished)).own_weight, 1.0);
    }

    #[test]
    fn slugs_and_file_names() {
        assert_eq!(slug("Fujifilm", 80), "fujifilm");
        assert_eq!(slug(" EOS R5 / Mark II ", 80), "eos-r5-mark-ii");
        assert_eq!(slug("../../etc/passwd", 80), "etc-passwd");
        let store = ProfileStore::new("/tmp/x");
        assert!(store.file_path("", "  ").is_none());
        assert!(store.file_path("Canon", "").is_none(), "a model alone or a make alone never names a file");
        assert_eq!(store.file_path("Apple", "iPhone 15 Pro").unwrap(), PathBuf::from("/tmp/x/apple-iphone-15-pro.json"));
        // Different makes never share a file; long and non-ASCII names stay short and distinct.
        assert_ne!(store.file_path("Sony", "A1"), store.file_path("Sigma", "A1"));
        let long = store.file_path(&"M".repeat(500), &"Z".repeat(500)).unwrap();
        let stem = long.file_stem().unwrap().to_string_lossy().into_owned();
        assert!(stem.len() <= MAX_SLUG, "{stem}");
        let a = store.file_path("大疆", "一").unwrap();
        let b = store.file_path("大疆", "二").unwrap();
        assert_ne!(a, b);
        assert!(a.parent() == Some(Path::new("/tmp/x")) && a.to_string_lossy().is_ascii());
    }

    #[test]
    fn a_foreign_profile_file_is_backed_up_before_it_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path());
        let path = store.file_path("Nikon", "Z 6").unwrap();
        fs::write(&path, r#"{"version":99,"future":true}"#).unwrap();
        let (what, _) = store.learn("Nikon", "Z 6", SourceKind::Raw, 800, &h(1), &fit_with(1.0, 0.9)).unwrap();
        assert_eq!(what, Learned::Added);
        assert_eq!(fs::read_to_string(path.with_extension("json.bak")).unwrap(), r#"{"version":99,"future":true}"#);
        assert_eq!(store.load("Nikon", "Z 6").raw[&800].n, 1);
    }
}
