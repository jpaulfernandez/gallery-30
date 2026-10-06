//! Path scope for every command that touches the disk.
//!
//! Commands may only read or write inside two roots:
//! - the source folder of the open book, set by `open_book`, and
//! - the app data dir (recent.json now; the thumbnail and proxy cache in step 1.2).
//!
//! `open_book` only accepts a folder the user picked through the native dialog (the dialog
//! plugin adds it to the fs scope) or the folder recorded in recent.json. Every other command
//! resolves its paths through [`ensure_allowed`], which rejects anything outside the roots, and
//! commands that take the book's `folder` require it to be exactly the open root
//! ([`ensure_source_root`]), not a subfolder or the app data dir.
//!
//! The webview has no fs plugin permissions; it reads the source folder only through the asset
//! protocol (the original view). Every folder opened in a session stays readable there: Tauri 2.12
//! scopes cannot drop a pattern again, and forbidding the previous root would stop a book reopened
//! later in the same session from showing its originals. Commands are still bound to the open root.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::error::{Error, IoContext, Result};

/// The source folder of the currently open book (canonical path).
#[derive(Default)]
pub struct SourceScope {
    root: Mutex<Option<PathBuf>>,
}

impl SourceScope {
    pub fn root(&self) -> Option<PathBuf> {
        self.root.lock().expect("scope lock poisoned").clone()
    }

    fn set_root(&self, root: PathBuf) {
        *self.root.lock().expect("scope lock poisoned") = Some(root);
    }
}

pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir).ctx(format!("creating {}", dir.display()))?;
    dir.canonicalize().ctx(format!("resolving {}", dir.display()))
}

/// Canonicalize an absolute path. A path that does not exist yet is resolved through its parent,
/// so a file about to be created can be checked. `..` components are rejected outright.
pub fn normalize(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::Invalid(format!("Expected an absolute path, got {}", path.display())));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::OutOfScope(path.display().to_string()));
    }
    if path.exists() {
        return path.canonicalize().ctx(format!("resolving {}", path.display()));
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => Ok(normalize(parent)?.join(name)),
        _ => Err(Error::Invalid(format!("Invalid path {}", path.display()))),
    }
}

/// True when `path` equals `root` or is below it. Both must already be normalized.
pub fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// Resolve `path` and return it if it lies inside the open source folder or the app data dir.
pub fn ensure_allowed<R: Runtime>(app: &AppHandle<R>, path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = normalize(path.as_ref())?;
    let in_source = app
        .state::<SourceScope>()
        .root()
        .is_some_and(|root| is_within(&path, &root));
    if in_source || is_within(&path, &app_data_dir(app)?) {
        Ok(path)
    } else {
        Err(Error::OutOfScope(path.display().to_string()))
    }
}

/// Resolve `folder` and return it only if it is exactly the open book's source folder.
pub fn ensure_source_root<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf> {
    let path = normalize(Path::new(folder))?;
    if is_root(&path, app.state::<SourceScope>().root().as_deref()) {
        Ok(path)
    } else {
        Err(Error::OutOfScope(path.display().to_string()))
    }
}

/// True when the normalized `path` is the open root itself.
pub fn is_root(path: &Path, root: Option<&Path>) -> bool {
    root.is_some_and(|root| root == path)
}

/// Make `folder` the open book's source folder. `trusted` is the folder from recent.json,
/// which was itself only ever written for a folder that passed this check.
pub fn set_source_root<R: Runtime>(app: &AppHandle<R>, folder: &str, trusted: Option<&Path>) -> Result<PathBuf> {
    let root = normalize(Path::new(folder))?;
    if !root.is_dir() {
        return Err(Error::Invalid(format!("{} is not a folder", root.display())));
    }
    let picked = app.fs_scope().is_allowed(&root);
    let is_recent = trusted.and_then(|p| normalize(p).ok()).is_some_and(|p| p == root);
    let is_current = app.state::<SourceScope>().root().is_some_and(|p| p == root);
    if !(picked || is_recent || is_current) {
        return Err(Error::OutOfScope(root.display().to_string()));
    }

    // The webview reads originals over the asset protocol (see the module doc on why nothing is forbidden).
    app.asset_protocol_scope().allow_directory(&root, true)?;
    app.state::<SourceScope>().set_root(root.clone());
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_relative_and_parent_paths() {
        assert!(normalize(Path::new("photos/a.jpg")).is_err());
        assert!(matches!(normalize(Path::new("/tmp/../etc/passwd")), Err(Error::OutOfScope(_))));
    }

    #[test]
    fn normalize_resolves_files_that_do_not_exist_yet() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let new_file = normalize(&dir.path().join("book.photobook.json")).unwrap();
        assert_eq!(new_file, root.join("book.photobook.json"));
        assert!(is_within(&new_file, &root));
    }

    #[test]
    fn source_root_must_match_exactly() {
        let root = Path::new("/a/book");
        assert!(is_root(Path::new("/a/book"), Some(root)));
        assert!(!is_root(Path::new("/a/book/sub"), Some(root)));
        assert!(!is_root(Path::new("/a"), Some(root)));
        assert!(!is_root(Path::new("/a/book"), None));
    }

    #[test]
    fn is_within_matches_whole_components_only() {
        assert!(is_within(Path::new("/a/book/x.jpg"), Path::new("/a/book")));
        assert!(!is_within(Path::new("/a/bookshelf/x.jpg"), Path::new("/a/book")));
    }
}
