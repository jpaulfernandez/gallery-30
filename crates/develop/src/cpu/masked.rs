//! Local adjustments (D4.1, pipeline half): masks blended into the pipeline as per-pixel parameters.
//!
//! The model (plan section 4.1, written from its description): every active mask is composited to one plane on
//! the working grid ([`MaskLayers`]); per pixel the local slider values are `Σ wₘ · adjustmentsₘ` over the masks
//! and are **added to the global slider values** in each operator's own units, clamped to the range the
//! operator accepts, before that operator runs. A pixel (or a whole row) no mask touches goes through the
//! global operators unchanged, so mask-less renders and the untouched parts of masked ones are bit-identical to
//! the global pipeline. Within a masked pixel each operator falls back to its global path when its own local
//! value is 0.
//!
//! | Local slider | Where it blends |
//! | --- | --- |
//! | Exposure (EV) | `2^(EV_global + EV_local)`, EV within −10..10; also rescales the cached highlights/shadows base |
//! | Temperature, Tint | added to the incremental sliders (−100..100; `asShot` counts as 0/0); for `absolute` a mired and tint shift of the source illuminant. The matrices come from a small per-render table over the local range ([`WbLut`]), bilinear |
//! | Highlights, Shadows | added to the sliders (−100..100), exact tone gain per pixel (no table) on the base rescaled by that pixel's exposure and white balance |
//! | Whites, Blacks | added to the sliders; the end-point curve's constants are rebuilt per pixel (a few flops) |
//! | Contrast | added to the slider (the exponent is per pixel anyway) |
//! | Clarity, Texture, Dehaze | added to the sliders; per-pixel gain on the cached pre-pass planes; dehaze's atmospheric light stays the global one |
//! | Sharpness | added to the sharpening Amount (0..150; negative values only reduce it, no blur); radius, detail and masking stay global |
//! | Saturation | added to the slider: the chroma scale `1 + s` in the OKLCH step |
//! | Hue | an extra OKLCH hue rotation of `hue/100 · 30°` (positive turns red towards yellow) after the colour mix |
//! | Noise | `Σ wₘ·noiseₘ/100` added to the chroma filter's strength, and a weaker luminance filter ([`crate::ops::noise`], workflow plan 24), before white balance |

use std::sync::Arc;

use rayon::prelude::*;

use super::Params;
use crate::canonical::canonical_json;
use crate::color::matrix::{apply_f32, Mat3f};
use crate::geometry::Homography;
use crate::image::{ImageMeta, LinearImage};
use crate::local::{Needs, SharpenPlanes, BASE_GAMMA};
use crate::masks::{LocalParams, MaskCache, MaskContext, MaskLayers, MaskPlane};
use crate::ops::clarity::{clarity_px, ClarityParams};
use crate::ops::color::{color_px, local_hue_degrees, saturation, ColorParams};
use crate::ops::contrast::{contrast_px, ContrastParams};
use crate::ops::dehaze::dehaze_px;
use crate::ops::sharpen::{sharpen_px, SHARPEN_STRENGTH};
use crate::ops::texture::{texture_px, TextureParams};
use crate::ops::tonal::{tone_gain, whites_blacks_value, WhitesBlacksParams};
use crate::ops::white_balance::with_local_offsets;
use crate::settings::{DevelopSettings, LocalAdjustments, Mask, MaskShape, WhiteBalance};

/// Which local sliders some mask sets (`LocalBlend::active`; the GPU reads the same bits).
pub(crate) const LOCAL_EXPOSURE: u32 = 1;
pub(crate) const LOCAL_WB: u32 = 2;
pub(crate) const LOCAL_HS: u32 = 4;
pub(crate) const LOCAL_WHITES_BLACKS: u32 = 8;
pub(crate) const LOCAL_CONTRAST: u32 = 16;
pub(crate) const LOCAL_CLARITY: u32 = 32;
pub(crate) const LOCAL_TEXTURE: u32 = 64;
pub(crate) const LOCAL_DEHAZE: u32 = 128;
pub(crate) const LOCAL_SHARPEN: u32 = 256;
pub(crate) const LOCAL_COLOR: u32 = 512;
/// Local `noise` (workflow plan 24): read by `ops::noise` before the chain, not by the chain itself.
pub(crate) const LOCAL_NOISE: u32 = 1024;

/// Local temperature/tint sums beyond this (units) saturate in the white balance table.
pub(crate) const WB_LOCAL_LIMIT: f32 = 300.0;
/// Largest step of the white balance table, in slider units.
pub(crate) const WB_LUT_STEP: f32 = 2.0;
/// Most entries per axis of the white balance table.
pub(crate) const WB_LUT_MAX: usize = 129;
/// Floats per white balance table entry: the 3×3 matrix row-major, then the grey gain.
pub(crate) const WB_ENTRY: usize = 10;

/// The global slider values the per-pixel (masked) path adds local values to, in the units the operators use.
/// Every value is the one the global pass runs with (0 when that pass is skipped).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sliders {
    /// Exposure in EV, within −10..10.
    pub exposure_ev: f32,
    /// `2^exposure_ev` as the global pass applies it (1 at 0).
    pub exposure_gain: f32,
    /// The global white balance's grey gain (1 without white balance).
    pub grey_gain: f32,
    /// The highlights/shadows base rescale for the global exposure and white balance.
    pub base_scale: f32,
    /// −1..1 (slider / 100).
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub contrast: f32,
    pub clarity: f32,
    pub texture: f32,
    pub dehaze: f32,
    pub saturation: f32,
    /// Sharpening amount / 100 (0..1.5); 0 while sharpening does not run globally.
    pub sharpen_amount: f32,
    /// The sharpening radius (reference px), detail and masking (0..1) from the settings, used by local
    /// sharpness even while the global pass is off.
    pub sharpen_radius: f32,
    pub sharpen_detail: f32,
    pub sharpen_masking: f32,
    pub white_balance: WhiteBalance,
    /// The image's source metadata (a RAW's as-shot white balance), for local white balance.
    pub meta: ImageMeta,
}

impl Sliders {
    pub(crate) fn new(settings: &DevelopSettings, params: &Params, base_scale: f32, meta: &ImageMeta) -> Self {
        let unit = |v: f64| (v / 100.0).clamp(-1.0, 1.0) as f32;
        let light = &settings.light;
        let detail = &settings.detail;
        let sharpen = &detail.sharpen;
        let global_sharpen = params.detail.as_ref().and_then(|d| d.sharpen.as_ref());
        Sliders {
            exposure_ev: light.exposure.clamp(-10.0, 10.0) as f32,
            exposure_gain: params.exposure.unwrap_or(1.0),
            grey_gain: params.white_balance.as_ref().map_or(1.0, |w| w.grey_gain),
            base_scale,
            highlights: unit(light.highlights),
            shadows: unit(light.shadows),
            whites: unit(light.whites),
            blacks: unit(light.blacks),
            contrast: unit(light.contrast),
            clarity: unit(detail.clarity),
            texture: unit(detail.texture),
            dehaze: unit(detail.dehaze),
            saturation: unit(settings.color.saturation),
            sharpen_amount: global_sharpen.map_or(0.0, |_| (sharpen.amount / 100.0).clamp(0.0, 1.5) as f32),
            sharpen_radius: sharpen.radius.clamp(0.5, 3.0) as f32,
            sharpen_detail: (sharpen.detail / 100.0).clamp(0.0, 1.0) as f32,
            sharpen_masking: (sharpen.masking / 100.0).clamp(0.0, 1.0) as f32,
            white_balance: settings.white_balance.clone(),
            meta: meta.clone(),
        }
    }
}

/// `global + local/100`, clamped to −1..1 (a −100..100 slider as a unit value).
#[inline]
pub(crate) fn unit_sum(global: f32, local: f32) -> f32 {
    (global + local / 100.0).clamp(-1.0, 1.0)
}

/// A mask that can change a pixel: enabled, with some adjustment set.
pub fn is_active(mask: &Mask) -> bool {
    mask.enabled && mask.adjustments != LocalAdjustments::default()
}

/// Whether any active mask has a luminance or colour range component (they read the input image).
pub fn masks_need_input(masks: &[Mask]) -> bool {
    masks.iter().filter(|m| is_active(m)).any(mask_reads_input)
}

/// Whether a mask has a luminance or colour range component.
pub fn mask_reads_input(mask: &Mask) -> bool {
    mask.components.iter().any(|c| matches!(c.shape, MaskShape::Luminance { .. } | MaskShape::Color { .. }))
}

/// Whether a mask has a luminance range component (it reads the input's luminance plane).
pub fn mask_reads_luma(mask: &Mask) -> bool {
    mask.components.iter().any(|c| matches!(c.shape, MaskShape::Luminance { .. }))
}

/// The cache key of the composited planes: the canonical JSON of the active masks **without** their
/// adjustments (a local slider drag keeps the planes; a mask turning active or inactive changes the key).
pub fn layers_key(masks: &[Mask]) -> String {
    let active: Vec<serde_json::Value> = masks
        .iter()
        .filter(|m| is_active(m))
        .map(|m| {
            let mut v = serde_json::to_value(m).expect("masks always serialise");
            if let Some(o) = v.as_object_mut() {
                o.remove("adjustments");
            }
            v
        })
        .collect();
    canonical_json(&serde_json::Value::Array(active))
}

/// The adjustments of the active masks, in order (what [`MaskLayers::build`] keeps).
pub(crate) fn active_adjustments(masks: &[Mask]) -> Vec<LocalAdjustments> {
    masks.iter().filter(|m| is_active(m)).map(|m| m.adjustments.clone()).collect()
}

fn no_ai(_: &str) -> Option<Arc<MaskPlane>> {
    None
}

/// An empty image for mask contexts that read no pixels.
pub(crate) fn empty_image() -> LinearImage {
    LinearImage::new(0, 0, Vec::new())
}

/// Composited planes of a render's masks, ready to blend: the planes (their `adjustments` are those of the
/// build and are not read), which rows any mask touches, and the AI components that had no raster.
#[derive(Debug, Clone)]
pub struct PreparedLayers {
    pub layers: Arc<MaskLayers>,
    pub rows: Arc<Vec<bool>>,
    pub missing_ai: Vec<String>,
}

impl PreparedLayers {
    /// Rasterise and composite the active masks onto a `width × height` grid. `input` is the input image on
    /// that grid (only read by range components; may be empty otherwise) and `luma` its luminance plane (empty
    /// = derived when needed).
    pub fn build(
        masks: &[Mask],
        width: u32,
        height: u32,
        frame_to_output: &Homography,
        input: &LinearImage,
        luma: &[f32],
        cache: Option<&mut MaskCache>,
    ) -> PreparedLayers {
        Self::build_with_ai(masks, width, height, frame_to_output, input, luma, cache, &no_ai)
    }

    /// [`build`](Self::build) with AI component rasters from `ai_rasters` (by component id, on this grid; see
    /// [`crate::masks::ai_cache::lookup_on_plan`]).
    #[allow(clippy::too_many_arguments)]
    pub fn build_with_ai(
        masks: &[Mask],
        width: u32,
        height: u32,
        frame_to_output: &Homography,
        input: &LinearImage,
        luma: &[f32],
        cache: Option<&mut MaskCache>,
        ai_rasters: &(dyn Fn(&str) -> Option<Arc<MaskPlane>> + Sync),
    ) -> PreparedLayers {
        let ctx = MaskContext { width, height, frame_to_output, input_luma: luma, input_rgb: input, ai_rasters };
        let (layers, missing_ai) = MaskLayers::build(masks, &ctx, cache);
        let rows = row_flags(&layers);
        PreparedLayers { layers: Arc::new(layers), rows: Arc::new(rows), missing_ai }
    }
}

/// For each row, whether any layer is non-zero in it.
pub(crate) fn row_flags(layers: &MaskLayers) -> Vec<bool> {
    let w = layers.width as usize;
    (0..layers.height as usize)
        .into_par_iter()
        .map(|y| layers.planes.iter().any(|p| p.data[y * w..(y + 1) * w].iter().any(|&v| v > 0.0)))
        .collect()
}

/// Bilinear table of white balance matrices over the local temperature/tint offsets one render can reach.
#[derive(Debug, Clone)]
pub(crate) struct WbLut {
    pub t0: f32,
    pub t_step: f32,
    pub nt: usize,
    pub i0: f32,
    pub i_step: f32,
    pub ni: usize,
    /// `ni × nt` entries (tint-major), [`WB_ENTRY`] floats each.
    pub entries: Vec<f32>,
}

/// `(start, step, count)` of one table axis covering `lo..hi`.
fn wb_axis(lo: f32, hi: f32) -> (f32, f32, usize) {
    let (lo, hi) = (lo.clamp(-WB_LOCAL_LIMIT, WB_LOCAL_LIMIT), hi.clamp(-WB_LOCAL_LIMIT, WB_LOCAL_LIMIT));
    if hi - lo < 1e-3 {
        return (lo, 1.0, 1);
    }
    let n = (((hi - lo) / WB_LUT_STEP).ceil() as usize + 1).clamp(2, WB_LUT_MAX);
    (lo, (hi - lo) / (n - 1) as f32, n)
}

/// Bilinear position on an axis: `(i, j, f)`.
#[inline]
pub(crate) fn lut_axis(v: f32, v0: f32, step: f32, n: usize) -> (usize, usize, f32) {
    let p = ((v - v0) / step).clamp(0.0, (n - 1) as f32);
    let i = (p as usize).min(n.saturating_sub(2));
    let j = (i + 1).min(n - 1);
    (i, j, p - i as f32)
}

impl WbLut {
    fn new(wb: &WhiteBalance, meta: &ImageMeta, temperature: (f32, f32), tint: (f32, f32)) -> WbLut {
        let (t0, t_step, nt) = wb_axis(temperature.0, temperature.1);
        let (i0, i_step, ni) = wb_axis(tint.0, tint.1);
        let entries: Vec<f32> = (0..ni * nt)
            .into_par_iter()
            .flat_map_iter(|k| {
                let (j, i) = (k / nt, k % nt);
                let (t, ti) = (t0 + i as f32 * t_step, i0 + j as f32 * i_step);
                let mut e = [0.0f32; WB_ENTRY];
                match with_local_offsets(wb, meta, t as f64, ti as f64) {
                    Some(p) => {
                        for r in 0..3 {
                            e[r * 3..r * 3 + 3].copy_from_slice(&p.matrix[r]);
                        }
                        e[9] = p.grey_gain;
                    }
                    None => {
                        e[0] = 1.0;
                        e[4] = 1.0;
                        e[8] = 1.0;
                        e[9] = 1.0;
                    }
                }
                e
            })
            .collect();
        WbLut { t0, t_step, nt, i0, i_step, ni, entries }
    }

    /// The matrix and grey gain for local offsets `(temperature, tint)`.
    #[inline]
    pub fn at(&self, temperature: f32, tint: f32) -> (Mat3f, f32) {
        let (ti, tj, tf) = lut_axis(temperature, self.t0, self.t_step, self.nt);
        let (ii, ij, iff) = lut_axis(tint, self.i0, self.i_step, self.ni);
        let e = |i: usize, j: usize| &self.entries[(j * self.nt + i) * WB_ENTRY..(j * self.nt + i + 1) * WB_ENTRY];
        let (a, b, c, d) = (e(ti, ii), e(tj, ii), e(ti, ij), e(tj, ij));
        let mut v = [0.0f32; WB_ENTRY];
        for k in 0..WB_ENTRY {
            let top = a[k] + (b[k] - a[k]) * tf;
            let bottom = c[k] + (d[k] - c[k]) * tf;
            v[k] = top + (bottom - top) * iff;
        }
        ([[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]], v[9])
    }
}

/// Everything one render needs to blend its masks: the composited planes, the current adjustments of the
/// active masks (in the planes' order), the local sliders some mask sets, and the per-render tables.
#[derive(Debug, Clone)]
pub struct LocalBlend {
    pub layers: Arc<MaskLayers>,
    /// Current adjustments, one per plane (the planes are cached without them).
    pub adjustments: Vec<LocalAdjustments>,
    pub(crate) rows: Arc<Vec<bool>>,
    /// `LOCAL_*` bits.
    pub(crate) active: u32,
    pub(crate) wb: Option<WbLut>,
    /// Colour parameters for local saturation/hue while the global colour pass is skipped.
    pub(crate) color: Option<ColorParams>,
    pub(crate) needs: Needs,
    /// AI components without a raster (they counted as 0).
    pub missing_ai: Vec<String>,
}

impl LocalBlend {
    /// `None` when no layer can change a pixel (no active mask, or only sliders that are not applied yet).
    pub fn new(settings: &DevelopSettings, params: &Params, prepared: &PreparedLayers) -> Option<LocalBlend> {
        let adjustments = active_adjustments(&settings.masks);
        if prepared.layers.is_empty() || adjustments.len() != prepared.layers.len() {
            return None;
        }
        let any = |f: fn(&LocalAdjustments) -> f64| adjustments.iter().any(|a| f(a) != 0.0);
        let mut active = 0;
        for (bit, set) in [
            (LOCAL_EXPOSURE, any(|a| a.exposure)),
            (LOCAL_WB, any(|a| a.temperature) || any(|a| a.tint)),
            (LOCAL_HS, any(|a| a.highlights) || any(|a| a.shadows)),
            (LOCAL_WHITES_BLACKS, any(|a| a.whites) || any(|a| a.blacks)),
            (LOCAL_CONTRAST, any(|a| a.contrast)),
            (LOCAL_CLARITY, any(|a| a.clarity)),
            (LOCAL_TEXTURE, any(|a| a.texture)),
            (LOCAL_DEHAZE, any(|a| a.dehaze)),
            (LOCAL_SHARPEN, any(|a| a.sharpness)),
            (LOCAL_COLOR, any(|a| a.saturation) || any(|a| a.hue)),
            (LOCAL_NOISE, any(|a| a.noise)),
        ] {
            if set {
                active |= bit;
            }
        }
        if active == 0 {
            return None;
        }
        let range = |f: fn(&LocalAdjustments) -> f64| {
            let lo: f64 = adjustments.iter().map(|a| f(a).min(0.0)).sum();
            let hi: f64 = adjustments.iter().map(|a| f(a).max(0.0)).sum();
            (lo as f32, hi as f32)
        };
        let s = &params.sliders;
        let wb = (active & LOCAL_WB != 0).then(|| WbLut::new(&s.white_balance, &s.meta, range(|a| a.temperature), range(|a| a.tint)));
        let color = (active & LOCAL_COLOR != 0 && params.color.is_none()).then(|| ColorParams::always(&settings.color));
        let needs = Needs {
            hs_base: active & LOCAL_HS != 0,
            clarity: active & LOCAL_CLARITY != 0,
            texture: active & LOCAL_TEXTURE != 0,
            haze: active & LOCAL_DEHAZE != 0,
            sharpen_radius: (active & LOCAL_SHARPEN != 0).then_some(s.sharpen_radius),
            halation: None,
            // The noise planes come with `Params::needs` (`Params::noise` knows about local noise).
            noise: None,
        };
        Some(LocalBlend {
            layers: Arc::clone(&prepared.layers),
            adjustments,
            rows: Arc::clone(&prepared.rows),
            active,
            wb,
            color,
            needs,
            missing_ai: prepared.missing_ai.clone(),
        })
    }

    pub fn width(&self) -> u32 {
        self.layers.width
    }

    pub fn height(&self) -> u32 {
        self.layers.height
    }

    pub fn len(&self) -> usize {
        self.layers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }

    /// The pre-passes the local sliders read (add to [`Params::needs`]).
    pub fn needs(&self) -> Needs {
        self.needs
    }

    /// The local `noise` at pixel `idx` as a strength, `Σ w · noise / 100` (layers in order, zero weights skipped,
    /// summed as [`LocalParams::add_weighted`] does).
    #[inline]
    pub fn noise_at(&self, idx: usize) -> f32 {
        let mut n = 0.0f32;
        for (p, a) in self.layers.planes.iter().zip(&self.adjustments) {
            let w = p.data[idx];
            if w > 0.0 {
                n += w * a.noise as f32;
            }
        }
        n / 100.0
    }

    /// The local slider values at pixel `idx` (`Σ w · adjustments`, layers in order, zero weights skipped).
    #[inline]
    pub fn local_at(&self, idx: usize) -> LocalParams {
        let mut l = LocalParams::default();
        for (p, a) in self.layers.planes.iter().zip(&self.adjustments) {
            let w = p.data[idx];
            if w > 0.0 {
                l.add_weighted(w, a);
            }
        }
        l
    }
}

/// `a ∪ b`.
pub(crate) fn union_needs(a: Needs, b: Option<Needs>) -> Needs {
    let Some(b) = b else { return a };
    Needs {
        hs_base: a.hs_base || b.hs_base,
        clarity: a.clarity || b.clarity,
        texture: a.texture || b.texture,
        haze: a.haze || b.haze,
        sharpen_radius: a.sharpen_radius.or(b.sharpen_radius),
        halation: a.halation.or(b.halation),
        noise: a.noise.or(b.noise),
    }
}

/// The planes and constants one masked row reads.
pub(crate) struct RowInputs<'a> {
    pub hs_base: Option<&'a [f32]>,
    pub clarity: Option<&'a [f32]>,
    pub texture: Option<&'a [f32]>,
    /// Density and the atmospheric light in this render's space.
    pub haze: Option<(&'a [f32], [f32; 3])>,
    pub sharpen: Option<&'a SharpenPlanes>,
}

/// Run white balance … colour on one row with the local values of each pixel. `span` is the row's range in
/// the planes; the display look and the encode follow as for any row.
pub(crate) fn develop_row(row: &mut [f32], span: std::ops::Range<usize>, params: &Params, inp: &RowInputs, b: &LocalBlend) {
    let base = span.start;
    let sat_global = params.color.as_ref().map(|c| saturation(c.saturation));
    for (i, px) in row.chunks_exact_mut(3).enumerate() {
        let l = b.local_at(base + i);
        develop_pixel(px, base + i, &l, params, inp, b, sat_global);
    }
}

#[inline]
fn scale_px(px: &mut [f32], g: f32) {
    px[0] *= g;
    px[1] *= g;
    px[2] *= g;
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn develop_pixel(
    px: &mut [f32],
    idx: usize,
    l: &LocalParams,
    params: &Params,
    inp: &RowInputs,
    b: &LocalBlend,
    sat_global: Option<f32>,
) {
    let s = &params.sliders;
    // White balance.
    let mut grey = s.grey_gain;
    let mut rescaled = false;
    match b.wb.as_ref().filter(|_| l.temperature != 0.0 || l.tint != 0.0) {
        Some(lut) => {
            let (m, g) = lut.at(l.temperature, l.tint);
            px.copy_from_slice(&apply_f32(&m, px[0], px[1], px[2]));
            grey = g;
            rescaled = true;
        }
        None => {
            if let Some(p) = &params.white_balance {
                px.copy_from_slice(&apply_f32(&p.matrix, px[0], px[1], px[2]));
            }
        }
    }
    // Exposure.
    let mut gain = s.exposure_gain;
    if l.exposure != 0.0 {
        gain = (s.exposure_ev + l.exposure).clamp(-10.0, 10.0).exp2();
        scale_px(px, gain);
        rescaled = true;
    } else if let Some(g) = params.exposure {
        scale_px(px, g);
    }
    // Highlights / shadows, on the base rescaled by this pixel's exposure and white balance.
    if let Some(base) = inp.hs_base {
        let t = base[idx];
        let scale = if rescaled { (gain * grey).max(0.0).powf(1.0 / BASE_GAMMA) } else { s.base_scale };
        if l.highlights != 0.0 || l.shadows != 0.0 {
            let (h, sh) = (unit_sum(s.highlights, l.highlights), unit_sum(s.shadows, l.shadows));
            if h != 0.0 || sh != 0.0 {
                scale_px(px, tone_gain((t * scale).clamp(0.0, 1.0), h, sh));
            }
        } else if let Some(p) = &params.highlights_shadows {
            scale_px(px, p.gain_scaled(t, scale));
        }
    }
    // Whites / blacks.
    if l.whites != 0.0 || l.blacks != 0.0 {
        if let Some(p) = WhitesBlacksParams::from_unit(unit_sum(s.whites, l.whites), unit_sum(s.blacks, l.blacks)) {
            for v in px.iter_mut() {
                *v = whites_blacks_value(*v, &p);
            }
        }
    } else if let Some(p) = &params.whites_blacks {
        for v in px.iter_mut() {
            *v = whites_blacks_value(*v, p);
        }
    }
    // Contrast.
    if l.contrast != 0.0 {
        if let Some(p) = ContrastParams::from_unit(unit_sum(s.contrast, l.contrast)) {
            contrast_px(px, p.c);
        }
    } else if let Some(p) = &params.contrast {
        contrast_px(px, p.c);
    }
    let detail = params.detail.as_ref();
    // Clarity.
    if let Some(plane) = inp.clarity {
        let k = if l.clarity != 0.0 {
            ClarityParams::from_unit(unit_sum(s.clarity, l.clarity)).map(|p| p.k)
        } else {
            detail.and_then(|d| d.clarity.as_ref()).map(|p| p.k)
        };
        if let Some(k) = k {
            clarity_px(px, plane[idx], k);
        }
    }
    // Texture.
    if let Some(plane) = inp.texture {
        let k = if l.texture != 0.0 {
            TextureParams::from_unit(unit_sum(s.texture, l.texture)).map(|p| p.k)
        } else {
            detail.and_then(|d| d.texture.as_ref()).map(|p| p.k)
        };
        if let Some(k) = k {
            texture_px(px, plane[idx], k);
        }
    }
    // Dehaze (the atmospheric light stays global).
    if let Some((density, a)) = inp.haze {
        let strength = if l.dehaze != 0.0 {
            unit_sum(s.dehaze, l.dehaze)
        } else {
            detail.and_then(|d| d.dehaze.as_ref()).map_or(0.0, |p| p.strength)
        };
        dehaze_px(px, density[idx], a, strength);
    }
    // Sharpening.
    if let Some(sp) = inp.sharpen {
        let (f, c, e) = (sp.fine[idx], sp.coarse[idx], sp.edges[idx]);
        if l.sharpness != 0.0 {
            let amount = (s.sharpen_amount + l.sharpness / 100.0).clamp(0.0, 1.5) * SHARPEN_STRENGTH;
            if amount > 0.0 {
                sharpen_px(px, f, c, e, amount, s.sharpen_detail, s.sharpen_masking);
            }
        } else if let Some(p) = detail.and_then(|d| d.sharpen.as_ref()) {
            sharpen_px(px, f, c, e, p.amount, p.detail, p.masking);
        }
    }
    // Colour: saturation and hue.
    if l.saturation != 0.0 || l.hue != 0.0 {
        if let Some(p) = params.color.as_ref().or(b.color.as_ref()) {
            let sat = saturation(unit_sum(s.saturation, l.saturation));
            let rotate = (l.hue != 0.0).then(|| {
                let (sin, cos) = local_hue_degrees(l.hue).to_radians().sin_cos();
                (cos, sin)
            });
            color_px(px, p, sat, rotate);
        }
    } else if let (Some(p), Some(sat)) = (&params.color, sat_global) {
        color_px(px, p, sat, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cpu::RenderOptions;
    use crate::ops::white_balance::WhiteBalanceParams;

    #[test]
    fn wb_lut_hits_the_exact_matrices_at_its_nodes() {
        let wb = WhiteBalance::Incremental { temperature: 20.0, tint: -5.0 };
        let meta = ImageMeta::default();
        let lut = WbLut::new(&wb, &meta, (-30.0, 50.0), (0.0, 10.0));
        assert_eq!((lut.nt, lut.ni), (41, 6));
        let (m, g) = lut.at(-30.0 + 4.0 * lut.t_step, 2.0 * lut.i_step);
        let exact = with_local_offsets(&wb, &meta, (-30.0 + 4.0 * lut.t_step) as f64, (2.0 * lut.i_step) as f64).unwrap();
        for r in 0..3 {
            for c in 0..3 {
                assert!((m[r][c] - exact.matrix[r][c]).abs() < 1e-6);
            }
        }
        assert!((g - exact.grey_gain).abs() < 1e-6);
        // Between nodes it stays close to the exact matrix.
        let (m, _) = lut.at(7.3, 3.1);
        let exact = with_local_offsets(&wb, &meta, 7.3, 3.1).unwrap();
        for r in 0..3 {
            for c in 0..3 {
                assert!((m[r][c] - exact.matrix[r][c]).abs() < 2e-4, "{m:?} vs {:?}", exact.matrix);
            }
        }
        // asShot plus a local offset is the incremental matrix.
        let lut = WbLut::new(&WhiteBalance::AsShot, &meta, (25.0, 25.0), (0.0, 0.0));
        let (m, _) = lut.at(25.0, 0.0);
        let inc = WhiteBalanceParams::new(&WhiteBalance::Incremental { temperature: 25.0, tint: 0.0 }).unwrap();
        assert_eq!(m, inc.matrix);
    }

    #[test]
    fn sliders_mirror_the_global_passes() {
        let mut s = DevelopSettings::default();
        s.light.exposure = 1.0;
        s.detail.clarity = 20.0;
        let p = Params::new(&s, &RenderOptions::default());
        assert_eq!(p.sliders.exposure_gain, 2.0);
        assert_eq!(p.sliders.clarity, 0.2);
        assert_eq!(p.sliders.sharpen_amount, 0.4, "the baseline sharpening runs once the section is edited");
        let p = Params::new(&DevelopSettings::default(), &RenderOptions::default());
        assert_eq!(p.sliders.sharpen_amount, 0.0);
        assert_eq!(p.sliders.base_scale, 1.0);
    }
}
