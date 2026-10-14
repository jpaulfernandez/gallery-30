//! Folder scan, hashing, thumbnails and proxies (step 1.2).
//!
//! - `scan_folder` lists the photos in the source folder (JPEG, PNG, HEIC and camera RAW).
//! - `hash_files` streams SHA-256 over a list of files on a few worker threads and reports each
//!   result through the `asset:hashed` and `asset:hash-progress` events.
//! - `prepare_asset` writes `<appdata>/cache/<hash>/{thumb,proxy}.jpg` (upright, 256 and 1600 px
//!   long edge) plus a small `meta.json`, and returns the upright dimensions and absolute paths.
//! - `read_cache_dir` returns `<appdata>/cache` for `convertFileSrc`.
//!
//! JPEGs are decoded with libjpeg-turbo DCT scaling, so a 24 MP file is never fully decoded:
//! the decoder picks the smallest 1/8 multiple that still covers the target long edge, then
//! `fast_image_resize` (Lanczos3) brings it to the exact size.
//!
//! Colour: the proxy and thumbnail of a JPEG (and of a HEIC, through its `sips` JPEG) keep the source's ICC
//! profile (its APP2 segments are copied byte for byte), so WKWebView colour-manages a Display P3 photo on
//! the canvas as it does the Develop render.
//!
//! Camera RAW (step D6.1, `photobook_develop::decode::raw`): size, orientation and the as-shot white balance
//! come from the file's metadata (`raw_info`, no sensor decode); the proxy and thumbnail from the camera's
//! embedded JPEG preview when it is at least `RAW_PREVIEW_MIN_EDGE` px and has the RAW's aspect ratio, else
//! from a developed decode (default settings, display look on). `meta.json` then also records `isRaw` and
//! `asShot: [Kelvin, tint]`. The canvas and publish use the develop render of every RAW (see the assets store),
//! so the embedded preview only shows until that render exists.
//!
//! Camera metadata (workflow plan 23): `meta.json` records `exif: { make?, model?, iso? }`
//! (`photobook_develop::decode::camera_exif`, names cleaned); a `meta.json` from before has it added from the source
//! on its next `prepare_asset`. `prepare_asset` returns them (`iso`, `make`, `model`) with `noise`, the measured σ of
//! the photo's noise profile when `commands::noise` has cached one (`noise.json`), so the folder index and the
//! "Needs denoise" collection learn both.
//!
//! Capture facts and photo stats (plan 38, CULL_PLAN 5): `meta.json` also records `exif.taken` / `lens` / `focal` /
//! `serial`, `phash` (16 hex chars) and `stats` (`photobook_develop::stats`), computed in `prepare` from the upright
//! 8-bit proxy pixels already in memory, so nothing is decoded twice. They reach the webview as [`PhotoFacts`],
//! flattened into [`AssetInfo`], [`ScannedFile`] and the folder index's `IndexEntry`. A cache entry from before
//! (`factsVersion` below [`FACTS_VERSION`], or no `phash` / `stats`) is backfilled by [`cached`]: the Exif is read
//! again from the source and the stats from the cached `proxy.jpg`, inside the same `prepare_asset` call. A later
//! plan adding an index field adds it to [`PhotoFacts`], to [`facts_of`] and to the backfill, and bumps
//! [`FACTS_VERSION`] when the field comes from the Exif.
//!
//! Plan 52 adds `shutter`, `aperture` and `gps { lat, lon }` that way (`FACTS_VERSION` 2), and `open_map(lat, lon)`,
//! which opens Apple Maps at a photo's coordinates (the webview has no opener of its own).
//!
//! Plan 56 adds `palette` (five sRGB hex colours, `photobook_develop::stats::palette`, k-means in Oklab at 240 px)
//! the same way: computed with the stats from the proxy pixels in memory, backfilled by [`cached`] from the cached
//! `proxy.jpg` when `meta.json` has none (`FACTS_VERSION` 3).

use std::ffi::OsStr;
use std::fmt::Display;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use fast_image_resize as fr;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Semaphore;
use turbojpeg::{Compressor, Decompressor, PixelFormat, ScalingFactor, Subsamp};
use walkdir::WalkDir;

use crate::commands::folders;
use crate::commands::projects::LEGACY_BOOK_FILE_NAME;
use crate::error::{Error, IoContext, Result};
use crate::scope::{self, ensure_allowed};

pub const THUMB_EDGE: u32 = 256;
pub const PROXY_EDGE: u32 = 1600;
const THUMB_QUALITY: i32 = 82;
const PROXY_QUALITY: i32 = 85;
const HASH_BUFFER: usize = 1 << 20;
const MAX_HASH_THREADS: usize = 4;

const PUBLISH_DIR: &str = ".photobook-publish";
pub(crate) const SOURCE_CACHE_DIR: &str = ".photobook-cache";
pub(crate) const THUMB_FILE: &str = "thumb.jpg";
pub(crate) const PROXY_FILE: &str = "proxy.jpg";
const META_FILE: &str = "meta.json";
/// HEIC files (and JPEGs libjpeg-turbo cannot read, e.g. CMYK) are converted once with `sips`.
const SIPS_SOURCE_FILE: &str = "source.jpg";

pub const EVENT_HASHED: &str = "asset:hashed";
pub const EVENT_HASH_PROGRESS: &str = "asset:hash-progress";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Jpeg,
    Png,
    Heic,
    /// Camera RAW (`photobook_develop::decode::RAW_EXTENSIONS`).
    Raw,
}

/// What the cull groups and ranks on (plan 38): when and with what a photo was taken, its perceptual hash and its
/// stats. One optional-field set, flattened into [`AssetInfo`], [`ScannedFile`] and `folders::IndexEntry`, so every
/// later index field is added here once.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhotoFacts {
    /// Capture time, epoch ms of the camera's clock read as UTC (`DateTimeOriginal` + `SubSecTimeOriginal`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<i64>,
    /// Camera maker and model, cleaned ("Fujifilm", "X-T5").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    /// Focal length, mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal: Option<f64>,
    /// DCT perceptual hash of the proxy, 16 lowercase hex chars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<photobook_develop::stats::PhotoStats>,
    /// Plan 52: exposure time, seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shutter: Option<f64>,
    /// Plan 52: the f-number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aperture: Option<f64>,
    /// Plan 52: where it was taken, decimal degrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps: Option<photobook_develop::decode::Gps>,
    /// Plan 56: five colours of the proxy as `#rrggbb`, most of the picture first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<Vec<String>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Relative to the source folder, `/`-separated.
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub kind: Kind,
    /// From the folder's `index.json` when its entry still matches the file (same size, mtime and kind), so the
    /// editor neither hashes nor waits for `prepare_asset` to know the photo (workflow plan 05). Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// σ at mid-grey of the measured noise profile (workflow plan 23), from the index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noise: Option<f64>,
    /// Capture facts and stats (plan 38), from the index.
    #[serde(flatten)]
    pub facts: PhotoFacts,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    /// Upright (orientation applied) pixel size of the original (for RAW: of the developed full render).
    pub width: u32,
    pub height: u32,
    /// EXIF orientation 1 to 8 of the decoded source (1 when absent).
    pub orientation: u32,
    pub thumb_path: String,
    pub proxy_path: String,
    /// A camera RAW: renders always go through the develop pipeline, and white balance is absolute.
    pub is_raw: bool,
    /// RAW only: the as-shot white balance as `[Kelvin, tint]`, where the Absolute sliders start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub as_shot: Option<[f64; 2]>,
    /// Camera metadata (workflow plan 23), absent when the file has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// Make, model, capture time, lens, focal length, perceptual hash and stats (plans 23 and 38).
    #[serde(flatten)]
    pub facts: PhotoFacts,
    /// σ at mid-grey of the photo's measured noise profile, once `noise_profile` has run for it. Always sent (null
    /// when there is none, or it is of an older engine), so a stale value in the folder index is cleared.
    pub noise: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HashedEvent<'a> {
    job: u64,
    rel_path: &'a str,
    hash: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct HashProgressEvent {
    job: u64,
    done: usize,
    total: usize,
}

/// Upright size and orientation, stored next to the cached images so a warm call is a file read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Meta {
    width: u32,
    height: u32,
    orientation: u32,
    /// Absent (false) in caches written before RAW support, which never held a RAW.
    #[serde(default, rename = "isRaw", skip_serializing_if = "std::ops::Not::not")]
    is_raw: bool,
    #[serde(default, rename = "asShot", skip_serializing_if = "Option::is_none")]
    as_shot: Option<[f64; 2]>,
    /// Make, model and ISO (plan 23), capture time, lens, focal length and serial (plan 38); `None` in caches
    /// written before plan 23, filled in from the source by [`cached`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exif: Option<photobook_develop::decode::CameraExif>,
    /// Which [`FACTS_VERSION`] read `exif`; 0 (absent) before plan 38.
    #[serde(default, rename = "factsVersion")]
    facts_version: u32,
    /// Plan 38: the proxy's perceptual hash and stats; `None` in caches written before, filled in by [`cached`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    phash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stats: Option<photobook_develop::stats::PhotoStats>,
    /// Plan 56: the proxy's palette; `None` in caches written before, filled in by [`cached`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    palette: Option<Vec<String>>,
}

/// Bumped when a plan adds an index field, so [`cached`] reads the source again (1: plan 38's `taken`, `lens`,
/// `focal`, `serial`; 2: plan 52's `shutter`, `aperture`, `gps`; 3: plan 56's `palette`, which itself comes from the
/// proxy and is backfilled whenever it is missing).
const FACTS_VERSION: u32 = 3;

/// Shared state for the asset commands.
pub struct AssetJobs {
    /// Highest `hash_files` job id seen; workers of lower jobs stop early.
    hash_job: AtomicU64,
    /// Caps concurrent `prepare_asset` decodes at about one per core, leaving one free.
    prepare: Arc<Semaphore>,
}

impl Default for AssetJobs {
    fn default() -> Self {
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        Self { hash_job: AtomicU64::new(0), prepare: Arc::new(Semaphore::new(cores.saturating_sub(1).max(1))) }
    }
}

// ---------------------------------------------------------------------------------------------
// Commands

/// Every photo under `folder` (recursive), sorted by relative path. Skips hidden files and
/// folders, the project file, `.photobook-publish/` and `.photobook-cache/`. Files whose
/// `.photobook/index.json` entry still matches carry its hash and size (`folders::apply_index`).
#[tauri::command]
pub async fn scan_folder<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Vec<ScannedFile>> {
    let root = source_root(&app, &folder)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mut files = scan(&root);
        let index = folders::load_index(&root);
        let reused = folders::apply_index(&index, &mut files);
        log::info!(
            "[photobook:index] scanned {}: {} photos, {reused} from the index ({} entries)",
            root.display(),
            files.len(),
            index.len()
        );
        files
    })
    .await?)
}

/// Hash `rel_paths` (relative to `folder`) in order on a few threads. Emits `asset:hashed`
/// `{ job, relPath, hash, error }` per file and `asset:hash-progress` `{ job, done, total }` after
/// each one. A call with a higher `job` cancels lower ones (a call with no files just cancels).
/// Resolves when every file is done or the job was cancelled.
#[tauri::command]
pub async fn hash_files<R: Runtime>(app: AppHandle<R>, folder: String, rel_paths: Vec<String>, job: u64) -> Result<()> {
    let root = source_root(&app, &folder)?;
    let files: Vec<(String, std::result::Result<PathBuf, String>)> = rel_paths
        .into_iter()
        .map(|rel| {
            let path = resolve_rel(&app, &root, &rel).map_err(|err| err.to_string());
            (rel, path)
        })
        .collect();
    // Job ids only grow, so a stale call arriving late can never cancel a newer one.
    app.state::<AssetJobs>().hash_job.fetch_max(job, Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        let current = &app.state::<AssetJobs>().hash_job;
        let total = files.len();
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get()).min(MAX_HASH_THREADS);
        std::thread::scope(|s| {
            for _ in 0..threads.min(total) {
                s.spawn(|| loop {
                    if current.load(Ordering::SeqCst) != job {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some((rel_path, path)) = files.get(i) else { break };
                    let result = path.clone().and_then(|p| hash_file(&p).map_err(|err| err.to_string()));
                    let (hash, error) = match result {
                        Ok(hash) => (Some(hash), None),
                        Err(err) => (None, Some(err)),
                    };
                    let _ = app.emit(EVENT_HASHED, HashedEvent { job, rel_path, hash, error });
                    let done = done.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit(EVENT_HASH_PROGRESS, HashProgressEvent { job, done, total });
                });
            }
        });
    })
    .await?;
    Ok(())
}

/// Make sure the thumbnail and proxy of `rel_path` exist in the cache under `hash` and return
/// the upright size, orientation and absolute cache paths. Already cached files are not redone.
#[tauri::command]
pub async fn prepare_asset<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
) -> Result<AssetInfo> {
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let kind =
        kind_of(&src).ok_or_else(|| Error::Invalid(format!("{rel_path} is not a JPEG, PNG, HEIC or camera RAW file")))?;
    let dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    // A warm entry is a file read; one that needs a backfill (plan 38: a proxy decode) waits for the permit below.
    let cached_dir = dir.clone();
    if let Some(info) = tauri::async_runtime::spawn_blocking(move || cached_current(&cached_dir)).await? {
        return Ok(info);
    }
    let permit = app
        .state::<AssetJobs>()
        .prepare
        .clone()
        .acquire_owned()
        .await
        .map_err(|err| Error::Invalid(err.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        prepare(&src, kind, &dir)
    })
    .await?
}

/// Absolute path of the thumbnail and proxy cache root, `<appdata>/cache`.
#[tauri::command]
pub async fn read_cache_dir<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    Ok(cache_root(&app)?.to_string_lossy().into_owned())
}

/// `folder` must be one of the imported folders itself (`scope::ensure_imported_root`), not a subfolder.
pub(crate) fn source_root<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf> {
    let root = scope::ensure_imported_root(app, folder)?;
    if !root.is_dir() {
        return Err(Error::Invalid(format!("{} is not a folder", root.display())));
    }
    Ok(root)
}

pub(crate) fn resolve_rel<R: Runtime>(app: &AppHandle<R>, root: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(Error::Invalid(format!("Invalid relative path {rel}")));
    }
    ensure_allowed(app, root.join(rel_path))
}

pub(crate) fn cache_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = scope::app_data_dir(app)?.join("cache");
    fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// `<cache>/<hash>`; `hash` must be a lowercase SHA-256 hex digest.
pub(crate) fn cache_entry_dir(cache: &Path, hash: &str) -> Result<PathBuf> {
    let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(Error::Invalid(format!("Invalid asset hash {hash:?}")));
    }
    Ok(cache.join(hash))
}

// ---------------------------------------------------------------------------------------------
// Scan

pub(crate) fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some(Kind::Jpeg),
        "png" => Some(Kind::Png),
        "heic" | "heif" => Some(Kind::Heic),
        e if photobook_develop::decode::RAW_EXTENSIONS.contains(&e) => Some(Kind::Raw),
        _ => None,
    }
}

/// The folder Export writes into by default (`<folder>/Exports/<preset>/`, workflow plan 11; `defaultExportDir` in
/// `packages/shared`): skipped at the top of a scan so exported files never come back as photos.
pub(crate) const EXPORTS_DIR: &str = "Exports";

fn is_skipped(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') || name == LEGACY_BOOK_FILE_NAME || name == PUBLISH_DIR || name == SOURCE_CACHE_DIR
}

pub fn scan(root: &Path) -> Vec<ScannedFile> {
    let mut files: Vec<ScannedFile> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !(is_skipped(e.file_name())
                    || (e.depth() == 1 && e.file_type().is_dir() && e.file_name() == EXPORTS_DIR))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let kind = kind_of(e.path())?;
            let rel = e.path().strip_prefix(root).ok()?;
            let rel_path = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            let meta = e.metadata().ok()?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            Some(ScannedFile {
                rel_path,
                size: meta.len(),
                mtime_ms,
                kind,
                hash: None,
                width: None,
                height: None,
                orientation: None,
                iso: None,
                noise: None,
                facts: PhotoFacts::default(),
            })
        })
        .collect();
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    files
}

// ---------------------------------------------------------------------------------------------
// Hash

/// Lowercase hex SHA-256 of the file, streamed in 1 MB chunks.
pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).ctx(format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUFFER];
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(Error::Io(format!("reading {}", path.display()), err)),
        };
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// ---------------------------------------------------------------------------------------------
// Thumbnail and proxy

fn decode_err(what: impl Display, err: impl Display) -> Error {
    Error::Invalid(format!("{what}: {err}"))
}

/// The cached result when thumb, proxy and meta all exist. A `meta.json` from before plan 23 or 38 is backfilled
/// and rewritten (best effort): camera metadata read again from `src` when its `factsVersion` is older than
/// [`FACTS_VERSION`], the perceptual hash and stats from the cached `proxy.jpg` when either is missing.
fn cached(dir: &Path, src: &Path) -> Option<AssetInfo> {
    let thumb = dir.join(THUMB_FILE);
    let proxy = dir.join(PROXY_FILE);
    if !(thumb.is_file() && proxy.is_file()) {
        return None;
    }
    let mut meta: Meta = serde_json::from_slice(&fs::read(dir.join(META_FILE)).ok()?).ok()?;
    if !needs_backfill(&meta) {
        return Some(asset_info(meta, &thumb, &proxy));
    }
    let mut changed = false;
    if meta.exif.is_none() || meta.facts_version < FACTS_VERSION {
        meta.exif = Some(photobook_develop::decode::camera_exif(src));
        meta.facts_version = FACTS_VERSION;
        changed = true;
    }
    if meta.phash.is_none() || meta.stats.is_none() || meta.palette.is_none() {
        match proxy_file_facts(&proxy) {
            Ok(facts) => {
                facts.fill(&mut meta);
                changed = true;
            }
            Err(err) => log::info!("[photobook:assets] no stats for {}: {err}", proxy.display()),
        }
    }
    if changed {
        if let Ok(json) = serde_json::to_vec(&meta) {
            let _ = write_atomic(&dir.join(META_FILE), &json);
        }
    }
    Some(asset_info(meta, &thumb, &proxy))
}

/// The cached result when thumb, proxy and meta exist and the meta needs no backfill: a file read only, so
/// `prepare_asset` runs it before taking a `prepare` permit.
fn cached_current(dir: &Path) -> Option<AssetInfo> {
    let thumb = dir.join(THUMB_FILE);
    let proxy = dir.join(PROXY_FILE);
    if !(thumb.is_file() && proxy.is_file()) {
        return None;
    }
    let meta: Meta = serde_json::from_slice(&fs::read(dir.join(META_FILE)).ok()?).ok()?;
    (!needs_backfill(&meta)).then(|| asset_info(meta, &thumb, &proxy))
}

/// A `meta.json` from before plan 23 or 38, which [`cached`] fills in.
fn needs_backfill(meta: &Meta) -> bool {
    meta.exif.is_none()
        || meta.facts_version < FACTS_VERSION
        || meta.phash.is_none()
        || meta.stats.is_none()
        || meta.palette.is_none()
}

/// What [`proxy_facts`] measures on the proxy pixels.
struct ProxyFacts {
    phash: String,
    stats: photobook_develop::stats::PhotoStats,
    palette: Vec<String>,
}

impl ProxyFacts {
    fn fill(self, meta: &mut Meta) {
        (meta.phash, meta.stats, meta.palette) = (Some(self.phash), Some(self.stats), Some(self.palette));
    }
}

/// Plan 38: the perceptual hash (16 hex chars) and the stats of upright 8-bit RGB proxy pixels; plan 56: the palette.
fn proxy_facts(rgb: &[u8], width: u32, height: u32) -> ProxyFacts {
    use photobook_develop::stats::{luma, palette, phash, photo_stats};
    let gray = luma(rgb);
    ProxyFacts {
        phash: format!("{:016x}", phash(&gray, width, height)),
        stats: photo_stats(&gray, rgb, width, height, None),
        palette: palette(rgb, width, height),
    }
}

/// [`proxy_facts`] of a cached `proxy.jpg` (the backfill of a cache entry from before plan 38 or 56).
fn proxy_file_facts(proxy: &Path) -> Result<ProxyFacts> {
    let source = load_jpeg(proxy, Some(PROXY_EDGE))?;
    let pixels = source.pixels.ok_or_else(|| Error::Invalid(format!("{}: not decoded", proxy.display())))?;
    Ok(proxy_facts(&pixels.data, pixels.width, pixels.height))
}

/// The [`PhotoFacts`] a cache entry's `meta.json` holds.
fn facts_of(meta: &Meta) -> PhotoFacts {
    let exif = meta.exif.clone().unwrap_or_default();
    PhotoFacts {
        taken: exif.taken,
        make: exif.make,
        model: exif.model,
        lens: exif.lens,
        focal: exif.focal,
        phash: meta.phash.clone(),
        stats: meta.stats,
        shutter: exif.shutter,
        aperture: exif.aperture,
        gps: exif.gps,
        palette: meta.palette.clone(),
    }
}

/// Plan 52: open Apple Maps at a photo's location. Only the two numbers reach the URL (no text from the webview), and
/// they must be a position: finite, latitude within ±90 and longitude within ±180.
#[tauri::command]
pub async fn open_map(lat: f64, lon: f64) -> Result<()> {
    open_url(&map_url(lat, lon)?)
}

/// The Apple Maps URL of a position (a pin at it), or an error for a value that is not one.
fn map_url(lat: f64, lon: f64) -> Result<String> {
    let valid = lat.is_finite() && lon.is_finite() && (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon);
    if !valid {
        return Err(Error::Invalid(format!("Not a position: {lat}, {lon}")));
    }
    Ok(format!("https://maps.apple.com/?ll={lat:.6},{lon:.6}&q={lat:.6},{lon:.6}"))
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<()> {
    // `open -b com.apple.Maps`: the Maps app itself, never whatever handles https on this Mac.
    let status = Command::new("/usr/bin/open").args(["-b", "com.apple.Maps", url]).status().ctx("running open")?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(format!("open {url} failed ({status})")))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_url(url: &str) -> Result<()> {
    Err(Error::Invalid(format!("Opening Maps is only supported on macOS ({url})")))
}

/// The upright size `prepare_asset` recorded in `dir`'s `meta.json` (workflow plan 23: what a noise measurement was
/// downscaled from).
pub(crate) fn cached_size(dir: &Path) -> Option<(u32, u32)> {
    let meta: Meta = serde_json::from_slice(&fs::read(dir.join(META_FILE)).ok()?).ok()?;
    Some((meta.width, meta.height))
}

fn asset_info(meta: Meta, thumb: &Path, proxy: &Path) -> AssetInfo {
    let facts = facts_of(&meta);
    let iso = meta.exif.and_then(|exif| exif.iso);
    let noise = thumb.parent().and_then(crate::commands::noise::cached_sigma);
    AssetInfo {
        width: meta.width,
        height: meta.height,
        orientation: meta.orientation,
        thumb_path: thumb.to_string_lossy().into_owned(),
        proxy_path: proxy.to_string_lossy().into_owned(),
        is_raw: meta.is_raw,
        as_shot: meta.as_shot,
        iso,
        facts,
        noise,
    }
}

/// Decoded pixels, interleaved u8, 3 (RGB) or 4 (RGBA) channels.
pub(crate) struct Pixels {
    pub(crate) data: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) channels: u8,
}

/// What a decode returns: stored (not upright) size of the original, its orientation, and the
/// pixels at a reduced size when asked for.
struct Source {
    width: u32,
    height: u32,
    orientation: u32,
    pixels: Option<Pixels>,
    /// The source JPEG's APP2 ICC profile segments, copied into the proxy and thumbnail (empty when none).
    icc: Vec<u8>,
}

/// Write any missing thumb/proxy for `src` into `dir` and return the asset info.
pub fn prepare(src: &Path, kind: Kind, dir: &Path) -> Result<AssetInfo> {
    if let Some(info) = cached(dir, src) {
        return Ok(info);
    }
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    if kind == Kind::Raw {
        return prepare_raw(src, dir);
    }
    let thumb = dir.join(THUMB_FILE);
    let proxy = dir.join(PROXY_FILE);
    let need_thumb = !thumb.is_file();
    let need_proxy = !proxy.is_file();
    // Decode just big enough for the largest output still missing (no decode if only meta is).
    let target = if need_proxy {
        Some(PROXY_EDGE)
    } else if need_thumb {
        Some(THUMB_EDGE)
    } else {
        None
    };

    let source = load(src, kind, dir, target)?;
    let mut meta = upright_meta(&source);
    meta.exif = Some(photobook_develop::decode::camera_exif(src));
    if let Some(pixels) = source.pixels {
        let (w, h) = (source.width, source.height);
        let mut base = pixels;
        if need_proxy {
            // The thumb then comes from the proxy-sized pixels: cheaper and just as sharp.
            base = resize(&base, fit(w, h, PROXY_EDGE))?;
            let upright = orient(&base, source.orientation)?;
            write_jpeg(&upright, PROXY_QUALITY, &source.icc, &proxy)?;
            crate::commands::develop::histogram::forget_plain(dir);
            // Plan 38: the stats come from the same upright pixels, before they are dropped.
            proxy_facts(upright.as_raw(), upright.width(), upright.height()).fill(&mut meta);
        }
        if need_thumb {
            let resized = resize(&base, fit(w, h, THUMB_EDGE))?;
            write_jpeg(&orient(&resized, source.orientation)?, THUMB_QUALITY, &source.icc, &thumb)?;
        }
    }
    if meta.stats.is_none() {
        // The proxy was already on disk (only the thumb or the meta was missing).
        if let Ok(facts) = proxy_file_facts(&proxy) {
            facts.fill(&mut meta);
        }
    }
    let json = serde_json::to_vec(&meta).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&dir.join(META_FILE), &json)?;
    Ok(asset_info(meta, &thumb, &proxy))
}

fn upright_meta(source: &Source) -> Meta {
    let swap = (5..=8).contains(&source.orientation);
    let (width, height) = if swap { (source.height, source.width) } else { (source.width, source.height) };
    Meta {
        width,
        height,
        orientation: source.orientation,
        is_raw: false,
        as_shot: None,
        exif: None,
        facts_version: FACTS_VERSION,
        phash: None,
        stats: None,
        palette: None,
    }
}

/// Smallest embedded RAW preview (long edge, px) used for the proxy; smaller ones (thumbnails) are skipped
/// for a developed decode.
const RAW_PREVIEW_MIN_EDGE: u32 = 1024;
/// How far (relative) an embedded preview's aspect ratio may be from the RAW's before it is taken for a
/// letterboxed or cropped picture (Sony's 16:9 previews of 3:2 sensors) and skipped.
const RAW_PREVIEW_ASPECT_TOLERANCE: f64 = 0.015;

/// Thumb, proxy and meta of a camera RAW (see the module notes). Always writes all three.
fn prepare_raw(src: &Path, dir: &Path) -> Result<AssetInfo> {
    use photobook_develop::decode::raw::{embedded_preview, raw_info};
    let start = std::time::Instant::now();
    let thumb = dir.join(THUMB_FILE);
    let proxy = dir.join(PROXY_FILE);
    let what = || src.display().to_string();
    // Metadata only; fails for rotated (Fujifilm SuperCCD) sensors, whose size only the decode knows.
    let info = raw_info(src).map_err(|err| log::info!("[photobook:assets] raw_info {}: {err}", what())).ok();
    let preview = info.as_ref().and_then(|info| {
        let preview = embedded_preview(src, RAW_PREVIEW_MIN_EDGE)?;
        let ratio = |w: u32, h: u32| w.max(h) as f64 / w.min(h).max(1) as f64;
        let (want, got) = (ratio(info.width, info.height), ratio(preview.width, preview.height));
        ((got / want - 1.0).abs() <= RAW_PREVIEW_ASPECT_TOLERANCE).then_some(preview)
    });
    let (meta, source) = match (info, preview) {
        (Some(info), Some(preview)) => {
            let pixels = Pixels { data: preview.rgb, width: preview.width, height: preview.height, channels: 3 };
            let (w, h) = (pixels.width, pixels.height);
            let base = resize(&pixels, fit(w, h, PROXY_EDGE))?;
            let upright = orient(&base, info.orientation)?;
            write_jpeg(&upright, PROXY_QUALITY, &[], &proxy)?;
            crate::commands::develop::histogram::forget_plain(dir);
            let small = resize(&base, fit(w, h, THUMB_EDGE))?;
            write_jpeg(&orient(&small, info.orientation)?, THUMB_QUALITY, &[], &thumb)?;
            let mut meta = raw_meta(info.width, info.height, info.orientation, info.as_shot);
            proxy_facts(upright.as_raw(), upright.width(), upright.height()).fill(&mut meta);
            (meta, "embedded preview")
        }
        (info, _) => {
            let (meta, rendered) = develop_raw_proxy(src, info)?;
            let encode = |img: &photobook_develop::Rgb8Image, q: i32| {
                photobook_develop::encode_jpeg(img, q as u8).map_err(|e| decode_err(what(), e))
            };
            write_atomic(&proxy, &encode(&rendered, PROXY_QUALITY)?)?;
            crate::commands::develop::histogram::forget_plain(dir);
            let mut meta = meta;
            proxy_facts(&rendered.data, rendered.width, rendered.height).fill(&mut meta);
            let pixels = Pixels { data: rendered.data, width: rendered.width, height: rendered.height, channels: 3 };
            let small = resize(&pixels, fit(pixels.width, pixels.height, THUMB_EDGE))?;
            let small = photobook_develop::Rgb8Image::new(small.width, small.height, small.data);
            write_atomic(&thumb, &encode(&small, THUMB_QUALITY)?)?;
            (meta, "developed decode")
        }
    };
    let meta = Meta { exif: Some(photobook_develop::decode::camera_exif(src)), ..meta };
    let json = serde_json::to_vec(&meta).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&dir.join(META_FILE), &json)?;
    log::info!(
        "[photobook:assets] raw proxy {} {}x{} from {source} in {}ms",
        src.file_name().unwrap_or_default().to_string_lossy(),
        meta.width,
        meta.height,
        start.elapsed().as_millis()
    );
    Ok(asset_info(meta, &thumb, &proxy))
}

fn raw_meta(width: u32, height: u32, orientation: u32, (kelvin, tint): (f64, f64)) -> Meta {
    Meta {
        width,
        height,
        orientation,
        is_raw: true,
        as_shot: Some([kelvin.round(), (tint * 10.0).round() / 10.0]),
        exif: None,
        facts_version: FACTS_VERSION,
        phash: None,
        stats: None,
        palette: None,
    }
}

/// A RAW without a usable embedded preview: decode (at the proxy size when `info` knows the full size, else in
/// full) and develop with the default settings (display look on, as every RAW render), upright, long edge at
/// most `PROXY_EDGE`.
fn develop_raw_proxy(
    src: &Path,
    info: Option<photobook_develop::decode::raw::RawInfo>,
) -> Result<(Meta, photobook_develop::Rgb8Image)> {
    use photobook_develop::{decode::decode_raw, decode::resize_linear, render_full, DevelopSettings};
    let decoded = decode_raw(src, info.as_ref().map(|_| PROXY_EDGE))?;
    let mut image = decoded.image;
    let meta = match info {
        Some(info) => raw_meta(info.width, info.height, info.orientation, info.as_shot),
        None => {
            let as_shot = image.meta.as_shot.unwrap_or((5000.0, 0.0));
            let meta = raw_meta(image.width, image.height, decoded.camera.orientation, as_shot);
            let (w, h) = fit(image.width, image.height, PROXY_EDGE);
            if (w, h) != (image.width, image.height) {
                image = resize_linear(image, w, h)?;
            }
            meta
        }
    };
    Ok((meta, render_full(&image, &DevelopSettings::default())?))
}

fn load(src: &Path, kind: Kind, dir: &Path, target: Option<u32>) -> Result<Source> {
    match kind {
        Kind::Png => load_png(src, target.is_some()),
        Kind::Heic => load_jpeg(&sips_to_jpeg(src, dir)?, target),
        Kind::Raw => Err(Error::Invalid(format!("{}: RAW files are prepared by prepare_raw", src.display()))),
        Kind::Jpeg => load_jpeg(src, target).or_else(|err| {
            // libjpeg-turbo cannot convert e.g. CMYK or 12-bit JPEGs; let macOS do it once.
            let converted = sips_to_jpeg(src, dir).map_err(|_| err)?;
            load_jpeg(&converted, target)
        }),
    }
}

fn exif_orientation<R: BufRead + Seek>(reader: &mut R) -> u32 {
    exif::Reader::new()
        .read_from_container(reader)
        .ok()
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0))
        })
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1)
}

/// The smallest supported DCT scale (<= 1) whose scaled long edge still covers `target`.
fn pick_scale(long_edge: usize, target: usize) -> ScalingFactor {
    Decompressor::supported_scaling_factors()
        .into_iter()
        .filter(|f| f.num() <= f.denom() && f.scale(long_edge) >= target)
        .min_by(|a, b| (a.num() * b.denom()).cmp(&(b.num() * a.denom())))
        .unwrap_or(ScalingFactor::ONE)
}

fn load_jpeg(path: &Path, target: Option<u32>) -> Result<Source> {
    let bytes = fs::read(path).ctx(format!("reading {}", path.display()))?;
    let what = || path.display().to_string();
    let mut decompressor = Decompressor::new().map_err(|e| decode_err(what(), e))?;
    let header = decompressor.read_header(&bytes).map_err(|e| decode_err(what(), e))?;
    let orientation = exif_orientation(&mut Cursor::new(&bytes));
    let icc = icc_segments(&bytes);
    let pixels = match target {
        None => None,
        Some(target) => {
            let factor = pick_scale(header.width.max(header.height), target as usize);
            decompressor.set_scaling_factor(factor).map_err(|e| decode_err(what(), e))?;
            let scaled = header.scaled(factor);
            let mut image = turbojpeg::Image {
                pixels: vec![0u8; scaled.width * scaled.height * 3],
                width: scaled.width,
                pitch: scaled.width * 3,
                height: scaled.height,
                format: PixelFormat::RGB,
            };
            decompressor.decompress(&bytes, image.as_deref_mut()).map_err(|e| decode_err(what(), e))?;
            Some(Pixels { data: image.pixels, width: scaled.width as u32, height: scaled.height as u32, channels: 3 })
        }
    };
    Ok(Source { width: header.width as u32, height: header.height as u32, orientation, pixels, icc })
}

fn load_png(path: &Path, decode: bool) -> Result<Source> {
    let what = || path.display().to_string();
    let orientation = File::open(path).map(|f| exif_orientation(&mut BufReader::new(f))).unwrap_or(1);
    let reader = image::ImageReader::open(path)
        .ctx(format!("opening {}", path.display()))?
        .with_guessed_format()
        .ctx(format!("reading {}", path.display()))?;
    if !decode {
        let (width, height) = reader.into_dimensions().map_err(|e| decode_err(what(), e))?;
        return Ok(Source { width, height, orientation, pixels: None, icc: Vec::new() });
    }
    let img = reader.decode().map_err(|e| decode_err(what(), e))?;
    let (width, height) = (img.width(), img.height());
    let pixels = if img.color().has_alpha() {
        Pixels { data: img.into_rgba8().into_raw(), width, height, channels: 4 }
    } else {
        Pixels { data: img.into_rgb8().into_raw(), width, height, channels: 3 }
    };
    Ok(Source { width, height, orientation, pixels: Some(pixels), icc: Vec::new() })
}

/// Convert with macOS `sips` into `<dir>/source.jpg` once and return that path.
pub(crate) fn sips_to_jpeg(src: &Path, dir: &Path) -> Result<PathBuf> {
    let out = dir.join(SIPS_SOURCE_FILE);
    if out.is_file() {
        return Ok(out);
    }
    let tmp = dir.join(format!(".source.{}.{}.jpg", std::process::id(), unique()));
    let status = Command::new("sips")
        .args(["-s", "format", "jpeg"])
        .arg(src)
        .arg("--out")
        .arg(&tmp)
        .output()
        .ctx("running sips")?;
    if !status.status.success() || !tmp.is_file() {
        let _ = fs::remove_file(&tmp);
        return Err(Error::Invalid(format!(
            "sips could not convert {}: {}",
            src.display(),
            String::from_utf8_lossy(&status.stderr).trim()
        )));
    }
    fs::rename(&tmp, &out).ctx(format!("writing {}", out.display()))?;
    Ok(out)
}

/// Size of an image with stored size `w x h` scaled so its long edge is `edge` (never upscaled).
pub(crate) fn fit(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= edge {
        return (w, h);
    }
    let scale = |v: u32| ((v as f64 * edge as f64 / long as f64).round() as u32).max(1);
    if w >= h {
        (edge, scale(h))
    } else {
        (scale(w), edge)
    }
}

pub(crate) fn resize(src: &Pixels, (width, height): (u32, u32)) -> Result<Pixels> {
    if (src.width, src.height) == (width, height) {
        return Ok(Pixels { data: src.data.clone(), width, height, channels: src.channels });
    }
    let pixel_type = if src.channels == 4 { fr::PixelType::U8x4 } else { fr::PixelType::U8x3 };
    let src_image = fr::images::ImageRef::new(src.width, src.height, &src.data, pixel_type)
        .map_err(|e| decode_err("resize", e))?;
    let mut dst = fr::images::Image::new(width, height, pixel_type);
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3));
    fr::Resizer::new().resize(&src_image, &mut dst, &options).map_err(|e| decode_err("resize", e))?;
    Ok(Pixels { data: dst.into_vec(), width, height, channels: src.channels })
}

/// Flatten alpha onto white and apply the EXIF orientation so the result is upright RGB.
fn orient(pixels: &Pixels, orientation: u32) -> Result<image::RgbImage> {
    use image::imageops;
    let Pixels { data, width, height, channels } = pixels;
    let data: Vec<u8> = if *channels == 4 {
        data.chunks_exact(4)
            .flat_map(|p| {
                let a = p[3] as u32;
                let blend = move |c: u8| ((c as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
                [blend(p[0]), blend(p[1]), blend(p[2])]
            })
            .collect()
    } else {
        data.clone()
    };
    let img = image::RgbImage::from_raw(*width, *height, data)
        .ok_or_else(|| Error::Invalid("pixel buffer has the wrong size".into()))?;
    Ok(match orientation {
        2 => imageops::flip_horizontal(&img),
        3 => imageops::rotate180(&img),
        4 => imageops::flip_vertical(&img),
        5 => imageops::flip_horizontal(&imageops::rotate90(&img)),
        6 => imageops::rotate90(&img),
        7 => imageops::flip_horizontal(&imageops::rotate270(&img)),
        8 => imageops::rotate270(&img),
        _ => img,
    })
}

/// Encode `img` and write it to `target`, with `icc` (whole APP2 segments, see [`icc_segments`]) inserted.
fn write_jpeg(img: &image::RgbImage, quality: i32, icc: &[u8], target: &Path) -> Result<()> {
    let what = || target.display().to_string();
    let mut compressor = Compressor::new().map_err(|e| decode_err(what(), e))?;
    compressor.set_quality(quality).map_err(|e| decode_err(what(), e))?;
    compressor.set_subsamp(Subsamp::Sub2x2).map_err(|e| decode_err(what(), e))?;
    let (width, height) = (img.width() as usize, img.height() as usize);
    let image = turbojpeg::Image { pixels: img.as_raw().as_slice(), width, pitch: width * 3, height, format: PixelFormat::RGB };
    let mut bytes = compressor.compress_to_vec(image).map_err(|e| decode_err(what(), e))?;
    insert_segments(&mut bytes, icc);
    write_atomic(target, &bytes)
}

/// Signature of a JPEG APP2 ICC profile chunk.
pub(crate) const ICC_SIGNATURE: &[u8] = b"ICC_PROFILE\0";

/// The APP2 `ICC_PROFILE` segments of a JPEG, whole (marker, length and payload) and in file order, so they can
/// be copied byte for byte into another JPEG. Empty when there are none or `jpeg` is not a JPEG.
pub(crate) fn icc_segments(jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return out;
    }
    let mut pos = 2;
    while pos + 4 <= jpeg.len() && jpeg[pos] == 0xFF {
        let marker = jpeg[pos + 1];
        if marker == 0xFF {
            pos += 1; // fill byte
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // the scan or the end: no more headers
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        let len = u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > jpeg.len() {
            break;
        }
        let segment = &jpeg[pos..pos + 2 + len];
        if marker == 0xE2 && segment[4..].starts_with(ICC_SIGNATURE) {
            out.extend_from_slice(segment);
        }
        pos += 2 + len;
    }
    out
}

/// Insert whole marker segments after SOI and the JFIF APP0 segment libjpeg-turbo writes first.
fn insert_segments(jpeg: &mut Vec<u8>, segments: &[u8]) {
    if segments.is_empty() || !jpeg.starts_with(&[0xFF, 0xD8]) {
        return;
    }
    let mut at = 2;
    if jpeg.len() >= 6 && jpeg[2] == 0xFF && jpeg[3] == 0xE0 {
        at = (4 + u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize).min(jpeg.len());
    }
    jpeg.splice(at..at, segments.iter().copied());
}

fn unique() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Temp file + rename, so two calls racing on the same hash never leave a torn file.
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let tmp = target.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), unique()));
    fs::write(&tmp, bytes)
        .and_then(|()| fs::rename(&tmp, target))
        .map_err(|err| {
            let _ = fs::remove_file(&tmp);
            Error::Io(format!("writing {}", target.display()), err)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip").canonicalize().unwrap()
    }

    fn jpeg_size(path: &str) -> (u32, u32) {
        let header = turbojpeg::read_header(&fs::read(path).unwrap()).unwrap();
        (header.width as u32, header.height as u32)
    }

    #[test]
    fn scans_the_fixture_folder() {
        let files = scan(&fixtures());
        assert_eq!(files.len(), 40);
        assert!(files.iter().any(|f| f.rel_path == "day-two/DSCF1032.png" && f.kind == Kind::Png));
        assert!(files.windows(2).all(|w| w[0].rel_path < w[1].rel_path));
        assert!(files.iter().all(|f| f.size > 0 && f.mtime_ms > 0));
    }

    #[test]
    fn scan_skips_the_top_level_exports_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in ["a.jpg", "Exports/Social/a.jpg", "Exports.jpg", "trip/Exports/b.jpg"] {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        let rels: Vec<_> = scan(root).into_iter().map(|f| f.rel_path).collect();
        // Only the top-level `Exports` folder (Export's default destination) is skipped.
        assert_eq!(rels, vec!["Exports.jpg", "a.jpg", "trip/Exports/b.jpg"]);
    }

    #[test]
    fn scan_skips_hidden_project_and_cache_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in [
            "a.JPG",
            "b.png",
            "c.HEIC",
            "d.heif",
            "sub/e.jpeg",
            "f.CR2",
            "g.dng",
            "h.xmp",
            ".hidden.jpg",
            ".dir/x.jpg",
            "sub/.photobook-cache/y.jpg",
            ".photobook-publish/z.jpg",
            "book.photobook.json",
            "book.photobook.json.bak",
            "photo.jpg.bak",
            "notes.txt",
        ] {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        let rels: Vec<_> = scan(root).into_iter().map(|f| (f.rel_path, f.kind)).collect();
        assert_eq!(
            rels,
            vec![
                ("a.JPG".to_string(), Kind::Jpeg),
                ("b.png".to_string(), Kind::Png),
                ("c.HEIC".to_string(), Kind::Heic),
                ("d.heif".to_string(), Kind::Heic),
                ("f.CR2".to_string(), Kind::Raw),
                ("g.dng".to_string(), Kind::Raw),
                ("sub/e.jpeg".to_string(), Kind::Jpeg),
            ]
        );
    }

    #[test]
    fn hash_matches_shasum() {
        let file = fixtures().join("DSCF1008.jpg");
        let out = Command::new("shasum").args(["-a", "256"]).arg(&file).output().unwrap();
        let expected = String::from_utf8(out.stdout).unwrap().split_whitespace().next().unwrap().to_string();
        assert_eq!(hash_file(&file).unwrap(), expected);
    }

    #[test]
    fn cache_dir_rejects_non_hashes() {
        let cache = Path::new("/cache");
        assert!(cache_entry_dir(cache, "../etc").is_err());
        assert!(cache_entry_dir(cache, &"A".repeat(64)).is_err());
        assert!(cache_entry_dir(cache, &"a".repeat(64)).is_ok());
    }

    #[test]
    fn picks_smallest_covering_dct_scale() {
        assert_eq!(pick_scale(6000, 1600), ScalingFactor::new(3, 8));
        assert_eq!(pick_scale(6000, 256), ScalingFactor::new(1, 8));
        assert_eq!(pick_scale(1200, 1600), ScalingFactor::ONE);
        assert_eq!(fit(6000, 4000, 256), (256, 171));
        assert_eq!(fit(1000, 800, 1600), (1000, 800));
    }

    #[test]
    fn prepares_a_24mp_jpeg_quickly() {
        let cache = tempfile::tempdir().unwrap();
        let dir = cache.path().join("a");
        let start = Instant::now();
        let info = prepare(&fixtures().join("DSCF1008.jpg"), Kind::Jpeg, &dir).unwrap();
        let elapsed = start.elapsed();
        println!("6000x4000 JPEG -> thumb + proxy: {elapsed:?}");
        assert_eq!((info.width, info.height, info.orientation), (6000, 4000, 1));
        assert_eq!(jpeg_size(&info.thumb_path), (256, 171));
        assert_eq!(jpeg_size(&info.proxy_path), (1600, 1067));
        // Cargo.toml builds this crate and the image crates optimized even in dev and test.
        assert!(elapsed.as_millis() < 300, "took {elapsed:?}");

        let start = Instant::now();
        assert_eq!(prepare(&fixtures().join("DSCF1008.jpg"), Kind::Jpeg, &dir).unwrap(), info);
        println!("warm cache: {:?}", start.elapsed());
    }

    #[test]
    fn prepare_records_facts_and_backfills_an_old_meta_json() {
        let cache = tempfile::tempdir().unwrap();
        let dir = cache.path().join("a");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crates/develop/tests/fixtures/stats/panned.jpg");
        let info = prepare(&src, Kind::Jpeg, &dir).unwrap();
        let facts = info.facts.clone();
        assert_eq!(facts.taken, Some(1_791_885_602_050));
        assert_eq!((facts.lens.as_deref(), facts.focal), (Some("Fixture 35mm F2"), Some(35.0)));
        assert_eq!(facts.phash.as_ref().map(String::len), Some(16));
        assert!(facts.stats.is_some_and(|s| s.motion > 0.6), "{facts:?}");
        let json = serde_json::to_value(&info).unwrap();
        assert!(json["stats"]["sharpnessMax"].is_number() && json["taken"].is_number(), "{json}");

        // A meta.json from before plan 38: no factsVersion, no phash, no stats, and an exif without the new fields.
        let meta_path = dir.join(META_FILE);
        let mut old: serde_json::Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        let obj = old.as_object_mut().unwrap();
        for key in ["factsVersion", "phash", "stats"] {
            obj.remove(key);
        }
        for key in ["taken", "lens", "focal", "serial"] {
            obj["exif"].as_object_mut().unwrap().remove(key);
        }
        fs::write(&meta_path, old.to_string()).unwrap();
        // The permit-free read leaves an entry that needs a backfill to `prepare` (under the permit).
        assert!(cached_current(&dir).is_none());
        let again = prepare(&src, Kind::Jpeg, &dir).unwrap();
        assert_eq!((again.facts.taken, again.facts.lens.clone()), (facts.taken, facts.lens.clone()));
        // From the cached proxy.jpg rather than the pixels in memory: the same up to the JPEG round trip.
        let (a, b) = (again.facts.stats.unwrap(), facts.stats.unwrap());
        assert!((a.motion - b.motion).abs() < 0.05 && (a.clip_high - b.clip_high).abs() < 0.01, "{a:?} {b:?}");
        let hamming = u64::from_str_radix(again.facts.phash.as_deref().unwrap(), 16).unwrap()
            ^ u64::from_str_radix(facts.phash.as_deref().unwrap(), 16).unwrap();
        assert!(hamming.count_ones() <= 4);
        // Written back, so the next call is a plain read.
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta["factsVersion"], FACTS_VERSION);
        assert!(meta["stats"].is_object() && meta["exif"]["taken"].is_number(), "{meta}");
        assert_eq!(prepare(&src, Kind::Jpeg, &dir).unwrap(), again);
        assert_eq!(cached_current(&dir), Some(again));
    }

    #[test]
    fn plan_52_fields_backfill_once_and_reach_the_facts() {
        let exif = photobook_develop::decode::CameraExif {
            shutter: Some(0.004),
            aperture: Some(2.8),
            gps: photobook_develop::decode::Gps::valid(38.71, -9.14),
            ..Default::default()
        };
        let meta = Meta {
            width: 10,
            height: 10,
            orientation: 1,
            is_raw: false,
            as_shot: None,
            exif: Some(exif),
            facts_version: FACTS_VERSION,
            phash: Some("00".into()),
            stats: None,
            palette: None,
        };
        let facts = facts_of(&meta);
        assert_eq!((facts.shutter, facts.aperture), (Some(0.004), Some(2.8)));
        let json = serde_json::to_value(&facts).unwrap();
        assert_eq!(json["gps"], serde_json::json!({ "lat": 38.71, "lon": -9.14 }));
        // A meta.json read by plan 38 (factsVersion 1) is read from the Exif again, once.
        let stats = photobook_develop::stats::PhotoStats {
            sharpness: 1.0,
            sharpness_max: 1.0,
            sharpest_tile: 0,
            motion: 0.0,
            clip_high: 0.0,
            clip_low: 0.0,
            median_lum: 0.5,
        };
        let current = Meta { stats: Some(stats), palette: Some(vec!["#808080".into(); 5]), ..meta };
        assert!(!needs_backfill(&current));
        assert!(needs_backfill(&Meta { facts_version: 1, ..current }));
    }

    #[test]
    fn plan_56_palette_is_recorded_and_backfilled_the_same_every_time() {
        let cache = tempfile::tempdir().unwrap();
        let dir = cache.path().join("a");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crates/develop/tests/fixtures/stats/sharp.jpg");
        let info = prepare(&src, Kind::Jpeg, &dir).unwrap();
        let palette = info.facts.palette.clone().unwrap();
        assert_eq!(palette.len(), 5);
        assert!(palette.iter().all(|c| c.len() == 7 && c.starts_with('#')), "{palette:?}");
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["palette"].as_array().map(Vec::len), Some(5));

        // A meta.json from plan 52 (factsVersion 2, no palette) gains one from the cached proxy, once.
        let meta_path = dir.join(META_FILE);
        let strip = || {
            let mut old: serde_json::Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
            old.as_object_mut().unwrap().remove("palette");
            old["factsVersion"] = 2.into();
            fs::write(&meta_path, old.to_string()).unwrap();
        };
        strip();
        assert!(cached_current(&dir).is_none());
        let first = prepare(&src, Kind::Jpeg, &dir).unwrap().facts.palette.unwrap();
        assert_eq!(first.len(), 5);
        // Deterministic: a second backfill of the same proxy gives the same colours.
        strip();
        assert_eq!(prepare(&src, Kind::Jpeg, &dir).unwrap().facts.palette.unwrap(), first);
        let meta: serde_json::Value = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
        assert_eq!(meta["factsVersion"], FACTS_VERSION);
        assert!(cached_current(&dir).is_some());
    }

    #[test]
    fn map_url_takes_a_position_only() {
        let url = map_url(38.71, -9.14).unwrap();
        assert_eq!(url, "https://maps.apple.com/?ll=38.710000,-9.140000&q=38.710000,-9.140000");
        for (lat, lon) in [(91.0, 0.0), (0.0, -180.5), (f64::NAN, 1.0), (1.0, f64::INFINITY)] {
            assert!(map_url(lat, lon).is_err(), "{lat} {lon}");
        }
    }

    /// Plan 38's budget: a cold `prepare` of every photo of `fixtures/lisbon-demo` (git-ignored, so ignored here),
    /// one at a time, best of three runs. Run with
    /// `cargo test --lib prepare_timing_lisbon -- --ignored --nocapture` in `src-tauri`.
    #[test]
    #[ignore = "needs the git-ignored fixtures/lisbon-demo"]
    fn prepare_timing_lisbon() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/lisbon-demo");
        let mut photos: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| kind_of(p) == Some(Kind::Jpeg))
            .collect();
        photos.sort();
        assert!(!photos.is_empty());
        let mut best = f64::MAX;
        for _ in 0..3 {
            let cache = tempfile::tempdir().unwrap();
            let start = Instant::now();
            for (i, photo) in photos.iter().enumerate() {
                prepare(photo, Kind::Jpeg, &cache.path().join(i.to_string())).unwrap();
            }
            best = best.min(start.elapsed().as_secs_f64() * 1000.0 / photos.len() as f64);
        }
        println!("prepare, lisbon-demo: {} photos, best of 3: {best:.1} ms a photo", photos.len());
    }

    #[test]
    fn applies_exif_orientation_6() {
        let cache = tempfile::tempdir().unwrap();
        // Stored 2400x1600 with orientation 6: upright portrait.
        let info = prepare(&fixtures().join("DSCF1004.jpg"), Kind::Jpeg, &cache.path().join("a")).unwrap();
        assert_eq!((info.width, info.height, info.orientation), (1600, 2400, 6));
        assert_eq!(jpeg_size(&info.thumb_path), (171, 256));
        assert_eq!(jpeg_size(&info.proxy_path), (1067, 1600));

        // Stored 4000x6000 with orientation 6: upright 6000x4000 landscape.
        let start = Instant::now();
        let info = prepare(&fixtures().join("DSCF1024.jpg"), Kind::Jpeg, &cache.path().join("b")).unwrap();
        println!("4000x6000 orientation-6 JPEG -> thumb + proxy: {:?}", start.elapsed());
        assert_eq!((info.width, info.height, info.orientation), (6000, 4000, 6));
        assert_eq!(jpeg_size(&info.thumb_path), (256, 171));
    }

    #[test]
    fn prepares_a_png() {
        let cache = tempfile::tempdir().unwrap();
        let start = Instant::now();
        let info = prepare(&fixtures().join("day-two/DSCF1032.png"), Kind::Png, &cache.path().join("a")).unwrap();
        println!("6000x4000 PNG -> thumb + proxy: {:?}", start.elapsed());
        assert_eq!((info.width, info.height), (6000, 4000));
        assert_eq!(jpeg_size(&info.thumb_path), (256, 171));
    }

    #[test]
    fn prepares_a_heic_through_sips() {
        let tmp = tempfile::tempdir().unwrap();
        let heic = tmp.path().join("photo.heic");
        let made = Command::new("sips")
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
        let dir = tmp.path().join("cache");
        let info = prepare(&heic, Kind::Heic, &dir).unwrap();
        assert_eq!((info.width, info.height), (2400, 1600));
        assert!(dir.join(SIPS_SOURCE_FILE).is_file());
        assert_eq!(jpeg_size(&info.thumb_path), (256, 171));
    }

    /// A real RAW from `PHOTOBOOK_RAW_DIR` or `~/Pictures/ON1 Samples` (read only), when there is one.
    fn sample_raw(name: &str) -> Option<PathBuf> {
        let dir = std::env::var_os("PHOTOBOOK_RAW_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples"));
        let path = dir.join(name);
        path.is_file().then_some(path)
    }

    #[test]
    fn prepares_a_raw_from_its_embedded_preview_and_by_developing() {
        let Some(src) = sample_raw("ON1 Sample 7.CR2") else {
            eprintln!("no sample RAW here; skipping");
            return;
        };
        // Canon EOS 6D, stored 5472x3648 with orientation 8: upright portrait.
        let cache = tempfile::tempdir().unwrap();
        let dir = cache.path().join("a");
        let start = Instant::now();
        let info = prepare(&src, Kind::Raw, &dir).unwrap();
        println!("CR2 -> thumb + proxy from the embedded preview: {:?}", start.elapsed());
        assert_eq!((info.width, info.height, info.orientation), (3648, 5472, 8));
        assert!(info.is_raw);
        let [kelvin, tint] = info.as_shot.unwrap();
        assert!((5000.0..6500.0).contains(&kelvin) && tint.abs() < 50.0, "{kelvin} {tint}");
        assert_eq!(jpeg_size(&info.proxy_path), (1067, 1600));
        assert_eq!(jpeg_size(&info.thumb_path), (171, 256));
        let meta = fs::read_to_string(dir.join(META_FILE)).unwrap();
        assert!(meta.contains(r#""isRaw":true"#) && meta.contains(r#""asShot":["#), "{meta}");
        // Plan 23: the camera and ISO, cleaned ("Canon" + "EOS 6D").
        assert_eq!(
            (info.facts.make.as_deref(), info.facts.model.as_deref()),
            (Some("Canon"), Some("EOS 6D")),
            "{info:?}"
        );
        // Plan 38: capture time and stats from the embedded preview.
        assert!(info.facts.taken.is_some() && info.facts.stats.is_some() && info.facts.phash.is_some(), "{info:?}");
        assert!(info.iso.is_some_and(|iso| iso >= 50), "{info:?}");
        // Warm: read back from meta.json.
        assert_eq!(prepare(&src, Kind::Raw, &dir).unwrap(), info);

        // No usable preview: developed with the default settings, same size and orientation.
        let start = Instant::now();
        let (developed, image) = develop_raw_proxy(&src, photobook_develop::decode::raw::raw_info(&src).ok()).unwrap();
        println!("CR2 -> developed proxy: {:?}", start.elapsed());
        assert_eq!(developed, raw_meta(3648, 5472, 8, (kelvin, tint)));
        assert_eq!((image.width, image.height), (1067, 1600));
        // Without metadata (the rotated-sensor fallback): decoded in full for the size.
        let (full, image) = develop_raw_proxy(&src, None).unwrap();
        assert_eq!((full.width, full.height, full.orientation, full.is_raw), (3648, 5472, 8, true));
        assert_eq!((image.width, image.height), (1067, 1600));
    }

    #[test]
    fn copies_icc_segments_after_jfif() {
        let icc = [&[0xFF, 0xE2, 0x00, 0x10][..], b"ICC_PROFILE\0", &[1, 1]].concat();
        let exif = [&[0xFF, 0xE1, 0x00, 0x08][..], b"Exif\0\0"].concat();
        let jpeg = [&[0xFF, 0xD8][..], &exif, &icc, &[0xFF, 0xDA, 0x00, 0x02, 0x00]].concat();
        assert_eq!(icc_segments(&jpeg), icc);
        assert!(icc_segments(b"not a jpeg").is_empty());
        let jfif = [0xFF, 0xE0, 0x00, 0x04, 0xAA, 0xBB];
        let mut out = [&[0xFF, 0xD8][..], &jfif, &[0xFF, 0xDB, 0x00, 0x02]].concat();
        insert_segments(&mut out, &icc);
        assert_eq!(out, [&[0xFF, 0xD8][..], &jfif, &icc, &[0xFF, 0xDB, 0x00, 0x02]].concat());
    }
}
