//! Settings → Models (step D4.2): the Tauri side of `photobook_develop::ai`.
//!
//! - `list_models` returns every model of the pinned manifest (`crates/develop/models.toml`) with its install status.
//! - `download_model(name, job)` downloads (or resumes) a model into `<appdata>/models/<name>/<version>/`, reporting
//!   `models:progress { job, name, received, total }` at most every 100 ms and once at the end, and returns the
//!   model's new state. `cancel_model_download(job)` stops it between chunks; the partial file is kept, so the next
//!   download resumes.
//! - `delete_model(name)` removes every version of a model, its partial files and its CoreML cache.
//! - `models_dir()` is the models folder; `open_model_link(name, page)` opens a model's licence or home page.
//!
//! Every path is under the app data dir and goes through `ensure_allowed`.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use photobook_develop::ai::{self, registry, ModelDir, ModelEntry, ModelStatus, Progress, Task};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{Error, IoContext, Result};
use crate::scope::{app_data_dir, ensure_allowed};

pub const EVENT_PROGRESS: &str = "models:progress";
const MODELS_DIR: &str = "models";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// A manifest model and its state on disk.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub title: String,
    pub version: String,
    pub task: Task,
    /// Download size (all files).
    pub bytes: u64,
    pub licence: String,
    pub licence_url: String,
    pub homepage: String,
    pub status: ModelStatus,
    /// Disk used by every version of the model (partial files and the CoreML cache included).
    pub installed_bytes: u64,
    /// False while the manifest has no pinned checksum for it.
    pub downloadable: bool,
    /// The job id of a download in progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job: u64,
    name: &'a str,
    received: u64,
    total: u64,
}

struct Running {
    name: String,
    cancel: Arc<AtomicBool>,
}

/// Downloads in progress, by job id.
#[derive(Default)]
pub struct ModelJobs {
    running: Mutex<HashMap<u64, Running>>,
}

impl ModelJobs {
    fn job_for(&self, name: &str) -> Option<u64> {
        self.running.lock().expect("model jobs lock").iter().find(|(_, r)| r.name == name).map(|(job, _)| *job)
    }

    /// Register a download; fails when `name` is already downloading.
    fn start(&self, job: u64, name: &str) -> Result<Arc<AtomicBool>> {
        let mut running = self.running.lock().expect("model jobs lock");
        if running.values().any(|r| r.name == name) {
            return Err(Error::Invalid(format!("{name} is already downloading")));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(job, Running { name: name.to_owned(), cancel: cancel.clone() });
        Ok(cancel)
    }

    fn finish(&self, job: u64) {
        self.running.lock().expect("model jobs lock").remove(&job);
    }

    fn cancel(&self, job: u64) -> bool {
        match self.running.lock().expect("model jobs lock").get(&job) {
            Some(r) => {
                r.cancel.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// `<appdata>/models`, created if needed.
fn model_dir<R: Runtime>(app: &AppHandle<R>) -> Result<ModelDir> {
    let dir = ensure_allowed(app, app_data_dir(app)?.join(MODELS_DIR))?;
    std::fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    Ok(ModelDir::new(dir))
}

fn entry(name: &str) -> Result<&'static ModelEntry> {
    registry().get(name).ok_or_else(|| Error::Invalid(format!("Unknown model {name}")))
}

pub fn model_info(entry: &ModelEntry, dir: &ModelDir, job: Option<u64>) -> ModelInfo {
    ModelInfo {
        name: entry.name.clone(),
        title: entry.title.clone(),
        version: entry.version.clone(),
        task: entry.task,
        bytes: entry.total_bytes(),
        licence: entry.licence.clone(),
        licence_url: entry.licence_url.clone(),
        homepage: entry.homepage.clone(),
        status: ai::status(entry, dir),
        installed_bytes: ai::disk_usage(&dir.model_root(entry)),
        downloadable: entry.downloadable(),
        job,
    }
}

fn ai_error(err: ai::Error) -> Error {
    Error::Invalid(err.to_string())
}

#[tauri::command]
pub async fn list_models<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ModelInfo>> {
    let dir = model_dir(&app)?;
    let jobs = app.state::<ModelJobs>();
    Ok(registry().models.iter().map(|m| model_info(m, &dir, jobs.job_for(&m.name))).collect())
}

#[tauri::command]
pub async fn models_dir<R: Runtime>(app: AppHandle<R>) -> Result<String> {
    Ok(model_dir(&app)?.root().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn download_model<R: Runtime>(app: AppHandle<R>, name: String, job: u64) -> Result<ModelInfo> {
    let entry = entry(&name)?;
    if !entry.downloadable() {
        return Err(ai_error(ai::Error::Unverified(name)));
    }
    let dir = model_dir(&app)?;
    let cancel = app.state::<ModelJobs>().start(job, &name)?;
    let start = Instant::now();
    let emitter = app.clone();
    let worker_dir = dir.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let last = Cell::new(None::<Instant>);
        let progress = |p: Progress| {
            let now = Instant::now();
            let due = last.get().map_or(true, |t| now.duration_since(t) >= PROGRESS_INTERVAL) || p.received == p.total;
            if due {
                last.set(Some(now));
                let _ = emitter.emit(
                    EVENT_PROGRESS,
                    ProgressEvent { job, name: &entry.name, received: p.received, total: p.total },
                );
            }
        };
        ai::download_model(entry, &worker_dir, &progress, &cancel)
    })
    .await;
    app.state::<ModelJobs>().finish(job);
    let result = match outcome {
        Ok(result) => result.map_err(ai_error),
        Err(err) => Err(Error::Invalid(format!("download task failed: {err}"))),
    };
    log::info!(
        "[photobook:models] download {} {} job={job} {} ms {}",
        entry.name,
        entry.version,
        start.elapsed().as_millis(),
        result.as_ref().err().map_or_else(|| "ok".to_owned(), ToString::to_string)
    );
    result?;
    Ok(model_info(entry, &dir, None))
}

#[tauri::command]
pub async fn cancel_model_download<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<bool> {
    Ok(app.state::<ModelJobs>().cancel(job))
}

#[tauri::command]
pub async fn delete_model<R: Runtime>(app: AppHandle<R>, name: String) -> Result<ModelInfo> {
    let entry = entry(&name)?;
    if app.state::<ModelJobs>().job_for(&name).is_some() {
        return Err(Error::Invalid(format!("{name} is downloading; cancel it first")));
    }
    let dir = model_dir(&app)?;
    // The folder must stay inside the models dir (names are validated by the manifest; this is belt and braces).
    ensure_allowed(&app, dir.model_root(entry))?;
    let worker_dir = dir.clone();
    let freed = tauri::async_runtime::spawn_blocking(move || ai::delete_model(entry, &worker_dir))
        .await
        .map_err(|err| Error::Invalid(format!("delete task failed: {err}")))?
        .map_err(ai_error)?;
    log::info!("[photobook:models] deleted {} ({freed} bytes)", entry.name);
    Ok(model_info(entry, &dir, None))
}

/// Open a model's licence or home page (`page` = `licence` | `homepage`) in the default browser. Only the manifest's
/// own https URLs can be opened; the webview has no shell or opener permission.
#[tauri::command]
pub async fn open_model_link(name: String, page: String) -> Result<()> {
    let entry = entry(&name)?;
    let url = match page.as_str() {
        "licence" => &entry.licence_url,
        "homepage" => &entry.homepage,
        _ => return Err(Error::Invalid(format!("Unknown page {page}"))),
    };
    if !url.starts_with("https://") {
        return Err(Error::Invalid(format!("Refusing to open {url}")));
    }
    open_url(url)
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<()> {
    let status = std::process::Command::new("/usr/bin/open").arg(url).status().ctx("running open")?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(format!("open {url} failed ({status})")))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_url(url: &str) -> Result<()> {
    Err(Error::Invalid(format!("Opening links is only supported on macOS; visit {url}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_reflects_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = ModelDir::new(tmp.path());
        let sky = registry().get("skywater-seg").unwrap();
        let info = model_info(sky, &dir, Some(7));
        assert_eq!(info.status, ModelStatus::Missing);
        assert_eq!(info.installed_bytes, 0);
        assert_eq!(info.bytes, sky.total_bytes());
        assert!(info.downloadable);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["task"], "sky");
        assert_eq!(json["status"]["state"], "missing");
        assert_eq!(json["installedBytes"], 0);
        assert_eq!(json["job"], 7);

        std::fs::create_dir_all(dir.version_dir(sky)).unwrap();
        std::fs::write(dir.part_path(sky, sky.primary_file()), [0u8; 10]).unwrap();
        let info = model_info(sky, &dir, None);
        assert_eq!(info.status, ModelStatus::Partial(10));
        assert_eq!(info.installed_bytes, 10);
        assert!(serde_json::to_value(&info).unwrap().get("job").is_none());

        // An entry without a pinned hash (NAFNet was one until D5.1 pinned it) is listed but not downloadable.
        let mut unpinned = registry().get("nafnet-sidd-width32").unwrap().clone();
        unpinned.verified = false;
        unpinned.files[0].sha256.clear();
        assert!(!model_info(&unpinned, &dir, None).downloadable);
        assert!(model_info(registry().get("nafnet-sidd-width32").unwrap(), &dir, None).downloadable);
    }

    #[test]
    fn one_download_per_model() {
        let jobs = ModelJobs::default();
        let cancel = jobs.start(1, "skywater-seg").unwrap();
        assert!(jobs.start(2, "skywater-seg").is_err());
        assert!(jobs.start(3, "birefnet-lite").is_ok());
        assert_eq!(jobs.job_for("skywater-seg"), Some(1));
        assert!(jobs.cancel(1));
        assert!(cancel.load(Ordering::Relaxed));
        assert!(!jobs.cancel(99));
        jobs.finish(1);
        assert_eq!(jobs.job_for("skywater-seg"), None);
        assert!(jobs.start(4, "skywater-seg").is_ok());
    }
}
