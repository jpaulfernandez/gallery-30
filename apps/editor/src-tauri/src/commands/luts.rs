//! User 3D LUTs (workflow plan 18): `<appdata>/luts/<sha256>.cube`, plus a `<sha256>.json` sidecar with the name the
//! editor shows and the lattice size. The render reads them by id through `photobook_develop::lut` ([`init`] points
//! it at the folder).
//!
//! - `import_lut(path)` reads a `.cube` file or a HALD CLUT `.png`, stores its canonical `.cube` text
//!   (`lut::canonical_cube`: no title or comments, LF, six decimals) and returns `{ id, name, size }`; the id is the
//!   SHA-256 of that text, so CRLF copies, re-commented files and the same HALD under another name dedupe. The file
//!   must have been picked in the native open dialog this session (or lie inside an imported folder or app data);
//!   only app data is written. 1D LUTs and sizes outside 2 to 129 are refused with a message. A stored file that is
//!   corrupt (does not hash to its id) is rewritten; the first import's name is kept for identical LUTs.
//! - `list_luts` returns the stored LUTs by name; `delete_lut(id)` removes one (already gone is fine) and drops it
//!   from the render's memory; `lut_present(id)` says whether its file is there, parses and matches its id (the Look
//!   section's "LUT missing"), the same check the render makes.

use std::fs;
use std::path::{Path, PathBuf};

use photobook_develop::lut;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

use crate::commands::assets::write_atomic;
use crate::error::{Error, IoContext, Result};
use crate::scope::{app_data_dir, ensure_allowed, normalize};

const LUTS_DIR: &str = "luts";
/// Largest file imported (a 129³ `.cube` is about 55 MB of text).
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 80;

/// A stored LUT as the editor lists it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LutInfo {
    /// SHA-256 hex of the stored `.cube` file.
    pub id: String,
    pub name: String,
    /// Lattice points per side.
    pub size: u32,
    /// Workflow plan 22: how a LUT made by Match camera JPEG was fitted (absent for imported LUTs). Read leniently:
    /// a damaged or out-of-range record is dropped, never the sidecar.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_fitted")]
    pub fitted: Option<FittedInfo>,
}

/// `<appdata>/luts`, also where the render looks for them.
fn luts_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app_data_dir(app)?.join(LUTS_DIR))
}

/// Point the develop crate's LUT store at `<appdata>/luts` (at startup).
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    match luts_dir(app) {
        Ok(dir) => lut::set_lut_dir(Some(dir)),
        Err(err) => log::warn!("[photobook:develop] no LUT folder: {err}"),
    }
}

fn check_id(id: &str) -> Result<()> {
    if lut::is_lut_id(id) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("Invalid LUT id {id:?}")))
    }
}

fn sidecar(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

/// The name a LUT gets from its file: the file name without extension, trimmed and shortened.
fn name_of(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name: String = stem.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect::<String>().trim().to_string();
    if name.is_empty() {
        "LUT".to_string()
    } else {
        name
    }
}

/// Store `lut`'s canonical `.cube` text as `<dir>/<id>.cube` (created if needed) and return the id (its SHA-256). A
/// stored copy that is missing or corrupt (anything but exactly this text) is rewritten.
fn write_canonical(dir: &Path, lut: &lut::Lut3d) -> Result<String> {
    let text = lut::canonical_cube(lut);
    let id = lut::text_id(&text);
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    let file = lut::lut_file(dir, &id);
    if fs::read(&file).ok().as_deref() != Some(text.as_bytes()) {
        write_atomic(&file, text.as_bytes())?;
    }
    Ok(id)
}

/// Read, validate and store the LUT at `src` in `dir` (created if needed). See the module docs.
pub fn import_into(dir: &Path, src: &Path) -> Result<LutInfo> {
    let len = fs::metadata(src).ctx(format!("reading {}", src.display()))?.len();
    if len > MAX_BYTES {
        return Err(Error::Invalid(format!("{} is larger than {} MB", src.display(), MAX_BYTES / (1024 * 1024))));
    }
    let ext = src.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let name = name_of(src);
    let parsed = match ext.as_str() {
        "cube" => {
            let bytes = fs::read(src).ctx(format!("reading {}", src.display()))?;
            let text = std::str::from_utf8(&bytes).map_err(|_| Error::Invalid("A .cube file must be text".into()))?;
            lut::parse_cube(text)?
        }
        "png" => lut::decode_hald_png(src)?,
        _ => return Err(Error::Invalid("Import a .cube file or a HALD CLUT .png".into())),
    };
    let id = write_canonical(dir, &parsed)?;
    // The same LUT imported again keeps the name it was first given.
    let kept = fs::read(sidecar(dir, &id))
        .ok()
        .and_then(|b| serde_json::from_slice::<LutInfo>(&b).ok())
        .filter(|i| i.id == id && !i.name.trim().is_empty());
    let info = kept.map(|i| LutInfo { size: parsed.size as u32, ..i }).unwrap_or(LutInfo {
        id: id.clone(),
        name,
        size: parsed.size as u32,
        fitted: None,
    });
    let json = serde_json::to_vec_pretty(&info).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&sidecar(dir, &id), &json)?;
    // A file deleted (or broken) and imported again: forget any "missing" state and cached copy.
    lut::forget(&id);
    Ok(info)
}

/// `LUT_3D_SIZE` and `TITLE` from the head of a `.cube` file, for a LUT without a sidecar.
fn header_info(file: &Path, id: &str) -> LutInfo {
    use std::io::{BufRead, BufReader};
    let mut info = LutInfo { id: id.to_string(), name: id[..8].to_string(), size: 0, fitted: None };
    let Ok(f) = fs::File::open(file) else { return info };
    for line in BufReader::new(f).lines().take(64).map_while(|l| l.ok()) {
        let line = line.trim();
        if let Some(t) = line.strip_prefix("TITLE") {
            let t = t.trim().trim_matches('"').trim();
            if !t.is_empty() {
                info.name = t.chars().take(MAX_NAME_CHARS).collect();
            }
        } else if let Some(n) = line.strip_prefix("LUT_3D_SIZE") {
            info.size = n.trim().parse().unwrap_or(0);
        }
    }
    info
}

/// Every `<id>.cube` in `dir`, sorted by name (case-insensitive), then id.
pub fn list_in(dir: &Path) -> Vec<LutInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<LutInfo> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".cube").filter(|id| lut::is_lut_id(id))?.to_string();
            let info = fs::read(sidecar(dir, &id))
                .ok()
                .and_then(|b| serde_json::from_slice::<LutInfo>(&b).ok())
                .filter(|i| i.id == id)
                .unwrap_or_else(|| header_info(&e.path(), &id));
            Some(info)
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Remove `<id>.cube` and its sidecar from `dir` (missing files are fine).
pub fn delete_in(dir: &Path, id: &str) -> Result<()> {
    check_id(id)?;
    for path in [lut::lut_file(dir, id), sidecar(dir, id)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(Error::Io(format!("deleting {}", path.display()), err)),
        }
    }
    lut::forget(id);
    Ok(())
}

/// `path` resolved, when it is inside an imported folder or app data, or the native dialog picked it this session.
fn check_source<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf> {
    let given = Path::new(path);
    if let Ok(p) = ensure_allowed(app, given) {
        return Ok(p);
    }
    let resolved = normalize(given).map_err(|_| Error::OutOfScope(path.to_string()))?;
    let scope = app.fs_scope();
    if scope.is_allowed(given) || scope.is_allowed(&resolved) {
        Ok(resolved)
    } else {
        Err(Error::OutOfScope(path.to_string()))
    }
}

#[tauri::command]
pub async fn import_lut<R: Runtime>(app: AppHandle<R>, path: String) -> Result<LutInfo> {
    let src = check_source(&app, &path)?;
    let dir = ensure_allowed(&app, luts_dir(&app)?)?;
    let info = tauri::async_runtime::spawn_blocking(move || import_into(&dir, &src)).await??;
    log::info!("[photobook:develop] imported LUT {} ({}³) as {}", info.name, info.size, info.id);
    Ok(info)
}

#[tauri::command]
pub async fn list_luts<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LutInfo>> {
    let dir = ensure_allowed(&app, luts_dir(&app)?)?;
    Ok(list_in(&dir))
}

#[tauri::command]
pub async fn delete_lut<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    let dir = ensure_allowed(&app, luts_dir(&app)?)?;
    delete_in(&dir, &id)?;
    log::info!("[photobook:develop] deleted LUT {id}");
    Ok(())
}

#[tauri::command]
pub async fn lut_present<R: Runtime>(_app: AppHandle<R>, id: String) -> Result<bool> {
    if !lut::is_lut_id(&id) || lut::lut_dir().is_none() {
        return Ok(false);
    }
    // The render's own check (the file is there, parses and hashes to its id), so the UI and renders agree.
    Ok(tauri::async_runtime::spawn_blocking(move || lut::present(&id)).await?)
}

// ---------- Workflow plan 22: Match camera JPEG ----------
//
// - `fit_lut(folder, pairs, name, job)` fits a 33³ LUT from RAW + camera JPEG pairs in `folder` (relative paths;
//   `photobook_develop::lutfit`), stores it like an imported LUT with a sidecar that also records how it was fitted
//   (`fitted`: the camera's film simulation tag, the camera, the pairs used, the mean ΔE), and returns it with a
//   report per pair. Progress is `lut:fit-progress` `{ job, done, total, detail }`; `cancel_develop(job)` stops it
//   (the error is then "Cancelled"). The editor saves the look preset named after it (`commands/presets.rs`).
// - `film_simulation(folder, relPath)`: the Fujifilm film simulation recorded in a RAF or JPEG and the camera
//   (`{ simulation, camera }` or null; at most 128 KB read), for the Look section's "Suggested: Classic Chrome (fitted)".

/// How a LUT was fitted, in its sidecar.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FittedInfo {
    /// The camera's film simulation tag (`Classic Chrome`), when the RAWs or JPEGs record one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simulation: Option<String>,
    /// "Fujifilm X-T5".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<String>,
    /// Pairs the fit used.
    pub pairs: u32,
    /// Mean CIE76 ΔE of the fitted LUT on those pairs.
    pub mean_delta_e: f32,
}

impl FittedInfo {
    /// This record with its strings cleaned and capped at 80 characters, or `None` when `pairs` is not 1 to
    /// [`MAX_FIT_PAIRS`] or `mean_delta_e` is not a finite 0 to 100.
    pub fn checked(self) -> Option<FittedInfo> {
        let short = |s: Option<String>| {
            s.map(|s| s.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let ok = (1..=MAX_FIT_PAIRS as u32).contains(&self.pairs)
            && self.mean_delta_e.is_finite()
            && (0.0..=100.0).contains(&self.mean_delta_e);
        ok.then(|| FittedInfo { simulation: short(self.simulation), camera: short(self.camera), ..self })
    }
}

/// `fitted` as stored, or `None` when it is not a valid record ([`FittedInfo::checked`]).
fn lenient_fitted<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<FittedInfo>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<FittedInfo>(value).ok().and_then(FittedInfo::checked))
}

/// One RAW + JPEG pair, relative to the folder.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FitPair {
    pub raw: String,
    pub jpeg: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FitLutResult {
    pub lut: LutInfo,
    pub pairs: Vec<photobook_develop::lutfit::PairReport>,
    pub mean_delta_e: f32,
    /// Share of the LUT's lattice the pairs reached (the rest is extrapolated smoothly).
    pub coverage: f32,
    /// Final relative residual of the least-squares solve, and whether it converged.
    pub residual: f64,
    pub converged: bool,
}

#[derive(Serialize, Clone)]
struct FitProgress<'a> {
    job: u64,
    done: usize,
    total: usize,
    detail: &'a str,
}

pub const EVENT_FIT_PROGRESS: &str = "lut:fit-progress";
/// Most pairs one fit takes (each is a RAW decode at the working size).
const MAX_FIT_PAIRS: usize = 24;

/// A LUT name: control characters removed, trimmed, at most 80 characters; `fallback` when that leaves nothing.
fn clean_name(name: &str, fallback: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect::<String>().trim().to_string();
    if name.is_empty() {
        fallback.to_string()
    } else {
        name
    }
}

/// Store a fitted `lut` in `dir` under `name` (canonical text, id = its SHA-256, as [`import_into`]); the sidecar gets
/// `name` (a fit names its LUT afresh, even when the same lattice was stored before) and `fitted`.
pub fn store_fitted(dir: &Path, lut: &lut::Lut3d, name: &str, fitted: FittedInfo) -> Result<LutInfo> {
    let id = write_canonical(dir, lut)?;
    let info = LutInfo {
        id: id.clone(),
        name: clean_name(name, "Camera look"),
        size: lut.size as u32,
        fitted: fitted.checked(),
    };
    let json = serde_json::to_vec_pretty(&info).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&sidecar(dir, &id), &json)?;
    lut::forget(&id);
    Ok(info)
}

/// The simulation most of `pairs` record (the RAW's tag, else the JPEG's); ties go to the first pair's.
pub fn common_simulation(pairs: &[(PathBuf, PathBuf)]) -> Option<String> {
    use photobook_develop::decode::film_simulation;
    let tags: Vec<String> =
        pairs.iter().filter_map(|(raw, jpeg)| film_simulation(raw).or_else(|| film_simulation(jpeg))).collect();
    let mut best: Option<(&String, usize)> = None;
    for tag in &tags {
        let count = tags.iter().filter(|t| *t == tag).count();
        if best.is_none_or(|(_, n)| count > n) {
            best = Some((tag, count));
        }
    }
    best.map(|(t, _)| t.clone())
}

/// Why a pair is left out before fitting: the RAW records a film simulation and its JPEG does not, so the JPEG is
/// not the camera's own (an edited export usually drops the maker note).
fn exported_jpeg(raw: &Path, jpeg: &Path) -> Option<String> {
    use photobook_develop::decode::film_simulation;
    let tag = film_simulation(raw)?;
    film_simulation(jpeg).is_none().then(|| {
        format!("The RAW records {tag} but the JPEG has no film simulation: is it an edited export, not the camera's?")
    })
}

/// Fit a LUT from `files` (absolute; `pairs` the same pairs relative to the folder, for the reports) and store it in
/// `dir` named `name` (the simulation's, when blank). Pairs whose JPEG is not the camera's ([`exported_jpeg`]) are
/// left out with a reason before the fit.
pub fn fit_and_store(
    dir: &Path,
    files: &[(PathBuf, PathBuf)],
    pairs: &[FitPair],
    name: &str,
    cancelled: &(dyn Fn() -> bool + Sync),
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<FitLutResult> {
    use photobook_develop::lutfit::{fit_files, FitOptions, PairReport};
    let skipped: Vec<Option<String>> = files.iter().map(|(raw, jpeg)| exported_jpeg(raw, jpeg)).collect();
    let kept: Vec<(PathBuf, PathBuf)> =
        files.iter().zip(&skipped).filter(|(_, why)| why.is_none()).map(|(f, _)| f.clone()).collect();
    if kept.is_empty() {
        let why = skipped.iter().flatten().next().cloned().unwrap_or_default();
        return Err(Error::Invalid(format!("No pair could be used. {why}")));
    }
    let report = fit_files(&kept, &FitOptions::default(), cancelled, progress)?;
    // Every pair's report in the order asked, named by its path relative to the folder.
    let mut fitted_reports = report.pairs.into_iter();
    let reports: Vec<PairReport> = pairs
        .iter()
        .zip(&skipped)
        .map(|(p, why)| {
            let mut r = match why {
                Some(why) => PairReport {
                    raw: String::new(),
                    jpeg: String::new(),
                    samples: 0,
                    score: None,
                    mean_delta_e: None,
                    error: Some(why.clone()),
                },
                None => fitted_reports.next().expect("one report per pair fitted"),
            };
            r.raw = p.raw.clone();
            r.jpeg = p.jpeg.clone();
            r
        })
        .collect();
    let used: Vec<(PathBuf, PathBuf)> =
        files.iter().zip(&reports).filter(|(_, r)| r.error.is_none()).map(|(f, _)| f.clone()).collect();
    let tag = used.iter().find_map(|(raw, jpeg)| {
        photobook_develop::decode::film_tag(raw).or_else(|| photobook_develop::decode::film_tag(jpeg))
    });
    let simulation = common_simulation(&used);
    let camera = tag
        .and_then(|t| t.camera)
        .or_else(|| used.first().and_then(|(raw, _)| photobook_develop::decode::camera_exif(raw).camera_name()));
    let fallback = simulation.clone().unwrap_or_else(|| "Camera look".into());
    let fitted = FittedInfo { simulation, camera, pairs: used.len() as u32, mean_delta_e: report.mean_delta_e };
    let info = store_fitted(dir, &report.lut, &clean_name(name, &fallback), fitted)?;
    log::info!(
        "[photobook:develop] fitted LUT {} from {} pairs: mean ΔE {:.2}, coverage {:.3}, residual {:.1e} ({})",
        info.name,
        used.len(),
        report.mean_delta_e,
        report.coverage,
        report.residual,
        info.id
    );
    Ok(FitLutResult {
        lut: info,
        pairs: reports,
        mean_delta_e: report.mean_delta_e,
        coverage: report.coverage,
        residual: report.residual,
        converged: report.converged,
    })
}

#[tauri::command]
pub async fn fit_lut<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    pairs: Vec<FitPair>,
    name: String,
    job: u64,
) -> Result<FitLutResult> {
    use crate::commands::develop::DevelopJobs;
    use tauri::{Emitter, Manager};
    let outcome = async {
        if pairs.is_empty() {
            return Err(Error::Invalid("Choose at least one RAW + JPEG pair".into()));
        }
        if pairs.len() > MAX_FIT_PAIRS {
            return Err(Error::Invalid(format!("Choose at most {MAX_FIT_PAIRS} pairs")));
        }
        let root = crate::commands::assets::source_root(&app, &folder)?;
        let files = pairs
            .iter()
            .map(|p| {
                Ok((
                    crate::commands::assets::resolve_rel(&app, &root, &p.raw)?,
                    crate::commands::assets::resolve_rel(&app, &root, &p.jpeg)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let dir = ensure_allowed(&app, luts_dir(&app)?)?;
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<FitLutResult> {
            let cancelled = {
                let app = app2.clone();
                move || app.state::<DevelopJobs>().cancel_requested(job)
            };
            let mut progress = |done: usize, total: usize, detail: &str| {
                let _ = app2.emit(EVENT_FIT_PROGRESS, FitProgress { job, done, total, detail });
            };
            fit_and_store(&dir, &files, &pairs, &name, &cancelled, &mut progress)
        })
        .await?
    }
    .await;
    // A cancel that came after the last checkpoint has nothing left to stop.
    app.state::<DevelopJobs>().take_cancel(job);
    outcome
}

#[tauri::command]
pub async fn film_simulation<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
) -> Result<Option<photobook_develop::decode::FilmTag>> {
    let root = crate::commands::assets::source_root(&app, &folder)?;
    let path = crate::commands::assets::resolve_rel(&app, &root, &rel_path)?;
    Ok(tauri::async_runtime::spawn_blocking(move || photobook_develop::decode::film_tag(&path)).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn cube(size: usize) -> String {
        lut::to_cube(&lut::Lut3d::identity(size), Some("Identity"))
    }

    #[test]
    fn imports_lists_and_deletes_a_cube() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("My Look.cube");
        fs::write(&src, cube(5)).unwrap();
        let dir = tmp.path().join("luts");
        let info = import_into(&dir, &src).unwrap();
        assert_eq!(info.name, "My Look");
        assert_eq!(info.size, 5);
        let canonical = lut::canonical_cube(&lut::Lut3d::identity(5));
        assert_eq!(info.id, hex::encode(Sha256::digest(canonical.as_bytes())));
        assert_eq!(fs::read_to_string(lut::lut_file(&dir, &info.id)).unwrap(), canonical, "stored canonical");
        // The same file again is the same id.
        assert_eq!(import_into(&dir, &src).unwrap(), info);
        assert_eq!(list_in(&dir), vec![info.clone()]);
        // A CRLF copy with other comments under another name is the same LUT and keeps the first name.
        let copy = tmp.path().join("Copy\u{7}.cube");
        fs::write(&copy, format!("# exported\r\n{}", cube(5).replace('\n', "\r\n"))).unwrap();
        assert_eq!(import_into(&dir, &copy).unwrap(), info);
        assert_eq!(name_of(&copy), "Copy");
        // A corrupt stored file is rewritten by the next import.
        fs::write(lut::lut_file(&dir, &info.id), "LUT_3D_SIZE 2\n").unwrap();
        import_into(&dir, &src).unwrap();
        assert_eq!(fs::read_to_string(lut::lut_file(&dir, &info.id)).unwrap(), canonical);
        // Without its sidecar the id stands in for the name.
        fs::remove_file(sidecar(&dir, &info.id)).unwrap();
        assert_eq!(list_in(&dir)[0].name, info.id[..8]);
        assert_eq!(list_in(&dir)[0].size, 5);
        delete_in(&dir, &info.id).unwrap();
        assert!(list_in(&dir).is_empty());
        delete_in(&dir, &info.id).unwrap();
        assert!(delete_in(&dir, "../x").is_err());
    }

    #[test]
    fn converts_a_hald_png() {
        let tmp = tempfile::tempdir().unwrap();
        let id = lut::Lut3d::identity(4);
        let px: Vec<u8> = id.data.iter().flatten().map(|v| (v * 255.0).round() as u8).collect();
        let src = tmp.path().join("hald.png");
        image::RgbImage::from_raw(8, 8, px).unwrap().save(&src).unwrap();
        let info = import_into(&tmp.path().join("luts"), &src).unwrap();
        assert_eq!((info.name.as_str(), info.size), ("hald", 4));
        let text = fs::read_to_string(lut::lut_file(&tmp.path().join("luts"), &info.id)).unwrap();
        assert_eq!(info.id, hex::encode(Sha256::digest(text.as_bytes())));
        let parsed = lut::parse_cube(&text).unwrap();
        assert!((parsed.apply([0.2, 0.5, 0.9])[2] - 0.9).abs() < 1e-3);
        // The same HALD under another name is the same LUT.
        let again = tmp.path().join("other.png");
        fs::copy(&src, &again).unwrap();
        assert_eq!(import_into(&tmp.path().join("luts"), &again).unwrap().id, info.id);
        // Not a HALD size: refused from the header.
        let wrong = tmp.path().join("photo.png");
        image::RgbImage::new(10, 8).save(&wrong).unwrap();
        assert!(import_into(&tmp.path().join("luts"), &wrong).unwrap_err().to_string().contains("not a HALD"));
    }

    #[test]
    fn refuses_1d_and_other_files() {
        let tmp = tempfile::tempdir().unwrap();
        let one_d = tmp.path().join("curve.cube");
        fs::write(&one_d, "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n").unwrap();
        let err = import_into(&tmp.path().join("luts"), &one_d).unwrap_err().to_string();
        assert!(err.contains("1D"), "{err}");
        let txt = tmp.path().join("look.3dl");
        fs::write(&txt, "x").unwrap();
        assert!(import_into(&tmp.path().join("luts"), &txt).is_err());
        assert!(list_in(&tmp.path().join("luts")).is_empty());
    }
    /// Workflow plan 22: a fitted LUT is stored like an import, with its fit in the sidecar.
    #[test]
    fn stores_a_fitted_lut_with_its_fit() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("luts");
        let mut fitted_lut = lut::Lut3d::identity(3);
        fitted_lut.data[0] = [0.1, 0.05, 0.0];
        let fit = FittedInfo {
            simulation: Some("Classic Chrome".into()),
            camera: Some("Fujifilm X-T5".into()),
            pairs: 3,
            mean_delta_e: 1.2,
        };
        let info = store_fitted(&dir, &fitted_lut, "  Classic Chrome\u{7} ", fit.clone()).unwrap();
        assert_eq!(info.name, "Classic Chrome");
        assert_eq!(info.id, lut::lut_id(&fitted_lut));
        assert_eq!(info.fitted.as_ref(), Some(&fit));
        assert_eq!(list_in(&dir), vec![info.clone()]);
        let json: serde_json::Value = serde_json::from_slice(&fs::read(sidecar(&dir, &info.id)).unwrap()).unwrap();
        assert_eq!(json["fitted"]["simulation"], "Classic Chrome");
        assert!(json["fitted"]["meanDeltaE"].as_f64().is_some());
        // Importing the same lattice from a file keeps the fitted name and record.
        let src = tmp.path().join("copy.cube");
        fs::write(&src, lut::to_cube(&fitted_lut, Some("copy"))).unwrap();
        assert_eq!(import_into(&dir, &src).unwrap(), info);
        // A blank name falls back.
        assert_eq!(store_fitted(&dir, &fitted_lut, " ", fit).unwrap().name, "Camera look");
        assert_eq!(clean_name("", "Velvia"), "Velvia");
        assert_eq!(common_simulation(&[]), None);
    }
    /// A damaged or out-of-range `fitted` record is dropped, the rest of the sidecar kept; long strings are capped.
    #[test]
    fn fitted_records_are_read_leniently() {
        let read = |json: &str| serde_json::from_str::<LutInfo>(json).unwrap();
        let base = r#"{"id":"ab","name":"Mine","size":33"#;
        assert_eq!(read(&format!("{base}}}")).fitted, None);
        let ok = read(&format!(r#"{base},"fitted":{{"simulation":"Velvia","pairs":3,"meanDeltaE":1.5}}}}"#));
        assert_eq!(ok.fitted.unwrap().simulation.as_deref(), Some("Velvia"));
        for bad in [
            r#""oops""#,
            r#"{"pairs":0,"meanDeltaE":1}"#,
            r#"{"pairs":99,"meanDeltaE":1}"#,
            r#"{"pairs":2,"meanDeltaE":-1}"#,
            r#"{"pairs":2,"meanDeltaE":1000}"#,
            r#"{"pairs":2}"#,
        ] {
            let info = read(&format!(r#"{base},"fitted":{bad}}}"#));
            assert_eq!(info.name, "Mine", "{bad}");
            assert_eq!(info.fitted, None, "{bad}");
        }
        let long = "x".repeat(300);
        let capped = FittedInfo { simulation: Some(long.clone()), camera: Some(long), pairs: 2, mean_delta_e: 1.0 }
            .checked()
            .unwrap();
        assert_eq!(capped.simulation.unwrap().chars().count(), 80);
        assert_eq!(capped.camera.unwrap().chars().count(), 80);
    }
}
