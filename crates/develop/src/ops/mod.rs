//! One pure function per control. Each works in place on a row of interleaved linear Rec.2020 RGB
//! triples (`&mut [f32]`, length a multiple of 3) with a `Params` struct precomputed once per render
//! from the settings. A `Params::new` returns `None` when the control is at its default, and the
//! pipeline then skips the pass entirely, so an unedited photo goes through untouched.
//!
//! The local controls (highlights/shadows, clarity, texture, dehaze, sharpening) are per-pixel too: they
//! read the matching row of a plane precomputed once per image by [`crate::local::prepass`] and apply a
//! gain, so a slider drag never recomputes a neighbourhood.
//!
//! Constants that set a slider's strength (`*_STRENGTH`, `*_EV`, ...) are first guesses at a
//! Lightroom-like feel; changing any of them changes renders, so bump `ENGINE_VERSION` with them.

pub mod clarity;
pub mod color;
pub mod contrast;
pub mod curves;
pub mod dehaze;
pub mod detail;
pub mod display;
pub mod exposure;
pub mod output;
pub mod sharpen;
pub mod texture;
pub mod tonal;
pub mod white_balance;
// Effects (workflow plan 17).
pub mod effects;
pub mod grading;
pub mod grain;
pub mod halation;
pub mod vignette;
// The look's 3D LUT (workflow plan 18).
pub mod lut;
// The chroma filter and mask noise (workflow plan 24).
pub mod noise;
// Export watermark and border, on the final pixels (workflow plan 12).
pub mod watermark;

/// Hermite smoothstep of `x` between `e0` and `e1`.
#[inline]
pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
