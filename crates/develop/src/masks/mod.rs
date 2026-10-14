//! D4.1 masks: rasterise the parametric and brush mask components of a [`crate::settings::Mask`] onto the
//! output (crop) grid, combine them, and describe how the pipeline blends local adjustments per pixel.
//! See `docs/design/archive/DEVELOP_PLAN.md` (section 2 "Masks and geometry", 4.2 "Masks", Step D4.1) and the
//! crate README's Masks section for the unit conventions.
//!
//! - [`raster`]: [`MaskPlane`] and one rasteriser per shape (linear, radial, brush, luminance, colour).
//!   Vector shapes live in fractions of the transformed, uncropped frame and are mapped onto the output grid
//!   by a `frame_to_output` homography ([`crate::GeometryPlan::frame_to_output_matrix`]).
//! - [`composite`]: [`rasterise_mask`]: components in order (add = max, subtract = saturating subtract,
//!   intersect = min), per-component and mask-level invert, feather, opacity; [`grow`] (dilate/erode).
//! - [`hash`]: [`component_hash`] and [`MaskCache`], a small LRU of component rasters.
//! - [`blend`]: [`MaskLayers`], [`local_weights`] and [`LocalParams`], the per-pixel contract the pipeline
//!   consumes.
//!
//! - [`ai_cache`]: AI component rasters (D4.3) on disk and in memory, on the source grid, and how renders read them.
//!
//! The pipeline applies them through [`crate::cpu::masked`] (CPU) and the GPU chain kernel.

pub mod ai_cache;
pub mod blend;
pub mod composite;
pub mod hash;
pub mod raster;

pub use blend::{local_weights, LocalParams, MaskLayers};
pub use composite::{
    combine, feather_sigma_px, grow, max_filter, rasterise_component, rasterise_mask, rasterise_mask_cached, MaskContext,
    MaskResult,
};
pub use hash::{component_hash, component_hash_input, MaskCache, MaskKey, MASK_RASTER_VERSION};
pub use raster::{
    color_sigma, luminance_plane, parse_hex_color, rasterise_brush, rasterise_color, rasterise_linear,
    rasterise_luminance, rasterise_radial, FrameGrid, MaskPlane,
};
