//! Folders registry (workflow plan 01): the photo folders imported into the editor, remembered across sessions in
//! `<appdata>/folders.json` as `[{ id, path, name, addedAt, lastSeen }]` (ULID id, canonical path, epoch ms times).
//!
//! - `list_folders` returns the registry in import order, each with `missing` set when the folder is not on disk now.
//! - `import_folder(path)` adds a folder (idempotent by canonical path: importing it again only refreshes `lastSeen`)
//!   and makes it an imported root (`scope::add_root`). The folder must have been picked in the native dialog, be in
//!   the registry already, or already be a root. A legacy `<folder>/book.photobook.json` in it then becomes a project
//!   in app data (`projects::import_legacy`, workflow plan 04).
//! - `remove_folder(id)` drops it from the registry and the command scope; `<folder>/.photobook/` and
//!   `.photobook-cache/` are left in place. An unknown id is fine (already gone).
//! - `rename_folder(id, name)` sets the display name (the path never changes).
//!
//! [`init`] runs once at startup: it reads the registry and adds every folder that still exists as a root, so cached
//! thumbnails, renders and projects keep working without the dialog. A registry that cannot be read or parsed is
//! moved aside to `folders.json.corrupt-<epoch ms>`, logged as a `[photobook:folders]` line and treated as empty,
//! never fatal; entries dropped while reading (invalid id or path, duplicates) are logged one per line. Startup also
//! rewrites each path it adds to its canonical form and drops entries that turn out to be the same folder. Writes go
//! through a temp file that is synced to disk before the rename.
//!
//! Photo index (workflow plan 05): `<folder>/.photobook/index.json` remembers, per relative path, what scanning,
//! hashing and preparing found (`{ hash, size, mtime, kind, width?, height?, orientation?, iso?, noise? }`, plus plan
//! 38's `assets::PhotoFacts`: `taken?, make?, model?, lens?, focal?, phash?, stats?`, plan 52's `shutter?,
//! aperture?, gps?` and plan 56's `palette?`), so reopening a folder neither hashes nor waits for thumbnails of files that did not change.
//! `scan_folder` reads it and copies an entry onto every scanned file whose size, mtime and kind still match
//! (`apply_index`); the editor writes it back with `write_index` after a scan (temp file + rename, no backup: it is a
//! cache, rebuilt by hashing). `read_index` returns the entries. A missing, unreadable or unparsable index is empty (logged); entries with a bad path are dropped.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::BTreeMap;
use std::path::Component;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::atomic::atomic_write;
use crate::commands::assets::{Kind, PhotoFacts, ScannedFile};
use crate::commands::library::LIBRARY_DIR;
use crate::commands::presets::is_ulid;
use crate::commands::projects;
use crate::error::{Error, Result};
use crate::scope::{self, app_data_dir, ImportedRoots};

pub const FOLDERS_FILE_NAME: &str = "folders.json";
/// The photo index, next to the library in `<folder>/.photobook/`.
pub const INDEX_FILE_NAME: &str = "index.json";
const INDEX_VERSION: u32 = 1;
const CORRUPT_SUFFIX: &str = "corrupt";
const MAX_NAME_CHARS: usize = 120;

/// One registry entry, exactly as stored in `folders.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    /// A ULID minted on first import; later plans key the folder's projects and library on it.
    pub id: String,
    /// Canonical absolute path.
    pub path: String,
    /// Display name; the folder's own name until renamed.
    pub name: String,
    /// Epoch milliseconds of the first import.
    pub added_at: u64,
    /// Epoch milliseconds the folder was last found on disk (import, open or startup).
    pub last_seen: u64,
}

/// What the commands return: the entry plus whether the folder is on disk now.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(flatten)]
    pub entry: FolderEntry,
    pub missing: bool,
}

impl From<&FolderEntry> for Folder {
    fn from(entry: &FolderEntry) -> Self {
        Folder { entry: entry.clone(), missing: !Path::new(&entry.path).is_dir() }
    }
}

/// The registry in memory, loaded by [`init`]; every change is written through to `folders.json`.
#[derive(Default)]
pub struct FolderRegistry {
    folders: Mutex<Vec<FolderEntry>>,
}

#[tauri::command]
pub async fn list_folders<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Folder>> {
    let folders = app.state::<FolderRegistry>().folders.lock().expect("folders lock poisoned").clone();
    Ok(folders.iter().map(Folder::from).collect())
}

#[tauri::command]
pub async fn import_folder<R: Runtime>(app: AppHandle<R>, path: String) -> Result<Folder> {
    let folder = import(&app, Path::new(&path))?;
    // Best effort: a legacy book that cannot be imported stays where it is and the folder is imported anyway.
    if let Err(err) = projects::import_legacy(&app, Path::new(&folder.entry.path)) {
        log::info!("[photobook:projects] legacy book in {} not imported: {err}", folder.entry.path);
    }
    Ok(folder)
}

#[tauri::command]
pub async fn remove_folder<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    let registry = app.state::<FolderRegistry>();
    let mut folders = registry.folders.lock().expect("folders lock poisoned");
    let Some(index) = folders.iter().position(|f| f.id == id) else {
        return Ok(());
    };
    let mut next = folders.clone();
    let removed = next.remove(index);
    save(&registry_file(&app)?, &next)?;
    *folders = next;
    // `remove_root` normalizes too, so a folder reached through a symlink or renamed since still loses scope.
    scope::remove_root(&app, Path::new(&removed.path));
    log::info!("[photobook:folders] removed {} ({})", removed.name, removed.path);
    Ok(())
}

#[tauri::command]
pub async fn rename_folder<R: Runtime>(app: AppHandle<R>, id: String, name: String) -> Result<Folder> {
    let name = valid_name(&name)?;
    let registry = app.state::<FolderRegistry>();
    let mut folders = registry.folders.lock().expect("folders lock poisoned");
    let mut next = folders.clone();
    let entry = next
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| Error::Invalid(format!("No imported folder with id {id:?}")))?;
    entry.name = name;
    let folder = Folder::from(&*entry);
    save(&registry_file(&app)?, &next)?;
    *folders = next;
    Ok(folder)
}

/// One photo of the index, by relative path.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    /// SHA-256 hex of the file's bytes.
    pub hash: String,
    pub size: u64,
    /// Modification time, epoch ms (the scan's `mtimeMs`).
    pub mtime: u64,
    pub kind: Kind,
    /// Upright pixel size and EXIF orientation, once `prepare_asset` has run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u32>,
    /// ISO speed from the file's Exif (`prepare_asset`, workflow plan 23), when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// σ at mid-grey of the photo's measured noise profile (`noise_profile`, plan 23), once measured. Index files
    /// from before either field read as absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise: Option<f64>,
    /// Capture time, camera, lens, perceptual hash and stats (plan 38), once `prepare_asset` has run; every field
    /// optional, so the index stays at version 1.
    #[serde(flatten)]
    pub facts: PhotoFacts,
}

/// The photo index entries by relative path (`/`-separated).
pub type PhotoIndex = BTreeMap<String, IndexEntry>;

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    photos: PhotoIndex,
}

#[tauri::command]
pub async fn read_index<R: Runtime>(app: AppHandle<R>, folder: String) -> Result<PhotoIndex> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    scope::ensure_allowed(&app, index_path(&root))?;
    Ok(load_index(&root))
}

#[tauri::command]
pub async fn write_index<R: Runtime>(app: AppHandle<R>, folder: String, photos: PhotoIndex) -> Result<()> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    let dir = root.join(LIBRARY_DIR);
    fs::create_dir_all(&dir).map_err(|err| Error::Io(format!("creating {}", dir.display()), err))?;
    let file = scope::ensure_allowed(&app, dir.join(INDEX_FILE_NAME))?;
    let count = save_index(&file, photos)?;
    log::info!("[photobook:index] written {}: {count} photos", root.display());
    Ok(())
}

/// `<root>/.photobook/index.json`.
pub fn index_path(root: &Path) -> PathBuf {
    root.join(LIBRARY_DIR).join(INDEX_FILE_NAME)
}

/// The index of `root`: empty when there is none, or when it cannot be read or parsed (logged; the next write replaces
/// it). Entries whose path is not a plain relative path are dropped.
pub fn load_index(root: &Path) -> PhotoIndex {
    let file = index_path(root);
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return PhotoIndex::new(),
        Err(err) => {
            log::info!("[photobook:index] {} is unreadable ({err}); scanning without it", file.display());
            return PhotoIndex::new();
        }
    };
    match parse_index(&text) {
        Ok(photos) => photos,
        Err(err) => {
            log::info!("[photobook:index] {} is not a photo index ({err}); scanning without it", file.display());
            PhotoIndex::new()
        }
    }
}

/// Parse an index file's text (version 1). Entries with an invalid relative path are dropped.
pub fn parse_index(text: &str) -> std::result::Result<PhotoIndex, String> {
    let file: IndexFile = serde_json::from_str(text).map_err(|err| err.to_string())?;
    if file.version != INDEX_VERSION {
        return Err(format!("unknown version {}", file.version));
    }
    Ok(file.photos.into_iter().filter_map(|(rel, entry)| valid_entry(rel, entry)).collect())
}

/// Write the index (entries with an invalid path or hash dropped) and return how many it holds.
pub fn save_index(file: &Path, photos: PhotoIndex) -> Result<usize> {
    let photos: PhotoIndex = photos.into_iter().filter_map(|(rel, entry)| valid_entry(rel, entry)).collect();
    let count = photos.len();
    let json = serde_json::to_vec(&IndexFile { version: INDEX_VERSION, photos })
        .map_err(|err| Error::Invalid(err.to_string()))?;
    atomic_write(file, &json)?;
    Ok(count)
}

/// Copy the index entry of every scanned file whose size, mtime and kind still match onto it. Returns how many matched.
pub fn apply_index(index: &PhotoIndex, files: &mut [ScannedFile]) -> usize {
    let mut reused = 0;
    for file in files.iter_mut() {
        let Some(entry) = index.get(&file.rel_path) else { continue };
        if entry.size != file.size || entry.mtime != file.mtime_ms || entry.kind != file.kind {
            continue;
        }
        file.hash = Some(entry.hash.clone());
        file.width = entry.width;
        file.height = entry.height;
        file.orientation = entry.orientation;
        file.iso = entry.iso;
        file.noise = entry.noise;
        file.facts = entry.facts.clone();
        reused += 1;
    }
    reused
}

/// The entry with its hash in lowercase hex (the thumbnail cache names folders by it), or None when its path or hash
/// is not valid.
fn valid_entry(rel: String, mut entry: IndexEntry) -> Option<(String, IndexEntry)> {
    entry.hash.make_ascii_lowercase();
    (valid_rel_path(&rel) && valid_hash(&entry.hash)).then_some((rel, entry))
}

fn valid_rel_path(rel: &str) -> bool {
    !rel.is_empty() && !rel.contains('\\') && Path::new(rel).components().all(|c| matches!(c, Component::Normal(_)))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Import `path` (see the module doc) and return its entry. When the registry cannot be written the import fails and
/// the folder is taken back out of scope if this call added it.
pub fn import<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<Folder> {
    let registry = app.state::<FolderRegistry>();
    let mut folders = registry.folders.lock().expect("folders lock poisoned");
    let canonical = scope::normalize(path).ok();
    let known = canonical.as_deref().is_some_and(|c| find_by_path(&folders, c).is_some());
    let was_root = canonical.as_deref().is_some_and(|c| app.state::<ImportedRoots>().contains(c));
    let root = scope::add_root(app, path, known)?;

    let mut next = folders.clone();
    let (entry, added) = upsert(&mut next, &root, now_ms());
    if let Err(err) = registry_file(app).and_then(|file| save(&file, &next)) {
        if !was_root {
            scope::remove_root(app, &root);
        }
        return Err(err);
    }
    *folders = next;
    if added {
        log::info!("[photobook:folders] imported {} ({}), {} in the registry", entry.name, entry.path, folders.len());
    }
    Ok(Folder::from(&entry))
}

/// The registry entries now, in import order.
pub fn entries<R: Runtime>(app: &AppHandle<R>) -> Vec<FolderEntry> {
    app.state::<FolderRegistry>().folders.lock().expect("folders lock poisoned").clone()
}

/// The registry entry with `id`.
pub fn find<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<FolderEntry> {
    entries(app).into_iter().find(|f| f.id == id)
}

/// Startup: load the registry and add every folder still on disk as a root. Never fails the app.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let file = match registry_file(app) {
        Ok(file) => file,
        Err(err) => {
            log::info!("[photobook:folders] no app data dir, registry not loaded: {err}");
            return;
        }
    };
    let loaded = load(&file);
    let count = loaded.len();
    let now = now_ms();
    let (mut present, mut missing) = (0, 0);
    let folders = canonicalize(loaded, |path| {
        if !path.is_dir() {
            missing += 1;
            return None;
        }
        match scope::add_root(app, path, true) {
            Ok(root) => {
                present += 1;
                Some(root)
            }
            Err(err) => {
                log::info!("[photobook:folders] could not add {} as a root: {err}", path.display());
                None
            }
        }
    }, now);
    if present > 0 || folders.len() != count {
        if let Err(err) = save(&file, &folders) {
            log::info!("[photobook:folders] could not update the registry: {err}");
        }
    }
    log::info!("[photobook:folders] registry loaded: {} folders, {present} roots, {missing} missing", folders.len());
    *app.state::<FolderRegistry>().folders.lock().expect("folders lock poisoned") = folders;
}

/// Rewrite each entry `resolve` maps to a root (`add_root` at startup) to that canonical path, with `lastSeen = now`,
/// then drop entries that became duplicates (the first one keeps its id and name). Unresolved entries are kept as
/// they are: a folder on an unplugged drive comes back when the drive does.
pub fn canonicalize(
    folders: Vec<FolderEntry>,
    mut resolve: impl FnMut(&Path) -> Option<PathBuf>,
    now: u64,
) -> Vec<FolderEntry> {
    let resolved = folders
        .into_iter()
        .map(|mut entry| {
            if let Some(root) = resolve(Path::new(&entry.path)) {
                entry.path = root.to_string_lossy().into_owned();
                entry.last_seen = now;
            }
            entry
        })
        .collect();
    dedupe(resolved)
}

/// Keep the first entry per path and per id, logging each one dropped.
fn dedupe(entries: Vec<FolderEntry>) -> Vec<FolderEntry> {
    let mut folders: Vec<FolderEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        if let Some(kept) = folders.iter().find(|f| f.path == entry.path || f.id == entry.id) {
            log::info!(
                "[photobook:folders] dropped duplicate entry {} ({}), same {} as {}",
                entry.id,
                entry.path,
                if kept.path == entry.path { "folder" } else { "id" },
                kept.id
            );
        } else {
            folders.push(entry);
        }
    }
    folders
}

fn registry_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(FOLDERS_FILE_NAME))
}

/// Parse the registry text. Entries with an invalid id or a relative path are dropped, duplicates of a path or an id
/// keep the first entry; every dropped entry is logged.
pub fn parse(text: &str) -> std::result::Result<Vec<FolderEntry>, String> {
    let entries: Vec<FolderEntry> = serde_json::from_str(text).map_err(|err| err.to_string())?;
    let valid = entries
        .into_iter()
        .filter(|entry| {
            let ok = is_ulid(&entry.id) && Path::new(&entry.path).is_absolute();
            if !ok {
                log::info!("[photobook:folders] dropped invalid entry {:?} ({:?})", entry.id, entry.path);
            }
            ok
        })
        .collect();
    Ok(dedupe(valid))
}

/// Read `file`: empty when it does not exist; empty, logged and moved aside to `folders.json.corrupt-<epoch ms>` when
/// it cannot be read or parsed (so the next write does not destroy what was there).
pub fn load(file: &Path) -> Vec<FolderEntry> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => return corrupt(file, &err.to_string()),
    };
    match parse(&text) {
        Ok(folders) => folders,
        Err(err) => corrupt(file, &err),
    }
}

fn corrupt(file: &Path, reason: &str) -> Vec<FolderEntry> {
    let aside = corrupt_path(file, now_ms());
    let moved = fs::rename(file, &aside).is_ok();
    log::info!(
        "[photobook:folders] {} is unreadable ({reason}); starting with an empty registry{}",
        file.display(),
        if moved { format!(", old file kept as {}", aside.display()) } else { String::new() }
    );
    Vec::new()
}

/// `<file>.corrupt-<now>`, or `-<now>-<n>` when that exists already, so an older copy is never overwritten.
pub(crate) fn corrupt_path(file: &Path, now: u64) -> PathBuf {
    let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut aside = file.with_file_name(format!("{name}.{CORRUPT_SUFFIX}-{now}"));
    let mut n = 1;
    while aside.exists() {
        aside = file.with_file_name(format!("{name}.{CORRUPT_SUFFIX}-{now}-{n}"));
        n += 1;
    }
    aside
}

/// Write the registry: temp file, `sync_all`, rename (`atomic::atomic_write`). Callers hold the registry lock (or run
/// before any command, at startup), so the per-process temp name never races.
pub fn save(file: &Path, folders: &[FolderEntry]) -> Result<()> {
    let json = serde_json::to_vec_pretty(folders).map_err(|err| Error::Invalid(err.to_string()))?;
    atomic_write(file, &json)
}

fn find_by_path<'a>(folders: &'a [FolderEntry], root: &Path) -> Option<&'a FolderEntry> {
    folders.iter().find(|f| Path::new(&f.path) == root)
}

/// Add `root` (canonical) or refresh its `lastSeen`. Returns the entry and whether it is new.
pub fn upsert(folders: &mut Vec<FolderEntry>, root: &Path, now: u64) -> (FolderEntry, bool) {
    if let Some(entry) = folders.iter_mut().find(|f| Path::new(&f.path) == root) {
        entry.last_seen = now;
        return (entry.clone(), false);
    }
    let entry = FolderEntry {
        id: new_ulid(now),
        path: root.to_string_lossy().into_owned(),
        name: default_name(root),
        added_at: now,
        last_seen: now,
    };
    folders.push(entry.clone());
    (entry, true)
}

fn default_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string())
}

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::Invalid(format!("A folder name has 1 to {MAX_NAME_CHARS} characters")));
    }
    Ok(name.to_string())
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A ULID: 48 bits of `now_ms`, then 80 random bits, in Crockford base32. The randomness comes from std's
/// per-process random hash keys mixed with a counter and the clock; ids only need to be unique, not secret.
pub(crate) fn new_ulid(now_ms: u64) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let word = |salt: u64| {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u64(count);
        hasher.write_u32(nanos);
        hasher.finish()
    };
    let random = (u128::from(word(1)) << 64 | u128::from(word(2))) & ((1u128 << 80) - 1);
    let value = (u128::from(now_ms & ((1 << 48) - 1)) << 80) | random;

    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    (0..26).rev().map(|i| ALPHABET[((value >> (i * 5)) & 31) as usize] as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, path: &str) -> FolderEntry {
        FolderEntry { id: id.into(), path: path.into(), name: "x".into(), added_at: 1, last_seen: 1 }
    }

    #[test]
    fn ulids_are_valid_unique_and_time_ordered() {
        let a = new_ulid(1_760_000_000_000);
        let b = new_ulid(1_760_000_000_000);
        let later = new_ulid(1_760_000_000_001);
        assert!(is_ulid(&a) && is_ulid(&b) && is_ulid(&later), "{a} {b} {later}");
        assert_ne!(a, b);
        assert_eq!(a[..10], b[..10], "same millisecond, same time prefix");
        assert!(later[..10] > a[..10]);
    }

    #[test]
    fn upsert_is_idempotent_by_path() {
        let mut folders = Vec::new();
        let (first, added) = upsert(&mut folders, Path::new("/photos/Lisbon 2026"), 10);
        assert!(added);
        assert_eq!(first.name, "Lisbon 2026");
        assert_eq!((first.added_at, first.last_seen), (10, 10));

        let (again, added) = upsert(&mut folders, Path::new("/photos/Lisbon 2026"), 20);
        assert!(!added);
        assert_eq!(again.id, first.id);
        assert_eq!((again.added_at, again.last_seen), (10, 20));
        assert_eq!(folders.len(), 1);

        let (other, added) = upsert(&mut folders, Path::new("/photos/Porto"), 30);
        assert!(added);
        assert_ne!(other.id, first.id);
        assert_eq!(folders.len(), 2);
    }

    #[test]
    fn registry_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FOLDERS_FILE_NAME);
        assert!(load(&file).is_empty(), "no file yet is an empty registry");

        let mut folders = Vec::new();
        upsert(&mut folders, Path::new("/photos/a"), 1);
        upsert(&mut folders, Path::new("/photos/b"), 2);
        save(&file, &folders).unwrap();
        assert_eq!(load(&file), folders);
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"addedAt\"") && text.contains("\"lastSeen\""), "{text}");
        // Only the registry: the temp file was renamed over it.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_corrupt_registry_is_empty_and_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FOLDERS_FILE_NAME);
        let junks = ["{not json", "{\"folders\": []}", "[{\"id\": 3}]", ""];
        for junk in junks {
            fs::write(&file, junk).unwrap();
            assert!(load(&file).is_empty(), "{junk:?}");
            assert!(!file.exists());
        }
        // Every corrupt copy is kept, none overwritten (several land in the same millisecond here).
        let mut kept: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("folders.json.corrupt-"))
            .map(|p| fs::read_to_string(p).unwrap())
            .collect();
        kept.sort();
        let mut expected: Vec<String> = junks.iter().map(|j| j.to_string()).collect();
        expected.sort();
        assert_eq!(kept, expected);
        // The next save starts a fresh registry.
        let mut folders = Vec::new();
        upsert(&mut folders, Path::new("/photos/a"), 1);
        save(&file, &folders).unwrap();
        assert_eq!(load(&file), folders);
    }

    #[test]
    fn parse_drops_invalid_and_duplicate_entries() {
        let good = new_ulid(1);
        let other = new_ulid(2);
        let text = serde_json::to_string(&[
            entry(&good, "/photos/a"),
            entry("not-a-ulid", "/photos/b"),
            entry(&other, "relative/c"),
            entry(&other, "/photos/a"),
        ])
        .unwrap();
        assert_eq!(parse(&text).unwrap(), vec![entry(&good, "/photos/a")]);
    }

    #[test]
    fn corrupt_copies_get_unique_names() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FOLDERS_FILE_NAME);
        let first = corrupt_path(&file, 42);
        assert_eq!(first.file_name().unwrap(), "folders.json.corrupt-42");
        fs::write(&first, "x").unwrap();
        let second = corrupt_path(&file, 42);
        assert_eq!(second.file_name().unwrap(), "folders.json.corrupt-42-1");
    }

    #[test]
    fn startup_rewrites_paths_to_canonical_and_merges_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let real = base.join("Lisbon");
        fs::create_dir(&real).unwrap();
        let link = base.join("lisbon-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (a, b, c, gone) = (new_ulid(1), new_ulid(1), new_ulid(1), new_ulid(1));
        let folders = vec![
            entry(&a, &link.to_string_lossy()),
            entry(&b, &real.to_string_lossy()),
            entry(&gone, "/unplugged/drive/Porto"),
            entry(&c, &format!("{}/", real.display())),
        ];
        // What `init` passes: canonicalize the folders that exist.
        let out = canonicalize(folders, |p| p.is_dir().then(|| p.canonicalize().unwrap()), 99);
        let real_s = real.to_string_lossy().into_owned();
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!((out[0].id.as_str(), out[0].path.as_str(), out[0].last_seen), (a.as_str(), real_s.as_str(), 99));
        let unplugged = (out[1].id.as_str(), out[1].path.as_str(), out[1].last_seen);
        assert_eq!(unplugged, (gone.as_str(), "/unplugged/drive/Porto", 1));
        // A later import of the canonical path finds the entry instead of adding a second one.
        let mut next = out.clone();
        let (found, added) = upsert(&mut next, &real, 100);
        assert!(!added);
        assert_eq!(found.id, a);
        assert_eq!(next.len(), 2);
    }

    #[test]
    fn folder_reports_missing_and_flattens() {
        let dir = tempfile::tempdir().unwrap();
        let here = entry(&new_ulid(1), &dir.path().to_string_lossy());
        let gone = entry(&new_ulid(2), "/definitely/not/here");
        assert!(!Folder::from(&here).missing);
        assert!(Folder::from(&gone).missing);
        let json = serde_json::to_value(Folder::from(&gone)).unwrap();
        assert_eq!(json["path"], "/definitely/not/here");
        assert_eq!(json["missing"], true);
    }

    fn scanned(rel: &str, size: u64, mtime: u64, kind: Kind) -> ScannedFile {
        ScannedFile {
            rel_path: rel.into(),
            size,
            mtime_ms: mtime,
            kind,
            hash: None,
            width: None,
            height: None,
            orientation: None,
            iso: None,
            noise: None,
            facts: PhotoFacts::default(),
        }
    }

    fn indexed(hash: char, size: u64, mtime: u64) -> IndexEntry {
        IndexEntry {
            hash: hash.to_string().repeat(64),
            size,
            mtime,
            kind: Kind::Jpeg,
            width: Some(1200),
            height: Some(800),
            orientation: Some(6),
            iso: None,
            noise: None,
            facts: PhotoFacts::default(),
        }
    }

    #[test]
    fn iso_and_noise_round_trip_and_old_entries_still_read() {
        let old = r#"{"version":1,"photos":{"a.jpg":{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":10,"mtime":1,"kind":"jpeg"}}}"#;
        let photos = parse_index(old).unwrap();
        assert_eq!((photos["a.jpg"].iso, photos["a.jpg"].noise), (None, None));
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(LIBRARY_DIR)).unwrap();
        let mut photos = PhotoIndex::new();
        photos.insert("a.jpg".into(), IndexEntry { iso: Some(6400), noise: Some(0.0042), ..indexed('a', 10, 1) });
        save_index(&index_path(dir.path()), photos).unwrap();
        let back = load_index(dir.path());
        assert_eq!((back["a.jpg"].iso, back["a.jpg"].noise), (Some(6400), Some(0.0042)));
        let mut files = vec![scanned("a.jpg", 10, 1, Kind::Jpeg)];
        apply_index(&back, &mut files);
        assert_eq!((files[0].iso, files[0].noise), (Some(6400), Some(0.0042)));
    }

    #[test]
    fn plan_38_facts_round_trip_flat_and_reach_an_unchanged_file() {
        let stats = photobook_develop::stats::PhotoStats {
            sharpness: 12.5,
            sharpness_max: 80.25,
            sharpest_tile: 19,
            motion: 0.125,
            clip_high: 0.02,
            clip_low: 0.0,
            median_lum: 0.5,
        };
        let facts = PhotoFacts {
            taken: Some(1_791_885_600_050),
            make: Some("Fujifilm".into()),
            model: Some("X-T5".into()),
            lens: Some("XF23mmF1.4 R LM WR".into()),
            focal: Some(23.0),
            phash: Some("0d3d5cd915da4734".into()),
            stats: Some(stats),
            shutter: Some(0.004),
            aperture: Some(1.4),
            gps: photobook_develop::decode::Gps::valid(38.71, -9.14),
            palette: Some(["#1f3a5f", "#d8c3a5", "#8e8d8a", "#e98074", "#e85a4f"].map(String::from).to_vec()),
        };
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(LIBRARY_DIR)).unwrap();
        let mut photos = PhotoIndex::new();
        photos.insert("a.jpg".into(), IndexEntry { facts: facts.clone(), ..indexed('a', 10, 1) });
        photos.insert("b.jpg".into(), indexed('b', 20, 2));
        save_index(&index_path(dir.path()), photos).unwrap();
        let text = fs::read_to_string(index_path(dir.path())).unwrap();
        // Flat on the entry, camelCase, and absent when unknown.
        assert!(text.contains(r#""taken":1791885600050,"make":"Fujifilm""#), "{text}");
        assert!(text.contains(r#""stats":{"sharpness":12.5,"sharpnessMax":80.25,"sharpestTile":19"#), "{text}");
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(json["photos"]["b.jpg"].get("taken").is_none() && json["photos"]["b.jpg"].get("stats").is_none());
        let back = load_index(dir.path());
        assert_eq!(back["a.jpg"].facts, facts);
        assert_eq!(back["b.jpg"].facts, PhotoFacts::default());
        let mut files = vec![scanned("a.jpg", 10, 1, Kind::Jpeg), scanned("b.jpg", 21, 2, Kind::Jpeg)];
        apply_index(&back, &mut files);
        assert_eq!(files[0].facts, facts);
        assert_eq!(files[1].facts, PhotoFacts::default());
        let json = serde_json::to_value(&files[0]).unwrap();
        assert_eq!((json["phash"].as_str(), json["focal"].as_f64()), (Some("0d3d5cd915da4734"), Some(23.0)));
        assert_eq!(json["palette"][0].as_str(), Some("#1f3a5f"));
    }

    #[test]
    fn an_index_as_the_webview_writes_it_parses_through_the_flattened_facts() {
        // JSON numbers as JavaScript writes them (`23`, not `23.0`), optional fields absent on the second entry.
        let text = format!(
            r#"{{"version":1,"photos":{{"a.jpg":{{"hash":"{a}","size":10,"mtime":1,"kind":"jpeg","iso":200,"taken":1791885600050,"make":"Fujifilm","lens":"XF23","focal":23,"phash":"0d3d5cd915da4734","stats":{{"sharpness":12,"sharpnessMax":80.5,"sharpestTile":19,"motion":0.1,"clipHigh":0,"clipLow":0,"medianLum":0.5}}}},"b.jpg":{{"hash":"{b}","size":20,"mtime":2,"kind":"png"}}}}}}"#,
            a = "a".repeat(64),
            b = "b".repeat(64)
        );
        let photos = parse_index(&text).unwrap();
        let a = &photos["a.jpg"];
        assert_eq!((a.iso, a.facts.taken, a.facts.focal), (Some(200), Some(1_791_885_600_050), Some(23.0)));
        assert_eq!((a.facts.make.as_deref(), a.facts.model.as_deref()), (Some("Fujifilm"), None));
        assert_eq!(a.facts.stats.map(|s| (s.sharpness, s.sharpest_tile)), Some((12.0, 19)));
        assert_eq!(photos["b.jpg"].facts, PhotoFacts::default());
        assert_eq!(photos["b.jpg"].kind, Kind::Png);
    }

    #[test]
    fn the_index_round_trips_and_drops_bad_entries() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(LIBRARY_DIR)).unwrap();
        assert!(load_index(dir.path()).is_empty(), "no index yet");
        let mut photos = PhotoIndex::new();
        photos.insert("a.jpg".into(), indexed('a', 10, 1));
        photos.insert("trip/b.jpg".into(), indexed('b', 20, 2));
        photos.insert("../escape.jpg".into(), indexed('c', 30, 3));
        photos.insert("short-hash.jpg".into(), IndexEntry { hash: "abc".into(), ..indexed('d', 40, 4) });
        assert_eq!(save_index(&index_path(dir.path()), photos).unwrap(), 2);
        let back = load_index(dir.path());
        assert_eq!(back.keys().collect::<Vec<_>>(), ["a.jpg", "trip/b.jpg"]);
        assert_eq!(back["a.jpg"], indexed('a', 10, 1));
        let text = fs::read_to_string(index_path(dir.path())).unwrap();
        assert!(text.starts_with("{\"version\":1,") && !text.contains("\"iso\""), "{text}");
        // Only the index in .photobook: the temp file was renamed over it.
        assert_eq!(fs::read_dir(dir.path().join(LIBRARY_DIR)).unwrap().count(), 1);
    }

    #[test]
    fn index_hashes_are_lowercase_hex() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(LIBRARY_DIR)).unwrap();
        let mut photos = PhotoIndex::new();
        photos.insert("upper.jpg".into(), IndexEntry { hash: "AB".repeat(32), ..indexed('a', 1, 1) });
        photos.insert("not-hex.jpg".into(), IndexEntry { hash: "g".repeat(64), ..indexed('a', 1, 1) });
        assert_eq!(save_index(&index_path(dir.path()), photos).unwrap(), 1);
        assert_eq!(load_index(dir.path())["upper.jpg"].hash, "ab".repeat(32));
        // An index written elsewhere with uppercase hashes is read in lowercase.
        let text = format!(
            "{{\"version\":1,\"photos\":{{\"x.jpg\":{{\"hash\":\"{}\",\"size\":1,\"mtime\":1,\"kind\":\"jpeg\"}}}}}}",
            "CD".repeat(32)
        );
        assert_eq!(parse_index(&text).unwrap()["x.jpg"].hash, "cd".repeat(32));
    }

    #[test]
    fn a_corrupt_or_newer_index_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(LIBRARY_DIR)).unwrap();
        for junk in ["{not json", "[]", "{\"version\":2,\"photos\":{}}", "{\"photos\":{}}"] {
            fs::write(index_path(dir.path()), junk).unwrap();
            assert!(load_index(dir.path()).is_empty(), "{junk:?}");
        }
    }

    #[test]
    fn scanned_files_take_their_entry_only_while_size_mtime_and_kind_match() {
        let mut index = PhotoIndex::new();
        index.insert("same.jpg".into(), indexed('a', 10, 1));
        index.insert("edited.jpg".into(), indexed('b', 20, 2));
        index.insert("touched.jpg".into(), indexed('c', 30, 3));
        index.insert("renamed.png".into(), indexed('d', 40, 4));
        let mut files = vec![
            scanned("same.jpg", 10, 1, Kind::Jpeg),
            scanned("edited.jpg", 21, 2, Kind::Jpeg),
            scanned("touched.jpg", 30, 99, Kind::Jpeg),
            scanned("renamed.png", 40, 4, Kind::Png),
            scanned("new.jpg", 50, 5, Kind::Jpeg),
        ];
        assert_eq!(apply_index(&index, &mut files), 1);
        assert_eq!(files[0].hash.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!((files[0].width, files[0].height, files[0].orientation), (Some(1200), Some(800), Some(6)));
        assert!(files[1..].iter().all(|f| f.hash.is_none() && f.width.is_none()));
        let json = serde_json::to_value(&files[4]).unwrap();
        assert!(json.get("hash").is_none() && json.get("iso").is_none(), "{json}");
        assert_eq!(serde_json::to_value(&files[0]).unwrap()["hash"], "a".repeat(64));
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(valid_name("  Lisbon  ").unwrap(), "Lisbon");
        assert!(valid_name("   ").is_err());
        assert!(valid_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert_eq!(default_name(Path::new("/photos/Porto")), "Porto");
    }
}
