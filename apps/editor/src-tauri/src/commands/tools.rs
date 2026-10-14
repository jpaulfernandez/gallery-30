//! Settings → Tools (workflow plan 16): external programs the editor downloads on demand, never bundled. Today one:
//! FFmpeg, which encodes slideshow videos (`commands/video.rs`).
//!
//! The pinned manifest is `apps/editor/src-tauri/tools.toml` (compiled in), shaped like the models' (`models.toml`):
//! per platform a download `url`, its `bytes` and `sha256`, the program inside it (`member`, a path in the zip) and that
//! program's own `member_bytes` and `member_sha256`. A download is checked against both before the program is moved
//! into `<appdata>/tools/<name>/<version>/<name>`; nothing half-written ever sits at that path (temp file + rename).
//!
//! - `tool_status(name)` says what is installed, what is on PATH (a user-installed FFmpeg, e.g. Homebrew's) and which
//!   one slideshows use: the downloaded one first, else PATH.
//! - `download_tool(name, job)` downloads, verifies and installs it, reporting `tools:progress { job, received, total }`;
//!   `cancel_tool_download(job)` stops it (the partial file is deleted). `delete_tool(name)` removes every version.
//! - `check_tool(name)` runs the program once (`-version`, `-encoders`) and says whether it has the H.264 encoder
//!   slideshows use.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::publish::child_path;
use crate::error::{Error, IoContext, Result};
use crate::scope::{app_data_dir, ensure_allowed};

const MANIFEST: &str = include_str!("../../tools.toml");
pub const EVENT_PROGRESS: &str = "tools:progress";
const TOOLS_DIR: &str = "tools";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// How often a waiting download looks at its cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(250);
/// A download that receives nothing for this long fails.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// The slideshow encoder.
pub const FFMPEG: &str = "ffmpeg";
/// The H.264 encoder slideshows use on macOS (Apple's VideoToolbox; the LGPL build has no x264).
pub const H264_ENCODER: &str = if cfg!(target_os = "macos") { "h264_videotoolbox" } else { "libx264" };

#[derive(Deserialize, Debug, Clone)]
pub struct ToolManifest {
    #[serde(rename = "tool")]
    pub tools: Vec<ToolEntry>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ToolEntry {
    pub name: String,
    pub title: String,
    pub version: String,
    pub licence: String,
    pub licence_url: String,
    pub homepage: String,
    #[serde(rename = "download", default)]
    pub downloads: Vec<ToolDownload>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ToolDownload {
    /// `std::env::consts::OS` (`macos`).
    pub os: String,
    /// `std::env::consts::ARCH` (`aarch64`, `x86_64`).
    pub arch: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    /// The program's path inside the zip.
    pub member: String,
    pub member_bytes: u64,
    pub member_sha256: String,
}

impl ToolEntry {
    pub fn download_for(&self, os: &str, arch: &str) -> Option<&ToolDownload> {
        self.downloads.iter().find(|d| d.os == os && d.arch == arch)
    }

    /// This machine's download, if the manifest has one.
    pub fn current_download(&self) -> Option<&ToolDownload> {
        self.download_for(std::env::consts::OS, std::env::consts::ARCH)
    }
}

pub fn manifest() -> &'static ToolManifest {
    static MANIFEST_CELL: OnceLock<ToolManifest> = OnceLock::new();
    MANIFEST_CELL.get_or_init(|| toml::from_str(MANIFEST).expect("tools.toml is valid"))
}

fn entry(name: &str) -> Result<&'static ToolEntry> {
    manifest().tools.iter().find(|t| t.name == name).ok_or_else(|| Error::Invalid(format!("Unknown tool {name}")))
}

/// `<tools>/<name>/<version>/<name>`.
pub fn installed_path(tools_dir: &Path, entry: &ToolEntry) -> PathBuf {
    tools_dir.join(&entry.name).join(&entry.version).join(&entry.name)
}

/// The installed program, when it is there with this platform's pinned size (it was verified when installed).
pub fn installed(tools_dir: &Path, entry: &ToolEntry) -> Option<PathBuf> {
    let path = installed_path(tools_dir, entry);
    let expected = entry.current_download().map(|d| d.member_bytes);
    let len = fs::metadata(&path).ok().filter(|m| m.is_file())?.len();
    (expected.is_none() || expected == Some(len)).then_some(path)
}

/// `name` in one of the `:`-separated directories of `path`, if it is an executable file there.
pub fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// `<appdata>/tools`, created if needed.
fn tools_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = ensure_allowed(app, app_data_dir(app)?.join(TOOLS_DIR))?;
    fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    Ok(dir)
}

/// The program to run for tool `name`: the downloaded one, else one on PATH (the app's PATH plus Homebrew's).
pub fn resolve_tool<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf> {
    let tool = entry(name)?;
    if let Some(path) = installed(&tools_dir(app)?, tool) {
        // Hashed again before every use: a program changed since it was installed is never run.
        verify_installed(&path, tool)?;
        return Ok(path);
    }
    find_on_path(name, &child_path()).ok_or_else(|| {
        Error::Invalid(format!("{} is needed for this: download it in Settings → Tools (or install it, e.g. with Homebrew)", tool.title))
    })
}

/// Check the installed program against this platform's pinned `member_sha256`.
pub fn verify_installed(path: &Path, tool: &ToolEntry) -> Result<()> {
    let Some(download) = tool.current_download() else { return Ok(()) };
    let (sha, len) = file_sha256(path)?;
    if len == download.member_bytes && sha.eq_ignore_ascii_case(&download.member_sha256) {
        Ok(())
    } else {
        Err(Error::Invalid(format!(
            "The downloaded {} at {} does not match its pinned checksum: delete it in Settings → Tools and download it again",
            tool.title,
            path.display()
        )))
    }
}

/// A tool and where it is (`ToolStatus` in TS).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub name: String,
    pub title: String,
    pub version: String,
    pub licence: String,
    pub licence_url: String,
    pub homepage: String,
    /// Download size for this machine; None when the manifest has no build for it (use one on PATH).
    pub bytes: Option<u64>,
    /// The downloaded program, when installed.
    pub installed_path: Option<String>,
    /// A program of that name on PATH.
    pub system_path: Option<String>,
    /// The one slideshows run: the downloaded one, else the one on PATH.
    pub active_path: Option<String>,
    /// A download in progress.
    pub job: Option<u64>,
}

pub fn status_of(tool: &ToolEntry, tools_dir: &Path, path_var: &str, job: Option<u64>) -> ToolStatus {
    let installed = installed(tools_dir, tool).map(|p| p.to_string_lossy().into_owned());
    let system = find_on_path(&tool.name, path_var).map(|p| p.to_string_lossy().into_owned());
    ToolStatus {
        name: tool.name.clone(),
        title: tool.title.clone(),
        version: tool.version.clone(),
        licence: tool.licence.clone(),
        licence_url: tool.licence_url.clone(),
        homepage: tool.homepage.clone(),
        bytes: tool.current_download().map(|d| d.bytes),
        active_path: installed.clone().or_else(|| system.clone()),
        installed_path: installed,
        system_path: system,
        job,
    }
}

/// Downloads in progress, by job id.
#[derive(Default)]
pub struct ToolJobs {
    running: Mutex<HashMap<u64, (String, Arc<AtomicBool>)>>,
}

impl ToolJobs {
    fn job_for(&self, name: &str) -> Option<u64> {
        self.running.lock().expect("tool jobs lock").iter().find(|(_, (n, _))| n == name).map(|(job, _)| *job)
    }

    fn start(&self, job: u64, name: &str) -> Result<Arc<AtomicBool>> {
        let mut running = self.running.lock().expect("tool jobs lock");
        if running.values().any(|(n, _)| n == name) {
            return Err(Error::Invalid(format!("{name} is already downloading")));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        running.insert(job, (name.to_owned(), cancel.clone()));
        Ok(cancel)
    }

    fn finish(&self, job: u64) {
        self.running.lock().expect("tool jobs lock").remove(&job);
    }

    fn cancel(&self, job: u64) {
        if let Some((_, flag)) = self.running.lock().expect("tool jobs lock").get(&job) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    job: u64,
    name: &'a str,
    received: u64,
    total: u64,
}

/// SHA-256 (hex) and size of the file at `path`.
pub fn file_sha256(path: &Path) -> Result<(String, u64)> {
    let mut file = fs::File::open(path).ctx(format!("opening {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buf).ctx(format!("reading {}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), len))
}

/// Check the downloaded `archive` against `download`, extract its program to `target` (through a temp file next to it)
/// and check that too; the program is made executable. Nothing is left at `target` when a check fails.
pub fn install_from_archive(archive: &Path, download: &ToolDownload, target: &Path) -> Result<()> {
    let (sha, len) = file_sha256(archive)?;
    if len != download.bytes || !sha.eq_ignore_ascii_case(&download.sha256) {
        return Err(Error::Invalid(format!(
            "The download does not match its pinned checksum ({len} bytes, sha256 {sha}); nothing was installed"
        )));
    }
    let dir = target.parent().ok_or_else(|| Error::Invalid("Invalid tool path".into()))?;
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    let tmp = dir.join(format!(".{}.part", target.file_name().and_then(|n| n.to_str()).unwrap_or("tool")));
    let result = (|| {
        extract_member(archive, &download.member, &tmp)?;
        let (sha, len) = file_sha256(&tmp)?;
        if len != download.member_bytes || !sha.eq_ignore_ascii_case(&download.member_sha256) {
            return Err(Error::Invalid(format!(
                "{} in the download does not match its pinned checksum; nothing was installed",
                download.member
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).ctx("making the tool executable")?;
        }
        fs::rename(&tmp, target).ctx(format!("installing {}", target.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Write `member` of zip `archive` to `out` with the system's `unzip` (every macOS has it; the downloads are wheels,
/// which are zip files).
fn extract_member(archive: &Path, member: &str, out: &Path) -> Result<()> {
    if member.starts_with('-') || member.contains("..") {
        return Err(Error::Invalid(format!("Invalid archive member {member:?}")));
    }
    let file = fs::File::create(out).ctx(format!("creating {}", out.display()))?;
    let status = Command::new("/usr/bin/unzip")
        .arg("-p")
        .arg(archive)
        .arg(member)
        .stdin(Stdio::null())
        .stdout(file)
        .stderr(Stdio::null())
        .status()
        .ctx("running unzip")?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(format!("{member} could not be extracted from the download ({status})")))
    }
}

#[tauri::command]
pub async fn tool_status<R: Runtime>(app: AppHandle<R>, name: String) -> Result<ToolStatus> {
    let tool = entry(&name)?;
    let job = app.state::<ToolJobs>().job_for(&name);
    Ok(status_of(tool, &tools_dir(&app)?, &child_path(), job))
}

#[tauri::command]
pub async fn download_tool<R: Runtime>(app: AppHandle<R>, name: String, job: u64) -> Result<ToolStatus> {
    let tool = entry(&name)?;
    let download = tool.current_download().ok_or_else(|| {
        Error::Invalid(format!(
            "There is no {} download for this Mac ({} {}): install it yourself, e.g. with Homebrew",
            tool.title,
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    })?;
    let dir = tools_dir(&app)?;
    let cancel = app.state::<ToolJobs>().start(job, &name)?;
    let archive = dir.join(format!(".{}-{}.download", tool.name, tool.version));
    let result = fetch(&app, job, &name, download, &archive, &cancel).await.and_then(|()| {
        let target = installed_path(&dir, tool);
        install_from_archive(&archive, download, &target)
    });
    let _ = fs::remove_file(&archive);
    app.state::<ToolJobs>().finish(job);
    result?;
    log::info!("[photobook:tools] installed {} {}", tool.name, tool.version);
    Ok(status_of(tool, &dir, &child_path(), None))
}

/// GET `download.url` into `out`, at most `download.bytes`, reporting progress; stops (deleting `out`) on cancel.
async fn fetch<R: Runtime>(
    app: &AppHandle<R>,
    job: u64,
    name: &str,
    download: &ToolDownload,
    out: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| Error::Invalid(format!("Could not start the download: {e}")))?;
    let mut response = client
        .get(&download.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| Error::Invalid(format!("The download failed: {e}")))?;
    let mut file = fs::File::create(out).ctx(format!("creating {}", out.display()))?;
    let mut received = 0u64;
    let mut last = Instant::now();
    let mut last_data = Instant::now();
    let emit = |received: u64| {
        let _ = app.emit(EVENT_PROGRESS, ProgressEvent { job, name, received, total: download.bytes });
    };
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = fs::remove_file(out);
            return Err(Error::Invalid("Download cancelled".into()));
        }
        // Wait for the next chunk in short slices, so a cancel interrupts a stalled read and a dead connection
        // times out (`STALL_TIMEOUT`) instead of hanging.
        let chunk = match tokio::time::timeout(CANCEL_POLL, response.chunk()).await {
            Err(_) => {
                if last_data.elapsed() >= STALL_TIMEOUT {
                    drop(file);
                    let _ = fs::remove_file(out);
                    return Err(Error::Invalid(format!(
                        "The download stalled (nothing received for {} s); try again",
                        STALL_TIMEOUT.as_secs()
                    )));
                }
                continue;
            }
            Ok(chunk) => chunk.map_err(|e| Error::Invalid(format!("The download failed: {e}")))?,
        };
        last_data = Instant::now();
        let Some(chunk) = chunk else { break };
        received += chunk.len() as u64;
        if received > download.bytes {
            drop(file);
            let _ = fs::remove_file(out);
            return Err(Error::Invalid("The download is larger than its pinned size; nothing was installed".into()));
        }
        file.write_all(&chunk).ctx(format!("writing {}", out.display()))?;
        if last.elapsed() >= PROGRESS_INTERVAL {
            emit(received);
            last = Instant::now();
        }
    }
    file.flush().ctx(format!("writing {}", out.display()))?;
    emit(received);
    Ok(())
}

#[tauri::command]
pub async fn cancel_tool_download<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<ToolJobs>().cancel(job);
    Ok(())
}

/// Remove every downloaded version of tool `name` (a program on PATH is never touched).
#[tauri::command]
pub async fn delete_tool<R: Runtime>(app: AppHandle<R>, name: String) -> Result<ToolStatus> {
    let tool = entry(&name)?;
    let dir = tools_dir(&app)?;
    let root = dir.join(&tool.name);
    if root.exists() {
        fs::remove_dir_all(&root).ctx(format!("removing {}", root.display()))?;
    }
    Ok(status_of(tool, &dir, &child_path(), None))
}

/// What running a tool once said (`ToolCheck` in TS).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCheck {
    pub path: String,
    /// First line of `-version`.
    pub version: String,
    /// Whether it has the H.264 encoder slideshows use (`H264_ENCODER`).
    pub h264: bool,
    pub encoder: String,
}

/// Run the FFmpeg slideshows would use: its version line and whether it has the H.264 encoder.
#[tauri::command]
pub async fn check_tool<R: Runtime>(app: AppHandle<R>, name: String) -> Result<ToolCheck> {
    let path = resolve_tool(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || check_ffmpeg(&path)).await?
}

pub fn check_ffmpeg(path: &Path) -> Result<ToolCheck> {
    let run = |args: &[&str]| -> Result<String> {
        let out = Command::new(path)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .ctx(format!("running {}", path.display()))?;
        if !out.status.success() {
            return Err(Error::Invalid(format!("{} {} failed ({})", path.display(), args.join(" "), out.status)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let version = run(&["-hide_banner", "-version"])?.lines().next().unwrap_or_default().trim().to_string();
    let encoders = run(&["-hide_banner", "-encoders"])?;
    Ok(ToolCheck {
        path: path.to_string_lossy().into_owned(),
        version,
        h264: encoders.split_whitespace().any(|w| w == H264_ENCODER),
        encoder: H264_ENCODER.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn the_manifest_pins_every_download() {
        let ffmpeg = entry(FFMPEG).unwrap();
        assert!(ffmpeg.licence.starts_with("LGPL"), "only LGPL or permissive tools");
        assert!(!ffmpeg.downloads.is_empty());
        for d in &ffmpeg.downloads {
            assert!(d.url.starts_with("https://"));
            assert!(d.bytes > 0 && d.member_bytes > 0);
            assert_eq!(d.sha256.len(), 64);
            assert_eq!(d.member_sha256.len(), 64);
            assert!(d.bytes < 150_000_000);
        }
        assert!(ffmpeg.download_for("macos", "aarch64").is_some());
        assert!(ffmpeg.download_for("macos", "x86_64").is_some());
        assert!(ffmpeg.download_for("linux", "x86_64").is_none());
    }

    fn fake_tool(dir: &Path) -> (PathBuf, ToolDownload) {
        // A zip holding `bin/ffmpeg`, made with the system's zip.
        let src = dir.join("src");
        fs::create_dir_all(src.join("bin")).unwrap();
        fs::write(src.join("bin/ffmpeg"), b"#!/bin/sh\necho ffmpeg version test\n").unwrap();
        let archive = dir.join("tool.whl");
        let status = Command::new("/usr/bin/zip")
            .current_dir(&src)
            .args(["-q", "-r"])
            .arg(&archive)
            .arg("bin")
            .status()
            .unwrap();
        assert!(status.success());
        let (sha, bytes) = file_sha256(&archive).unwrap();
        let member = fs::read(src.join("bin/ffmpeg")).unwrap();
        let download = ToolDownload {
            os: "macos".into(),
            arch: "aarch64".into(),
            url: "https://example.test/tool.whl".into(),
            bytes,
            sha256: sha,
            member: "bin/ffmpeg".into(),
            member_bytes: member.len() as u64,
            member_sha256: sha256_hex(&member),
        };
        (archive, download)
    }

    #[test]
    fn installs_a_verified_download_and_refuses_a_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let (archive, download) = fake_tool(dir.path());
        let target = dir.path().join("tools/ffmpeg/1/ffmpeg");
        install_from_archive(&archive, &download, &target).unwrap();
        assert!(is_executable(&target));
        assert_eq!(fs::read(&target).unwrap(), b"#!/bin/sh\necho ffmpeg version test\n");

        // A wrong archive checksum, or a wrong program checksum: nothing installed, no temp file left.
        let other = dir.path().join("tools/ffmpeg/2/ffmpeg");
        let bad = ToolDownload { sha256: "0".repeat(64), ..download.clone() };
        assert!(install_from_archive(&archive, &bad, &other).is_err());
        let bad_member = ToolDownload { member_sha256: "0".repeat(64), ..download.clone() };
        assert!(install_from_archive(&archive, &bad_member, &other).is_err());
        assert!(!other.exists());
        assert_eq!(fs::read_dir(other.parent().unwrap()).unwrap().count(), 0, "no temp file left");
        let missing = ToolDownload { member: "bin/nothing".into(), ..download };
        assert!(install_from_archive(&archive, &missing, &other).is_err());
        assert!(!other.exists());
    }

    #[test]
    fn an_installed_program_is_hashed_again_before_use() {
        let dir = tempfile::tempdir().unwrap();
        let tool = entry(FFMPEG).unwrap();
        let Some(d) = tool.current_download() else { return };
        let path = dir.path().join("ffmpeg");
        // The pinned size but other bytes: refused.
        fs::write(&path, vec![0u8; d.member_bytes as usize]).unwrap();
        let err = verify_installed(&path, tool).unwrap_err();
        assert!(err.to_string().contains("does not match its pinned checksum"), "{err}");
    }

    #[test]
    fn finds_programs_on_path_and_prefers_the_download() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let tool = entry(FFMPEG).unwrap();
        let path_var = format!("/nonexistent:{}", bin.display());
        let tools = dir.path().join("tools");
        assert_eq!(status_of(tool, &tools, &path_var, None).active_path, None);

        let system = bin.join("ffmpeg");
        fs::write(&system, b"#!/bin/sh\n").unwrap();
        assert_eq!(find_on_path("ffmpeg", &path_var), None, "not executable yet");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&system, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let status = status_of(tool, &tools, &path_var, None);
        assert_eq!(status.system_path.as_deref(), Some(system.to_str().unwrap()));
        assert_eq!(status.active_path, status.system_path);

        // An installed program of the pinned size wins (on a platform the manifest covers).
        if let Some(d) = tool.current_download() {
            let installed = installed_path(&tools, tool);
            fs::create_dir_all(installed.parent().unwrap()).unwrap();
            fs::write(&installed, vec![0u8; d.member_bytes as usize]).unwrap();
            let status = status_of(tool, &tools, &path_var, None);
            assert_eq!(status.active_path.as_deref(), Some(installed.to_str().unwrap()));
            // A truncated program does not count.
            fs::write(&installed, b"short").unwrap();
            assert_eq!(status_of(tool, &tools, &path_var, None).installed_path, None);
        }
    }
}
