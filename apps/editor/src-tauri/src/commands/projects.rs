//! Projects (workflow plan 04): a project is one `project.photobook.json`, the book document of `BookSchema` in
//! `packages/shared/src/schema.ts` (Rust only checks that it is a JSON object, and reads a few fields for the list).
//!
//! - In app data: `<appdata>/projects/<ULID>/project.photobook.json` (+ `.bak`). The directory listing is the registry
//!   of these; the directory name is the project id. The publish CLI's work dir `.photobook-publish/` lands next to
//!   the file, inside the project directory.
//! - Anywhere else (Save as, Open project file…): remembered in `<appdata>/projects.json` as `[{ id, path }]`. An id
//!   listed there wins over an app data directory of the same name.
//! - `recent.json` is `{ project: id, opened: { id: epoch ms } }` (the last opened project, and when each was last
//!   opened, for the Home list). An old `{ folder }` file resolves to the newest project on that folder.
//!
//! Commands: `list_projects`, `create_project(id, json)` (the webview builds the document with `createEmptyBook`, so
//! the Zod schema stays the only definition; every folder it names must be imported), `read_project(id)`,
//! `write_project(id, json)` (temp file + rename, the previous version kept as `.bak`), `delete_project(id)` (moves
//! the project directory, or an external file and its `.bak`, to the system Trash; never a permanent delete),
//! `save_project_as(id, path, json)` (the file now lives at `path`, picked in the save dialog; an app data directory
//! goes to the Trash), `open_project_file(path)` (picked in the open dialog), `import_legacy_book(folderId)`,
//! `get_recent`, `set_recent(id)`, `reveal_project(id)`.
//!
//! Legacy import: a `<folder>/book.photobook.json` (the project file before plan 04) found when a folder is imported
//! or at startup for every registry folder becomes a project in app data, keeping its book id as the project id when
//! that is free. Its folder path is rewritten to the folder it was found in (it follows a moved folder). The old file
//! is renamed `book.photobook.json.imported`, so it is never imported twice; a project already imported from that
//! folder with the same id only retries the rename. A file listed in `projects.json` (saved there with Save as) is
//! never treated as legacy.
//!
//! Scope: app data is always allowed; an external path only when the native dialog picked it in this session (the
//! dialog plugin adds it to the fs scope) or it is already listed in `projects.json`. The folders inside a project
//! are never trusted from its content: they must be imported (`folders.json`) for any command to read them.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::atomic::{atomic_write, backup_path, write_with_backup};
use crate::commands::assets::{cache_entry_dir, cache_root, THUMB_FILE};
use crate::commands::folders::{self, new_ulid, now_ms, FolderEntry};
use crate::commands::presets::is_ulid;
use crate::error::{Error, IoContext, Result};
use crate::scope::{self, ImportedRoots};

pub const PROJECTS_DIR: &str = "projects";
pub const PROJECT_FILE_NAME: &str = "project.photobook.json";
pub const EXTERNAL_FILE_NAME: &str = "projects.json";
/// The project file inside a photo folder before plan 04.
pub const LEGACY_BOOK_FILE_NAME: &str = "book.photobook.json";
const IMPORTED_SUFFIX: &str = "imported";
const RECENT_FILE_NAME: &str = "recent.json";
const CORRUPT_SUFFIX: &str = "corrupt";

/// Serializes every read-modify-write of `projects.json`, `recent.json` and the project directories.
static LOCK: Mutex<()> = Mutex::new(());

/// A project saved outside app data, as stored in `projects.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ExternalEntry {
    pub id: String,
    /// Canonical absolute path of the project file.
    pub path: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Recent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(default)]
    opened: BTreeMap<String, u64>,
    /// The pre-plan-04 shape (`{ folder }`): read once, never written.
    #[serde(default, skip_serializing)]
    folder: Option<String>,
}

/// A folder a project draws from, as the Home list shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolder {
    /// The folder id inside the project (`book.folders`); empty for a pre-v8 file.
    pub id: String,
    pub path: String,
    /// The registry name when the folder is imported, else the last path component.
    pub name: String,
    /// In the folders registry (`folders.json`), so the project's photos are in scope.
    pub imported: bool,
    /// Not on disk now.
    pub missing: bool,
}

/// One project in `list_projects`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    /// The project file.
    pub path: String,
    /// Saved outside app data (listed in `projects.json`).
    pub external: bool,
    pub title: String,
    pub folders: Vec<ProjectFolder>,
    /// Epoch ms the file was last written.
    pub updated_at: u64,
    /// Epoch ms the project was last opened in the editor, if ever.
    pub opened_at: Option<u64>,
    /// Content hash of the first photo on the first page that has one (the cover).
    pub cover_hash: Option<String>,
    /// The cover's cached thumbnail (`<appdata>/cache/<hash>/thumb.jpg`) when it exists.
    pub cover_thumb: Option<String>,
    /// Why the file could not be read (missing, not JSON); the project is still listed so it can be deleted.
    pub error: Option<String>,
}

/// Where a project's file is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Location {
    AppData { dir: PathBuf },
    External { file: PathBuf },
}

impl Location {
    pub fn file(&self) -> PathBuf {
        match self {
            Location::AppData { dir } => dir.join(PROJECT_FILE_NAME),
            Location::External { file } => file.clone(),
        }
    }

    fn is_external(&self) -> bool {
        matches!(self, Location::External { .. })
    }
}

/// What a summary needs besides the file: the folders registry, the thumbnail cache and the opened times.
pub struct SummaryContext<'a> {
    pub registry: &'a [FolderEntry],
    pub cache: Option<&'a Path>,
    pub opened: &'a BTreeMap<String, u64>,
}

/// The project files under one app data dir. No app handle, so tests run it on a temp dir; callers hold [`LOCK`]
/// around anything that writes.
pub struct Store {
    app_data: PathBuf,
}

impl Store {
    pub fn new(app_data: PathBuf) -> Self {
        Store { app_data }
    }

    fn projects_dir(&self) -> PathBuf {
        self.app_data.join(PROJECTS_DIR)
    }

    fn externals_file(&self) -> PathBuf {
        self.app_data.join(EXTERNAL_FILE_NAME)
    }

    fn recent_file(&self) -> PathBuf {
        self.app_data.join(RECENT_FILE_NAME)
    }

    pub fn externals(&self) -> Vec<ExternalEntry> {
        load_externals(&self.externals_file())
    }

    fn save_externals(&self, entries: &[ExternalEntry]) -> Result<()> {
        let json = serde_json::to_vec_pretty(entries).map_err(|err| Error::Invalid(err.to_string()))?;
        atomic_write(&self.externals_file(), &json)
    }

    /// The ids of the project directories in app data (ULID names holding a project file).
    fn app_data_ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.projects_dir()) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| is_ulid(name) && self.projects_dir().join(name).join(PROJECT_FILE_NAME).is_file())
            .collect();
        ids.sort();
        ids
    }

    /// True when `id` names no project (no app data directory, no external entry).
    fn is_free(&self, id: &str, externals: &[ExternalEntry]) -> bool {
        !self.projects_dir().join(id).exists() && !externals.iter().any(|e| e.id == id)
    }

    pub fn locate(&self, id: &str) -> Result<Location> {
        locate(&self.projects_dir(), &self.externals(), id)
    }

    pub fn list(&self, registry: &[FolderEntry], cache: Option<&Path>) -> Vec<ProjectSummary> {
        let externals = self.externals();
        let recent = self.read_recent();
        let context = SummaryContext { registry, cache, opened: &recent.opened };
        let mut out: Vec<ProjectSummary> = self
            .app_data_ids()
            .into_iter()
            .filter(|id| !externals.iter().any(|e| &e.id == id))
            .map(|id| {
                let dir = self.projects_dir().join(&id);
                summarize(&id, &Location::AppData { dir }, &context)
            })
            .collect();
        for entry in &externals {
            out.push(summarize(&entry.id, &Location::External { file: PathBuf::from(&entry.path) }, &context));
        }
        out.sort_by(|a, b| {
            b.opened_at.cmp(&a.opened_at).then(b.updated_at.cmp(&a.updated_at)).then(a.id.cmp(&b.id))
        });
        out
    }

    pub fn summary(&self, id: &str, registry: &[FolderEntry], cache: Option<&Path>) -> Result<ProjectSummary> {
        let location = self.locate(id)?;
        let recent = self.read_recent();
        Ok(summarize(id, &location, &SummaryContext { registry, cache, opened: &recent.opened }))
    }

    /// Write a new project in app data. `json` must be an object; `id` a ULID no project uses yet.
    pub fn create(&self, id: &str, json: &str) -> Result<()> {
        parse_object(json)?;
        if !is_ulid(id) {
            return Err(Error::Invalid(format!("Invalid project id {id:?}")));
        }
        if !self.is_free(id, &self.externals()) {
            return Err(Error::Invalid(format!("A project with id {id} exists already")));
        }
        let dir = self.projects_dir().join(id);
        fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
        atomic_write(&dir.join(PROJECT_FILE_NAME), json.as_bytes()).inspect_err(|_| {
            let _ = fs::remove_dir(&dir);
        })
    }

    pub fn read(&self, id: &str) -> Result<String> {
        let file = self.locate(id)?.file();
        fs::read_to_string(&file).ctx(format!("reading {}", file.display()))
    }

    /// Replace the project file (temp + rename, `.bak` kept). The project must exist: a deleted one is not recreated.
    pub fn write(&self, id: &str, json: &str) -> Result<()> {
        parse_object(json)?;
        let file = self.locate(id)?.file();
        if file.parent().is_none_or(|dir| !dir.is_dir()) {
            return Err(Error::Invalid(format!("The folder of {} is gone", file.display())));
        }
        write_with_backup(&file, json.as_bytes())
    }

    /// Move the project to the Trash (`trash`): its app data directory, or an external file and its `.bak` (the entry
    /// in `projects.json` is dropped) plus an app data directory of the same id that a failed trash in `save_as` left
    /// behind. Clears recent.json when it named the project.
    pub fn delete(&self, id: &str, trash: impl Fn(&Path) -> Result<()>) -> Result<()> {
        match self.locate(id)? {
            Location::AppData { dir } => trash(&dir)?,
            Location::External { file } => {
                if file.exists() {
                    trash(&file)?;
                }
                let bak = backup_path(&file);
                if bak.exists() {
                    trash(&bak)?;
                }
                let leftover = self.projects_dir().join(id);
                if leftover.exists() {
                    trash(&leftover)?;
                }
                let externals: Vec<_> = self.externals().into_iter().filter(|e| e.id != id).collect();
                self.save_externals(&externals)?;
            }
        }
        let mut recent = self.read_recent();
        let was_recent = recent.project.as_deref() == Some(id);
        if was_recent {
            recent.project = None;
        }
        if recent.opened.remove(id).is_some() || was_recent {
            self.write_recent(&recent)?;
        }
        Ok(())
    }

    /// Save as: write `json` to `target` (canonical), remember it in `projects.json` for `id`, and move an app data
    /// directory the project leaves to the Trash. An external file the project leaves stays where it is.
    pub fn save_as(&self, id: &str, target: &Path, json: &str, trash: impl Fn(&Path) -> Result<()>) -> Result<()> {
        parse_project(json)?;
        if !target.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")) {
            return Err(Error::Invalid(format!("{} is not a .json file name", target.display())));
        }
        let location = self.locate(id)?;
        if scope::is_within(target, &self.projects_dir()) {
            return Err(Error::Invalid("Choose a place outside the app's own projects folder".into()));
        }
        let mut externals = self.externals();
        if externals.iter().any(|e| e.id != id && Path::new(&e.path) == target) {
            return Err(Error::Invalid(format!("{} is another project's file", target.display())));
        }
        write_with_backup(target, json.as_bytes())?;
        externals.retain(|e| e.id != id);
        externals.push(ExternalEntry { id: id.to_string(), path: target.to_string_lossy().into_owned() });
        self.save_externals(&externals)?;
        if let Location::AppData { dir } = location {
            // The project now lives at `target`; a directory that cannot be trashed is hidden by the entry above.
            if let Err(err) = trash(&dir) {
                log::info!("[photobook:projects] could not move {} to the Trash: {err}", dir.display());
            }
        }
        log::info!("[photobook:projects] saved {id} as {}", target.display());
        Ok(())
    }

    /// Open a project file from anywhere (`file` canonical): the id of a file already known, else a new external
    /// entry whose id is the book's own id when that is free.
    pub fn open_file(&self, file: &Path) -> Result<String> {
        if let Some(id) = self.id_of_file(file) {
            return Ok(id);
        }
        let text = fs::read_to_string(file).ctx(format!("reading {}", file.display()))?;
        let value = parse_project(&text)?;
        let mut externals = self.externals();
        let id = free_id(book_id(&value), |id| self.is_free(id, &externals));
        externals.push(ExternalEntry { id: id.clone(), path: file.to_string_lossy().into_owned() });
        self.save_externals(&externals)?;
        log::info!("[photobook:projects] opened {} as project {id}", file.display());
        Ok(id)
    }

    /// The id of the project whose file is `file`: an app data project or an external entry.
    fn id_of_file(&self, file: &Path) -> Option<String> {
        if let Some(entry) = self.externals().into_iter().find(|e| Path::new(&e.path) == file) {
            return Some(entry.id);
        }
        let dir = file.parent()?;
        let id = dir.file_name()?.to_str()?;
        (file.file_name()? == PROJECT_FILE_NAME && dir.parent()? == self.projects_dir() && is_ulid(id))
            .then(|| id.to_string())
    }

    /// Turn `<root>/book.photobook.json` into a project in app data (see the module doc). `root` is canonical.
    /// Returns the project id, or `None` when there is nothing to import.
    pub fn import_legacy(&self, root: &Path) -> Result<Option<String>> {
        let file = root.join(LEGACY_BOOK_FILE_NAME);
        if !file.is_file() {
            return Ok(None);
        }
        let canonical = file.canonicalize().unwrap_or_else(|_| file.clone());
        let externals = self.externals();
        if externals.iter().any(|e| Path::new(&e.path) == canonical) {
            return Ok(None);
        }
        let text = fs::read_to_string(&file).ctx(format!("reading {}", file.display()))?;
        let mut value = parse_object(&text).map_err(|err| Error::Invalid(format!("{}: {err}", file.display())))?;
        let root_str = root.to_string_lossy().into_owned();
        relocate(&mut value, &root_str);

        // Imported before, but the rename did not happen: only retry it.
        if let Some(id) = book_id(&value).filter(|id| is_ulid(id)) {
            let existing = self.projects_dir().join(id).join(PROJECT_FILE_NAME);
            let same = fs::read_to_string(&existing)
                .ok()
                .and_then(|t| parse_object(&t).ok())
                .is_some_and(|v| folder_paths(&v).iter().any(|p| p == &root_str));
            if same {
                let id = id.to_string();
                match mark_imported(&file) {
                    Ok(_) => log::info!("[photobook:projects] {} was already imported as project {id}", file.display()),
                    Err(err) => log_not_renamed(&file, &id, &err),
                }
                return Ok(Some(id));
            }
        }

        let id = free_id(book_id(&value), |id| self.is_free(id, &externals));
        let json = serde_json::to_vec_pretty(&value).map_err(|err| Error::Invalid(err.to_string()))?;
        let dir = self.projects_dir().join(&id);
        fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
        atomic_write(&dir.join(PROJECT_FILE_NAME), &json)?;
        // The project exists from here on: a folder where the old file cannot be renamed (read-only) still opens it,
        // and the next import only retries the rename (the "already imported" case above).
        match mark_imported(&file) {
            Ok(renamed) => log::info!(
                "[photobook:projects] imported legacy book {} as project {id}; the old file is now {}",
                file.display(),
                renamed.display()
            ),
            Err(err) => log_not_renamed(&file, &id, &err),
        }
        Ok(Some(id))
    }

    fn read_recent(&self) -> Recent {
        fs::read_to_string(self.recent_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn write_recent(&self, recent: &Recent) -> Result<()> {
        let json = serde_json::to_vec_pretty(recent).map_err(|err| Error::Invalid(err.to_string()))?;
        atomic_write(&self.recent_file(), &json)
    }

    /// The last opened project if it still exists. A pre-plan-04 `{ folder }` resolves to the newest app data project
    /// that draws from that folder (its legacy book imported at startup).
    pub fn recent(&self) -> Option<String> {
        let recent = self.read_recent();
        if let Some(id) = recent.project {
            return self.locate(&id).ok().filter(|l| l.file().is_file()).map(|_| id);
        }
        let folder = recent.folder?;
        let mut best: Option<(u64, String)> = None;
        for id in self.app_data_ids() {
            let file = self.projects_dir().join(&id).join(PROJECT_FILE_NAME);
            let Some(value) = fs::read_to_string(&file).ok().and_then(|t| parse_object(&t).ok()) else { continue };
            if folder_paths(&value).iter().any(|p| p == &folder) {
                let at = mtime_ms(&file);
                if best.as_ref().is_none_or(|(t, _)| at > *t) {
                    best = Some((at, id));
                }
            }
        }
        best.map(|(_, id)| id)
    }

    /// Remember `id` as the last opened project, now.
    pub fn set_recent(&self, id: &str, now: u64) -> Result<()> {
        self.locate(id)?;
        let mut recent = self.read_recent();
        recent.folder = None;
        recent.project = Some(id.to_string());
        recent.opened.insert(id.to_string(), now);
        let gone: Vec<String> = recent.opened.keys().filter(|k| self.locate(k).is_err()).cloned().collect();
        for gone in gone {
            recent.opened.remove(&gone);
        }
        self.write_recent(&recent)
    }
}

/// `id` in `projects.json` or as a directory under `projects_dir`.
fn locate(projects_dir: &Path, externals: &[ExternalEntry], id: &str) -> Result<Location> {
    if !is_ulid(id) {
        return Err(Error::Invalid(format!("Invalid project id {id:?}")));
    }
    if let Some(entry) = externals.iter().find(|e| e.id == id) {
        return Ok(Location::External { file: PathBuf::from(&entry.path) });
    }
    let dir = projects_dir.join(id);
    if dir.join(PROJECT_FILE_NAME).is_file() {
        return Ok(Location::AppData { dir });
    }
    Err(Error::Invalid(format!("No project with id {id}")))
}

/// Read `projects.json`: empty when missing; empty, logged and moved aside when it is not a valid list. Entries with an
/// invalid id or a relative path, and later duplicates of an id or a path, are dropped.
fn load_externals(file: &Path) -> Vec<ExternalEntry> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(err) => {
            log::info!("[photobook:projects] {} is unreadable: {err}", file.display());
            return Vec::new();
        }
    };
    match serde_json::from_str::<Vec<ExternalEntry>>(&text) {
        Ok(entries) => {
            let mut out: Vec<ExternalEntry> = Vec::with_capacity(entries.len());
            for entry in entries {
                let valid = is_ulid(&entry.id) && Path::new(&entry.path).is_absolute();
                if !valid || out.iter().any(|e| e.id == entry.id || e.path == entry.path) {
                    log::info!(
                        "[photobook:projects] dropped entry {:?} ({:?}) from {EXTERNAL_FILE_NAME}",
                        entry.id,
                        entry.path
                    );
                    continue;
                }
                out.push(entry);
            }
            out
        }
        Err(err) => {
            let aside = file.with_file_name(format!("{EXTERNAL_FILE_NAME}.{CORRUPT_SUFFIX}-{}", now_ms()));
            let moved = fs::rename(file, &aside).is_ok();
            log::info!(
                "[photobook:projects] {} is not a valid list ({err}); starting empty{}",
                file.display(),
                if moved { format!(", old file kept as {}", aside.display()) } else { String::new() }
            );
            Vec::new()
        }
    }
}

/// `parse_object` that also requires the shape of a project file (`version` a number, `pages` an array), for files
/// the user picked: a stray JSON file is refused instead of being registered as a project.
fn parse_project(text: &str) -> Result<Value> {
    let value = parse_object(text)?;
    let shaped = value.get("version").is_some_and(Value::is_number) && value.get("pages").is_some_and(Value::is_array);
    if !shaped {
        return Err(Error::Invalid("Not a Photobook project file: it has no version or pages".into()));
    }
    Ok(value)
}

fn parse_object(text: &str) -> Result<Value> {
    let value: Value =
        serde_json::from_str(text).map_err(|err| Error::Invalid(format!("Not a valid project file: {err}")))?;
    if !value.is_object() {
        return Err(Error::Invalid("Not a valid project file: expected a JSON object".into()));
    }
    Ok(value)
}

fn book_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}

/// `preferred` when it is a ULID and `free`, else a new ULID.
fn free_id(preferred: Option<&str>, free: impl Fn(&str) -> bool) -> String {
    match preferred {
        Some(id) if is_ulid(id) && free(id) => id.to_string(),
        _ => loop {
            let id = new_ulid(now_ms());
            if free(&id) {
                break id;
            }
        },
    }
}

/// The folder paths a project file draws from: `folders[*].path` (v8), else `sourceFolder` (older files).
pub fn folder_paths(value: &Value) -> Vec<String> {
    folder_entries(value).into_iter().map(|(_, path)| path).collect()
}

fn folder_entries(value: &Value) -> Vec<(String, String)> {
    if let Some(folders) = value.get("folders").and_then(Value::as_object) {
        return folders
            .iter()
            .filter_map(|(id, f)| f.get("path").and_then(Value::as_str).map(|p| (id.clone(), p.to_string())))
            .collect();
    }
    value.get("sourceFolder").and_then(Value::as_str).map(|p| vec![(String::new(), p.to_string())]).unwrap_or_default()
}

/// Point a legacy book at the folder it was found in: `sourceFolder` (pre-v8), or the one entry of `folders`.
fn relocate(value: &mut Value, root: &str) {
    let Some(object) = value.as_object_mut() else { return };
    if object.contains_key("sourceFolder") {
        object.insert("sourceFolder".into(), Value::String(root.to_string()));
    }
    if let Some(folders) = object.get_mut("folders").and_then(Value::as_object_mut) {
        if folders.len() == 1 {
            if let Some(entry) = folders.values_mut().next().and_then(Value::as_object_mut) {
                entry.insert("path".into(), Value::String(root.to_string()));
            }
        }
    }
}

/// The content hash of the cover: the first photo (background or photo element) on the earliest page that has one.
pub fn cover_hash(value: &Value) -> Option<String> {
    let assets = value.get("assets").and_then(Value::as_object);
    let hash_of = |id: &str| -> Option<String> {
        assets?.get(id)?.get("hash")?.as_str().map(str::to_string)
    };
    for page in value.get("pages").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = page.get("background").and_then(|b| b.get("asset")).and_then(Value::as_str) {
            if let Some(hash) = hash_of(id) {
                return Some(hash);
            }
        }
        for el in page.get("elements").and_then(Value::as_array).into_iter().flatten() {
            if el.get("type").and_then(Value::as_str) != Some("photo") {
                continue;
            }
            if let Some(hash) = el.get("asset").and_then(Value::as_str).and_then(hash_of) {
                return Some(hash);
            }
        }
    }
    None
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// The Home list entry for the project at `location`. A file that cannot be read or parsed still gives an entry,
/// with `error` set.
pub fn summarize(id: &str, location: &Location, context: &SummaryContext) -> ProjectSummary {
    let file = location.file();
    let mut summary = ProjectSummary {
        id: id.to_string(),
        path: file.to_string_lossy().into_owned(),
        external: location.is_external(),
        title: String::new(),
        folders: Vec::new(),
        updated_at: mtime_ms(&file),
        opened_at: context.opened.get(id).copied(),
        cover_hash: None,
        cover_thumb: None,
        error: None,
    };
    let value = match fs::read_to_string(&file) {
        Ok(text) => parse_object(&text),
        Err(err) => Err(Error::Io(format!("reading {}", file.display()), err)),
    };
    let value = match value {
        Ok(value) => value,
        Err(err) => {
            summary.title = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            summary.error = Some(err.to_string());
            return summary;
        }
    };
    summary.title = value.get("title").and_then(Value::as_str).unwrap_or("Untitled").to_string();
    summary.folders = folder_entries(&value)
        .into_iter()
        .map(|(folder_id, path)| {
            let entry = context.registry.iter().find(|f| f.path == path);
            ProjectFolder {
                id: folder_id,
                name: entry.map(|f| f.name.clone()).unwrap_or_else(|| folder_name(&path)),
                imported: entry.is_some(),
                missing: !Path::new(&path).is_dir(),
                path,
            }
        })
        .collect();
    summary.cover_hash = cover_hash(&value);
    if let (Some(hash), Some(cache)) = (&summary.cover_hash, context.cache) {
        let thumb = cache_entry_dir(cache, hash).ok().map(|dir| dir.join(THUMB_FILE)).filter(|p| p.is_file());
        summary.cover_thumb = thumb.map(|p| p.to_string_lossy().into_owned());
    }
    summary
}

fn log_not_renamed(file: &Path, id: &str, err: &Error) {
    log::info!(
        "[photobook:projects] imported legacy book {} as project {id}, but could not rename it ({err}); it stays in \
         place and is only matched again, never imported twice",
        file.display()
    );
}

/// Rename `<folder>/book.photobook.json` to `book.photobook.json.imported` (or `.imported-<epoch ms>` when that is
/// taken, so an earlier one is never overwritten). Returns the new path.
fn mark_imported(file: &Path) -> Result<PathBuf> {
    let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut target = file.with_file_name(format!("{name}.{IMPORTED_SUFFIX}"));
    if target.exists() {
        target = file.with_file_name(format!("{name}.{IMPORTED_SUFFIX}-{}", now_ms()));
    }
    fs::rename(file, &target).ctx(format!("renaming {}", file.display()))?;
    Ok(target)
}

/// Move `path` to the system Trash. On macOS through `NSFileManager` (the Finder route asks for automation access).
pub fn move_to_trash(path: &Path) -> Result<()> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|err| Error::Invalid(format!("Could not move {} to the Trash: {err}", path.display())))
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store<R: Runtime>(app: &AppHandle<R>) -> Result<Store> {
    Ok(Store::new(scope::app_data_dir(app)?))
}

fn summary_of<R: Runtime>(app: &AppHandle<R>, store: &Store, id: &str) -> Result<ProjectSummary> {
    let cache = cache_root(app).ok();
    store.summary(id, &folders::entries(app), cache.as_deref())
}

/// The project file of `id` (for the publish CLI).
pub fn project_file<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<PathBuf> {
    let _guard = lock();
    Ok(store(app)?.locate(id)?.file())
}

/// True when the native dialog picked `path` in this session (as given or canonical).
fn dialog_picked<R: Runtime>(app: &AppHandle<R>, given: &Path, canonical: &Path) -> bool {
    let scope = app.fs_scope();
    scope.is_allowed(given) || scope.is_allowed(canonical)
}

#[tauri::command]
pub async fn list_projects<R: Runtime>(app: AppHandle<R>) -> Result<Vec<ProjectSummary>> {
    let _guard = lock();
    let cache = cache_root(&app).ok();
    Ok(store(&app)?.list(&folders::entries(&app), cache.as_deref()))
}

/// Create a project in app data from the document the webview built. Every folder it names must be imported.
#[tauri::command]
pub async fn create_project<R: Runtime>(app: AppHandle<R>, id: String, json: String) -> Result<ProjectSummary> {
    let value = parse_object(&json)?;
    let paths = folder_paths(&value);
    if paths.is_empty() {
        return Err(Error::Invalid("A project needs at least one folder".into()));
    }
    let roots = app.state::<ImportedRoots>().roots();
    for path in &paths {
        scope::check_imported_root(Path::new(path), &roots)?;
    }
    let _guard = lock();
    let store = store(&app)?;
    store.create(&id, &json)?;
    log::info!("[photobook:projects] created {id} on {}", paths.join(", "));
    summary_of(&app, &store, &id)
}

#[tauri::command]
pub async fn read_project<R: Runtime>(app: AppHandle<R>, id: String) -> Result<String> {
    let _guard = lock();
    store(&app)?.read(&id)
}

#[tauri::command]
pub async fn write_project<R: Runtime>(app: AppHandle<R>, id: String, json: String) -> Result<()> {
    let _guard = lock();
    store(&app)?.write(&id, &json)
}

#[tauri::command]
pub async fn delete_project<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    let _guard = lock();
    store(&app)?.delete(&id, move_to_trash)?;
    log::info!("[photobook:projects] moved {id} to the Trash");
    Ok(())
}

/// Save the open project as `path` (picked in the save dialog) and keep working there.
#[tauri::command]
pub async fn save_project_as<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    path: String,
    json: String,
) -> Result<ProjectSummary> {
    let given = Path::new(&path);
    let target = scope::normalize(given)?;
    let _guard = lock();
    let store = store(&app)?;
    let current = store.locate(&id)?;
    if current.file() != target && !dialog_picked(&app, given, &target) {
        return Err(Error::OutOfScope(path));
    }
    store.save_as(&id, &target, &json, move_to_trash)?;
    summary_of(&app, &store, &id)
}

/// Open a project file picked in the open dialog (or one already known) and return it.
#[tauri::command]
pub async fn open_project_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ProjectSummary> {
    let given = Path::new(&path);
    let file = scope::normalize(given)?;
    let _guard = lock();
    let store = store(&app)?;
    if store.id_of_file(&file).is_none() && !dialog_picked(&app, given, &file) {
        return Err(Error::OutOfScope(path));
    }
    if !file.is_file() {
        return Err(Error::Invalid(format!("{} is not a file", file.display())));
    }
    let id = store.open_file(&file)?;
    summary_of(&app, &store, &id)
}

/// Import the legacy book of a registry folder (see the module doc). `None` when it has none.
#[tauri::command]
pub async fn import_legacy_book<R: Runtime>(app: AppHandle<R>, folder_id: String) -> Result<Option<ProjectSummary>> {
    let entry = folders::find(&app, &folder_id)
        .ok_or_else(|| Error::Invalid(format!("No imported folder with id {folder_id:?}")))?;
    import_legacy(&app, Path::new(&entry.path))
}

/// [`Store::import_legacy`] for an imported folder.
pub fn import_legacy<R: Runtime>(app: &AppHandle<R>, folder: &Path) -> Result<Option<ProjectSummary>> {
    let root = scope::ensure_imported_root(app, &folder.to_string_lossy())?;
    let _guard = lock();
    let store = store(app)?;
    match store.import_legacy(&root)? {
        Some(id) => summary_of(app, &store, &id).map(Some),
        None => Ok(None),
    }
}

/// Startup: import the legacy book of every registry folder that is on disk. Never fails the app.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    for entry in folders::entries(app) {
        if !Path::new(&entry.path).is_dir() {
            continue;
        }
        if let Err(err) = import_legacy(app, Path::new(&entry.path)) {
            log::info!("[photobook:projects] legacy book in {} not imported: {err}", entry.path);
        }
    }
}

/// The last opened project, if it still exists.
#[tauri::command]
pub async fn get_recent<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>> {
    let _guard = lock();
    Ok(store(&app)?.recent())
}

#[tauri::command]
pub async fn set_recent<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    let _guard = lock();
    store(&app)?.set_recent(&id, now_ms())
}

/// Show the project file in the Finder.
#[tauri::command]
pub async fn reveal_project<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    let file = project_file(&app, &id)?;
    reveal(&file)
}

#[cfg(target_os = "macos")]
fn reveal(file: &Path) -> Result<()> {
    let status = std::process::Command::new("/usr/bin/open").arg("-R").arg(file).status().ctx("running open")?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Invalid(format!("open -R {} failed ({status})", file.display())))
    }
}

#[cfg(not(target_os = "macos"))]
fn reveal(file: &Path) -> Result<()> {
    Err(Error::Invalid(format!("Revealing files is only supported on macOS; the project is {}", file.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "01K7A00000000000000000000A";
    const B: &str = "01K7B00000000000000000000B";

    struct Fixture {
        _dir: tempfile::TempDir,
        store: Store,
        base: PathBuf,
        trash: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let app_data = base.join("appdata");
        let trash = base.join("Trash");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&trash).unwrap();
        Fixture { _dir: dir, store: Store::new(app_data), base, trash }
    }

    /// A stand-in for the system Trash: moves the item into `<base>/Trash`.
    fn fake_trash(trash: &Path) -> impl Fn(&Path) -> Result<()> + '_ {
        move |path: &Path| {
            let to = trash.join(path.file_name().unwrap());
            fs::rename(path, &to).ctx("trash")
        }
    }

    fn book(id: &str, title: &str, folder: &Path) -> String {
        serde_json::json!({
            "version": 8,
            "id": id,
            "title": title,
            "folders": { "F1": { "path": folder.to_string_lossy() } },
            "assets": {
                "a1": { "path": "a.jpg", "folder": "F1", "hash": "a".repeat(64) },
                "a2": { "path": "b.jpg", "folder": "F1", "hash": "b".repeat(64) },
            },
            "pages": [
                { "elements": [{ "type": "text" }] },
                { "elements": [{ "type": "photo", "asset": null }, { "type": "photo", "asset": "a2" }] },
            ],
        })
        .to_string()
    }

    fn folder(f: &Fixture, name: &str) -> PathBuf {
        let path = f.base.join(name);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn create_list_read_write_in_app_data() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        f.store.create(B, &book(B, "Carousel", &lisbon)).unwrap();
        assert!(f.store.create(A, &book(A, "Again", &lisbon)).is_err(), "ids are unique");
        assert!(f.store.create("nope", "{}").is_err());
        assert!(f.store.create(B, "[1]").is_err());

        let registry = vec![FolderEntry {
            id: "R".into(),
            path: lisbon.to_string_lossy().into_owned(),
            name: "Lisbon 2026".into(),
            added_at: 1,
            last_seen: 1,
        }];
        let list = f.store.list(&registry, None);
        assert_eq!(list.len(), 2);
        let zine = list.iter().find(|p| p.id == A).unwrap();
        assert_eq!(zine.title, "Zine");
        assert!(!zine.external);
        assert_eq!(zine.folders[0].name, "Lisbon 2026");
        assert!(zine.folders[0].imported && !zine.folders[0].missing);
        assert_eq!(zine.cover_hash.as_deref(), Some("b".repeat(64).as_str()));
        assert_eq!(zine.path, f.store.projects_dir().join(A).join(PROJECT_FILE_NAME).to_string_lossy());

        f.store.write(A, &book(A, "Zine 2", &lisbon)).unwrap();
        assert!(f.store.read(A).unwrap().contains("Zine 2"));
        let bak = backup_path(&f.store.projects_dir().join(A).join(PROJECT_FILE_NAME));
        assert!(fs::read_to_string(bak).unwrap().contains("\"Zine\""));
        // The two projects stay independent.
        assert!(f.store.read(B).unwrap().contains("Carousel"));
        assert!(f.store.write(B, "not json").is_err());
        assert!(f.store.read("01K7C00000000000000000000C").is_err());
    }

    #[test]
    fn recent_and_opened_order_the_list() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        f.store.create(B, &book(B, "Carousel", &lisbon)).unwrap();
        assert_eq!(f.store.recent(), None);
        f.store.set_recent(A, 10).unwrap();
        f.store.set_recent(B, 20).unwrap();
        assert_eq!(f.store.recent().as_deref(), Some(B));
        let ids: Vec<_> = f.store.list(&[], None).into_iter().map(|p| (p.id, p.opened_at)).collect();
        assert_eq!(ids, vec![(B.to_string(), Some(20)), (A.to_string(), Some(10))]);
        assert!(f.store.set_recent("01K7C00000000000000000000C", 30).is_err());
    }

    #[test]
    fn an_old_recent_folder_resolves_to_its_project() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        let old = serde_json::json!({ "folder": lisbon.to_string_lossy() }).to_string();
        fs::write(f.store.recent_file(), old).unwrap();
        assert_eq!(f.store.recent().as_deref(), Some(A));
    }

    #[test]
    fn delete_moves_the_directory_to_the_trash() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        f.store.set_recent(A, 1).unwrap();
        f.store.delete(A, fake_trash(&f.trash)).unwrap();
        assert!(f.trash.join(A).join(PROJECT_FILE_NAME).is_file(), "in the Trash, not gone");
        assert!(f.store.locate(A).is_err());
        assert_eq!(f.store.recent(), None);
        assert!(f.store.list(&[], None).is_empty());
    }

    #[test]
    fn save_as_moves_the_project_out_of_app_data() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        let target = f.base.join("Desktop-zine.photobook.json");
        f.store.save_as(A, &target, &book(A, "Zine", &lisbon), fake_trash(&f.trash)).unwrap();
        assert_eq!(f.store.locate(A).unwrap(), Location::External { file: target.clone() });
        assert!(f.trash.join(A).is_dir(), "the app data copy went to the Trash");
        f.store.write(A, &book(A, "Zine 3", &lisbon)).unwrap();
        assert!(fs::read_to_string(&target).unwrap().contains("Zine 3"));
        let list = f.store.list(&[], None);
        assert_eq!(list.len(), 1);
        assert!(list[0].external);
        // Not into the app's own projects folder.
        let inside = f.store.projects_dir().join("x.json");
        assert!(f.store.save_as(A, &inside, "{}", fake_trash(&f.trash)).is_err());

        // Delete of an external project trashes the file and its backup and forgets it.
        f.store.delete(A, fake_trash(&f.trash)).unwrap();
        assert!(!target.exists() && f.trash.join("Desktop-zine.photobook.json").is_file());
        assert!(f.trash.join("Desktop-zine.photobook.json.bak").is_file());
        assert!(f.store.externals().is_empty());
    }

    #[test]
    fn open_file_registers_it_once_and_keeps_free_book_ids() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        let file = f.base.join("elsewhere.photobook.json");
        fs::write(&file, book(A, "Elsewhere", &lisbon)).unwrap();
        assert_eq!(f.store.open_file(&file).unwrap(), A);
        assert_eq!(f.store.open_file(&file).unwrap(), A, "the same file keeps its id");
        // A copy of the same book gets a fresh id.
        let copy = f.base.join("copy.photobook.json");
        fs::copy(&file, &copy).unwrap();
        let other = f.store.open_file(&copy).unwrap();
        assert_ne!(other, A);
        assert!(is_ulid(&other));
        assert_eq!(f.store.externals().len(), 2);
        // An app data project file maps to its own id.
        f.store.create(B, &book(B, "In app data", &lisbon)).unwrap();
        assert_eq!(f.store.open_file(&f.store.projects_dir().join(B).join(PROJECT_FILE_NAME)).unwrap(), B);
    }

    #[test]
    fn a_legacy_book_imports_exactly_once() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        let legacy = lisbon.join(LEGACY_BOOK_FILE_NAME);
        let v7 = serde_json::json!({
            "version": 7, "id": A, "title": "Old", "sourceFolder": "/moved/away", "assets": {}, "pages": []
        });
        fs::write(&legacy, v7.to_string()).unwrap();

        assert_eq!(f.store.import_legacy(&lisbon).unwrap().as_deref(), Some(A));
        assert!(!legacy.exists());
        assert!(lisbon.join("book.photobook.json.imported").is_file(), "the old file is left behind, renamed");
        let text = f.store.read(A).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["sourceFolder"], Value::String(lisbon.to_string_lossy().into_owned()), "relocated");
        assert_eq!(f.store.import_legacy(&lisbon).unwrap(), None, "nothing left to import");
        assert_eq!(f.store.list(&[], None).len(), 1);

        // The same legacy file put back (the rename failed last time): only the rename is retried.
        fs::write(&legacy, v7.to_string()).unwrap();
        assert_eq!(f.store.import_legacy(&lisbon).unwrap().as_deref(), Some(A));
        assert_eq!(f.store.list(&[], None).len(), 1);
        assert!(!legacy.exists());
        let names: Vec<_> = fs::read_dir(&lisbon).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "the second rename does not overwrite the first: {names:?}");
    }

    #[test]
    fn a_legacy_book_with_a_taken_id_in_another_folder_gets_a_new_id() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        let porto = folder(&f, "porto");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        fs::write(porto.join(LEGACY_BOOK_FILE_NAME), book(A, "Porto copy", &lisbon)).unwrap();
        let id = f.store.import_legacy(&porto).unwrap().unwrap();
        assert_ne!(id, A);
        let value: Value = serde_json::from_str(&f.store.read(&id).unwrap()).unwrap();
        assert_eq!(value["folders"]["F1"]["path"], Value::String(porto.to_string_lossy().into_owned()));
    }

    #[test]
    fn a_file_saved_as_into_a_folder_is_not_legacy() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        let target = lisbon.join(LEGACY_BOOK_FILE_NAME);
        f.store.save_as(A, &target, &book(A, "Zine", &lisbon), fake_trash(&f.trash)).unwrap();
        assert_eq!(f.store.import_legacy(&lisbon).unwrap(), None);
        assert!(target.is_file());
    }

    #[test]
    fn a_legacy_book_that_cannot_be_renamed_still_becomes_one_project() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        let legacy = lisbon.join(LEGACY_BOOK_FILE_NAME);
        fs::write(&legacy, book(A, "Read-only", &lisbon)).unwrap();
        // A read-only folder: the file can be read, not renamed.
        fs::set_permissions(&lisbon, fs::Permissions::from_mode(0o555)).unwrap();
        let first = f.store.import_legacy(&lisbon);
        let second = f.store.import_legacy(&lisbon);
        fs::set_permissions(&lisbon, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(first.unwrap().as_deref(), Some(A));
        assert_eq!(second.unwrap().as_deref(), Some(A), "matched again, not imported twice");
        assert!(legacy.is_file(), "left in place");
        assert_eq!(f.store.list(&[], None).len(), 1);
        // Once the folder is writable the next import renames it.
        assert_eq!(f.store.import_legacy(&lisbon).unwrap().as_deref(), Some(A));
        assert!(!legacy.exists());
    }

    #[test]
    fn only_project_shaped_json_files_open_or_save() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        let stray = f.base.join("package.json");
        fs::write(&stray, r#"{ "name": "not a book", "version": "1.0.0" }"#).unwrap();
        assert!(f.store.open_file(&stray).is_err());
        let no_pages = f.base.join("half.photobook.json");
        fs::write(&no_pages, r#"{ "version": 8 }"#).unwrap();
        assert!(f.store.open_file(&no_pages).is_err());
        assert!(f.store.externals().is_empty(), "nothing registered");

        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        let json = book(A, "Zine", &lisbon);
        assert!(f.store.save_as(A, &f.base.join("zine.txt"), &json, fake_trash(&f.trash)).is_err());
        assert!(f.store.save_as(A, &f.base.join("zine"), &json, fake_trash(&f.trash)).is_err());
        assert!(f.store.save_as(A, &f.base.join("zine.json"), "{}", fake_trash(&f.trash)).is_err());
        assert!(f.store.locate(A).unwrap() == Location::AppData { dir: f.store.projects_dir().join(A) });
        f.store.save_as(A, &f.base.join("zine.JSON"), &json, fake_trash(&f.trash)).unwrap();
    }

    #[test]
    fn deleting_a_saved_as_project_also_trashes_a_leftover_app_data_copy() {
        let f = fixture();
        let lisbon = folder(&f, "lisbon");
        f.store.create(A, &book(A, "Zine", &lisbon)).unwrap();
        let target = f.base.join("zine.photobook.json");
        // The Trash refused the app data copy during Save as: it is left behind, hidden by the external entry.
        f.store.save_as(A, &target, &book(A, "Zine", &lisbon), |_| Err(Error::Invalid("no Trash".into()))).unwrap();
        assert!(f.store.projects_dir().join(A).is_dir());
        assert_eq!(f.store.list(&[], None).len(), 1);
        f.store.delete(A, fake_trash(&f.trash)).unwrap();
        assert!(!f.store.projects_dir().join(A).exists());
        assert!(f.trash.join(A).join(PROJECT_FILE_NAME).is_file());
        assert!(f.trash.join("zine.photobook.json").is_file());
        assert!(f.store.list(&[], None).is_empty());
    }

    #[test]
    fn unreadable_projects_are_listed_with_an_error() {
        let f = fixture();
        let dir = f.store.projects_dir().join(A);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(PROJECT_FILE_NAME), "{ broken").unwrap();
        let list = f.store.list(&[], None);
        assert_eq!(list.len(), 1);
        assert!(list[0].error.is_some());
        // A corrupt projects.json is moved aside, not fatal.
        fs::write(f.store.externals_file(), "{").unwrap();
        assert!(f.store.externals().is_empty());
        assert!(!f.store.externals_file().exists());
    }

    #[test]
    fn cover_prefers_the_earliest_page_with_a_photo() {
        let value: Value = serde_json::json!({
            "assets": { "x": { "hash": "x" }, "y": { "hash": "y" }, "z": {} },
            "pages": [
                { "elements": [{ "type": "photo", "asset": "z" }] },
                { "background": { "asset": "y" }, "elements": [{ "type": "photo", "asset": "x" }] },
            ],
        });
        assert_eq!(cover_hash(&value).as_deref(), Some("y"));
        assert_eq!(cover_hash(&serde_json::json!({ "pages": [] })), None);
    }
}
