//! Publish settings and running the publish CLI (step 2.7).
//!
//! Settings live in `<appdata>/publish.env` (dotenv style; the CLI reads the same file and never
//! the project file, so secrets stay out of the photo folder). `run_publish` starts the CLI as a
//! child process and streams its `--json` stdout lines to the webview as events.
//!
//! During development the CLI is the workspace source, run through `tsx` from
//! `packages/publish` (located from `CARGO_MANIFEST_DIR`). A bundled sidecar comes with the
//! installable build; until then release builds need `PHOTOBOOK_CLI` pointing at a `photobook`
//! executable.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::atomic::write_secret;
use crate::commands::develop::PendingCancels;
use crate::commands::projects;
use crate::error::{Error, IoContext, Result};
use crate::scope;

pub const SETTINGS_FILE_NAME: &str = "publish.env";
const EVENT_LINE: &str = "publish:line";
const EVENT_EXIT: &str = "publish:exit";

/// Keys the Settings screen may write. Anything else in the file is kept as-is.
pub const SETTINGS_KEYS: &[&str] = &[
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL",
    "R2_TRANSPORT",
    "VIEWER_URL",
    "DOWNLOAD_MAX_EDGE",
    "DOWNLOAD_QUALITY",
    "PUBLISH_CONCURRENCY",
    "SOCIAL_API_URL",
    "SOCIAL_ADMIN_TOKEN",
];

/// The running CLI process, if any, tagged with its job id, and cancels of jobs that had not started yet.
#[derive(Default)]
pub struct PublishJobs {
    child: Mutex<Option<(u64, Child)>>,
    /// Remembered and taken with the `child` lock held, so a cancel and a start never miss each other.
    pending: PendingCancels,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LineEvent<'a> {
    job: u64,
    /// `stdout` lines are JSON events from the CLI; `stderr` lines are plain text.
    stream: &'a str,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    job: u64,
    /// Exit code, or null when killed.
    code: Option<i32>,
}

/// What the webview may ask the CLI to do. Arguments are built here, never passed through.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PublishCommand {
    Publish,
    Unpublish,
    PasswordClear,
    Doctor,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(scope::app_data_dir(app)?.join(SETTINGS_FILE_NAME))
}

/// Parse `KEY=VALUE` lines; `#` comments; optional single or double quotes around the value.
pub fn parse_env(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let mut value = value.trim();
        if value.len() >= 2 && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''))) {
            value = &value[1..value.len() - 1];
        }
        out.insert(key.trim().to_string(), value.to_string());
    }
    out
}

pub fn serialize_env(values: &BTreeMap<String, String>) -> String {
    let mut text = String::from("# Photobook publish settings. Written by the editor; edit by hand if you like.\n");
    for (key, value) in values {
        if value.is_empty() {
            continue;
        }
        let needs_quotes = value.chars().any(|c| c.is_whitespace() || c == '#' || c == '"' || c == '\'');
        if needs_quotes {
            text.push_str(&format!("{key}=\"{}\"\n", value.replace('\\', "\\\\").replace('"', "\\\"")));
        } else {
            text.push_str(&format!("{key}={value}\n"));
        }
    }
    text
}

/// The settings file as a map (empty when it does not exist yet).
#[tauri::command]
pub async fn read_publish_settings<R: Runtime>(app: AppHandle<R>) -> Result<BTreeMap<String, String>> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse_env(&text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(err) => Err(Error::Io(format!("reading {}", path.display()), err)),
    }
}

/// Replace the known settings keys with `values` (an empty value removes the key); other keys in
/// the file are kept. Written atomically.
#[tauri::command]
pub async fn write_publish_settings<R: Runtime>(app: AppHandle<R>, values: BTreeMap<String, String>) -> Result<()> {
    for key in values.keys() {
        if !SETTINGS_KEYS.contains(&key.as_str()) {
            return Err(Error::Invalid(format!("Unknown setting {key}")));
        }
    }
    let path = settings_path(&app)?;
    let mut current = read_publish_settings(app.clone()).await?;
    for (key, value) in values {
        if value.trim().is_empty() {
            current.remove(&key);
        } else {
            current.insert(key, value.trim().to_string());
        }
    }
    // The file holds secrets: created owner read and write only (`write_secret`).
    write_secret(&path, serialize_env(&current).as_bytes())?;
    Ok(())
}

/// How to start the CLI: program plus leading arguments.
pub(crate) fn cli_launcher() -> Result<(PathBuf, Vec<String>, Option<PathBuf>)> {
    if let Some(bin) = std::env::var_os("PHOTOBOOK_CLI") {
        return Ok((PathBuf::from(bin), vec![], None));
    }
    if cfg!(debug_assertions) {
        // apps/editor/src-tauri -> repo root -> packages/publish
        let pkg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/publish");
        let pkg = pkg.canonicalize().ctx("locating packages/publish")?;
        let tsx = pkg.join("node_modules/.bin/tsx");
        if !tsx.is_file() {
            return Err(Error::Invalid(format!("{} is missing: run pnpm install", tsx.display())));
        }
        let entry = pkg.join("bin/photobook.ts");
        return Ok((tsx, vec!["--conditions=source".into(), entry.to_string_lossy().into_owned()], Some(pkg)));
    }
    Err(Error::Invalid("The publish CLI is not bundled with this build yet; set PHOTOBOOK_CLI".into()))
}

/// PATH for the child: the app's own PATH plus where Node usually lives when the app was launched
/// from the Finder (no shell profile): Homebrew, /usr/local and nvm installs.
pub(crate) fn child_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH").ok().into_iter().collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        parts.push(extra.to_string());
    }
    if let Some(home) = std::env::var_os("HOME") {
        let nvm = Path::new(&home).join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path().join("bin"))).collect();
            versions.sort();
            versions.reverse();
            parts.extend(versions.into_iter().map(|p| p.to_string_lossy().into_owned()));
        }
    }
    parts.join(":")
}

/// Run the CLI. `project` is the open project's id for `publish` and `unpublish` (its file is passed to the CLI as
/// `photobook publish <project file>`), ignored otherwise. Emits `publish:line` `{ job, stream, line }` per output
/// line and `publish:exit` `{ job, code }` once. Resolves when the process has exited. A new job kills a running one.
#[tauri::command]
pub async fn run_publish<R: Runtime>(
    app: AppHandle<R>,
    job: u64,
    command: PublishCommand,
    project: Option<String>,
    dry_run: Option<bool>,
    prune: Option<bool>,
) -> Result<()> {
    // Cancelled before it got here: nothing to start.
    if app.state::<PublishJobs>().cancelled_before_start(job) {
        let _ = app.emit(EVENT_EXIT, ExitEvent { job, code: None });
        return Ok(());
    }
    let (program, mut args, cwd) = cli_launcher()?;
    let settings = settings_path(&app)?;
    match command {
        PublishCommand::Publish | PublishCommand::Unpublish => {
            let id = project.ok_or_else(|| Error::Invalid("A project must be open".into()))?;
            let project = projects::project_file(&app, &id)?;
            if !project.is_file() {
                return Err(Error::Invalid(format!("{} not found", project.display())));
            }
            args.push(if command == PublishCommand::Publish { "publish" } else { "unpublish" }.into());
            args.push(project.to_string_lossy().into_owned());
            if command == PublishCommand::Publish {
                // The editor records lastPublishedAt itself: it owns the open project file.
                args.push("--no-record".into());
                if dry_run.unwrap_or(false) {
                    args.push("--dry-run".into());
                }
                if prune.unwrap_or(false) {
                    args.push("--prune".into());
                }
            }
        }
        PublishCommand::PasswordClear => args.extend(["password".into(), "clear".into()]),
        PublishCommand::Doctor => args.push("doctor".into()),
    }
    args.push("--json".into());
    args.push("--env".into());
    args.push(settings.to_string_lossy().into_owned());

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .env("PATH", child_path())
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().ctx(format!("starting {}", program.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    app.state::<PublishJobs>().adopt(job, child);

    let app2 = app.clone();
    let err_reader = tauri::async_runtime::spawn_blocking(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                let _ = app2.emit(EVENT_LINE, LineEvent { job, stream: "stderr", line });
            }
        }
    });
    let app3 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
                let _ = app3.emit(EVENT_LINE, LineEvent { job, stream: "stdout", line });
            }
        }
    })
    .await?;
    let _ = err_reader.await;

    let code = {
        let jobs = app.state::<PublishJobs>();
        let mut slot = jobs.child.lock().expect("publish lock poisoned");
        match slot.take() {
            Some((id, mut child)) if id == job => child.wait().ok().and_then(|s| s.code()),
            other => {
                *slot = other; // a newer job replaced us; it already killed this process
                None
            }
        }
    };
    let _ = app.emit(EVENT_EXIT, ExitEvent { job, code });
    Ok(())
}

/// Kill the running job if it is `job`; a job that has not started yet never starts (or is killed once spawned).
#[tauri::command]
pub async fn cancel_publish<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<PublishJobs>().cancel(job);
    Ok(())
}

impl PublishJobs {
    /// `job` was cancelled before it started (consumes the request).
    fn cancelled_before_start(&self, job: u64) -> bool {
        let _slot = self.child.lock().expect("publish lock poisoned");
        self.pending.take(job)
    }

    /// Make `child` the running job, killing the one it replaces; killed at once when `job` was cancelled meanwhile.
    fn adopt(&self, job: u64, mut child: Child) {
        let mut slot = self.child.lock().expect("publish lock poisoned");
        if let Some((_, mut old)) = slot.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        if self.pending.take(job) {
            let _ = child.kill();
        }
        *slot = Some((job, child));
    }

    fn cancel(&self, job: u64) {
        let mut slot = self.child.lock().expect("publish lock poisoned");
        match slot.as_mut() {
            Some((id, child)) if *id == job => {
                let _ = child.kill();
            }
            _ => self.pending.remember(job),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancel_before_the_cli_starts_is_kept_until_it_does() {
        let jobs = PublishJobs::default();
        // Cancelled before `run_publish` got to it: it does not start.
        jobs.cancel(1);
        assert!(jobs.cancelled_before_start(1));
        assert!(!jobs.cancelled_before_start(1), "consumed once");
        // Cancelled while spawning: killed as soon as it is adopted.
        jobs.cancel(2);
        jobs.adopt(2, Command::new("sleep").arg("30").spawn().unwrap());
        let (_, mut child) = jobs.child.lock().unwrap().take().unwrap();
        let status = child.wait().unwrap();
        assert_eq!(status.code(), None, "killed");
        // A running job is killed directly and nothing is remembered.
        jobs.adopt(3, Command::new("sleep").arg("30").spawn().unwrap());
        jobs.cancel(3);
        assert!(!jobs.cancelled_before_start(3));
        let (_, mut child) = jobs.child.lock().unwrap().take().unwrap();
        assert_eq!(child.wait().unwrap().code(), None);
    }

    #[test]
    fn env_round_trips_quotes_and_comments() {
        let mut values = BTreeMap::new();
        values.insert("R2_BUCKET".to_string(), "photobook".to_string());
        values.insert("VIEWER_URL".to_string(), "two words #1".to_string());
        values.insert("EMPTY".to_string(), String::new());
        let text = serialize_env(&values);
        let parsed = parse_env(&text);
        assert_eq!(parsed.get("R2_BUCKET").map(String::as_str), Some("photobook"));
        assert_eq!(parsed.get("VIEWER_URL").map(String::as_str), Some("two words #1"));
        assert!(!parsed.contains_key("EMPTY"));
        assert_eq!(parse_env("# c\nA=1\nB='x y'\n\nbad line\n").len(), 2);
    }
}
