//! The GPU path (D3.2): a `wgpu` port of the CPU reference pipeline as WGSL compute shaders, verified
//! against it (`tests/gpu.rs`). See the README's GPU section for the architecture, tiling and caveats.
//!
//! - [`device`]: the process-wide [`GpuContext`], [`init`] (crash flag directory), `PHOTOBOOK_FORCE_CPU`.
//! - `kernels`: WGSL assembly (a `const` prelude generated from the Rust constants) and the pipelines.
//! - `params`: the chain's uniform block and lookup tables, built from [`crate::cpu::Params`].
//! - `warp`: the geometry warp's three paths (copy, copy + resize, Catmull-Rom / Lanczos3 gathers with
//!   the Mitchell prefilter).
//! - `engine`: upload, the whole image's coarse guided-filter stages, tiles with overlap, the chain,
//!   readback; [`GpuState`] caches one image's GPU resources.
//!
//! [`crate::Developer`], [`crate::render_full`] and [`crate::render_preview`] use the GPU when
//! [`GpuContext::get`] is `Some` (and the image fits the GPU's texture limit), else the CPU, per
//! [`RenderBackend`]. Any GPU error falls back to the CPU for that render and disables the GPU for the
//! rest of the process.

pub mod device;
mod engine;
mod kernels;
// The chroma filter and mask noise (workflow plan 24).
mod noise;
mod params;
// Plan 53: focus peak and zebra, a view-only pass over the 8-bit preview (the CPU reference is `preview_modes`).
mod preview_mode;
mod warp;

use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

pub use device::{
    availability, clear_crash_flag, crash_flag_present, force_cpu, init, GpuContext, CRASH_FLAG_FILE, FORCE_CPU_ENV,
};
pub use engine::{GpuError, GpuState, Tiling, MAX_PIXELS, TILE_SIZE};

use crate::cpu::{one_shot_blend, LocalBlend, Params, RenderOptions};
use crate::geometry::Quality;
use crate::image::{LinearImage, Rgb8Image};
use crate::settings::DevelopSettings;

/// Which engine renders.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum RenderBackend {
    /// The GPU when [`GpuContext::get`] is `Some`, else the CPU.
    #[default]
    Auto,
    /// The CPU reference pipeline.
    Cpu,
    /// The GPU; falls back to the CPU (with a warning in the log) when there is none.
    Gpu,
}

/// Most mask layers a GPU render takes (one `r32float` array layer each, per tile); a render with more
/// active masks runs on the CPU.
pub const MAX_MASK_LAYERS: usize = 16;

/// Whether the GPU can take these masks ([`MAX_MASK_LAYERS`]).
pub(crate) fn fits_masks(blend: Option<&LocalBlend>) -> bool {
    blend.is_none_or(|b| b.len() <= MAX_MASK_LAYERS)
}

/// Why the GPU path cannot render `settings` (`Unsupported`), or `None` when it can. Nothing is unsupported at
/// present: the Effects (workflow plan 17) run in WGSL since plan 19. The hook stays for any future operator that
/// lands on the CPU before its GPU port; such a render then falls back to the CPU with the same pixels.
pub fn unsupported(_settings: &DevelopSettings) -> Option<&'static str> {
    None
}

/// Whether the GPU can render `settings`; logs the CPU fallback when it cannot: at info level the first time a
/// reason is seen in a row, at debug level for repeats, so a slider drag does not log every preview frame.
pub(crate) fn supports(settings: &DevelopSettings) -> bool {
    static LAST: Mutex<Option<&'static str>> = Mutex::new(None);
    let Some(why) = unsupported(settings) else { return true };
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if *last == Some(why) {
        log::debug!("[photobook:gpu] unsupported: {why}; rendering on the CPU");
    } else {
        log::info!("[photobook:gpu] unsupported: {why}; rendering on the CPU");
        *last = Some(why);
    }
    false
}

/// The context to render with for these options, if any.
pub(crate) fn context_for(options: &RenderOptions) -> Option<&'static GpuContext> {
    match options.backend {
        RenderBackend::Cpu => None,
        RenderBackend::Auto => GpuContext::get(),
        RenderBackend::Gpu => {
            let ctx = GpuContext::get();
            if ctx.is_none() {
                log::warn!("[photobook:gpu] GPU render requested but no GPU is available; using the CPU");
            }
            ctx
        }
    }
}

/// Run a GPU render inside a validation/out-of-memory error scope; any error disables the GPU.
fn guarded(ctx: &GpuContext, f: impl FnOnce() -> Result<Rgb8Image, GpuError>) -> Option<Rgb8Image> {
    let validation = ctx.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let oom = ctx.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let result = f();
    let oom_err = pollster::block_on(oom.pop());
    let validation_err = pollster::block_on(validation.pop());
    if let Some(err) = validation_err.or(oom_err) {
        ctx.mark_broken(&err.to_string());
        return None;
    }
    match result {
        Ok(img) => Some(img),
        Err(err) => {
            log::warn!("[photobook:gpu] render failed, using the CPU: {err}");
            None
        }
    }
}

/// A [`crate::Developer`]'s render on the GPU with its cached state; `None` = render on the CPU.
pub(crate) fn render_cached(
    ctx: &GpuContext,
    state: &Mutex<GpuState>,
    image: &LinearImage,
    settings: &DevelopSettings,
    params: &Params,
    quality: Quality,
    warps: &AtomicUsize,
    masks: Option<(&LocalBlend, &str)>,
) -> Option<Rgb8Image> {
    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
    guarded(ctx, || engine::render(ctx, &mut state, image, settings, params, quality, None, Tiling::Auto, warps, masks))
}

/// A one-shot GPU render (`render_full`, `render_preview`); `None` = render on the CPU.
pub(crate) fn render_once(
    ctx: &GpuContext,
    image: &LinearImage,
    settings: &DevelopSettings,
    options: &RenderOptions,
    quality: Quality,
    target: Option<u32>,
    tiling: Tiling,
    blend: Option<&LocalBlend>,
) -> Option<Rgb8Image> {
    let params = Params::for_image(settings, options, &image.meta);
    let mut state = GpuState::default();
    let warps = AtomicUsize::new(0);
    let masks = blend.map(|b| (b, ""));
    guarded(ctx, || engine::render(ctx, &mut state, image, settings, &params, quality, target, tiling, &warps, masks))
}

/// `image` with the preview `modes` drawn over it on the GPU (plan 53); `None` = draw them on the CPU. Public for the
/// GPU-against-CPU test; renders go through [`crate::apply_preview_modes`].
pub fn preview_modes(
    ctx: &GpuContext,
    image: &Rgb8Image,
    modes: &[crate::preview_modes::PreviewMode],
) -> Option<Rgb8Image> {
    guarded(ctx, || preview_mode::run(ctx, image, modes))
}

/// Render the whole image on the GPU with an explicit tiling (for tests and benchmarks: whole-image vs
/// tiled agreement). `None` when no GPU is available or it failed. The geometry resamples with
/// [`Quality::for_size`] of the image, as [`crate::render_full`].
pub fn render_tiled(image: &LinearImage, settings: &DevelopSettings, tiling: Tiling) -> Option<Rgb8Image> {
    let ctx = GpuContext::get()?;
    let quality = Quality::for_size(image.width, image.height);
    let options = RenderOptions::default();
    let params = Params::for_image(settings, &options, &image.meta);
    let plan = crate::GeometryPlan::new(&settings.geometry, image.width, image.height, None);
    let warped = std::cell::OnceCell::new();
    let input = || Ok(if plan.is_identity() { image } else { warped.get_or_init(|| crate::geometry::warp(image, &plan, quality)) });
    let blend = one_shot_blend(settings, &params, &plan, input).ok()?;
    if !fits_masks(blend.as_ref()) || !supports(settings) {
        return None;
    }
    render_once(ctx, image, settings, &options, quality, None, tiling, blend.as_ref())
}
