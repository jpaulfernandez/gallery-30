//! Print PDF export (workflow plan 15): the publish CLI's `print` command, run for the editor's print jobs.
//!
//! A print output is printed by the same headless Chromium path as the book's page images (`packages/publish`
//! `print.ts`, `page.pdf` at the trim plus the bleed). The editor queues one job per export (`lib/jobs/printExport.ts`):
//! the publish gates render and denoise the photos first, then this command runs `print <project> --output <id>
//! --out <dest>/<file>.pdf`.
//!
//! `run_print` streams the CLI's `--json` lines as `print:line` `{ job, stream, line }` and ends with one `print:exit`
//! `{ job, code }`; `cancel_print(job)` kills it (or keeps it from starting). The destination is checked like an
//! export's (`check_export_dest`: inside an imported folder or app data, or picked in the dialog this session) and the
//! file name must be one plain `<slug>.pdf` segment. Arguments are built here, never passed through.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::develop::PendingCancels;
use crate::commands::export::check_export_dest;
use crate::commands::projects;
use crate::commands::publish::{child_path, cli_launcher, SETTINGS_FILE_NAME};
use crate::error::{Error, IoContext, Result};
use crate::scope;

const EVENT_LINE: &str = "print:line";
const EVENT_EXIT: &str = "print:exit";

/// Running `print` processes by job id, and cancels of jobs that had not started yet.
#[derive(Default)]
pub struct PrintJobs {
    children: Mutex<HashMap<u64, Child>>,
    /// Remembered and taken with the `children` lock held, so a cancel and a start never miss each other.
    pending: PendingCancels,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LineEvent<'a> {
    job: u64,
    stream: &'a str,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    job: u64,
    code: Option<i32>,
}

/// The request of one `run_print` call.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrintRequest {
    /// The open project's id (its file is passed to the CLI).
    pub project: String,
    /// The print output's id in the project.
    pub output: String,
    /// Destination folder (absolute); the PDF is `<dest>/<file>`.
    pub dest: String,
    /// `<slug>.pdf`.
    pub file: String,
    /// Overwrite an existing `<dest>/<file>` (the sheet asks first); without it the job refuses to replace one.
    #[serde(default)]
    pub replace: bool,
}

/// A PDF file name is one plain segment: a slug (lowercase letters, digits, dashes) plus `.pdf`.
fn check_file(file: &str) -> Result<&str> {
    let ok = file.strip_prefix('-').is_none()
        && file.strip_suffix(".pdf").is_some_and(|slug| {
            !slug.is_empty() && slug.len() <= 64 && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    if ok {
        Ok(file)
    } else {
        Err(Error::Invalid(format!("Invalid PDF file name {file:?}")))
    }
}

/// Output ids are ULIDs (letters and digits).
fn check_output_id(id: &str) -> Result<&str> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err(Error::Invalid(format!("Invalid output id {id:?}")))
    }
}

/// The CLI arguments after the launcher's own, for `request` writing `out_file`.
fn cli_args(request: &PrintRequest, project_file: &Path, out_file: &Path, settings: &Path) -> Result<Vec<String>> {
    Ok(vec![
        "print".to_string(),
        project_file.to_string_lossy().into_owned(),
        "--output".into(),
        check_output_id(&request.output)?.to_string(),
        "--out".into(),
        out_file.to_string_lossy().into_owned(),
        "--json".into(),
        "--env".into(),
        settings.to_string_lossy().into_owned(),
    ])
}

/// Run one `print` job. Resolves when the process has exited (after its `print:exit` event).
#[tauri::command]
pub async fn run_print<R: Runtime>(app: AppHandle<R>, job: u64, request: PrintRequest) -> Result<()> {
    if app.state::<PrintJobs>().cancelled_before_start(job) {
        let _ = app.emit(EVENT_EXIT, ExitEvent { job, code: None });
        return Ok(());
    }
    let dest = check_export_dest(app.clone(), request.dest.clone()).await?;
    let out_file = Path::new(&dest).join(check_file(&request.file)?);
    if out_file.exists() && !request.replace {
        return Err(Error::Invalid(format!("{} already exists", out_file.display())));
    }
    let project_file = projects::project_file(&app, &request.project)?;
    if !project_file.is_file() {
        return Err(Error::Invalid(format!("{} not found", project_file.display())));
    }
    let settings = scope::app_data_dir(&app)?.join(SETTINGS_FILE_NAME);
    let (program, mut args, cwd) = cli_launcher()?;
    args.extend(cli_args(&request, &project_file, &out_file, &settings)?);

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
    in_own_group(&mut cmd);
    log::info!("[photobook:print] print job {job} to {}", out_file.display());
    let mut child = cmd.spawn().ctx(format!("starting {}", program.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    app.state::<PrintJobs>().adopt(job, child);

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
    let code = app.state::<PrintJobs>().finish(job);
    let _ = app.emit(EVENT_EXIT, ExitEvent { job, code });
    Ok(())
}

/// Whether `<dest>/<file>` exists, so the Export PDF sheet can ask before replacing it (`dest` checked as for a run).
#[tauri::command]
pub async fn print_target_exists<R: Runtime>(app: AppHandle<R>, dest: String, file: String) -> Result<bool> {
    let dest = check_export_dest(app, dest).await?;
    Ok(Path::new(&dest).join(check_file(&file)?).exists())
}

/// Kill job `job` if it runs; one that has not started yet never starts.
#[tauri::command]
pub async fn cancel_print<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<PrintJobs>().cancel(job);
    Ok(())
}

impl PrintJobs {
    fn cancelled_before_start(&self, job: u64) -> bool {
        let _children = self.children.lock().expect("print lock poisoned");
        self.pending.take(job)
    }

    /// Track `child` as job `job`; killed at once when the job was cancelled meanwhile.
    fn adopt(&self, job: u64, mut child: Child) {
        let mut children = self.children.lock().expect("print lock poisoned");
        if self.pending.take(job) {
            kill_group(&mut child);
        }
        children.insert(job, child);
    }

    /// Wait for job `job`'s process and forget it: its exit code, None when killed (or unknown).
    fn finish(&self, job: u64) -> Option<i32> {
        let child = self.children.lock().expect("print lock poisoned").remove(&job);
        child.and_then(|mut c| c.wait().ok().and_then(|s| s.code()))
    }

    fn cancel(&self, job: u64) {
        let mut children = self.children.lock().expect("print lock poisoned");
        match children.get_mut(&job) {
            Some(child) => kill_group(child),
            None => self.pending.remember(job),
        }
    }
}

/// Start the child as the leader of a new process group, so `kill_group` reaches what the launcher starts (`tsx` runs
/// Node, which runs Chromium). Plan 14's `social.rs` does the same; the two can share one helper later.
#[cfg(unix)]
fn in_own_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn in_own_group(_cmd: &mut Command) {}

/// Kill `child` and every process of its group (it leads one, see `in_own_group`): killing the launcher alone would
/// leave Node writing the PDF and holding the output pipe.
fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    {
        // `kill -KILL -<pgid>`: the group's id is the leader's pid.
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &format!("-{}", child.id())])
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request() -> PrintRequest {
        PrintRequest {
            project: "01PROJECT".into(),
            output: "01OUTPUT".into(),
            dest: "/photos/Exports/Print".into(),
            file: "zine.pdf".into(),
            replace: false,
        }
    }

    #[test]
    fn builds_the_arguments() {
        let (file, out, env) =
            (PathBuf::from("/p/project.json"), PathBuf::from("/d/zine.pdf"), PathBuf::from("/a/publish.env"));
        assert_eq!(
            cli_args(&request(), &file, &out, &env).unwrap(),
            ["print", "/p/project.json", "--output", "01OUTPUT", "--out", "/d/zine.pdf", "--json", "--env", "/a/publish.env"]
        );
        let mut bad_output = request();
        bad_output.output = "../x".into();
        assert!(cli_args(&bad_output, &file, &out, &env).is_err());
    }

    #[test]
    fn file_names_are_one_plain_pdf_segment() {
        assert!(check_file("summer-zine-2.pdf").is_ok());
        for bad in ["", ".pdf", "zine", "zine.PDF", "../zine.pdf", "a/b.pdf", "-x.pdf", "Upper.pdf", "a b.pdf"] {
            assert!(check_file(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_cancel_before_start_is_kept_and_a_running_job_is_killed() {
        let jobs = PrintJobs::default();
        jobs.cancel(1);
        assert!(jobs.cancelled_before_start(1));
        assert!(!jobs.cancelled_before_start(1));
        jobs.adopt(2, Command::new("sleep").arg("30").spawn().unwrap());
        jobs.cancel(2);
        assert_eq!(jobs.finish(2), None, "killed");
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_kills_what_the_cli_started() {
        // A launcher that starts a long-running grandchild (as tsx starts Node): the cancel must stop both.
        let dir = std::env::temp_dir().join(format!("pb-print-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("grandchild.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()));
        in_own_group(&mut cmd);
        let jobs = PrintJobs::default();
        jobs.adopt(7, cmd.spawn().unwrap());
        let mut grandchild = None;
        for _ in 0..100 {
            if let Some(pid) = std::fs::read_to_string(&pid_file).ok().and_then(|t| t.trim().parse::<u32>().ok()) {
                grandchild = Some(pid);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let grandchild = grandchild.expect("grandchild started");
        jobs.cancel(7);
        assert_eq!(jobs.finish(7), None, "killed");
        let mut alive = true;
        for _ in 0..100 {
            alive = Command::new("/bin/kill")
                .args(["-0", &grandchild.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!alive, "the grandchild was killed with the group");
    }
}
