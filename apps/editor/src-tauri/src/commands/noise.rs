//! Noise profiles (workflow plan 23): the Tauri side of `photobook_develop::ai::noise_profile`.
//!
//! - `noise_profile(folder, relPath, hash)` measures the photo's own noise curve on its 1600 px linear decode (the
//!   source, as Develop decodes it; a RAW is decoded from the sensor data) and caches it with the camera's make, model
//!   and ISO in `<appdata>/cache/<hash>/noise.json` (`{ engine, exif, source, fit }`, redone when the engine changes).
//!   With a make, model and ISO it then looks up the camera's learned curve at that ISO (before this photo) and learns
//!   the fit into it, and returns the photo's fit blended with that curve by confidence ([`NoiseProfile`]). At most
//!   [`MAX_PROFILES`] run at once (each decodes the photo; a RAW takes about a second); a call that waited re-reads
//!   `noise.json` first, so the same photo is never measured twice.
//! - `camera_profile(make, model, iso, source)` returns a camera's learned curve at an ISO (interpolated between
//!   known ISOs, at most two stops away), or null.
//! - `learn_profile(make, model, iso, source, hash, fit)` folds a fit into the camera's profile (once per photo
//!   hash; `hash` must be a SHA-256 hex digest) and returns what happened and the curve afterwards.
//!
//! Which σ to use: `NoiseProfile.measured.sigma` is the photo's own, cached and stable until [`PROFILE_ENGINE`]
//! changes; anything that keys files or settings on σ (plans 24, 27) must use it (quantised). `NoiseProfile.sigma` is
//! the blend with the camera's learned curve, which moves as other photos are learned: it is for the badge and the
//! suggested amount only. σ is measured at the 1600 px analysis size; `scale` (source long edge over analysed long
//! edge) converts it: for white noise σ at full size is about `σ × scale`, for the correlated noise of real files it
//! lies between `σ` and `σ × scale`.
//!
//! Learned profiles live in `<appdata>/noise-profiles/<make>-<model>.json` (see the crate module for the format).

use std::fs;
use std::path::Path;
use std::time::Instant;

use photobook_develop::ai::noise_profile::{
    self, blend, CameraProfile, ChannelFit, Learned, NoiseFit, ProfileStore, SourceKind, MIN_LEARN_CONFIDENCE,
    PROFILE_ENGINE,
};
use photobook_develop::decode::{camera_exif, CameraExif};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tokio::sync::Semaphore;

use crate::commands::assets::{
    cache_entry_dir, cache_root, cached_size, kind_of, resolve_rel, source_root, write_atomic, Kind, PROXY_EDGE,
};
use crate::commands::develop::decode_source;
use crate::error::{Error, Result};
use crate::scope::{self, ensure_allowed};

/// The cached measurement, `<appdata>/cache/<hash>/noise.json`.
pub const NOISE_FILE: &str = "noise.json";
/// `<appdata>/noise-profiles`.
pub const PROFILES_DIR: &str = "noise-profiles";
/// `noise_profile` calls measuring (or waiting to) at once.
pub const MAX_PROFILES: usize = 2;
static PROFILE_PERMITS: Semaphore = Semaphore::const_new(MAX_PROFILES);

/// `noise.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoiseRecord {
    /// [`PROFILE_ENGINE`] when measured; another value is measured again.
    pub engine: String,
    pub exif: CameraExif,
    pub source: SourceKind,
    pub fit: NoiseFit,
    /// Upright pixel size of the source (from `prepare_asset`'s `meta.json`), when known: what `fit` was measured
    /// downscaled from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_size: Option<[u32; 2]>,
}

/// What `noise_profile` returns.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoiseProfile {
    /// Camera metadata of the file (cleaned names), absent when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    pub source: SourceKind,
    /// The photo's own fit. `measured.sigma` is stable (cached until the engine changes): key anything on it.
    pub measured: NoiseFit,
    /// Upright source size, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_size: Option<[u32; 2]>,
    /// Source long edge over the analysed long edge (≥ 1), when the source size is known. See the module notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
    /// The camera's learned curve at this ISO before this photo was learned (what the fit is blended with).
    pub learned: Option<CameraProfile>,
    /// What learning this photo did (`None` without make, model and ISO).
    pub learn: Option<Learned>,
    /// Photos learned at exactly this ISO now, this one included (0 when none).
    pub photos: u32,
    /// The blend of `measured` and `learned` (only an established curve is blended in). It moves as other photos are
    /// learned: for the badge and the suggestion, not for keys.
    pub channels: [ChannelFit; 3],
    /// σ at mid-grey (linear, at the analysis size) of `channels`.
    pub sigma: f64,
    pub confidence: f64,
}

/// What `learn_profile` returns.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LearnResult {
    pub outcome: Learned,
    /// The camera's curve at the ISO afterwards (`None` when the camera has no entry of that source).
    pub profile: Option<CameraProfile>,
}

/// Measure (or read the cached measurement of) a photo's noise, learn it into its camera's profile and return the
/// blend. See the module notes.
#[tauri::command]
pub async fn noise_profile<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
) -> Result<NoiseProfile> {
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let store = profile_store(&app)?;
    let _permit = PROFILE_PERMITS.acquire().await.map_err(|err| Error::Invalid(err.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || profile_photo(&src, &entry_dir, &hash, &store)).await?
}

/// A camera's learned curve at `iso` for `source`, interpolated between known ISOs (see the crate's `profile_at`).
#[tauri::command]
pub async fn camera_profile<R: Runtime>(
    app: AppHandle<R>,
    make: String,
    model: String,
    iso: u32,
    source: SourceKind,
) -> Result<Option<CameraProfile>> {
    let store = profile_store(&app)?;
    Ok(tauri::async_runtime::spawn_blocking(move || store.lookup(&make, &model, source, iso)).await?)
}

/// Fold `fit` (of the photo with content hash `hash`) into the camera's profile at `iso`.
#[tauri::command]
pub async fn learn_profile<R: Runtime>(
    app: AppHandle<R>,
    make: String,
    model: String,
    iso: u32,
    source: SourceKind,
    hash: String,
    fit: NoiseFit,
) -> Result<LearnResult> {
    // The same rule as the cache directories: a lowercase SHA-256 hex digest.
    cache_entry_dir(Path::new(""), &hash)?;
    let store = profile_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || learn(&store, &make, &model, source, iso, &hash, &fit)).await?
}

/// `<appdata>/noise-profiles` (created on the first write).
fn profile_store<R: Runtime>(app: &AppHandle<R>) -> Result<ProfileStore> {
    Ok(ProfileStore::new(ensure_allowed(app, scope::app_data_dir(app)?.join(PROFILES_DIR))?))
}

fn learn(
    store: &ProfileStore,
    make: &str,
    model: &str,
    source: SourceKind,
    iso: u32,
    hash: &str,
    fit: &NoiseFit,
) -> Result<LearnResult> {
    let (outcome, profile) = store
        .learn(make, model, source, iso, hash, fit)
        .map_err(|err| Error::Io(format!("writing the {make} {model} noise profile"), err))?;
    log::info!(
        "[photobook:noise] learn {make} {model} ISO {iso} ({source:?}): {outcome:?}, {} photos",
        profile.as_ref().map_or(0, |p| p.photos)
    );
    Ok(LearnResult { outcome, profile })
}

/// The cached measurement in `entry_dir`, when it is of this engine.
pub fn read_record(entry_dir: &Path) -> Option<NoiseRecord> {
    let record: NoiseRecord = serde_json::from_slice(&fs::read(entry_dir.join(NOISE_FILE)).ok()?).ok()?;
    (record.engine == PROFILE_ENGINE).then_some(record)
}

/// σ of the cached measurement in `entry_dir` when it is confident enough to stand for the photo (what
/// `prepare_asset` reports as `noise`, and the folder index keeps).
pub fn cached_sigma(entry_dir: &Path) -> Option<f64> {
    read_record(entry_dir).filter(|r| r.fit.confidence >= MIN_LEARN_CONFIDENCE).map(|r| r.fit.sigma)
}

/// The cached measurement in `entry_dir`, measuring `src` and writing `noise.json` first when there is none (or it is
/// of another engine).
/// At most [`MAX_PROFILES`] measurements run at once from any thread, and one per cache entry: a second caller for
/// the same photo waits and then reads the first one's `noise.json`.
pub fn ensure_record(src: &Path, entry_dir: &Path) -> Result<NoiseRecord> {
    if let Some(record) = read_record(entry_dir) {
        return Ok(record);
    }
    let _slot = MeasureSlot::acquire(entry_dir);
    if let Some(record) = read_record(entry_dir) {
        return Ok(record);
    }
    let record = measure_photo(src, entry_dir)?;
    fs::create_dir_all(entry_dir).map_err(|err| Error::Io(format!("creating {}", entry_dir.display()), err))?;
    let json = serde_json::to_vec(&record).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&entry_dir.join(NOISE_FILE), &json)?;
    Ok(record)
}

/// The σ the chroma filter keys on (workflow plan 24): the record's own `fit.sigma`, quantised to 3 significant
/// digits, or from the ISO when the fit is not confident enough to stand for the photo (below
/// [`MIN_LEARN_CONFIDENCE`], as [`cached_sigma`]) ([`photobook_develop::ops::noise::chroma_sigma`]).
pub fn filter_sigma(record: &NoiseRecord) -> f32 {
    let fit = (record.fit.confidence >= MIN_LEARN_CONFIDENCE).then_some(record.fit.sigma);
    photobook_develop::ops::noise::chroma_sigma(fit, record.exif.iso)
}

/// [`filter_sigma`] of the photo, measuring it first if needed; when the measurement fails, logs it and falls back to
/// the file's ISO (then the default), as [`filter_sigma`] does without a fit.
pub fn photo_filter_sigma(src: &Path, entry_dir: &Path) -> f32 {
    match ensure_record(src, entry_dir) {
        Ok(record) => filter_sigma(&record),
        Err(err) => {
            log::warn!("[photobook:noise] measuring {} failed, the chroma filter uses the ISO: {err}", src.display());
            photobook_develop::ops::noise::chroma_sigma(None, camera_exif(src).iso)
        }
    }
}

/// A measurement slot of [`ensure_record`]: held while measuring one cache entry.
struct MeasureSlot {
    entry: std::path::PathBuf,
}

static MEASURING: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());
static MEASURED: std::sync::Condvar = std::sync::Condvar::new();

impl MeasureSlot {
    /// Wait until fewer than [`MAX_PROFILES`] measurements run and none is for `entry_dir`, then take a slot.
    fn acquire(entry_dir: &Path) -> MeasureSlot {
        let mut running = MEASURING.lock().unwrap_or_else(|e| e.into_inner());
        while running.len() >= MAX_PROFILES || running.iter().any(|p| p == entry_dir) {
            running = MEASURED.wait(running).unwrap_or_else(|e| e.into_inner());
        }
        running.push(entry_dir.to_path_buf());
        MeasureSlot { entry: entry_dir.to_path_buf() }
    }
}

impl Drop for MeasureSlot {
    fn drop(&mut self) {
        let mut running = MEASURING.lock().unwrap_or_else(|e| e.into_inner());
        running.retain(|p| *p != self.entry);
        MEASURED.notify_all();
    }
}

/// Measure `src` (or read `noise.json`), learn and blend. No Tauri state: unit-tested below.
pub fn profile_photo(src: &Path, entry_dir: &Path, hash: &str, store: &ProfileStore) -> Result<NoiseProfile> {
    let record = ensure_record(src, entry_dir)?;
    let exif = record.exif.clone();
    let camera = match (&exif.make, &exif.model, exif.iso) {
        (Some(make), Some(model), Some(iso)) => Some((make.as_str(), model.as_str(), iso)),
        _ => None,
    };
    let (learned, learn_result) = match camera {
        Some((make, model, iso)) => {
            let prior = store.lookup(make, model, record.source, iso);
            // A failed write must not hide the measurement: log it and go on without learning.
            let result = learn(store, make, model, record.source, iso, hash, &record.fit)
                .map_err(|err| log::info!("[photobook:noise] not learned: {err}"))
                .ok();
            (prior, result)
        }
        None => (None, None),
    };
    let mixed = blend(&record.fit, learned.as_ref());
    let photos = learn_result.as_ref().and_then(|r| r.profile.as_ref()).map_or(0, |p| p.photos);
    let scale = record.source_size.map(|[w, h]| {
        let analysed = record.fit.width.max(record.fit.height).max(1) as f64;
        (w.max(h) as f64 / analysed).max(1.0)
    });
    Ok(NoiseProfile {
        make: exif.make,
        model: exif.model,
        iso: exif.iso,
        source: record.source,
        source_size: record.source_size,
        scale,
        measured: record.fit,
        learned,
        learn: learn_result.map(|r| r.outcome),
        photos,
        channels: mixed.channels,
        sigma: mixed.sigma,
        confidence: mixed.confidence,
    })
}

/// Decode `src` at the working size and measure it.
fn measure_photo(src: &Path, entry_dir: &Path) -> Result<NoiseRecord> {
    let start = Instant::now();
    let source = if kind_of(src) == Some(Kind::Raw) { SourceKind::Raw } else { SourceKind::Processed };
    let exif = camera_exif(src);
    let (image, _) = decode_source(src, entry_dir, Some(PROXY_EDGE))?;
    let fit = noise_profile::measure(&image);
    log::info!(
        "[photobook:noise] measured {} {}x{}: σ {:.5} ({:.2} % of mid-grey), {} patches, confidence {:.2}, {} ms",
        src.file_name().unwrap_or_default().to_string_lossy(),
        image.width,
        image.height,
        fit.sigma,
        fit.sigma / noise_profile::MID_GREY * 100.0,
        fit.patches,
        fit.confidence,
        start.elapsed().as_millis()
    );
    let source_size = cached_size(entry_dir).map(|(w, h)| [w, h]);
    Ok(NoiseRecord { engine: PROFILE_ENGINE.to_string(), exif, source, fit, source_size })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Grey bands with Gaussian noise of `sigma` in 8-bit codes, RGB.
    fn noisy_pixels(w: usize, h: usize, sigma: f64, seed: u64) -> Vec<u8> {
        let mut state = seed.max(1);
        let mut next = || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            ((state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 + 0.5) / (1u64 << 53) as f64
        };
        let mut data = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let base = 60.0 + 120.0 * (x / 80) as f64 / 7.0 + 10.0 * y as f64 / h as f64;
                for _ in 0..3 {
                    let g = (-2.0 * next().ln()).sqrt() * (2.0 * std::f64::consts::PI * next()).cos();
                    data.push((base + sigma * g).round().clamp(0.0, 255.0) as u8);
                }
            }
        }
        data
    }

    /// A noisy grey JPEG ([`noisy_pixels`]) with an Exif block naming a Fujifilm X-T5 and the ISO.
    fn noisy_jpeg(path: &Path, sigma: f64, iso: u16, seed: u64) {
        noisy_jpeg_from(path, sigma, iso, seed, "FUJIFILM", "X-T5");
    }

    fn noisy_jpeg_from(path: &Path, sigma: f64, iso: u16, seed: u64, make: &str, model: &str) {
        let (w, h) = (640usize, 480usize);
        let image = photobook_develop::Rgb8Image::new(w as u32, h as u32, noisy_pixels(w, h, sigma, seed));
        let jpeg = photobook_develop::encode_jpeg(&image, 95).unwrap();
        // Splice an APP1 Exif segment (big-endian TIFF: IFD0 Make, Model, ExifIFD → PhotographicSensitivity) after SOI.
        let exif = exif_segment(make, model, iso);
        let bytes = [&jpeg[..2], &exif[..], &jpeg[2..]].concat();
        fs::write(path, bytes).unwrap();
    }

    fn exif_segment(make: &str, model: &str, iso: u16) -> Vec<u8> {
        let mut tiff = Vec::new();
        let make = [make.as_bytes(), b"\0"].concat();
        let model = [model.as_bytes(), b"\0"].concat();
        // Header, IFD0 at 8 with 3 entries (2 + 3·12 + 4 = 42 bytes), then the strings, then the Exif IFD.
        let ifd0 = 8u32;
        let strings = ifd0 + 42;
        let model_at = strings + make.len() as u32;
        let exif_ifd = model_at + model.len() as u32;
        tiff.extend_from_slice(b"MM\0\x2a");
        tiff.extend_from_slice(&ifd0.to_be_bytes());
        tiff.extend_from_slice(&3u16.to_be_bytes());
        let entry = |tiff: &mut Vec<u8>, tag: u16, typ: u16, count: u32, value: u32| {
            tiff.extend_from_slice(&tag.to_be_bytes());
            tiff.extend_from_slice(&typ.to_be_bytes());
            tiff.extend_from_slice(&count.to_be_bytes());
            tiff.extend_from_slice(&value.to_be_bytes());
        };
        entry(&mut tiff, 0x010F, 2, make.len() as u32, strings);
        entry(&mut tiff, 0x0110, 2, model.len() as u32, model_at);
        entry(&mut tiff, 0x8769, 4, 1, exif_ifd);
        tiff.extend_from_slice(&0u32.to_be_bytes());
        tiff.extend_from_slice(&make);
        tiff.extend_from_slice(&model);
        tiff.extend_from_slice(&1u16.to_be_bytes());
        // SHORT value left-justified in the 4-byte field.
        tiff.extend_from_slice(&0x8827u16.to_be_bytes());
        tiff.extend_from_slice(&3u16.to_be_bytes());
        tiff.extend_from_slice(&1u32.to_be_bytes());
        tiff.extend_from_slice(&iso.to_be_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_be_bytes());
        let payload = [&b"Exif\0\0"[..], &tiff[..]].concat();
        let len = (payload.len() + 2) as u16;
        [&[0xFF, 0xE1][..], &len.to_be_bytes(), &payload].concat()
    }

    #[test]
    fn measures_caches_learns_and_blends() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path().join("appdata").join(PROFILES_DIR));
        let folder = tmp.path().join("photos");
        fs::create_dir_all(&folder).unwrap();
        let cache = tmp.path().join("appdata").join("cache");

        let shoot = |name: &str, sigma: f64, iso: u16, seed: u64| {
            let path = folder.join(name);
            noisy_jpeg(&path, sigma, iso, seed);
            let hash = crate::commands::assets::hash_file(&path).unwrap();
            let entry = cache.join(&hash);
            (path, hash, entry)
        };

        // First photo of the camera at ISO 6400: measured, cached, learned as a new entry. Its meta.json says it
        // was 6000 px wide, so σ scales by 6000 / 640.
        let (src, hash, entry) = shoot("a.jpg", 4.0, 6400, 1);
        fs::create_dir_all(&entry).unwrap();
        fs::write(entry.join("meta.json"), r#"{"width":6000,"height":4500,"orientation":1}"#).unwrap();
        let first = profile_photo(&src, &entry, &hash, &store).unwrap();
        assert_eq!((first.make.as_deref(), first.model.as_deref(), first.iso), (Some("Fujifilm"), Some("X-T5"), Some(6400)));
        assert_eq!(first.source, SourceKind::Processed);
        assert_eq!((first.source_size, first.scale), (Some([6000, 4500]), Some(6000.0 / 640.0)));
        assert!(first.measured.confidence > MIN_LEARN_CONFIDENCE, "{first:?}");
        assert_eq!((first.learn, first.photos, first.learned.is_none()), (Some(Learned::Added), 1, true));
        assert_eq!(first.sigma, first.measured.sigma, "nothing learned before: the photo's own fit");
        assert!(entry.join(NOISE_FILE).is_file());
        assert_eq!(cached_sigma(&entry), Some(first.measured.sigma));
        let file = tmp.path().join("appdata/noise-profiles/fujifilm-x-t5.json");
        let read = || -> serde_json::Value { serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap() };
        assert_eq!(read()["processed"].as_object().unwrap().len(), 1);

        // Asking again reads the cache and learns nothing new.
        let again = profile_photo(&src, &entry, &hash, &store).unwrap();
        assert_eq!((again.learn, again.photos), (Some(Learned::AlreadyKnown), 1));
        assert_eq!(again.measured, first.measured);

        // Two more ISO 6400 photos join the entry; until three agree the curve is not blended in.
        let (src2, hash2, entry2) = shoot("b.jpg", 4.4, 6400, 2);
        let second = profile_photo(&src2, &entry2, &hash2, &store).unwrap();
        assert_eq!((second.learn, second.photos), (Some(Learned::Averaged), 2));
        assert!(!second.learned.as_ref().unwrap().established);
        assert_eq!(second.sigma, second.measured.sigma);
        let (src3, hash3, entry3) = shoot("c.jpg", 3.8, 6400, 3);
        assert_eq!(profile_photo(&src3, &entry3, &hash3, &store).unwrap().photos, 3);
        assert_eq!(read()["processed"]["6400"]["n"], 3);

        // The fourth is blended with the established curve.
        let (src4, hash4, entry4) = shoot("d.jpg", 5.5, 6400, 4);
        let fourth = profile_photo(&src4, &entry4, &hash4, &store).unwrap();
        let prior = fourth.learned.as_ref().unwrap();
        assert!(prior.established && prior.photos == 3, "{prior:?}");
        let (lo, hi) = (prior.sigma.min(fourth.measured.sigma), prior.sigma.max(fourth.measured.sigma));
        assert!(fourth.sigma > lo && fourth.sigma < hi, "{fourth:?}");

        // A new ISO adds an entry; the file grows by one.
        let (src5, hash5, entry5) = shoot("e.jpg", 1.0, 200, 5);
        let fifth = profile_photo(&src5, &entry5, &hash5, &store).unwrap();
        assert_eq!(fifth.learn, Some(Learned::Added));
        assert!(fifth.measured.sigma < fourth.measured.sigma);
        let processed = read()["processed"].as_object().unwrap().clone();
        assert_eq!(processed.keys().cloned().collect::<Vec<_>>(), vec!["200".to_string(), "6400".to_string()]);

        // camera_profile's lookup reads ISO 3200 off the established ISO 6400 curve, one stop away; ISO 200 is not
        // established and ISO 800 is three stops from 6400.
        let near = store.lookup("Fujifilm", "X-T5", SourceKind::Processed, 3200).unwrap();
        assert!(near.interpolated && near.established && near.distance == 1.0 && near.sigma < prior.sigma, "{near:?}");
        assert!(store.lookup("Fujifilm", "X-T5", SourceKind::Processed, 800).is_none());
    }

    #[test]
    fn prepare_reads_the_camera_and_backfills_an_old_meta_json() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("cam.jpg");
        noisy_jpeg(&src, 2.0, 6400, 11);
        let dir = tmp.path().join("cache-entry");
        let info = crate::commands::assets::prepare(&src, Kind::Jpeg, &dir).unwrap();
        assert_eq!(
            (info.facts.make.as_deref(), info.facts.model.as_deref(), info.iso),
            (Some("Fujifilm"), Some("X-T5"), Some(6400))
        );
        // No measurement yet: noise is sent as an explicit null, so a stale index value is cleared.
        assert_eq!(serde_json::to_value(&info).unwrap()["noise"], serde_json::Value::Null);
        // A meta.json from before plan 23 (no exif) is filled in from the source on the next prepare.
        let meta = dir.join("meta.json");
        let mut old: serde_json::Value = serde_json::from_str(&fs::read_to_string(&meta).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("exif");
        fs::write(&meta, old.to_string()).unwrap();
        let again = crate::commands::assets::prepare(&src, Kind::Jpeg, &dir).unwrap();
        assert_eq!(again.iso, Some(6400));
        assert!(fs::read_to_string(&meta).unwrap().contains(r#""exif":{"make":"Fujifilm","model":"X-T5","iso":6400}"#));
        // Once measured, prepare reports the measured σ; a record of another engine reads as none.
        let store = ProfileStore::new(tmp.path().join(PROFILES_DIR));
        let hash = crate::commands::assets::hash_file(&src).unwrap();
        let profile = profile_photo(&src, &dir, &hash, &store).unwrap();
        assert_eq!(crate::commands::assets::prepare(&src, Kind::Jpeg, &dir).unwrap().noise, Some(profile.measured.sigma));
        let mut record: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join(NOISE_FILE)).unwrap()).unwrap();
        record["engine"] = "noise-profile/0".into();
        fs::write(dir.join(NOISE_FILE), record.to_string()).unwrap();
        assert_eq!(crate::commands::assets::prepare(&src, Kind::Jpeg, &dir).unwrap().noise, None);
    }

    #[test]
    fn hostile_camera_names_stay_inside_the_profiles_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(PROFILES_DIR);
        let store = ProfileStore::new(&dir);
        let src = tmp.path().join("evil.jpg");
        let model = format!("{}/../../evil", "X".repeat(300));
        noisy_jpeg_from(&src, 4.0, 1600, 7, "../../..", &model);
        let hash = crate::commands::assets::hash_file(&src).unwrap();
        let profile = profile_photo(&src, &tmp.path().join("entry"), &hash, &store).unwrap();
        assert_eq!(profile.learn, Some(Learned::Added), "{profile:?}");
        let files: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 1, "{files:?}");
        let stem = files[0].file_stem().unwrap().to_string_lossy().into_owned();
        assert!(stem.len() <= noise_profile::MAX_SLUG && !stem.contains('.') && !stem.contains('/'), "{stem}");
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 3, "evil.jpg, entry/ and noise-profiles/ only");
    }

    /// Workflow plan 24: renders measure through `ensure_record` from several threads; one photo is measured once
    /// and every caller gets that record, and a fit below the learning confidence falls back to the ISO.
    #[test]
    fn concurrent_measurements_of_one_photo_agree() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("cam.jpg");
        noisy_jpeg(&src, 3.0, 3200, 21);
        let entry = tmp.path().join("entry");
        let records: Vec<NoiseRecord> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..4).map(|_| s.spawn(|| ensure_record(&src, &entry).unwrap())).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(records.windows(2).all(|w| w[0] == w[1]));
        assert!(!MEASURING.lock().unwrap().iter().any(|p| *p == entry), "the slot is released");
        let mut weak = records[0].clone();
        weak.fit.confidence = 0.0;
        assert_eq!(filter_sigma(&weak), photobook_develop::ops::noise::chroma_sigma(None, Some(3200)));
    }

    #[test]
    fn a_photo_without_exif_is_measured_but_not_learned() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(tmp.path().join(PROFILES_DIR));
        let src = tmp.path().join("plain.png");
        image::RgbImage::from_raw(320, 240, noisy_pixels(320, 240, 3.0, 9)).unwrap().save(&src).unwrap();
        let profile = profile_photo(&src, &tmp.path().join("entry"), &"0".repeat(64), &store).unwrap();
        assert_eq!((profile.make.clone(), profile.iso, profile.learn), (None, None, None));
        assert!(!tmp.path().join(PROFILES_DIR).exists());
        assert!(profile.measured.patches > 0, "{profile:?}");
    }
}
