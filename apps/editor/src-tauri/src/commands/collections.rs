//! Saved collections (workflow plan 06): named filters over the imported folders, in `<appdata>/collections.json` as
//! `[{ id, name, filter }]`. They are filters, never copies; the editor owns their shape (`CollectionFilterSchema` in
//! `packages/shared/src/collections.ts`) and this module only keeps the file sound: a ULID id, a 1 to 80 character
//! name and an object filter, ids unique.
//!
//! - `read_collections` returns the list in saved order. No file is an empty list; a file that cannot be read or parsed
//!   is moved aside to `collections.json.corrupt-<epoch ms>` (logged) and read as empty; invalid entries are dropped
//!   one by one (logged), and the file is first copied aside under the same name so the next write cannot lose them.
//! - `write_collections(collections)` validates every entry and replaces the file (temp file + rename). Fields this
//!   version does not know (a newer editor's) are read and written back as they are.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::atomic::atomic_write;
use crate::commands::folders::{corrupt_path, now_ms};
use crate::commands::presets::is_ulid;
use crate::error::{Error, Result};
use crate::scope::app_data_dir;

pub const COLLECTIONS_FILE_NAME: &str = "collections.json";
const MAX_NAME_CHARS: usize = 80;
/// Largest file read (a collection is a few hundred bytes; this stops a stray file from being loaded).
const MAX_BYTES: u64 = 1024 * 1024;

/// Serializes the read-modify-write of the file (the temp file name is per process).
static LOCK: Mutex<()> = Mutex::new(());

/// One saved collection, as stored. `filter` and any other field are passed through as the editor wrote them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SavedCollection {
    pub id: String,
    pub name: String,
    pub filter: Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[tauri::command]
pub async fn read_collections<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SavedCollection>> {
    let file = collections_file(&app)?;
    let _guard = LOCK.lock().expect("collections lock poisoned");
    Ok(load(&file))
}

#[tauri::command]
pub async fn write_collections<R: Runtime>(app: AppHandle<R>, collections: Vec<SavedCollection>) -> Result<()> {
    let collections = validate(collections)?;
    let file = collections_file(&app)?;
    let _guard = LOCK.lock().expect("collections lock poisoned");
    save(&file, &collections)
}

fn collections_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(COLLECTIONS_FILE_NAME))
}

/// Why an entry is not a valid collection, or None.
fn invalid(entry: &SavedCollection) -> Option<String> {
    if !is_ulid(&entry.id) {
        return Some(format!("invalid id {:?}", entry.id));
    }
    let name = entry.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Some(format!("a collection name has 1 to {MAX_NAME_CHARS} characters ({:?})", entry.name));
    }
    if !entry.filter.is_object() {
        return Some(format!("the filter of {:?} is not an object", entry.name));
    }
    None
}

/// Check a list the editor wants to write: every entry valid, ids unique. Names are trimmed.
pub fn validate(collections: Vec<SavedCollection>) -> Result<Vec<SavedCollection>> {
    let mut out: Vec<SavedCollection> = Vec::with_capacity(collections.len());
    for mut entry in collections {
        if let Some(reason) = invalid(&entry) {
            return Err(Error::Invalid(format!("Cannot save the collection: {reason}")));
        }
        if out.iter().any(|c| c.id == entry.id) {
            return Err(Error::Invalid(format!("Two collections have the id {:?}", entry.id)));
        }
        entry.name = entry.name.trim().to_string();
        out.push(entry);
    }
    Ok(out)
}

/// Parse the file's text: invalid entries and repeated ids are dropped (logged), the rest kept in order.
#[cfg(test)]
pub fn parse(text: &str) -> std::result::Result<Vec<SavedCollection>, String> {
    parse_counting(text).map(|(list, _)| list)
}

/// [`parse`], with how many entries were dropped.
fn parse_counting(text: &str) -> std::result::Result<(Vec<SavedCollection>, usize), String> {
    let entries: Vec<Value> = serde_json::from_str(text).map_err(|err| err.to_string())?;
    let total = entries.len();
    let mut out: Vec<SavedCollection> = Vec::with_capacity(entries.len());
    for value in entries {
        let entry = match serde_json::from_value::<SavedCollection>(value) {
            Ok(entry) => entry,
            Err(err) => {
                log::info!("[photobook:collections] dropped an entry ({err})");
                continue;
            }
        };
        if let Some(reason) = invalid(&entry) {
            log::info!("[photobook:collections] dropped an entry: {reason}");
        } else if out.iter().any(|c| c.id == entry.id) {
            log::info!("[photobook:collections] dropped a second entry with id {:?}", entry.id);
        } else {
            out.push(entry);
        }
    }
    let dropped = total - out.len();
    Ok((out, dropped))
}

/// Read `file`: empty when it does not exist; empty, logged and moved aside when it cannot be read or parsed (so the
/// next write does not destroy what was there).
pub fn load(file: &Path) -> Vec<SavedCollection> {
    let read = fs::metadata(file).and_then(|meta| {
        if meta.len() > MAX_BYTES {
            Err(std::io::Error::other(format!("larger than {MAX_BYTES} bytes")))
        } else {
            fs::read_to_string(file)
        }
    });
    let text = match read {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => return corrupt(file, &err.to_string()),
    };
    match parse_counting(&text) {
        Ok((collections, 0)) => collections,
        Ok((collections, dropped)) => {
            // The next write would leave the dropped entries out: keep the file as it was first.
            let aside = corrupt_path(file, now_ms());
            match fs::copy(file, &aside) {
                Ok(_) => log::info!(
                    "[photobook:collections] {dropped} entries dropped; the file is kept as {}",
                    aside.display()
                ),
                Err(err) => log::info!("[photobook:collections] {dropped} entries dropped; copy failed: {err}"),
            }
            collections
        }
        Err(err) => corrupt(file, &err),
    }
}

fn corrupt(file: &Path, reason: &str) -> Vec<SavedCollection> {
    let aside = corrupt_path(file, now_ms());
    let moved = fs::rename(file, &aside).is_ok();
    log::info!(
        "[photobook:collections] {} is unreadable ({reason}); starting with no saved collections{}",
        file.display(),
        if moved { format!(", old file kept as {}", aside.display()) } else { String::new() }
    );
    Vec::new()
}

/// Write the list: temp file, `sync_all`, rename.
pub fn save(file: &Path, collections: &[SavedCollection]) -> Result<()> {
    let json = serde_json::to_vec_pretty(collections).map_err(|err| Error::Invalid(err.to_string()))?;
    atomic_write(file, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "01K7F000000000000000000000";
    const B: &str = "01K7G000000000000000000000";

    fn collection(id: &str, name: &str) -> SavedCollection {
        SavedCollection {
            id: id.into(),
            name: name.into(),
            filter: json!({ "flag": "picks", "minRating": 3 }),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn collections_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(COLLECTIONS_FILE_NAME);
        assert!(load(&file).is_empty(), "no file yet is an empty list");

        let list = validate(vec![collection(A, " Keepers "), collection(B, "Rome")]).unwrap();
        assert_eq!(list[0].name, "Keepers", "names are trimmed");
        save(&file, &list).unwrap();
        assert_eq!(load(&file), list);
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from(COLLECTIONS_FILE_NAME)], "no temp file left behind");
    }

    #[test]
    fn writes_refuse_invalid_entries_and_repeated_ids() {
        assert!(validate(vec![collection("nope", "Bad")]).is_err());
        assert!(validate(vec![collection(A, "   ")]).is_err());
        assert!(validate(vec![collection(A, &"x".repeat(81))]).is_err());
        assert!(validate(vec![collection(A, "One"), collection(A, "Two")]).is_err());
        let mut not_object = collection(A, "Array");
        not_object.filter = json!([1]);
        assert!(validate(vec![not_object]).is_err());
    }

    #[test]
    fn reads_drop_bad_entries_and_keep_the_rest() {
        let text = json!([
            { "id": A, "name": "Keepers", "filter": {} },
            { "id": A, "name": "Again", "filter": {} },
            { "id": "bad", "name": "Bad id", "filter": {} },
            { "id": B, "name": "No filter" },
            { "id": B, "name": "Rome", "filter": { "query": "rome" } },
        ])
        .to_string();
        let list = parse(&text).unwrap();
        assert_eq!(list.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["Keepers", "Rome"]);
    }

    #[test]
    fn unknown_fields_survive_and_dropped_entries_are_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(COLLECTIONS_FILE_NAME);
        let text = json!([
            { "id": A, "name": "Keepers", "filter": { "flag": "picks", "future": 1 }, "colour": "red" },
            { "id": "bad", "name": "Bad id", "filter": {} },
        ])
        .to_string();
        fs::write(&file, &text).unwrap();
        let list = load(&file);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].extra.get("colour"), Some(&json!("red")));
        save(&file, &list).unwrap();
        let written: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(written[0]["colour"], json!("red"));
        assert_eq!(written[0]["filter"]["future"], json!(1));
        let aside: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("collections.json.corrupt-"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(fs::read_to_string(aside[0].path()).unwrap(), text, "the original, both entries");
    }

    #[test]
    fn a_corrupt_file_is_empty_and_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(COLLECTIONS_FILE_NAME);
        fs::write(&file, "{ not json").unwrap();
        assert!(load(&file).is_empty());
        assert!(!file.exists(), "moved aside so the next write keeps it");
        let kept = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("collections.json.corrupt-"));
        assert!(kept);
    }
}
