//! Neighbourhood pre-passes (plan section 4.2 item 4) and the filters they are built from, all on
//! single-channel `f32` planes with `rayon`:
//!
//! - [`blur`]: separable Gaussian (exact kernel, or three box passes for large σ), box filter by
//!   running sums, min filter, integer-factor down/upsampling.
//! - [`guided`]: the guided filter (He, Sun, Tang) with a grey guide and its fast form (coefficients
//!   solved at a quarter of the resolution, applied to the full-resolution guide).
//! - [`prepass`]: the planes the pipeline reads (highlights/shadows base, clarity detail, texture band,
//!   dehaze density and atmospheric light, sharpening detail and edge mask) and [`PrePasses`], their
//!   per-image cache.
//!
//! Radii are given at a 1080 px short-side reference and scaled by `min(w, h) / 1080`
//! ([`reference_scale`]), so a proxy and a full-resolution export get the same look.

pub mod blur;
pub mod guided;
pub mod prepass;

pub use blur::{box_filter, gaussian_blur, gaussian_blurred};
pub use guided::{guided_filter, guided_filter_with};
pub use prepass::{HazePlanes, LocalPlanes, Needs, PrePasses, SharpenPlanes, LOG_FLOOR};

/// Reference short side for every radius.
pub const REFERENCE_SHORT_SIDE: f32 = 1080.0;
/// Exponent of the lightness encoding: `t = Y^(1/2.4)`, close to sRGB.
pub const BASE_GAMMA: f32 = 2.4;

/// `min(w, h) / 1080`: multiply a reference radius by this to get pixels.
pub fn reference_scale(width: usize, height: usize) -> f32 {
    width.min(height) as f32 / REFERENCE_SHORT_SIDE
}

/// σ in pixels for an image of this size.
pub fn scaled_sigma(sigma_ref: f32, width: u32, height: u32) -> f32 {
    sigma_ref * reference_scale(width as usize, height as usize)
}

/// Encoded lightness: `max(Y, 0)^(1/2.4)`.
#[inline]
pub fn lightness(y: f32) -> f32 {
    y.max(0.0).powf(1.0 / BASE_GAMMA)
}
