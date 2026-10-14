//! Develop renders (step D1.3): the Tauri side of `crates/develop`.
//!
//! - `render_develop_preview` renders the open photo's 1600 px proxy with the given settings and returns the
//!   JPEG bytes (empty when a newer preview job superseded it). The decoded proxy of the current photo is kept
//!   in [`DevelopJobs`] so a slider tick costs one render pass.
//! - `render_develop_cached` writes `<appdata>/cache/<hash>/{proxy,thumb}-<developHash>.jpg` plus
//!   `develop-<developHash>.json` (`{ developHash, width, height, engine }`) and returns their paths; existing
//!   files are returned without rendering. Only the two most recently used develop hashes of a photo are kept.
//! - `render_develop_full` renders each item at full resolution into
//!   `<folder>/.photobook-cache/develop/<hash>-<developHash>.jpg` (quality 95, source Exif copied), reporting
//!   each item on `develop:progress`; `cancel_develop` stops a batch between items and drops the item in flight
//!   before it is written (a render is written whole, to a temp name renamed at the end, or not at all).
//! - `develop_renders_present` and `prune_develop_renders` (step D1.5) tell which of those files exist and
//!   delete the stale ones after a publish.
//!
//! Sources are decoded with `photobook_develop::decode_file`; HEIC, CMYK and other JPEGs it cannot read are
//! converted once with `sips` into `<appdata>/cache/<hash>/source.jpg`, like `prepare_asset` does.
//!
//! Camera RAW (step D6.1): the working image is always decoded from the RAW (`decode_file`, about 0.2 to 1.3 s;
//! the cached proxy is the camera's JPEG, not the RAW's data), and every render uses
//! `RenderOptions::for_image`, so the display look is on for RAW. Full renders of a RAW carry no Exif (it is
//! copied from JPEG sources only).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use photobook_develop::{
    apply_preview_modes, copy_exif, decode_file, develop_hash, encode_jpeg, encode_jpeg_as, render_full_with_options,
    render_preview_image_with, render_preview_with, DevelopSettings, Developer, LinearImage, OutputProfile, PreviewMode,
    Quality, RenderOptions, Rgb8Image, ENGINE_VERSION,
};
use photobook_develop::ai::denoise::{self, DenoiseOptions, DenoiseSessions};
use photobook_develop::ai::{self, ModelDir};
use photobook_develop::settings::Denoise;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Semaphore;

use crate::commands::assets::{
    cache_entry_dir, cache_root, fit, icc_segments, kind_of, resize, resolve_rel, sips_to_jpeg, source_root,
    write_atomic, Kind, Pixels, PROXY_EDGE, PROXY_FILE, SOURCE_CACHE_DIR, THUMB_EDGE,
};
use crate::error::{Error, IoContext, Result};
use crate::scope::ensure_allowed;

const PREVIEW_QUALITY: u8 = 85;
const CACHED_PROXY_QUALITY: u8 = 85;
const CACHED_THUMB_QUALITY: u8 = 82;
const FULL_QUALITY: u8 = 95;
/// Develop hashes kept per photo in the app cache (the newest plus two for undo and redo). Equals `KEEP_DEVELOPED`
/// in `apps/editor/src/store/assets.ts`, which remembers that many renders per file.
const KEEP_DEVELOPED: usize = 3;
/// Concurrent renders (each one already uses every core through rayon).
const MAX_RENDERS: usize = 2;
/// Denoise intermediates kept per photo (content hash): the one just made and the most recent others, for versions of
/// the photo with other denoise settings.
const KEEP_DENOISE_KEYS: usize = 3;
/// Cancel requests remembered at once. A request for a batch that is already over (or never started) is never
/// consumed, so the set is bounded: the oldest (lowest, ids only grow) are dropped first.
const MAX_CANCELLED: usize = 64;
/// The error of a full render item that a cancel stopped (`renderBeforePublish` and the job queue match on it).
pub(crate) const CANCELLED: &str = "Cancelled";

/// Cancel requests for jobs that have not registered yet (the request beat the command's start), consumed when the job
/// starts. Bounded like [`DevelopJobs`]'s set: a request for a job that never starts is dropped, oldest first.
#[derive(Default)]
pub(crate) struct PendingCancels(Mutex<HashSet<u64>>);

impl PendingCancels {
    /// Remember a cancel of `job`, which is not running yet.
    pub(crate) fn remember(&self, job: u64) {
        let mut pending = self.0.lock().expect("cancel lock poisoned");
        pending.insert(job);
        while pending.len() > MAX_CANCELLED {
            let Some(oldest) = pending.iter().min().copied() else { break };
            pending.remove(&oldest);
        }
    }

    /// Whether `job` was cancelled before it started (consumes the request).
    pub(crate) fn take(&self, job: u64) -> bool {
        self.0.lock().expect("cancel lock poisoned").remove(&job)
    }
}
const DEVELOP_DIR: &str = "develop";
/// Signature of a JPEG APP2 ICC profile chunk.
const ICC_MARKER: &[u8] = b"ICC_PROFILE\0";

pub const EVENT_PROGRESS: &str = "develop:progress";

/// What `render_develop_cached` returns (and stores as `develop-<developHash>.json`, minus the paths).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevelopRenderMeta {
    pub develop_hash: String,
    /// Pixel size of the rendered proxy.
    pub width: u32,
    pub height: u32,
    pub thumb_path: String,
    pub proxy_path: String,
    /// `true` when `settings.detail.denoise` is set but its intermediate does not exist yet, so the render used the
    /// source (step D5.1); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denoise_stale: Option<bool>,
    /// `true` when the look's LUT file is missing, so the render left it out (workflow plan 18); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lut_missing: Option<bool>,
}

/// `develop-<developHash>.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CachedMeta {
    develop_hash: String,
    width: u32,
    height: u32,
    engine: String,
    /// The denoise intermediate key the render was decoded from (step D5.1); absent when it came from the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    denoise: Option<String>,
    /// The id of the look's LUT when its file was missing, so the render left it out (plan 18): the render is redone
    /// once the file is back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    missing_lut: Option<String>,
    /// The noise σ the chroma filter / mask noise used (workflow plan 24), when the settings run it: a render made
    /// with another σ (the default after a failed measurement, or before `noise.json` changed) is redone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    noise_sigma: Option<f32>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FullItem {
    pub asset_id: String,
    pub rel_path: String,
    pub hash: String,
    pub settings: DevelopSettings,
}

/// One entry of `render_develop_full`'s summary.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FullResult {
    pub asset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job: u64,
    asset_id: &'a str,
    done: usize,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

/// The decoded proxy of the photo being developed.
struct Current {
    hash: String,
    /// What it was decoded from (the source, or a denoise intermediate).
    input: Input,
    developer: Arc<Developer>,
}

/// Shared state for the develop commands.
pub struct DevelopJobs {
    /// One photo's decoded proxy (about 30 MB at 1600 px); replaced when another photo is rendered.
    current: Mutex<Option<Current>>,
    /// Highest preview job seen; an older job returns empty bytes instead of rendering.
    preview_job: AtomicU64,
    /// `render_develop_full` jobs asked to stop.
    cancelled: Mutex<HashSet<u64>>,
    renders: Arc<Semaphore>,
}

impl Default for DevelopJobs {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
            preview_job: AtomicU64::new(0),
            cancelled: Mutex::new(HashSet::new()),
            renders: Arc::new(Semaphore::new(MAX_RENDERS)),
        }
    }
}

impl DevelopJobs {
    fn is_stale(&self, job: u64) -> bool {
        self.preview_job.load(Ordering::SeqCst) != job
    }

    /// The cached proxy of `hash` if it was decoded from `want` (from anything when `None`).
    fn cached_developer(&self, hash: &str, want: Option<&Input>) -> Option<Arc<Developer>> {
        let current = self.current.lock().expect("develop lock poisoned");
        current
            .as_ref()
            .filter(|c| c.hash == hash && want.map_or(true, |w| *w == c.input))
            .map(|c| c.developer.clone())
    }

    /// The decoded proxy for `hash`, decoding it when it is not the current one. `keep` makes it the current
    /// one; otherwise it is kept only when nothing is cached yet (so a cached render for another photo never
    /// evicts the photo being edited). Takes the cached proxy whatever it was decoded from (geometry analysis and
    /// mask overlays do not depend on denoise); a fresh decode reads the source.
    fn developer(&self, hash: &str, entry_dir: &Path, src: &Path, keep: bool) -> Result<(Arc<Developer>, bool)> {
        self.developer_with(hash, entry_dir, src, keep, None)
    }

    /// [`Self::developer`] decoded from `want` ([`choose_input`]: the source or the denoise intermediate); `None`
    /// takes any cached input. A proxy of the same photo from another input is replaced.
    fn developer_with(
        &self,
        hash: &str,
        entry_dir: &Path,
        src: &Path,
        keep: bool,
        want: Option<&Input>,
    ) -> Result<(Arc<Developer>, bool)> {
        if let Some(developer) = self.cached_developer(hash, want) {
            return Ok((developer, false));
        }
        let input = want.cloned().unwrap_or(Input::Source);
        let developer = Arc::new(Developer::new(decode_input(entry_dir, src, &input)?));
        attach_ai_rasters(&developer, entry_dir);
        let mut current = self.current.lock().expect("develop lock poisoned");
        if keep || current.as_ref().map_or(true, |c| c.hash == hash) {
            *current = Some(Current { hash: hash.to_string(), input, developer: developer.clone() });
        }
        Ok((developer, true))
    }

    /// [`Self::developer_with`] for a render of `settings`: when they run the chroma filter or a mask's noise (workflow
    /// plan 24) and the proxy was decoded before the photo's noise was measured, measure it (`noise.json`) and decode
    /// again, so the filter keys on the photo's σ and not the default.
    fn developer_for(
        &self,
        hash: &str,
        entry_dir: &Path,
        src: &Path,
        keep: bool,
        want: &Input,
        settings: &DevelopSettings,
    ) -> Result<(Arc<Developer>, bool)> {
        let (developer, decoded) = self.developer_with(hash, entry_dir, src, keep, Some(want))?;
        if !needs_noise_sigma(settings) {
            return Ok((developer, decoded));
        }
        let current = crate::commands::noise::read_record(entry_dir).map(|r| crate::commands::noise::filter_sigma(&r));
        if current.is_some() && developer.image().meta.noise_sigma == current {
            return Ok((developer, decoded));
        }
        // Not measured yet, or `noise.json` changed since this proxy was decoded (a new `PROFILE_ENGINE`).
        if current.is_none() {
            if let Err(err) = crate::commands::noise::ensure_record(src, entry_dir) {
                log::warn!("[photobook:develop] noise measurement failed, the chroma filter uses the default σ: {err}");
                return Ok((developer, decoded));
            }
        }
        self.invalidate(hash);
        self.developer_with(hash, entry_dir, src, keep, Some(want))
    }

    /// Forget the cached proxy of `hash` (its denoise intermediate changed).
    fn invalidate(&self, hash: &str) {
        let mut current = self.current.lock().expect("develop lock poisoned");
        if current.as_ref().is_some_and(|c| c.hash == hash) {
            *current = None;
        }
    }

    pub(crate) fn take_cancel(&self, job: u64) -> bool {
        self.cancelled.lock().expect("develop lock poisoned").remove(&job)
    }

    /// `job` was asked to stop (without consuming the request: the batch loop takes it before the next item).
    pub(crate) fn cancel_requested(&self, job: u64) -> bool {
        self.cancelled.lock().expect("develop lock poisoned").contains(&job)
    }

    /// Ask the full-render batch `job` to stop before its next item.
    fn cancel(&self, job: u64) {
        let mut cancelled = self.cancelled.lock().expect("develop lock poisoned");
        cancelled.insert(job);
        while cancelled.len() > MAX_CANCELLED {
            let Some(oldest) = cancelled.iter().min().copied() else { break };
            cancelled.remove(&oldest);
        }
    }
}

pub(crate) async fn render_permit<R: Runtime>(app: &AppHandle<R>) -> Result<tokio::sync::OwnedSemaphorePermit> {
    app.state::<DevelopJobs>().renders.clone().acquire_owned().await.map_err(|err| Error::Invalid(err.to_string()))
}

fn ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

// ---------------------------------------------------------------------------------------------
// Commands

/// JPEG bytes of the photo's proxy developed with `settings` (long edge at most `long_edge`, default 1600), or
/// empty bytes when a newer `job` arrived first. Job ids must increase. `output_profile` (`"srgb"`, the default, or
/// `"display-p3"`) is the space the preview is rendered in and tagged with: the book's, or the other one to proof.
/// `modes` (plan 53: `"focus-peak"`, `"zebra"`) draw those view-only overlays over the developed pixels (focus peak
/// first, whatever the order given); they are not settings, so they never reach the develop hash, a cached render or a
/// full render, and these bytes are never cached.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn render_develop_preview<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    job: u64,
    long_edge: Option<u32>,
    output_profile: Option<String>,
    modes: Option<Vec<String>>,
) -> Result<Response> {
    let output = parse_output_profile(output_profile.as_deref())?;
    let modes = parse_preview_modes(modes.as_deref().unwrap_or_default())?;
    let jobs = app.state::<DevelopJobs>();
    jobs.preview_job.fetch_max(job, Ordering::SeqCst);
    if jobs.is_stale(job) {
        return Ok(Response::new(Vec::new()));
    }
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let permit = render_permit(&app).await?;
    if app.state::<DevelopJobs>().is_stale(job) {
        return Ok(Response::new(Vec::new()));
    }
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        preview_bytes(&app2.state::<DevelopJobs>(), &hash, &entry_dir, &src, &settings, job, long_edge, output, &modes)
    })
    .await??;
    Ok(Response::new(bytes))
}

/// The preview render behind `render_develop_preview`; empty bytes when `job` went stale (checked after the
/// decode and again before encoding). `modes` are drawn over the developed pixels, in order, before the encode.
#[allow(clippy::too_many_arguments)]
fn preview_bytes(
    jobs: &DevelopJobs,
    hash: &str,
    entry_dir: &Path,
    src: &Path,
    settings: &DevelopSettings,
    job: u64,
    long_edge: Option<u32>,
    output: OutputProfile,
    modes: &[PreviewMode],
) -> Result<Vec<u8>> {
    let start = Instant::now();
    let input = choose_input(entry_dir, settings).input;
    let (developer, _) = jobs.developer_for(hash, entry_dir, src, true, &input, settings)?;
    let decode = ms(start);
    if jobs.is_stale(job) {
        return Ok(Vec::new());
    }
    let start = Instant::now();
    let (w, h) = developer.size();
    if let Some(edge) = long_edge.filter(|&e| e > 0 && e < w.max(h)) {
        // Smaller than the cached proxy: rare (the UI uses the proxy size); resize in linear light, then develop.
        let options = render_options(developer.image(), output);
        let bytes = if modes.is_empty() {
            photobook_develop::masks::ai_cache::with_ai_source(developer.ai_rasters(), || {
                render_preview_with(developer.image(), settings, edge, PREVIEW_QUALITY, &options)
            })?
        } else {
            let plain = photobook_develop::masks::ai_cache::with_ai_source(developer.ai_rasters(), || {
                render_preview_image_with(developer.image(), settings, edge, &options)
            })?;
            encode_jpeg_as(&with_modes(plain, modes, &options), PREVIEW_QUALITY, output)?
        };
        log::info!("[photobook:develop] preview job={job} decode={decode}ms render+encode={}ms", ms(start));
        return Ok(bytes);
    }
    let rendered = render_developer(&developer, settings, output);
    let rendered = with_modes(rendered, modes, &render_options(developer.image(), output));
    let render = ms(start);
    if jobs.is_stale(job) {
        return Ok(Vec::new());
    }
    let start = Instant::now();
    let bytes = encode_jpeg_as(&rendered, PREVIEW_QUALITY, output)?;
    log::info!("[photobook:develop] preview job={job} decode={decode}ms render={render}ms encode={}ms", ms(start));
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Workflow plan 36 (platform budgets): the raw preview experiment. Debug builds only, behind the webview's
// `photobook.rawPreview` flag (`commands/raw_preview.rs` serves it over the `pbraw` scheme); the JPEG path above is
// unchanged.

/// One live preview frame as packed RGBA8 (the proxy developed exactly like `render_develop_preview`, no encode).
#[cfg(debug_assertions)]
pub(crate) struct RawPreviewFrame {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, alpha 255.
    pub rgba: Vec<u8>,
    pub render_ms: u128,
    /// RGB → RGBA expansion (what replaces the JPEG encode).
    pub pack_ms: u128,
}

/// [`render_develop_preview`] without the JPEG: the same scope checks, job ordering, render permit and cached proxy,
/// returning raw RGBA. `None` when a newer job arrived first.
#[cfg(debug_assertions)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn raw_preview_frame<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    job: u64,
    output_profile: Option<String>,
) -> Result<Option<RawPreviewFrame>> {
    let output = parse_output_profile(output_profile.as_deref())?;
    let jobs = app.state::<DevelopJobs>();
    jobs.preview_job.fetch_max(job, Ordering::SeqCst);
    if jobs.is_stale(job) {
        return Ok(None);
    }
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let permit = render_permit(&app).await?;
    if app.state::<DevelopJobs>().is_stale(job) {
        return Ok(None);
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<RawPreviewFrame>> {
        let _permit = permit;
        let jobs = app2.state::<DevelopJobs>();
        let input = choose_input(&entry_dir, &settings).input;
        let (developer, _) = jobs.developer_for(&hash, &entry_dir, &src, true, &input, &settings)?;
        if jobs.is_stale(job) {
            return Ok(None);
        }
        let start = Instant::now();
        let rendered = render_developer(&developer, &settings, output);
        let render_ms = ms(start);
        if jobs.is_stale(job) {
            return Ok(None);
        }
        let start = Instant::now();
        let mut rgba = Vec::with_capacity(rendered.data.len() / 3 * 4);
        for px in rendered.data.chunks_exact(3) {
            rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
        let pack_ms = ms(start);
        log::info!("[photobook:develop] raw preview job={job} render={render_ms}ms pack={pack_ms}ms");
        Ok(Some(RawPreviewFrame { width: rendered.width, height: rendered.height, rgba, render_ms, pack_ms }))
    })
    .await?
}

/// The sharpening mask of the photo's proxy as a greyscale JPEG (white = sharpened) for the Alt-drag view on the
/// Sharpening sliders. Same decode source and cached `Developer` as `render_develop_preview`; the picture has
/// the size of the developed render. Only `settings.detail.sharpen` radius and masking (and the geometry) matter.
#[tauri::command]
pub async fn develop_sharpen_mask<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
) -> Result<Response> {
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let permit = render_permit(&app).await?;
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let start = Instant::now();
        let input = choose_input(&entry_dir, &settings).input;
        let (developer, _) = app2.state::<DevelopJobs>().developer_with(&hash, &entry_dir, &src, true, Some(&input))?;
        let (w, h, plane) = developer.sharpen_mask(&settings);
        let mut data = Vec::with_capacity(plane.len() * 3);
        for v in &plane {
            let g = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            data.extend_from_slice(&[g, g, g]);
        }
        let bytes = encode_jpeg(&Rgb8Image::new(w, h, data), PREVIEW_QUALITY)?;
        log::info!("[photobook:develop] sharpen mask {w}x{h} in {}ms", ms(start));
        Ok::<_, Error>(bytes)
    })
    .await??;
    Ok(Response::new(bytes))
}

/// Make sure `proxy-<developHash>.jpg` and `thumb-<developHash>.jpg` exist for `settings` in the photo's
/// cache folder and return their paths and the rendered size. Already rendered hashes return at once.
/// With `output_profile` `"display-p3"` (the book's output profile; `"srgb"` when omitted) the files are rendered in
/// and tagged with Display P3 and named `...-<developHash>-p3.jpg` ([`OutputProfile::file_suffix`]).
/// Photos with identical bytes share the cache folder, so `keep` names the develop hashes other photos still
/// use there: pruning leaves them (and the render just written) alone.
#[tauri::command]
pub async fn render_develop_cached<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    keep: Option<Vec<String>>,
    output_profile: Option<String>,
) -> Result<DevelopRenderMeta> {
    let output = parse_output_profile(output_profile.as_deref())?;
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let develop_hash = develop_hash(&settings);
    let choice = choose_input(&entry_dir, &settings);
    if let Some(meta) = cached_render_checked(&entry_dir, &develop_hash, output, &choice, &settings) {
        log::info!("[photobook:develop] cached hit {develop_hash} ({rel_path})");
        return Ok(meta);
    }
    let permit = render_permit(&app).await?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        // Another call may have written it while this one waited for a permit.
        if let Some(meta) = cached_render_checked(&entry_dir, &develop_hash, output, &choice, &settings) {
            return Ok(meta);
        }
        let start = Instant::now();
        let (developer, decoded) =
            app2.state::<DevelopJobs>().developer_for(&hash, &entry_dir, &src, false, &choice.input, &settings)?;
        let decode = ms(start);
        let start = Instant::now();
        let meta = write_cached(&entry_dir, &developer, &settings, &develop_hash, output, &choice.input)?;
        prune_developed(&entry_dir, KEEP_DEVELOPED, &keep.unwrap_or_default());
        log::info!(
            "[photobook:develop] cached render {develop_hash} ({rel_path}) {}x{} decode={decode}ms{} render+write={}ms",
            meta.width,
            meta.height,
            if decoded { "" } else { " (reused)" },
            ms(start)
        );
        Ok(DevelopRenderMeta { denoise_stale: choice.stale.then_some(true), ..meta })
    })
    .await?
}

/// Render each item at full resolution into `<folder>/.photobook-cache/develop/<hash>-<developHash>.jpg`,
/// skipping existing files. Emits `develop:progress` `{ job, assetId, done, total, path?, error? }` after each
/// item; a failed item does not stop the batch. `cancel_develop(job)` stops the item in flight before it is written
/// (it reports the error `Cancelled`) and the rest before they start (reported as cancelled in the summary only). `output_profile` (the book's; `"srgb"` when omitted) is the space
/// every item is rendered in and tagged with; Display P3 renders are named `<hash>-<developHash>-p3.jpg`.
#[tauri::command]
pub async fn render_develop_full<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    items: Vec<FullItem>,
    job: u64,
    output_profile: Option<String>,
) -> Result<Vec<FullResult>> {
    let output = parse_output_profile(output_profile.as_deref())?;
    let root = source_root(&app, &folder)?;
    let out_dir = ensure_allowed(&app, root.join(SOURCE_CACHE_DIR).join(DEVELOP_DIR))?;
    let cache = cache_root(&app)?;
    let total = items.len();
    let mut results = Vec::with_capacity(total);
    let mut cancelled = false;
    for (i, item) in items.into_iter().enumerate() {
        if cancelled || app.state::<DevelopJobs>().take_cancel(job) {
            cancelled = true;
            results.push(FullResult { asset_id: item.asset_id, path: None, error: Some("Cancelled".into()) });
            continue;
        }
        let start = Instant::now();
        let outcome = render_full_item(&app, &root, &cache, &out_dir, &item, output, job).await;
        let (path, error) = match outcome {
            Ok(path) => (Some(path.to_string_lossy().into_owned()), None),
            Err(err) => (None, Some(err.to_string())),
        };
        log::info!(
            "[photobook:develop] full job={job} {}/{total} {} {}ms {}",
            i + 1,
            item.rel_path,
            ms(start),
            error.as_deref().unwrap_or("ok")
        );
        let _ = app.emit(
            EVENT_PROGRESS,
            ProgressEvent {
                job,
                asset_id: &item.asset_id,
                done: i + 1,
                total,
                path: path.as_deref(),
                error: error.as_deref(),
            },
        );
        results.push(FullResult { asset_id: item.asset_id, path, error });
    }
    // A cancel that came in during the last item (or after the batch) has nothing left to stop.
    app.state::<DevelopJobs>().take_cancel(job);
    Ok(results)
}

/// Stop the `render_develop_full` batch `job`: the item in flight is dropped before it is written, the rest never start.
#[tauri::command]
pub async fn cancel_develop<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<DevelopJobs>().cancel(job);
    Ok(())
}

/// Which of `names` (`<hash>-<developHash>.jpg`) already exist in `<folder>/.photobook-cache/develop/`, in
/// the order given. The publish flow renders only what is missing.
#[tauri::command]
pub async fn develop_renders_present<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    names: Vec<String>,
) -> Result<Vec<String>> {
    if let Some(bad) = names.iter().find(|n| !is_render_name(n)) {
        return Err(Error::Invalid(format!("not a develop render name: {bad}")));
    }
    let dir = develop_out_dir(&app, &folder)?;
    Ok(present_renders(&dir, &names))
}

/// Delete the files in `<folder>/.photobook-cache/develop/` that are not in `keep` (the current
/// `<hash>-<developHash>[-p3].jpg` names of the book), so an edit does not leave its old full-size render behind.
/// Only files named like a render are touched, and with `hashes` only those of these photos (content hashes): the
/// folder's cache is shared by every project on it, so a project prunes its own photos' renders only. Returns how
/// many were deleted.
#[tauri::command]
pub async fn prune_develop_renders<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    keep: Vec<String>,
    hashes: Option<Vec<String>>,
) -> Result<usize> {
    let dir = develop_out_dir(&app, &folder)?;
    let removed = prune_renders(&dir, &keep, hashes.as_deref());
    log::info!("[photobook:develop] pruned {removed} stale full render(s), kept {}", keep.len());
    Ok(removed)
}

fn develop_out_dir<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf> {
    let root = source_root(app, folder)?;
    ensure_allowed(app, root.join(SOURCE_CACHE_DIR).join(DEVELOP_DIR))
}

async fn render_full_item<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    cache: &Path,
    out_dir: &Path,
    item: &FullItem,
    output: OutputProfile,
    job: u64,
) -> Result<PathBuf> {
    let src = resolve_rel(app, root, &item.rel_path)?;
    let entry_dir = ensure_allowed(app, cache_entry_dir(cache, &item.hash)?)?;
    let out = full_render_path(out_dir, &item.hash, &develop_hash(&item.settings), output);
    if out.is_file() {
        return Ok(out);
    }
    let missing = missing_ai_rasters(&entry_dir, &item.settings);
    if missing > 0 {
        return Err(Error::Invalid(format!(
            "{missing} AI mask component(s) have no mask on this computer yet; open the photo in Develop and regenerate them"
        )));
    }
    let permit = render_permit(app).await?;
    let out_dir = out_dir.to_path_buf();
    let settings = item.settings.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if out.is_file() {
            return Ok(out);
        }
        let cancelled = || app.state::<DevelopJobs>().cancel_requested(job);
        if cancelled() {
            return Err(Error::Invalid(CANCELLED.into()));
        }
        fs::create_dir_all(&out_dir).ctx(format!("creating {}", out_dir.display()))?;
        render_full_file(&src, &entry_dir, &out, &settings, output, &cancelled)?;
        Ok(out)
    })
    .await?
}

// ---------------------------------------------------------------------------------------------
// Decode, render, cache files (no Tauri state: unit-tested below)

/// Decode `src` to linear light. HEIC goes through ImageIO first ([`decode_file`], D6.2: the file's own colour and
/// bit depth); it, and the JPEGs libjpeg-turbo cannot read, fall back to a `sips` JPEG (in `entry_dir`) when the
/// decoder is unavailable (`Unsupported`) or fails. Returns the image and the file the Exif for a full render
/// comes from, if any: the JPEG itself, the HEIC (its Exif item is read by `copy_exif`) or the `sips` JPEG.
pub(crate) fn decode_source(src: &Path, entry_dir: &Path, max_long_edge: Option<u32>) -> Result<(LinearImage, Option<PathBuf>)> {
    let kind = kind_of(src);
    match decode_file(src, max_long_edge) {
        Ok(image) => Ok((image, matches!(kind, Some(Kind::Jpeg | Kind::Heic)).then(|| src.to_path_buf()))),
        Err(err) if !matches!(kind, Some(Kind::Jpeg | Kind::Heic)) => Err(err.into()),
        Err(err) => {
            fs::create_dir_all(entry_dir).ctx(format!("creating {}", entry_dir.display()))?;
            let converted = sips_to_jpeg(src, entry_dir).map_err(|sips_err| match err {
                // No HEIC decoder in this build: the `sips` failure is the useful one.
                photobook_develop::Error::Unsupported(_) if kind == Some(Kind::Heic) => sips_err,
                err => Error::from(err),
            })?;
            Ok((decode_file(&converted, max_long_edge)?, Some(converted)))
        }
    }
}

/// Render the cached working image with the default options for its source ([`RenderOptions::for_image`]:
/// the display look on for RAW) in the `output` colour space.
fn render_developer(developer: &Developer, settings: &DevelopSettings, output: OutputProfile) -> Rgb8Image {
    developer.render_with(settings, &render_options(developer.image(), output))
}

/// [`RenderOptions::for_image`] rendering into `output`.
fn render_options(image: &LinearImage, output: OutputProfile) -> RenderOptions {
    RenderOptions { output, ..RenderOptions::for_image(&image.meta) }
}

/// The `output_profile` argument of the render commands (`Book.outputProfile`): sRGB when omitted.
fn parse_output_profile(value: Option<&str>) -> Result<OutputProfile> {
    match value {
        None => Ok(OutputProfile::Srgb),
        Some(v) => OutputProfile::parse(v).ok_or_else(|| Error::Invalid(format!("unknown output profile: {v}"))),
    }
}

/// The `modes` argument of `render_develop_preview` (plan 53), deduplicated, in drawing order: focus peak, then zebra
/// (both test the plain pixels; `apply_preview_modes`).
fn parse_preview_modes(values: &[String]) -> Result<Vec<PreviewMode>> {
    let mut modes = Vec::new();
    for v in values {
        modes.push(PreviewMode::parse(v).ok_or_else(|| Error::Invalid(format!("unknown preview mode: {v}")))?);
    }
    Ok([PreviewMode::FocusPeak, PreviewMode::Zebra].into_iter().filter(|m| modes.contains(m)).collect())
}

/// `image` with the preview `modes` drawn over it (none: unchanged), each tested on the plain pixels.
fn with_modes(image: Rgb8Image, modes: &[PreviewMode], options: &RenderOptions) -> Rgb8Image {
    if modes.is_empty() {
        return image;
    }
    apply_preview_modes(&image, modes, options)
}

/// The develop hash plus the output profile's file suffix: what cached and full render file names carry.
fn render_key(develop_hash: &str, output: OutputProfile) -> String {
    format!("{develop_hash}{}", output.file_suffix())
}

/// The 1600 px working image: the cached source proxy when `prepare_asset` made one and it stands in
/// faithfully for the source, else the source. A RAW is always decoded from the source (its proxy is the
/// camera's embedded JPEG or a developed render, never linear camera data): rawler decodes the whole sensor
/// first, about 0.2 to 1.3 s.
fn decode_proxy(entry_dir: &Path, src: &Path) -> Result<LinearImage> {
    if kind_of(src) == Some(Kind::Raw) {
        let start = Instant::now();
        let image = decode_file(src, Some(PROXY_EDGE))?;
        log::info!(
            "[photobook:develop] raw decode {} {}x{} in {}ms",
            src.file_name().unwrap_or_default().to_string_lossy(),
            image.width,
            image.height,
            ms(start)
        );
        return Ok(image);
    }
    let proxy = entry_dir.join(PROXY_FILE);
    if proxy.is_file() && proxy_is_faithful(src, &proxy) {
        if let Ok(image) = decode_file(&proxy, Some(PROXY_EDGE)) {
            return Ok(image);
        }
    }
    Ok(decode_source(src, entry_dir, Some(PROXY_EDGE))?.0)
}

/// Whether `proxy` (written by `prepare_asset`) decodes to the colours of the JPEG `src`: `prepare_asset` copies
/// the source's pixel values and its APP2 ICC segments, so the two carry the same profile (or none). A proxy
/// from before profiles were copied, a PNG (its iCCP is not carried over), a HEIC and a RAW are decoded from
/// the source instead, as the full render is, so the canvas and the published photo match.
fn proxy_is_faithful(src: &Path, proxy: &Path) -> bool {
    if kind_of(src) != Some(Kind::Jpeg) {
        return false;
    }
    let head = |path: &Path| -> Option<Vec<u8>> {
        // The ICC segments sit before the image data, after at most 64 KiB of Exif.
        let mut head = Vec::new();
        fs::File::open(path).and_then(|f| f.take(1 << 20).read_to_end(&mut head)).ok()?;
        Some(head)
    };
    match (head(src), head(proxy)) {
        (Some(s), Some(p)) => {
            let source_icc = icc_segments(&s);
            // A profile in the source but not found whole in its first MiB is never taken for "none".
            let truncated = source_icc.is_empty() && s.windows(ICC_MARKER.len()).any(|w| w == ICC_MARKER);
            !truncated && source_icc == icc_segments(&p)
        }
        _ => false,
    }
}

fn proxy_name(develop_hash: &str) -> String {
    format!("proxy-{develop_hash}.jpg")
}

fn thumb_name(develop_hash: &str) -> String {
    format!("thumb-{develop_hash}.jpg")
}

fn meta_name(develop_hash: &str) -> String {
    format!("develop-{develop_hash}.json")
}

/// `<folder>/.photobook-cache/develop/<hash>-<developHash>.jpg`, `...-p3.jpg` for Display P3 (equal to
/// `developRenderName` in `packages/shared`).
fn full_render_path(out_dir: &Path, hash: &str, develop_hash: &str, output: OutputProfile) -> PathBuf {
    out_dir.join(format!("{hash}-{}.jpg", render_key(develop_hash, output)))
}

/// `<hex64>-<hex64>.jpg` or `<hex64>-<hex64>-p3.jpg`: the name of a full-resolution render (asset hash, then
/// develop hash, both lowercase SHA-256 hex, then the Display P3 suffix), so pruning never touches a file merely
/// named like `cafe-face.jpg`.
fn is_render_name(name: &str) -> bool {
    let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let stem = name.strip_suffix(".jpg").map(|s| s.strip_suffix(OutputProfile::DisplayP3.file_suffix()).unwrap_or(s));
    stem.and_then(|stem| stem.split_once('-')).is_some_and(|(a, b)| hex(a) && hex(b))
}

fn present_renders(dir: &Path, names: &[String]) -> Vec<String> {
    names.iter().filter(|n| dir.join(n).is_file()).cloned().collect()
}

/// Remove render-named files in `dir` that are not in `keep`, and, with `only`, whose content hash (the part before
/// the first `-`) is one of `only`. Best effort; returns the number removed.
fn prune_renders(dir: &Path, keep: &[String], only: Option<&[String]>) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours = only.is_none_or(|hashes| {
            name.split_once('-').is_some_and(|(hash, _)| hashes.iter().any(|h| h == hash))
        });
        if is_render_name(&name) && ours && !keep.contains(&name) && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The develop hash a cache file name belongs to (`proxy-`, `thumb-`, `develop-` or `histogram-` + 64 hex digits,
/// then `-p3` for a Display P3 render: both profiles of one develop hash are pruned together).
fn develop_hash_of(name: &str) -> Option<&str> {
    let stem = name
        .strip_prefix("proxy-")
        .and_then(|s| s.strip_suffix(".jpg"))
        .or_else(|| name.strip_prefix("thumb-").and_then(|s| s.strip_suffix(".jpg")))
        .or_else(|| name.strip_prefix("develop-").and_then(|s| s.strip_suffix(".json")))
        // Plan 52: the histogram of a developed proxy goes with it.
        .or_else(|| name.strip_prefix("histogram-").and_then(|s| s.strip_suffix(".json")))?;
    let stem = stem.strip_suffix(OutputProfile::DisplayP3.file_suffix()).unwrap_or(stem);
    (stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit())).then_some(stem)
}

/// The meta of an existing render in `output` (proxy, thumb and meta all present). Marks it as recently used.
fn cached_render(entry_dir: &Path, develop_hash: &str, output: OutputProfile) -> Option<DevelopRenderMeta> {
    let key = render_key(develop_hash, output);
    let proxy = entry_dir.join(proxy_name(&key));
    let thumb = entry_dir.join(thumb_name(&key));
    let meta_path = entry_dir.join(meta_name(&key));
    if !(proxy.is_file() && thumb.is_file()) {
        return None;
    }
    let meta: CachedMeta = serde_json::from_slice(&fs::read(&meta_path).ok()?).ok()?;
    if meta.develop_hash != develop_hash {
        return None;
    }
    if meta.missing_lut.as_deref().is_some_and(photobook_develop::lut::present) {
        return None; // Rendered without its LUT, which is back.
    }
    // Pruning keeps the most recently used hashes; a hit counts as a use.
    let _ = fs::File::options().append(true).open(&meta_path).and_then(|f| f.set_modified(SystemTime::now()));
    Some(render_meta(&meta, &thumb, &proxy))
}

fn render_meta(meta: &CachedMeta, thumb: &Path, proxy: &Path) -> DevelopRenderMeta {
    DevelopRenderMeta {
        develop_hash: meta.develop_hash.clone(),
        width: meta.width,
        height: meta.height,
        thumb_path: thumb.to_string_lossy().into_owned(),
        proxy_path: proxy.to_string_lossy().into_owned(),
        denoise_stale: None,
        lut_missing: meta.missing_lut.as_ref().map(|_| true),
    }
}

/// Render the proxy with `settings` in `output` and write proxy, thumb and meta (meta last, so it marks a complete
/// set), named with [`render_key`]. `input` is what `developer` was decoded from (recorded in the meta).
fn write_cached(
    entry_dir: &Path,
    developer: &Developer,
    settings: &DevelopSettings,
    develop_hash: &str,
    output: OutputProfile,
    input: &Input,
) -> Result<DevelopRenderMeta> {
    fs::create_dir_all(entry_dir).ctx(format!("creating {}", entry_dir.display()))?;
    let missing_lut = photobook_develop::ops::lut::missing_lut(settings).map(|l| l.id.clone());
    let rendered = render_developer(developer, settings, output);
    let key = render_key(develop_hash, output);
    let proxy = entry_dir.join(proxy_name(&key));
    let thumb = entry_dir.join(thumb_name(&key));
    write_atomic(&proxy, &encode_jpeg_as(&rendered, CACHED_PROXY_QUALITY, output)?)?;
    write_atomic(&thumb, &encode_jpeg_as(&thumbnail(&rendered)?, CACHED_THUMB_QUALITY, output)?)?;
    let meta = CachedMeta {
        develop_hash: develop_hash.to_string(),
        width: rendered.width,
        height: rendered.height,
        engine: ENGINE_VERSION.to_string(),
        denoise: match input {
            Input::Source => None,
            Input::Denoised { key } => Some(key.clone()),
        },
        missing_lut,
        noise_sigma: if needs_noise_sigma(settings) { developer.image().meta.noise_sigma } else { None },
    };
    let json = serde_json::to_vec(&meta).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&entry_dir.join(meta_name(&key)), &json)?;
    Ok(render_meta(&meta, &thumb, &proxy))
}

/// 256 px long edge, Lanczos3 from the rendered proxy (as `prepare_asset` makes thumbs from its proxy).
fn thumbnail(rendered: &Rgb8Image) -> Result<Rgb8Image> {
    let size = fit(rendered.width, rendered.height, THUMB_EDGE);
    let pixels = Pixels { data: rendered.data.clone(), width: rendered.width, height: rendered.height, channels: 3 };
    let small = resize(&pixels, size)?;
    Ok(Rgb8Image::new(small.width, small.height, small.data))
}

/// Delete the cached develop files of all but the `keep` most recently used develop hashes in `entry_dir`
/// (recency: newest mtime among a hash's files), never those listed in `protected`. Best effort; errors are ignored.
fn prune_developed(entry_dir: &Path, keep: usize, protected: &[String]) {
    let Ok(entries) = fs::read_dir(entry_dir) else { return };
    let mut groups: Vec<(String, SystemTime, Vec<PathBuf>)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(hash) = develop_hash_of(&name) else { continue };
        let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        match groups.iter_mut().find(|g| g.0 == hash) {
            Some(group) => {
                group.1 = group.1.max(mtime);
                group.2.push(entry.path());
            }
            None => groups.push((hash.to_string(), mtime, vec![entry.path()])),
        }
    }
    groups.sort_by(|a, b| b.1.cmp(&a.1));
    for (hash, _, paths) in groups.into_iter().skip(keep) {
        if protected.contains(&hash) {
            continue;
        }
        for path in paths {
            let _ = fs::remove_file(path);
        }
    }
}

/// Full-resolution render of `src` to `out` in `output` (JPEG q95 tagged with its profile, with the source's Exif,
/// Orientation reset to 1). `cancelled` is asked after the decode and after the render: when it says yes nothing is
/// written and the error is `Cancelled`. The file is written to a temp name and renamed, so `out` is whole or absent.
fn render_full_file(
    src: &Path,
    entry_dir: &Path,
    out: &Path,
    settings: &DevelopSettings,
    output: OutputProfile,
    cancelled: &dyn Fn() -> bool,
) -> Result<()> {
    let FullImage { image: rendered, exif_source, decode_ms: decode, render_ms: render } =
        develop_full_image(src, entry_dir, settings, output, cancelled)?;
    let start = Instant::now();
    let mut bytes = encode_jpeg_as(&rendered, FULL_QUALITY, output)?;
    if let Some(exif_source) = exif_source {
        copy_exif(&exif_source, &mut bytes)?;
    }
    write_atomic(out, &bytes)?;
    log::info!(
        "[photobook:develop] full {}x{} decode={decode}ms render={render}ms encode+write={}ms",
        rendered.width,
        rendered.height,
        ms(start)
    );
    Ok(())
}

/// A full-resolution develop of one photo (what `develop_full_image` returns).
pub(crate) struct FullImage {
    pub image: Rgb8Image,
    /// The file the Exif comes from (the source JPEG or HEIC, or its `sips` copy), if any.
    pub exif_source: Option<PathBuf>,
    pub decode_ms: u128,
    pub render_ms: u128,
}

/// Decode `src` at full resolution (the denoise intermediate when current) and develop it in `output`: the pixels of a
/// full render, shared by [`render_full_file`] and the export (`commands/export.rs`, workflow plan 11). `cancelled` is
/// asked after the decode and after the render; when it says yes the error is `Cancelled`.
pub(crate) fn develop_full_image(
    src: &Path,
    entry_dir: &Path,
    settings: &DevelopSettings,
    output: OutputProfile,
    cancelled: &dyn Fn() -> bool,
) -> Result<FullImage> {
    // A full render (publish, export) without the look's LUT would be wrong under a name that says it has it.
    if let Some(lut) = photobook_develop::ops::lut::missing_lut(settings) {
        return Err(Error::Invalid(format!(
            "LUT missing: {}. Import it again from the Look section (Locate) or remove the LUT",
            lut.name
        )));
    }
    let start = Instant::now();
    let (image, exif_source) = decode_full_input(src, entry_dir, settings)?;
    let decode_ms = ms(start);
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let start = Instant::now();
    let quality = Quality::for_size(image.width, image.height);
    let rendered = photobook_develop::masks::ai_cache::with_ai_source(Some(ai_rasters_for(entry_dir)), || {
        render_full_with_options(&image, settings, quality, &render_options(&image, output))
    })?;
    drop(image);
    let render_ms = ms(start);
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    Ok(FullImage { image: rendered, exif_source, decode_ms, render_ms })
}

/// [`develop_full_image`] into 16 bits per channel (the export's TIFF and HEIC, workflow plan 12): the same input and
/// settings through `render_full16_with_options` (the CPU path). Returns the frame, the Exif source and the timings.
pub(crate) fn develop_full_image16(
    src: &Path,
    entry_dir: &Path,
    settings: &DevelopSettings,
    output: OutputProfile,
    cancelled: &dyn Fn() -> bool,
) -> Result<(photobook_develop::image::Rgb16Image, Option<PathBuf>, u128, u128)> {
    if let Some(lut) = photobook_develop::ops::lut::missing_lut(settings) {
        return Err(Error::Invalid(format!(
            "LUT missing: {}. Import it again from the Look section (Locate) or remove the LUT",
            lut.name
        )));
    }
    let start = Instant::now();
    let (image, exif_source) = decode_full_input(src, entry_dir, settings)?;
    let decode_ms = ms(start);
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let start = Instant::now();
    let quality = Quality::for_size(image.width, image.height);
    let rendered = photobook_develop::masks::ai_cache::with_ai_source(Some(ai_rasters_for(entry_dir)), || {
        photobook_develop::render::render_full16_with_options(&image, settings, quality, &render_options(&image, output))
    })?;
    drop(image);
    let render_ms = ms(start);
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    Ok((rendered, exif_source, decode_ms, render_ms))
}

/// [`render_full_file`] in sRGB, never cancelled (the export tests compare against it).
#[cfg(test)]
pub(crate) fn render_full_file_for_tests(src: &Path, entry_dir: &Path, out: &Path, settings: &DevelopSettings) {
    render_full_file(src, entry_dir, out, settings, OutputProfile::Srgb, &|| false).expect("full render");
}

/// Denoise is on for `settings` but the photo's intermediate is not ready, so a full render would use the source.
pub(crate) fn denoise_pending(entry_dir: &Path, settings: &DevelopSettings) -> bool {
    choose_input(entry_dir, settings).stale
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::assets::prepare;
    use std::time::Duration;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip").canonicalize().unwrap()
    }

    fn bright() -> DevelopSettings {
        serde_json::from_str(r#"{"version":1,"light":{"exposure":1}}"#).unwrap()
    }

    /// Mean 8-bit value over all channels (the editor builds `image` with PNG only, so decode with turbojpeg).
    fn mean(jpeg: &Path) -> f64 {
        let bytes = fs::read(jpeg).unwrap();
        let img: image::RgbImage = turbojpeg::decompress_image(&bytes).unwrap();
        img.as_raw().iter().map(|&v| v as f64).sum::<f64>() / img.as_raw().len() as f64
    }

    fn jpeg_size(path: &Path) -> (u32, u32) {
        let header = turbojpeg::read_header(&fs::read(path).unwrap()).unwrap();
        (header.width as u32, header.height as u32)
    }

    #[test]
    fn names_round_trip_and_reject_others() {
        let h = "ab".repeat(32);
        assert_eq!(develop_hash_of(&proxy_name(&h)), Some(h.as_str()));
        assert_eq!(develop_hash_of(&thumb_name(&h)), Some(h.as_str()));
        assert_eq!(develop_hash_of(&meta_name(&h)), Some(h.as_str()));
        assert_eq!(develop_hash_of("proxy.jpg"), None);
        assert_eq!(develop_hash_of("thumb.jpg"), None);
        assert_eq!(develop_hash_of("meta.json"), None);
        assert_eq!(develop_hash_of("source.jpg"), None);
        assert_eq!(develop_hash_of("proxy-abc.jpg"), None);
        assert_eq!(
            full_render_path(Path::new("/b/.photobook-cache/develop"), "aa", "bb", OutputProfile::Srgb),
            Path::new("/b/.photobook-cache/develop/aa-bb.jpg")
        );
        // Display P3 renders carry `-p3` and belong to the same develop hash.
        assert_eq!(
            full_render_path(Path::new("/b"), "aa", "bb", OutputProfile::DisplayP3),
            Path::new("/b/aa-bb-p3.jpg")
        );
        let p3 = render_key(&h, OutputProfile::DisplayP3);
        assert_eq!(develop_hash_of(&proxy_name(&p3)), Some(h.as_str()));
        assert_eq!(develop_hash_of(&meta_name(&p3)), Some(h.as_str()));
        assert_eq!(develop_hash_of(&format!("proxy-{h}-p4.jpg")), None);
        let full_p3 = format!("{}-{}-p3.jpg", "a1".repeat(32), "b2".repeat(32));
        assert!(is_render_name(&full_p3));
        assert!(!is_render_name(&full_p3.replace("-p3", "-p4")));
        assert_eq!(parse_output_profile(None).unwrap(), OutputProfile::Srgb);
        assert_eq!(parse_output_profile(Some("display-p3")).unwrap(), OutputProfile::DisplayP3);
        assert!(parse_output_profile(Some("adobe-rgb")).is_err());
    }

    #[test]
    fn prunes_only_stale_renders_and_reports_presence() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let current = format!("{}-{}.jpg", "a1".repeat(32), "b2".repeat(32));
        let stale = format!("{}-{}.jpg", "a1".repeat(32), "c3".repeat(32));
        let other_photo = format!("{}-{}.jpg", "d4".repeat(32), "e5".repeat(32));
        for name in [&current, &stale, &other_photo, &"notes.txt".to_string(), &"readme-render.jpg".to_string()] {
            fs::write(d.join(name), b"x").unwrap();
        }
        assert!(is_render_name(&current));
        assert!(!is_render_name("notes.txt"));
        assert!(!is_render_name("readme-render.jpg"));
        assert!(!is_render_name("../a-b.jpg"));
        // Short or uppercase hex is a user's file, not a render.
        assert!(!is_render_name("cafe-face.jpg"));
        assert!(!is_render_name(&current.to_uppercase().replace(".JPG", ".jpg")));
        let keep = vec![current.clone(), format!("{}-{}.jpg", "f6".repeat(32), "07".repeat(32))];
        assert_eq!(present_renders(d, &keep), vec![current.clone()]);
        assert_eq!(prune_renders(d, &keep, None), 2);
        let mut left: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, vec![current, "notes.txt".to_string(), "readme-render.jpg".to_string()]);
        // A missing folder is not an error.
        assert_eq!(prune_renders(&d.join("nope"), &keep, None), 0);
    }

    #[test]
    fn prunes_only_the_listed_photos_renders() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let ours = "a1".repeat(32);
        let theirs = "d4".repeat(32);
        let current = format!("{ours}-{}.jpg", "b2".repeat(32));
        let current_p3 = format!("{ours}-{}-p3.jpg", "b2".repeat(32));
        let stale = format!("{ours}-{}.jpg", "c3".repeat(32));
        // Another project on the folder: its photo, and its own (other profile) render of it.
        let other_project = format!("{theirs}-{}-p3.jpg", "e5".repeat(32));
        for name in [&current, &current_p3, &stale, &other_project] {
            fs::write(d.join(name), b"x").unwrap();
        }
        let keep = vec![current.clone(), current_p3.clone()];
        assert_eq!(prune_renders(d, &keep, Some(&[ours.clone()])), 1);
        let mut left: Vec<String> =
            fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        let mut want = vec![current, current_p3, other_project];
        want.sort();
        assert_eq!(left, want);
    }

    #[test]
    fn prune_keeps_the_most_recent_hashes_and_source_files() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        for f in ["thumb.jpg", "proxy.jpg", "meta.json", "source.jpg"] {
            fs::write(d.join(f), b"x").unwrap();
        }
        let hashes: Vec<String> = ["a", "b", "c"].iter().map(|c| c.repeat(64)).collect();
        let base = SystemTime::now() - Duration::from_secs(100);
        for (i, h) in hashes.iter().enumerate() {
            for name in [proxy_name(h), thumb_name(h), meta_name(h)] {
                let path = d.join(name);
                fs::write(&path, b"x").unwrap();
                let when = base + Duration::from_secs(10 * i as u64);
                fs::File::options().append(true).open(&path).unwrap().set_modified(when).unwrap();
            }
        }
        // Using "a" again makes it recent: "b" is the oldest now.
        fs::File::options()
            .append(true)
            .open(d.join(meta_name(&hashes[0])))
            .unwrap()
            .set_modified(SystemTime::now())
            .unwrap();
        prune_developed(d, 2, &[]);
        let mut left: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        let mut expected = vec![
            "meta.json".to_string(),
            "proxy.jpg".into(),
            "source.jpg".into(),
            "thumb.jpg".into(),
        ];
        for h in [&hashes[0], &hashes[2]] {
            expected.extend([proxy_name(h), thumb_name(h), meta_name(h)]);
        }
        expected.sort();
        assert_eq!(left, expected);
    }

    #[test]
    fn prune_never_deletes_hashes_other_photos_with_the_same_bytes_still_use() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // Four renders in one shared folder, oldest first: "a" belongs to the duplicate photo and is the oldest.
        let hashes: Vec<String> = ["a", "b", "c", "d"].iter().map(|c| c.repeat(64)).collect();
        let base = SystemTime::now() - Duration::from_secs(100);
        for (i, h) in hashes.iter().enumerate() {
            for name in [proxy_name(h), thumb_name(h), meta_name(h)] {
                let path = d.join(name);
                fs::write(&path, b"x").unwrap();
                let when = base + Duration::from_secs(10 * i as u64);
                fs::File::options().append(true).open(&path).unwrap().set_modified(when).unwrap();
            }
        }
        let names = |d: &Path| {
            let mut left: Vec<String> =
                fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            left.sort();
            left
        };
        let trio = |h: &String| [proxy_name(h), thumb_name(h), meta_name(h)];
        // Keep 2 most recent (c, d) plus the protected "a"; only "b" goes.
        prune_developed(d, 2, &[hashes[0].clone(), "f".repeat(64)]);
        let mut expected: Vec<String> = [&hashes[0], &hashes[2], &hashes[3]].into_iter().flat_map(trio).collect();
        expected.sort();
        assert_eq!(names(d), expected);
        // Without protection the stale "a" is pruned as before.
        prune_developed(d, 2, &[]);
        let mut expected: Vec<String> = [&hashes[2], &hashes[3]].into_iter().flat_map(trio).collect();
        expected.sort();
        assert_eq!(names(d), expected);
    }

    #[test]
    fn cancel_requests_are_consumed_once_and_bounded() {
        let jobs = DevelopJobs::default();
        jobs.cancel(7);
        assert!(jobs.take_cancel(7));
        assert!(!jobs.take_cancel(7));
        // Requests for batches that never consume them cannot pile up; the newest survive.
        for job in 1..=(MAX_CANCELLED as u64 + 10) {
            jobs.cancel(job);
        }
        assert_eq!(jobs.cancelled.lock().unwrap().len(), MAX_CANCELLED);
        assert!(!jobs.take_cancel(1));
        assert!(jobs.take_cancel(MAX_CANCELLED as u64 + 10));
    }

    /// Workflow plan 18: a missing LUT file is left out of the cached render (which says so and is redone once the
    /// file is back), and a full render refuses to run without it.
    #[test]
    fn a_missing_lut_warns_and_blocks_full_renders() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1004.jpg");
        prepare(&src, Kind::Jpeg, &entry).unwrap();
        let id = "7".repeat(64);
        let settings: DevelopSettings =
            serde_json::from_str(&format!(r#"{{"version":1,"look":{{"lut":{{"id":"{id}","name":"Gone"}}}}}}"#)).unwrap();
        let dh = develop_hash(&settings);
        let (developer, _) = DevelopJobs::default().developer(&"e".repeat(64), &entry, &src, false).unwrap();
        let meta = write_cached(&entry, &developer, &settings, &dh, OutputProfile::Srgb, &Input::Source).unwrap();
        assert_eq!(meta.lut_missing, Some(true));
        assert_eq!(cached_render(&entry, &dh, OutputProfile::Srgb), Some(meta));
        let err = develop_full_image(&src, &entry, &settings, OutputProfile::Srgb, &|| false).err().unwrap();
        assert!(err.to_string().starts_with("LUT missing: Gone"), "{err}");
        // The file is back: the cached render without it no longer counts.
        photobook_develop::lut::insert(&id, std::sync::Arc::new(photobook_develop::lut::Lut3d::identity(2)));
        assert!(cached_render(&entry, &dh, OutputProfile::Srgb).is_none());
        photobook_develop::lut::forget(&id);
    }

    #[test]
    fn cached_render_writes_brighter_files_and_hits_afterwards() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1004.jpg"); // orientation 6, upright 1600x2400
        prepare(&src, Kind::Jpeg, &entry).unwrap();
        let jobs = DevelopJobs::default();
        let hash = "f".repeat(64);
        let (developer, decoded) = jobs.developer(&hash, &entry, &src, false).unwrap();
        assert!(decoded);
        // Nothing was cached, so it is kept even with keep = false; the second call reuses it.
        assert!(!jobs.developer(&hash, &entry, &src, false).unwrap().1);

        let settings = bright();
        let dh = develop_hash(&settings);
        assert!(cached_render(&entry, &dh, OutputProfile::Srgb).is_none());
        let start = Instant::now();
        let meta = write_cached(&entry, &developer, &settings, &dh, OutputProfile::Srgb, &Input::Source).unwrap();
        println!("cached render (proxy + thumb): {:?}", start.elapsed());
        assert_eq!((meta.width, meta.height), (1067, 1600));
        assert_eq!(jpeg_size(Path::new(&meta.proxy_path)), (1067, 1600));
        assert_eq!(jpeg_size(Path::new(&meta.thumb_path)), (171, 256));
        let (before, after) = (mean(&entry.join(PROXY_FILE)), mean(Path::new(&meta.proxy_path)));
        println!("mean proxy.jpg {before:.1} -> proxy-<dh>.jpg {after:.1}");
        assert!(after > before + 20.0);
        assert_eq!(cached_render(&entry, &dh, OutputProfile::Srgb), Some(meta.clone()));

        // The Display P3 render of the same settings is a separate, P3-tagged set with the same develop hash.
        assert!(cached_render(&entry, &dh, OutputProfile::DisplayP3).is_none());
        let p3 = write_cached(&entry, &developer, &settings, &dh, OutputProfile::DisplayP3, &Input::Source).unwrap();
        assert_eq!(p3.develop_hash, dh);
        assert!(p3.proxy_path.ends_with(&format!("proxy-{dh}-p3.jpg")), "{}", p3.proxy_path);
        let bytes = fs::read(&p3.proxy_path).unwrap();
        let icc = OutputProfile::DisplayP3.icc();
        assert!(bytes.windows(icc.len()).any(|w| w == icc), "P3 profile embedded");
        assert_eq!(cached_render(&entry, &dh, OutputProfile::DisplayP3), Some(p3));
        assert_eq!(cached_render(&entry, &dh, OutputProfile::Srgb), Some(meta));
    }

    #[test]
    fn preview_renders_the_proxy_and_drops_stale_jobs() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1008.jpg"); // 6000x4000, no proxy yet: decoded from the source
        let jobs = DevelopJobs::default();
        let hash = "d".repeat(64);
        jobs.preview_job.fetch_max(5, Ordering::SeqCst);
        let start = Instant::now();
        let bytes = preview_bytes(&jobs, &hash, &entry, &src, &bright(), 5, None, OutputProfile::Srgb, &[]).unwrap();
        println!("first preview (decode + render + encode): {:?}", start.elapsed());
        assert_eq!(turbojpeg::read_header(&bytes).map(|h| (h.width, h.height)).unwrap(), (1600, 1067));
        let start = Instant::now();
        let small = preview_bytes(&jobs, &hash, &entry, &src, &bright(), 5, Some(800), OutputProfile::DisplayP3, &[]).unwrap();
        println!("second preview at 800 px (cached decode): {:?}", start.elapsed());
        assert_eq!(turbojpeg::read_header(&small).map(|h| (h.width, h.height)).unwrap(), (800, 534));
        let icc = OutputProfile::DisplayP3.icc();
        assert!(small.windows(icc.len()).any(|w| w == icc), "the proof render is tagged Display P3");
        // A newer job makes job 5 stale.
        jobs.preview_job.fetch_max(6, Ordering::SeqCst);
        assert!(preview_bytes(&jobs, &hash, &entry, &src, &bright(), 5, None, OutputProfile::Srgb, &[]).unwrap().is_empty());
    }

    /// Plan 53: a preview with a mode is the plain preview's pixels with the CPU reference overlay drawn over them, and
    /// it never reaches the full render (same bytes before and after, no file named for a mode).
    #[test]
    fn a_preview_mode_draws_over_the_plain_preview_and_never_reaches_the_full_render() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1004.jpg");
        let jobs = DevelopJobs::default();
        let hash = "f".repeat(64);
        let settings = bright();
        jobs.preview_job.fetch_max(1, Ordering::SeqCst);
        let full_before = tmp.path().join("before.jpg");
        render_full_file(&src, &entry, &full_before, &settings, OutputProfile::Srgb, &|| false).unwrap();
        let plain_bytes = preview_bytes(&jobs, &hash, &entry, &src, &settings, 1, None, OutputProfile::Srgb, &[]).unwrap();
        for mode in [PreviewMode::FocusPeak, PreviewMode::Zebra] {
            let bytes =
                preview_bytes(&jobs, &hash, &entry, &src, &settings, 1, None, OutputProfile::Srgb, &[mode]).unwrap();
            let input = choose_input(&entry, &settings).input;
            let (developer, _) = jobs.developer_for(&hash, &entry, &src, true, &input, &settings).unwrap();
            let plain = render_developer(&developer, &settings, OutputProfile::Srgb);
            let overlay = photobook_develop::apply_preview_mode_cpu(&plain, mode);
            assert_ne!(overlay, plain, "{mode:?} drew nothing");
            let expected = encode_jpeg_as(&overlay, PREVIEW_QUALITY, OutputProfile::Srgb).unwrap();
            assert!(bytes == expected, "{mode:?}: the preview is not the plain preview with the CPU overlay");
            assert!(bytes != plain_bytes);
            // At a smaller edge too (the resize path).
            let small =
                preview_bytes(&jobs, &hash, &entry, &src, &settings, 1, Some(400), OutputProfile::Srgb, &[mode]).unwrap();
            assert_eq!(turbojpeg::read_header(&small).map(|h| (h.width, h.height)).unwrap(), (267, 400));
        }
        let full_after = tmp.path().join("after.jpg");
        render_full_file(&src, &entry, &full_after, &settings, OutputProfile::Srgb, &|| false).unwrap();
        assert!(fs::read(&full_before).unwrap() == fs::read(&full_after).unwrap(), "the full render changed");
        assert!(files_in(&entry).iter().all(|f| !f.contains("zebra") && !f.contains("focus")), "{:?}", files_in(&entry));
        // Both modes: tested on the plain pixels, focus peak painted first, then zebra, whatever the order sent.
        let both = preview_bytes(&jobs, &hash, &entry, &src, &settings, 1, None, OutputProfile::Srgb, &parse_preview_modes(&["zebra".into(), "focus-peak".into()]).unwrap()).unwrap();
        let input = choose_input(&entry, &settings).input;
        let (developer, _) = jobs.developer_for(&hash, &entry, &src, true, &input, &settings).unwrap();
        let plain = render_developer(&developer, &settings, OutputProfile::Srgb);
        let expected =
            photobook_develop::apply_preview_modes_cpu(&plain, &[PreviewMode::FocusPeak, PreviewMode::Zebra]);
        assert!(both == encode_jpeg_as(&expected, PREVIEW_QUALITY, OutputProfile::Srgb).unwrap());
        assert_eq!(parse_preview_modes(&[]).unwrap(), vec![]);
        assert_eq!(parse_preview_modes(&["zebra".into(), "zebra".into()]).unwrap(), vec![PreviewMode::Zebra]);
        assert!(parse_preview_modes(&["peaking".into()]).is_err());
    }

    /// The files in `dir` (none when it does not exist).
    fn files_in(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
        entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_full_render_cancelled_mid_way_leaves_no_file() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1004.jpg");
        let out_dir = tmp.path().join(SOURCE_CACHE_DIR).join(DEVELOP_DIR);
        fs::create_dir_all(&out_dir).unwrap();
        let settings = bright();
        let out = full_render_path(&out_dir, &"c".repeat(64), &develop_hash(&settings), OutputProfile::Srgb);
        // Cancelled once decoded (before the render) and once rendered (before the encode and the write).
        for stop_at in [1, 2] {
            let asked = std::cell::Cell::new(0);
            let cancelled = || {
                asked.set(asked.get() + 1);
                asked.get() >= stop_at
            };
            let err = render_full_file(&src, &entry, &out, &settings, OutputProfile::Srgb, &cancelled).unwrap_err();
            assert_eq!(err.to_string(), CANCELLED);
            assert_eq!(asked.get(), stop_at);
            assert!(files_in(&out_dir).is_empty(), "left {:?}", files_in(&out_dir));
        }
        // Not cancelled: one whole file and no temp file.
        render_full_file(&src, &entry, &out, &settings, OutputProfile::Srgb, &|| false).unwrap();
        assert_eq!(files_in(&out_dir), vec![out.file_name().unwrap().to_string_lossy().into_owned()]);
    }

    #[test]
    fn a_failed_render_write_leaves_no_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        // The target is a folder with something in it, so the rename over it fails after the temp file was written.
        let out = tmp.path().join("render.jpg");
        fs::create_dir_all(out.join("taken")).unwrap();
        assert!(write_atomic(&out, b"jpeg").is_err());
        assert_eq!(files_in(tmp.path()), vec!["render.jpg".to_string()]);
    }

    #[test]
    fn full_render_copies_exif_and_brightens() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        let src = fixtures().join("DSCF1004.jpg");
        let settings = bright();
        let out = full_render_path(tmp.path(), &"e".repeat(64), &develop_hash(&settings), OutputProfile::Srgb);
        let start = Instant::now();
        render_full_file(&src, &entry, &out, &settings, OutputProfile::Srgb, &|| false).unwrap();
        println!("full render 2400x1600: {:?}", start.elapsed());
        // Upright and full size; Exif copied with Orientation reset to 1.
        assert_eq!(jpeg_size(&out), (1600, 2400));
        let exif = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(fs::File::open(&out).unwrap()));
        let orientation = exif.ok().and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)));
        assert_eq!(orientation, Some(1));
        assert!(mean(&out) > mean(&src) + 20.0);
    }

    /// Mean absolute difference per channel value of two same-sized linear images.
    fn mean_diff(a: &LinearImage, b: &LinearImage) -> f64 {
        assert_eq!((a.width, a.height), (b.width, b.height));
        a.data.iter().zip(&b.data).map(|(x, y)| (x - y).abs() as f64).sum::<f64>() / a.data.len() as f64
    }

    #[test]
    fn working_proxy_of_an_icc_tagged_source_is_colour_managed() {
        let Ok(profile) = fs::read("/System/Library/ColorSync/Profiles/Display P3.icc") else {
            eprintln!("no Display P3 profile here; skipping");
            return;
        };
        // DSCF1004.jpg tagged as Display P3: prepare_asset's proxy.jpg and thumb.jpg keep the profile.
        let tmp = tempfile::tempdir().unwrap();
        let mut bytes = fs::read(fixtures().join("DSCF1004.jpg")).unwrap();
        let payload = [ICC_MARKER, &[1, 1], profile.as_slice()].concat();
        let mut segment = vec![0xFF, 0xE2];
        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(&payload);
        bytes.splice(2..2, segment.clone());
        let src = tmp.path().join("p3.jpg");
        fs::write(&src, &bytes).unwrap();
        let entry = tmp.path().join("entry");
        let info = prepare(&src, Kind::Jpeg, &entry).unwrap();
        assert_eq!(icc_segments(&bytes), segment);
        let proxy_bytes = fs::read(&info.proxy_path).unwrap();
        assert_eq!(icc_segments(&proxy_bytes), segment, "proxy.jpg carries the source's APP2 ICC segment byte for byte");
        assert_eq!(icc_segments(&fs::read(&info.thumb_path).unwrap()), segment);
        assert!(turbojpeg::read_header(&proxy_bytes).is_ok());

        // The proxy now decodes like the source (it is used as the working image); the same pixels without
        // the profile (what proxies held before) do not.
        let proxy = entry.join(PROXY_FILE);
        assert!(proxy_is_faithful(&src, &proxy));
        let managed = decode_source(&src, &entry, Some(PROXY_EDGE)).unwrap().0;
        let working = decode_proxy(&entry, &src).unwrap();
        let at = proxy_bytes.windows(segment.len()).position(|w| w == segment.as_slice()).unwrap();
        let mut untagged = proxy_bytes.clone();
        untagged.drain(at..at + segment.len());
        let old = tmp.path().join("old-proxy.jpg");
        fs::write(&old, &untagged).unwrap();
        let as_srgb = decode_file(&old, Some(PROXY_EDGE)).unwrap();
        let (bad, got) = (mean_diff(&as_srgb, &managed), mean_diff(&working, &managed));
        println!("untagged proxy differs by {bad:.4}, tagged working proxy by {got:.4}");
        assert!(got < bad / 4.0, "working proxy {got} vs untagged proxy {bad}");
        // A proxy without the source's profile (an older cache) is not used; the source is decoded instead.
        assert!(!proxy_is_faithful(&src, &old));
        // An untagged JPEG: untagged proxy, used. PNG and HEIC are always decoded from the source.
        let plain = tmp.path().join("plain");
        let plain_info = prepare(&fixtures().join("DSCF1004.jpg"), Kind::Jpeg, &plain).unwrap();
        assert!(icc_segments(&fs::read(&plain_info.proxy_path).unwrap()).is_empty());
        assert!(proxy_is_faithful(&fixtures().join("DSCF1004.jpg"), &plain.join(PROXY_FILE)));
        assert!(!proxy_is_faithful(&fixtures().join("day-two/DSCF1032.png"), &plain.join(PROXY_FILE)));
    }

    #[test]
    fn renders_a_raw_in_full_and_as_a_working_image() {
        let dir = std::env::var_os("PHOTOBOOK_RAW_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples"));
        let src = dir.join("ON1 Sample 2.CR2");
        if !src.is_file() {
            eprintln!("no sample RAW here; skipping");
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("entry");
        // The proxy from prepare_asset is the camera's JPEG: the working image is decoded from the RAW instead.
        prepare(&src, Kind::Raw, &entry).unwrap();
        let working = decode_proxy(&entry, &src).unwrap();
        assert!(working.meta.is_raw && working.meta.as_shot.is_some());
        assert_eq!((working.width, working.height), (1600, 1067));
        // Full render: the whole default crop, no Exif source (not a JPEG), the display look on.
        let settings = DevelopSettings::default();
        let out = full_render_path(tmp.path(), &"a".repeat(64), &develop_hash(&settings), OutputProfile::Srgb);
        render_full_file(&src, &entry, &out, &settings, OutputProfile::Srgb, &|| false).unwrap();
        assert_eq!(jpeg_size(&out), (3456, 2304));
        let image = decode_source(&src, &entry, Some(400)).unwrap();
        assert!(image.1.is_none());
        let with_look = render_developer(&Developer::new(image.0.clone()), &settings, OutputProfile::Srgb);
        let plain = Developer::new(image.0).render_with(&settings, &RenderOptions::default());
        assert_ne!(with_look.data, plain.data);
    }

    #[test]
    fn decodes_a_png_and_a_heic_source() {
        let tmp = tempfile::tempdir().unwrap();
        let (png, exif) = decode_source(&fixtures().join("day-two/DSCF1032.png"), tmp.path(), Some(PROXY_EDGE)).unwrap();
        assert_eq!((png.width, png.height, exif), (1600, 1067, None));

        let heic = tmp.path().join("photo.heic");
        let made = std::process::Command::new("sips")
            .args(["-s", "format", "heic"])
            .arg(fixtures().join("DSCF1001.jpg"))
            .arg("--out")
            .arg(&heic)
            .output()
            .is_ok_and(|o| o.status.success() && heic.is_file());
        if !made {
            eprintln!("sips cannot write HEIC here; skipping");
            return;
        }
        let entry = tmp.path().join("entry");
        let (img, exif) = decode_source(&heic, &entry, Some(PROXY_EDGE)).unwrap();
        assert_eq!((img.width, img.height), (1600, 1067));
        // ImageIO decodes it directly: no `sips` JPEG is made, and the Exif comes from the HEIC itself.
        assert_eq!(exif, Some(heic.clone()));
        assert!(!entry.join("source.jpg").exists());
        assert_eq!(exif_source_of(&heic), Some(heic.clone()));

        // A full render of a HEIC that has Exif keeps it (Orientation reset to 1).
        let with_exif = tmp.path().join("exif.heic");
        let made = std::process::Command::new("sips")
            .args(["-s", "format", "heic"])
            .arg(fixtures().join("DSCF1004.jpg"))
            .arg("--out")
            .arg(&with_exif)
            .output()
            .is_ok_and(|o| o.status.success() && with_exif.is_file());
        assert!(made);
        let out = tmp.path().join("full.jpg");
        render_full_file(&with_exif, &entry, &out, &bright(), OutputProfile::Srgb, &|| false).unwrap();
        assert!(!entry.join("source.jpg").exists());
        let parsed = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(fs::File::open(&out).unwrap()));
        let orientation = parsed.ok().and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)));
        assert_eq!(orientation, Some(1));
    }
}

// ---------- Guided Upright (step D2.2) ----------

/// What `solve_upright_guides` returns: the solver's [`photobook_develop::geometry::GuidedSolution`] with the
/// correction as `level`, `vertical` or `full`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuidedUprightSolution {
    /// Row-major forward homography in normalised coordinates of the oriented frame (`h8 = 1`).
    pub transform: [f64; 9],
    /// Focal used, long-edge units.
    pub focal: f64,
    /// Length-weighted RMS angle (degrees) between the warped guides and their axis.
    pub residual: f64,
    pub correction: &'static str,
}

/// Guided Upright: solve the correction for `guides` (endpoints in fractions of the oriented
/// `frame_w × frame_h` frame, before Upright and the manual Transform; the UI maps its stored guides back
/// first). Pure maths, no disk access. Errors reach JS as `InvalidGuides: …` or `Unstable: …`.
#[tauri::command]
pub fn solve_upright_guides(
    guides: Vec<photobook_develop::settings::UprightGuide>,
    frame_w: f64,
    frame_h: f64,
    focal: Option<f64>,
) -> Result<GuidedUprightSolution> {
    use photobook_develop::geometry::{solve_guided, GuidedCorrection, UprightError};
    let started = Instant::now();
    let solution = solve_guided(&guides, frame_w, frame_h, focal).map_err(|err| {
        Error::Invalid(match err {
            UprightError::InvalidGuides(msg) => format!("InvalidGuides: {msg}"),
            UprightError::Unstable(msg) => format!("Unstable: {msg}"),
            UprightError::NoStructure(msg) => format!("NoStructure: {msg}"),
        })
    })?;
    let correction = match solution.correction {
        GuidedCorrection::Level => "level",
        GuidedCorrection::Vertical => "vertical",
        GuidedCorrection::Full => "full",
    };
    log::info!(
        "[photobook:develop] guided upright: {} guides, {correction}, residual {:.4}°, {:?}",
        guides.len(),
        solution.residual,
        started.elapsed()
    );
    Ok(GuidedUprightSolution {
        transform: solution.transform,
        focal: solution.focal,
        residual: solution.residual,
        correction,
    })
}

#[cfg(test)]
mod upright_tests {
    use super::*;
    use photobook_develop::settings::{GuideKind, UprightGuide};

    fn guide(id: &str, kind: GuideKind, from: [f64; 2], to: [f64; 2]) -> UprightGuide {
        UprightGuide { id: id.into(), kind, from, to }
    }

    #[test]
    fn solves_two_verticals_and_rejects_one_guide() {
        let guides = vec![
            guide("a", GuideKind::Vertical, [0.3, 0.1], [0.25, 0.9]),
            guide("b", GuideKind::Vertical, [0.7, 0.1], [0.75, 0.9]),
        ];
        let s = solve_upright_guides(guides.clone(), 6000.0, 4000.0, None).unwrap();
        assert_eq!(s.correction, "vertical");
        assert!((s.transform[8] - 1.0).abs() < 1e-12);
        let err = solve_upright_guides(guides[..1].to_vec(), 6000.0, 4000.0, None).unwrap_err();
        assert!(err.to_string().starts_with("InvalidGuides: "), "{err}");
    }
}

// ---------- Auto level and automatic Upright (step D2.3) ----------

/// Analyses kept (each is a few hundred segments): the photo being edited in a few orientations.
const MAX_ANALYSES: usize = 8;

/// One detected segment for the "show structure" overlay: endpoints in fractions (0..1) of the oriented frame.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructureLine {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// Used by the correction (rejected otherwise).
    pub used: bool,
}

/// What `analyse_geometry` returns. Without a correction (`NoStructure`) `transform`, `focal`, `angle` and
/// `correction` are null, `message` says why and every line is unused.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeometryAnalysis {
    /// Row-major forward homography in normalised coordinates of the oriented frame (`h8 = 1`).
    pub transform: Option<[f64; 9]>,
    /// Focal used, long-edge units.
    pub focal: Option<f64>,
    /// Rotation the correction applies at the frame centre, degrees clockwise (Level: the straighten angle).
    pub angle: Option<f64>,
    /// 0..1.
    pub confidence: f64,
    /// `level`, `vertical` or `full`: what was applied (Auto and the fallbacks may differ from the mode).
    pub correction: Option<&'static str>,
    pub message: Option<String>,
    pub lines: Vec<StructureLine>,
    /// Wall time of the command (decode, orientation, analysis when not cached, solve).
    pub elapsed_ms: f64,
}

/// One cached analysis: the photo's hash and orientation it was computed for, and the oriented frame size.
struct CachedAnalysis {
    key: (String, u16, bool, bool),
    analysis: Arc<photobook_develop::geometry::Analysis>,
    frame: (u32, u32),
}

/// Analyses of recent `(hash, rotate, flipH, flipV)`, newest last, so switching Upright modes does not re-analyse.
#[derive(Default)]
pub struct GeometryAnalyses {
    entries: Mutex<Vec<CachedAnalysis>>,
}

impl GeometryAnalyses {
    fn get(&self, key: &(String, u16, bool, bool)) -> Option<(Arc<photobook_develop::geometry::Analysis>, (u32, u32))> {
        let mut entries = self.entries.lock().expect("analysis lock poisoned");
        let i = entries.iter().position(|e| &e.key == key)?;
        let entry = entries.remove(i);
        let hit = (entry.analysis.clone(), entry.frame);
        entries.push(entry);
        Some(hit)
    }

    fn put(&self, key: (String, u16, bool, bool), analysis: Arc<photobook_develop::geometry::Analysis>, frame: (u32, u32)) {
        let mut entries = self.entries.lock().expect("analysis lock poisoned");
        entries.retain(|e| e.key != key);
        entries.push(CachedAnalysis { key, analysis, frame });
        while entries.len() > MAX_ANALYSES {
            entries.remove(0);
        }
    }
}

/// EXIF `FocalLengthIn35mmFilm` (mm) of a JPEG (or any container kamadak-exif reads), when present and positive.
fn exif_focal_35mm(path: &Path) -> Option<f64> {
    let file = fs::File::open(path).ok()?;
    focal_35mm_from(&mut std::io::BufReader::new(file))
}

fn focal_35mm_from<R: std::io::BufRead + std::io::Seek>(reader: &mut R) -> Option<f64> {
    let exif = exif::Reader::new().read_from_container(reader).ok()?;
    let field = exif.get_field(exif::Tag::FocalLengthIn35mmFilm, exif::In::PRIMARY)?;
    let mm = field.value.get_uint(0)? as f64;
    (mm > 0.0).then_some(mm)
}

fn upright_mode_of(mode: &str) -> Result<photobook_develop::settings::UprightMode> {
    use photobook_develop::settings::UprightMode;
    match mode {
        "auto" => Ok(UprightMode::Auto),
        "level" => Ok(UprightMode::Level),
        "vertical" => Ok(UprightMode::Vertical),
        "full" => Ok(UprightMode::Full),
        other => Err(Error::Invalid(format!("mode must be auto, level, vertical or full, got {other}"))),
    }
}

/// The decoded image turned into the oriented frame (exact copies: 90° turns and flips only).
fn oriented_image(image: &LinearImage, rotate: u16, flip_h: bool, flip_v: bool) -> Result<LinearImage> {
    use photobook_develop::geometry::warp;
    use photobook_develop::settings::{Geometry, Rotation};
    let rotate = Rotation::try_from(rotate).map_err(Error::Invalid)?;
    let geometry = Geometry { rotate, flip_h, flip_v, ..Default::default() };
    let plan = photobook_develop::GeometryPlan::new(&geometry, image.width, image.height, None);
    Ok(warp(image, &plan, photobook_develop::Quality::Preview))
}

/// [`analyse_geometry`] without Tauri state: solve `mode` on `analysis` for the oriented `frame`.
fn auto_upright_result(
    analysis: &photobook_develop::geometry::Analysis,
    mode: photobook_develop::settings::UprightMode,
    frame: (u32, u32),
) -> Result<GeometryAnalysis> {
    use photobook_develop::geometry::{solve_auto, GuidedCorrection, UprightError};
    let lines = |used: &[bool]| -> Vec<StructureLine> {
        analysis
            .segments
            .iter()
            .enumerate()
            .map(|(i, s)| StructureLine {
                x0: s.x0,
                y0: s.y0,
                x1: s.x1,
                y1: s.y1,
                used: used.get(i).copied().unwrap_or(false),
            })
            .collect()
    };
    match solve_auto(analysis, mode, frame.0 as f64, frame.1 as f64) {
        Ok(s) => Ok(GeometryAnalysis {
            transform: Some(s.transform),
            focal: Some(s.focal),
            angle: Some(s.angle),
            confidence: s.confidence,
            correction: Some(match s.correction {
                GuidedCorrection::Level => "level",
                GuidedCorrection::Vertical => "vertical",
                GuidedCorrection::Full => "full",
            }),
            message: None,
            lines: lines(&s.used),
            elapsed_ms: 0.0,
        }),
        Err(UprightError::NoStructure(msg)) => Ok(GeometryAnalysis {
            transform: None,
            focal: None,
            angle: None,
            confidence: analysis.level.as_ref().map_or(0.0, |l| l.confidence),
            correction: None,
            message: Some(msg),
            lines: lines(&[]),
            elapsed_ms: 0.0,
        }),
        Err(UprightError::InvalidGuides(msg)) => Err(Error::Invalid(format!("InvalidGuides: {msg}"))),
        Err(UprightError::Unstable(msg)) => Err(Error::Invalid(format!("Unstable: {msg}"))),
    }
}

/// Auto level and automatic Upright: analyse the photo's 1600 px proxy (the decode `render_develop_preview`
/// caches) in the oriented frame (`rotate`, `flip_h`, `flip_v` applied, before Upright and the manual Transform)
/// and solve `mode` (`auto`, `level`, `vertical` or `full`). The analysis is cached per
/// `(hash, rotate, flipH, flipV)`, so switching modes only re-solves. "No structure" is a result with a
/// `message` (and the rejected lines), not an error; an unstable warp rejects with `Unstable: …`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn analyse_geometry<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    mode: String,
    rotate: u16,
    flip_h: bool,
    flip_v: bool,
) -> Result<GeometryAnalysis> {
    let started = Instant::now();
    let upright_mode = upright_mode_of(&mode)?;
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let key = (hash.clone(), rotate, flip_h, flip_v);
    let cached = app.state::<GeometryAnalyses>().get(&key);
    let hit = cached.is_some();
    let (analysis, frame) = match cached {
        Some(c) => c,
        None => {
            let permit = render_permit(&app).await?;
            let app2 = app.clone();
            let (analysis, frame) = tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                let (developer, _) = app2.state::<DevelopJobs>().developer(&hash, &entry_dir, &src, true)?;
                let image = developer.image();
                let oriented = if rotate == 0 && !flip_h && !flip_v {
                    None
                } else {
                    Some(oriented_image(image, rotate, flip_h, flip_v)?)
                };
                let oriented = oriented.as_ref().unwrap_or(image);
                let focal = if kind_of(&src) == Some(Kind::Jpeg) { exif_focal_35mm(&src) } else { None };
                let analysis = photobook_develop::geometry::analyse(oriented, focal);
                Ok::<_, Error>((Arc::new(analysis), (oriented.width, oriented.height)))
            })
            .await??;
            app.state::<GeometryAnalyses>().put(key, analysis.clone(), frame);
            (analysis, frame)
        }
    };
    let mut result = auto_upright_result(&analysis, upright_mode, frame)?;
    result.elapsed_ms = started.elapsed().as_secs_f64() * 1e3;
    log::info!(
        "[photobook:develop] analyse {mode} {:.0}ms segments={} used={} correction={} angle={} confidence={:.2} focal={:.3} ({:?}) analysis={:.0}ms{} vision={}{}",
        result.elapsed_ms,
        result.lines.len(),
        result.lines.iter().filter(|l| l.used).count(),
        result.correction.unwrap_or("none"),
        result.angle.map_or("-".into(), |a| format!("{a:.2}°")),
        result.confidence,
        analysis.focal,
        analysis.focal_source,
        analysis.elapsed_ms,
        if hit { " cached" } else { "" },
        analysis.level.as_ref().is_some_and(|l| l.source == photobook_develop::geometry::LevelSource::Vision),
        result.message.as_ref().map_or(String::new(), |m| format!(" message=\"{m}\"")),
    );
    Ok(result)
}

#[cfg(test)]
mod auto_upright_tests {
    use super::*;
    use photobook_develop::settings::UprightMode;

    /// A JPEG holding only SOI, an Exif APP1 (IFD0 → Exif IFD with `FocalLengthIn35mmFilm` = `mm`) and EOI.
    fn jpeg_with_focal(mm: u16) -> Vec<u8> {
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II\x2a\x00");
        tiff.extend_from_slice(&8u32.to_le_bytes());
        // IFD0 at 8: one entry, ExifIFDPointer (0x8769, LONG) → 26.
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x8769u16.to_le_bytes());
        tiff.extend_from_slice(&4u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&26u32.to_le_bytes());
        tiff.extend_from_slice(&0u32.to_le_bytes());
        // Exif IFD at 26: FocalLengthIn35mmFilm (0xA405, SHORT).
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0xa405u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&mm.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend_from_slice(&tiff);
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
        jpeg.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&app1);
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        jpeg
    }

    #[test]
    fn reads_the_35mm_focal_from_exif() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("focal.jpg");
        fs::write(&path, jpeg_with_focal(28)).unwrap();
        assert_eq!(exif_focal_35mm(&path), Some(28.0));
        fs::write(&path, jpeg_with_focal(0)).unwrap();
        assert_eq!(exif_focal_35mm(&path), None);
        fs::write(&path, [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        assert_eq!(exif_focal_35mm(&path), None);
        assert_eq!(exif_focal_35mm(&tmp.path().join("missing.jpg")), None);
    }

    #[test]
    fn modes_parse_and_reject_others() {
        assert_eq!(upright_mode_of("auto").unwrap(), UprightMode::Auto);
        assert_eq!(upright_mode_of("full").unwrap(), UprightMode::Full);
        assert!(upright_mode_of("guided").is_err());
    }

    /// Light and dark bands whose edges are turned by `deg` (negative: rising to the right, a tilted horizon).
    fn tilted_bands(w: u32, h: u32, deg: f64) -> LinearImage {
        let t = deg.to_radians();
        let mut data = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = (x as f64 - w as f64 / 2.0, y as f64 - h as f64 / 2.0);
                let d = -t.sin() * dx + t.cos() * dy;
                // Soft (anti-aliased) band edges, so the detector sees straight lines rather than pixel steps.
                let v = (0.325 + 0.275 * (13.0 * (std::f64::consts::PI * d / 60.0).sin()).tanh()) as f32;
                data.extend_from_slice(&[v, v, v]);
            }
        }
        LinearImage::new(w, h, data)
    }

    #[test]
    fn levels_a_tilted_image_and_orients_it_first() {
        let image = tilted_bands(960, 640, -2.0);
        let analysis = photobook_develop::geometry::analyse(&image, None);
        let r = auto_upright_result(&analysis, UprightMode::Level, (960, 640)).unwrap();
        assert_eq!(r.correction, Some("level"));
        let angle = r.angle.unwrap();
        assert!((angle - 2.0).abs() < 0.3, "{angle}");
        assert_eq!(r.lines.len(), analysis.segments.len());
        assert!(r.lines.iter().any(|l| l.used));

        // Turned 90°: the frame is portrait and the analysis runs on the turned pixels.
        let turned = oriented_image(&image, 90, false, false).unwrap();
        assert_eq!((turned.width, turned.height), (640, 960));
        assert!(oriented_image(&image, 45, false, false).is_err());
    }

    #[test]
    fn a_flat_image_has_no_structure() {
        let image = LinearImage::new(320, 240, vec![0.2; 320 * 240 * 3]);
        let analysis = photobook_develop::geometry::analyse(&image, None);
        let r = auto_upright_result(&analysis, UprightMode::Auto, (320, 240)).unwrap();
        assert!(r.transform.is_none() && r.correction.is_none());
        assert!(r.message.is_some());
        assert!(r.lines.iter().all(|l| !l.used));
    }
}

// ---------------------------------------------------------------------------------------------
// Mask overlay (D4.1)

/// A `0..1` plane as an 8-bit greyscale JPEG (white = 1), like the sharpening mask view.
fn plane_jpeg(w: u32, h: u32, plane: &[f32]) -> Result<Vec<u8>> {
    let mut data = Vec::with_capacity(plane.len() * 3);
    for v in plane {
        let g = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        data.extend_from_slice(&[g, g, g]);
    }
    Ok(encode_jpeg(&Rgb8Image::new(w, h, data), PREVIEW_QUALITY)?)
}

/// One mask's composited plane (its components, invert, feather and opacity) on the photo's proxy, as a
/// greyscale JPEG (white = full strength) the size of the developed render, for the Masks panel's overlay.
/// Same decode source and cached `Developer` as `render_develop_preview`; only `settings.masks` and the
/// geometry matter. Disabled masks are drawn too. Errors when `settings` has no mask `mask_id`.
#[tauri::command]
pub async fn develop_mask_overlay<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    mask_id: String,
) -> Result<Response> {
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let permit = render_permit(&app).await?;
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let start = Instant::now();
        let (developer, _) = app2.state::<DevelopJobs>().developer(&hash, &entry_dir, &src, true)?;
        let (w, h, plane) = developer
            .mask_overlay(&settings, &mask_id)
            .ok_or_else(|| Error::Invalid(format!("no mask {mask_id:?} in the develop settings")))?;
        let bytes = plane_jpeg(w, h, &plane)?;
        log::info!("[photobook:develop] mask overlay {mask_id} {w}x{h} in {}ms", ms(start));
        Ok::<_, Error>(bytes)
    })
    .await??;
    Ok(Response::new(bytes))
}

/// Bring the GPU up for the develop renders (its crash flag lives in the app cache directory) and log
/// whether renders will use it: `[photobook:develop] gpu available: …` or `gpu unavailable: <reason>`.
/// Called once from `run()`'s setup; the wait for the device happens on a background thread.
pub fn init_gpu<R: Runtime>(app: &AppHandle<R>) {
    let dir = app.path().app_cache_dir().ok();
    photobook_develop::gpu::init(dir);
    let _ = std::thread::Builder::new().name("photobook-gpu-status".into()).spawn(|| {
        match photobook_develop::gpu::availability() {
            Ok(adapter) => log::info!("[photobook:develop] gpu available: {adapter}"),
            Err(reason) => log::info!("[photobook:develop] gpu unavailable: {reason}"),
        }
    });
}

// ---------------------------------------------------------------------------------------------
// AI denoise (D5.1)
//
// `run_denoise` decodes the source at full resolution, runs `photobook_develop::ai::denoise` and writes the 16-bit
// intermediate `<appdata>/cache/<hash>/develop/denoise-<key>.png` (+ `.json` sidecar) and a 1600 px copy
// `denoise-<key>-proxy.png` for the working proxy; only the current key's files are kept per photo. While
// `settings.detail.denoise` is set and the intermediate for its key exists, every render of the photo (preview,
// cached proxy/thumb, full render) decodes it instead of the source; without it they use the source and
// `render_develop_cached` reports `denoiseStale: true`.

pub const EVENT_DENOISE_PROGRESS: &str = "develop:denoise-progress";
/// Long edge of the tuning crop, px at 100 %.
const DENOISE_CROP: u32 = 512;
const DENOISE_CROP_QUALITY: u8 = 90;
/// `<appdata>/models` (as `commands::models`).
const MODELS_DIR: &str = "models";

/// What a develop render decodes.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Input {
    Source,
    /// The denoise intermediate with this key.
    Denoised { key: String },
}

/// The input for some settings, and whether denoise is on without its intermediate (the source stands in).
#[derive(Clone, Debug, PartialEq, Eq)]
struct InputChoice {
    input: Input,
    stale: bool,
}

/// `<entry>/develop/`, where the denoise intermediates live.
fn denoise_dir(entry_dir: &Path) -> PathBuf {
    entry_dir.join(DEVELOP_DIR)
}

fn intermediate_path(entry_dir: &Path, key: &str) -> PathBuf {
    denoise_dir(entry_dir).join(denoise::intermediate_name(key))
}

fn proxy_intermediate_path(entry_dir: &Path, key: &str) -> PathBuf {
    denoise_dir(entry_dir).join(format!("denoise-{key}-proxy.png"))
}

/// The asset hash of a cache entry folder (`<cache>/<hash>`).
fn entry_hash(entry_dir: &Path) -> &str {
    entry_dir.file_name().and_then(|n| n.to_str()).unwrap_or_default()
}

/// The source, or the denoise intermediate when `settings.detail.denoise` is set and its file is complete.
fn choose_input(entry_dir: &Path, settings: &DevelopSettings) -> InputChoice {
    let Some(settings) = settings.detail.denoise.as_ref() else {
        return InputChoice { input: Input::Source, stale: false };
    };
    match denoise::denoise_key_for(entry_hash(entry_dir), settings) {
        Some(key) if denoise::intermediate_ready(&intermediate_path(entry_dir, &key), &key) => {
            InputChoice { input: Input::Denoised { key }, stale: false }
        }
        _ => InputChoice { input: Input::Source, stale: true },
    }
}

fn ai_error(err: ai::Error) -> Error {
    Error::Invalid(err.to_string())
}

/// Whether a render of `settings` runs the chroma filter or a mask's noise (workflow plan 24), so needs the photo's σ.
fn needs_noise_sigma(settings: &DevelopSettings) -> bool {
    photobook_develop::ops::noise::NoiseParams::new(settings, &photobook_develop::ImageMeta::default()).is_some()
}

/// `image` with the photo's noise σ from `noise.json` (workflow plan 24), when it has been measured.
fn with_noise_sigma(mut image: LinearImage, entry_dir: &Path) -> LinearImage {
    if let Some(record) = crate::commands::noise::read_record(entry_dir) {
        image.meta.noise_sigma = Some(crate::commands::noise::filter_sigma(&record));
    }
    image
}

/// The 1600 px working image of `input`, with the photo's noise σ when known.
fn decode_input(entry_dir: &Path, src: &Path, input: &Input) -> Result<LinearImage> {
    Ok(with_noise_sigma(decode_input_pixels(entry_dir, src, input)?, entry_dir))
}

fn decode_input_pixels(entry_dir: &Path, src: &Path, input: &Input) -> Result<LinearImage> {
    match input {
        Input::Source => decode_proxy(entry_dir, src),
        Input::Denoised { key } => {
            let proxy = proxy_intermediate_path(entry_dir, key);
            if denoise::intermediate_ready(&proxy, key) {
                if let Ok(image) = denoise::read_intermediate_fit(&proxy, Some(PROXY_EDGE)) {
                    return Ok(image);
                }
            }
            let start = Instant::now();
            let image =
                denoise::read_intermediate_fit(&intermediate_path(entry_dir, key), Some(PROXY_EDGE)).map_err(ai_error)?;
            log::info!("[photobook:develop] denoised proxy from the full intermediate in {}ms", ms(start));
            Ok(image)
        }
    }
}

/// The file whose Exif a full render of `src` copies: the source itself (a JPEG, or a HEIC whose Exif item
/// `copy_exif` reads from the container).
fn exif_source_of(src: &Path) -> Option<PathBuf> {
    matches!(kind_of(src), Some(Kind::Jpeg | Kind::Heic)).then(|| src.to_path_buf())
}

/// The full-resolution image a full render develops: the denoise intermediate when current, else the source
/// (logging when denoise is on without its intermediate), with the photo's noise σ (measured first when the render
/// needs it and it is not yet: workflow plan 24).
fn decode_full_input(src: &Path, entry_dir: &Path, settings: &DevelopSettings) -> Result<(LinearImage, Option<PathBuf>)> {
    let (mut image, exif) = decode_full_pixels(src, entry_dir, settings)?;
    image.meta.noise_sigma = if needs_noise_sigma(settings) {
        // Measured first when needed; the file's ISO when the measurement fails (logged).
        Some(crate::commands::noise::photo_filter_sigma(src, entry_dir))
    } else {
        crate::commands::noise::read_record(entry_dir).map(|r| crate::commands::noise::filter_sigma(&r))
    };
    Ok((image, exif))
}

fn decode_full_pixels(src: &Path, entry_dir: &Path, settings: &DevelopSettings) -> Result<(LinearImage, Option<PathBuf>)> {
    let choice = choose_input(entry_dir, settings);
    match &choice.input {
        Input::Source => {
            if choice.stale {
                log::warn!(
                    "[photobook:develop] full render of {} without its denoise intermediate (stale)",
                    entry_hash(entry_dir)
                );
            }
            decode_source(src, entry_dir, None)
        }
        Input::Denoised { key } => {
            let image = denoise::read_intermediate(&intermediate_path(entry_dir, key)).map_err(ai_error)?;
            Ok((image, exif_source_of(src)))
        }
    }
}

/// Whether the cached render of `develop_hash` was not decoded from the current denoise intermediate (it then came
/// from the source and must be redone; the develop hash alone cannot tell). Read from the key its meta records, not
/// from file times: a render that started before the intermediate was written can finish after it.
fn rendered_before_denoise(entry_dir: &Path, develop_hash: &str, output: OutputProfile, choice: &InputChoice) -> bool {
    let Input::Denoised { key } = &choice.input else { return false };
    let meta_path = entry_dir.join(meta_name(&render_key(develop_hash, output)));
    let Some(meta) = fs::read(meta_path).ok().and_then(|b| serde_json::from_slice::<CachedMeta>(&b).ok()) else {
        return false; // No complete render: nothing cached to reject.
    };
    meta.denoise.as_deref() != Some(key.as_str())
}

/// [`cached_render_for`] unless `settings` run the chroma filter or mask noise (workflow plan 24) and the render used
/// another σ than the photo's current one (none: never measured or the measurement failed, so it used the default).
fn cached_render_checked(
    entry_dir: &Path,
    develop_hash: &str,
    output: OutputProfile,
    choice: &InputChoice,
    settings: &DevelopSettings,
) -> Option<DevelopRenderMeta> {
    if needs_noise_sigma(settings) {
        let current = crate::commands::noise::read_record(entry_dir).map(|r| crate::commands::noise::filter_sigma(&r));
        let meta_path = entry_dir.join(meta_name(&render_key(develop_hash, output)));
        let used = fs::read(meta_path).ok().and_then(|b| serde_json::from_slice::<CachedMeta>(&b).ok())?.noise_sigma;
        if current.is_none() || used != current {
            return None;
        }
    }
    cached_render_for(entry_dir, develop_hash, output, choice)
}

/// [`cached_render`] unless it predates the denoise intermediate, with `denoiseStale` filled in.
fn cached_render_for(
    entry_dir: &Path,
    develop_hash: &str,
    output: OutputProfile,
    choice: &InputChoice,
) -> Option<DevelopRenderMeta> {
    if rendered_before_denoise(entry_dir, develop_hash, output, choice) {
        return None;
    }
    let meta = cached_render(entry_dir, develop_hash, output)?;
    Some(DevelopRenderMeta { denoise_stale: choice.stale.then_some(true), ..meta })
}

/// Loaded denoise sessions, running denoise jobs (for cancel) and the last full-resolution decode (the crop
/// preview re-reads it while the sliders move).
pub struct DenoiseState {
    sessions: Mutex<Option<Arc<DenoiseSessions>>>,
    running: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /// `cancel_denoise` calls that came before their `run_denoise` registered (while it checked the model).
    pending: PendingCancels,
    /// `(hash, full-resolution image)`: about 290 MB for 24 MP. Taken (dropped) by `run_denoise`.
    full: Mutex<Option<(String, Arc<LinearImage>)>>,
    /// One full denoise at a time (it already uses the Neural Engine/GPU and every core).
    runs: Arc<Semaphore>,
}

impl Default for DenoiseState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(None),
            running: Mutex::new(HashMap::new()),
            pending: PendingCancels::default(),
            full: Mutex::new(None),
            runs: Arc::new(Semaphore::new(1)),
        }
    }
}

impl DenoiseState {
    fn sessions(&self, dir: ModelDir) -> Arc<DenoiseSessions> {
        let mut sessions = self.sessions.lock().expect("denoise lock poisoned");
        match sessions.as_ref().filter(|s| *s.dir() == dir) {
            Some(s) => s.clone(),
            None => sessions.insert(Arc::new(DenoiseSessions::new(dir))).clone(),
        }
    }

    /// Register `job`; its flag is set already when it was cancelled before it got here.
    fn start(&self, job: u64) -> Arc<AtomicBool> {
        let mut running = self.running.lock().expect("denoise lock poisoned");
        let flag = Arc::new(AtomicBool::new(self.pending.take(job)));
        running.insert(job, flag.clone());
        flag
    }

    fn finish(&self, job: u64) {
        self.running.lock().expect("denoise lock poisoned").remove(&job);
    }

    /// Stop `job` before its next tile; a job that has not registered yet is stopped when it does. True when it was
    /// running.
    fn cancel(&self, job: u64) -> bool {
        let running = self.running.lock().expect("denoise lock poisoned");
        match running.get(&job) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => {
                self.pending.remember(job);
                false
            }
        }
    }

    /// The full-resolution decode of `hash`, from the cache or `decode` (which then becomes the cached one).
    fn full_image(&self, hash: &str, decode: impl FnOnce() -> Result<LinearImage>) -> Result<Arc<LinearImage>> {
        if let Some((h, image)) = self.full.lock().expect("denoise lock poisoned").as_ref() {
            if h == hash {
                return Ok(image.clone());
            }
        }
        let image = Arc::new(decode()?);
        *self.full.lock().expect("denoise lock poisoned") = Some((hash.to_string(), image.clone()));
        Ok(image)
    }

    /// Hand over the cached full decode of `hash` (and drop any other).
    fn take_full(&self, hash: &str) -> Option<Arc<LinearImage>> {
        let taken = self.full.lock().expect("denoise lock poisoned").take();
        taken.filter(|(h, _)| h == hash).map(|(_, image)| image)
    }
}

/// `<appdata>/models`.
fn models_dir<R: Runtime>(app: &AppHandle<R>) -> Result<ModelDir> {
    let dir = ensure_allowed(app, crate::scope::app_data_dir(app)?.join(MODELS_DIR))?;
    Ok(ModelDir::new(dir))
}

/// A finished denoise.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DenoiseResult {
    pub key: String,
    /// The full-resolution intermediate (16-bit PNG).
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub elapsed_ms: u64,
    /// `"CoreML (1 partition, 812/812 nodes)"`, `"CPU"`, ...; empty when the intermediate already existed.
    pub engine: String,
    pub tiles: usize,
}

/// What `run_denoise` returns: `{ status: "done", key, path, width, height, elapsedMs, engine, tiles }`,
/// `{ status: "missingModel", model: { name, title, version, bytes, licence, licenceUrl, status } }` or
/// `{ status: "cancelled" }`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DenoiseOutcome {
    Done(DenoiseResult),
    MissingModel { model: AiModelInfo },
    Cancelled,
}

/// What `denoise_status` returns.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DenoiseStatus {
    /// `None` when denoise is off or its model is not in the manifest.
    pub key: Option<String>,
    /// The intermediate for `key` exists.
    pub ready: bool,
    /// Size of the intermediate files on disk (0 when not ready).
    pub bytes: u64,
    /// The manifest model (`None` when denoise is off or the model is unknown).
    pub model: Option<AiModelInfo>,
}

/// The `Denoise` settings and their manifest model, or a user-facing error.
fn denoise_settings(settings: &DevelopSettings) -> Result<(&Denoise, &'static ai::ModelEntry)> {
    let d = settings.detail.denoise.as_ref().ok_or_else(|| Error::Invalid("Denoise is off for this photo".into()))?;
    let entry = denoise::model_entry(d.model)
        .ok_or_else(|| Error::Invalid(format!("The {} denoise model is not available", denoise::model_name(d.model))))?;
    Ok((d, entry))
}

/// The denoise state of a photo for `settings`: its intermediate's key, whether it exists, its size, and the model.
#[tauri::command]
pub async fn denoise_status<R: Runtime>(app: AppHandle<R>, hash: String, settings: DevelopSettings) -> Result<DenoiseStatus> {
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let dir = models_dir(&app)?;
    let Some(d) = settings.detail.denoise.as_ref() else {
        return Ok(DenoiseStatus { key: None, ready: false, bytes: 0, model: None });
    };
    let model = denoise::model_entry(d.model).map(|e| ai_model_info(e, &dir));
    let key = denoise::denoise_key_for(&hash, d);
    let (ready, bytes) = match &key {
        Some(key) => {
            let path = intermediate_path(&entry_dir, key);
            let ready = denoise::intermediate_ready(&path, key);
            let size = |p: PathBuf| fs::metadata(p).map(|m| m.len()).unwrap_or(0);
            let bytes = if ready {
                let proxy = proxy_intermediate_path(&entry_dir, key);
                size(path.clone()) + size(denoise::sidecar_path(&path)) + size(proxy.clone()) + size(denoise::sidecar_path(&proxy))
            } else {
                0
            };
            (ready, bytes)
        }
        None => (false, 0),
    };
    Ok(DenoiseStatus { key, ready, bytes, model })
}

/// Denoise the photo at full resolution with `settings.detail.denoise` and write its intermediate (see the section
/// comment). Emits `develop:denoise-progress { job, done, total }` (tiles) and stops between tiles after
/// `cancel_denoise(job)`. An existing intermediate for the same key returns at once, unless `force` (workflow plan
/// 27: Shift + Denoise selected runs it again and replaces it). Afterwards the cached working proxy of the photo is
/// dropped, so the next preview decodes the intermediate.
#[tauri::command]
pub async fn run_denoise<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    job: u64,
    force: Option<bool>,
) -> Result<DenoiseOutcome> {
    let started = Instant::now();
    let (d, entry) = denoise_settings(&settings)?;
    let d = d.clone();
    let dir = models_dir(&app)?;
    if ai::status(entry, &dir) != ai::ModelStatus::Installed {
        return Ok(DenoiseOutcome::MissingModel { model: ai_model_info(entry, &dir) });
    }
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let key = denoise::denoise_key(&hash, &entry.name, &entry.version, d.luminance, d.chroma, d.sharpen, d.chroma_mode);
    let path = intermediate_path(&entry_dir, &key);
    let done = |meta: &denoise::IntermediateMeta, elapsed_ms: u64, engine: String, tiles: usize| {
        DenoiseOutcome::Done(DenoiseResult {
            key: key.clone(),
            path: path.to_string_lossy().into_owned(),
            width: meta.width,
            height: meta.height,
            elapsed_ms,
            engine,
            tiles,
        })
    };
    if !force.unwrap_or(false) {
        if let Some(meta) = denoise::read_intermediate_meta(&path).filter(|m| m.key == key && path.is_file()) {
            return Ok(done(&meta, 0, String::new(), 0));
        }
    }
    let cancel = app.state::<DenoiseState>().start(job);
    let permit = app.state::<DenoiseState>().runs.clone().acquire_owned().await.map_err(|e| Error::Invalid(e.to_string()));
    let app2 = app.clone();
    let key2 = key.clone();
    let outcome = match permit {
        Err(err) => Err(err),
        Ok(permit) => tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            let state = app2.state::<DenoiseState>();
            let start = Instant::now();
            let engine = match state.sessions(dir.clone()).engine(d.model) {
                Ok(engine) => engine,
                Err(ai::Error::NotInstalled(_)) => return Ok(Err(ai_model_info(entry, &dir))),
                Err(err) => return Err(ai_error(err)),
            };
            let load = ms(start);
            let start = Instant::now();
            let image = match state.take_full(&hash) {
                Some(image) => image,
                None => Arc::new(decode_source(&src, &entry_dir, None)?.0),
            };
            let decode = ms(start);
            let _ = app2.emit(EVENT_DENOISE_PROGRESS, DenoiseProgress { job, done: 0, total: 0 });
            let progress = |done: usize, total: usize| {
                let _ = app2.emit(EVENT_DENOISE_PROGRESS, DenoiseProgress { job, done, total });
            };
            let start = Instant::now();
            let denoised = denoise_into_cache(&engine, image, &d, &entry_dir, &key2, &progress, &cancel)?;
            let Some((meta, stats)) = denoised else { return Ok(Ok(None)) };
            // Other keys of these bytes may belong to another version still in use (a publish denoising both).
            let removed =
                denoise::prune_intermediates_keeping(&denoise_dir(&entry_dir), &[&key2], KEEP_DENOISE_KEYS - 1);
            app2.state::<DevelopJobs>().invalidate(&hash);
            let provider = engine.session().info().provider_summary();
            log::info!(
                "[photobook:develop] denoise {} {}x{} with {} ({provider}): load={load}ms decode={decode}ms \
                 tiles={}x{} inference={}ms post={}ms write={}ms, pruned {removed} old file(s)",
                src.file_name().unwrap_or_default().to_string_lossy(),
                meta.width,
                meta.height,
                engine.name,
                stats.tiles,
                stats.tile_size,
                stats.inference.as_millis(),
                stats.post.as_millis(),
                ms(start).saturating_sub(stats.total.as_millis())
            );
            Ok(Ok(Some((meta, provider, stats.tiles))))
        })
        .await
        .map_err(Error::from)
        .and_then(|r| r),
    };
    app.state::<DenoiseState>().finish(job);
    match outcome? {
        Ok(Some((meta, engine, tiles))) => Ok(done(&meta, started.elapsed().as_millis() as u64, engine, tiles)),
        Ok(None) => Ok(DenoiseOutcome::Cancelled),
        Err(model) => Ok(DenoiseOutcome::MissingModel { model }),
    }
}

/// Denoise `image` with `engine` tile by tile, then write the full-size intermediate and its 1600 px copy into
/// `entry_dir` for `key`. `None` when `cancel` was set, between tiles or once the model is done: nothing is written
/// then. Each file is written to a temp name and renamed, and a failed copy removes the full-size one, so a run leaves
/// a complete pair or no `denoise-<key>*` file at all.
fn denoise_into_cache(
    engine: &denoise::DenoiseEngine,
    image: Arc<LinearImage>,
    d: &Denoise,
    entry_dir: &Path,
    key: &str,
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<Option<(denoise::IntermediateMeta, denoise::DenoiseStats)>> {
    let run = denoise::denoise_with(engine, &image, d, &DenoiseOptions::default(), progress, cancel);
    let (out, stats) = match run {
        Ok(result) => result,
        Err(ai::Error::Cancelled) => return Ok(None),
        Err(err) => return Err(ai_error(err)),
    };
    drop(image);
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let path = intermediate_path(entry_dir, key);
    let proxy_path = proxy_intermediate_path(entry_dir, key);
    // Both files are written under staged names (`denoise-<key>[-proxy].staged.png` + `.staged.json`, which pruning
    // counts as the key's) and moved in only once both are complete, so a failed run, a forced re-run included (plan
    // 27), never removes a valid intermediate already there.
    let staged = |p: &Path| p.with_extension("staged.png");
    let (path_staged, proxy_staged) = (staged(&path), staged(&proxy_path));
    let discard = || {
        for p in [&path_staged, &proxy_staged] {
            let _ = fs::remove_file(denoise::sidecar_path(p));
            let _ = fs::remove_file(p);
        }
    };
    let meta = match denoise::write_intermediate(&path_staged, &out, key) {
        Ok(meta) => meta,
        Err(err) => {
            discard();
            return Err(ai_error(err));
        }
    };
    let (pw, ph) = fit(out.width, out.height, PROXY_EDGE);
    let proxy = photobook_develop::decode::resize_linear(out, pw, ph)
        .map_err(Error::from)
        .and_then(|proxy| denoise::write_intermediate(&proxy_staged, &proxy, key).map_err(ai_error));
    if let Err(err) = proxy {
        discard();
        return Err(err);
    }
    // PNGs before their sidecars: a sidecar with the key marks a complete file.
    let moved = (|| -> std::io::Result<()> {
        fs::rename(&proxy_staged, &proxy_path)?;
        fs::rename(denoise::sidecar_path(&proxy_staged), denoise::sidecar_path(&proxy_path))?;
        fs::rename(&path_staged, &path)?;
        fs::rename(denoise::sidecar_path(&path_staged), denoise::sidecar_path(&path))
    })();
    if let Err(err) = moved {
        discard();
        return Err(Error::Io(format!("move {} into place", path.display()), err));
    }
    Ok(Some((meta, stats)))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DenoiseProgress {
    job: u64,
    /// Tiles done; `0 / 0` once the model is loaded and the source decoded, before the first tile.
    done: usize,
    total: usize,
}

/// Stop the `run_denoise` job `job` before its next tile (it then returns `{ status: "cancelled" }`). False when no
/// such job is running yet; it is then stopped as soon as it starts.
#[tauri::command]
pub async fn cancel_denoise<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<bool> {
    Ok(app.state::<DenoiseState>().cancel(job))
}

/// The tuning preview: a 512 × 512 crop at 100 % of the upright, full-resolution source around `center`
/// (fractions of that frame, clamped so the crop stays inside), run once through `settings.detail.denoise`'s model
/// with its blend and sharpening (the sharpening radius of the full image), as a JPEG. `before: true` returns the
/// same crop without denoising. Both are rendered with default develop settings (no tone, colour or geometry from
/// `settings`), so they compare like for like. The full decode is cached for the next call on the same photo.
/// Errors with `missingModel: <name>` when the model is not installed.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn preview_denoise_crop<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    center: [f64; 2],
    before: Option<bool>,
) -> Result<Response> {
    let (d, entry) = denoise_settings(&settings)?;
    let d = d.clone();
    let before = before.unwrap_or(false);
    let dir = models_dir(&app)?;
    if !before && ai::status(entry, &dir) != ai::ModelStatus::Installed {
        return Err(Error::Invalid(format!("missingModel: {}", entry.name)));
    }
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let app2 = app.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<DenoiseState>();
        let start = Instant::now();
        let full = state.full_image(&hash, || Ok(decode_source(&src, &entry_dir, None)?.0))?;
        let decode = ms(start);
        let crop = crop_around(&full, center, DENOISE_CROP);
        let start = Instant::now();
        let out = if before {
            crop
        } else {
            let engine = state.sessions(dir).engine(d.model).map_err(|err| match err {
                ai::Error::NotInstalled(name) => Error::Invalid(format!("missingModel: {name}")),
                other => ai_error(other),
            })?;
            let opts = DenoiseOptions { reference_size: Some((full.width, full.height)) };
            let never = AtomicBool::new(false);
            let out = denoise::denoise_with(&engine, &crop, &d, &opts, &|_, _| {}, &never).map_err(ai_error)?.0;
            if d.chroma_mode == photobook_develop::settings::ChromaMode::Filter {
                // Workflow plan 24: the colour comes from the chroma filter at render time, guided by the denoised L.
                let sigma = crate::commands::noise::photo_filter_sigma(&src, &entry_dir);
                let strength = (d.chroma / 100.0) as f32;
                photobook_develop::ops::noise::chroma_filter_image(&out, sigma, strength, Some((full.width, full.height)))
            } else {
                out
            }
        };
        let run = ms(start);
        let rendered = Developer::new(out).render_with(&DevelopSettings::default(), &RenderOptions::for_image(&full.meta));
        let bytes = encode_jpeg(&rendered, DENOISE_CROP_QUALITY)?;
        log::info!(
            "[photobook:develop] denoise crop {}x{} at {center:?}{} decode={decode}ms run={run}ms",
            rendered.width,
            rendered.height,
            if before { " (before)" } else { "" }
        );
        Ok::<_, Error>(bytes)
    })
    .await??;
    Ok(Response::new(bytes))
}

/// A `size × size` crop (smaller when the image is) of `image` centred on `center` (fractions), kept inside.
fn crop_around(image: &LinearImage, center: [f64; 2], size: u32) -> LinearImage {
    let (cw, ch) = (size.min(image.width), size.min(image.height));
    let origin = |c: f64, len: u32, crop: u32| -> u32 {
        let c = if c.is_finite() { c.clamp(0.0, 1.0) } else { 0.5 };
        ((c * len as f64 - crop as f64 / 2.0).round().max(0.0) as u32).min(len - crop)
    };
    let (x0, y0) = (origin(center[0], image.width, cw), origin(center[1], image.height, ch));
    let mut data = Vec::with_capacity(cw as usize * ch as usize * 3);
    for y in y0..y0 + ch {
        let row = image.row(y);
        data.extend_from_slice(&row[x0 as usize * 3..(x0 + cw) as usize * 3]);
    }
    LinearImage::new(cw, ch, data).with_meta(image.meta.clone())
}

#[cfg(test)]
mod denoise_tests {
    use super::*;

    fn settings_with_denoise() -> DevelopSettings {
        serde_json::from_str(r#"{"version":1,"detail":{"denoise":{"model":"nafnet-w32","luminance":40}}}"#).unwrap()
    }

    const APP_MODELS_DIR: &str = "Library/Application Support/com.photobook.editor/models";

    /// The installed NAFNet (w32) on the CPU; `None` (the caller skips) when it is not downloaded on this computer.
    fn installed_nafnet() -> Option<denoise::DenoiseEngine> {
        let dir = match std::env::var_os("PHOTOBOOK_MODELS_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => PathBuf::from(std::env::var_os("HOME")?).join(APP_MODELS_DIR),
        };
        let dir = ModelDir::new(dir);
        let entry = denoise::model_entry(photobook_develop::settings::DenoiseModel::NafnetW32)?;
        if ai::status(entry, &dir) != ai::ModelStatus::Installed {
            eprintln!("NAFNet (w32) is not installed; skipping");
            return None;
        }
        Some(denoise::DenoiseEngine::load_with(entry, &dir, &ai::SessionOptions::for_model(entry, &dir).cpu()).unwrap())
    }

    #[test]
    fn a_denoise_cancelled_mid_tile_leaves_no_intermediate() {
        let Some(engine) = installed_nafnet() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let hash = "cd".repeat(32);
        let entry = tmp.path().join(&hash);
        let dir = denoise_dir(&entry);
        let d = settings_with_denoise().detail.denoise.unwrap();
        let key = denoise::denoise_key_for(&hash, &d).unwrap();
        // Wider than one tile, so the run has a tile after the one it is cancelled on.
        let (w, h) = (engine.tile as u32 + 64, 96);
        let image = Arc::new(LinearImage::new(w, h, (0..w * h * 3).map(|i| (i % 97) as f32 / 97.0).collect()));
        let names = || -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(&dir)
                .map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            names.sort();
            names
        };

        let cancel = AtomicBool::new(false);
        let tiles = std::cell::Cell::new((0, 0));
        let progress = |done: usize, total: usize| {
            tiles.set((done, total));
            cancel.store(true, Ordering::Relaxed);
        };
        let run = denoise_into_cache(&engine, image.clone(), &d, &entry, &key, &progress, &cancel).unwrap();
        assert!(run.is_none());
        let (done, total) = tiles.get();
        assert!(done == 1 && total > 1, "cancelled after tile {done} of {total}");
        assert!(names().is_empty(), "left {:?}", names());

        // Run through: the full-size intermediate, its copy and their sidecars, and no temp file.
        let never = AtomicBool::new(false);
        let (meta, _) = denoise_into_cache(&engine, image, &d, &entry, &key, &|_, _| {}, &never).unwrap().unwrap();
        assert_eq!((meta.width, meta.height), (w, h));
        assert!(denoise::intermediate_ready(&intermediate_path(&entry, &key), &key));
        let expected: Vec<String> = {
            let mut v = vec![
                format!("denoise-{key}-proxy.json"),
                format!("denoise-{key}-proxy.png"),
                format!("denoise-{key}.json"),
                format!("denoise-{key}.png"),
            ];
            v.sort();
            v
        };
        assert_eq!(names(), expected);
    }

    #[test]
    fn a_cancel_before_the_denoise_registers_stops_it_when_it_does() {
        let state = DenoiseState::default();
        assert!(!state.cancel(5), "not running yet");
        assert!(state.start(5).load(Ordering::Relaxed), "starts cancelled");
        assert!(!state.start(6).load(Ordering::Relaxed));
        assert!(state.cancel(6));
        state.finish(5);
        state.finish(6);
        // Consumed once: the same id starting again runs.
        assert!(!state.start(5).load(Ordering::Relaxed));
        let pending = PendingCancels::default();
        for job in 0..(MAX_CANCELLED as u64 + 10) {
            pending.remember(job);
        }
        assert!(!pending.take(0), "the oldest requests are dropped");
        assert!(pending.take(MAX_CANCELLED as u64 + 9));
    }

    #[test]
    fn crops_stay_inside_the_frame() {
        let img = LinearImage::new(1000, 600, (0..1000 * 600 * 3).map(|i| i as f32).collect());
        let c = crop_around(&img, [0.5, 0.5], 512);
        assert_eq!((c.width, c.height), (512, 512));
        assert_eq!(c.pixel(0, 0), img.pixel(244, 44));
        let corner = crop_around(&img, [1.0, 0.0], 512);
        assert_eq!(corner.pixel(511, 0), img.pixel(999, 0));
        let small = LinearImage::new(100, 50, vec![0.5; 100 * 50 * 3]);
        let s = crop_around(&small, [f64::NAN, 2.0], 512);
        assert_eq!((s.width, s.height), (100, 50));
    }

    #[test]
    fn the_intermediate_replaces_the_source_once_it_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let hash = "ab".repeat(32);
        let entry = tmp.path().join(&hash);
        fs::create_dir_all(&entry).unwrap();
        let plain = DevelopSettings::default();
        assert_eq!(choose_input(&entry, &plain), InputChoice { input: Input::Source, stale: false });
        let settings = settings_with_denoise();
        assert_eq!(choose_input(&entry, &settings), InputChoice { input: Input::Source, stale: true });
        let dh = develop_hash(&settings);
        let out = OutputProfile::default();
        let key = denoise::denoise_key_for(&hash, settings.detail.denoise.as_ref().unwrap()).unwrap();
        let img = LinearImage::new(40, 20, vec![0.25; 40 * 20 * 3]);
        denoise::write_intermediate(&intermediate_path(&entry, &key), &img, &key).unwrap();
        let choice = choose_input(&entry, &settings);
        assert_eq!(choice, InputChoice { input: Input::Denoised { key: key.clone() }, stale: false });
        // A cached render made from the source while stale, finishing after the intermediate was written (a render
        // that started before it): newer than the intermediate, still not made from it.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let source = Developer::new(LinearImage::new(40, 20, vec![0.5; 40 * 20 * 3]));
        write_cached(&entry, &source, &settings, &dh, out, &Input::Source).unwrap();
        assert!(rendered_before_denoise(&entry, &dh, out, &choice));
        assert!(cached_render_for(&entry, &dh, out, &choice).is_none());
        // Once rendered from the intermediate, it is a hit (and a stale choice takes whatever is cached).
        write_cached(&entry, &source, &settings, &dh, out, &choice.input).unwrap();
        assert!(!rendered_before_denoise(&entry, &dh, out, &choice));
        assert!(cached_render_for(&entry, &dh, out, &choice).is_some());
        let stale = InputChoice { input: Input::Source, stale: true };
        assert_eq!(cached_render_for(&entry, &dh, out, &stale).unwrap().denoise_stale, Some(true));
        // The working proxy and the full render decode it.
        let src = tmp.path().join("missing.jpg");
        let proxy = decode_input(&entry, &src, &choice.input).unwrap();
        assert_eq!((proxy.width, proxy.height), (40, 20));
        let (full, exif) = decode_full_input(&src, &entry, &settings).unwrap();
        assert_eq!((full.width, full.height, exif), (40, 20, Some(src.clone())));
        // The cache keeps one proxy per photo and replaces it when the input changes.
        let jobs = DevelopJobs::default();
        let (_, decoded) = jobs.developer_with(&hash, &entry, &src, true, Some(&choice.input)).unwrap();
        assert!(decoded);
        assert!(!jobs.developer_with(&hash, &entry, &src, true, Some(&choice.input)).unwrap().1);
        assert!(!jobs.developer(&hash, &entry, &src, true).unwrap().1, "any input is fine without settings");
        jobs.invalidate(&hash);
        assert!(jobs.cached_developer(&hash, None).is_none());
    }

    /// Workflow plan 24: a render that runs the chroma filter measures the photo's noise first (once) and keys the
    /// filter on it; a render without it never measures.
    #[test]
    fn the_chroma_filter_gets_the_photos_sigma() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("noisy.jpg");
        let (w, h) = (320u32, 240u32);
        let mut s = 7u32;
        let data: Vec<u8> = (0..w * h * 3)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (110 + (s >> 27) as i32 - 16) as u8
            })
            .collect();
        fs::write(&src, photobook_develop::encode_jpeg(&photobook_develop::Rgb8Image::new(w, h, data), 92).unwrap()).unwrap();
        let hash = "ab".repeat(32);
        let entry = tmp.path().join(&hash);
        fs::create_dir_all(&entry).unwrap();
        let jobs = DevelopJobs::default();
        let plain = DevelopSettings::default();
        let (developer, _) = jobs.developer_for(&hash, &entry, &src, true, &Input::Source, &plain).unwrap();
        assert_eq!(developer.image().meta.noise_sigma, None);
        assert!(!entry.join(crate::commands::noise::NOISE_FILE).exists(), "nothing measured without the filter");
        let settings = settings_with_denoise();
        assert!(needs_noise_sigma(&settings));
        let (developer, decoded) = jobs.developer_for(&hash, &entry, &src, true, &Input::Source, &settings).unwrap();
        assert!(decoded, "decoded again with σ");
        let record = crate::commands::noise::read_record(&entry).expect("measured");
        assert_eq!(developer.image().meta.noise_sigma, Some(crate::commands::noise::filter_sigma(&record)));
        assert!(!jobs.developer_for(&hash, &entry, &src, true, &Input::Source, &settings).unwrap().1);
        let (full, _) = decode_full_input(&src, &entry, &settings).unwrap();
        assert_eq!(full.meta.noise_sigma, developer.image().meta.noise_sigma);

        // A cached render records its σ; when `noise.json` changes, the proxy is decoded again and the render redone.
        let (dh, out, choice) = (develop_hash(&settings), OutputProfile::default(), choose_input(&entry, &settings));
        write_cached(&entry, &developer, &settings, &dh, out, &Input::Source).unwrap();
        assert!(cached_render_checked(&entry, &dh, out, &choice, &settings).is_some());
        let mut changed = record.clone();
        changed.fit.sigma *= 2.0;
        changed.fit.confidence = 1.0;
        fs::write(entry.join(crate::commands::noise::NOISE_FILE), serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(cached_render_checked(&entry, &dh, out, &choice, &settings).is_none());
        let (developer, decoded) = jobs.developer_for(&hash, &entry, &src, true, &Input::Source, &settings).unwrap();
        assert!(decoded);
        assert_eq!(developer.image().meta.noise_sigma, Some(crate::commands::noise::filter_sigma(&changed)));
    }

    #[test]
    fn outcomes_serialise_for_the_ui() {
        let cancelled = serde_json::to_value(DenoiseOutcome::Cancelled).unwrap();
        assert_eq!(cancelled, serde_json::json!({ "status": "cancelled" }));
        let done = DenoiseOutcome::Done(DenoiseResult {
            key: "k".into(),
            path: "/p".into(),
            width: 2,
            height: 1,
            elapsed_ms: 5,
            engine: "CPU".into(),
            tiles: 1,
        });
        assert_eq!(
            serde_json::to_value(done).unwrap(),
            serde_json::json!({ "status": "done", "key": "k", "path": "/p", "width": 2, "height": 1, "elapsedMs": 5,
                "engine": "CPU", "tiles": 1 })
        );
        let entry = denoise::model_entry(photobook_develop::settings::DenoiseModel::NafnetW32).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let missing = DenoiseOutcome::MissingModel { model: ai_model_info(entry, &ModelDir::new(tmp.path())) };
        let v = serde_json::to_value(missing).unwrap();
        assert_eq!(v["status"], "missingModel");
        assert_eq!(v["model"]["name"], "nafnet-sidd-width32");
        assert_eq!(v["model"]["bytes"], 117_115_760);
        assert_eq!(v["model"]["licence"], "MIT");
        assert_eq!(v["model"]["status"], serde_json::json!({ "state": "missing" }));
    }
}

// ---------------------------------------------------------------------------------------------
// AI masks (step D4.3)
//
// - `generate_ai_mask(folder, relPath, hash, geometry, component, job)` runs an AI component's models
//   (`photobook_develop::ai::segment::generate`) on the photo's 1600 px proxy, turned as `geometry.rotate`/`flipH`/
//   `flipV` say, refines the result against the picture and writes it to
//   `<appdata>/cache/<hash>/develop/masks/<componentHash>.png` (depth: the depth map, `depth-<model>-<version>.png`).
//   Progress: `develop:ai-progress { job, stage: "loading" | "running" | "refining" }`. When a model is not
//   installed it returns at once with `missingModels` (name, size, licence) and no path.
// - `sam_refine_mask(...)`: the same for a component with click/box `prompts` (SAM 2.1); the image encoding is kept
//   for the current photo and rotation, so further clicks only run the decoder.
// - `ai_mask_status(hash, components)`: which components have a raster (or, for depth, a depth map) on disk.
// - `release_ai_masks()`: drop the loaded sessions and the SAM encoding (call when leaving Develop).
//
// Rasters live on the decoded picture's grid (before rotate/flip/crop), so they follow the content through any
// geometry change; every render (`render_develop_*`, the overlay, full renders) reads them through
// `photobook_develop::masks::ai_cache` and an AI component without a raster counts as 0.

pub const EVENT_AI_PROGRESS: &str = "develop:ai-progress";

/// The AI rasters of every photo, in memory (bounded) over the PNG files.
fn ai_raster_cache() -> &'static Arc<photobook_develop::masks::ai_cache::AiRasterCache> {
    static CACHE: std::sync::OnceLock<Arc<photobook_develop::masks::ai_cache::AiRasterCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The AI raster source of the photo whose cache folder is `entry_dir`.
fn ai_rasters_for(entry_dir: &Path) -> Arc<dyn photobook_develop::masks::ai_cache::AiRasterSource> {
    use photobook_develop::masks::ai_cache::{masks_dir, ImageRasters};
    Arc::new(ImageRasters::new(ai_raster_cache().clone(), masks_dir(entry_dir)))
}

/// How many AI components of the masks a render applies (enabled, with an adjustment) have no raster cached for the
/// photo whose cache folder is `entry_dir`. A full render would leave them out (they count as 0) and its file, named
/// by the develop hash alone, would then be published and kept as if it were complete.
pub(crate) fn missing_ai_rasters(entry_dir: &Path, settings: &DevelopSettings) -> usize {
    use photobook_develop::settings::{LocalAdjustments, MaskShape};
    let dir = photobook_develop::masks::ai_cache::masks_dir(entry_dir);
    settings
        .masks
        .iter()
        .filter(|m| m.enabled && m.adjustments != LocalAdjustments::default())
        .flat_map(|m| &m.components)
        .filter(|c| matches!(c.shape, MaskShape::Ai { .. }) && !ai_raster_cache().exists(&dir, c))
        .count()
}

/// Let `developer`'s renders read the photo's AI rasters.
fn attach_ai_rasters(developer: &Developer, entry_dir: &Path) {
    developer.set_ai_rasters(Some(ai_rasters_for(entry_dir)));
}

/// Loaded mask models and the current photo's SAM encoding, kept while the Develop view is open.
pub struct AiMaskState {
    sessions: photobook_develop::ai::segment::Sessions,
    sam: photobook_develop::ai::segment::LastSamEncoding,
    /// One mask job at a time (the models share the Neural Engine and every core).
    runs: Arc<Semaphore>,
}

impl Default for AiMaskState {
    fn default() -> Self {
        Self { sessions: Default::default(), sam: Default::default(), runs: Arc::new(Semaphore::new(1)) }
    }
}

/// A model an AI mask needs that is not installed: what the UI shows in its download prompt.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub name: String,
    pub title: String,
    pub version: String,
    /// Download size (all files).
    pub bytes: u64,
    pub licence: String,
    pub licence_url: String,
    pub status: ai::ModelStatus,
}

fn ai_model_info(entry: &ai::ModelEntry, dir: &ModelDir) -> AiModelInfo {
    AiModelInfo {
        name: entry.name.clone(),
        title: entry.title.clone(),
        version: entry.version.clone(),
        bytes: entry.total_bytes(),
        licence: entry.licence.clone(),
        licence_url: entry.licence_url.clone(),
        status: ai::status(entry, dir),
    }
}

/// What `generate_ai_mask` and `sam_refine_mask` return.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiMaskResult {
    /// `component_hash` of `component`: the raster's file name.
    pub component_hash: String,
    /// The PNG written (the depth map for a depth component); `None` when a model is missing.
    pub path: Option<String>,
    /// Raster size (the proxy's decoded size); 0 when a model is missing.
    pub width: u32,
    pub height: u32,
    /// The primary model's version (also in `component`).
    pub model_version: String,
    /// The component with `model` and `modelVersion` set to what generated it: store this one in the settings
    /// (its hash is `componentHash`).
    pub component: photobook_develop::settings::MaskComponent,
    /// Models to download first (empty when everything ran).
    pub missing_models: Vec<AiModelInfo>,
    /// People: the boxes found, as box prompts in the transformed frame (fractions), highest score first.
    pub people: Vec<[photobook_develop::settings::Point; 2]>,
    /// Share of the raster at or above 0.5, 0..1.
    pub coverage: f32,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiProgressEvent<'a> {
    job: u64,
    stage: &'a str,
}

/// Run an AI component's models and cache the raster (see the section comment).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn generate_ai_mask<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    geometry: photobook_develop::settings::Geometry,
    component: photobook_develop::settings::MaskComponent,
    job: u64,
) -> Result<AiMaskResult> {
    run_ai_mask(app, folder, rel_path, hash, geometry, component, job, false).await
}

/// Click-to-refine: an AI component with `prompts` (points and boxes in transformed-frame fractions) through SAM
/// 2.1, reusing the photo's cached image encoding. Errors when the component has no prompt.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sam_refine_mask<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    geometry: photobook_develop::settings::Geometry,
    component: photobook_develop::settings::MaskComponent,
    job: u64,
) -> Result<AiMaskResult> {
    run_ai_mask(app, folder, rel_path, hash, geometry, component, job, true).await
}

#[allow(clippy::too_many_arguments)]
async fn run_ai_mask<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    geometry: photobook_develop::settings::Geometry,
    component: photobook_develop::settings::MaskComponent,
    job: u64,
    require_prompts: bool,
) -> Result<AiMaskResult> {
    use photobook_develop::ai::segment::{missing_models, stamp_model_in, uses_prompts};
    use photobook_develop::masks::component_hash;
    use photobook_develop::settings::MaskShape;

    let MaskShape::Ai { .. } = &component.shape else {
        return Err(Error::Invalid("not an AI mask component".into()));
    };
    if require_prompts && !uses_prompts(&component) {
        return Err(Error::Invalid("the component has no click or box prompt".into()));
    }
    let dir = models_dir(&app)?;
    let stamped = stamp_model_in(&component, Some(&dir));
    let model_version = match &stamped.shape {
        MaskShape::Ai { model_version, .. } => model_version.clone(),
        _ => String::new(),
    };
    let missing = missing_models(&component, &dir);
    if !missing.is_empty() {
        return Ok(AiMaskResult {
            component_hash: component_hash(&stamped),
            path: None,
            width: 0,
            height: 0,
            model_version,
            component: stamped,
            missing_models: missing.iter().map(|m| ai_model_info(m, &dir)).collect(),
            people: Vec::new(),
            coverage: 0.0,
            elapsed_ms: 0,
        });
    }
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let masks_dir = ensure_allowed(&app, photobook_develop::masks::ai_cache::masks_dir(&entry_dir))?;
    let runs = app.state::<AiMaskState>().runs.clone();
    let permit = runs.acquire_owned().await.map_err(|err| Error::Invalid(err.to_string()))?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let start = Instant::now();
        let (developer, _) = app2.state::<DevelopJobs>().developer(&hash, &entry_dir, &src, true)?;
        let state = app2.state::<AiMaskState>();
        let progress = |stage: photobook_develop::ai::segment::Stage| {
            let _ = app2.emit(EVENT_AI_PROGRESS, AiProgressEvent { job, stage: stage.as_str() });
        };
        let ctx = photobook_develop::ai::segment::GenerateContext {
            image: developer.image(),
            image_id: &hash,
            geometry: &geometry,
            models: &dir,
            sessions: &state.sessions,
            sam: Some(&state.sam),
            progress: &progress,
        };
        let generated = photobook_develop::ai::segment::generate(&component, &ctx).map_err(ai_error)?;
        let cache = ai_raster_cache();
        let path = match (&generated.depth, &generated.component.shape) {
            (Some(depth), MaskShape::Ai { model, model_version, .. }) => {
                cache.put_depth(&masks_dir, model, model_version, &depth.depth)
            }
            _ => cache.put(&masks_dir, &generated.component, &generated.raster),
        }
        .ctx(format!("writing the mask raster in {}", masks_dir.display()))?;
        let raster = &generated.raster;
        let coverage = raster.data.iter().filter(|&&v| v >= 0.5).count() as f32 / raster.data.len().max(1) as f32;
        let runs: Vec<String> =
            generated.timings.iter().map(|(n, d)| format!("{n} {}ms", d.as_millis())).collect();
        log::info!(
            "[photobook:develop] ai mask job={job} {} {}x{} coverage={:.1}% in {}ms ({})",
            component_hash(&generated.component),
            raster.width,
            raster.height,
            coverage * 100.0,
            ms(start),
            runs.join(", ")
        );
        Ok(AiMaskResult {
            component_hash: component_hash(&generated.component),
            path: Some(path.to_string_lossy().into_owned()),
            width: raster.width,
            height: raster.height,
            model_version,
            component: generated.component,
            missing_models: Vec::new(),
            people: generated.people,
            coverage,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    })
    .await?
}

/// For each component, whether its AI raster (for depth, the depth map of its model version) exists for the photo
/// `hash`. Non-AI components are `false`.
#[tauri::command]
pub async fn ai_mask_status<R: Runtime>(
    app: AppHandle<R>,
    hash: String,
    components: Vec<photobook_develop::settings::MaskComponent>,
) -> Result<Vec<bool>> {
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let dir = photobook_develop::masks::ai_cache::masks_dir(&entry_dir);
    Ok(components.iter().map(|c| ai_raster_cache().exists(&dir, c)).collect())
}

/// Drop the loaded mask models and the SAM encoding (frees their memory; the next mask loads them again).
#[tauri::command]
pub async fn release_ai_masks<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    let state = app.state::<AiMaskState>();
    state.sessions.clear();
    state.sam.clear();
    Ok(())
}

#[cfg(test)]
mod ai_mask_tests {
    use super::*;

    #[test]
    fn results_serialise_for_the_ui() {
        let component: photobook_develop::settings::MaskComponent = serde_json::from_value(serde_json::json!({
            "id": "c", "kind": "ai", "target": "sky", "model": "", "modelVersion": ""
        }))
        .unwrap();
        let stamped = photobook_develop::ai::segment::stamp_model(&component);
        let tmp = tempfile::tempdir().unwrap();
        let entry = ai::registry().get("skywater-seg").unwrap();
        let result = AiMaskResult {
            component_hash: photobook_develop::masks::component_hash(&stamped),
            path: None,
            width: 0,
            height: 0,
            model_version: entry.version.clone(),
            component: stamped,
            missing_models: vec![ai_model_info(entry, &ModelDir::new(tmp.path()))],
            people: vec![[[0.1, 0.2], [0.3, 0.4]]],
            coverage: 0.0,
            elapsed_ms: 0,
        };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v["component"]["model"], "skywater-seg");
        assert_eq!(v["component"]["modelVersion"], entry.version.as_str());
        assert_eq!(v["modelVersion"], entry.version.as_str());
        assert_eq!(v["missingModels"][0]["licenceUrl"], entry.licence_url.as_str());
        assert_eq!(v["missingModels"][0]["status"], serde_json::json!({ "state": "missing" }));
        assert_eq!(v["people"], serde_json::json!([[[0.1, 0.2], [0.3, 0.4]]]));
        assert!(v["path"].is_null());
        let event = serde_json::to_value(AiProgressEvent { job: 3, stage: "running" }).unwrap();
        assert_eq!(event, serde_json::json!({ "job": 3, "stage": "running" }));
    }

    #[test]
    fn full_renders_need_the_rasters_of_the_masks_they_apply() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("f".repeat(64));
        let mut settings: DevelopSettings = serde_json::from_value(serde_json::json!({
            "version": 1,
            "masks": [{
                "id": "m", "name": "Sky", "adjustments": { "exposure": -1 },
                "components": [
                    { "id": "a", "kind": "ai", "target": "sky", "model": "skywater-seg", "modelVersion": "v" },
                    { "id": "r", "kind": "radial", "center": [0.5, 0.5], "radii": [0.2, 0.2], "angle": 0 }
                ]
            }]
        }))
        .unwrap();
        assert_eq!(missing_ai_rasters(&entry, &settings), 1);
        // Masks that cannot change a pixel do not need theirs.
        settings.masks[0].enabled = false;
        assert_eq!(missing_ai_rasters(&entry, &settings), 0);
        settings.masks[0].enabled = true;
        let dir = photobook_develop::masks::ai_cache::masks_dir(&entry);
        let plane = photobook_develop::masks::MaskPlane::filled(8, 4, 1.0);
        ai_raster_cache().put(&dir, &settings.masks[0].components[0], &plane).unwrap();
        assert_eq!(missing_ai_rasters(&entry, &settings), 0);
    }

    #[test]
    fn developers_read_rasters_from_the_entry_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = tmp.path().join("e".repeat(64));
        let component: photobook_develop::settings::MaskComponent = serde_json::from_value(serde_json::json!({
            "id": "c", "kind": "ai", "target": "subject", "model": "birefnet-lite", "modelVersion": "v"
        }))
        .unwrap();
        let source = ai_rasters_for(&entry);
        assert!(source.raster(&component).is_none());
        let plane = photobook_develop::masks::MaskPlane::filled(8, 4, 1.0);
        let dir = photobook_develop::masks::ai_cache::masks_dir(&entry);
        ai_raster_cache().put(&dir, &component, &plane).unwrap();
        assert_eq!(source.raster(&component).unwrap().width, 8);
        assert!(dir.join(format!("{}.png", photobook_develop::masks::component_hash(&component))).is_file());
    }
}

// ---------- Look thumbnails (workflow plan 20): `develop/looks.rs` ----------
pub mod looks;

// ---------- The Photo pane's histogram (plan 52): `develop/histogram.rs` ----------
pub mod histogram;
