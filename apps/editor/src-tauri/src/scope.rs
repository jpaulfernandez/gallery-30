//! Path scope for every command that touches the disk.
//!
//! Commands may only read or write inside:
//! - the imported folders ([`ImportedRoots`]): every folder in the registry `<appdata>/folders.json`
//!   (`commands/folders.rs`, added at startup) plus any folder imported or opened in this session, and
//! - the app data dir (registry, projects, recent.json, presets, models, the thumbnail and proxy cache).
//!
//! A folder becomes a root only through [`add_root`], which accepts a folder the user picked through the native
//! dialog (the dialog plugin adds it to the fs scope), one the caller vouches for (`trusted`: it is in the
//! registry), or one that is already a root. A project file never makes its folders roots (`commands/projects.rs`).
//! Every other command resolves its paths through [`ensure_allowed`], which rejects anything outside the roots, and
//! commands that take a `folder` argument require it to be exactly one of the roots ([`ensure_imported_root`]), not a
//! subfolder or the app data dir.
//!
//! The webview has no fs plugin permissions; it reads the imported folders only through the asset protocol (the
//! original view). Every root added in a session stays readable there, even after the folder is removed from the
//! registry: Tauri 2.12 scopes cannot drop a pattern again. Commands lose access as soon as the root is removed.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::error::{Error, IoContext, Result};

/// The imported folders (canonical paths) every command is scoped to, besides the app data dir.
#[derive(Default)]
pub struct ImportedRoots {
    roots: Mutex<Vec<PathBuf>>,
}

impl ImportedRoots {
    pub fn roots(&self) -> Vec<PathBuf> {
        self.roots.lock().expect("scope lock poisoned").clone()
    }

    pub fn contains(&self, root: &Path) -> bool {
        self.roots.lock().expect("scope lock poisoned").iter().any(|r| r == root)
    }

    fn insert(&self, root: PathBuf) {
        let mut roots = self.roots.lock().expect("scope lock poisoned");
        if !roots.contains(&root) {
            roots.push(root);
        }
    }

    fn remove(&self, root: &Path) {
        self.roots.lock().expect("scope lock poisoned").retain(|r| r != root);
    }

    /// Remove `path` both as given and normalized (roots are stored canonical, so a symlink or a non-canonical
    /// spelling of a root still drops it). A path that no longer resolves is removed as given.
    fn remove_path(&self, path: &Path) {
        if let Ok(canonical) = normalize(path) {
            self.remove(&canonical);
        }
        self.remove(path);
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

/// Resolve `path` and return it if it lies inside an imported folder or the app data dir.
pub fn ensure_allowed<R: Runtime>(app: &AppHandle<R>, path: impl AsRef<Path>) -> Result<PathBuf> {
    check_allowed(path.as_ref(), &app.state::<ImportedRoots>().roots(), &app_data_dir(app)?)
}

/// [`ensure_allowed`] without an app handle: `roots` and `app_data` must already be normalized.
pub fn check_allowed(path: &Path, roots: &[PathBuf], app_data: &Path) -> Result<PathBuf> {
    let path = normalize(path)?;
    if roots.iter().any(|root| is_within(&path, root)) || is_within(&path, app_data) {
        Ok(path)
    } else {
        Err(Error::OutOfScope(path.display().to_string()))
    }
}

/// Resolve `folder` and return it only if it is exactly one of the imported folders.
pub fn ensure_imported_root<R: Runtime>(app: &AppHandle<R>, folder: &str) -> Result<PathBuf> {
    check_imported_root(Path::new(folder), &app.state::<ImportedRoots>().roots())
}

/// [`ensure_imported_root`] without an app handle: `roots` must already be normalized.
pub fn check_imported_root(folder: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let path = normalize(folder)?;
    if roots.iter().any(|root| *root == path) {
        Ok(path)
    } else {
        Err(Error::OutOfScope(path.display().to_string()))
    }
}

/// Make `folder` an imported root and return its canonical path. Accepted when the user picked it in the native
/// dialog, the caller vouches for it (`trusted`: in the registry), or it is already a root.
pub fn add_root<R: Runtime>(app: &AppHandle<R>, folder: &Path, trusted: bool) -> Result<PathBuf> {
    let roots = app.state::<ImportedRoots>();
    let root = check_new_root(folder, trusted, |root| roots.contains(root) || app.fs_scope().is_allowed(root))?;

    // The webview reads originals over the asset protocol (see the module doc on why nothing is forbidden).
    app.asset_protocol_scope().allow_directory(&root, true)?;
    roots.insert(root.clone());
    Ok(root)
}

/// The checks of [`add_root`] without an app handle. The scope check (`trusted`, or `allowed` on the canonical path)
/// runs before anything else looks at the disk, and its error names `folder` as given, so a path out of scope never
/// reveals whether it is a folder or where a symlink in it resolves.
pub fn check_new_root(folder: &Path, trusted: bool, allowed: impl FnOnce(&Path) -> bool) -> Result<PathBuf> {
    let out_of_scope = || Error::OutOfScope(folder.display().to_string());
    let root = normalize(folder).map_err(|_| out_of_scope())?;
    if !(trusted || allowed(&root)) {
        return Err(out_of_scope());
    }
    if !root.is_dir() {
        return Err(Error::Invalid(format!("{} is not a folder", root.display())));
    }
    Ok(root)
}

/// Stop scoping commands to `root` (a folder removed from the registry). Its asset protocol access stays.
pub fn remove_root<R: Runtime>(app: &AppHandle<R>, root: &Path) {
    app.state::<ImportedRoots>().remove_path(root);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two imported folders side by side plus an app data dir, all canonical, with a sibling that is not imported.
    struct Fixture {
        _dir: tempfile::TempDir,
        a: PathBuf,
        b: PathBuf,
        sibling: PathBuf,
        app_data: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let [a, b, sibling, app_data] = ["lisbon", "porto", "lisbon-2", "appdata"].map(|name| base.join(name));
        for path in [&a, &b, &sibling, &app_data] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::create_dir_all(a.join("sub")).unwrap();
        std::fs::write(a.join("a.jpg"), b"x").unwrap();
        std::fs::write(b.join("b.jpg"), b"x").unwrap();
        std::fs::write(sibling.join("c.jpg"), b"x").unwrap();
        Fixture { _dir: dir, a, b, sibling, app_data }
    }

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
    fn a_path_in_either_imported_root_is_allowed() {
        let f = fixture();
        let roots = [f.a.clone(), f.b.clone()];
        assert_eq!(check_allowed(&f.a.join("a.jpg"), &roots, &f.app_data).unwrap(), f.a.join("a.jpg"));
        assert_eq!(check_allowed(&f.b.join("b.jpg"), &roots, &f.app_data).unwrap(), f.b.join("b.jpg"));
        // A file about to be created, a subfolder and the app data dir are inside too.
        assert!(check_allowed(&f.b.join("new.json"), &roots, &f.app_data).is_ok());
        assert!(check_allowed(&f.a.join("sub"), &roots, &f.app_data).is_ok());
        assert!(check_allowed(&f.app_data.join("folders.json"), &roots, &f.app_data).is_ok());
    }

    #[test]
    fn a_sibling_of_either_root_is_rejected() {
        let f = fixture();
        let roots = [f.a.clone(), f.b.clone()];
        // `lisbon-2` shares a prefix with `lisbon` but is not below it.
        let err = check_allowed(&f.sibling.join("c.jpg"), &roots, &f.app_data).unwrap_err();
        assert!(matches!(err, Error::OutOfScope(_)));
        assert!(check_allowed(&f.sibling, &roots, &f.app_data).is_err());
        assert!(check_allowed(f.a.parent().unwrap(), &roots, &f.app_data).is_err());
        // With no roots at all only app data is reachable.
        assert!(check_allowed(&f.a.join("a.jpg"), &[], &f.app_data).is_err());
    }

    #[test]
    fn parent_components_are_rejected() {
        let f = fixture();
        let roots = [f.a.clone(), f.b.clone()];
        // Would resolve to porto/b.jpg, which is allowed, but `..` is refused before resolving.
        let sneaky = f.a.join("..").join("porto").join("b.jpg");
        assert!(matches!(check_allowed(&sneaky, &roots, &f.app_data), Err(Error::OutOfScope(_))));
        let escape = f.a.join("..").join("lisbon-2").join("c.jpg");
        assert!(matches!(check_allowed(&escape, &roots, &f.app_data), Err(Error::OutOfScope(_))));
        assert!(matches!(check_imported_root(&f.a.join("sub").join(".."), &roots), Err(Error::OutOfScope(_))));
    }

    #[test]
    fn imported_root_must_match_exactly() {
        let f = fixture();
        let roots = [f.a.clone(), f.b.clone()];
        assert_eq!(check_imported_root(&f.a, &roots).unwrap(), f.a);
        assert_eq!(check_imported_root(&f.b, &roots).unwrap(), f.b);
        assert!(matches!(check_imported_root(&f.a.join("sub"), &roots), Err(Error::OutOfScope(_))));
        assert!(check_imported_root(&f.sibling, &roots).is_err());
        assert!(check_imported_root(f.a.parent().unwrap(), &roots).is_err());
        assert!(check_imported_root(&f.app_data, &roots).is_err());
        assert!(check_imported_root(&f.a, &[]).is_err());
    }

    #[test]
    fn imported_roots_insert_once_and_remove() {
        let roots = ImportedRoots::default();
        roots.insert(PathBuf::from("/a"));
        roots.insert(PathBuf::from("/b"));
        roots.insert(PathBuf::from("/a"));
        assert_eq!(roots.roots(), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert!(roots.contains(Path::new("/b")));
        roots.remove(Path::new("/a"));
        assert_eq!(roots.roots(), vec![PathBuf::from("/b")]);
        assert!(!roots.contains(Path::new("/a")));
    }

    #[test]
    fn new_roots_are_scope_checked_before_the_disk() {
        let f = fixture();
        let link = f.app_data.join("link-to-lisbon");
        std::os::unix::fs::symlink(&f.a, &link).unwrap();
        let file = f.a.join("a.jpg");
        let gone = f.a.join("nope");

        // Untrusted: a file, a missing path and a symlink all fail the same way, naming the path as given.
        for path in [&file, &gone, &link, &f.sibling] {
            match check_new_root(path, false, |_| false) {
                Err(Error::OutOfScope(shown)) => assert_eq!(shown, path.display().to_string()),
                other => panic!("{} gave {other:?}", path.display()),
            }
        }
        // `allowed` sees the canonical path (the dialog scope holds canonical paths).
        let mut seen = None;
        assert_eq!(check_new_root(&link, false, |p| { seen = Some(p.to_path_buf()); true }).unwrap(), f.a);
        assert_eq!(seen.as_deref(), Some(f.a.as_path()));
        // Trusted: only then does a non-folder say so.
        assert!(matches!(check_new_root(&file, true, |_| false), Err(Error::Invalid(_))));
        assert!(matches!(check_new_root(&gone, true, |_| false), Err(Error::Invalid(_))));
        assert_eq!(check_new_root(&f.b, true, |_| false).unwrap(), f.b);
        assert!(matches!(check_new_root(Path::new("rel"), true, |_| true), Err(Error::OutOfScope(_))));
    }

    #[test]
    fn removing_a_root_by_another_spelling_drops_it() {
        let f = fixture();
        let link = f.app_data.join("link-to-lisbon");
        std::os::unix::fs::symlink(&f.a, &link).unwrap();
        let roots = ImportedRoots::default();
        roots.insert(f.a.clone());
        roots.insert(f.b.clone());
        // Through a symlink to the root.
        roots.remove_path(&link);
        assert_eq!(roots.roots(), vec![f.b.clone()]);
        // A root whose folder is gone (moved or renamed on disk) is removed as given.
        let gone = f.app_data.join("gone");
        roots.insert(gone.clone());
        roots.remove_path(&gone);
        assert_eq!(roots.roots(), vec![f.b.clone()]);
        // A non-canonical spelling with a `..` cannot normalize, so only an exact match would go: nothing changes.
        roots.remove_path(&f.b.join("..").join("porto"));
        assert_eq!(roots.roots(), vec![f.b.clone()]);
    }

    #[test]
    fn is_within_matches_whole_components_only() {
        assert!(is_within(Path::new("/a/book/x.jpg"), Path::new("/a/book")));
        assert!(!is_within(Path::new("/a/bookshelf/x.jpg"), Path::new("/a/book")));
    }
}
