//! Folder scan, hashing, thumbnails and proxies (step 1.2).
//!
//! - `scan_folder` lists the photos in the source folder (JPEG, PNG, HEIC).
//! - `hash_files` streams SHA-256 over a list of files on a few worker threads and reports each
//!   result through the `asset:hashed` and `asset:hash-progress` events.
//! - `prepare_asset` writes `<appdata>/cache/<hash>/{thumb,proxy}.jpg` (upright, 256 and 1600 px
//!   long edge) plus a small `meta.json`, and returns the upright dimensions and absolute paths.
//! - `read_cache_dir` returns `<appdata>/cache` for `convertFileSrc`.
//!
//! JPEGs are decoded with libjpeg-turbo DCT scaling, so a 24 MP file is never fully decoded:
//! the decoder picks the smallest 1/8 multiple that still covers the target long edge, then
//! `fast_image_resize` (Lanczos3) brings it to the exact size.

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

use crate::commands::book::BOOK_FILE_NAME;
use crate::error::{Error, IoContext, Result};
use crate::scope::{self, ensure_allowed};

pub const THUMB_EDGE: u32 = 256;
pub const PROXY_EDGE: u32 = 1600;
const THUMB_QUALITY: i32 = 82;
const PROXY_QUALITY: i32 = 85;
const HASH_BUFFER: usize = 1 << 20;
const MAX_HASH_THREADS: usize = 4;

const PUBLISH_DIR: &str = ".photobook-publish";
const SOURCE_CACHE_DIR: &str = ".photobook-cache";
const THUMB_FILE: &str = "thumb.jpg";
const PROXY_FILE: &str = "proxy.jpg";
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
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Relative to the source folder, `/`-separated.
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub kind: Kind,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    /// Upright (orientation applied) pixel size of the original.
    pub width: u32,
    pub height: u32,
    /// EXIF orientation 1 to 8 of the decoded source (1 when absent).
    pub orientation: u32,
    pub thumb_path: String,
    pub proxy_path: String,
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
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
struct Meta {
    width: u32,
    height: u32,
    orientation: u32,
}

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
/// folders, the project file, `.photobook-publish/` and `.photobook-cache/`.
#[tauri::command]
pub async fn scan_folder<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Vec<ScannedFile>> {
    let root = source_root(&app, &folder)?;
    Ok(tauri::async_runtime::spawn_blocking(move || scan(&root)).await?)
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
    let kind = kind_of(&src).ok_or_else(|| Error::Invalid(format!("{rel_path} is not a JPEG, PNG or HEIC file")))?;
    let dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    if let Some(info) = cached(&dir) {
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

/// `folder` must be the open book's source folder itself.
fn source_root<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf> {
    let root = scope::ensure_source_root(app, folder)?;
    if !root.is_dir() {
        return Err(Error::Invalid(format!("{} is not a folder", root.display())));
    }
    Ok(root)
}

fn resolve_rel<R: Runtime>(app: &AppHandle<R>, root: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(Error::Invalid(format!("Invalid relative path {rel}")));
    }
    ensure_allowed(app, root.join(rel_path))
}

fn cache_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = scope::app_data_dir(app)?.join("cache");
    fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// `<cache>/<hash>`; `hash` must be a lowercase SHA-256 hex digest.
fn cache_entry_dir(cache: &Path, hash: &str) -> Result<PathBuf> {
    let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(Error::Invalid(format!("Invalid asset hash {hash:?}")));
    }
    Ok(cache.join(hash))
}

// ---------------------------------------------------------------------------------------------
// Scan

fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some(Kind::Jpeg),
        "png" => Some(Kind::Png),
        "heic" | "heif" => Some(Kind::Heic),
        _ => None,
    }
}

fn is_skipped(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') || name == BOOK_FILE_NAME || name == PUBLISH_DIR || name == SOURCE_CACHE_DIR
}

pub fn scan(root: &Path) -> Vec<ScannedFile> {
    let mut files: Vec<ScannedFile> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_skipped(e.file_name()))
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
            Some(ScannedFile { rel_path, size: meta.len(), mtime_ms, kind })
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

/// The cached result when thumb, proxy and meta all exist.
fn cached(dir: &Path) -> Option<AssetInfo> {
    let thumb = dir.join(THUMB_FILE);
    let proxy = dir.join(PROXY_FILE);
    if !(thumb.is_file() && proxy.is_file()) {
        return None;
    }
    let meta: Meta = serde_json::from_slice(&fs::read(dir.join(META_FILE)).ok()?).ok()?;
    Some(asset_info(meta, &thumb, &proxy))
}

fn asset_info(meta: Meta, thumb: &Path, proxy: &Path) -> AssetInfo {
    AssetInfo {
        width: meta.width,
        height: meta.height,
        orientation: meta.orientation,
        thumb_path: thumb.to_string_lossy().into_owned(),
        proxy_path: proxy.to_string_lossy().into_owned(),
    }
}

/// Decoded pixels, interleaved u8, 3 (RGB) or 4 (RGBA) channels.
struct Pixels {
    data: Vec<u8>,
    width: u32,
    height: u32,
    channels: u8,
}

/// What a decode returns: stored (not upright) size of the original, its orientation, and the
/// pixels at a reduced size when asked for.
struct Source {
    width: u32,
    height: u32,
    orientation: u32,
    pixels: Option<Pixels>,
}

/// Write any missing thumb/proxy for `src` into `dir` and return the asset info.
pub fn prepare(src: &Path, kind: Kind, dir: &Path) -> Result<AssetInfo> {
    if let Some(info) = cached(dir) {
        return Ok(info);
    }
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
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
    let meta = upright_meta(&source);
    if let Some(pixels) = source.pixels {
        let (w, h) = (source.width, source.height);
        let mut base = pixels;
        if need_proxy {
            // The thumb then comes from the proxy-sized pixels: cheaper and just as sharp.
            base = resize(&base, fit(w, h, PROXY_EDGE))?;
            write_jpeg(&orient(&base, source.orientation)?, PROXY_QUALITY, &proxy)?;
        }
        if need_thumb {
            let resized = resize(&base, fit(w, h, THUMB_EDGE))?;
            write_jpeg(&orient(&resized, source.orientation)?, THUMB_QUALITY, &thumb)?;
        }
    }
    let json = serde_json::to_vec(&meta).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&dir.join(META_FILE), &json)?;
    Ok(asset_info(meta, &thumb, &proxy))
}

fn upright_meta(source: &Source) -> Meta {
    let swap = (5..=8).contains(&source.orientation);
    let (width, height) = if swap { (source.height, source.width) } else { (source.width, source.height) };
    Meta { width, height, orientation: source.orientation }
}

fn load(src: &Path, kind: Kind, dir: &Path, target: Option<u32>) -> Result<Source> {
    match kind {
        Kind::Png => load_png(src, target.is_some()),
        Kind::Heic => load_jpeg(&sips_to_jpeg(src, dir)?, target),
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
    Ok(Source { width: header.width as u32, height: header.height as u32, orientation, pixels })
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
        return Ok(Source { width, height, orientation, pixels: None });
    }
    let img = reader.decode().map_err(|e| decode_err(what(), e))?;
    let (width, height) = (img.width(), img.height());
    let pixels = if img.color().has_alpha() {
        Pixels { data: img.into_rgba8().into_raw(), width, height, channels: 4 }
    } else {
        Pixels { data: img.into_rgb8().into_raw(), width, height, channels: 3 }
    };
    Ok(Source { width, height, orientation, pixels: Some(pixels) })
}

/// Convert with macOS `sips` into `<dir>/source.jpg` once and return that path.
fn sips_to_jpeg(src: &Path, dir: &Path) -> Result<PathBuf> {
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
fn fit(w: u32, h: u32, edge: u32) -> (u32, u32) {
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

fn resize(src: &Pixels, (width, height): (u32, u32)) -> Result<Pixels> {
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

fn write_jpeg(img: &image::RgbImage, quality: i32, target: &Path) -> Result<()> {
    let what = || target.display().to_string();
    let mut compressor = Compressor::new().map_err(|e| decode_err(what(), e))?;
    compressor.set_quality(quality).map_err(|e| decode_err(what(), e))?;
    compressor.set_subsamp(Subsamp::Sub2x2).map_err(|e| decode_err(what(), e))?;
    let (width, height) = (img.width() as usize, img.height() as usize);
    let image = turbojpeg::Image { pixels: img.as_raw().as_slice(), width, pitch: width * 3, height, format: PixelFormat::RGB };
    let bytes = compressor.compress_to_vec(image).map_err(|e| decode_err(what(), e))?;
    write_atomic(target, &bytes)
}

fn unique() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// Temp file + rename, so two calls racing on the same hash never leave a torn file.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<()> {
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
    fn scan_skips_hidden_project_and_cache_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for rel in [
            "a.JPG",
            "b.png",
            "c.HEIC",
            "d.heif",
            "sub/e.jpeg",
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
}
