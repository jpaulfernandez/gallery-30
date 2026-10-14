//! Classical noise reduction (workflow plan 24): the chroma filter that replaces the denoise model's colour, and the
//! mask-level `noise` slider.
//!
//! **Chroma.** Chroma noise is low-frequency blotching with almost no image detail in it, which a guided filter
//! removes well and cheaply where the denoise networks (SIDD-trained) can smear it into desaturated patches. Per
//! image ([`noise_planes`], cached by [`crate::local::PrePasses`]): Oklab L and the chroma *ratios* `a / max(L,
//! L_FLOOR)`, `b / max(L, L_FLOOR)` are box-averaged down by [`guided_subsample`] of the radius (a quarter of the
//! resolution once the radius is 8 px or more). The ratios are what a texture of one hue keeps constant while its
//! lightness varies (scaling linear RGB scales L, a and b alike), so fine detail the coarse grid cannot see keeps its
//! colour. On that grid the guided filter's coefficients of each ratio are solved with **L as the guide**
//! ([`chroma_coefficients`]), with a fit test: where a window's residual is far above the noise floor of its lightness the
//! linear model does not hold (two hues of similar lightness, several hues in a texture) and the filter steps back
//! there. Per pixel ([`apply_row`]) the coefficients are upsampled bilinearly and applied to the pixel's own
//! full-resolution L, `a' = (ā·L + b̄)·max(L, L_FLOOR)` (joint upsampling: colour edges follow the luminance edges of
//! the full image), and blended in by the strength times the fit: `a = a·(1 − t) + a'·t`. With denoise on, the
//! guide is the denoised L (the intermediate) or, before the model has run, the input's L; the Colour slider is `t`,
//! so moving it never waits for the model.
//!
//! **Masks.** A mask's `noise` slider (0..100) adds `Σ wₘ·noiseₘ/100` to `t` locally and also smooths L with a
//! self-guided filter of the same coarse grid (weaker: [`MASK_LUMA_SHARE`] of the local amount, a smaller radius),
//! no model involved.
//!
//! **Tuning from the noise profile.** σ is workflow plan 23's `measured.sigma` (linear, at mid-grey, on the 1600 px
//! working decode), passed in [`crate::image::ImageMeta::noise_sigma`]. The radius in reference pixels (1080 px short
//! side, so a proxy and a full render filter the same part of the picture) grows with the square root of σ as a
//! percentage of mid-grey ([`radius_for`]); ε, in Oklab L² (the guide's units), is `(EPS_K·σ_L)²` with
//! `σ_L ≈ L_PER_LINEAR·σ` the noise of L at mid-grey. Both are functions of σ only: σ is cached per photo and stable,
//! so a render's output is too. The constants were tuned on the synthetic denoise fixture (`tests/denoise.rs`) and
//! checked on an ISO 12800 camera-like JPEG (workflow plan 24's Status).
//!
//! The pass runs first in the chain, on the decoded (warped) pixels, before white balance; the local pre-passes
//! (highlights/shadows base, clarity, dehaze, ...) stay computed from the unfiltered input, as on the GPU, which reads
//! the filtered pixels from a separate texture (`gpu::noise`).

use rayon::prelude::*;

use crate::color::oklab::Oklab;
use crate::cpu::masked::{is_active, LocalBlend};
use crate::image::{ImageMeta, LinearImage};
use crate::local::guided::{guided_coefficients, guided_subsample};
use crate::local::reference_scale;
use crate::settings::{ChromaMode, DevelopSettings};

/// Mid-grey, linear: what σ is quoted at.
pub const MID_GREY: f32 = 0.18;
/// σ used when the caller knows none: 2 % of mid-grey, a typical ISO 1600–3200 file.
pub const DEFAULT_SIGMA: f32 = 0.0036;
/// Oklab L per unit of linear luminance at mid-grey: `d(Y^(1/3))/dY = (1/3)·0.18^(−2/3)`.
pub const L_PER_LINEAR: f32 = 1.0456;
/// Chroma radius, reference px: `RADIUS_K · sqrt(σ as % of mid-grey)`, within [`MIN_RADIUS`]..[`MAX_RADIUS`].
pub const RADIUS_K: f32 = 3.0;
pub const MIN_RADIUS: f32 = 3.0;
pub const MAX_RADIUS: f32 = 20.0;
/// ε of the chroma filter: `(EPS_K·σ_L)²`, plus [`EPS_FLOOR`].
pub const EPS_K: f32 = 0.5;
pub const EPS_FLOOR: f32 = 1e-6;
/// The chroma filter works on `a / max(L, L_FLOOR)` and `b / max(L, L_FLOOR)`: scaling a colour's linear RGB scales
/// its Oklab L, a and b alike, so these ratios are constant along a texture of one hue that only varies in lightness
/// (stripes, foliage, fabric), which the coarse grid could otherwise not hold.
pub const L_FLOOR: f32 = 0.1;
/// The fit test (see [`chroma_coefficients`]): a window filters fully while its residual is under `FIT_K` times
/// the noise floor of the windows of similar lightness ([`tone_floors`]: a low quantile of their residuals). [`FIT_FLOOR_MIN`] keeps a noiseless image from dividing by zero.
pub const FIT_K: f32 = 3.0;
pub const FIT_FLOOR_MIN: f32 = 1e-10;
/// Oklab L of mid-grey, and the power of the shadows' extra ε ([`eps_tone`]).
pub const L_MID: f32 = 0.5646;
pub const EPS_TONE_POWER: f32 = 2.0;
/// Lightness bands of the fit floor ([`tone_floors`]) and the fewest windows a band needs for its own median.
pub const FLOOR_BANDS: usize = 8;
pub const FLOOR_MIN_WINDOWS: usize = 32;
/// The residual quantile that stands for a band's noise: low, since edges and texture only ever add residual.
pub const FLOOR_QUANTILE: f32 = 0.25;
/// The mask luminance filter: radius a share of the chroma radius (at least [`MIN_LUMA_RADIUS`]), ε `(LUMA_EPS_K·σ_L)²`.
pub const LUMA_RADIUS_SHARE: f32 = 0.5;
pub const MIN_LUMA_RADIUS: f32 = 2.0;
pub const LUMA_EPS_K: f32 = 2.0;
/// The luminance strength a mask's `noise` gets, as a share of its chroma strength.
pub const MASK_LUMA_SHARE: f32 = 0.6;

/// The measured σ as stored for keys and renders: 3 significant digits, so a re-measure that differs in the noise
/// of `f64` arithmetic keeps every cache. `None` (or a non-finite or non-positive σ: no fit) falls back to the ISO
/// (`σ ≈ 0.5 % of mid-grey × sqrt(ISO/100)`: ISO 100 → 0.5 %, 1600 → 2 %, 12800 → 5.7 %), then to [`DEFAULT_SIGMA`].
pub fn chroma_sigma(measured: Option<f64>, iso: Option<u32>) -> f32 {
    let sigma = match measured.filter(|s| s.is_finite() && *s > 0.0) {
        Some(s) => s,
        None => match iso.filter(|&i| i > 0) {
            Some(iso) => 0.005 * MID_GREY as f64 * (iso as f64 / 100.0).sqrt(),
            None => DEFAULT_SIGMA as f64,
        },
    };
    quantise(sigma) as f32
}

/// `v` rounded to 3 significant digits.
fn quantise(v: f64) -> f64 {
    if v <= 0.0 || !v.is_finite() {
        return 0.0;
    }
    let digits = 2 - v.log10().floor() as i32;
    let k = 10f64.powi(digits);
    (v * k).round() / k
}

/// The chroma radius in reference px for σ.
pub fn radius_for(sigma: f32) -> f32 {
    let percent = (sigma / MID_GREY * 100.0).max(0.0);
    (RADIUS_K * percent.sqrt()).clamp(MIN_RADIUS, MAX_RADIUS)
}

/// What the coarse planes depend on (σ-derived filter constants and whether the L filter is needed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseKey {
    /// Chroma filter radius, reference px.
    pub radius_ref: f32,
    pub eps: f32,
    /// The mask luminance filter's radius (reference px) and ε, when a mask uses `noise`.
    pub luma: Option<(f32, f32)>,
}

impl NoiseKey {
    pub fn new(sigma: f32, luma: bool) -> NoiseKey {
        let radius_ref = radius_for(sigma);
        let sigma_l = L_PER_LINEAR * sigma;
        NoiseKey {
            radius_ref,
            eps: (EPS_K * sigma_l).powi(2) + EPS_FLOOR,
            luma: luma.then(|| {
                ((radius_ref * LUMA_RADIUS_SHARE).max(MIN_LUMA_RADIUS), (LUMA_EPS_K * sigma_l).powi(2) + EPS_FLOOR)
            }),
        }
    }

    /// The coarse grid's subsample factor for an image of this size.
    pub fn factor(&self, width: usize, height: usize) -> usize {
        guided_subsample(self.radius_ref * reference_scale(width, height))
    }
}

/// The pass's parameters for one render; `None` (from [`NoiseParams::new`]) when it changes nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct NoiseParams {
    /// The global chroma strength (the Colour slider with `chromaMode: filter`), 0..1.
    pub chroma: f32,
    /// σ the key was derived from.
    pub sigma: f32,
    pub key: NoiseKey,
    /// Some active mask sets `noise`.
    pub local: bool,
}

impl NoiseParams {
    /// From the settings: denoise with `chromaMode: filter` and a Colour above 0, or an active mask with `noise`.
    pub fn new(settings: &DevelopSettings, meta: &ImageMeta) -> Option<NoiseParams> {
        let chroma = settings
            .detail
            .denoise
            .as_ref()
            .filter(|d| d.chroma_mode == ChromaMode::Filter)
            .map_or(0.0, |d| (d.chroma / 100.0).clamp(0.0, 1.0) as f32);
        let local = settings.masks.iter().any(|m| is_active(m) && m.adjustments.noise > 0.0);
        if chroma <= 0.0 && !local {
            return None;
        }
        let sigma = meta.noise_sigma.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(DEFAULT_SIGMA);
        Some(NoiseParams { chroma, sigma, key: NoiseKey::new(sigma, local), local })
    }

    /// The strengths `(t_ab, t_l)` at a pixel with the local amount `n` (`Σ w·noise / 100`, 0 outside masks).
    #[inline]
    pub fn strengths(&self, n: f32) -> (f32, f32) {
        if n > 0.0 {
            ((self.chroma + n).clamp(0.0, 1.0), (n * MASK_LUMA_SHARE).clamp(0.0, 1.0))
        } else {
            (self.chroma, 0.0)
        }
    }
}

/// The coarse coefficients of one image.
#[derive(Debug, Clone)]
pub struct NoisePlanes {
    pub key: NoiseKey,
    pub factor: usize,
    pub lw: usize,
    pub lh: usize,
    /// Per coarse cell `(ā, b̄)` of `a / max(L, L_FLOOR)`, then of b's ratio (guide L).
    pub chroma: Vec<[f32; 4]>,
    /// Per coarse cell: how well the linear model fits there (window means of [`fit_weight`]), 0..1.
    pub fit: Vec<f32>,
    /// Per coarse cell `(ā, b̄)` of the self-guided L, with [`NoiseKey::luma`].
    pub luma: Option<Vec<[f32; 2]>>,
    /// Per output column: the two coarse columns and the weight (the bilinear upsampling's x axis).
    xs: Vec<(usize, usize, f32)>,
}

/// `apply_coefficients`' sampling position along one axis: the two coarse indices and the weight.
#[inline]
fn coarse_axis(v: usize, n: usize, scale: f32) -> (usize, usize, f32) {
    let p = ((v as f32 + 0.5) * scale - 0.5).max(0.0);
    let i = (p as usize).min(n - 1);
    let j = (i + 1).min(n - 1);
    (i, j, p - i as f32)
}

/// The cell means of Oklab L, `a / max(L, L_FLOOR)` and `b / max(L, L_FLOOR)` over `factor × factor` cells (row by row, as `downsample_mean` sums).
pub fn oklab_cells(image: &LinearImage, factor: usize) -> (usize, usize, [Vec<f32>; 3]) {
    let (w, h) = (image.width as usize, image.height as usize);
    let f = factor.max(1);
    let (lw, lh) = (w.div_ceil(f), h.div_ceil(f));
    let ok = Oklab::new();
    let cells: Vec<[f32; 3]> = (0..lw * lh)
        .into_par_iter()
        .map(|cell| {
            let (lx, ly) = (cell % lw, cell / lw);
            let (x0, x1) = (lx * f, ((lx + 1) * f).min(w));
            let (y0, y1) = (ly * f, ((ly + 1) * f).min(h));
            let mut sum = [0.0f32; 3];
            for y in y0..y1 {
                let row = image.row(y as u32);
                for x in x0..x1 {
                    let lab = ok.to_lab([row[x * 3], row[x * 3 + 1], row[x * 3 + 2]]);
                    let inv = 1.0 / lab[0].max(L_FLOOR);
                    sum[0] += lab[0];
                    sum[1] += lab[1] * inv;
                    sum[2] += lab[2] * inv;
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as f32;
            sum.map(|s| s / n)
        })
        .collect();
    let plane = |c: usize| cells.iter().map(|v| v[c]).collect::<Vec<f32>>();
    (lw, lh, [plane(0), plane(1), plane(2)])
}

/// The fit of a window whose residual variance is `res` with the image's noise floor `floor`: 1 up to
/// `FIT_K · floor`, then falling as `FIT_K · floor / res`.
#[inline]
pub fn fit_weight(res: f32, floor: f32) -> f32 {
    let limit = FIT_K * floor;
    if res <= limit {
        1.0
    } else {
        limit / res
    }
}

/// The guided filter of the two chroma ratio planes `a`, `b` with the guide `l` (all on the coarse grid), radius `r`
/// cells: per window the least-squares `ratio = α·L + β` of each, and its residual variance `var(ratio) − α·cov`
/// (a + b). Where the residual is far above the noise floor at that lightness ([`tone_floors`]),
/// the linear model does not hold (two hues of similar lightness, several hues in a texture) and filtering would mix
/// colours, so [`fit_weight`] turns the filter down there; noise is left in those few places rather than smeared.
/// The floor is per lightness band ([`tone_floors`]), so the shadows' larger chroma-ratio noise does not count as a
/// bad fit.
/// Returns the window means of `(α_a, β_a, α_b, β_b)` and of the fit weight.
pub fn chroma_coefficients(l: &[f32], a: &[f32], b: &[f32], w: usize, h: usize, radius: f32, eps: f32) -> (Vec<[f32; 4]>, Vec<f32>) {
    use crate::local::blur::box_filtered;
    let r = (radius.round() as usize).max(1);
    let product = |x: &[f32], y: &[f32]| -> Vec<f32> { x.par_iter().zip(y).map(|(p, q)| p * q).collect() };
    let mean_l = box_filtered(l, w, h, r);
    let corr_ll = box_filtered(&product(l, l), w, h, r);
    let [mean_a, corr_la, corr_aa, mean_b, corr_lb, corr_bb] = [
        box_filtered(a, w, h, r),
        box_filtered(&product(l, a), w, h, r),
        box_filtered(&product(a, a), w, h, r),
        box_filtered(b, w, h, r),
        box_filtered(&product(l, b), w, h, r),
        box_filtered(&product(b, b), w, h, r),
    ];
    let n = w * h;
    let mut coef = vec![[0.0f32; 4]; n];
    let mut res = vec![0.0f32; n];
    coef.par_iter_mut().zip(res.par_iter_mut()).enumerate().for_each(|(i, (c, res))| {
        let ml = mean_l[i];
        let var = (corr_ll[i] - ml * ml).max(0.0);
        let eps = eps * eps_tone(ml);
        let solve = |mp: f32, cp: f32, pp: f32| -> (f32, f32, f32) {
            let cov = cp - ml * mp;
            let alpha = cov / (var + eps);
            ((alpha), mp - alpha * ml, ((pp - mp * mp) - alpha * cov).max(0.0))
        };
        let (aa, ab, ra) = solve(mean_a[i], corr_la[i], corr_aa[i]);
        let (ba, bb, rb) = solve(mean_b[i], corr_lb[i], corr_bb[i]);
        *c = [aa, ab, ba, bb];
        *res = ra + rb;
    });
    let floors = tone_floors(&mean_l, &res);
    let weight: Vec<f32> =
        res.par_iter().zip(mean_l.par_iter()).map(|(&r, &l)| fit_weight(r, floor_at(&floors, l))).collect();
    let boxed: [Vec<f32>; 4] = std::array::from_fn(|k| {
        let plane: Vec<f32> = coef.iter().map(|c| c[k]).collect();
        box_filtered(&plane, w, h, r)
    });
    let coef = (0..n).map(|i| [boxed[0][i], boxed[1][i], boxed[2][i], boxed[3][i]]).collect();
    (coef, box_filtered(&weight, w, h, r))
}

/// How ε grows below mid-grey: the noise of Oklab L at lightness `l` relative to mid-grey's, squared. With read
/// noise (a constant linear σ) `σ_L ∝ dL/dY = 1/(3L²)`, so `(L_MID / l)^(2·EPS_TONE_POWER)`, capped at the
/// [`L_FLOOR`]; 1 at and above mid-grey (shot noise there grows slower than L's compression shrinks it).
#[inline]
pub fn eps_tone(l: f32) -> f32 {
    if l >= L_MID {
        1.0
    } else {
        (L_MID / l.max(L_FLOOR)).powf(2.0 * EPS_TONE_POWER)
    }
}

/// The noise floor per lightness band: the [`FLOOR_QUANTILE`] of the window residuals in each of [`FLOOR_BANDS`] equal bands of the
/// window's mean L (0..1), so the floor follows the noise's tone dependence (read noise makes the chroma ratio far
/// noisier in the shadows than in the mid-tones). A band with fewer than [`FLOOR_MIN_WINDOWS`] windows takes its
/// nearest populated neighbour's floor; with no populated band, the global median.
pub fn tone_floors(mean_l: &[f32], res: &[f32]) -> [f32; FLOOR_BANDS] {
    let band = |l: f32| ((l.max(0.0) * FLOOR_BANDS as f32) as usize).min(FLOOR_BANDS - 1);
    let mut bins: Vec<Vec<f32>> = vec![Vec::new(); FLOOR_BANDS];
    for (&l, &r) in mean_l.iter().zip(res) {
        bins[band(l)].push(r);
    }
    let own: Vec<Option<f32>> =
        bins.iter().map(|b| (b.len() >= FLOOR_MIN_WINDOWS).then(|| quantile(b, FLOOR_QUANTILE).max(FIT_FLOOR_MIN))).collect();
    let global = median(res).max(FIT_FLOOR_MIN);
    std::array::from_fn(|i| {
        own[i].unwrap_or_else(|| {
            (1..FLOOR_BANDS)
                .flat_map(|d| [i.checked_sub(d), Some(i + d)])
                .flatten()
                .find_map(|j| own.get(j).copied().flatten())
                .unwrap_or(global)
        })
    })
}

/// The floor for a window of mean lightness `l`: linear between the band centres of [`tone_floors`].
#[inline]
pub fn floor_at(floors: &[f32; FLOOR_BANDS], l: f32) -> f32 {
    let p = (l * FLOOR_BANDS as f32 - 0.5).clamp(0.0, (FLOOR_BANDS - 1) as f32);
    let i = (p as usize).min(FLOOR_BANDS - 2);
    let t = p - i as f32;
    floors[i] + (floors[i + 1] - floors[i]) * t
}

/// The `q` quantile of `v` (0..1, the lower one between two values), 0 when empty.
pub fn quantile(v: &[f32], q: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut v = v.to_vec();
    let k = ((v.len() - 1) as f32 * q.clamp(0.0, 1.0)) as usize;
    *v.select_nth_unstable_by(k, f32::total_cmp).1
}

/// The median of `v` (the lower middle for an even count), 0 when empty.
pub fn median(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut v = v.to_vec();
    let mid = (v.len() - 1) / 2;
    *v.select_nth_unstable_by(mid, f32::total_cmp).1
}

/// The coarse coefficients of `image` for `key` (see the module notes).
pub fn noise_planes(image: &LinearImage, key: NoiseKey) -> NoisePlanes {
    let (w, h) = (image.width as usize, image.height as usize);
    let factor = key.factor(w, h);
    let (lw, lh, cells) = oklab_cells(image, factor);
    planes_from_cells(key, (w, h), factor, (lw, lh), cells)
}

/// [`noise_planes`] from the coarse cells ([`oklab_cells`]: L and the two chroma ratios) of a `size` image reduced by
/// `factor` to `low`. The GPU computes the cells and calls this too.
pub fn planes_from_cells(
    key: NoiseKey,
    (w, h): (usize, usize),
    factor: usize,
    (lw, lh): (usize, usize),
    [l, a, b]: [Vec<f32>; 3],
) -> NoisePlanes {
    let scale = reference_scale(w, h);
    let radius = key.radius_ref * scale / factor as f32;
    let (chroma, fit) = chroma_coefficients(&l, &a, &b, lw, lh, radius, key.eps);
    let luma = key.luma.map(|(r, eps)| {
        let (la, lb) = guided_coefficients(&l, None, lw, lh, r * scale / factor as f32, eps);
        la.into_iter().zip(lb).map(|(a, b)| [a, b]).collect()
    });
    let inv = 1.0 / factor as f32;
    let xs = (0..w).map(|x| coarse_axis(x, lw.max(1), inv)).collect();
    NoisePlanes { key, factor, lw: lw.max(1), lh: lh.max(1), chroma, fit, luma, xs }
}

impl NoisePlanes {
    /// Bilinear weights of row `y`.
    #[inline]
    fn y_axis(&self, y: usize) -> (usize, usize, f32) {
        coarse_axis(y, self.lh, 1.0 / self.factor as f32)
    }
}

/// `(1 − t)·a + t·b`, as the WGSL writes it.
#[inline]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a * (1.0 - t) + b * t
}

/// One pixel: the filtered Oklab of `px` with strengths `t_ab`, `t_l`, given the bilinear position.
#[inline]
#[allow(clippy::too_many_arguments)]
fn filter_px(
    ok: &Oklab,
    px: &mut [f32],
    planes: &NoisePlanes,
    (y0, y1, fy): (usize, usize, f32),
    (x0, x1, fx): (usize, usize, f32),
    t_ab: f32,
    t_l: f32,
) {
    let lw = planes.lw;
    let bil4 = |c: &[[f32; 4]]| -> [f32; 4] {
        let (c00, c10, c01, c11) = (c[y0 * lw + x0], c[y0 * lw + x1], c[y1 * lw + x0], c[y1 * lw + x1]);
        std::array::from_fn(|k| {
            let top = c00[k] + (c10[k] - c00[k]) * fx;
            let bottom = c01[k] + (c11[k] - c01[k]) * fx;
            top + (bottom - top) * fy
        })
    };
    let lab = ok.to_lab([px[0], px[1], px[2]]);
    let c = bil4(&planes.chroma);
    let fit = {
        let f = &planes.fit;
        let (c00, c10, c01, c11) = (f[y0 * lw + x0], f[y0 * lw + x1], f[y1 * lw + x0], f[y1 * lw + x1]);
        let top = c00 + (c10 - c00) * fx;
        let bottom = c01 + (c11 - c01) * fx;
        top + (bottom - top) * fy
    };
    let t_ab = t_ab * fit;
    let lf = lab[0].max(L_FLOOR);
    let fa = (c[0] * lab[0] + c[1]) * lf;
    let fb = (c[2] * lab[0] + c[3]) * lf;
    let mut out = [lab[0], mix(lab[1], fa, t_ab), mix(lab[2], fb, t_ab)];
    if t_l > 0.0 {
        if let Some(l) = &planes.luma {
            let (c00, c10, c01, c11) = (l[y0 * lw + x0], l[y0 * lw + x1], l[y1 * lw + x0], l[y1 * lw + x1]);
            let k: [f32; 2] = std::array::from_fn(|k| {
                let top = c00[k] + (c10[k] - c00[k]) * fx;
                let bottom = c01[k] + (c11[k] - c01[k]) * fx;
                top + (bottom - top) * fy
            });
            out[0] = mix(lab[0], k[0] * lab[0] + k[1], t_l);
        }
    }
    px.copy_from_slice(&ok.to_rgb(out));
}

/// The pass on row `y` of the image `planes` were computed from (in place). `blend`: the render's masks when some
/// mask touches this row (their `noise` adds to the strength per pixel). Pixels with both strengths at 0 are left
/// untouched.
pub fn apply_row(row: &mut [f32], y: usize, params: &NoiseParams, planes: &NoisePlanes, blend: Option<&LocalBlend>) {
    let w = row.len() / 3;
    let ok = Oklab::new();
    let ya = planes.y_axis(y);
    let local = blend.filter(|_| params.local);
    for (x, px) in row.chunks_exact_mut(3).enumerate() {
        let n = local.map_or(0.0, |b| b.noise_at(y * w + x));
        let (t_ab, t_l) = params.strengths(n);
        if t_ab <= 0.0 && t_l <= 0.0 {
            continue;
        }
        filter_px(&ok, px, planes, ya, planes.xs[x], t_ab, t_l);
    }
}

/// The local amounts `Σ w·noise / 100` of every pixel (the GPU uploads them as one plane).
pub fn local_amounts(blend: &LocalBlend) -> Vec<f32> {
    let n = blend.width() as usize * blend.height() as usize;
    (0..n).into_par_iter().map(|i| blend.noise_at(i)).collect()
}

/// The chroma filter on a whole image at strength `chroma` (0..1) with σ `sigma`, radii scaled as for an image of
/// `reference_size` (the full image when `image` is a crop of it, e.g. the denoise tuning crop). The CPU reference,
/// for callers outside the develop pipeline.
pub fn chroma_filter_image(image: &LinearImage, sigma: f32, chroma: f32, reference_size: Option<(u32, u32)>) -> LinearImage {
    let chroma = chroma.clamp(0.0, 1.0);
    if chroma <= 0.0 || image.width == 0 || image.height == 0 {
        return image.clone();
    }
    let mut key = NoiseKey::new(sigma, false);
    if let Some((rw, rh)) = reference_size {
        // Keep the radius in this image's pixels equal to the full image's.
        let full = reference_scale(rw as usize, rh as usize);
        let own = reference_scale(image.width as usize, image.height as usize);
        if own > 0.0 {
            key.radius_ref *= full / own;
        }
    }
    let planes = noise_planes(image, key);
    let params = NoiseParams { chroma, sigma, key, local: false };
    let w = image.width as usize;
    let mut out = image.clone();
    out.data.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| apply_row(row, y, &params, &planes, None));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: u32) -> impl FnMut() -> f32 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        }
    }

    /// Left half a reddish grey, right half a darker bluish grey; blotchy chroma noise on both.
    fn noisy_halves(w: usize, h: usize, amount: f32) -> (LinearImage, LinearImage) {
        let mut r = lcg(5);
        let mut noise: Vec<f32> = (0..w * h * 2).map(|_| r()).collect();
        for c in 0..2 {
            crate::local::gaussian_blur(&mut noise[c * w * h..(c + 1) * w * h], w, h, 1.5);
        }
        let ok = Oklab::new();
        let mut clean = Vec::with_capacity(w * h * 3);
        let mut noisy = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let base = if x < w / 2 { [0.6, 0.04, 0.02] } else { [0.35, -0.01, -0.06] };
                clean.extend(ok.to_rgb(base));
                let i = y * w + x;
                noisy.extend(ok.to_rgb([base[0], base[1] + amount * noise[i], base[2] + amount * noise[w * h + i]]));
            }
        }
        (LinearImage::new(w as u32, h as u32, clean), LinearImage::new(w as u32, h as u32, noisy))
    }

    fn chroma_err(a: &LinearImage, b: &LinearImage, cols: std::ops::Range<usize>) -> f32 {
        let ok = Oklab::new();
        let w = a.width as usize;
        let mut sum = 0.0;
        let mut n = 0;
        for y in 0..a.height as usize {
            for x in cols.clone() {
                let i = (y * w + x) * 3;
                let p = ok.to_lab([a.data[i], a.data[i + 1], a.data[i + 2]]);
                let q = ok.to_lab([b.data[i], b.data[i + 1], b.data[i + 2]]);
                sum += (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
                n += 1;
            }
        }
        (sum / n as f32).sqrt()
    }

    #[test]
    fn sigma_is_quantised_and_falls_back_to_the_iso() {
        assert_eq!(chroma_sigma(Some(0.0041234), None), 0.00412);
        assert!((chroma_sigma(Some(0.0), Some(1600)) - 0.0036).abs() < 1e-9);
        assert_eq!(chroma_sigma(None, None), DEFAULT_SIGMA);
        assert_eq!(radius_for(0.0), MIN_RADIUS);
        assert_eq!(radius_for(1.0), MAX_RADIUS);
        assert!(radius_for(0.0041) > radius_for(0.0013));
    }

    #[test]
    fn removes_chroma_noise_and_keeps_the_edge() {
        let (w, h) = (320, 200);
        let (clean, noisy) = noisy_halves(w, h, 0.08);
        // Radii as for a 1620 × 1080 image (this one is a crop of it): a 9 px window here.
        let out = chroma_filter_image(&noisy, 0.004, 1.0, Some((1620, 1080)));
        // The flats (away from the edge): chroma noise drops a lot.
        let flats = [10..w / 2 - 20, w / 2 + 20..w - 10];
        for cols in flats {
            let (before, after) = (chroma_err(&noisy, &clean, cols.clone()), chroma_err(&out, &clean, cols.clone()));
            assert!(after < before * 0.5, "{cols:?}: {before} -> {after}");
        }
        // The colour edge follows the luminance edge: the two pixels either side keep their own colour (the halves
        // differ by about 0.09 in a/b; bleeding across would add an error of that order, the filter only removes).
        for cols in [w / 2 - 2..w / 2, w / 2..w / 2 + 2] {
            let (before, after) = (chroma_err(&noisy, &clean, cols.clone()), chroma_err(&out, &clean, cols.clone()));
            assert!(after < before, "edge {cols:?}: {before} -> {after}");
        }
        // L is untouched.
        let ok = Oklab::new();
        for i in (0..w * h).step_by(97) {
            let p = |img: &LinearImage| ok.to_lab([img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]])[0];
            assert!((p(&out) - p(&noisy)).abs() < 1e-4);
        }
    }

    /// Read-noise-dominated deep shadows (Y ≈ 0.02, the same linear noise as the mid-tones, so far more in Oklab and
    /// in the a/L ratio): the chroma noise there must drop at least as much as in the mid-tones.
    #[test]
    fn shadows_are_filtered_as_much_as_mid_tones() {
        let (w, h) = (480usize, 240usize);
        let mut r = lcg(23);
        let mut noise: Vec<f32> = (0..w * h * 3).map(|_| r()).collect();
        for c in 0..3 {
            crate::local::gaussian_blur(&mut noise[c * w * h..(c + 1) * w * h], w, h, 1.0);
        }
        let read = 0.012;
        let mut clean = Vec::with_capacity(w * h * 3);
        let mut noisy = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let base: [f32; 3] = if x < w / 2 { [0.024, 0.019, 0.016] } else { [0.21, 0.17, 0.15] };
                clean.extend(base);
                let i = y * w + x;
                noisy.extend((0..3).map(|c| base[c] + read * noise[c * w * h + i]));
            }
        }
        let (clean, noisy) = (LinearImage::new(w as u32, h as u32, clean), LinearImage::new(w as u32, h as u32, noisy));
        let out = chroma_filter_image(&noisy, 0.006, 1.0, Some((1620, 1080)));
        let ratio = |cols: std::ops::Range<usize>| {
            chroma_err(&out, &clean, cols.clone()) / chroma_err(&noisy, &clean, cols)
        };
        let (shadows, mids) = (ratio(10..w / 2 - 30), ratio(w / 2 + 30..w - 10));
        eprintln!("chroma noise left: shadows {shadows:.3}, mid-tones {mids:.3}");
        // Measured: 0.180 vs 0.173 (a single global floor and ε left 0.290 in the shadows). What remains is the ratio
        // domain carrying L's relative noise into a/b in coloured shadows, a ≤ 1 point difference.
        assert!(shadows <= mids + 0.01, "shadows {shadows} vs mid-tones {mids}");
    }

    #[test]
    fn strength_zero_is_the_identity() {
        let (_, noisy) = noisy_halves(64, 48, 0.05);
        assert_eq!(chroma_filter_image(&noisy, 0.004, 0.0, None), noisy);
        let half = chroma_filter_image(&noisy, 0.004, 0.5, None);
        let full = chroma_filter_image(&noisy, 0.004, 1.0, None);
        assert_ne!(half, full);
    }

    #[test]
    fn params_follow_the_settings() {
        let meta = ImageMeta::default();
        let mut s = DevelopSettings::default();
        assert!(NoiseParams::new(&s, &meta).is_none());
        s.detail.denoise = Some(crate::settings::Denoise {
            model: crate::settings::DenoiseModel::NafnetW32,
            luminance: 50.0,
            chroma: 75.0,
            sharpen: 25.0,
            chroma_mode: ChromaMode::Filter,
        });
        let p = NoiseParams::new(&s, &meta).unwrap();
        assert_eq!((p.chroma, p.sigma, p.local), (0.75, DEFAULT_SIGMA, false));
        if let Some(d) = s.detail.denoise.as_mut() {
            d.chroma_mode = ChromaMode::Model;
        }
        assert!(NoiseParams::new(&s, &meta).is_none(), "model mode keeps the model's colour");
        let p = NoiseParams::new(&s, &ImageMeta { noise_sigma: Some(0.01), ..ImageMeta::default() });
        assert!(p.is_none());
        assert_eq!(NoiseParams { chroma: 0.2, sigma: 0.01, key: NoiseKey::new(0.01, true), local: true }.strengths(0.5), (0.7, 0.3));
    }
}
