//! Per-folder library file (workflow plan 02): `<folder>/.photobook/library.json`, the ratings, flags and develop
//! settings of the folder's photos keyed by content hash (the shape is `LibrarySchema` in
//! `packages/shared/src/library.ts`; Rust only checks that it is a JSON object).
//!
//! - `read_library(folder)` returns the file's text, or `None` when the folder has no library yet. A file that is not
//!   valid JSON is moved aside to `library.json.corrupt` (logged as a `[photobook:library]` line). When the file is
//!   missing or was moved aside, the previous version, `library.json.bak`, is used if it is a JSON object: it is
//!   written back as `library.json` (so the recovery survives the next open) and returned; otherwise `None`.
//! - `read_library_backup(folder)` returns `library.json.bak` when it is a JSON object. The editor falls back to it
//!   when `library.json` is valid JSON but fails the schema (`parseLibrary` in TS).
//! - `write_library(folder, json)` creates `.photobook/` and replaces the file atomically (temp file + rename), the
//!   version being replaced kept as `library.json.bak`, exactly like `write_project`.
//!
//! `folder` must be an imported folder (`scope::ensure_imported_root`). One app instance at a time; no locking.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};

use crate::atomic::{backup_path, write_with_backup};
use crate::error::{Error, IoContext, Result};
use crate::scope;

/// The hidden folder the library lives in, next to the photos.
pub const LIBRARY_DIR: &str = ".photobook";
pub const LIBRARY_FILE_NAME: &str = "library.json";
const CORRUPT_SUFFIX: &str = "corrupt";

#[tauri::command]
pub async fn read_library<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Option<String>> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    // The resolved path must still be inside the folder (`.photobook` could be a link pointing elsewhere).
    let file = scope::ensure_allowed(&app, library_path(&root))?;
    read_file(&file)
}

#[tauri::command]
pub async fn read_library_backup<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<Option<String>> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    let file = scope::ensure_allowed(&app, library_path(&root))?;
    Ok(read_backup(&file))
}

#[tauri::command]
pub async fn write_library<R: Runtime>(app: AppHandle<R>, folder: String, json: String) -> Result<()> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    let dir = root.join(LIBRARY_DIR);
    fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    let file = scope::ensure_allowed(&app, dir.join(LIBRARY_FILE_NAME))?;
    write_file(&file, &json)
}

/// `<root>/.photobook/library.json`.
pub fn library_path(root: &Path) -> PathBuf {
    root.join(LIBRARY_DIR).join(LIBRARY_FILE_NAME)
}

/// The library text at `file`, falling back to its `.bak` when the file is missing or not valid JSON (see the module
/// doc). A text recovered from the backup is written back to `file`.
fn read_file(file: &Path) -> Result<Option<String>> {
    if file.is_file() {
        let text = fs::read_to_string(file).ctx(format!("reading {}", file.display()))?;
        if is_json_object(&text) {
            return Ok(Some(text));
        }
        let aside = file.with_file_name(format!("{LIBRARY_FILE_NAME}.{CORRUPT_SUFFIX}"));
        match fs::rename(file, &aside) {
            Ok(()) => log::info!("[photobook:library] {} is not valid JSON, moved to {}", file.display(), aside.display()),
            Err(err) => {
                log::info!("[photobook:library] {} is not valid JSON and could not be moved: {err}", file.display());
                // Never write over a file we could not move aside.
                return Ok(read_backup(file));
            }
        }
    }
    let Some(restored) = read_backup(file) else {
        return Ok(None);
    };
    log::info!("[photobook:library] restored {} from {}", file.display(), backup_path(file).display());
    if let Err(err) = write_with_backup(file, restored.as_bytes()) {
        log::info!("[photobook:library] could not write the restored library back: {err}");
    }
    Ok(Some(restored))
}

/// `<file>.bak` when it is a JSON object.
fn read_backup(file: &Path) -> Option<String> {
    fs::read_to_string(backup_path(file)).ok().filter(|text| is_json_object(text))
}

fn write_file(file: &Path, json: &str) -> Result<()> {
    if !is_json_object(json) {
        return Err(Error::Invalid("Refusing to write a library that is not a JSON object".into()));
    }
    write_with_backup(file, json.as_bytes())
}

fn is_json_object(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text).is_ok_and(|v| v.is_object())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join(LIBRARY_DIR)).unwrap();
        (dir, root)
    }

    #[test]
    fn a_missing_library_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_file(&library_path(dir.path())).unwrap(), None);
        assert_eq!(read_backup(&library_path(dir.path())), None);
    }

    #[test]
    fn a_missing_library_with_a_backup_is_restored_and_written_back() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        fs::write(backup_path(&file), r#"{"version":1,"photos":{"kept":{}}}"#).unwrap();
        assert_eq!(read_file(&file).unwrap().as_deref(), Some(r#"{"version":1,"photos":{"kept":{}}}"#));
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"version":1,"photos":{"kept":{}}}"#);
        // A backup that is not JSON is not restored.
        fs::remove_file(&file).unwrap();
        fs::write(backup_path(&file), "nope").unwrap();
        assert_eq!(read_file(&file).unwrap(), None);
        assert!(!file.exists());
    }

    #[test]
    fn read_backup_returns_the_previous_version() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        write_file(&file, r#"{"version":1,"photos":{"a":{}}}"#).unwrap();
        assert_eq!(read_backup(&file), None);
        write_file(&file, r#"{"version":1,"photos":{"a":{"rating":9}}}"#).unwrap();
        assert_eq!(read_backup(&file).as_deref(), Some(r#"{"version":1,"photos":{"a":{}}}"#));
    }

    #[test]
    fn write_then_read_keeps_one_backup() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        write_file(&file, r#"{"version":1,"photos":{}}"#).unwrap();
        assert_eq!(read_file(&file).unwrap().as_deref(), Some(r#"{"version":1,"photos":{}}"#));
        assert!(!backup_path(&file).exists(), "nothing to back up on the first write");

        write_file(&file, r#"{"version":1,"photos":{"a":{}}}"#).unwrap();
        write_file(&file, r#"{"version":1,"photos":{"b":{}}}"#).unwrap();
        assert_eq!(fs::read_to_string(backup_path(&file)).unwrap(), r#"{"version":1,"photos":{"a":{}}}"#);
        assert_eq!(read_file(&file).unwrap().as_deref(), Some(r#"{"version":1,"photos":{"b":{}}}"#));

        // Only the library and its backup: no temp files left behind.
        let mut names: Vec<_> = fs::read_dir(root.join(LIBRARY_DIR)).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, vec!["library.json", "library.json.bak"]);
    }

    #[test]
    fn invalid_json_is_never_written() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        assert!(matches!(write_file(&file, "{"), Err(Error::Invalid(_))));
        assert!(matches!(write_file(&file, "[]"), Err(Error::Invalid(_))));
        assert!(!file.exists());
    }

    #[test]
    fn an_unparsable_library_falls_back_to_the_backup() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        write_file(&file, r#"{"version":1,"photos":{"old":{}}}"#).unwrap();
        write_file(&file, r#"{"version":1,"photos":{"new":{}}}"#).unwrap();
        // Truncated by a crash or a sync tool.
        fs::write(&file, r#"{"version":1,"pho"#).unwrap();

        assert_eq!(read_file(&file).unwrap().as_deref(), Some(r#"{"version":1,"photos":{"old":{}}}"#));
        // The broken file is kept aside, not deleted, and the recovered version is written back in its place.
        let aside = root.join(LIBRARY_DIR).join("library.json.corrupt");
        assert_eq!(fs::read_to_string(&aside).unwrap(), r#"{"version":1,"pho"#);
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"version":1,"photos":{"old":{}}}"#);
        // So the next open (even one that never writes) still finds it.
        assert_eq!(read_file(&file).unwrap().as_deref(), Some(r#"{"version":1,"photos":{"old":{}}}"#));
    }

    #[test]
    fn an_unparsable_library_without_backup_reads_as_none() {
        let (_dir, root) = folder();
        let file = library_path(&root);
        fs::write(&file, "not json").unwrap();
        assert_eq!(read_file(&file).unwrap(), None);
        assert!(root.join(LIBRARY_DIR).join("library.json.corrupt").is_file());
    }
}
