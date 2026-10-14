//! Export from Develop (workflow plan 11): developed photos leave the app as new files. The source is never written.
//!
//! - `export_photo(item, options, presetHash, skipExported, job)` exports one photo: it develops it at full resolution
//!   exactly as a full render does (`develop::develop_full_image`), fits and sharpens it and encodes it
//!   (`photobook_develop::export`) into the folder's export cache
//!   `<folder>/.photobook-cache/export/<presetHash>/<hash>-<developHash>.<ext>`, then copies the cache entry to
//!   `<destDir>/<name>` with the cache entry's modification time. A cache hit is copied without encoding; with
//!   `skipExported` a destination file of the cache entry's size and time is left alone. Each step is reported on
//!   `export:progress`; `cancel_develop(job)` (the full-render cancel) stops it after the decode or the render, and
//!   nothing is written: every file goes to a temp name renamed when complete.
//! - `export_status(items, presetHash, format)` says which photos are cached and already exported (the dialog's count).
//! - `check_export_dest(dir)` resolves a destination: inside an imported folder or app data (`ensure_allowed`), or a
//!   folder picked in the native dialog this session (the dialog plugin adds it to the fs scope). The scope is not
//!   widened: a picked folder never becomes an imported root.
//! - `reveal_export(path)` shows an exported file (or its folder) in the Finder.
//! - `list_export_presets`, `save_export_preset(preset)`, `delete_export_preset(id)`: the user's presets, one file each
//!   in `<appdata>/export-presets/<ULID>.json` (the Zod `ExportPresetSchema` is the contract; Rust checks the id, the
//!   name and the size). The built-in presets live in `packages/shared/src/export.ts`.
//!
//! Workflow plan 12: TIFF and HEIC are developed into 16 bits per channel (`develop::develop_full_image16`); a
//! watermark image is read from `<appdata>/watermarks/<sha256>.png` (`import_watermark(path)` copies a PNG picked in the
//! dialog there and returns its id); `Original` copies the source file byte for byte to the destination (no cache)
//! and writes `<name>.xmp` next to it, our packet plus the Lightroom `crs:` fields (`xmp::export_sidecar`).
//! `export_capabilities()` says whether HEIC can be written (macOS).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime};

use photobook_develop::export::{self as px, ExportAssets, ExportFormat, ExportFrame, ExportOptions, WatermarkKind};
use photobook_develop::{develop_hash, DevelopSettings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::commands::assets::{cache_entry_dir, cache_root, resolve_rel, source_root, write_atomic, SOURCE_CACHE_DIR};
use crate::commands::develop::{
    denoise_pending, develop_full_image, develop_full_image16, missing_ai_rasters, render_permit, DevelopJobs, FullImage,
    CANCELLED,
};
use crate::commands::xmp::export_sidecar;
use crate::commands::presets::is_ulid;
use crate::error::{Error, IoContext, Result};
use crate::scope::{app_data_dir, ensure_allowed, normalize};

pub const EVENT_EXPORT_PROGRESS: &str = "export:progress";
/// `<folder>/.photobook-cache/export/`.
const EXPORT_DIR: &str = "export";
/// `<appdata>/export-presets/`.
const PRESETS_DIR: &str = "export-presets";
/// `<appdata>/watermarks/<sha256>.png`: imported watermark images, by content.
const WATERMARKS_DIR: &str = "watermarks";
/// Largest watermark PNG imported.
const MAX_WATERMARK_BYTES: u64 = 32 * 1024 * 1024;
/// Largest preset file read or written.
const MAX_PRESET_BYTES: u64 = 64 * 1024;
const MAX_PRESET_NAME: usize = 80;
/// Cache entries kept per photo and preset hash (the newest develop hashes: the current edit, versions, an undo).
const KEEP_PER_PHOTO: usize = 3;
/// How far apart a destination file's time may be from its cache entry's and still count as the same export (file
/// systems that keep two-second times, e.g. exFAT on a card).
const SAME_TIME_SLACK_MS: u128 = 2000;

/// One photo to export.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    /// The imported folder (absolute), as for the develop commands.
    pub folder: String,
    pub rel_path: String,
    pub hash: String,
    pub settings: DevelopSettings,
    /// Absolute destination folder (created when missing).
    pub dest_dir: String,
    /// File name in `dest_dir`, with the format's extension (the source's for Original).
    pub name: String,
    /// The file's EXIF orientation and upright size, for the `crs:` part of an Original export's sidecar.
    #[serde(default)]
    pub orientation: Option<u8>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The exported file.
    pub path: String,
    pub bytes: u64,
    /// Encoded now (false: copied from the cache, or skipped).
    pub encoded: bool,
    /// The destination already held this export; nothing was written.
    pub skipped: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job: u64,
    /// `decode`, `render`, `encode` or `copy`.
    stage: &'a str,
}

/// One photo of `export_status`.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusItem {
    pub folder: String,
    /// The source, for an Original export (compared with the destination; there is no cache).
    #[serde(default)]
    pub rel_path: Option<String>,
    pub hash: String,
    pub develop_hash: String,
    pub dest_dir: String,
    pub name: String,
    /// For an Original export: the edit and the file's orientation and size, so "already exported" also means the
    /// sidecar there has exactly this content.
    #[serde(default)]
    pub settings: Option<DevelopSettings>,
    #[serde(default)]
    pub orientation: Option<u8>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportState {
    /// The export cache has this photo with these settings: exporting it is a copy.
    pub cached: bool,
    /// The destination file is that cache entry (same size, written after it): with skip on it is left alone.
    pub exported: bool,
    /// A file that is not an export of this photo with these options is at the destination: exporting replaces it,
    /// which the dialog asks to confirm.
    pub replaces: bool,
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn export_photo<R: Runtime>(
    app: AppHandle<R>,
    item: ExportItem,
    options: ExportOptions,
    preset_hash: String,
    skip_exported: bool,
    replace: bool,
    job: u64,
) -> Result<ExportResult> {
    let outcome = export_photo_inner(&app, item, options, preset_hash, skip_exported, replace, job).await;
    // A cancel that came after the last checkpoint has nothing left to stop.
    app.state::<DevelopJobs>().take_cancel(job);
    outcome
}

async fn export_photo_inner<R: Runtime>(
    app: &AppHandle<R>,
    item: ExportItem,
    options: ExportOptions,
    preset_hash: String,
    skip_exported: bool,
    replace: bool,
    job: u64,
) -> Result<ExportResult> {
    // The cache folder is named after the hash: it must be the hash of the options used.
    let expected = px::preset_hash(&options);
    if preset_hash != expected {
        return Err(Error::Invalid(format!(
            "Export preset hash {preset_hash:?} does not match its options ({expected}); the editor and the app disagree"
        )));
    }
    let cancelled = {
        let app = app.clone();
        move || app.state::<DevelopJobs>().cancel_requested(job)
    };
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let root = source_root(app, &item.folder)?;
    let src = resolve_rel(app, &root, &item.rel_path)?;
    if options.format == ExportFormat::Original {
        let dest = check_dest(app, &item.dest_dir)?.join(checked_name(&item.name, &source_ext(&src))?);
        let app2 = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let report = |stage: &str| emit(&app2, job, stage);
            export_original(&src, &dest, &item, skip_exported, replace, &cancelled, &report)
        })
        .await?;
    }
    if options.format == ExportFormat::Heic && !px::heic_supported() {
        return Err(Error::Invalid("HEIC export needs macOS; choose another format".into()));
    }
    if options.format == ExportFormat::Avif && options.colour != photobook_develop::OutputProfile::Srgb {
        return Err(Error::Invalid("AVIF export is sRGB only; choose sRGB or another format".into()));
    }
    let entry_dir = ensure_allowed(app, cache_entry_dir(&cache_root(app)?, &item.hash)?)?;
    let cache = ensure_allowed(app, cache_path(&root, &preset_hash, &item.hash, &develop_hash(&item.settings), options.format)?)?;
    let dest = check_dest(app, &item.dest_dir)?.join(checked_name(&item.name, options.format.extension())?);
    let assets = export_assets(app, &options)?;
    let plan = Plan { src, entry_dir, cache, dest, skip_exported, replace, assets };
    if plan.cache.is_file() {
        // A copy: no render permit needed.
        let app2 = app.clone();
        let report = move |stage: &str| emit(&app2, job, stage);
        return tauri::async_runtime::spawn_blocking(move || {
            export_one(&plan, &item.settings, &options, &cancelled, &report, &|| {})
        })
        .await?;
    }
    let missing = missing_ai_rasters(&plan.entry_dir, &item.settings);
    if missing > 0 {
        return Err(Error::Invalid(format!(
            "{missing} AI mask component(s) have no mask on this computer yet; open the photo in Develop and regenerate them"
        )));
    }
    let permit = render_permit(app).await?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The render lane is held for the develop only: the encode (an AVIF takes seconds) runs outside it.
        let permit = std::sync::Mutex::new(Some(permit));
        let release = || drop(permit.lock().ok().and_then(|mut p| p.take()));
        let report = |stage: &str| emit(&app2, job, stage);
        export_one(&plan, &item.settings, &options, &cancelled, &report, &release)
    })
    .await?
}

/// Which photos of an export are cached with these options and already at their destination, in order. A photo whose
/// folder or destination is out of scope counts as neither.
#[tauri::command]
pub async fn export_status<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<StatusItem>,
    preset_hash: String,
    format: ExportFormat,
) -> Result<Vec<ExportState>> {
    check_preset_hash(&preset_hash)?;
    Ok(items
        .iter()
        .map(|item| {
            let state = || -> Result<ExportState> {
                let root = source_root(&app, &item.folder)?;
                if format == ExportFormat::Original {
                    let src = resolve_rel(&app, &root, item.rel_path.as_deref().unwrap_or_default())?;
                    let dest = check_dest(&app, &item.dest_dir)?.join(checked_name(&item.name, &source_ext(&src))?);
                    let expected = match &item.settings {
                        Some(s) => Some(export_sidecar(s, item.orientation, item.width, item.height)?),
                        None => None,
                    };
                    return Ok(original_state(&src, &dest, expected.as_deref()));
                }
                let cache = ensure_allowed(&app, cache_path(&root, &preset_hash, &item.hash, &item.develop_hash, format)?)?;
                let dest = check_dest(&app, &item.dest_dir)?.join(checked_name(&item.name, format.extension())?);
                let cached = cache.is_file();
                let exported = cached && same_export(&cache, &dest);
                Ok(ExportState { cached, exported, replaces: dest.exists() && !is_our_export(&cache, &dest) })
            };
            state().unwrap_or_default()
        })
        .collect())
}

/// The destination folder resolved (it may not exist yet), or an out-of-scope error: inside an imported folder or
/// app data, or picked in the native dialog this session.
#[tauri::command]
pub async fn check_export_dest<R: Runtime>(app: AppHandle<R>, dir: String) -> Result<String> {
    Ok(check_dest(&app, &dir)?.to_string_lossy().into_owned())
}

/// Show an exported file (selected in its folder) in the Finder; `path` must be in scope as a destination is.
#[tauri::command]
pub async fn reveal_export<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
    let given = Path::new(&path);
    let parent = given.parent().ok_or_else(|| Error::Invalid(format!("{path} has no folder")))?;
    check_dest(&app, &parent.to_string_lossy())?;
    reveal(&normalize(given)?)
}

/// The saved export presets (JSON objects as written; the editor parses them), by name.
#[tauri::command]
pub async fn list_export_presets<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Value>> {
    Ok(list_presets_in(&presets_dir(&app)?))
}

#[tauri::command]
pub async fn save_export_preset<R: Runtime>(app: AppHandle<R>, preset: Value) -> Result<()> {
    save_preset_in(&presets_dir(&app)?, preset)
}

#[tauri::command]
pub async fn delete_export_preset<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    delete_preset_in(&presets_dir(&app)?, &id)
}

/// What this build can export (`ExportCapabilities` in TS).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportCapabilities {
    /// HEIC through ImageIO (macOS).
    pub heic: bool,
}

#[tauri::command]
pub async fn export_capabilities() -> Result<ExportCapabilities> {
    Ok(ExportCapabilities { heic: px::heic_supported() })
}

/// An imported watermark image.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkImage {
    /// SHA-256 (hex) of the PNG, its name in `<appdata>/watermarks/`.
    pub id: String,
    /// The file name it was picked as.
    pub name: String,
    pub width: u32,
    pub height: u32,
}

/// Copy a PNG picked in the native dialog (or inside an imported folder) to `<appdata>/watermarks/<sha256>.png`.
#[tauri::command]
pub async fn import_watermark<R: Runtime>(app: AppHandle<R>, path: String) -> Result<WatermarkImage> {
    let src = check_dest(&app, &path)?;
    let dir = ensure_allowed(&app, app_data_dir(&app)?.join(WATERMARKS_DIR))?;
    let image = tauri::async_runtime::spawn_blocking(move || import_watermark_into(&dir, &src)).await??;
    log::info!("[photobook:export] imported watermark {} ({}x{}) as {}", image.name, image.width, image.height, image.id);
    Ok(image)
}

// ---------------------------------------------------------------------------------------------
// Paths and scope

fn emit<R: Runtime>(app: &AppHandle<R>, job: u64, stage: &str) {
    let _ = app.emit(EVENT_EXPORT_PROGRESS, ProgressEvent { job, stage });
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `presetHash` is 16 lowercase hex digits (`PRESET_HASH_LENGTH` in TS); it becomes a folder name.
fn check_preset_hash(preset_hash: &str) -> Result<()> {
    if is_hex(preset_hash, 16) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("Invalid export preset hash {preset_hash:?}")))
    }
}

/// `<root>/.photobook-cache/export/<presetHash>/<hash>-<developHash>.<ext>` (`exportCacheName` in TS).
fn cache_path(root: &Path, preset_hash: &str, hash: &str, develop_hash: &str, format: ExportFormat) -> Result<PathBuf> {
    check_preset_hash(preset_hash)?;
    if !is_hex(hash, 64) || !is_hex(develop_hash, 64) {
        return Err(Error::Invalid("Invalid photo or develop hash".into()));
    }
    Ok(root
        .join(SOURCE_CACHE_DIR)
        .join(EXPORT_DIR)
        .join(preset_hash)
        .join(format!("{hash}-{develop_hash}.{}", format.extension())))
}

/// A file name for the destination: one plain path segment, not hidden, ending in `ext` (the format's extension, or
/// the source's for Original).
fn checked_name<'a>(name: &'a str, ext: &str) -> Result<&'a str> {
    let mut parts = Path::new(name).components();
    let single = matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None));
    let ext_ok = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| !ext.is_empty() && e.eq_ignore_ascii_case(ext));
    if !single || name.starts_with('.') || name.contains(['/', '\\']) || !ext_ok {
        return Err(Error::Invalid(format!("Invalid export file name {name:?}")));
    }
    Ok(name)
}

/// `dir` resolved, when it is inside an imported folder or app data, or the native dialog picked it this session.
fn check_dest<R: Runtime>(app: &AppHandle<R>, dir: &str) -> Result<PathBuf> {
    let given = Path::new(dir);
    if let Ok(path) = ensure_allowed(app, given) {
        return Ok(path);
    }
    let path = normalize(given).map_err(|_| Error::OutOfScope(dir.to_string()))?;
    let scope = app.fs_scope();
    if scope.is_allowed(given) || scope.is_allowed(&path) {
        Ok(path)
    } else {
        Err(Error::OutOfScope(dir.to_string()))
    }
}

fn presets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    ensure_allowed(app, app_data_dir(app)?.join(PRESETS_DIR))
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<()> {
    // Always `-R` (select in its folder): `open` on a folder named like a bundle (`X.app`) would launch it.
    let status = std::process::Command::new("/usr/bin/open").arg("-R").arg(path).status().ctx("running open")?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(format!("open {} failed ({status})", path.display())))
    }
}

#[cfg(not(target_os = "macos"))]
fn reveal(path: &Path) -> Result<()> {
    Err(Error::Invalid(format!("Revealing files is only supported on macOS; the export is {}", path.display())))
}

// ---------------------------------------------------------------------------------------------
// The export itself (no Tauri state: unit-tested below)

/// Where one photo's export reads and writes.
struct Plan {
    src: PathBuf,
    /// `<appdata>/cache/<hash>/` (denoise intermediates, AI masks, `sips` copies).
    entry_dir: PathBuf,
    cache: PathBuf,
    dest: PathBuf,
    skip_exported: bool,
    /// Overwrite a destination file that is not this export (the user confirmed it in the dialog).
    replace: bool,
    /// The watermark image, when the options have one.
    assets: ExportAssets,
}

/// `dest` is a copy of the cache entry `cache`: the same size, and written after the entry (within
/// [`SAME_TIME_SLACK_MS`], for file systems with two-second times). A cache entry written again (the cache was
/// cleared) is newer than every copy of the old one, so those count as different.
fn same_export(cache: &Path, dest: &Path) -> bool {
    let (Ok(c), Ok(d)) = (fs::metadata(cache), fs::metadata(dest)) else { return false };
    if !d.is_file() || c.len() != d.len() {
        return false;
    }
    match (c.modified(), d.modified()) {
        (Ok(cache_time), Ok(dest_time)) => match cache_time.duration_since(dest_time) {
            Err(_) => true, // the copy is newer
            Ok(ahead) => ahead.as_millis() <= SAME_TIME_SLACK_MS,
        },
        _ => false,
    }
}

/// Copy the cache entry to `dest` (temp name, renamed); the copy has its own (current) time.
fn copy_to_dest(cache: &Path, dest: &Path) -> Result<u64> {
    let bytes = fs::read(cache).ctx(format!("reading {}", cache.display()))?;
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    }
    write_atomic(dest, &bytes)?;
    Ok(bytes.len() as u64)
}

/// `dest` is an export of this photo with these options: a copy of `cache` or of another cache entry of the same
/// photo (an earlier edit) next to it. Replacing it needs no confirmation; any other file at `dest` does.
fn is_our_export(cache: &Path, dest: &Path) -> bool {
    if same_export(cache, dest) {
        return true;
    }
    let (Some(dir), Some(name)) = (cache.parent(), cache.file_name().and_then(|n| n.to_str())) else { return false };
    let Some((hash, _)) = name.split_once('-') else { return false };
    let ext = cache.extension();
    let Ok(entries) = fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let path = e.path();
        e.file_name().to_string_lossy().starts_with(&format!("{hash}-")) && path.extension() == ext && same_export(&path, dest)
    })
}

fn is_not_found(err: &Error) -> bool {
    matches!(err, Error::Io(_, e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// Keep the [`KEEP_PER_PHOTO`] newest cache entries of `hash` in a preset's cache folder (other develop hashes);
/// `current` (the entry just written) is never removed.
fn prune_cache(dir: &Path, hash: &str, current: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let prefix = format!("{hash}-");
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix) && e.path() != current)
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), e.path()))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(KEEP_PER_PHOTO.saturating_sub(1)) {
        let _ = fs::remove_file(path);
    }
}

/// The source file's extension (lower case), which an Original export keeps.
fn source_ext(src: &Path) -> String {
    src.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// `<dest stem>.xmp`: the sidecar of an Original export (the Lightroom and Camera Raw name).
fn sidecar_of(dest: &Path) -> PathBuf {
    let stem = dest.file_stem().unwrap_or_default().to_string_lossy();
    dest.with_file_name(format!("{stem}.xmp"))
}

/// Two files with the same bytes (sizes first, then the contents in blocks).
fn same_file(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else { return false };
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (fs::File::open(a), fs::File::open(b)) else { return false };
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let Ok(n) = fa.read(&mut ba) else { return false };
        if n == 0 {
            return true;
        }
        if fb.read_exact(&mut bb[..n]).is_err() || ba[..n] != bb[..n] {
            return false;
        }
    }
}

/// What an Original export of `src` to `dest` would find there. Exported: the copy has the source's bytes and the
/// sidecar has `expected` (or, without it, a sidecar is there). Replaces: `dest` holds another file, or `<stem>.xmp`
/// holds something else than `expected` that is not our own sidecar of this copy (an earlier edit of the same photo,
/// replaced without asking): a user's or another photo's sidecar is never overwritten unconfirmed.
fn original_state(src: &Path, dest: &Path, expected: Option<&str>) -> ExportState {
    let copied = same_file(src, dest);
    let sidecar = fs::read_to_string(sidecar_of(dest)).ok();
    let sidecar_exists = sidecar_of(dest).exists();
    let same_sidecar = match (expected, &sidecar) {
        (Some(e), Some(s)) => s == e,
        (None, _) => sidecar_exists,
        (Some(_), None) => false,
    };
    let ours = |s: &str| matches!(photobook_develop::xmp::read_photobook_packet(s), Ok(Some(_)));
    let sidecar_conflict = sidecar_exists
        && !same_sidecar
        && expected.is_some()
        && !(copied && sidecar.as_deref().is_some_and(ours));
    ExportState {
        cached: false,
        exported: copied && same_sidecar,
        replaces: (dest.exists() && !copied) || sidecar_conflict,
    }
}

/// The Original + sidecar export: the source copied byte for byte to `dest` (temp name, renamed) and `<name>.xmp`
/// next to it with our packet and the Lightroom `crs:` fields. Skipped when the copy and a sidecar with the same
/// content are already there; a different file at `dest` is replaced only with `replace`.
fn export_original(
    src: &Path,
    dest: &Path,
    item: &ExportItem,
    skip_exported: bool,
    replace: bool,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&str),
) -> Result<ExportResult> {
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let path = dest.to_string_lossy().into_owned();
    let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let sidecar = export_sidecar(&item.settings, item.orientation, item.width, item.height)?;
    let sidecar_path = sidecar_of(dest);
    let state = original_state(src, dest, Some(&sidecar));
    let copied = same_file(src, dest);
    if !replace && state.replaces {
        let file = if dest.exists() && !copied { dest } else { &sidecar_path };
        let file = file.file_name().unwrap_or_default().to_string_lossy();
        return Err(Error::Invalid(format!(
            "{file} already exists in {}; export again with Replace existing files on",
            dest.parent().unwrap_or(Path::new("")).display()
        )));
    }
    if skip_exported && state.exported {
        log::info!("[photobook:export] skipped {name} (original already exported) -> {path}");
        return Ok(ExportResult { path, bytes: fs::metadata(dest).map(|m| m.len()).unwrap_or(0), encoded: false, skipped: true });
    }
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    }
    progress("copy");
    let bytes = if copied {
        fs::metadata(dest).map(|m| m.len()).unwrap_or(0)
    } else {
        let data = fs::read(src).ctx(format!("reading {}", src.display()))?;
        if cancelled() {
            return Err(Error::Invalid(CANCELLED.into()));
        }
        write_atomic(dest, &data)?;
        data.len() as u64
    };
    write_atomic(&sidecar_path, sidecar.as_bytes())?;
    log::info!("[photobook:export] copied original {name} with its XMP sidecar -> {path}");
    Ok(ExportResult { path, bytes, encoded: false, skipped: false })
}

/// The watermark image the options name, read from `<appdata>/watermarks/` and checked against its id.
fn export_assets<R: Runtime>(app: &AppHandle<R>, options: &ExportOptions) -> Result<ExportAssets> {
    let Some(watermark) = options.watermark.as_ref().filter(|w| w.kind == WatermarkKind::Image) else {
        return Ok(ExportAssets::default());
    };
    let id = watermark.image.as_deref().unwrap_or_default();
    if !is_hex(id, 64) {
        return Err(Error::Invalid("Choose the watermark image in the Export dialog".into()));
    }
    let file = ensure_allowed(app, app_data_dir(app)?.join(WATERMARKS_DIR).join(format!("{id}.png")))?;
    Ok(ExportAssets { watermark_png: Some(read_watermark(&file, id)?) })
}

/// The watermark PNG at `file`, whose SHA-256 must be `id`.
fn read_watermark(file: &Path, id: &str) -> Result<Vec<u8>> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(file).map_err(|_| Error::Invalid("The watermark image is missing; choose it again".into()))?;
    if hex::encode(Sha256::digest(&bytes)) != id {
        return Err(Error::Invalid("The watermark image changed on disk; choose it again".into()));
    }
    Ok(bytes)
}

/// Check `src` is a PNG of a sensible size, then store it in `dir` as `<sha256>.png`.
fn import_watermark_into(dir: &Path, src: &Path) -> Result<WatermarkImage> {
    use sha2::{Digest, Sha256};
    let len = fs::metadata(src).ctx(format!("reading {}", src.display()))?.len();
    if len > MAX_WATERMARK_BYTES {
        return Err(Error::Invalid(format!("{} is larger than {} MB", src.display(), MAX_WATERMARK_BYTES >> 20)));
    }
    let bytes = fs::read(src).ctx(format!("reading {}", src.display()))?;
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| Error::Invalid("A watermark image must be a PNG".into()))?;
    let id = hex::encode(Sha256::digest(&bytes));
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    let file = dir.join(format!("{id}.png"));
    if !file.is_file() {
        write_atomic(&file, &bytes)?;
    }
    let name: String = src.file_name().unwrap_or_default().to_string_lossy().chars().take(255).collect();
    Ok(WatermarkImage { id, name, width: decoded.width(), height: decoded.height() })
}

/// Export one photo along `plan`: skip, copy the cache entry, or develop, fit, sharpen, encode into the cache and copy.
/// `cancelled` is asked after the decode and after the render (then nothing is written and the error is `Cancelled`);
/// `progress` hears each stage. A render made without the denoise intermediate it asks for is not cached.
fn export_one(
    plan: &Plan,
    settings: &DevelopSettings,
    options: &ExportOptions,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(&str),
    rendered: &dyn Fn(),
) -> Result<ExportResult> {
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    let name = plan.src.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let path = plan.dest.to_string_lossy().into_owned();
    let same = plan.cache.is_file() && same_export(&plan.cache, &plan.dest);
    if !plan.replace && plan.dest.exists() && !is_our_export(&plan.cache, &plan.dest) {
        let file = plan.dest.file_name().unwrap_or_default().to_string_lossy();
        return Err(Error::Invalid(format!(
            "{file} already exists in {}; export again with Replace existing files on",
            plan.dest.parent().unwrap_or(Path::new("")).display()
        )));
    }
    if plan.cache.is_file() {
        if plan.skip_exported && same {
            log::info!("[photobook:export] skipped {name} (already exported) -> {path}");
            let bytes = fs::metadata(&plan.dest).map(|m| m.len()).unwrap_or(0);
            return Ok(ExportResult { path, bytes, encoded: false, skipped: true });
        }
        progress("copy");
        match copy_to_dest(&plan.cache, &plan.dest) {
            Ok(bytes) => {
                log::info!("[photobook:export] copied {name} from the cache -> {path}");
                return Ok(ExportResult { path, bytes, encoded: false, skipped: false });
            }
            // The entry went away (another export pruned it, the cache was cleared): encode it again.
            Err(err) if is_not_found(&err) => log::info!("[photobook:export] {name}: cache entry gone, encoding"),
            Err(err) => return Err(err),
        }
    }
    progress("decode");
    let stale = denoise_pending(&plan.entry_dir, settings);
    // Asked after the decode (the render starts when it says no) and after the render.
    let checks = std::cell::Cell::new(0);
    let check = || {
        let stop = cancelled();
        checks.set(checks.get() + 1);
        if !stop && checks.get() == 1 {
            progress("render");
        }
        stop
    };
    let (frame, exif_source, decode_ms, render_ms) = if options.format.is_16_bit() {
        let (image, exif, decode_ms, render_ms) =
            develop_full_image16(&plan.src, &plan.entry_dir, settings, options.colour, &check)?;
        (ExportFrame::Rgb16(image), exif, decode_ms, render_ms)
    } else {
        let FullImage { image, exif_source, decode_ms, render_ms } =
            develop_full_image(&plan.src, &plan.entry_dir, settings, options.colour, &check)?;
        (ExportFrame::Rgb8(image), exif_source, decode_ms, render_ms)
    };
    // Done with the render lane (the GPU or the CPU develop): finishing and encoding run outside it.
    rendered();
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    progress("encode");
    let start = Instant::now();
    let out = px::finish(frame, options, &plan.assets)?;
    // A RAW has no Exif source for a full render; copyright and artist are read from the file itself.
    let exif_source = exif_source.unwrap_or_else(|| plan.src.clone());
    let bytes = px::encode(&out, options, Some(&exif_source))?;
    let encode_ms = start.elapsed().as_millis();
    if cancelled() {
        return Err(Error::Invalid(CANCELLED.into()));
    }
    if let Some(dir) = plan.dest.parent() {
        fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    }
    if stale {
        // Denoise is on but its intermediate is missing: never cache what is not the photo's real render.
        log::warn!("[photobook:export] {name} exported without its denoise intermediate; not cached");
        write_atomic(&plan.dest, &bytes)?;
    } else {
        let dir = plan.cache.parent().ok_or_else(|| Error::Invalid("export cache has no folder".into()))?;
        fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
        write_atomic(&plan.cache, &bytes)?;
        copy_to_dest(&plan.cache, &plan.dest)?;
        let hash = plan.cache.file_name().unwrap_or_default().to_string_lossy();
        if let Some((hash, _)) = hash.split_once('-') {
            prune_cache(dir, hash, &plan.cache);
        }
    }
    let (out_w, out_h) = out.size();
    log::info!(
        "[photobook:export] encoded {name} {out_w}x{out_h} {:?} decode={decode_ms}ms render={render_ms}ms encode={encode_ms}ms -> {path}",
        options.format
    );
    Ok(ExportResult { path, bytes: bytes.len() as u64, encoded: true, skipped: false })
}

// ---------------------------------------------------------------------------------------------
// Presets on disk

fn preset_file(dir: &Path, id: &str) -> Result<PathBuf> {
    if !is_ulid(id) {
        return Err(Error::Invalid(format!("Invalid export preset id {id:?}")));
    }
    Ok(dir.join(format!("{id}.json")))
}

/// What the files rely on: an object with a ULID `id` and a 1 to 80 character `name`.
fn validate_preset(preset: &Value) -> Result<&str> {
    let Value::Object(map) = preset else { return Err(Error::Invalid("An export preset must be an object".into())) };
    let id = map.get("id").and_then(Value::as_str).unwrap_or_default();
    if !is_ulid(id) {
        return Err(Error::Invalid(format!("Invalid export preset id {id:?}")));
    }
    let name = map.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default();
    if name.is_empty() || name.chars().count() > MAX_PRESET_NAME {
        return Err(Error::Invalid(format!("An export preset name has 1 to {MAX_PRESET_NAME} characters")));
    }
    Ok(id)
}

fn list_presets_in(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut presets: Vec<Value> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            if path.extension()?.to_str()? != "json" || !is_ulid(&stem) || e.metadata().ok()?.len() > MAX_PRESET_BYTES {
                return None;
            }
            let value: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            // The file name is the identity.
            (validate_preset(&value).ok()? == stem).then_some(value)
        })
        .collect();
    let name = |v: &Value| v.get("name").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    presets.sort_by(|a, b| name(a).cmp(&name(b)));
    presets
}

fn save_preset_in(dir: &Path, mut preset: Value) -> Result<()> {
    let id = validate_preset(&preset)?.to_string();
    if let Value::Object(map) = &mut preset {
        map.insert("builtIn".into(), Value::Bool(false));
    }
    let json = serde_json::to_vec_pretty(&preset).map_err(|e| Error::Invalid(e.to_string()))?;
    if json.len() as u64 > MAX_PRESET_BYTES {
        return Err(Error::Invalid("This export preset is too large".into()));
    }
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    write_atomic(&preset_file(dir, &id)?, &json)
}

fn delete_preset_in(dir: &Path, id: &str) -> Result<()> {
    let file = preset_file(dir, id)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::Io(format!("deleting {}", file.display()), err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::develop::render_full_file_for_tests;
    use photobook_develop::export::{ExportMetadata, OutputSharpen};
    use photobook_develop::OutputProfile;
    use serde_json::json;
    use std::cell::Cell;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip").canonicalize().unwrap()
    }

    fn settings(exposure: f64) -> DevelopSettings {
        serde_json::from_value(json!({ "version": 1, "light": { "exposure": exposure } })).unwrap()
    }

    fn plan(dir: &Path, src: &str, hash: &str, settings: &DevelopSettings, ext: &str) -> Plan {
        let root = dir.join("folder");
        Plan {
            src: fixtures().join(src),
            entry_dir: dir.join("appcache").join(hash),
            cache: root.join(".photobook-cache/export/0123456789abcdef").join(format!(
                "{hash}-{}.{ext}",
                develop_hash(settings)
            )),
            dest: root.join("Exports/Social").join(src.replace(".jpg", &format!(".{ext}"))),
            skip_exported: true,
            replace: false,
            assets: ExportAssets::default(),
        }
    }

    fn files_under(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(dir).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            out.push(entry.path().strip_prefix(dir).unwrap().to_string_lossy().into_owned());
        }
        out.sort();
        out
    }

    const NEVER: &dyn Fn() -> bool = &|| false;
    const QUIET: &dyn Fn(&str) = &|_| {};
    const NOOP: &dyn Fn() = &|| {};

    #[test]
    fn full_quality_export_is_the_full_render_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(0.4);
        let full = dir.path().join("full.jpg");
        render_full_file_for_tests(&fixtures().join("DSCF1001.jpg"), &dir.path().join("appcache/a"), &full, &s);
        let options = ExportOptions { quality: 95, ..ExportOptions::default() };
        let p = plan(dir.path(), "DSCF1001.jpg", &"a1".repeat(32), &s, "jpg");
        let result = export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap();
        assert!(result.encoded && !result.skipped);
        // Same pixels, same encoder, same Exif: the same file as the publish render.
        assert_eq!(fs::read(&p.dest).unwrap(), fs::read(&full).unwrap());
        assert_eq!(fs::read(&p.cache).unwrap(), fs::read(&full).unwrap());
    }

    #[test]
    fn resized_export_has_the_long_edge_and_decodes() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(0.0);
        let mut formats = vec![
            (ExportFormat::Jpeg, "jpg"),
            (ExportFormat::Png, "png"),
            (ExportFormat::Webp, "webp"),
            (ExportFormat::Avif, "avif"),
            (ExportFormat::Tiff, "tif"),
        ];
        if px::heic_supported() {
            formats.push((ExportFormat::Heic, "heic"));
        }
        for (format, ext) in formats {
            let options = ExportOptions {
                format,
                quality: 85,
                long_edge: Some(600),
                metadata: ExportMetadata::None,
                sharpen: OutputSharpen::Standard,
                ..ExportOptions::default()
            };
            let p = plan(dir.path(), "DSCF1001.jpg", &"b2".repeat(32), &s, ext);
            export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap();
            let bytes = fs::read(&p.dest).unwrap();
            let (w, h) = match format {
                ExportFormat::Jpeg => {
                    let header = turbojpeg::read_header(&bytes).unwrap();
                    (header.width as u32, header.height as u32)
                }
                ExportFormat::Png => {
                    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
                    (img.width(), img.height())
                }
                ExportFormat::Webp => {
                    let img = webp_size(&bytes);
                    (img.0, img.1)
                }
                ExportFormat::Tiff => {
                    // The primary IFD's ImageWidth and ImageLength, read as Exif.
                    let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(&bytes)).unwrap();
                    let dim = |tag| exif.get_field(tag, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)).unwrap();
                    (dim(exif::Tag::ImageWidth), dim(exif::Tag::ImageLength))
                }
                ExportFormat::Avif | ExportFormat::Heic => {
                    #[cfg(target_os = "macos")]
                    {
                        let probe = px::heic::probe(&bytes).expect("ImageIO decodes it");
                        (probe.width as u32, probe.height as u32)
                    }
                    #[cfg(not(target_os = "macos"))]
                    (600, 400)
                }
                ExportFormat::Original => unreachable!(),
            };
            assert_eq!((w, h), (600, 400), "{ext}");
        }
    }

    /// Canvas size from a VP8X WebP header.
    fn webp_size(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[12..16], b"VP8X");
        let le24 = |b: &[u8]| u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16;
        (le24(&bytes[24..27]) + 1, le24(&bytes[27..30]) + 1)
    }

    #[test]
    fn re_export_after_editing_three_of_twelve_re_encodes_three() {
        let dir = tempfile::tempdir().unwrap();
        let photos: Vec<String> = fs::read_dir(fixtures())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".jpg") && n != "DSCF1000.jpg")
            .take(12)
            .collect();
        assert_eq!(photos.len(), 12);
        let options = ExportOptions { long_edge: Some(320), quality: 80, ..ExportOptions::default() };
        let hash = |i: usize| format!("{i:064x}");
        let run = |edits: &[f64]| -> (usize, usize, usize) {
            let (mut encoded, mut copied, mut skipped) = (0, 0, 0);
            for (i, name) in photos.iter().enumerate() {
                let s = settings(edits[i]);
                let p = plan(dir.path(), name, &hash(i), &s, "jpg");
                let r = export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap();
                match (r.encoded, r.skipped) {
                    (true, _) => encoded += 1,
                    (_, true) => skipped += 1,
                    _ => copied += 1,
                }
            }
            (encoded, copied, skipped)
        };
        let mut edits = vec![0.0; 12];
        assert_eq!(run(&edits), (12, 0, 0));
        // Nothing changed: every photo is already at its destination.
        assert_eq!(run(&edits), (0, 0, 12));
        edits[2] = 0.5;
        edits[5] = -0.3;
        edits[11] = 1.0;
        assert_eq!(run(&edits), (3, 0, 9));
        // A destination deleted (or another destination): copied from the cache, not encoded again.
        let p = plan(dir.path(), &photos[0], &hash(0), &settings(0.0), "jpg");
        fs::remove_file(&p.dest).unwrap();
        assert_eq!(run(&edits), (0, 1, 11));
        // Undoing an edit finds the earlier entry in the cache.
        edits[2] = 0.0;
        assert_eq!(run(&edits), (0, 1, 11));
    }

    #[test]
    fn cancel_before_or_after_decode_or_render_writes_nothing() {
        // Asked before anything, after the decode and after the render.
        for stop_at in [1, 2, 3] {
            let dir = tempfile::tempdir().unwrap();
            let s = settings(0.2);
            let p = plan(dir.path(), "DSCF1001.jpg", &"c3".repeat(32), &s, "jpg");
            let asked = Cell::new(0);
            let cancelled = || {
                asked.set(asked.get() + 1);
                asked.get() >= stop_at
            };
            let err = export_one(&p, &s, &ExportOptions::default(), &cancelled, QUIET, NOOP).unwrap_err();
            assert_eq!(err.to_string(), CANCELLED);
            assert!(!p.cache.exists() && !p.dest.exists());
            assert!(files_under(dir.path()).is_empty(), "left {:?}", files_under(dir.path()));
        }
    }

    #[test]
    fn same_export_compares_size_and_time() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("c.jpg");
        let dest = dir.path().join("out/d.jpg");
        fs::write(&cache, b"12345").unwrap();
        assert!(!same_export(&cache, &dest));
        copy_to_dest(&cache, &dest).unwrap();
        assert!(same_export(&cache, &dest));
        // Same size, another time: a different file.
        let old = SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options().write(true).open(&dest).unwrap().set_modified(old).unwrap();
        assert!(!same_export(&cache, &dest));
        // Same time, another size.
        copy_to_dest(&cache, &dest).unwrap();
        fs::write(&dest, b"123456").unwrap();
        assert!(!same_export(&cache, &dest));
    }

    #[test]
    fn prune_keeps_the_newest_entries_of_one_photo() {
        let dir = tempfile::tempdir().unwrap();
        let base = SystemTime::now() - std::time::Duration::from_secs(100);
        for (i, name) in ["aa-1.jpg", "aa-2.jpg", "aa-3.jpg", "aa-4.jpg", "bb-1.jpg"].iter().enumerate() {
            let path = dir.path().join(name);
            fs::write(&path, b"x").unwrap();
            let when = base + std::time::Duration::from_secs(10 * i as u64);
            fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
        }
        prune_cache(dir.path(), "aa", &dir.path().join("aa-4.jpg"));
        assert_eq!(files_under(dir.path()), vec!["aa-2.jpg", "aa-3.jpg", "aa-4.jpg", "bb-1.jpg"]);
        // The entry just written stays even when it is not the newest (its time came from a slow write).
        prune_cache(dir.path(), "aa", &dir.path().join("aa-2.jpg"));
        assert_eq!(files_under(dir.path()), vec!["aa-2.jpg", "aa-3.jpg", "aa-4.jpg", "bb-1.jpg"]);
        fs::write(dir.path().join("aa-0.jpg"), b"x").unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(1000);
        fs::File::options().write(true).open(dir.path().join("aa-0.jpg")).unwrap().set_modified(old).unwrap();
        prune_cache(dir.path(), "aa", &dir.path().join("aa-0.jpg"));
        assert_eq!(files_under(dir.path()), vec!["aa-0.jpg", "aa-3.jpg", "aa-4.jpg", "bb-1.jpg"]);
    }

    #[test]
    fn a_file_that_is_not_this_export_is_replaced_only_when_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(0.0);
        let options = ExportOptions { long_edge: Some(200), ..ExportOptions::default() };
        let mut p = plan(dir.path(), "DSCF1001.jpg", &"d4".repeat(32), &s, "jpg");
        fs::create_dir_all(p.dest.parent().unwrap()).unwrap();
        fs::write(&p.dest, b"someone else's photo").unwrap();
        let err = export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        assert_eq!(fs::read(&p.dest).unwrap(), b"someone else's photo");
        assert!(!p.cache.exists(), "refused before encoding");
        p.replace = true;
        assert!(export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap().encoded);
        // A later edit of the same photo replaces its own earlier export without asking.
        let edited = settings(0.7);
        let mut q = plan(dir.path(), "DSCF1001.jpg", &"d4".repeat(32), &edited, "jpg");
        q.cache = p.cache.with_file_name(format!("{}-{}.jpg", "d4".repeat(32), develop_hash(&edited)));
        assert!(is_our_export(&q.cache, &q.dest));
        assert!(export_one(&q, &edited, &options, NEVER, QUIET, NOOP).unwrap().encoded);
    }

    #[test]
    fn a_cache_entry_that_went_away_is_not_found_and_encoded_again() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(0.0);
        let options = ExportOptions { long_edge: Some(200), ..ExportOptions::default() };
        let p = plan(dir.path(), "DSCF1001.jpg", &"e5".repeat(32), &s, "jpg");
        // What `export_one` sees when the entry is removed between its check and the copy: NotFound, so it encodes.
        assert!(copy_to_dest(&p.cache, &p.dest).is_err_and(|e| is_not_found(&e)));
        assert!(export_one(&p, &s, &options, NEVER, QUIET, NOOP).unwrap().encoded);
    }

    #[test]
    fn names_and_hashes_are_checked() {
        assert!(checked_name("DSCF1001.jpg", "jpg").is_ok());
        assert!(checked_name("Lisbon 001.JPG", "jpg").is_ok());
        assert!(checked_name("a.webp", "jpg").is_err());
        assert!(checked_name("../a.jpg", "jpg").is_err());
        assert!(checked_name("sub/a.jpg", "jpg").is_err());
        assert!(checked_name(".a.jpg", "jpg").is_err());
        assert!(checked_name("/a.jpg", "jpg").is_err());
        assert!(check_preset_hash("0123456789abcdef").is_ok());
        assert!(check_preset_hash("0123456789ABCDEF").is_err());
        assert!(check_preset_hash("../../etc").is_err());
        let root = Path::new("/p");
        assert_eq!(
            cache_path(root, "0123456789abcdef", &"a".repeat(64), &"b".repeat(64), ExportFormat::Webp).unwrap(),
            root.join(format!(".photobook-cache/export/0123456789abcdef/{}-{}.webp", "a".repeat(64), "b".repeat(64)))
        );
        assert!(cache_path(root, "0123456789abcdef", "..", &"b".repeat(64), ExportFormat::Jpeg).is_err());
    }

    #[test]
    fn presets_round_trip_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let a = json!({
            "id": "01K7A00000000000000000000A",
            "name": "Proofs",
            "builtIn": true,
            "options": { "format": "webp", "quality": 80, "longEdge": 2000 },
            "naming": "{date}-{seq}",
            "destination": null,
            "skipExported": true
        });
        save_preset_in(d, a.clone()).unwrap();
        save_preset_in(d, json!({ "id": "01K7B00000000000000000000B", "name": "Archive" })).unwrap();
        let listed = list_presets_in(d);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0]["name"], "Archive");
        let mut want = a.clone();
        want["builtIn"] = json!(false);
        assert_eq!(listed[1], want);
        // Invalid presets are refused; stray files are skipped.
        assert!(save_preset_in(d, json!({ "id": "../x", "name": "a" })).is_err());
        assert!(save_preset_in(d, json!({ "id": "01K7C00000000000000000000C", "name": " " })).is_err());
        assert!(save_preset_in(d, json!([1])).is_err());
        fs::write(d.join("notes.json"), b"{}").unwrap();
        fs::write(d.join("01K7D00000000000000000000D.json"), br#"{"id":"01K7E00000000000000000000E","name":"x"}"#).unwrap();
        assert_eq!(list_presets_in(d).len(), 2);
        delete_preset_in(d, "01K7A00000000000000000000A").unwrap();
        delete_preset_in(d, "01K7A00000000000000000000A").unwrap();
        assert_eq!(list_presets_in(d).len(), 1);
        assert!(delete_preset_in(d, "nope").is_err());
        assert_eq!(OutputProfile::Srgb.as_str(), "srgb");
    }

    // ---- Workflow plan 12 ----

    fn item(s: &DevelopSettings) -> ExportItem {
        ExportItem {
            folder: String::new(),
            rel_path: "DSCF1001.jpg".into(),
            hash: "f6".repeat(32),
            settings: s.clone(),
            dest_dir: String::new(),
            name: "DSCF1001.jpg".into(),
            orientation: Some(1),
            width: Some(1200),
            height: Some(800),
        }
    }

    #[test]
    fn original_export_copies_the_source_and_writes_a_sidecar_both_apps_read() {
        let dir = tempfile::tempdir().unwrap();
        let s: DevelopSettings = serde_json::from_value(json!({ "version": 1, "light": { "exposure": 0.7, "contrast": 15 } })).unwrap();
        let src = fixtures().join("DSCF1001.jpg");
        let dest = dir.path().join("Exports/Original + sidecar/DSCF1001.jpg");
        let r = export_original(&src, &dest, &item(&s), true, false, NEVER, QUIET).unwrap();
        assert!(!r.skipped && !r.encoded);
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&src).unwrap());
        let sidecar = fs::read_to_string(dir.path().join("Exports/Original + sidecar/DSCF1001.xmp")).unwrap();
        // Lightroom's tone fields and our exact packet, in one file.
        assert!(sidecar.contains("crs:Exposure2012"), "{sidecar}");
        assert!(sidecar.contains("photobook:"), "{sidecar}");
        let back = crate::commands::xmp::read_for(&dest, Some(1)).unwrap();
        assert_eq!(back.format, Some(crate::commands::xmp::XmpFormat::Photobook));
        assert_eq!(back.import.unwrap().settings, s);
        // Again: already there.
        assert!(export_original(&src, &dest, &item(&s), true, false, NEVER, QUIET).unwrap().skipped);
        // Another edit rewrites the sidecar only.
        let edited: DevelopSettings = serde_json::from_value(json!({ "version": 1, "light": { "exposure": -0.2 } })).unwrap();
        assert!(!export_original(&src, &dest, &item(&edited), true, false, NEVER, QUIET).unwrap().skipped);
        let back = crate::commands::xmp::read_for(&dest, Some(1)).unwrap();
        assert_eq!(back.import.unwrap().settings, edited);
        // Someone else's file is replaced only when confirmed.
        fs::write(&dest, b"other").unwrap();
        assert!(export_original(&src, &dest, &item(&s), true, false, NEVER, QUIET).is_err());
        assert!(export_original(&src, &dest, &item(&s), true, true, NEVER, QUIET).is_ok());
        assert!(same_file(&src, &dest));
        let sidecar = fs::read_to_string(sidecar_of(&dest)).unwrap();
        assert_eq!(original_state(&src, &dest, Some(&sidecar)), ExportState { cached: false, exported: true, replaces: false });
        // A sidecar that is not ours for this copy (the user's, or the RAW of an `IMG_1.nef` / `IMG_1.jpg` pair
        // exported earlier) counts as a file to replace, and is never overwritten unconfirmed.
        let other = dir.path().join("Exports/Original + sidecar/DSCF1002.jpg");
        let theirs = sidecar_of(&other);
        fs::write(&theirs, "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>").unwrap();
        let src2 = fixtures().join("DSCF1002.jpg");
        let expected = export_sidecar(&s, Some(1), Some(1200), Some(800)).unwrap();
        assert!(original_state(&src2, &other, Some(&expected)).replaces);
        let err = export_original(&src2, &other, &item(&s), true, false, NEVER, QUIET).unwrap_err();
        assert!(err.to_string().contains("DSCF1002.xmp"), "{err}");
        assert!(!other.exists(), "nothing copied");
        assert!(export_original(&src2, &other, &item(&s), true, true, NEVER, QUIET).is_ok());
        // Our sidecar of another photo with the same stem (a different source at `dest`): asked too.
        let pair = dir.path().join("Exports/Original + sidecar/DSCF1001.png");
        let pair_edit = export_sidecar(&settings(1.5), Some(1), Some(1200), Some(800)).unwrap();
        assert!(original_state(&fixtures().join("DSCF1003.jpg"), &pair, Some(&pair_edit)).replaces);
    }

    #[test]
    fn the_render_lane_is_released_before_the_encode() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings(0.0);
        let options = ExportOptions { long_edge: Some(200), ..ExportOptions::default() };
        let p = plan(dir.path(), "DSCF1001.jpg", &"a8".repeat(32), &s, "jpg");
        let order = std::cell::RefCell::new(Vec::new());
        let progress = |stage: &str| order.borrow_mut().push(stage.to_string());
        let released = || order.borrow_mut().push("released".into());
        export_one(&p, &s, &options, NEVER, &progress, &released).unwrap();
        assert_eq!(*order.borrow(), ["decode", "render", "released", "encode"]);
    }

    #[test]
    fn watermark_images_are_stored_by_content_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(30, 10, image::Rgba([255, 255, 255, 200])))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let src = dir.path().join("logo.png");
        fs::write(&src, &png).unwrap();
        let store = dir.path().join("watermarks");
        let info = import_watermark_into(&store, &src).unwrap();
        assert_eq!((info.name.as_str(), info.width, info.height), ("logo.png", 30, 10));
        let file = store.join(format!("{}.png", info.id));
        assert_eq!(read_watermark(&file, &info.id).unwrap(), png);
        fs::write(&file, b"tampered").unwrap();
        assert!(read_watermark(&file, &info.id).is_err());
        fs::write(dir.path().join("notes.png"), b"not a png").unwrap();
        assert!(import_watermark_into(&store, &dir.path().join("notes.png")).is_err());

        // Laid over an export: the bottom-right corner gets lighter, the rest is the plain export.
        fs::write(&file, &png).unwrap();
        let s = settings(0.0);
        let watermark = px::Watermark {
            kind: WatermarkKind::Image,
            image: Some(info.id.clone()),
            size: 0.2,
            opacity: 1.0,
            margin: 0.0,
            ..px::Watermark::default()
        };
        let plain = ExportOptions { long_edge: Some(300), metadata: ExportMetadata::None, ..ExportOptions::default() };
        let marked = ExportOptions { watermark: Some(watermark), ..plain.clone() };
        let mut p = plan(dir.path(), "DSCF1001.jpg", &"a7".repeat(32), &s, "png");
        let (plain, marked) = (
            ExportOptions { format: ExportFormat::Png, ..plain },
            ExportOptions { format: ExportFormat::Png, ..marked },
        );
        export_one(&p, &s, &plain, NEVER, QUIET, NOOP).unwrap();
        let a = image::load_from_memory(&fs::read(&p.dest).unwrap()).unwrap().to_rgb8();
        p.cache = p.cache.with_file_name("other.png");
        p.dest = p.dest.with_file_name("marked.png");
        p.assets = ExportAssets { watermark_png: Some(png) };
        export_one(&p, &s, &marked, NEVER, QUIET, NOOP).unwrap();
        let b = image::load_from_memory(&fs::read(&p.dest).unwrap()).unwrap().to_rgb8();
        assert_eq!(a.dimensions(), (300, 200));
        assert_eq!(a.get_pixel(10, 10), b.get_pixel(10, 10));
        let corner = |img: &image::RgbImage| img.get_pixel(295, 197)[0];
        assert!(corner(&b) > corner(&a), "{} vs {}", corner(&b), corner(&a));
    }
}
