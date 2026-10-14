//! Colour science: RGB ↔ XYZ matrices, transfer functions, Oklab/OKLCH, CAT16 adaptation, the Robertson
//! correlated-colour-temperature model, monotone curves baked to lookup tables, camera (RAW) colour matrices and
//! the output profiles (sRGB, Display P3) with their ICC tags.
//!
//! Constants are derived in `f64` from published primaries and matrices; per-pixel code converts the
//! precomputed results to `f32` (see [`matrix::to_f32`]).

pub mod camera;
pub mod cat16;
pub mod curve;
pub mod matrix;
pub mod oklab;
pub mod output;
pub mod temperature;
pub mod transfer;

pub use matrix::{Mat3, Mat3f};
pub use output::OutputProfile;
