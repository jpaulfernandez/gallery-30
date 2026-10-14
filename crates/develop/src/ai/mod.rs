//! Local inference (D4.2, feature `ai`): the pinned model registry, the downloader and the ONNX Runtime wrapper.
//!
//! - [`registry`]: `models.toml` (name, version, task, files with URL/size/SHA-256, licence, input shape).
//! - [`download`]: resumable, verified downloads into `<models>/<name>/<version>/`, and deletion.
//! - [`runtime`]: an `ort` session with the CoreML execution provider (ML Program, static shapes, model cache dir,
//!   optimisation level 1, CPU fallback) and its partition count logged once per model.
//! - [`tiling`] and [`denoise`] (D5.1): tiled inference with overlap blending, the Oklab luminance/chroma blend and
//!   the 16-bit denoise intermediate.
//! - D4.3 AI masks: [`preprocess`] (model inputs from a `LinearImage`, outputs back), [`segment`] (subject, sky,
//!   people, SAM prompts, and [`segment::generate`], the whole flow), [`depth`] (Depth Anything → depth range masks),
//!   [`refine`] (guided-filter edge refinement). Rasters are cached by [`crate::masks::ai_cache`].
//! - [`merge`] (workflow plan 25): the denoise's frequency-aware luminance merge (à trous bands of `L_in − L_out`).
//! - `drunet` (workflow plan 26, feature `denoise-drunet`, off by default): the σ-map denoise experiment, DRUNet
//!   fed the noise profile's σ per pixel.
//! - [`noise_profile`] (workflow plan 23): a photo's own noise curve, learned per-camera profiles, the blend of the two.
//!
//! Nothing here knows about Tauri; the editor passes `<appdata>/models` as the [`ModelDir`].

pub mod denoise;
pub mod depth;
pub mod download;
#[cfg(feature = "denoise-drunet")]
pub mod drunet;
pub mod merge;
pub mod noise_profile;
pub mod preprocess;
pub mod refine;
pub mod registry;
pub mod runtime;
pub mod segment;
pub mod tiling;

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub use download::{delete_model, download_model, Progress};
pub use registry::{registry, ModelEntry, ModelFile, Registry, Task};
pub use runtime::{Session, SessionOptions};

/// Errors of the `ai` module. Messages are user-facing (the Settings page shows them).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// DNS or connection failure: no network, or the host is unreachable.
    #[error("offline: could not reach {host} ({message})")]
    Offline { host: String, message: String },
    /// The connection dropped or timed out mid-transfer; the partial file is kept for a resume.
    #[error("network error: {0}")]
    Network(String),
    #[error("download failed: HTTP {status} for {url}")]
    Http { status: u16, url: String },
    /// The finished file does not match the manifest; the partial file has been removed.
    #[error("{file}: checksum mismatch (expected {expected}, got {actual})")]
    HashMismatch { file: String, expected: String, actual: String },
    #[error("{file}: expected {expected} bytes, got {actual}")]
    SizeMismatch { file: String, expected: u64, actual: u64 },
    #[error("cancelled")]
    Cancelled,
    #[error("{0} has no pinned checksum yet and cannot be downloaded")]
    Unverified(String),
    #[error("unknown model {0}")]
    UnknownModel(String),
    #[error("{0} is not installed")]
    NotInstalled(String),
    #[error("models.toml: {0}")]
    Manifest(String),
    #[error("ONNX Runtime: {0}")]
    Runtime(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl From<ort::Error> for Error {
    fn from(err: ort::Error) -> Self {
        Error::Runtime(err.to_string())
    }
}

impl From<ort::Error<ort::session::builder::SessionBuilder>> for Error {
    fn from(err: ort::Error<ort::session::builder::SessionBuilder>) -> Self {
        Error::Runtime(err.to_string())
    }
}

/// Suffix of a file being downloaded.
pub const PART_SUFFIX: &str = ".part";
/// Folder inside a model's version folder where CoreML keeps its compiled model.
pub const COREML_CACHE_DIR: &str = "coreml-cache";

/// The models root, `<appdata>/models` in the editor. Layout: `<root>/<name>/<version>/<file>`, partial downloads
/// as `<file>.part` next to where the file will land, the CoreML cache in `<root>/<name>/<version>/coreml-cache/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDir {
    root: PathBuf,
}

impl ModelDir {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/<name>`: every version of a model (what deleting it frees).
    pub fn model_root(&self, entry: &ModelEntry) -> PathBuf {
        self.root.join(&entry.name)
    }

    /// `<root>/<name>/<version>`.
    pub fn version_dir(&self, entry: &ModelEntry) -> PathBuf {
        self.model_root(entry).join(&entry.version)
    }

    pub fn file_path(&self, entry: &ModelEntry, file: &ModelFile) -> PathBuf {
        self.version_dir(entry).join(&file.path)
    }

    pub fn part_path(&self, entry: &ModelEntry, file: &ModelFile) -> PathBuf {
        self.version_dir(entry).join(format!("{}{PART_SUFFIX}", file.path))
    }

    /// The ONNX graph to load.
    pub fn primary_path(&self, entry: &ModelEntry) -> PathBuf {
        self.file_path(entry, entry.primary_file())
    }

    /// Where CoreML caches the compiled model. Per version, because the cache is keyed on the graph's metadata and
    /// structure, not its weights.
    pub fn coreml_cache_dir(&self, entry: &ModelEntry) -> PathBuf {
        self.version_dir(entry).join(COREML_CACHE_DIR)
    }
}

/// Whether a model is on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "bytes", rename_all = "camelCase")]
pub enum ModelStatus {
    /// Every file is present with the manifest's size (hashes were checked before the files were renamed in place).
    Installed,
    /// Nothing downloaded.
    Missing,
    /// Some bytes are on disk (finished files and `.part` files); a download resumes from them.
    Partial(u64),
}

/// The state of `entry` under `dir`.
pub fn status(entry: &ModelEntry, dir: &ModelDir) -> ModelStatus {
    let mut complete = true;
    let mut bytes = 0;
    for file in &entry.files {
        match fs::metadata(dir.file_path(entry, file)) {
            Ok(meta) if meta.is_file() && meta.len() == file.bytes => bytes += meta.len(),
            _ => {
                complete = false;
                if let Ok(meta) = fs::metadata(dir.part_path(entry, file)) {
                    bytes += meta.len().min(file.bytes);
                }
            }
        }
    }
    match (complete, bytes) {
        (true, _) => ModelStatus::Installed,
        (false, 0) => ModelStatus::Missing,
        (false, n) => ModelStatus::Partial(n),
    }
}

/// An installed model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub name: String,
    pub version: String,
    /// Disk used under `<root>/<name>` (every version, partial files and the CoreML cache included).
    pub bytes: u64,
    pub licence: String,
    /// The ONNX graph.
    pub path: PathBuf,
}

/// The manifest's models that are installed under `dir`.
pub fn installed(dir: &ModelDir) -> Vec<InstalledModel> {
    registry()
        .models
        .iter()
        .filter(|m| status(m, dir) == ModelStatus::Installed)
        .map(|m| InstalledModel {
            name: m.name.clone(),
            version: m.version.clone(),
            bytes: disk_usage(&dir.model_root(m)),
            licence: m.licence.clone(),
            path: dir.primary_path(m),
        })
        .collect()
}

/// Bytes used by the files under `path` (0 when it does not exist). Symlinks are not followed.
pub fn disk_usage(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| disk_usage(&e.path())).sum())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_tracks_files_and_parts() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = ModelDir::new(tmp.path());
        let entry = registry().get("sam2.1-tiny-decoder").unwrap().clone();
        assert_eq!(status(&entry, &dir), ModelStatus::Missing);
        fs::create_dir_all(dir.version_dir(&entry)).unwrap();
        fs::write(dir.part_path(&entry, &entry.files[0]), vec![0u8; 100]).unwrap();
        assert_eq!(status(&entry, &dir), ModelStatus::Partial(100));
        for f in &entry.files {
            let file = fs::File::create(dir.file_path(&entry, f)).unwrap();
            file.set_len(f.bytes).unwrap();
        }
        assert_eq!(status(&entry, &dir), ModelStatus::Installed);
        let list = installed(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "sam2.1-tiny-decoder");
        assert_eq!(list[0].bytes, entry.total_bytes() + 100);
        assert_eq!(list[0].path, dir.primary_path(&entry));
        // A file of the wrong size is not installed.
        fs::File::create(dir.file_path(&entry, &entry.files[1])).unwrap().set_len(5).unwrap();
        assert_eq!(status(&entry, &dir), ModelStatus::Partial(entry.files[0].bytes));
    }

    #[test]
    fn status_serialises_for_the_ui() {
        assert_eq!(serde_json::to_string(&ModelStatus::Installed).unwrap(), r#"{"state":"installed"}"#);
        assert_eq!(serde_json::to_string(&ModelStatus::Partial(5)).unwrap(), r#"{"state":"partial","bytes":5}"#);
    }
}
