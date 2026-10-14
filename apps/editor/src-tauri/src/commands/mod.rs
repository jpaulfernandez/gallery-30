//! Tauri commands, one module per area. Register new commands in `lib.rs`.

pub mod ai;
pub mod assets;
pub mod collections;
pub mod develop;
pub mod export;
pub mod folders;
// Plan 46: the haptic tick on the Force Touch trackpad.
pub mod haptic;
pub mod library;
pub mod luts;
pub mod models;
pub mod noise;
// Plan 42: the reject pile's Trash (`trash_photos`).
pub mod photos;
pub mod presets;
pub mod print;
// Workflow plan 16: process groups for the CLI and FFmpeg children (kill the whole tree).
pub mod process;
pub mod projects;
pub mod publish;
// Workflow plan 36: the dev-only raw RGBA preview scheme (`pbraw`), the platform-budgets experiment.
#[cfg(debug_assertions)]
pub mod raw_preview;
pub mod social;
// Workflow plan 16: Settings → Tools (FFmpeg download) and slideshow video.
pub mod tools;
pub mod video;
pub mod xmp;
