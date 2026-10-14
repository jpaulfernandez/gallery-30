//! The CPU reference pipeline, in the plan's section 4.2 order:
//!
//! decode → white balance → exposure → (cached local pre-passes) → highlights/shadows → whites/blacks →
//! contrast → clarity → texture → dehaze → sharpening → colour (mix, vibrance, saturation) → display
//! look (optional) → output (Rec.2020 → sRGB, gamut map, sRGB transfer, parametric + point curves,
//! dither, 8 bit). Effects (workflow plan 17, [`crate::ops::effects`]): halation and vignette after the colour
//! passes and before the display look; grading and grain after the curves, before the dither. The look's 3D LUT
//! (plan 18, [`crate::ops::lut`]) runs between the curves and grading.
//!
//! The local pre-passes ([`crate::local::prepass`]) are computed from the (warped) image once and
//! cached in a [`PrePasses`]: the highlights/shadows guided base, the clarity detail, the texture band,
//! the dehaze density and atmospheric light, and the sharpening planes (for the last radius). Slider
//! changes only re-run the per-pixel passes, which read those planes row by row.
//!
//! `rayon` splits the work by rows; each row is copied into a scratch buffer, run through every active
//! pass, and encoded straight into the output.
//!
//! Geometry (D2.1) runs before all of this: [`Developer`] warps the decoded image into the crop framing
//! once per geometry ([`crate::geometry`]) and develops the warped image.
//!
//! Masks (D4.1): [`masked`] blends each active mask's local sliders into the parameters per pixel; AI components
//! (D4.3) read their rasters from [`Developer::set_ai_rasters`] (or, for one-shot renders, the source installed by
//! [`crate::masks::ai_cache::with_ai_source`]), warped from the decoded image's grid onto the render's; rows no mask
//! touches run the global passes below unchanged.
//!
//! Noise (workflow plan 24, [`crate::ops::noise`]): the chroma filter and the masks' `noise` run first on each row
//! of the input, before white balance; the AI denoise model itself runs outside the pipeline (its intermediate is
//! the input).

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;

pub mod masked;

pub use masked::{layers_key, masks_need_input, LocalBlend, PreparedLayers, Sliders};

use crate::canonical::canonical_json;
use crate::color::OutputProfile;
use crate::geometry::{warp, GeometryPlan, Quality};
use crate::masks::{luminance_plane, rasterise_mask_cached, MaskCache, MaskContext, MaskPlane};
use crate::gpu::{self, GpuState, RenderBackend};
use crate::image::{ImageMeta, LinearImage, Rgb16Image, Rgb8Image};
use crate::local::{LocalPlanes, Needs, PrePasses, BASE_GAMMA};
use crate::ops::clarity::clarity;
use crate::ops::color::{color, ColorParams};
use crate::ops::contrast::{contrast, ContrastParams};
use crate::ops::curves::CurveParams;
use crate::ops::dehaze::dehaze;
use crate::ops::detail::DetailParams;
use crate::ops::display::display_look;
use crate::ops::effects::EffectsParams;
use crate::ops::exposure::{exposure, exposure_gain};
use crate::ops::lut::LutParams;
use crate::ops::noise::NoiseParams;
use crate::ops::output::{encode_row_with, OutputParams, OutputSample};
use crate::ops::sharpen::{mask_visualisation, sharpen};
use crate::ops::texture::texture;
use crate::ops::tonal::{highlights_shadows, whites_blacks, HighlightsShadowsParams, WhitesBlacksParams};
use crate::ops::white_balance::{white_balance, WhiteBalanceParams};
use crate::settings::{DevelopSettings, Geometry, Mask};

/// Render options that are not part of the saved settings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RenderOptions {
    /// Apply the fixed display look ([`crate::ops::display`]). Off by default; see that module.
    pub look: bool,
    /// GPU or CPU ([`RenderBackend::Auto`]: the GPU when one is available).
    pub backend: RenderBackend,
    /// The output colour space (the book's `outputProfile`); sRGB by default. Renders are tagged with its ICC
    /// profile by [`crate::render::encode_jpeg_as`].
    pub output: OutputProfile,
}

/// Every pass's parameters, precomputed once per render. A `None` pass is skipped.
#[derive(Debug, Clone)]
pub struct Params {
    pub white_balance: Option<WhiteBalanceParams>,
    pub exposure: Option<f32>,
    pub highlights_shadows: Option<HighlightsShadowsParams>,
    pub whites_blacks: Option<WhitesBlacksParams>,
    pub contrast: Option<ContrastParams>,
    /// Clarity, texture, dehaze, sharpening; `None` while the Detail section is at its default.
    pub detail: Option<DetailParams>,
    pub color: Option<ColorParams>,
    /// Grading, grain, vignette, halation (workflow plan 17); `None` while the section is at its defaults.
    pub effects: Option<EffectsParams>,
    pub look: bool,
    pub output: OutputParams,
    /// The global slider values in the operators' units, for pixels with local (mask) values.
    pub sliders: Sliders,
    /// The chroma filter and mask noise (workflow plan 24, [`crate::ops::noise`]); runs before white balance.
    pub noise: Option<NoiseParams>,
}

impl Params {
    pub fn new(settings: &DevelopSettings, options: &RenderOptions) -> Self {
        Self::for_image(settings, options, &ImageMeta::default())
    }

    /// [`new`](Self::new) for an image with source metadata (a RAW's as-shot white balance, D6.1).
    pub fn for_image(settings: &DevelopSettings, options: &RenderOptions, meta: &ImageMeta) -> Self {
        let light = &settings.light;
        let white_balance = WhiteBalanceParams::for_image(&settings.white_balance, meta);
        let exposure = exposure_gain(light.exposure.clamp(-10.0, 10.0));
        // The base is cached from the decoded image; scale it as WB and exposure scale a grey.
        let grey = exposure.unwrap_or(1.0) * white_balance.as_ref().map_or(1.0, |w| w.grey_gain);
        let base_scale = grey.max(0.0).powf(1.0 / BASE_GAMMA);
        let mut params = Self {
            white_balance,
            exposure,
            highlights_shadows: HighlightsShadowsParams::new(light, base_scale),
            whites_blacks: WhitesBlacksParams::new(light),
            contrast: ContrastParams::new(light.contrast),
            detail: DetailParams::new(&settings.detail),
            color: ColorParams::new(&settings.color),
            effects: EffectsParams::new(&settings.effects, grey),
            look: options.look,
            output: OutputParams::for_profile(options.output, CurveParams::new(&settings.curve))
                .with_lut(LutParams::new(&settings.look)),
            sliders: Sliders::default(),
            noise: NoiseParams::new(settings, meta),
        };
        params.sliders = Sliders::new(settings, &params, base_scale, meta);
        params
    }

    /// The local pre-passes this render reads.
    pub fn needs(&self) -> Needs {
        let mut needs = Needs { hs_base: self.highlights_shadows.is_some(), ..Needs::default() };
        if let Some(d) = &self.detail {
            d.add_needs(&mut needs);
        }
        if let Some(e) = &self.effects {
            e.add_needs(&mut needs);
        }
        needs.noise = self.noise.as_ref().map(|n| n.key);
        needs
    }

    /// The atmospheric light measured on the decoded image, mapped through this render's white balance
    /// and exposure (dehaze runs after them).
    pub(crate) fn current_airlight(&self, measured: [f32; 3]) -> [f32; 3] {
        let mut a = measured;
        if let Some(p) = &self.white_balance {
            white_balance(&mut a, p);
        }
        if let Some(gain) = self.exposure {
            exposure(&mut a, gain);
        }
        a
    }
}

/// Run the pipeline. `planes` must hold what [`Params::needs`] asks for, computed from `image` (a pass
/// whose plane is missing is skipped).
pub fn develop(image: &LinearImage, planes: &LocalPlanes<'_>, params: &Params) -> Rgb8Image {
    develop_with_masks(image, planes, params, None)
}

/// [`develop`] with masks: rows some mask touches run [`masked`]'s per-pixel path. `planes` must also hold
/// what [`LocalBlend::needs`] asks for; the blend must be on `image`'s grid.
pub fn develop_with_masks(image: &LinearImage, planes: &LocalPlanes<'_>, params: &Params, blend: Option<&LocalBlend>) -> Rgb8Image {
    Rgb8Image::new(image.width, image.height, develop_samples(image, planes, params, blend))
}

/// [`develop_with_masks`] into 16-bit output samples (no dither): the export's TIFF and HEIC (workflow plan 12).
pub fn develop_with_masks16(image: &LinearImage, planes: &LocalPlanes<'_>, params: &Params, blend: Option<&LocalBlend>) -> Rgb16Image {
    Rgb16Image::new(image.width, image.height, develop_samples(image, planes, params, blend))
}

/// The pipeline into interleaved output samples of type `T` (`width * height * 3`).
fn develop_samples<T: OutputSample>(image: &LinearImage, planes: &LocalPlanes<'_>, params: &Params, blend: Option<&LocalBlend>) -> Vec<T> {
    let (w, h) = (image.width as usize, image.height as usize);
    let mut out = vec![T::default(); w * h * 3];
    if w == 0 || h == 0 {
        return out;
    }
    let hs = params.highlights_shadows.as_ref().zip(planes.hs_base);
    let detail = params.detail.as_ref();
    let cl = detail.and_then(|d| d.clarity.as_ref()).zip(planes.clarity);
    let tx = detail.and_then(|d| d.texture.as_ref()).zip(planes.texture);
    let dh = detail
        .and_then(|d| d.dehaze.as_ref())
        .zip(planes.haze)
        .map(|(p, haze)| (p, haze.density.as_slice(), params.current_airlight(haze.airlight)));
    let sh = detail.and_then(|d| d.sharpen.as_ref()).zip(planes.sharpen.as_deref());
    let blend = blend.filter(|b| !b.is_empty());
    if let Some(b) = blend {
        assert_eq!((b.width(), b.height()), (image.width, image.height), "mask layers are not on the image grid");
    }
    let linear_fx = params.effects.as_ref().and_then(|e| e.linear(image.width, image.height, planes.halation.as_deref()));
    let display_fx = params.effects.as_ref().and_then(|e| e.display(image.width, image.height));
    let noise = params.noise.as_ref().zip(planes.noise.as_deref());
    let row_inputs = blend.map(|_| masked::RowInputs {
        hs_base: planes.hs_base,
        clarity: planes.clarity,
        texture: planes.texture,
        haze: planes.haze.map(|haze| (haze.density.as_slice(), params.current_airlight(haze.airlight))),
        sharpen: planes.sharpen.as_deref(),
    });
    out.par_chunks_mut(w * 3).enumerate().for_each_init(
        || (vec![0.0f32; w * 3], Vec::new()),
        |(row, scratch), (y, out_row)| {
            let span = y * w..(y + 1) * w;
            row.copy_from_slice(image.row(y as u32));
            if let Some((p, n)) = noise {
                crate::ops::noise::apply_row(row, y, p, n, blend.filter(|b| b.rows[y]));
            }
            if let (Some(b), Some(inp)) = (blend.filter(|b| b.rows[y]), &row_inputs) {
                masked::develop_row(row, span, params, inp, b);
                if let Some(fx) = &linear_fx {
                    fx.apply(row, y as u32, scratch);
                }
                if params.look {
                    display_look(row);
                }
                encode_row_with(row, y as u32, out_row, &params.output, display_fx.as_ref());
                return;
            }
            if let Some(p) = &params.white_balance {
                white_balance(row, p);
            }
            if let Some(gain) = params.exposure {
                exposure(row, gain);
            }
            if let Some((p, base)) = hs {
                highlights_shadows(row, &base[span.clone()], p);
            }
            if let Some(p) = &params.whites_blacks {
                whites_blacks(row, p);
            }
            if let Some(p) = &params.contrast {
                contrast(row, p);
            }
            if let Some((p, plane)) = cl {
                clarity(row, &plane[span.clone()], p);
            }
            if let Some((p, plane)) = tx {
                texture(row, &plane[span.clone()], p);
            }
            if let Some((p, density, airlight)) = &dh {
                dehaze(row, &density[span.clone()], *airlight, p);
            }
            if let Some((p, s)) = sh {
                sharpen(row, &s.fine[span.clone()], &s.coarse[span.clone()], &s.edges[span.clone()], p);
            }
            if let Some(p) = &params.color {
                color(row, p);
            }
            if let Some(fx) = &linear_fx {
                fx.apply(row, y as u32, scratch);
            }
            if params.look {
                display_look(row);
            }
            encode_row_with(row, y as u32, out_row, &params.output, display_fx.as_ref());
        },
    );
    out
}

/// The masks of a one-shot render (`render_full`, `render_preview`) on `plan`'s grid, without caching; `None`
/// without an active mask. `input` gives the input image on that grid and is only called when a range
/// component needs it.
pub(crate) fn one_shot_blend<'a>(
    settings: &DevelopSettings,
    params: &Params,
    plan: &GeometryPlan,
    input: impl FnOnce() -> crate::Result<&'a LinearImage>,
) -> crate::Result<Option<LocalBlend>> {
    if !settings.masks.iter().any(masked::is_active) {
        return Ok(None);
    }
    let active: Vec<Mask> = settings.masks.iter().filter(|m| masked::is_active(m)).cloned().collect();
    let empty = masked::empty_image();
    let image: &LinearImage = if active.iter().any(masked::mask_reads_input) { input()? } else { &empty };
    let luma = if active.iter().any(masked::mask_reads_luma) { luminance_plane(image) } else { Vec::new() };
    let (w, h) = (plan.output_width, plan.output_height);
    // AI rasters come from the source installed on this thread (`masks::ai_cache::with_ai_source`), if any.
    let source = crate::masks::ai_cache::scoped_ai_source();
    let lookup = source.as_deref().map(|s| crate::masks::ai_cache::lookup_on_plan(s, &active, plan));
    let ai: &(dyn Fn(&str) -> Option<Arc<MaskPlane>> + Sync) = match &lookup {
        Some(l) => l,
        None => &no_ai_raster,
    };
    let prepared = PreparedLayers::build_with_ai(&active, w, h, &plan.frame_to_output_matrix(), image, &luma, None, ai);
    Ok(LocalBlend::new(settings, params, &prepared))
}

/// Holds a decoded image and its cached pre-passes so that a slider change costs one per-pixel pass.
///
/// The local pre-passes ([`PrePasses`]: highlights/shadows base, clarity detail, texture band, dehaze
/// density, sharpening planes) are computed on first use and kept for the life of the `Developer` (they
/// depend only on the image, plus the sharpening radius for the sharpening planes, which are kept for
/// the last radius; exposure and white balance are accounted for analytically).
///
/// Geometry: when the settings' geometry is not the identity, the decoded image is warped into the crop
/// framing first. The last warp is cached (keyed by the geometry's canonical JSON and the quality)
/// together with its own pre-passes, so dragging a colour slider never re-warps; changing the geometry
/// re-warps once from the decoded image. An identity geometry skips the warp and uses the decoded image
/// as is, so unedited renders are unchanged.
///
/// GPU (D3.2): with [`RenderBackend::Auto`] (the default) and a GPU available ([`crate::gpu::GpuContext`]),
/// renders run on the GPU, which keeps its own cache of the same things (the uploaded image, the last
/// warp under the same key, the coarse guided-filter planes, and the planes of an image that fits one
/// tile); a GPU failure falls back to this CPU path.
///
/// Make a new `Developer` when the image changes. `render` takes `&self`, so one `Developer` can be
/// shared (e.g. in an `Arc`) and render from several threads.
#[derive(Debug)]
pub struct Developer {
    image: LinearImage,
    pre: PrePasses,
    warped: Mutex<Option<Arc<Warped>>>,
    warps: AtomicUsize,
    /// The GPU path's cache of this image (uploaded source, warp, coarse planes), built on first use.
    gpu: Mutex<GpuState>,
    /// The backend of the last render (`BACKEND_*`).
    last_backend: AtomicU8,
    /// Mask rasters and composited planes for the current input image (D4.1).
    masks: Mutex<MaskState>,
    /// Where AI mask components get their rasters (D4.3); `None` = they count as 0.
    ai: Mutex<Option<Arc<dyn crate::masks::ai_cache::AiRasterSource>>>,
}

/// The mask caches of one input image (the decoded image, or the current warp): the component LRU, the
/// input's luminance plane, and the last composited planes keyed by [`layers_key`]. Everything is dropped when
/// the input changes (range components read its pixels).
#[derive(Debug, Default)]
struct MaskState {
    input: String,
    cache: MaskCache,
    luma: Option<Arc<Vec<f32>>>,
    layers: Option<(String, PreparedLayers)>,
    /// Composited-plane cache misses, for tests and logging.
    builds: usize,
}

impl MaskState {
    /// Switch to the input `key`, dropping everything cached for another one.
    fn select(&mut self, key: String) {
        if self.input != key {
            self.input = key;
            self.cache.clear();
            self.luma = None;
            self.layers = None;
        }
    }
}

fn no_ai_raster(_: &str) -> Option<Arc<MaskPlane>> {
    None
}

const BACKEND_NONE: u8 = 0;
const BACKEND_CPU: u8 = 1;
const BACKEND_GPU: u8 = 2;

/// One cached warp of the decoded image and its lazily computed pre-passes.
#[derive(Debug)]
struct Warped {
    key: String,
    image: LinearImage,
    pre: PrePasses,
}

/// The cache key of a geometry warp.
pub(crate) fn warp_key(geometry: &Geometry, quality: Quality) -> String {
    let value = serde_json::to_value(geometry).expect("geometry always serialises");
    format!("{}|{quality:?}", canonical_json(&value))
}

impl Developer {
    pub fn new(image: LinearImage) -> Developer {
        Developer {
            image,
            pre: PrePasses::new(),
            warped: Mutex::new(None),
            warps: AtomicUsize::new(0),
            gpu: Mutex::new(GpuState::default()),
            last_backend: AtomicU8::new(BACKEND_NONE),
            masks: Mutex::new(MaskState::default()),
            ai: Mutex::new(None),
        }
    }

    /// Set where AI mask components read their rasters (D4.3; [`crate::masks::ai_cache::ImageRasters`] in the
    /// editor). Rasters are on the decoded image's grid and are warped onto each render's grid. Drops the cached
    /// mask planes.
    pub fn set_ai_rasters(&self, source: Option<Arc<dyn crate::masks::ai_cache::AiRasterSource>>) {
        *self.ai.lock().unwrap_or_else(|e| e.into_inner()) = source;
        let mut st = self.masks.lock().unwrap_or_else(|e| e.into_inner());
        st.cache.clear();
        st.layers = None;
    }

    /// The AI raster source, if one is set.
    pub fn ai_rasters(&self) -> Option<Arc<dyn crate::masks::ai_cache::AiRasterSource>> {
        self.ai.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The decoded (unwarped) image.
    pub fn image(&self) -> &LinearImage {
        &self.image
    }

    /// `(width, height)` of the decoded image. A render's size is
    /// [`developed_size`](Self::developed_size) of its geometry (the same when there is no crop or
    /// 90° rotation).
    pub fn size(&self) -> (u32, u32) {
        (self.image.width, self.image.height)
    }

    /// `(width, height)` of a render with this geometry: the crop at this image's resolution.
    pub fn developed_size(&self, geometry: &Geometry) -> (u32, u32) {
        GeometryPlan::new(geometry, self.image.width, self.image.height, None).developed_size
    }

    pub fn into_image(self) -> LinearImage {
        self.image
    }

    /// How many times this `Developer` has warped (cache misses, CPU and GPU), for tests and logging.
    pub fn warp_count(&self) -> usize {
        self.warps.load(Ordering::Relaxed)
    }

    /// Render with the default options for the decoded image ([`RenderOptions::for_image`]: the display look on for
    /// camera RAW, as `render_full` and `render_preview` do).
    pub fn render(&self, settings: &DevelopSettings) -> Rgb8Image {
        self.render_with(settings, &RenderOptions::for_image(&self.image.meta))
    }

    /// Render; the geometry resamples with [`Quality::for_size`] of the decoded image (Catmull-Rom up to
    /// a 2000 px long edge, Lanczos3 above).
    pub fn render_with(&self, settings: &DevelopSettings, options: &RenderOptions) -> Rgb8Image {
        self.render_with_quality(settings, options, Quality::for_size(self.image.width, self.image.height))
    }

    /// Render with an explicit resampling quality for the geometry warp.
    pub fn render_with_quality(&self, settings: &DevelopSettings, options: &RenderOptions, quality: Quality) -> Rgb8Image {
        let params = Params::for_image(settings, options, &self.image.meta);
        let plan = GeometryPlan::new(&settings.geometry, self.image.width, self.image.height, None);
        let blend = self.blend(settings, &params, &plan, quality);
        if let Some(ctx) = gpu::context_for(options).filter(|_| gpu::fits_masks(blend.as_ref()) && gpu::supports(settings)) {
            // Layers with a missing AI raster are not cached (empty key): the raster may arrive before the next render.
            let key = blend.as_ref().map(|b| if b.missing_ai.is_empty() { layers_key(&settings.masks) } else { String::new() });
            let masks = blend.as_ref().zip(key.as_deref());
            if let Some(out) = gpu::render_cached(ctx, &self.gpu, &self.image, settings, &params, quality, &self.warps, masks) {
                self.last_backend.store(BACKEND_GPU, Ordering::Relaxed);
                return out;
            }
        }
        self.last_backend.store(BACKEND_CPU, Ordering::Relaxed);
        let needs = masked::union_needs(params.needs(), blend.as_ref().map(LocalBlend::needs));
        if plan.is_identity() {
            return develop_with_masks(&self.image, &self.pre.prepare(&self.image, &needs), &params, blend.as_ref());
        }
        let warped = self.warped(&settings.geometry, &plan, quality);
        develop_with_masks(&warped.image, &warped.pre.prepare(&warped.image, &needs), &params, blend.as_ref())
    }

    /// The masks of a render on `plan`'s grid (`None` without an active mask). Composited planes are cached
    /// under [`layers_key`] for the current input image and component rasters in a [`MaskCache`], so a global
    /// or local slider change reuses both. Range components read the input image (the CPU warp when there is
    /// a geometry, made here even when the GPU renders).
    fn blend(&self, settings: &DevelopSettings, params: &Params, plan: &GeometryPlan, quality: Quality) -> Option<LocalBlend> {
        if !settings.masks.iter().any(masked::is_active) {
            return None;
        }
        let key = layers_key(&settings.masks);
        let mut st = self.masks.lock().unwrap_or_else(|e| e.into_inner());
        st.select(self.input_key(settings, plan, quality));
        if let Some((_, prepared)) = st.layers.as_ref().filter(|(k, _)| *k == key) {
            return LocalBlend::new(settings, params, prepared);
        }
        let active: Vec<_> = settings.masks.iter().filter(|m| masked::is_active(m)).cloned().collect();
        let prepared = self.with_mask_input(&mut st, settings, plan, quality, &active, |st, ctx| {
            PreparedLayers::build_with_ai(
                &active,
                ctx.width,
                ctx.height,
                ctx.frame_to_output,
                ctx.input_rgb,
                ctx.input_luma,
                Some(&mut st.cache),
                ctx.ai_rasters,
            )
        });
        st.builds += 1;
        let blend = LocalBlend::new(settings, params, &prepared);
        // Planes with a missing AI raster are rebuilt next time, so a raster generated meanwhile is picked up.
        st.layers = if prepared.missing_ai.is_empty() { Some((key, prepared)) } else { None };
        blend
    }

    /// The input key of the mask caches: the warp key, or `identity`.
    fn input_key(&self, settings: &DevelopSettings, plan: &GeometryPlan, quality: Quality) -> String {
        if plan.is_identity() {
            "identity".to_string()
        } else {
            warp_key(&settings.geometry, quality)
        }
    }

    /// Run `f` with a mask context on `plan`'s grid for `masks`, with the input image (and its luminance
    /// plane) only when one of them has a range component.
    fn with_mask_input<T>(
        &self,
        st: &mut MaskState,
        settings: &DevelopSettings,
        plan: &GeometryPlan,
        quality: Quality,
        masks: &[Mask],
        f: impl FnOnce(&mut MaskState, &MaskContext) -> T,
    ) -> T {
        let frame_to_output = plan.frame_to_output_matrix();
        let empty = masked::empty_image();
        let warped;
        let input: &LinearImage = if !masks.iter().any(masked::mask_reads_input) {
            &empty
        } else if plan.is_identity() {
            &self.image
        } else {
            warped = self.warped(&settings.geometry, plan, quality);
            &warped.image
        };
        let luma = masks
            .iter()
            .any(masked::mask_reads_luma)
            .then(|| Arc::clone(st.luma.get_or_insert_with(|| Arc::new(luminance_plane(input)))));
        let source = self.ai_rasters();
        let lookup = source.as_deref().map(|s| crate::masks::ai_cache::lookup_on_plan(s, masks, plan));
        let ai_rasters: &(dyn Fn(&str) -> Option<Arc<MaskPlane>> + Sync) = match &lookup {
            Some(l) => l,
            None => &no_ai_raster,
        };
        let ctx = MaskContext {
            width: plan.output_width,
            height: plan.output_height,
            frame_to_output: &frame_to_output,
            input_luma: luma.as_deref().map_or(&[], |l| l.as_slice()),
            input_rgb: input,
            ai_rasters,
        };
        f(st, &ctx)
    }

    /// One mask's composited plane (after its components, invert, feather and opacity) at the size of a
    /// render with `settings.geometry`, for the UI's overlay: `(width, height, values 0..1)`. Disabled masks
    /// and masks without adjustments are drawn too. `None` when there is no mask `mask_id`. Shares the
    /// component cache with renders.
    pub fn mask_overlay(&self, settings: &DevelopSettings, mask_id: &str) -> Option<(u32, u32, Vec<f32>)> {
        let mask = settings.masks.iter().find(|m| m.id == mask_id)?.clone();
        let quality = Quality::for_size(self.image.width, self.image.height);
        let plan = GeometryPlan::new(&settings.geometry, self.image.width, self.image.height, None);
        let mut st = self.masks.lock().unwrap_or_else(|e| e.into_inner());
        st.select(self.input_key(settings, &plan, quality));
        let plane = self.with_mask_input(&mut st, settings, &plan, quality, std::slice::from_ref(&mask), |st, ctx| {
            rasterise_mask_cached(&mask, ctx, &mut st.cache).plane
        });
        Some((plane.width, plane.height, plane.data))
    }

    /// How many times this `Developer` composited mask planes (cache misses), for tests and logging.
    pub fn mask_build_count(&self) -> usize {
        self.masks.lock().unwrap_or_else(|e| e.into_inner()).builds
    }

    /// The sharpening mask for the Alt-drag view on Masking: one value per pixel of the render (0 = not
    /// sharpened, 1 = fully), at the render's size, for `settings.detail.sharpen` (radius and masking).
    /// Shares the cached sharpening planes with [`render`](Self::render).
    pub fn sharpen_mask(&self, settings: &DevelopSettings) -> (u32, u32, Vec<f32>) {
        let sharpen = &settings.detail.sharpen;
        let radius = sharpen.radius.clamp(0.5, 3.0) as f32;
        let plan = GeometryPlan::new(&settings.geometry, self.image.width, self.image.height, None);
        let (w, h, planes) = if plan.is_identity() {
            (self.image.width, self.image.height, self.pre.sharpen(&self.image, radius))
        } else {
            let warped = self.warped(&settings.geometry, &plan, Quality::for_size(self.image.width, self.image.height));
            (warped.image.width, warped.image.height, warped.pre.sharpen(&warped.image, radius))
        };
        (w, h, mask_visualisation(&planes.edges, sharpen.masking))
    }

    /// How many pre-pass planes this `Developer` has computed for the unwarped image (cache misses, on the
    /// CPU and the GPU together), for tests and logging.
    pub fn prepass_count(&self) -> usize {
        self.pre.computed() + self.gpu.lock().unwrap_or_else(|e| e.into_inner()).prepass_count()
    }

    /// Which engine rendered last ([`RenderBackend::Cpu`] or [`RenderBackend::Gpu`]; `None` before the
    /// first render).
    pub fn last_backend(&self) -> Option<RenderBackend> {
        match self.last_backend.load(Ordering::Relaxed) {
            BACKEND_CPU => Some(RenderBackend::Cpu),
            BACKEND_GPU => Some(RenderBackend::Gpu),
            _ => None,
        }
    }

    /// The cached warp for `geometry`, computing it on a miss. The lock is held while warping so
    /// concurrent renders of a new geometry warp once.
    fn warped(&self, geometry: &Geometry, plan: &GeometryPlan, quality: Quality) -> Arc<Warped> {
        let key = warp_key(geometry, quality);
        let mut slot = self.warped.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = slot.as_ref().filter(|w| w.key == key) {
            return Arc::clone(w);
        }
        *slot = None; // free the old warp before allocating the new one
        let image = warp(&self.image, plan, quality);
        self.warps.fetch_add(1, Ordering::Relaxed);
        let w = Arc::new(Warped { key, image, pre: PrePasses::new() });
        *slot = Some(Arc::clone(&w));
        w
    }
}
