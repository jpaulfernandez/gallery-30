//! The model downloader: one blocking HTTP client (`reqwest`, rustls), files streamed into `<file>.part` while
//! being hashed, `Range` resume from the part's length (the part is re-hashed first, so a resumed file is verified
//! end to end), SHA-256 checked against the manifest, then an atomic rename into `<root>/<name>/<version>/`.
//!
//! Blocking by design: callers run it on a worker thread (`spawn_blocking` in the editor). Cancellation is polled
//! between chunks and leaves the part in place for the next attempt.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};

use super::{Error, ModelDir, ModelEntry, ModelFile, Result};

/// Bytes of the whole model received so far (finished files, the verified part and the current transfer) out of
/// the manifest's total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
}

const CHUNK: usize = 256 * 1024;
const USER_AGENT: &str = concat!("Photobook/", env!("CARGO_PKG_VERSION"), " (model downloader)");

fn client() -> Result<&'static Client> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let c = Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        // Model files take minutes on a slow line: no overall timeout. Dead connections are found by keep-alive.
        .timeout(None::<Duration>)
        .tcp_keepalive(Duration::from_secs(20))
        // HTTP/2's default 64 KB flow-control window caps a single stream well below the line speed on the CDN.
        .http2_adaptive_window(true)
        .build()
        .map_err(|e| Error::Network(e.to_string()))?;
    Ok(CLIENT.get_or_init(|| c))
}

/// Download every file of `entry` into `dir`, resuming partial files, and return the ONNX graph's path. Already
/// installed files are skipped (they were verified before being renamed into place). Older versions of the same
/// model are removed once this one is complete.
///
/// Errors: [`Error::Offline`] (DNS or connect failure), [`Error::Network`] (dropped mid-transfer; the part is
/// kept), [`Error::HashMismatch`] / [`Error::SizeMismatch`] (the part is removed), [`Error::Cancelled`] (the part
/// is kept), [`Error::Http`], [`Error::Unverified`] (no pinned hash).
pub fn download_model(
    entry: &ModelEntry,
    dir: &ModelDir,
    progress: &dyn Fn(Progress),
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    if !entry.downloadable() {
        return Err(Error::Unverified(entry.name.clone()));
    }
    let version_dir = dir.version_dir(entry);
    fs::create_dir_all(&version_dir)?;
    let total = entry.total_bytes();
    let mut done = 0;
    for file in &entry.files {
        let report = |received: u64| progress(Progress { received: done + received, total });
        fetch_file(file, &dir.file_path(entry, file), &dir.part_path(entry, file), &report, cancel)?;
        done += file.bytes;
    }
    progress(Progress { received: total, total });
    prune_other_versions(entry, dir);
    Ok(dir.primary_path(entry))
}

/// Remove every version of `entry` (files, partial downloads, the CoreML cache). Returns the bytes freed.
pub fn delete_model(entry: &ModelEntry, dir: &ModelDir) -> Result<u64> {
    let root = dir.model_root(entry);
    let freed = super::disk_usage(&root);
    match fs::remove_dir_all(&root) {
        Ok(()) => Ok(freed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
    }
}

fn prune_other_versions(entry: &ModelEntry, dir: &ModelDir) {
    let Ok(read) = fs::read_dir(dir.model_root(entry)) else { return };
    for e in read.flatten() {
        if e.file_name() != entry.version.as_str() && e.path().is_dir() {
            if let Err(err) = fs::remove_dir_all(e.path()) {
                log::warn!("[photobook:models] could not remove {}: {err}", e.path().display());
            }
        }
    }
}

/// One file: skip if installed, else resume or start `<file>.part`, verify, rename.
fn fetch_file(
    file: &ModelFile,
    final_path: &Path,
    part_path: &Path,
    report: &dyn Fn(u64),
    cancel: &AtomicBool,
) -> Result<()> {
    if fs::metadata(final_path).is_ok_and(|m| m.is_file() && m.len() == file.bytes) {
        report(file.bytes);
        return Ok(());
    }
    // Two rounds at most: the second starts from scratch when the server ignored or rejected our Range.
    for _ in 0..2 {
        let (mut hasher, mut have) = rehash_part(part_path, file.bytes, cancel)?;
        report(have);
        if have < file.bytes {
            let mut request = client()?.get(&file.url);
            if have > 0 {
                request = request.header(RANGE, format!("bytes={have}-"));
            }
            let mut response = request.send().map_err(|e| request_error(e, &file.url))?;
            let status = response.status();
            let append = match status {
                StatusCode::PARTIAL_CONTENT if have > 0 => {
                    if range_start(&response) != Some(have) {
                        log::warn!("[photobook:models] {}: unexpected Content-Range, restarting", file.path);
                        fs::remove_file(part_path)?;
                        continue;
                    }
                    true
                }
                StatusCode::OK => {
                    if have > 0 {
                        log::info!("[photobook:models] {}: server ignored the Range header, restarting", file.path);
                        hasher = Sha256::new();
                        have = 0;
                        report(0);
                    }
                    false
                }
                StatusCode::RANGE_NOT_SATISFIABLE if have > 0 => {
                    fs::remove_file(part_path)?;
                    continue;
                }
                _ => return Err(Error::Http { status: status.as_u16(), url: file.url.clone() }),
            };
            let mut out = if append {
                OpenOptions::new().append(true).open(part_path)?
            } else {
                File::create(part_path)?
            };
            let mut buf = vec![0u8; CHUNK];
            loop {
                if cancel.load(Ordering::Relaxed) {
                    out.flush()?;
                    return Err(Error::Cancelled);
                }
                let n = match response.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        out.flush()?;
                        return Err(Error::Network(format!("{}: {e}", file.path)));
                    }
                };
                if have + n as u64 > file.bytes {
                    drop(out);
                    let _ = fs::remove_file(part_path);
                    return Err(Error::SizeMismatch {
                        file: file.path.clone(),
                        expected: file.bytes,
                        actual: have + n as u64,
                    });
                }
                out.write_all(&buf[..n])?;
                hasher.update(&buf[..n]);
                have += n as u64;
                report(have);
            }
            out.sync_all()?;
            if have < file.bytes {
                // The body ended early without an error: keep what we have for the next attempt.
                return Err(Error::Network(format!(
                    "{}: connection closed after {have} of {} bytes",
                    file.path, file.bytes
                )));
            }
        }
        let actual = hex::encode(hasher.finalize());
        if actual != file.sha256 {
            let _ = fs::remove_file(part_path);
            return Err(Error::HashMismatch { file: file.path.clone(), expected: file.sha256.clone(), actual });
        }
        fs::rename(part_path, final_path)?;
        return Ok(());
    }
    Err(Error::Network(format!("{}: the server does not honour range requests", file.path)))
}

/// Hash the existing part (if any) so a resumed download is verified as a whole. A part longer than the file is
/// discarded.
fn rehash_part(part_path: &Path, expected: u64, cancel: &AtomicBool) -> Result<(Sha256, u64)> {
    let mut hasher = Sha256::new();
    let mut part = match File::open(part_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((hasher, 0)),
        Err(e) => return Err(e.into()),
    };
    if part.metadata()?.len() > expected {
        drop(part);
        fs::remove_file(part_path)?;
        return Ok((hasher, 0));
    }
    let mut have = 0;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let n = part.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        have += n as u64;
    }
    Ok((hasher, have))
}

/// Start offset of a `Content-Range: bytes <start>-<end>/<total>` header.
fn range_start(response: &reqwest::blocking::Response) -> Option<u64> {
    let value = response.headers().get(CONTENT_RANGE)?.to_str().ok()?;
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    rest.split('-').next()?.trim().parse().ok()
}

fn request_error(err: reqwest::Error, url: &str) -> Error {
    if err.is_connect() {
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| url.to_owned());
        // reqwest's top-level message is generic ("error sending request"); the source says why.
        let mut message = err.to_string();
        let mut source = std::error::Error::source(&err);
        while let Some(s) = source {
            message = s.to_string();
            source = s.source();
        }
        Error::Offline { host, message }
    } else {
        Error::Network(err.to_string())
    }
}
