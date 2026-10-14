//! Slideshow video (workflow plan 16): the frames, the encode and the audio track.
//!
//! The editor runs one export job per slideshow (`lib/jobs/slideshowExport.ts`), with a run id of its own:
//!
//! - `slideshow_preflight(request)` first: FFmpeg is there (a downloaded one re-hashed) and has the H.264 encoder, the
//!   audio file and the destination are usable, the video file exists or not (the sheet asks before replacing), and
//!   the disk has room for the frames (about 1.5 MB a frame at 1080p, scaled by the pixel count);
//! - `run_slideshow_frames(job, project, output, run)` runs the publish CLI's `render-slideshow`, which writes every
//!   video frame as a JPEG to `<project dir>/.photobook-publish/slideshow/<output>/frames-<run>/000001.jpg …` and
//!   `frames.json` last (its lines stream as `video:line` `{ job, stream, line }`, then one `video:exit`
//!   `{ job, code, signal, cancelled }`: a CLI killed by a signal it was not sent by a cancel is a failure);
//! - `encode_slideshow(job, request)` runs FFmpeg (`tools::resolve_tool`) on that image sequence and the optional audio
//!   into `<dest>/.<file>.<pid>.part`, renamed to `<dest>/<file>` once FFmpeg exits 0 (an existing file only with
//!   `replace`). Progress comes from `-progress pipe:1` (`frame=N`) as `video:progress` `{ job, frame, total }`. A cancel
//!   kills FFmpeg and the temp file is deleted, so a cancelled or failed encode leaves no partial video;
//! - `discard_slideshow_frames(project, output, run)` deletes that run's frames (never another run's).
//!
//! Every child runs in its own process group and a cancel kills the group (`commands/process.rs`): the CLI is `tsx` →
//! Node → Chromium. Frame folders older than `STALE_FRAMES` and `.part` files of earlier app sessions are swept when a
//! run starts. `cancel_video(job)` kills either kind (or keeps it from starting); `video_target_exists(dest, fileName)`
//! says whether the video would replace a file. `import_audio(path)` copies an audio file picked in the dialog to
//! `<appdata>/audio/<sha256>.<ext>`, so the project can name it in later sessions. Arguments are built here, never
//! passed through.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::develop::PendingCancels;
use crate::commands::export::check_export_dest;
use crate::commands::process::{exit_signal, in_own_group, kill_group};
use crate::commands::projects;
use crate::commands::publish::{child_path, cli_launcher, SETTINGS_FILE_NAME};
use crate::commands::tools::{self, file_sha256, FFMPEG, H264_ENCODER};
use crate::error::{Error, IoContext, Result};
use crate::scope::{self, app_data_dir, ensure_allowed};

const EVENT_LINE: &str = "video:line";
const EVENT_EXIT: &str = "video:exit";
const EVENT_PROGRESS: &str = "video:progress";
/// Written last by `render-slideshow` (`SlideshowFramesManifest` in `packages/publish/src/slideshow.ts`).
pub const FRAMES_MANIFEST: &str = "frames.json";
const AUDIO_DIR: &str = "audio";
/// Audio files a slideshow takes (`SLIDESHOW_AUDIO_EXTENSIONS` in TS).
const AUDIO_EXTENSIONS: [&str; 9] = ["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus"];
/// Seconds of audio fade-out at the end (`AUDIO_FADE_SECONDS` in TS).
const AUDIO_FADE_SECONDS: f64 = 1.5;
/// FFmpeg's last stderr lines kept for the error message.
const STDERR_TAIL: usize = 12;
/// Frame folders of a run older than this are left over (a crash, a killed app) and swept.
const STALE_FRAMES: Duration = Duration::from_secs(6 * 3600);
/// Disk a 1920 × 1080 frame takes, with room to spare (they are about 0.3 MB; transitions and 4:4:4 cost more).
const FRAME_BYTES_1080P: f64 = 1.5e6;

/// How a job's process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Finished {
    /// Exit code; None when a signal ended it (or it never ran).
    pub code: Option<i32>,
    /// The signal that ended it.
    pub signal: Option<i32>,
    /// A cancel killed it (or kept it from starting).
    pub cancelled: bool,
}

/// Running CLI and FFmpeg processes by job id, cancels of jobs not started yet, and jobs killed by a cancel.
#[derive(Default)]
pub struct VideoJobs {
    children: Mutex<HashMap<u64, Child>>,
    /// Remembered and taken with the `children` lock held, so a cancel and a start never miss each other.
    pending: PendingCancels,
    killed: Mutex<HashSet<u64>>,
}

impl VideoJobs {
    fn cancelled_before_start(&self, job: u64) -> bool {
        let _children = self.children.lock().expect("video lock poisoned");
        self.pending.take(job)
    }

    /// Track `child` as job `job`; killed at once (with its group) when the job was cancelled meanwhile.
    fn adopt(&self, job: u64, mut child: Child) {
        let mut children = self.children.lock().expect("video lock poisoned");
        if self.pending.take(job) {
            kill_group(&mut child);
            self.killed.lock().expect("video lock poisoned").insert(job);
        }
        children.insert(job, child);
    }

    /// Wait for job `job`'s process and forget it.
    fn finish(&self, job: u64) -> Finished {
        let child = self.children.lock().expect("video lock poisoned").remove(&job);
        let status = child.and_then(|mut c| c.wait().ok());
        let cancelled = self.killed.lock().expect("video lock poisoned").remove(&job);
        Finished { code: status.and_then(|s| s.code()), signal: status.as_ref().and_then(exit_signal), cancelled }
    }

    pub(crate) fn cancel(&self, job: u64) {
        let mut children = self.children.lock().expect("video lock poisoned");
        match children.get_mut(&job) {
            Some(child) => {
                kill_group(child);
                self.killed.lock().expect("video lock poisoned").insert(job);
            }
            None => self.pending.remember(job),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LineEvent<'a> {
    job: u64,
    stream: &'a str,
    line: String,
}

/// `video:exit`: `code` is None when a signal ended the CLI; `cancelled` says whether a cancel sent it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    job: u64,
    code: Option<i32>,
    signal: Option<i32>,
    cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job: u64,
    frame: u64,
    total: u64,
}

/// `frames.json`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FramesManifest {
    pub version: u32,
    pub output: String,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
    pub frames: u64,
    pub slides: u32,
    pub seconds: f64,
}

/// Output ids are ULIDs and run ids short tokens: letters and digits only.
fn check_id<'a>(id: &'a str, what: &str) -> Result<&'a str> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err(Error::Invalid(format!("Invalid {what} {id:?}")))
    }
}

/// `<project dir>/.photobook-publish/slideshow/<output>`: the run folders of one slideshow.
fn slideshow_dir(project_file: &Path, output: &str) -> Result<PathBuf> {
    let dir = project_file.parent().ok_or_else(|| Error::Invalid("Invalid project path".into()))?;
    Ok(dir.join(".photobook-publish").join("slideshow").join(check_id(output, "output id")?))
}

/// `<project dir>/.photobook-publish/slideshow/<output>/frames-<run>`: one export's frames.
pub fn frames_dir(project_file: &Path, output: &str, run: &str) -> Result<PathBuf> {
    Ok(slideshow_dir(project_file, output)?.join(format!("frames-{}", check_id(run, "run id")?)))
}

/// Remove the `frames-*` folders under `dir` older than `max_age`, except `keep`.
pub fn sweep_stale_frames(dir: &Path, keep: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= max_age);
        if path != keep && name.to_string_lossy().starts_with("frames-") && path.is_dir() && stale {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Remove `.<name>.<pid>.part` files in `dest` left by another process (an earlier session that died mid-encode).
pub fn sweep_stale_parts(dest: &Path, name: &str) {
    let Ok(entries) = fs::read_dir(dest) else { return };
    let prefix = format!(".{name}.");
    let mine = format!(".{name}.{}.part", std::process::id());
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let pid = file.strip_prefix(&prefix).and_then(|rest| rest.strip_suffix(".part"));
        if file != mine && pid.is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The frames' manifest, checked: frames there are (the last one exists), a sane size and rate.
pub fn read_frames(dir: &Path, output: &str) -> Result<FramesManifest> {
    let text = fs::read_to_string(dir.join(FRAMES_MANIFEST))
        .map_err(|_| Error::Invalid("The slideshow's frames are not rendered (or not complete)".into()))?;
    let manifest: FramesManifest =
        serde_json::from_str(&text).map_err(|e| Error::Invalid(format!("Invalid {FRAMES_MANIFEST}: {e}")))?;
    let sane = manifest.version == 1
        && manifest.output == output
        && manifest.frames > 0
        && (1..=120).contains(&manifest.fps)
        && (16..=8192).contains(&manifest.width)
        && (16..=8192).contains(&manifest.height);
    if !sane {
        return Err(Error::Invalid(format!("{FRAMES_MANIFEST} does not describe this slideshow's frames")));
    }
    if !dir.join(frame_name(manifest.frames - 1)).is_file() {
        return Err(Error::Invalid("The slideshow's frames are incomplete; export again".into()));
    }
    Ok(manifest)
}

/// `000001.jpg` for frame 0 (`slideshowFrameName` in TS).
pub fn frame_name(index: u64) -> String {
    format!("{:06}.jpg", index + 1)
}

/// FFmpeg's image2 pattern for the frames in `dir`: a `%` in the folder's path is doubled, so it is not a field.
pub fn frames_pattern(dir: &Path) -> OsString {
    let escaped = dir.to_string_lossy().replace('%', "%%");
    PathBuf::from(escaped).join("%06d.jpg").into_os_string()
}

/// What one encode is made of.
pub struct EncodeArgs<'a> {
    pub frames_dir: &'a Path,
    pub manifest: &'a FramesManifest,
    pub audio: Option<&'a Path>,
    /// Video bitrate, bits per second.
    pub bitrate: u64,
    pub encoder: &'a str,
    /// The temp file FFmpeg writes (an MP4 whatever its name).
    pub output: &'a Path,
}

/// FFmpeg's arguments: the image sequence at the frames' rate, exactly `frames` video frames, the audio (if any) cut
/// or padded to the video's length and faded out over its last `AUDIO_FADE_SECONDS` (a track shorter than that point
/// ends unfaded, then silence), H.264 in BT.709 limited range (what phones play), AAC, `faststart`.
pub fn ffmpeg_args(a: &EncodeArgs) -> Vec<OsString> {
    let m = a.manifest;
    let seconds = m.frames as f64 / m.fps as f64;
    let mut args: Vec<OsString> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(OsString::from));
    push(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]);
    push(&["-framerate", &m.fps.to_string(), "-start_number", "1", "-i"]);
    args.push(frames_pattern(a.frames_dir));
    if let Some(audio) = a.audio {
        args.push("-i".into());
        args.push(audio.as_os_str().to_owned());
    }
    let mut push = |items: &[&str]| args.extend(items.iter().map(OsString::from));
    push(&["-map", "0:v:0"]);
    if a.audio.is_some() {
        push(&["-map", "1:a:0"]);
    }
    let rate = a.bitrate.to_string();
    let max = (a.bitrate * 3 / 2).to_string();
    let buf = (a.bitrate * 2).to_string();
    push(&[
        "-frames:v",
        &m.frames.to_string(),
        "-vf",
        // `setparams` tags the frames too: VideoToolbox writes the tags of the frames, not of the options below.
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-c:v",
        a.encoder,
        "-b:v",
        &rate,
        "-maxrate",
        &max,
        "-bufsize",
        &buf,
        "-profile:v",
        "high",
    ]);
    if a.encoder == "h264_videotoolbox" {
        // A software encode when the media engine is busy or missing, rather than a failure.
        push(&["-allow_sw", "1"]);
    }
    push(&[
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-color_range",
        "tv",
        "-r",
        &m.fps.to_string(),
    ]);
    if a.audio.is_some() {
        let fade_start = (seconds - AUDIO_FADE_SECONDS).max(0.0);
        let fade = format!("afade=t=out:st={fade_start:.3}:d={AUDIO_FADE_SECONDS}");
        push(&["-c:a", "aac", "-b:a", "192k", "-af", &fade]);
    }
    // The video's length: a longer track is cut, a shorter one leaves silence.
    push(&["-t", &format!("{seconds:.3}"), "-tag:v", "avc1", "-movflags", "+faststart", "-f", "mp4"]);
    args.push(a.output.as_os_str().to_owned());
    args
}

/// The frame number of a `-progress` line (`frame=123`).
pub fn parse_progress(line: &str) -> Option<u64> {
    line.trim().strip_prefix("frame=").and_then(|n| n.trim().parse().ok())
}

/// A line of a child's output: `stream` is `stdout` or `stderr`.
pub type LineSink = Arc<dyn Fn(&'static str, String) + Send + Sync>;

/// Run `cmd` (piped, in its own process group) as job `job`, handing every output line to `on_line`; returns how it
/// ended once it has exited and its pipes are closed. A cancel (`VideoJobs::cancel`) kills its whole group.
pub fn run_streaming(mut cmd: Command, jobs: &VideoJobs, job: u64, on_line: LineSink) -> Result<Finished> {
    if jobs.cancelled_before_start(job) {
        return Ok(Finished { cancelled: true, ..Finished::default() });
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    in_own_group(&mut cmd);
    let mut child = cmd.spawn().ctx(format!("starting {}", cmd.get_program().to_string_lossy()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    jobs.adopt(job, child);
    let err_sink = on_line.clone();
    let err_reader = std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                err_sink("stderr", line);
            }
        }
    });
    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            on_line("stdout", line);
        }
    }
    let _ = err_reader.join();
    Ok(jobs.finish(job))
}

/// How an encode ended.
#[derive(Debug, PartialEq, Eq)]
pub enum EncodeOutcome {
    Done,
    Cancelled,
}

/// Run `program args` (FFmpeg writing `tmp`) as job `job`; on exit 0 rename `tmp` to `target`, otherwise delete `tmp`.
/// `on_progress` gets each `frame=` value. A cancel (`VideoJobs::cancel`) kills it: `Cancelled`, and no file is left.
pub fn run_encoder(
    program: &Path,
    args: &[OsString],
    tmp: &Path,
    target: &Path,
    jobs: &VideoJobs,
    job: u64,
    on_progress: impl Fn(u64) + Send + Sync + 'static,
) -> Result<EncodeOutcome> {
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let sink_tail = tail.clone();
    let sink: LineSink = Arc::new(move |stream, line| {
        if stream == "stdout" {
            if let Some(frame) = parse_progress(&line) {
                on_progress(frame);
            }
        } else if !line.trim().is_empty() {
            let mut tail = sink_tail.lock().expect("stderr tail lock");
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
    let mut cmd = Command::new(program);
    cmd.args(args);
    let finished = run_streaming(cmd, jobs, job, sink)?;
    if finished.code == Some(0) && !finished.cancelled && tmp.is_file() {
        fs::rename(tmp, target).ctx(format!("writing {}", target.display()))?;
        return Ok(EncodeOutcome::Done);
    }
    let _ = fs::remove_file(tmp);
    if finished.cancelled {
        return Ok(EncodeOutcome::Cancelled);
    }
    let errors = tail.lock().expect("stderr tail lock").iter().cloned().collect::<Vec<_>>().join("\n");
    let how = match (finished.code, finished.signal) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(s)) => format!("killed by signal {s}"),
        (None, None) => "killed".to_string(),
    };
    Err(Error::Invalid(if errors.is_empty() {
        format!("FFmpeg failed ({how})")
    } else {
        format!("FFmpeg failed ({how}): {errors}")
    }))
}

/// A video file name: one plain segment, not hidden, `.mp4`.
fn check_file_name(name: &str) -> Result<&str> {
    let mut parts = Path::new(name).components();
    let single = matches!((parts.next(), parts.next()), (Some(Component::Normal(_)), None));
    let ok = single
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && name.len() <= 128
        && Path::new(name).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    if ok {
        Ok(name)
    } else {
        Err(Error::Invalid(format!("Invalid video file name {name:?}")))
    }
}

/// The CLI arguments after the launcher's own.
fn cli_args(project_file: &Path, output: &str, out_dir: &Path, settings: &Path) -> Result<Vec<String>> {
    Ok(vec![
        "render-slideshow".to_string(),
        project_file.to_string_lossy().into_owned(),
        "--output".into(),
        check_id(output, "output id")?.to_string(),
        "--out".into(),
        out_dir.to_string_lossy().into_owned(),
        "--json".into(),
        "--env".into(),
        settings.to_string_lossy().into_owned(),
    ])
}

/// Run `render-slideshow` for slideshow `output` of project `project` into run `run`'s frame folder. Resolves when the
/// process has exited (after its `video:exit` event).
#[tauri::command]
pub async fn run_slideshow_frames<R: Runtime>(
    app: AppHandle<R>,
    job: u64,
    project: String,
    output: String,
    run: String,
) -> Result<()> {
    if app.state::<VideoJobs>().cancelled_before_start(job) {
        let _ = app.emit(EVENT_EXIT, ExitEvent { job, code: None, signal: None, cancelled: true });
        return Ok(());
    }
    let project_file = projects::project_file(&app, &project)?;
    if !project_file.is_file() {
        return Err(Error::Invalid(format!("{} not found", project_file.display())));
    }
    let out_dir = frames_dir(&project_file, &output, &run)?;
    sweep_stale_frames(&slideshow_dir(&project_file, &output)?, &out_dir, STALE_FRAMES);
    let settings = scope::app_data_dir(&app)?.join(SETTINGS_FILE_NAME);
    let (program, mut args, cwd) = cli_launcher()?;
    args.extend(cli_args(&project_file, &output, &out_dir, &settings)?);
    let mut cmd = Command::new(&program);
    cmd.args(&args).env("PATH", child_path()).env("FORCE_COLOR", "0");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    log::info!("[photobook:video] render-slideshow job {job} output {output} run {run}");
    let app2 = app.clone();
    let sink: LineSink = Arc::new(move |stream, line| {
        let _ = app2.emit(EVENT_LINE, LineEvent { job, stream, line });
    });
    let app3 = app.clone();
    let finished = tauri::async_runtime::spawn_blocking(move || {
        let jobs = app3.state::<VideoJobs>();
        run_streaming(cmd, &jobs, job, sink)
    })
    .await??;
    let Finished { code, signal, cancelled } = finished;
    let _ = app.emit(EVENT_EXIT, ExitEvent { job, code, signal, cancelled });
    Ok(())
}

/// What `slideshow_preflight` checks before any frame is rendered.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRequest {
    pub project: String,
    pub output: String,
    pub dest: String,
    pub file_name: String,
    #[serde(default)]
    pub audio_path: Option<String>,
    /// Frames the video will have, and their size.
    pub frames: u64,
    pub width: u32,
    pub height: u32,
}

/// What the preflight found (`SlideshowPreflight` in TS).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    /// The FFmpeg the encode will run.
    pub ffmpeg: String,
    /// `<dest>/<fileName>` exists: the sheet asks before replacing it.
    pub target_exists: bool,
    /// Disk the frames need, and what the project's volume has free (when known).
    pub needed_bytes: u64,
    pub free_bytes: Option<u64>,
}

/// Disk the frames of `frames` frames at `width` × `height` take, generously.
pub fn frames_bytes(frames: u64, width: u32, height: u32) -> u64 {
    let scale = (width as f64 * height as f64) / (1920.0 * 1080.0);
    (frames as f64 * FRAME_BYTES_1080P * scale).ceil() as u64
}

/// Free bytes on the volume holding `path` (or its nearest existing ancestor).
#[cfg(unix)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let existing = path.ancestors().find(|p| p.exists())?;
    let c = CString::new(existing.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is a valid NUL-terminated path and `stat` a zeroed out-parameter statvfs fills in.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(not(unix))]
pub fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// "1.2 GB".
fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

/// The audio track, checked: in the app data dir (where `import_audio` puts it) and still there.
fn checked_audio<R: Runtime>(app: &AppHandle<R>, path: Option<&str>) -> Result<Option<PathBuf>> {
    let Some(path) = path else { return Ok(None) };
    let path = ensure_allowed(app, path)?;
    if !path.is_file() {
        return Err(Error::Invalid(format!("The audio file {} is missing; choose it again", path.display())));
    }
    Ok(Some(path))
}

/// Check everything the export needs before rendering a frame; fails with a readable reason.
#[tauri::command]
pub async fn slideshow_preflight<R: Runtime>(app: AppHandle<R>, request: PreflightRequest) -> Result<Preflight> {
    let project_file = projects::project_file(&app, &request.project)?;
    let dir = slideshow_dir(&project_file, &request.output)?;
    let dest = PathBuf::from(check_export_dest(app.clone(), request.dest.clone()).await?);
    let name = check_file_name(&request.file_name)?.to_string();
    checked_audio(&app, request.audio_path.as_deref())?;
    let ffmpeg = tools::resolve_tool(&app, FFMPEG)?;
    let checked = {
        let ffmpeg = ffmpeg.clone();
        tauri::async_runtime::spawn_blocking(move || tools::check_ffmpeg(&ffmpeg)).await??
    };
    if !checked.h264 {
        return Err(Error::Invalid(format!(
            "The FFmpeg at {} has no {} encoder; download the one in Settings → Tools",
            checked.path, checked.encoder
        )));
    }
    let needed = frames_bytes(request.frames, request.width, request.height);
    let free = free_bytes(&dir);
    if let Some(free) = free {
        if free < needed {
            return Err(Error::Invalid(format!(
                "Not enough free disk space: the frames need about {} next to the project, and {} is free",
                gigabytes(needed),
                gigabytes(free)
            )));
        }
    }
    Ok(Preflight {
        ffmpeg: ffmpeg.to_string_lossy().into_owned(),
        target_exists: dest.join(&name).exists(),
        needed_bytes: needed,
        free_bytes: free,
    })
}

/// Whether `<dest>/<fileName>` exists (the sheet asks before replacing it).
#[tauri::command]
pub async fn video_target_exists<R: Runtime>(app: AppHandle<R>, dest: String, file_name: String) -> Result<bool> {
    let dest = PathBuf::from(check_export_dest(app, dest).await?);
    Ok(dest.join(check_file_name(&file_name)?).exists())
}

/// The request of one `encode_slideshow` call.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EncodeRequest {
    /// The open project's id.
    pub project: String,
    /// The slideshow's id.
    pub output: String,
    /// The export's run id (its frame folder).
    pub run: String,
    /// Destination folder (absolute), checked like an export's.
    pub dest: String,
    /// `<slug>.mp4`.
    pub file_name: String,
    /// The imported audio (`import_audio`), in the app data dir.
    #[serde(default)]
    pub audio_path: Option<String>,
    /// Video bitrate in bits per second (`SLIDESHOW_SIZES[size].bitrate`).
    pub bitrate: u64,
    /// Replace an existing `<dest>/<fileName>` (the sheet asked).
    #[serde(default)]
    pub replace: bool,
}

/// Encode run `request.run`'s frames of `request.output` to `<dest>/<fileName>`. Returns the video's path, or None
/// when cancelled (nothing is left then).
#[tauri::command]
pub async fn encode_slideshow<R: Runtime>(app: AppHandle<R>, job: u64, request: EncodeRequest) -> Result<Option<String>> {
    let project_file = projects::project_file(&app, &request.project)?;
    let dir = frames_dir(&project_file, &request.output, &request.run)?;
    let manifest = read_frames(&dir, &request.output)?;
    let dest = PathBuf::from(check_export_dest(app.clone(), request.dest.clone()).await?);
    fs::create_dir_all(&dest).ctx(format!("creating {}", dest.display()))?;
    let name = check_file_name(&request.file_name)?;
    let audio = checked_audio(&app, request.audio_path.as_deref())?;
    if !(500_000..=200_000_000).contains(&request.bitrate) {
        return Err(Error::Invalid(format!("Video bitrate {} is out of range", request.bitrate)));
    }
    let ffmpeg = tools::resolve_tool(&app, FFMPEG)?;
    let target = dest.join(name);
    if target.exists() && !request.replace {
        return Err(Error::Invalid(format!("{} already exists", target.display())));
    }
    sweep_stale_parts(&dest, name);
    let tmp = dest.join(format!(".{name}.{}.part", std::process::id()));
    let args = ffmpeg_args(&EncodeArgs {
        frames_dir: &dir,
        manifest: &manifest,
        audio: audio.as_deref(),
        bitrate: request.bitrate,
        encoder: H264_ENCODER,
        output: &tmp,
    });
    log::info!(
        "[photobook:video] encode job {job}: {} frames {}x{} -> {}",
        manifest.frames,
        manifest.width,
        manifest.height,
        target.display()
    );
    let total = manifest.frames;
    let app2 = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let jobs = app2.state::<VideoJobs>();
        let app3 = app2.clone();
        run_encoder(&ffmpeg, &args, &tmp, &target, &jobs, job, move |frame| {
            let _ = app3.emit(EVENT_PROGRESS, ProgressEvent { job, frame, total });
        })
        .map(|o| (o, target))
    })
    .await??;
    Ok(match outcome {
        (EncodeOutcome::Done, target) => Some(target.to_string_lossy().into_owned()),
        (EncodeOutcome::Cancelled, _) => None,
    })
}

/// Kill job `job` (frames or encode) and what it started; one that has not started yet never starts.
#[tauri::command]
pub async fn cancel_video<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<()> {
    app.state::<VideoJobs>().cancel(job);
    Ok(())
}

/// Delete run `run`'s frames of slideshow `output` (after the encode, or when the export stopped).
#[tauri::command]
pub async fn discard_slideshow_frames<R: Runtime>(
    app: AppHandle<R>,
    project: String,
    output: String,
    run: String,
) -> Result<()> {
    let project_file = projects::project_file(&app, &project)?;
    let dir = frames_dir(&project_file, &output, &run)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).ctx(format!("removing {}", dir.display()))?;
    }
    Ok(())
}

/// An imported audio track (`AudioFile` in TS).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    /// `<appdata>/audio/<sha256>.<ext>`.
    pub path: String,
    /// The file name it was picked as.
    pub name: String,
}

/// Copy an audio file picked in the native dialog (or inside an imported folder) to `<appdata>/audio/<sha256>.<ext>`.
#[tauri::command]
pub async fn import_audio<R: Runtime>(app: AppHandle<R>, path: String) -> Result<AudioFile> {
    let src = PathBuf::from(check_export_dest(app.clone(), path.clone()).await?);
    let dir = ensure_allowed(&app, app_data_dir(&app)?.join(AUDIO_DIR))?;
    let file = tauri::async_runtime::spawn_blocking(move || import_audio_into(&dir, &src)).await??;
    log::info!("[photobook:video] imported audio {} as {}", file.name, file.path);
    Ok(file)
}

pub fn import_audio_into(dir: &Path, src: &Path) -> Result<AudioFile> {
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("audio").to_string();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| AUDIO_EXTENSIONS.contains(&e.as_str()))
        .ok_or_else(|| Error::Invalid(format!("{name} is not an audio file this can use ({})", AUDIO_EXTENSIONS.join(", "))))?;
    if !src.is_file() {
        return Err(Error::Invalid(format!("{} not found", src.display())));
    }
    let (sha, _) = file_sha256(src)?;
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    let target = dir.join(format!("{sha}.{ext}"));
    if !target.is_file() {
        let tmp = dir.join(format!(".{sha}.{ext}.part"));
        fs::copy(src, &tmp).ctx(format!("copying {}", src.display()))?;
        fs::rename(&tmp, &target).ctx(format!("writing {}", target.display()))?;
    }
    Ok(AudioFile { path: target.to_string_lossy().into_owned(), name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn manifest(slides: u32, seconds_per_slide: u32, fps: u32) -> FramesManifest {
        let frames = (slides * seconds_per_slide * fps) as u64;
        FramesManifest {
            version: 1,
            output: "01OUTPUT".into(),
            fps,
            width: 1920,
            height: 1080,
            frames,
            slides,
            seconds: frames as f64 / fps as f64,
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let i = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{flag} missing"));
        &args[i + 1]
    }

    #[test]
    fn the_command_line_encodes_slides_times_seconds_times_fps_frames() {
        let m = manifest(12, 4, 30);
        let (dir, out) = (PathBuf::from("/p/.photobook-publish/slideshow/01OUTPUT"), PathBuf::from("/d/.trip.mp4.1.part"));
        let args = strings(&ffmpeg_args(&EncodeArgs {
            frames_dir: &dir,
            manifest: &m,
            audio: None,
            bitrate: 12_000_000,
            encoder: "h264_videotoolbox",
            output: &out,
        }));
        assert_eq!(after(&args, "-frames:v"), (12 * 4 * 30).to_string());
        assert_eq!(after(&args, "-framerate"), "30");
        assert_eq!(after(&args, "-r"), "30");
        assert_eq!(after(&args, "-i"), "/p/.photobook-publish/slideshow/01OUTPUT/%06d.jpg");
        assert_eq!(after(&args, "-start_number"), "1");
        assert_eq!(after(&args, "-t"), "48.000");
        assert_eq!(after(&args, "-c:v"), "h264_videotoolbox");
        assert_eq!(after(&args, "-b:v"), "12000000");
        assert!(after(&args, "-vf").contains("format=yuv420p"));
        assert_eq!(after(&args, "-f"), "mp4");
        assert_eq!(args.last().unwrap(), "/d/.trip.mp4.1.part");
        assert!(!args.iter().any(|a| a == "-c:a" || a == "-shortest"));
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 1);
    }

    #[test]
    fn audio_is_mapped_cut_to_the_video_and_faded_out() {
        let m = manifest(3, 2, 30);
        let (dir, out, audio) = (PathBuf::from("/f"), PathBuf::from("/o.part"), PathBuf::from("/a/song.m4a"));
        let args = strings(&ffmpeg_args(&EncodeArgs {
            frames_dir: &dir,
            manifest: &m,
            audio: Some(&audio),
            bitrate: 8_000_000,
            encoder: "libx264",
            output: &out,
        }));
        assert_eq!(args.iter().filter(|a| *a == "-i").count(), 2);
        assert!(args.windows(2).any(|w| w == ["-i", "/a/song.m4a"]));
        assert!(args.windows(2).any(|w| w == ["-map", "1:a:0"]));
        assert_eq!(after(&args, "-c:a"), "aac");
        assert_eq!(after(&args, "-af"), "afade=t=out:st=4.500:d=1.5");
        assert_eq!(after(&args, "-t"), "6.000");
        assert_eq!(after(&args, "-frames:v"), "180");
        assert!(!args.iter().any(|a| a == "-allow_sw"), "VideoToolbox only");
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress("frame=123"), Some(123));
        assert_eq!(parse_progress("frame= 7"), Some(7));
        assert_eq!(parse_progress("fps=30.0"), None);
        assert_eq!(parse_progress("progress=end"), None);
    }

    #[test]
    fn checks_names_ids_and_the_frames_manifest() {
        assert!(check_file_name("summer-trip.mp4").is_ok());
        for bad in ["", ".hidden.mp4", "a/b.mp4", "../x.mp4", "trip.mov", "trip"] {
            assert!(check_file_name(bad).is_err(), "{bad:?}");
        }
        assert!(frames_dir(Path::new("/p/project.photobook.json"), "../x", "r1").is_err());
        assert!(frames_dir(Path::new("/p/project.photobook.json"), "01OUT", "../r").is_err());
        assert_eq!(
            frames_dir(Path::new("/p/project.photobook.json"), "01OUT", "r1").unwrap(),
            PathBuf::from("/p/.photobook-publish/slideshow/01OUT/frames-r1")
        );

        let dir = tempfile::tempdir().unwrap();
        assert!(read_frames(dir.path(), "01OUTPUT").is_err(), "no manifest yet");
        let m = manifest(2, 1, 30);
        let json = format!(
            r#"{{"version":1,"output":"01OUTPUT","fps":30,"width":1920,"height":1080,"frames":{},"slides":2,"seconds":2}}"#,
            m.frames
        );
        fs::write(dir.path().join(FRAMES_MANIFEST), json).unwrap();
        assert!(read_frames(dir.path(), "01OUTPUT").is_err(), "frames missing");
        fs::write(dir.path().join(frame_name(m.frames - 1)), b"jpg").unwrap();
        assert_eq!(read_frames(dir.path(), "01OUTPUT").unwrap(), m);
        assert!(read_frames(dir.path(), "01OTHER").is_err(), "another slideshow's frames");
    }

    /// A stand-in FFmpeg: writes its last argument (the output), prints progress, then sleeps or exits.
    fn fake_ffmpeg(dir: &Path, tail: &str) -> PathBuf {
        let path = dir.join("ffmpeg");
        let script = format!(
            "#!/bin/sh\nfor a in \"$@\"; do last=\"$a\"; done\necho partial > \"$last\"\necho frame=1\necho frame=2\n{tail}\n"
        );
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn a_finished_encode_is_renamed_into_place() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_ffmpeg(dir.path(), "exit 0");
        let (tmp, target) = (dir.path().join(".trip.mp4.1.part"), dir.path().join("trip.mp4"));
        let frames = Arc::new(Mutex::new(Vec::new()));
        let seen = frames.clone();
        let outcome = run_encoder(&program, &[tmp.clone().into_os_string()], &tmp, &target, &VideoJobs::default(), 1, move |f| {
            seen.lock().unwrap().push(f)
        })
        .unwrap();
        assert_eq!(outcome, EncodeOutcome::Done);
        assert_eq!(*frames.lock().unwrap(), [1, 2]);
        assert!(target.is_file() && !tmp.exists());
    }

    #[test]
    fn a_failed_encode_leaves_no_file_and_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_ffmpeg(dir.path(), "echo 'Unknown encoder h264_videotoolbox' >&2\nexit 1");
        let (tmp, target) = (dir.path().join(".trip.mp4.1.part"), dir.path().join("trip.mp4"));
        let err = run_encoder(&program, &[tmp.clone().into_os_string()], &tmp, &target, &VideoJobs::default(), 1, |_| {})
            .unwrap_err();
        assert!(err.to_string().contains("Unknown encoder"), "{err}");
        assert!(!tmp.exists() && !target.exists());
    }

    #[test]
    fn cancel_kills_the_encoder_and_leaves_no_partial_file() {
        let dir = tempfile::tempdir().unwrap();
        // `exec`: one process, like FFmpeg (a child of the shell would keep the pipes open after the kill).
        let program = fake_ffmpeg(dir.path(), "exec sleep 30");
        let (tmp, target) = (dir.path().join(".trip.mp4.7.part"), dir.path().join("trip.mp4"));
        let jobs = Arc::new(VideoJobs::default());
        let runner = {
            let (jobs, tmp, target, program) = (jobs.clone(), tmp.clone(), target.clone(), program.clone());
            std::thread::spawn(move || run_encoder(&program, &[tmp.clone().into_os_string()], &tmp, &target, &jobs, 7, |_| {}))
        };
        // Wait until the encoder has started writing.
        let started = Instant::now();
        while !tmp.exists() {
            assert!(started.elapsed() < Duration::from_secs(10), "the fake encoder never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        jobs.cancel(7);
        let outcome = runner.join().unwrap().unwrap();
        assert_eq!(outcome, EncodeOutcome::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(10), "killed, not waited for");
        assert!(!tmp.exists(), "the partial file is deleted");
        assert!(!target.exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "only the fake ffmpeg is left");

        // A cancel before the start: it never runs.
        jobs.cancel(8);
        let outcome = run_encoder(&program, &[tmp.clone().into_os_string()], &tmp, &target, &jobs, 8, |_| {}).unwrap();
        assert_eq!(outcome, EncodeOutcome::Cancelled);
        assert!(!tmp.exists());
    }

    /// With an FFmpeg on PATH (e.g. Homebrew's; skipped otherwise): 2 slides × 1 s × 30 fps of test frames and a
    /// test tone encode to an MP4 with exactly 60 H.264 frames, 2 s long, in yuv420p BT.709.
    #[test]
    fn encodes_real_frames_with_an_ffmpeg_on_path() {
        let Some(ffmpeg) = tools::find_on_path("ffmpeg", &child_path()) else {
            eprintln!("no ffmpeg on PATH: skipped");
            return;
        };
        let Some(ffprobe) = tools::find_on_path("ffprobe", &child_path()) else { return };
        let dir = tempfile::tempdir().unwrap();
        let frames = dir.path().join("frames");
        fs::create_dir_all(&frames).unwrap();
        let make = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-frames:v", "60", "-q:v", "3"])
            .arg(frames.join("%06d.jpg"))
            .status()
            .unwrap();
        assert!(make.success());
        let tone = dir.path().join("tone.m4a");
        let make = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "aac"])
            .arg(&tone)
            .status()
            .unwrap();
        assert!(make.success());
        let m = FramesManifest { width: 320, height: 180, ..manifest(2, 1, 30) };
        let (tmp, target) = (dir.path().join(".v.mp4.1.part"), dir.path().join("v.mp4"));
        let args = ffmpeg_args(&EncodeArgs {
            frames_dir: &frames,
            manifest: &m,
            audio: Some(&tone),
            bitrate: 2_000_000,
            encoder: H264_ENCODER,
            output: &tmp,
        });
        let last = Arc::new(Mutex::new(0));
        let seen = last.clone();
        let outcome =
            run_encoder(&ffmpeg, &args, &tmp, &target, &VideoJobs::default(), 1, move |f| *seen.lock().unwrap() = f).unwrap();
        assert_eq!(outcome, EncodeOutcome::Done);
        assert_eq!(*last.lock().unwrap(), 60);
        let probe = Command::new(&ffprobe)
            .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries"])
            .arg("stream=codec_name,nb_read_frames,pix_fmt,color_space,color_transfer,color_primaries,profile:format=duration")
            .args(["-of", "default=noprint_wrappers=1"])
            .arg(&target)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&probe.stdout);
        assert!(text.contains("codec_name=h264"), "{text}");
        assert!(text.contains("nb_read_frames=60"), "{text}");
        assert!(text.contains("pix_fmt=yuv420p"), "{text}");
        assert!(text.contains("color_space=bt709"), "{text}");
        assert!(text.contains("color_transfer=bt709"), "{text}");
        assert!(text.contains("color_primaries=bt709"), "{text}");
        let duration: f64 = text.lines().find_map(|l| l.strip_prefix("duration=")).unwrap().parse().unwrap();
        assert!((duration - 2.0).abs() < 0.1, "{text}");
    }

    /// A stand-in for the CLI (`tsx` → Node → Chromium): prints a line, starts a grandchild that keeps the pipes open
    /// and writes "frames" (its pid in `pid`), then runs `tail`.
    fn fake_cli(dir: &Path, tail: &str) -> PathBuf {
        let path = dir.join("cli");
        let pid = dir.join("pid");
        let frames = dir.join("frames");
        let script = format!(
            "#!/bin/sh\necho '{{\"type\":\"progress\",\"step\":\"slideshow\",\"done\":1,\"total\":90}}'\n\
             (while true; do echo x >> '{}'; sleep 0.05; done) &\necho $! > '{}'\n{tail}\n",
            frames.display(),
            pid.display()
        );
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn alive(pid: &str) -> bool {
        Command::new("/bin/kill").args(["-0", pid.trim()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
    }

    fn collect() -> (LineSink, Arc<Mutex<Vec<(String, String)>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink_lines = lines.clone();
        let sink: LineSink = Arc::new(move |stream, line| sink_lines.lock().unwrap().push((stream.to_string(), line)));
        (sink, lines)
    }

    #[test]
    fn the_frames_job_streams_the_cli_and_reports_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "kill $(cat pid)\necho done >&2\nexit 3");
        let (sink, lines) = collect();
        let mut cmd = Command::new(&cli);
        cmd.current_dir(dir.path());
        let finished = run_streaming(cmd, &VideoJobs::default(), 1, sink).unwrap();
        assert_eq!(finished, Finished { code: Some(3), signal: None, cancelled: false });
        let lines = lines.lock().unwrap();
        assert!(lines.iter().any(|(s, l)| s == "stdout" && l.contains("\"slideshow\"")));
        assert!(lines.iter().any(|(s, l)| s == "stderr" && l == "done"));
    }

    #[test]
    fn cancelling_the_frames_job_kills_the_cli_and_what_it_started() {
        let dir = tempfile::tempdir().unwrap();
        // The CLI waits for its grandchild, which would write forever and keep the pipes open.
        let cli = fake_cli(dir.path(), "wait");
        let jobs = Arc::new(VideoJobs::default());
        let runner = {
            let (jobs, cli) = (jobs.clone(), cli.clone());
            std::thread::spawn(move || run_streaming(Command::new(&cli), &jobs, 5, collect().0))
        };
        let pid_file = dir.path().join("pid");
        let started = Instant::now();
        while fs::read_to_string(&pid_file).map_or(true, |p| p.trim().is_empty()) {
            assert!(started.elapsed() < Duration::from_secs(10), "the fake CLI never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild = fs::read_to_string(&pid_file).unwrap();
        assert!(alive(&grandchild));
        jobs.cancel(5);
        let finished = runner.join().unwrap().unwrap();
        assert!(finished.cancelled, "{finished:?}");
        assert_eq!(finished.code, None);
        assert!(started.elapsed() < Duration::from_secs(10), "the pipes closed: the grandchild died too");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!alive(&grandchild), "the grandchild is killed with the group");
        let frames = fs::metadata(dir.path().join("frames")).map(|m| m.len()).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fs::metadata(dir.path().join("frames")).map(|m| m.len()).unwrap_or(0), frames, "nothing writes on");
    }

    #[test]
    fn a_cli_killed_by_a_signal_it_was_not_sent_is_not_a_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "kill $(cat pid)\nkill -9 $$");
        let mut cmd = Command::new(&cli);
        cmd.current_dir(dir.path());
        let finished = run_streaming(cmd, &VideoJobs::default(), 1, collect().0).unwrap();
        assert_eq!(finished, Finished { code: None, signal: Some(9), cancelled: false });
    }

    #[test]
    fn a_frames_job_cancelled_before_it_starts_never_runs() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "exit 0");
        let jobs = VideoJobs::default();
        jobs.cancel(9);
        let finished = run_streaming(Command::new(&cli), &jobs, 9, collect().0).unwrap();
        assert!(finished.cancelled);
        assert!(!dir.path().join("pid").exists(), "never started");
    }

    #[test]
    fn builds_the_cli_arguments_with_the_run_folder() {
        let args = cli_args(
            Path::new("/p/project.photobook.json"),
            "01OUT",
            Path::new("/p/.photobook-publish/slideshow/01OUT/frames-r1"),
            Path::new("/a/publish.env"),
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "render-slideshow",
                "/p/project.photobook.json",
                "--output",
                "01OUT",
                "--out",
                "/p/.photobook-publish/slideshow/01OUT/frames-r1",
                "--json",
                "--env",
                "/a/publish.env"
            ]
        );
        assert!(cli_args(Path::new("/p/x.json"), "a/b", Path::new("/o"), Path::new("/e")).is_err());
    }

    #[test]
    fn escapes_percent_in_the_frame_pattern() {
        assert_eq!(frames_pattern(Path::new("/a/100% b/f")), OsString::from("/a/100%% b/f/%06d.jpg"));
    }

    #[test]
    fn estimates_the_frames_disk_and_reads_free_space() {
        assert_eq!(frames_bytes(2400, 1920, 1080), 3_600_000_000);
        assert_eq!(frames_bytes(100, 3840, 2160), 4 * frames_bytes(100, 1920, 1080));
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(&dir.path().join("not/yet/there")).is_some_and(|b| b > 0));
    }

    #[test]
    fn sweeps_stale_frame_folders_and_part_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let (keep, old, other) = (dir.path().join("frames-a"), dir.path().join("frames-b"), dir.path().join("notes"));
        for d in [&keep, &old, &other] {
            fs::create_dir_all(d).unwrap();
        }
        sweep_stale_frames(dir.path(), &keep, Duration::from_secs(3600));
        assert!(old.exists(), "fresh: another run may be using it");
        sweep_stale_frames(dir.path(), &keep, Duration::ZERO);
        assert!(keep.exists() && !old.exists() && other.exists());

        let mine = format!(".trip.mp4.{}.part", std::process::id());
        for f in [mine.as_str(), ".trip.mp4.1.part", ".other.mp4.1.part", "trip.mp4"] {
            fs::write(dir.path().join(f), b"x").unwrap();
        }
        sweep_stale_parts(dir.path(), "trip.mp4");
        assert!(dir.path().join(&mine).exists());
        assert!(!dir.path().join(".trip.mp4.1.part").exists());
        assert!(dir.path().join(".other.mp4.1.part").exists() && dir.path().join("trip.mp4").exists());
    }

    #[test]
    fn imports_audio_by_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Song.M4A");
        fs::write(&src, b"audio bytes").unwrap();
        let store = dir.path().join("audio");
        let file = import_audio_into(&store, &src).unwrap();
        assert_eq!(file.name, "Song.M4A");
        assert!(file.path.ends_with(".m4a"));
        assert_eq!(fs::read(&file.path).unwrap(), b"audio bytes");
        assert_eq!(import_audio_into(&store, &src).unwrap(), file, "same bytes, same file");
        let text = dir.path().join("notes.txt");
        fs::write(&text, b"x").unwrap();
        assert!(import_audio_into(&store, &text).is_err());
    }
}
