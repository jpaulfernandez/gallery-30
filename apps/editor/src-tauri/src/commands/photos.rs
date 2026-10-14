//! Plan 42 (CULL_PLAN 4.5): `trash_photos`, the only command that removes photos from an imported folder.
//!
//! It moves files to the system Trash (the `trash` crate through `NSFileManager`, the path Delete project uses:
//! [`projects::move_to_trash`]), never deletes them, so every file can be put back from the Trash. It is reached only
//! through the reject pile's confirm dialog; there is no key for it.
//!
//! Rules, per file, each checked before anything moves:
//! - `folder` is exactly one imported root ([`assets::source_root`]: `ensure_imported_root`).
//! - The relative path passes `resolve_rel` (normal components only, inside the scope) and stays inside that root once
//!   symlinks resolve ([`resolve_in_root`]); a `..`, an absolute path or a path into another root is refused.
//! - The file is a regular file (not a folder, not a symlink), is a photo the scan lists ([`assets::kind_of`]) and
//!   has no hidden component (`.photobook/`, `.photobook-cache/` and the like are never touched).
//! - Sidecars: `<file>.xmp` (darktable style) goes along always; `<stem>.xmp` (Lightroom and Camera Raw) goes along
//!   only when no other photo with that stem stays in the folder, so a RAW+JPEG pair keeps its shared sidecar until
//!   the last of the pair goes. Names match in any case.
//!
//! A failure on one file never stops the rest: the result lists every file as moved or skipped with the reason. Each
//! file is one `NSFileManager` move, so the command is cancel-safe per file; the editor splits a big pile into calls.
//! The thumbnail and proxy cache under the hash is left for the cache cleaner.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::commands::{assets, projects};
use crate::error::{Error, Result};
use crate::scope;

/// What happened to one file of `trash_photos`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// The relative path as given.
    pub path: String,
    /// The photo is in the Trash.
    pub ok: bool,
    /// Why the photo was skipped (`ok: false`), or why a sidecar stayed (`ok: true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Sidecars moved along, relative to the folder.
    pub sidecars: Vec<String>,
}

/// `resolve_rel`'s rule (a non-empty path of normal components) plus: the resolved path is inside `root` itself, not
/// only inside some imported root. `root` must be canonical.
pub(crate) fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(Error::Invalid(format!("Invalid relative path {rel}")));
    }
    let path = scope::normalize(&root.join(rel_path))?;
    if !scope::is_within(&path, root) || path == root {
        return Err(Error::OutOfScope(path.display().to_string()));
    }
    Ok(path)
}

/// The checks of the module doc for one file; returns the file to move (`root.join(rel)`, which then has no symlink).
///
/// The checks run before the move, so a file swapped for a link between the two is not caught: acceptable for a local,
/// single-user app whose folders only the user changes.
fn checked_photo(root: &Path, rel: &str, resolve: &impl Fn(&str) -> Result<PathBuf>) -> Result<PathBuf> {
    let resolved = resolve(rel)?;
    let file = root.join(rel);
    // A symlink anywhere in the path (a folder `pics -> .photobook-cache`, the file itself) would move something the
    // checks below did not look at: refused, the path must already be the real one.
    if resolved != file {
        return Err(Error::Invalid(format!("{rel} has a symlink in its path")));
    }
    if Path::new(rel).components().any(|c| c.as_os_str().to_string_lossy().starts_with('.')) {
        return Err(Error::Invalid(format!("{rel} is in a hidden folder")));
    }
    // The scan skips the top-level Export folder: its files are never photos of the folder.
    if Path::new(rel).components().next().is_some_and(|c| c.as_os_str() == assets::EXPORTS_DIR) {
        return Err(Error::Invalid(format!("{rel} is in the {} folder", assets::EXPORTS_DIR)));
    }
    let meta = fs::symlink_metadata(&file).map_err(|_| Error::Invalid(format!("{rel} is not in the folder")))?;
    if !meta.is_file() {
        return Err(Error::Invalid(format!("{rel} is not a file")));
    }
    if assets::kind_of(&file).is_none() {
        return Err(Error::Invalid(format!("{rel} is not a photo")));
    }
    Ok(file)
}

/// The sidecars that go with `photo` (see the module doc), before it moves.
fn sidecars_of(photo: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(name), Some(stem)) = (photo.parent(), photo.file_name(), photo.file_stem()) else {
        return Vec::new();
    };
    let (name, stem) = (name.to_string_lossy().into_owned(), stem.to_string_lossy().into_owned());
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let files: Vec<(String, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    // Another photo of the same stem (the JPEG of a RAW+JPEG pair) keeps the `<stem>.xmp` they share.
    let shared = files.iter().any(|(n, p)| {
        !n.eq_ignore_ascii_case(&name)
            && assets::kind_of(p).is_some()
            && Path::new(n).file_stem().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(&stem))
    });
    let own = format!("{name}.xmp");
    let by_stem = format!("{stem}.xmp");
    files
        .into_iter()
        .filter(|(n, _)| n.eq_ignore_ascii_case(&own) || (!shared && n.eq_ignore_ascii_case(&by_stem)))
        .map(|(_, p)| p)
        .collect()
}

/// Move each photo of `rel_paths` under `root` (canonical) and its sidecars with `trash`, refusing what `resolve` or
/// the checks refuse. One result per path, in order.
pub(crate) fn trash_files(
    root: &Path,
    rel_paths: &[String],
    resolve: impl Fn(&str) -> Result<PathBuf>,
    trash: impl Fn(&Path) -> Result<()>,
) -> Vec<TrashResult> {
    rel_paths
        .iter()
        .map(|rel| {
            let skipped = |err: Error| TrashResult {
                path: rel.clone(),
                ok: false,
                error: Some(err.to_string()),
                sidecars: vec![],
            };
            let photo = match checked_photo(root, rel, &resolve) {
                Ok(photo) => photo,
                Err(err) => return skipped(err),
            };
            let sidecars = sidecars_of(&photo);
            if let Err(err) = trash(&photo) {
                return skipped(err);
            }
            let mut moved = Vec::new();
            let mut errors = Vec::new();
            for sidecar in sidecars {
                let shown = sidecar.strip_prefix(root).unwrap_or(&sidecar).to_string_lossy().into_owned();
                match trash(&sidecar) {
                    Ok(()) => moved.push(shown),
                    Err(err) => errors.push(format!("the sidecar {shown} stayed: {err}")),
                }
            }
            let error = (!errors.is_empty()).then(|| errors.join("; "));
            TrashResult { path: rel.clone(), ok: true, error, sidecars: moved }
        })
        .collect()
}

/// Move photos of imported folder `folder` (relative paths) and their sidecars to the system Trash. Never fails for a
/// single file: each is reported in its [`TrashResult`]. Fails only when `folder` is not an imported root.
#[tauri::command]
pub async fn trash_photos<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_paths: Vec<String>,
) -> Result<Vec<TrashResult>> {
    let root = assets::source_root(&app, &folder)?;
    let results = tauri::async_runtime::spawn_blocking(move || {
        let resolve = |rel: &str| {
            assets::resolve_rel(&app, &root, rel)?;
            resolve_in_root(&root, rel)
        };
        trash_files(&root, &rel_paths, resolve, projects::move_to_trash)
    })
    .await?;
    let moved = results.iter().filter(|r| r.ok).count();
    log::info!("[photobook:cull] trash_photos: {moved} of {} moved", results.len());
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::IoContext;

    /// An imported root `lisbon` with a sibling `lisbon-2`, and a stand-in Trash beside them. All canonical.
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        sibling: PathBuf,
        bin: PathBuf,
    }

    fn fixture(files: &[&str]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let [root, sibling, bin] = ["lisbon", "lisbon-2", "Trash"].map(|n| base.join(n));
        for path in [&root, &sibling, &bin] {
            fs::create_dir_all(path).unwrap();
        }
        for rel in files {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, rel.as_bytes()).unwrap();
        }
        fs::write(sibling.join("c.jpg"), b"x").unwrap();
        Fixture { _dir: dir, root, sibling, bin }
    }

    /// The stand-in Trash: moves the item into `<base>/Trash` (the real one is the user's, never touched by a test).
    fn fake_trash(bin: &Path) -> impl Fn(&Path) -> Result<()> + '_ {
        move |path: &Path| fs::rename(path, bin.join(path.file_name().unwrap())).ctx("trash")
    }

    fn run(f: &Fixture, rels: &[&str]) -> Vec<TrashResult> {
        let rels: Vec<String> = rels.iter().map(|r| r.to_string()).collect();
        trash_files(&f.root, &rels, |rel| resolve_in_root(&f.root, rel), fake_trash(&f.bin))
    }

    fn in_bin(f: &Fixture) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(&f.bin).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn parent_absolute_and_out_of_root_paths_are_refused() {
        let f = fixture(&["a.jpg", "sub/b.jpg"]);
        let outside = f.sibling.join("c.jpg").to_string_lossy().into_owned();
        let results = run(&f, &["../lisbon-2/c.jpg", "sub/../a.jpg", &outside, "", "./a.jpg"]);
        assert!(results.iter().all(|r| !r.ok && r.error.is_some()), "{results:?}");
        assert!(in_bin(&f).is_empty());
        assert!(f.sibling.join("c.jpg").exists() && f.root.join("a.jpg").exists());
    }

    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let f = fixture(&["a.jpg"]);
        std::os::unix::fs::symlink(f.sibling.join("c.jpg"), f.root.join("link.jpg")).unwrap();
        std::os::unix::fs::symlink(&f.sibling, f.root.join("elsewhere")).unwrap();
        assert!(matches!(resolve_in_root(&f.root, "link.jpg"), Err(Error::OutOfScope(_))));
        assert!(matches!(resolve_in_root(&f.root, "elsewhere/c.jpg"), Err(Error::OutOfScope(_))));
        let results = run(&f, &["link.jpg", "elsewhere/c.jpg"]);
        assert!(results.iter().all(|r| !r.ok));
        assert!(f.sibling.join("c.jpg").exists());
        assert!(in_bin(&f).is_empty());
    }

    #[test]
    fn folders_links_hidden_and_non_photos_are_refused() {
        let f = fixture(&["sub/b.jpg", "notes.txt", "a.xmp", ".photobook/library.json", ".photobook-cache/x.jpg"]);
        std::os::unix::fs::symlink(f.root.join("sub/b.jpg"), f.root.join("inner.jpg")).unwrap();
        let rels =
            ["sub", "notes.txt", "a.xmp", ".photobook/library.json", ".photobook-cache/x.jpg", "inner.jpg", "gone.jpg"];
        let results = run(&f, &rels);
        assert!(results.iter().all(|r| !r.ok), "{results:?}");
        assert!(in_bin(&f).is_empty());
        assert!(f.root.join("sub/b.jpg").exists());
    }

    #[test]
    fn hidden_folders_past_the_first_component_and_exports_are_refused() {
        let f = fixture(&["sub/.x/a.jpg", "Exports/web/b.jpg", "trip/Exports/c.jpg"]);
        let results = run(&f, &["sub/.x/a.jpg", "Exports/web/b.jpg", "trip/Exports/c.jpg"]);
        let ok: Vec<bool> = results.iter().map(|r| r.ok).collect();
        // Only the top-level Exports is skipped by the scan; a nested one holds photos.
        assert_eq!(ok, vec![false, false, true]);
        assert_eq!(in_bin(&f), vec!["c.jpg"]);
    }

    #[test]
    fn a_symlinked_folder_inside_the_root_is_refused() {
        let f = fixture(&[".photobook-cache/x.jpg", "Exports/e.jpg", "real/a.jpg"]);
        for (link, to) in [("pics", ".photobook-cache"), ("out", "Exports"), ("alias", "real")] {
            std::os::unix::fs::symlink(f.root.join(to), f.root.join(link)).unwrap();
        }
        let results = run(&f, &["pics/x.jpg", "out/e.jpg", "alias/a.jpg"]);
        assert!(results.iter().all(|r| !r.ok), "{results:?}");
        assert!(results[2].error.as_deref().unwrap().contains("symlink"));
        assert!(in_bin(&f).is_empty());
    }

    #[test]
    fn a_duplicate_path_moves_once() {
        let f = fixture(&["a.jpg"]);
        let results = run(&f, &["a.jpg", "a.jpg"]);
        assert!(results[0].ok);
        assert!(!results[1].ok);
        assert_eq!(in_bin(&f), vec!["a.jpg"]);
    }

    #[test]
    fn a_root_given_through_a_symlink_refuses_everything() {
        // `trash_photos` passes the canonical root (`source_root`); a non-canonical one never matches its own paths.
        let f = fixture(&["a.jpg"]);
        let link = f.bin.parent().unwrap().join("lisbon-link");
        std::os::unix::fs::symlink(&f.root, &link).unwrap();
        assert!(matches!(resolve_in_root(&link, "a.jpg"), Err(Error::OutOfScope(_))));
        let results = trash_files(&link, &["a.jpg".to_string()], |rel| resolve_in_root(&link, rel), fake_trash(&f.bin));
        assert!(!results[0].ok);
        assert!(f.root.join("a.jpg").exists());
    }

    #[test]
    fn a_raw_moves_with_its_xmp() {
        let f =
            fixture(&["DSCF1001.RAF", "DSCF1001.xmp", "DSCF1002.RAF", "DSCF1002.xmp", "IMG_1.jpg", "IMG_1.jpg.XMP"]);
        let results = run(&f, &["DSCF1001.RAF", "IMG_1.jpg"]);
        let sidecars = vec!["DSCF1001.xmp".to_string()];
        let raw = TrashResult { path: "DSCF1001.RAF".into(), ok: true, error: None, sidecars };
        assert_eq!(results[0], raw);
        assert_eq!(results[1].sidecars, vec!["IMG_1.jpg.XMP".to_string()]);
        assert_eq!(in_bin(&f), vec!["DSCF1001.RAF", "DSCF1001.xmp", "IMG_1.jpg", "IMG_1.jpg.XMP"]);
        // The other RAW keeps its own sidecar.
        assert!(f.root.join("DSCF1002.xmp").exists());
    }

    #[test]
    fn a_raw_jpeg_pair_keeps_the_shared_xmp_until_the_last_goes() {
        let f = fixture(&["DSCF1.RAF", "DSCF1.JPG", "DSCF1.xmp"]);
        let first = run(&f, &["DSCF1.RAF"]);
        assert!(first[0].ok && first[0].sidecars.is_empty());
        assert!(f.root.join("DSCF1.xmp").exists());
        let second = run(&f, &["DSCF1.JPG"]);
        assert_eq!(second[0].sidecars, vec!["DSCF1.xmp".to_string()]);
        assert_eq!(in_bin(&f), vec!["DSCF1.JPG", "DSCF1.RAF", "DSCF1.xmp"]);
        // Both in one call: the sidecar goes with the second.
        let g = fixture(&["P.dng", "P.jpg", "P.xmp"]);
        let both = run(&g, &["P.dng", "P.jpg"]);
        assert!(both[0].sidecars.is_empty());
        assert_eq!(both[1].sidecars, vec!["P.xmp".to_string()]);
    }

    #[test]
    fn a_failure_on_one_file_does_not_stop_the_rest() {
        let f = fixture(&["a.jpg", "b.jpg", "c.jpg"]);
        let rels: Vec<String> = ["a.jpg", "b.jpg", "../x.jpg", "c.jpg"].iter().map(|r| r.to_string()).collect();
        let bin = fake_trash(&f.bin);
        let flaky = |path: &Path| {
            if path.ends_with("b.jpg") {
                Err(Error::Invalid("Could not move b.jpg to the Trash: busy".into()))
            } else {
                bin(path)
            }
        };
        let results = trash_files(&f.root, &rels, |rel| resolve_in_root(&f.root, rel), flaky);
        let ok: Vec<bool> = results.iter().map(|r| r.ok).collect();
        assert_eq!(ok, vec![true, false, false, true]);
        assert_eq!(results[1].error.as_deref(), Some("Could not move b.jpg to the Trash: busy"));
        assert_eq!(in_bin(&f), vec!["a.jpg", "c.jpg"]);
        assert!(f.root.join("b.jpg").exists());
    }

    #[test]
    fn a_sidecar_that_stays_is_reported_on_a_moved_photo() {
        let f = fixture(&["a.jpg", "a.xmp"]);
        let bin = fake_trash(&f.bin);
        let no_xmp =
            |path: &Path| if path.ends_with("a.xmp") { Err(Error::Invalid("locked".into())) } else { bin(path) };
        let results = trash_files(&f.root, &["a.jpg".to_string()], |rel| resolve_in_root(&f.root, rel), no_xmp);
        assert!(results[0].ok);
        assert!(results[0].sidecars.is_empty());
        assert_eq!(results[0].error.as_deref(), Some("the sidecar a.xmp stayed: locked"));
    }

    #[test]
    fn results_serialize_for_the_webview() {
        let r = TrashResult { path: "a.jpg".into(), ok: true, error: None, sidecars: vec!["a.xmp".into()] };
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"path":"a.jpg","ok":true,"sidecars":["a.xmp"]}"#);
    }
}
