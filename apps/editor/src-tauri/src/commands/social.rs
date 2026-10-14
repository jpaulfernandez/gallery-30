//! Social post export (workflow plan 14): the publish CLI's `render-frames` command, run for the editor's export jobs.
//!
//! A post's frames are rendered by the same headless Chromium path as the book's page images (`packages/publish`
//! `frames.ts`), so a frame is pixel for pixel what `pages.ts` makes of the same page. The editor runs one job per
//! export (`lib/jobs/socialExport.ts`), the `post` task: one CLI process that removes the frames an earlier export left
//! and this one will not write, writes `caption.txt` and renders every frame (`--caption --clean`), reporting each
//! frame on stdout. `prepare`, `frame` and `caption` run the parts on their own.
//!
//! The CLI runs in a process group of its own (in development it is `tsx` starting Node, which starts Chromium), and a
//! cancel kills the whole group, so no renderer is left behind.
//!
//! `run_render_frames` streams the CLI's `--json` lines as `social:line` `{ job, stream, line }` and ends with one
//! `social:exit` `{ job, code }`; `cancel_render_frames(job)` kills it (or keeps it from starting). The destination is
//! checked like an export's (`check_export_dest`: inside an imported folder or app data, or picked in the dialog this
//! session) and the slug must be one plain path segment. Arguments are built here, never passed through.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::develop::PendingCancels;
use crate::commands::export::check_export_dest;
// Process groups: shared with the slideshow and print runners (`commands/process.rs`).
use crate::commands::process::{in_own_group, kill_group};
use crate::commands::projects;
use crate::commands::publish::{child_path, cli_launcher, SETTINGS_FILE_NAME};
use crate::error::{Error, IoContext, Result};
use crate::scope;

const EVENT_LINE: &str = "social:line";
const EVENT_EXIT: &str = "social:exit";

/// Running `render-frames` processes by job id (several at once: the export lane runs two), and cancels of jobs that
/// had not started yet.
#[derive(Default)]
pub struct SocialJobs {
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

/// What one job asks the CLI to do.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FramesTask {
    /// The whole post: caption, then every frame, earlier leftovers removed.
    Post,
    Prepare,
    Frame,
    Caption,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FrameFormat {
    Jpeg,
    Png,
}

/// The request of one `run_render_frames` call.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RenderFramesRequest {
    /// The open project's id (its file is passed to the CLI).
    pub project: String,
    /// The social output's id in the project.
    pub output: String,
    pub task: FramesTask,
    /// Destination folder (absolute); the files go to `<dest>/<slug>/`.
    pub dest: String,
    pub slug: String,
    /// 1-based frame number, for `frame`.
    #[serde(default)]
    pub frame: Option<u32>,
    #[serde(default)]
    pub format: Option<FrameFormat>,
    #[serde(default)]
    pub quality: Option<u8>,
}

/// A slug is one plain path segment: lowercase letters, digits and dashes (`postSlug`).
fn check_slug(slug: &str) -> Result<&str> {
    let ok = !slug.is_empty()
        && slug.len() <= 64
        && !slug.starts_with('-')
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(slug)
    } else {
        Err(Error::Invalid(format!("Invalid post folder name {slug:?}")))
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

/// The CLI arguments after the launcher's own, for `request` writing into `out_dir`.
fn cli_args(request: &RenderFramesRequest, project_file: &Path, out_dir: &Path, settings: &Path) -> Result<Vec<String>> {
    let mut args = vec![
        "render-frames".to_string(),
        project_file.to_string_lossy().into_owned(),
        "--output".into(),
        check_output_id(&request.output)?.to_string(),
        "--out".into(),
        out_dir.to_string_lossy().into_owned(),
    ];
    match request.task {
        FramesTask::Post => args.extend(["--caption".into(), "--clean".into()]),
        FramesTask::Prepare => args.push("--prepare".into()),
        FramesTask::Frame => {
            let n = request.frame.filter(|n| *n >= 1).ok_or_else(|| Error::Invalid("A frame number is needed".into()))?;
            args.extend(["--frames".into(), n.to_string()]);
        }
        FramesTask::Caption => args.extend(["--frames".into(), String::new(), "--caption".into()]),
    }
    if let Some(format) = request.format {
        args.extend(["--format".into(), if format == FrameFormat::Png { "png" } else { "jpeg" }.into()]);
    }
    if let Some(quality) = request.quality {
        if !(1..=100).contains(&quality) {
            return Err(Error::Invalid(format!("JPEG quality {quality} is not 1 to 100")));
        }
        args.extend(["--quality".into(), quality.to_string()]);
    }
    args.extend(["--json".into(), "--env".into(), settings.to_string_lossy().into_owned()]);
    Ok(args)
}

/// Run one `render-frames` job. Resolves when the process has exited (after its `social:exit` event).
#[tauri::command]
pub async fn run_render_frames<R: Runtime>(app: AppHandle<R>, job: u64, request: RenderFramesRequest) -> Result<()> {
    if app.state::<SocialJobs>().cancelled_before_start(job) {
        let _ = app.emit(EVENT_EXIT, ExitEvent { job, code: None });
        return Ok(());
    }
    let dest = check_export_dest(app.clone(), request.dest.clone()).await?;
    let out_dir = Path::new(&dest).join(check_slug(&request.slug)?);
    let project_file = projects::project_file(&app, &request.project)?;
    if !project_file.is_file() {
        return Err(Error::Invalid(format!("{} not found", project_file.display())));
    }
    let settings = scope::app_data_dir(&app)?.join(SETTINGS_FILE_NAME);
    let (program, mut args, cwd) = cli_launcher()?;
    args.extend(cli_args(&request, &project_file, &out_dir, &settings)?);

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
    log::info!("[photobook:social] render-frames job {job} {:?} frame {:?}", request.task, request.frame);
    let mut child = cmd.spawn().ctx(format!("starting {}", program.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    app.state::<SocialJobs>().adopt(job, child);

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
    let code = app.state::<SocialJobs>().finish(job);
    let _ = app.emit(EVENT_EXIT, ExitEvent { job, code });
    Ok(())
}

/// Kill job `job` if it runs; one that has not started yet never starts.
#[tauri::command]
pub async fn cancel_render_frames<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<SocialJobs>().cancel(job);
    Ok(())
}

impl SocialJobs {
    fn cancelled_before_start(&self, job: u64) -> bool {
        let _children = self.children.lock().expect("social lock poisoned");
        self.pending.take(job)
    }

    /// Track `child` as job `job`; killed at once when the job was cancelled meanwhile.
    fn adopt(&self, job: u64, mut child: Child) {
        let mut children = self.children.lock().expect("social lock poisoned");
        if self.pending.take(job) {
            kill_group(&mut child);
        }
        children.insert(job, child);
    }

    /// Wait for job `job`'s process and forget it: its exit code, None when killed (or unknown).
    fn finish(&self, job: u64) -> Option<i32> {
        let child = self.children.lock().expect("social lock poisoned").remove(&job);
        child.and_then(|mut c| c.wait().ok().and_then(|s| s.code()))
    }

    fn cancel(&self, job: u64) {
        let mut children = self.children.lock().expect("social lock poisoned");
        match children.get_mut(&job) {
            Some(child) => kill_group(child),
            None => self.pending.remember(job),
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request(task: FramesTask) -> RenderFramesRequest {
        RenderFramesRequest {
            project: "01PROJECT".into(),
            output: "01OUTPUT".into(),
            task,
            dest: "/photos/Exports/Posts".into(),
            slug: "summer".into(),
            frame: Some(3),
            format: Some(FrameFormat::Jpeg),
            quality: Some(90),
        }
    }

    #[test]
    fn builds_the_arguments_per_task() {
        let (file, out, env) = (PathBuf::from("/p/project.json"), PathBuf::from("/d/summer"), PathBuf::from("/a/publish.env"));
        let frame = cli_args(&request(FramesTask::Frame), &file, &out, &env).unwrap();
        assert_eq!(
            frame,
            [
                "render-frames", "/p/project.json", "--output", "01OUTPUT", "--out", "/d/summer", "--frames", "3", "--format",
                "jpeg", "--quality", "90", "--json", "--env", "/a/publish.env"
            ]
        );
        let caption = cli_args(&request(FramesTask::Caption), &file, &out, &env).unwrap();
        assert!(caption.windows(3).any(|w| w == ["--frames", "", "--caption"]));
        let post = cli_args(&request(FramesTask::Post), &file, &out, &env).unwrap();
        assert!(post.windows(2).any(|w| w == ["--caption", "--clean"]));
        assert!(!post.contains(&"--frames".to_string()), "every frame");
        let prepare = cli_args(&request(FramesTask::Prepare), &file, &out, &env).unwrap();
        assert!(prepare.contains(&"--prepare".to_string()));
        assert!(!prepare.contains(&"--frames".to_string()));
        let mut no_frame = request(FramesTask::Frame);
        no_frame.frame = Some(0);
        assert!(cli_args(&no_frame, &file, &out, &env).is_err());
        let mut bad_output = request(FramesTask::Frame);
        bad_output.output = "../x".into();
        assert!(cli_args(&bad_output, &file, &out, &env).is_err());
    }

    #[test]
    fn slugs_are_one_plain_segment() {
        assert!(check_slug("instagram-carousel-2").is_ok());
        for bad in ["", "..", "a/b", "-x", "Upper", ".hidden", "a b"] {
            assert!(check_slug(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_cancel_before_start_is_kept_and_a_running_job_is_killed() {
        let jobs = SocialJobs::default();
        jobs.cancel(1);
        assert!(jobs.cancelled_before_start(1));
        assert!(!jobs.cancelled_before_start(1));
        // Two jobs run side by side; cancelling one leaves the other.
        jobs.adopt(2, Command::new("sleep").arg("30").spawn().unwrap());
        jobs.adopt(3, Command::new("sleep").arg("0").spawn().unwrap());
        jobs.cancel(2);
        assert_eq!(jobs.finish(2), None, "killed");
        assert_eq!(jobs.finish(3), Some(0));
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_kills_what_the_cli_started() {
        // A launcher that starts a grandchild (as tsx starts Node): the cancel must stop both.
        let dir = std::env::temp_dir().join(format!("pb-social-group-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("grandchild.pid");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("sleep 30 & echo $! > {}; wait", pid_file.display()));
        in_own_group(&mut cmd);
        let jobs = SocialJobs::default();
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
            alive = Command::new("/bin/kill").args(["-0", &grandchild.to_string()]).status().unwrap().success();
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!alive, "the grandchild was killed with the group");
    }
}
