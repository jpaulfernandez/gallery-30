//! Crash-safe file writes shared by every command that replaces a file the user would miss: the project file, the
//! folder library, the folders and projects registries, recent.json and the publish settings.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// `atomic_write` that first preserves the current `target` as `<target>.bak`, overwriting the
/// previous backup. The backup is a hard link to the old file (a copy where links are not
/// supported), swapped in with a rename, so `target` and the backup both exist at every instant and
/// the later rename over `target` leaves the backup holding the old bytes. A failed backup never
/// blocks the save of the new version. Used for project files and `<folder>/.photobook/library.json`.
pub(crate) fn write_with_backup(target: &Path, bytes: &[u8]) -> Result<()> {
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

/// `<target>.bak` next to `target` (`project.photobook.json.bak` for a project file).
pub(crate) fn backup_path(target: &Path) -> PathBuf {
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    target.with_file_name(format!("{name}.bak"))
}

/// Replace `target`: write a temp file in the same folder, flush it to disk, then rename it over `target`.
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

/// [`atomic_write`] for a file holding secrets (`publish.env`, `ai.env`): the temp file is created owner read/write
/// only, so the bytes are never readable by others, not even between the write and the rename, and the final mode is
/// checked (an error when it cannot be set).
pub(crate) fn write_secret(target: &Path, bytes: &[u8]) -> Result<()> {
    let dir = target
        .parent()
        .ok_or_else(|| Error::Invalid(format!("{} has no parent folder", target.display())))?;
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let _ = fs::remove_file(&tmp);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, target)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(target, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    };
    write().map_err(|err| {
        let _ = fs::remove_file(&tmp);
        Error::Io(format!("writing {}", target.display()), err)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn secrets_are_owner_only_from_the_start() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("ai.env");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        write_secret(&target, b"KEY=x\n").unwrap();
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::read(&target).unwrap(), b"KEY=x\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    const FILE: &str = "project.photobook.json";
    const BACKUP: &str = "project.photobook.json.bak";

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(FILE);
        atomic_write(&target, b"{\"version\":1}").unwrap();
        atomic_write(&target, b"{\"version\":1,\"x\":2}").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"version\":1,\"x\":2}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_keeps_exactly_one_backup_of_the_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(FILE);
        let bak = dir.path().join(BACKUP);
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
        assert_eq!(names, vec![FILE, BACKUP]);
    }
}
