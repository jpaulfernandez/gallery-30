//! The local pre-passes (plan section 4.2 item 4) and their per-image cache.
//!
//! Every plane is computed from the image *as decoded and warped* (before white balance and
//! exposure), once, and reused by every render of that image. The detail planes are differences of
//! `log2(Y + LOG_FLOOR)`, which exposure and white balance's grey gain only shift, so they stay valid
//! when those sliders move; the highlights/shadows base is stored as lightness and rescaled
//! analytically ([`crate::cpu::Params`]). Only the sharpening planes depend on a slider (the radius);
//! they are cached for the last radius used.

use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use rayon::prelude::*;

use super::blur::{downsample_mean, downsample_min, gaussian_blur, gaussian_blurred, min_filter, reduced_size};
use super::guided::{apply_coefficients, guided_coefficients, guided_filter, guided_subsample};
use super::{lightness, reference_scale};
use crate::color::matrix::REC2020_LUMA;
use crate::image::LinearImage;

/// Added to `Y` before `log2`: a soft noise floor (about 8/255 in sRGB) below which detail is compressed
/// instead of amplified, so the log-domain operators do not blow up shadow noise.
pub const LOG_FLOOR: f32 = 1.0 / 512.0;

/// Highlights/shadows base: guided-filter radius (reference px) and `eps` (stops²).
pub const HS_RADIUS_REF: f32 = 40.0;
pub const HS_EPS: f32 = 0.08;
/// Clarity base: guided-filter radius (reference px) and `eps` (stops²). The radius sits above the
/// texture band (σ 6) so the two controls reach different scales.
pub const CLARITY_RADIUS_REF: f32 = 16.0;
pub const CLARITY_EPS: f32 = 0.1;
/// Texture band-pass: `blur(σ_fine) − blur(σ_coarse)` on `log2 Y`, σ in reference px.
pub const TEXTURE_FINE_SIGMA_REF: f32 = 1.5;
pub const TEXTURE_COARSE_SIGMA_REF: f32 = 6.0;
/// Dehaze: dark-channel patch radius (a 15 px patch), transmission refinement radius (reference px),
/// and the refinement `eps` (the guide is the per-pixel dark channel, 0..1).
pub const DEHAZE_PATCH_RADIUS_REF: f32 = 7.0;
pub const DEHAZE_GUIDE_RADIUS_REF: f32 = 20.0;
pub const DEHAZE_EPS: f32 = 1e-4;
/// Fraction of the brightest dark-channel cells averaged for the atmospheric light.
pub const AIRLIGHT_FRACTION: f32 = 0.001;
/// How far the atmospheric light is pulled toward neutral (0 = as measured, 1 = grey).
pub const AIRLIGHT_NEUTRAL: f32 = 0.5;
/// Smallest sharpening σ in pixels (a radius this small on a tiny image does nothing anyway).
pub(crate) const MIN_SHARPEN_SIGMA: f32 = 0.25;

#[inline]
fn luma(p: &[f32]) -> f32 {
    REC2020_LUMA[0] * p[0] + REC2020_LUMA[1] * p[1] + REC2020_LUMA[2] * p[2]
}

/// `log2(max(Y, 0) + LOG_FLOOR)` per pixel.
pub fn log_luminance(image: &LinearImage) -> Vec<f32> {
    image.data.par_chunks_exact(3).map(|p| (luma(p).max(0.0) + LOG_FLOOR).log2()).collect()
}

/// The highlights/shadows base as lightness `t = Y^(1/2.4)`: the guided filter of `log2 Y` (self-guided,
/// [`HS_RADIUS_REF`], [`HS_EPS`]) mapped back to `Y`. Large tonal regions keep their own level across
/// strong edges, so lifting shadows does not leave a bright rim beside a dark subject.
pub fn hs_base(log_y: &[f32], w: usize, h: usize) -> Vec<f32> {
    let r = HS_RADIUS_REF * reference_scale(w, h);
    let mut base = guided_filter(log_y, None, w, h, r, HS_EPS);
    base.par_iter_mut().for_each(|v| *v = lightness(v.exp2() - LOG_FLOOR));
    base
}

/// Clarity detail `log2 Y − GF(log2 Y)` ([`CLARITY_RADIUS_REF`], [`CLARITY_EPS`]).
pub fn clarity_detail(log_y: &[f32], w: usize, h: usize) -> Vec<f32> {
    let r = CLARITY_RADIUS_REF * reference_scale(w, h);
    let mut base = guided_filter(log_y, None, w, h, r, CLARITY_EPS);
    base.par_iter_mut().zip(log_y).for_each(|(b, l)| *b = l - *b);
    base
}

/// Texture band `G(σ_fine) − G(σ_coarse)` of `log2 Y`.
pub fn texture_band(log_y: &[f32], w: usize, h: usize) -> Vec<f32> {
    let s = reference_scale(w, h);
    let mut fine = gaussian_blurred(log_y, w, h, TEXTURE_FINE_SIGMA_REF * s);
    let coarse = gaussian_blurred(log_y, w, h, TEXTURE_COARSE_SIGMA_REF * s);
    fine.par_iter_mut().zip(&coarse).for_each(|(f, c)| *f -= c);
    fine
}

/// Dehaze inputs: the atmospheric light and the refined haze density `D` (so that the transmission at
/// strength ω is `t = 1 − ω·D`).
#[derive(Debug, Clone)]
pub struct HazePlanes {
    /// Atmospheric light `A`, linear Rec.2020 of the decoded image, pulled toward neutral.
    pub airlight: [f32; 3],
    /// Dark channel of `I / A` (min over RGB, then a morphological opening over the patch), refined by
    /// the guided filter with the per-pixel dark channel as guide; 0..1.
    pub density: Vec<f32>,
}

/// Dark channel prior (He, Sun, Tang 2009) at the guided filter's coarse resolution: block minimum,
/// min filter over the patch, atmospheric light from the brightest [`AIRLIGHT_FRACTION`] of cells
/// (pulled [`AIRLIGHT_NEUTRAL`] of the way to grey, at least 0.05), then the dark channel of `I / A`,
/// opened (min then max filter) and refined by the guided filter against the full-resolution per-pixel
/// dark channel.
pub fn haze_planes(image: &LinearImage) -> HazePlanes {
    let (w, h) = (image.width as usize, image.height as usize);
    let scale = reference_scale(w, h);
    let guide_r = DEHAZE_GUIDE_RADIUS_REF * scale;
    let factor = guided_subsample(guide_r);
    let (lw, lh) = reduced_size(w, h, factor);
    let patch_r = ((DEHAZE_PATCH_RADIUS_REF * scale / factor as f32).round() as usize).max(1);

    // (per-pixel dark channel, its patch minimum at the coarse resolution)
    let dark_of = |a: [f32; 3]| -> (Vec<f32>, Vec<f32>) {
        let raw: Vec<f32> = image
            .data
            .par_chunks_exact(3)
            .map(|p| (p[0] / a[0]).min(p[1] / a[1]).min(p[2] / a[2]).clamp(0.0, 1.0))
            .collect();
        let mut low = downsample_min(&raw, w, h, factor);
        min_filter(&mut low, lw, lh, patch_r);
        // Morphological opening (the min filter then a max filter of the same size): the patch minimum
        // stays for texture and noise but object boundaries move back to where they were, which removes
        // most of the classic dark-channel halo before the guided refinement.
        low.par_iter_mut().for_each(|v| *v = -*v);
        min_filter(&mut low, lw, lh, patch_r);
        low.par_iter_mut().for_each(|v| *v = -*v);
        (raw, low)
    };

    // Atmospheric light: mean colour of the cells with the brightest dark channel.
    let (_, dark) = dark_of([1.0; 3]);
    let mut order: Vec<usize> = (0..dark.len()).collect();
    order.sort_by(|&i, &j| dark[j].total_cmp(&dark[i]).then(i.cmp(&j)));
    let count = ((dark.len() as f32 * AIRLIGHT_FRACTION).ceil() as usize).clamp(1, dark.len());
    let mut sum = [0.0f64; 3];
    let mut n = 0usize;
    for &cell in &order[..count] {
        let (lx, ly) = (cell % lw, cell / lw);
        for y in ly * factor..((ly + 1) * factor).min(h) {
            for x in lx * factor..((lx + 1) * factor).min(w) {
                let p = image.pixel(x as u32, y as u32);
                for c in 0..3 {
                    sum[c] += p[c] as f64;
                }
                n += 1;
            }
        }
    }
    let mean = sum.map(|s| (s / n.max(1) as f64) as f32);
    let y = luma(&mean);
    let airlight = mean.map(|c| (y + (c - y) * (1.0 - AIRLIGHT_NEUTRAL)).max(0.05));

    // Normalised dark channel, refined with the per-pixel dark channel as the (grey) guide: it has
    // exactly the edges the patch minimum smeared, including between colours of equal lightness, where
    // a luminance guide lets the transmission bleed across and leaves dark rims.
    let (guide, p_low) = dark_of(airlight);
    let g_low = downsample_mean(&guide, w, h, factor);
    let (a, b) = guided_coefficients(&g_low, Some(&p_low), lw, lh, guide_r / factor as f32, DEHAZE_EPS);
    let mut density = apply_coefficients(&a, &b, lw, lh, factor, &guide, w, h);
    density.par_iter_mut().for_each(|v| *v = v.clamp(0.0, 1.0));
    HazePlanes { airlight, density }
}

/// Sharpening inputs for one radius.
#[derive(Debug, Clone)]
pub struct SharpenPlanes {
    /// The radius slider value these were computed for (reference px).
    pub radius_ref: f32,
    /// σ in pixels at this image's size.
    pub sigma: f32,
    /// `log2 Y − G(σ)`.
    pub fine: Vec<f32>,
    /// `log2 Y − G(2σ)`.
    pub coarse: Vec<f32>,
    /// Sobel gradient magnitude of `G(σ)` in stops per *reference* pixel, smoothed by `G(σ)`: the
    /// Masking slider thresholds it.
    pub edges: Vec<f32>,
}

/// The sharpening planes for a radius slider value (reference px).
pub fn sharpen_planes(log_y: &[f32], w: usize, h: usize, radius_ref: f32) -> SharpenPlanes {
    let scale = reference_scale(w, h);
    let sigma = (radius_ref * scale).max(MIN_SHARPEN_SIGMA);
    let g1 = gaussian_blurred(log_y, w, h, sigma);
    let g2 = gaussian_blurred(log_y, w, h, 2.0 * sigma);
    let fine: Vec<f32> = log_y.par_iter().zip(&g1).map(|(l, g)| l - g).collect();
    let coarse: Vec<f32> = log_y.par_iter().zip(&g2).map(|(l, g)| l - g).collect();
    let mut edges = sobel_magnitude(&g1, w, h);
    edges.par_iter_mut().for_each(|e| *e *= scale);
    gaussian_blur(&mut edges, w, h, sigma);
    SharpenPlanes { radius_ref, sigma, fine, coarse, edges }
}

/// Sobel gradient magnitude per pixel (kernels normalised to a unit-step derivative), edges clamped.
pub fn sobel_magnitude(plane: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; w * h];
    if w == 0 || h == 0 {
        return out;
    }
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let rows = [y.saturating_sub(1), y, (y + 1).min(h - 1)].map(|r| &plane[r * w..(r + 1) * w]);
        for (x, cell) in row.iter_mut().enumerate() {
            let (l, r) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let gx = (rows[0][r] - rows[0][l]) + 2.0 * (rows[1][r] - rows[1][l]) + (rows[2][r] - rows[2][l]);
            let gy = (rows[2][l] - rows[0][l]) + 2.0 * (rows[2][x] - rows[0][x]) + (rows[2][r] - rows[0][r]);
            *cell = (gx * gx + gy * gy).sqrt() / 8.0;
        }
    });
    out
}

/// What the halation glow depends on (workflow plan 17).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HalationKey {
    /// Luminance threshold in the decoded image's units (the render's threshold over its exposure and white-balance
    /// grey gain).
    pub threshold: f32,
    /// Blur σ, reference px.
    pub sigma_ref: f32,
}

/// The halation glow: `max(0, Y − threshold)` (capped at [`crate::ops::halation::MAX_EXCESS`]), averaged down by
/// `factor`, Gaussian-blurred there; sampled back bilinearly per row ([`HalationPlane::sample_row`]).
#[derive(Debug, Clone)]
pub struct HalationPlane {
    pub key: HalationKey,
    pub low: Vec<f32>,
    pub lw: usize,
    pub lh: usize,
    pub factor: usize,
}

impl HalationPlane {
    /// Row `y` of the glow at full resolution (`out.len()` is the width), bilinear at pixel centres like
    /// [`super::blur::upsample_bilinear`].
    pub fn sample_row(&self, y: usize, out: &mut [f32]) {
        let scale = 1.0 / self.factor as f32;
        let coord = |v: usize, n: usize| -> (usize, usize, f32) {
            let p = ((v as f32 + 0.5) * scale - 0.5).max(0.0);
            let i = (p as usize).min(n - 1);
            let j = (i + 1).min(n - 1);
            (i, j, p - i as f32)
        };
        let (y0, y1, fy) = coord(y, self.lh);
        let (r0, r1) = (&self.low[y0 * self.lw..(y0 + 1) * self.lw], &self.low[y1 * self.lw..(y1 + 1) * self.lw]);
        for (x, cell) in out.iter_mut().enumerate() {
            let (x0, x1, fx) = coord(x, self.lw);
            let top = r0[x0] + (r0[x1] - r0[x0]) * fx;
            let bottom = r1[x0] + (r1[x1] - r1[x0]) * fx;
            *cell = top + (bottom - top) * fy;
        }
    }
}

/// The halation glow of `image` for `key` (see [`HalationPlane`]). The reduction keeps σ at about
/// [`HALATION_LOW_SIGMA`] px or more at the reduced size, so a 24 MP render blurs a plane of well under a megapixel.
pub fn halation_plane(image: &LinearImage, key: HalationKey) -> HalationPlane {
    let (w, h) = (image.width as usize, image.height as usize);
    let (factor, low_sigma) = halation_reduction(w, h, key);
    let t = key.threshold;
    let excess: Vec<f32> = image
        .data
        .par_chunks_exact(3)
        .map(|p| (luma(p) - t).clamp(0.0, crate::ops::halation::MAX_EXCESS))
        .collect();
    let (lw, lh) = reduced_size(w, h, factor);
    let mut low = downsample_mean(&excess, w, h, factor);
    drop(excess);
    gaussian_blur(&mut low, lw, lh, low_sigma);
    HalationPlane { key, low, lw: lw.max(1), lh: lh.max(1), factor }
}

/// The halation glow's reduction factor and its blur σ at the reduced size for a `w × h` image (the GPU builds the
/// same plane, `gpu::engine`).
pub(crate) fn halation_reduction(w: usize, h: usize, key: HalationKey) -> (usize, f32) {
    let sigma = key.sigma_ref * reference_scale(w, h);
    let factor = ((sigma / HALATION_LOW_SIGMA).floor() as usize).clamp(1, 32);
    (factor, sigma / factor as f32)
}

/// Smallest σ (px) the halation blur runs at after the reduction.
pub const HALATION_LOW_SIGMA: f32 = 3.0;

/// Which pre-passes a render reads.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Needs {
    pub hs_base: bool,
    pub clarity: bool,
    pub texture: bool,
    pub haze: bool,
    /// The sharpening radius slider value, when sharpening runs.
    pub sharpen_radius: Option<f32>,
    /// The halation glow (workflow plan 17), when halation runs.
    pub halation: Option<HalationKey>,
    /// The chroma / mask noise filter's coarse coefficients (workflow plan 24), when it runs.
    pub noise: Option<crate::ops::noise::NoiseKey>,
}

/// The planes one render reads, borrowed from (or shared with) a [`PrePasses`].
#[derive(Debug, Default, Clone)]
pub struct LocalPlanes<'a> {
    /// Highlights/shadows base, lightness `t`.
    pub hs_base: Option<&'a [f32]>,
    /// Clarity detail, stops.
    pub clarity: Option<&'a [f32]>,
    /// Texture band, stops.
    pub texture: Option<&'a [f32]>,
    pub haze: Option<&'a HazePlanes>,
    pub sharpen: Option<Arc<SharpenPlanes>>,
    pub halation: Option<Arc<HalationPlane>>,
    pub noise: Option<Arc<crate::ops::noise::NoisePlanes>>,
}

/// Per-image cache of the pre-passes. Each plane is computed on first use and kept; the sharpening
/// planes are kept for the last radius (an LRU of one). Pair one `PrePasses` with one image: it does not
/// check that later calls pass the same image.
#[derive(Default)]
pub struct PrePasses {
    log_y: OnceLock<Vec<f32>>,
    hs_base: OnceLock<Vec<f32>>,
    clarity: OnceLock<Vec<f32>>,
    texture: OnceLock<Vec<f32>>,
    haze: OnceLock<HazePlanes>,
    sharpen: Mutex<Option<Arc<SharpenPlanes>>>,
    halation: Mutex<Option<Arc<HalationPlane>>>,
    noise: Mutex<Option<Arc<crate::ops::noise::NoisePlanes>>>,
    computed: AtomicUsize,
}

impl fmt::Debug for PrePasses {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PrePasses")
            .field("log_y", &self.log_y.get().is_some())
            .field("hs_base", &self.hs_base.get().is_some())
            .field("clarity", &self.clarity.get().is_some())
            .field("texture", &self.texture.get().is_some())
            .field("haze", &self.haze.get().is_some())
            .field("computed", &self.computed.load(Ordering::Relaxed))
            .finish()
    }
}

impl PrePasses {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many planes have been computed so far (cache misses), for tests and logging.
    pub fn computed(&self) -> usize {
        self.computed.load(Ordering::Relaxed)
    }

    fn once<'a, T>(&self, cell: &'a OnceLock<T>, f: impl FnOnce() -> T) -> &'a T {
        cell.get_or_init(|| {
            self.computed.fetch_add(1, Ordering::Relaxed);
            f()
        })
    }

    fn log_y(&self, image: &LinearImage) -> &[f32] {
        self.once(&self.log_y, || log_luminance(image))
    }

    /// The planes `needs` asks for, computing the missing ones.
    pub fn prepare(&self, image: &LinearImage, needs: &Needs) -> LocalPlanes<'_> {
        let (w, h) = (image.width as usize, image.height as usize);
        LocalPlanes {
            hs_base: needs.hs_base.then(|| self.once(&self.hs_base, || hs_base(self.log_y(image), w, h)).as_slice()),
            clarity: needs.clarity.then(|| self.once(&self.clarity, || clarity_detail(self.log_y(image), w, h)).as_slice()),
            texture: needs.texture.then(|| self.once(&self.texture, || texture_band(self.log_y(image), w, h)).as_slice()),
            haze: needs.haze.then(|| self.once(&self.haze, || haze_planes(image))),
            sharpen: needs.sharpen_radius.map(|r| self.sharpen(image, r)),
            halation: needs.halation.map(|k| self.halation(image, k)),
            noise: needs.noise.map(|k| self.noise(image, k)),
        }
    }

    /// The noise filter's coarse coefficients for `key` (workflow plan 24), recomputed only when the key changes (an
    /// LRU of one: σ is fixed per image, the key changes only when a mask's `noise` turns the luminance filter on).
    pub fn noise(&self, image: &LinearImage, key: crate::ops::noise::NoiseKey) -> Arc<crate::ops::noise::NoisePlanes> {
        let mut slot = self.noise.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = slot.as_ref().filter(|p| p.key == key) {
            return Arc::clone(p);
        }
        *slot = None;
        self.computed.fetch_add(1, Ordering::Relaxed);
        let start = std::time::Instant::now();
        let p = Arc::new(crate::ops::noise::noise_planes(image, key));
        log::debug!(
            "[photobook:develop] noise planes {}x{} (1/{}) in {:.1} ms",
            image.width,
            image.height,
            p.factor,
            start.elapsed().as_secs_f64() * 1e3
        );
        *slot = Some(Arc::clone(&p));
        p
    }

    /// The halation glow for `key`, recomputed only when the key changes (an LRU of one, like the sharpening
    /// planes).
    pub fn halation(&self, image: &LinearImage, key: HalationKey) -> Arc<HalationPlane> {
        let mut slot = self.halation.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = slot.as_ref().filter(|p| p.key == key) {
            return Arc::clone(p);
        }
        *slot = None;
        self.computed.fetch_add(1, Ordering::Relaxed);
        let p = Arc::new(halation_plane(image, key));
        *slot = Some(Arc::clone(&p));
        p
    }

    /// The sharpening planes for `radius_ref`, recomputed only when the radius changes. The lock is held
    /// while computing so concurrent renders of a new radius compute once.
    pub fn sharpen(&self, image: &LinearImage, radius_ref: f32) -> Arc<SharpenPlanes> {
        let mut slot = self.sharpen.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = slot.as_ref().filter(|p| p.radius_ref.to_bits() == radius_ref.to_bits()) {
            return Arc::clone(p);
        }
        *slot = None;
        let (w, h) = (image.width as usize, image.height as usize);
        self.computed.fetch_add(1, Ordering::Relaxed);
        let p = Arc::new(sharpen_planes(self.log_y(image), w, h, radius_ref));
        *slot = Some(Arc::clone(&p));
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_image_has_flat_planes() {
        let img = LinearImage::new(300, 200, [0.18f32; 3].repeat(300 * 200));
        let pre = PrePasses::new();
        let planes = pre.prepare(
            &img,
            &Needs { hs_base: true, clarity: true, texture: true, haze: true, sharpen_radius: Some(1.0), ..Needs::default() },
        );
        let want = lightness(0.18);
        assert!(planes.hs_base.unwrap().iter().all(|v| (v - want).abs() < 1e-3));
        assert!(planes.clarity.unwrap().iter().all(|v| v.abs() < 1e-4));
        assert!(planes.texture.unwrap().iter().all(|v| v.abs() < 1e-4));
        let s = planes.sharpen.unwrap();
        assert!(s.fine.iter().chain(&s.coarse).chain(&s.edges).all(|v| v.abs() < 1e-4));
        // log_y, four planes and the sharpening set; asking again computes nothing.
        assert_eq!(pre.computed(), 6);
        let _ = pre.prepare(&img, &Needs { clarity: true, sharpen_radius: Some(1.0), ..Needs::default() });
        assert_eq!(pre.computed(), 6);
        let _ = pre.prepare(&img, &Needs { sharpen_radius: Some(2.0), ..Needs::default() });
        assert_eq!(pre.computed(), 7);
    }

    #[test]
    fn airlight_comes_from_the_haze() {
        // Left: a dark scene; right: bright bluish haze.
        let (w, h) = (200u32, 120u32);
        let data: Vec<f32> = (0..w * h)
            .flat_map(|i| if i % w < w / 2 { [0.05, 0.1, 0.02] } else { [0.7, 0.75, 0.85] })
            .collect();
        let hp = haze_planes(&LinearImage::new(w, h, data));
        assert!(hp.airlight[2] > hp.airlight[0] && hp.airlight[0] > 0.65, "{:?}", hp.airlight);
        let d = |x: u32, y: u32| hp.density[(y * w + x) as usize];
        assert!(d(20, 60) < 0.2 && d(180, 60) > 0.8);
    }
}
