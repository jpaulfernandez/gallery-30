//! Photobook's develop pipeline. Pure Rust, no Tauri: the editor's Tauri commands and (later) a sidecar
//! CLI use it. See docs/design/archive/DEVELOP_PLAN.md and this crate's README.
//!
//! - [`settings`]: the serde mirror of the Zod `DevelopSettings`, [`develop_hash`] keys cached renders.
//! - [`decode`]: JPEG/PNG to [`LinearImage`] (linear Rec.2020, D65, `f32`, upright).
//! - [`color`]: matrices, transfer functions, Oklab, CAT16, Robertson temperature, monotone curves.
//! - [`local`]: Gaussian, box and guided filters and the cached local pre-passes (D3.1).
//! - [`ops`]: one pure function per control on rows of RGB triples, each with a precomputed `Params`.
//! - [`masks`]: mask rasterisers, composition, the component LRU and the per-pixel blend contract (D4.1).
//! - [`geometry`]: rotate/flip, straighten and crop as one homography, and the warp into the crop framing.
//! - [`cpu`]: the reference pipeline ([`Developer`]), `rayon` over rows.
//! - [`gpu`]: the `wgpu` compute port of the same pipeline (D3.2), used when a GPU is available.
//! - [`preview_modes`]: focus peak and zebra drawn over a preview's 8-bit output (plan 53; never in the hash).
//! - [`render`]: preview/full entry points, JPEG encoding tagged with the output profile (sRGB or Display P3), Exif copy.
//! - [`lut`]: 3D LUTs (`.cube` parser, HALD conversion, tetrahedral interpolation, the by-id store; plan 18).
//! - [`xmp`]: Lightroom `crs:` import (sidecars and embedded packets), our `photobook:` packet, lossy `crs:` export (D6.3).
//! - `ai` (feature `ai`, default on): ONNX Runtime sessions, the pinned model registry and the downloader (D4.2).

#[cfg(feature = "ai")]
pub mod ai;
pub mod canonical;
pub mod color;
pub mod cpu;
pub mod decode;
mod error;
// Workflow plan 11: export resize, output sharpening and JPEG/PNG/WebP encode.
pub mod export;
pub mod geometry;
pub mod gpu;
pub mod image;
mod jpeg_markers;
pub mod local;
// Workflow plan 18: 3D LUTs (`.cube`, HALD) and the store the render reads them from.
pub mod lut;
// Workflow plan 22: Match camera JPEG, a 3D LUT fitted from RAW + camera JPEG pairs.
pub mod lutfit;
pub mod masks;
pub mod ops;
// Plan 53: focus peak and zebra, view-only preview modes outside the develop hash.
pub mod preview_modes;
pub mod render;
pub mod settings;
pub mod stats;
pub mod xmp;

pub use canonical::canonical_json;
pub use color::OutputProfile;
pub use cpu::{Developer, RenderOptions};
pub use decode::decode_file;
pub use error::{Error, Result};
pub use geometry::{developed_size, GeometryPlan, Quality};
pub use gpu::RenderBackend;
pub use image::{ImageMeta, LinearImage, Rgb8Image};
pub use preview_modes::{
    apply_preview_mode, apply_preview_mode_cpu, apply_preview_modes, apply_preview_modes_cpu, PreviewMode,
};
pub use render::{
    copy_exif, encode_jpeg, render_full, render_full_with, render_full_with_options, render_preview, render_preview_image_with,
    render_preview_with,
};
pub use render::{display_p3_icc, encode_jpeg_as, srgb_icc};
pub use settings::DevelopSettings;

use sha2::{Digest, Sha256};

/// Engine version mixed into [`develop_hash`]; bump when the render maths changes so cached renders are
/// invalidated. Must equal `DEVELOP_ENGINE_VERSION` in `packages/shared/src/develop/schema.ts`.
///
/// `develop-engine/3` (workflow plan 19): the one bump for the looks work (Effects, plan 17; the 3D LUT, plan 18;
/// their GPU port, plan 19). Settings without effects or a LUT render exactly as under `/2`.
///
/// `develop-engine/4` (plan 55): the grading wheels' luminance offsets and the Global wheel. Settings without them
/// render byte-identical to `/3` on the CPU and the GPU (`tests/engine_bump.rs` on the ON1 samples).
pub const ENGINE_VERSION: &str = "develop-engine/4";

/// The exact string [`develop_hash`] hashes: the canonical JSON of every field (defaults included), a
/// newline and [`ENGINE_VERSION`]. Equal to `developHashInput` in TS.
pub fn develop_hash_input(settings: &DevelopSettings) -> String {
    let value = serde_json::to_value(settings).expect("develop settings always serialise");
    format!("{}\n{}", canonical_json(&value), ENGINE_VERSION)
}

/// SHA-256 hex of [`develop_hash_input`]: the key for cached renders (`proxy-<developHash>.jpg`). Equal to
/// `developHash` in TS.
pub fn develop_hash(settings: &DevelopSettings) -> String {
    hex::encode(Sha256::digest(develop_hash_input(settings).as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_default() {
        let mut s = DevelopSettings::default();
        assert!(s.is_default());
        s.light.exposure = 0.5;
        assert!(!s.is_default());
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let s: DevelopSettings = serde_json::from_str(r#"{"version":1}"#).unwrap();
        assert_eq!(s, DevelopSettings::default());
        let s: DevelopSettings = serde_json::from_str(r#"{"version":1,"light":{"exposure":1}}"#).unwrap();
        assert_eq!(s.light.exposure, 1.0);
        assert_eq!(s.detail.sharpen.amount, 40.0);
    }

    #[test]
    fn rejects_bad_rotation() {
        let r: Result<DevelopSettings, _> = serde_json::from_str(r#"{"version":1,"geometry":{"rotate":45}}"#);
        assert!(r.is_err());
    }

    #[test]
    fn hash_is_hex_and_changes() {
        let a = develop_hash(&DevelopSettings::default());
        assert_eq!(a.len(), 64);
        let mut s = DevelopSettings::default();
        s.geometry.flip_h = true;
        assert_ne!(develop_hash(&s), a);
    }
}
