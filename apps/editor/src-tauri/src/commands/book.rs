//! Project file and recent-folder commands.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::error::{Error, IoContext, Result};
use crate::scope::{self, ensure_allowed};

pub const BOOK_FILE_NAME: &str = "book.photobook.json";
/// The previous version of the project file, kept next to it (exactly one, overwritten on each save).
pub const BACKUP_FILE_NAME: &str = "book.photobook.json.bak";
const RECENT_FILE_NAME: &str = "recent.json";

#[derive(Serialize, Deserialize)]
struct Recent {
    folder: String,
}

/// Open the book in `folder`: returns the raw project file text, or `None` when the folder has
/// no project file yet. Also makes `folder` the source root for every later command.
#[tauri::command]
pub async fn open_book<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Option<String>> {
    let recent = read_recent(&app);
    let root = scope::set_source_root(&app, &folder, recent.as_deref())?;
    let file = ensure_allowed(&app, root.join(BOOK_FILE_NAME))?;
    if !file.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&file).ctx(format!("reading {}", file.display())).map(Some)
}

/// Replace `<folder>/book.photobook.json` atomically: write a temp file in the same folder,
/// flush it to disk, then rename it over the project file. The version being replaced is kept as
/// `book.photobook.json.bak` (see `write_with_backup`).
#[tauri::command]
pub async fn write_book<R: Runtime>(app: AppHandle<R>, folder: String, json: String) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|err| Error::Invalid(format!("Refusing to write invalid JSON: {err}")))?;
    let file = scope::ensure_source_root(&app, &folder)?.join(BOOK_FILE_NAME);
    write_with_backup(&file, json.as_bytes())
}

/// `atomic_write` that first preserves the current `target` as `<target>.bak`, overwriting the
/// previous backup. The backup is a hard link to the old file (a copy where links are not
/// supported), swapped in with a rename, so `target` and the backup both exist at every instant and
/// the later rename over `target` leaves the backup holding the old bytes. A failed backup never
/// blocks the save of the new version.
fn write_with_backup(target: &Path, bytes: &[u8]) -> Result<()> {
    if target.is_file() {
        let _ = backup(target);
    }
    atomic_write(target, bytes)
}

fn backup(target: &Path) -> std::io::Result<()> {
    let bak = backup_path(target);
    let bak_name = bak.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let tmp = bak.with_file_name(format!(".{bak_name}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let linked = fs::hard_link(target, &tmp).or_else(|_| fs::copy(target, &tmp).map(|_| ()));
    linked.and_then(|()| fs::rename(&tmp, &bak)).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn backup_path(target: &Path) -> PathBuf {
    target.with_file_name(BACKUP_FILE_NAME)
}

/// The last opened folder, if it still exists.
#[tauri::command]
pub async fn get_recent<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>> {
    Ok(read_recent(&app)
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Remember `folder` (must be the open book's folder) as the last opened book.
#[tauri::command]
pub async fn set_recent<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<()> {
    let folder = scope::ensure_source_root(&app, &folder)?;
    let file = scope::app_data_dir(&app)?.join(RECENT_FILE_NAME);
    let json = serde_json::to_vec_pretty(&Recent { folder: folder.to_string_lossy().into_owned() })
        .map_err(|err| Error::Invalid(err.to_string()))?;
    atomic_write(&file, &json)
}

fn read_recent<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let file = scope::app_data_dir(app).ok()?.join(RECENT_FILE_NAME);
    let text = fs::read_to_string(file).ok()?;
    let recent: Recent = serde_json::from_str(&text).ok()?;
    Some(PathBuf::from(recent.folder))
}

pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    let dir = target
        .parent()
        .ok_or_else(|| Error::Invalid(format!("{} has no parent folder", target.display())))?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));

    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, target)
    };
    write().map_err(|err| {
        let _ = fs::remove_file(&tmp);
        Error::Io(format!("writing {}", target.display()), err)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(BOOK_FILE_NAME);
        atomic_write(&target, b"{\"version\":1}").unwrap();
        atomic_write(&target, b"{\"version\":1,\"x\":2}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"version\":1,\"x\":2}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_keeps_exactly_one_backup_of_the_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(BOOK_FILE_NAME);
        let bak = dir.path().join(BACKUP_FILE_NAME);
        assert_eq!(backup_path(&target), bak);

        write_with_backup(&target, b"{\"n\":1}").unwrap();
        assert!(!bak.exists(), "nothing to back up on the first save");

        write_with_backup(&target, b"{\"n\":2}").unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{\"n\":1}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"n\":2}");

        write_with_backup(&target, b"{\"n\":3}").unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), "{\"n\":2}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"n\":3}");

        // Only the project file and its backup: no temp files left behind.
        let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, vec![BOOK_FILE_NAME, BACKUP_FILE_NAME]);
    }
}
