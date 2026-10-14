//! Lightroom XMP interop (step D6.3, editor half): the Tauri side of `photobook_develop::xmp`.
//!
//! - `read_xmp(folder, relPath, fileOrientation?)` looks for a sidecar next to the photo (`<stem>.xmp`, the Lightroom
//!   and Camera Raw name, then `<file>.xmp`, the darktable style; the extension in any case), else the packet embedded
//!   in a JPEG. A packet with our own `photobook:Develop` property is read back exactly (`format: "photobook"`);
//!   otherwise the `crs:` fields are mapped (`format: "crs"`). `orientationChange` is what to set on
//!   `geometry.rotate`/`flipH` when the sidecar records a different orientation than the file (rotated in Lightroom).
//! - `write_xmp_sidecar(...)` merges our `photobook:` packet or a lossy `crs:` packet into the photo's sidecar (the
//!   existing one, else a new `<stem>.xmp`), keeping the previous version as `<sidecar>.bak`.
//!
//! Every path goes through `resolve_rel` / `ensure_allowed` under an imported folder. The lookup and the merge
//! are plain functions of paths (`find_sidecar`, `read_for`, `write_for`), tested without an app handle.

use std::fs;
use std::path::{Path, PathBuf};

use photobook_develop::settings::DevelopSettings;
use photobook_develop::xmp::{self, CrsExportOptions, DroppedItem, XmpImport};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::commands::assets::{resolve_rel, source_root, write_atomic};
use crate::error::{Error, IoContext, Result};

/// Where an import came from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum XmpSource {
    Sidecar,
    Embedded,
}

/// Which properties the settings were read from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum XmpFormat {
    /// Our `photobook:Develop` JSON: exact.
    Photobook,
    /// Lightroom's `crs:` fields: slider values, not pixels.
    Crs,
}

/// The rotation and flip to set on a photo whose sidecar records another orientation than its file.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrientationChange {
    /// `geometry.rotate`: 0, 90, 180 or 270.
    pub rotate: u16,
    pub flip_h: bool,
}

/// What `read_xmp` returns.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XmpImportResult {
    /// `None` when the photo has neither a sidecar nor an embedded packet.
    pub import: Option<XmpImport>,
    pub source: Option<XmpSource>,
    pub format: Option<XmpFormat>,
    /// Absolute path of the sidecar that was read (or that an export would merge into; `None` for embedded).
    pub sidecar_path: Option<String>,
    /// Set when the packet's `tiff:Orientation` differs from the file's own EXIF orientation.
    pub orientation_change: Option<OrientationChange>,
}

/// How `write_xmp_sidecar` writes.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum XmpMode {
    /// Our namespace: lossless, ignored by Lightroom.
    Photobook,
    /// Lightroom's `crs:` fields: lossy, with the warning property.
    Crs,
}

/// The sidecar next to `photo`: `<stem>.xmp` first, then `<file>.xmp` (`IMG_1.jpg.xmp`), the extension in any case.
pub fn find_sidecar(photo: &Path) -> Option<PathBuf> {
    let dir = photo.parent()?;
    let file = photo.file_name()?.to_string_lossy().into_owned();
    let stem = photo.file_stem()?.to_string_lossy().into_owned();
    let wanted = [format!("{stem}.xmp"), format!("{file}.xmp")];
    let entries: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    // Exact names win over case variants; a file with the photo's own name never matches itself.
    for name in &wanted {
        if let Some((_, path)) = entries.iter().find(|(n, _)| n == name) {
            return Some(path.clone());
        }
    }
    for name in &wanted {
        let lower = name.to_ascii_lowercase();
        if let Some((_, path)) = entries.iter().find(|(n, _)| n.to_ascii_lowercase() == lower) {
            return Some(path.clone());
        }
    }
    None
}

fn is_jpeg(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
}

fn rotation_degrees(r: photobook_develop::settings::Rotation) -> u16 {
    r.degrees()
}

/// Read a photo's settings from its sidecar or embedded packet. `file_orientation` is the file's own EXIF
/// orientation (1..=8) when known; without it no `orientation_change` is reported.
pub fn read_for(photo: &Path, file_orientation: Option<u8>) -> Result<XmpImportResult> {
    let (text, source, sidecar_path) = if let Some(path) = find_sidecar(photo) {
        let bytes = fs::read(&path).ctx(format!("reading {}", path.display()))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::Invalid(format!("{}: XMP is not UTF-8", path.display())))?;
        (text, XmpSource::Sidecar, Some(path))
    } else if is_jpeg(photo) {
        let bytes = fs::read(photo).ctx(format!("reading {}", photo.display()))?;
        match xmp::find_embedded_packet(&bytes) {
            Some(xml) => (xml, XmpSource::Embedded, None),
            None => return Ok(none_found(None)),
        }
    } else {
        return Ok(none_found(None));
    };

    let shown = sidecar_path.as_ref().map(|p| p.to_string_lossy().into_owned());
    let name = sidecar_path.as_deref().unwrap_or(photo).display().to_string();
    let (import, format) = match xmp::read_photobook_packet(&text) {
        Ok(Some(settings)) => (photobook_import(settings), XmpFormat::Photobook),
        // A damaged photobook property falls back to the crs fields; a damaged packet is an error.
        _ => (xmp::read_packet(&text).map_err(|e| Error::Invalid(format!("{name}: {e}")))?, XmpFormat::Crs),
    };
    let orientation_change = match (file_orientation, import.orientation) {
        (Some(file), Some(recorded)) if (1..=8).contains(&file) && (1..=8).contains(&recorded) && file != recorded => {
            let (rotation, flip_h, _) = xmp::orientation_change(file, recorded);
            let change = OrientationChange { rotate: rotation_degrees(rotation), flip_h };
            (change.rotate != 0 || change.flip_h).then_some(change)
        }
        _ => None,
    };
    Ok(XmpImportResult {
        import: Some(import),
        source: Some(source),
        format: Some(format),
        sidecar_path: shown,
        orientation_change,
    })
}

fn none_found(sidecar_path: Option<String>) -> XmpImportResult {
    XmpImportResult { import: None, source: None, format: None, sidecar_path, orientation_change: None }
}

/// Our own packet read back: exact settings, nothing dropped.
fn photobook_import(settings: DevelopSettings) -> XmpImport {
    XmpImport {
        settings,
        process_version: None,
        dropped: Vec::<DroppedItem>::new(),
        already_applied: false,
        orientation: None,
        ignored: Vec::new(),
    }
}

/// The packet `write_for` merges: ours, or the `crs:` one for the file's orientation and recorded size.
fn packet_for(
    settings: &DevelopSettings,
    orientation: Option<u8>,
    width: Option<u32>,
    height: Option<u32>,
    mode: XmpMode,
) -> String {
    match mode {
        XmpMode::Photobook => xmp::write_photobook_packet(settings),
        XmpMode::Crs => {
            let orientation = orientation.filter(|o| (1..=8).contains(o));
            let swapped = orientation.is_some_and(|o| o >= 5);
            let source_size = match (width, height) {
                (Some(w), Some(h)) if w > 0 && h > 0 => Some(if swapped { (h, w) } else { (w, h) }),
                _ => None,
            };
            xmp::write_crs_packet(settings, &CrsExportOptions { warn: true, orientation, source_size })
        }
    }
}

/// A new sidecar for an exported copy of a photo (the Original + sidecar export, workflow plan 12): our packet, read
/// back exactly by Photobook, with the Lightroom-readable `crs:` fields merged into it (the same packets as
/// `write_xmp_sidecar`).
pub fn export_sidecar(
    settings: &DevelopSettings,
    orientation: Option<u8>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<String> {
    let ours = packet_for(settings, orientation, width, height, XmpMode::Photobook);
    let crs = packet_for(settings, orientation, width, height, XmpMode::Crs);
    xmp::merge_into_sidecar(Some(&ours), &crs).map_err(|e| Error::Invalid(format!("XMP sidecar: {e}")))
}

/// Merge the settings into the photo's sidecar. `width` / `height` are the upright pixel size the book stores;
/// they are swapped for orientations 5..=8 into the recorded size the `crs:` packet declares. Returns the path.
pub fn write_for(
    photo: &Path,
    settings: &DevelopSettings,
    orientation: Option<u8>,
    width: Option<u32>,
    height: Option<u32>,
    mode: XmpMode,
) -> Result<PathBuf> {
    let existing = find_sidecar(photo);
    let target = match &existing {
        Some(path) => path.clone(),
        None => {
            let stem = photo
                .file_stem()
                .ok_or_else(|| Error::Invalid(format!("{} has no file name", photo.display())))?;
            photo.with_file_name(format!("{}.xmp", stem.to_string_lossy()))
        }
    };
    let packet = packet_for(settings, orientation, width, height, mode);
    let old = match &existing {
        Some(path) => Some(fs::read_to_string(path).ctx(format!("reading {}", path.display()))?),
        None => None,
    };
    let merged = xmp::merge_into_sidecar(old.as_deref(), &packet)
        .map_err(|e| Error::Invalid(format!("{}: {e}", target.display())))?;
    if let (Some(path), Some(old)) = (&existing, &old) {
        // Keep the version being replaced; a failed backup never blocks the export. Written like the sidecar (temp
        // file + rename) rather than `fs::copy`, which would follow a `.bak` symlink and write outside the folder.
        let mut bak = path.clone().into_os_string();
        bak.push(".bak");
        let _ = write_atomic(&PathBuf::from(bak), old.as_bytes());
    }
    write_atomic(&target, merged.as_bytes())?;
    Ok(target)
}

/// Read the Lightroom (or Photobook) settings of the photo at `rel_path` of the open book folder.
#[tauri::command]
pub async fn read_xmp<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    file_orientation: Option<u8>,
) -> Result<XmpImportResult> {
    let root = source_root(&app, &folder)?;
    let photo = resolve_rel(&app, &root, &rel_path)?;
    tauri::async_runtime::spawn_blocking(move || read_for(&photo, file_orientation))
        .await
        .map_err(|e| Error::Invalid(format!("XMP read failed: {e}")))?
}

/// Write the photo's settings to its XMP sidecar (merged into an existing one) and return the sidecar's path.
/// `orientation` is the file's EXIF orientation; `width` / `height` the upright size the book stores.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn write_xmp_sidecar<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    settings: DevelopSettings,
    orientation: Option<u8>,
    width: Option<u32>,
    height: Option<u32>,
    mode: XmpMode,
) -> Result<String> {
    let root = source_root(&app, &folder)?;
    let photo = resolve_rel(&app, &root, &rel_path)?;
    let path = tauri::async_runtime::spawn_blocking(move || write_for(&photo, &settings, orientation, width, height, mode))
        .await
        .map_err(|e| Error::Invalid(format!("XMP write failed: {e}")))??;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photobook_develop::settings::DevelopSettings;
    use serde_json::json;

    fn lisbon(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/lisbon-demo").join(name)
    }

    /// A Lightroom Classic sidecar as written for a rendered JPEG: both the attribute and the element form,
    /// sliders in the PV2012 ranges, a tone curve, one band of the colour mixer, a crop with an angle, a mask
    /// (dropped) and a few fields we do not map.
    const LIGHTROOM_SIDECAR: &str = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="4"
   tiff:Orientation="1"
   crs:Version="15.4"
   crs:ProcessVersion="15.4"
   crs:WhiteBalance="Custom"
   crs:IncrementalTemperature="+8"
   crs:IncrementalTint="-3"
   crs:Exposure2012="+0.45"
   crs:Contrast2012="+12"
   crs:Highlights2012="-35"
   crs:Shadows2012="+28"
   crs:Whites2012="+6"
   crs:Blacks2012="-10"
   crs:Vibrance="+18"
   crs:Saturation="-4"
   crs:SaturationAdjustmentOrange="+15"
   crs:Sharpness="45"
   crs:HasCrop="True"
   crs:CropLeft="0.05"
   crs:CropTop="0.1"
   crs:CropRight="0.95"
   crs:CropBottom="0.9"
   crs:CropAngle="1.5"
   crs:CameraProfile="Adobe Standard"
   crs:HasSettings="True">
   <crs:Texture>+10</crs:Texture>
   <crs:Clarity2012>+16</crs:Clarity2012>
   <crs:Dehaze>+5</crs:Dehaze>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>64, 58</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;

    fn photo_in(dir: &Path, name: &str) -> PathBuf {
        let target = dir.join(name);
        fs::copy(lisbon("IMG_01.jpg"), &target).unwrap();
        target
    }

    #[test]
    fn sidecar_lookup_prefers_the_stem_then_the_full_name() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        assert_eq!(find_sidecar(&photo), None);

        fs::write(dir.path().join("IMG_01.jpg.xmp"), "x").unwrap();
        assert_eq!(find_sidecar(&photo), Some(dir.path().join("IMG_01.jpg.xmp")));

        fs::write(dir.path().join("IMG_01.xmp"), "x").unwrap();
        assert_eq!(find_sidecar(&photo), Some(dir.path().join("IMG_01.xmp")));
    }

    #[test]
    fn sidecar_lookup_ignores_other_photos_and_matches_the_extension_in_any_case() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        fs::write(dir.path().join("IMG_011.xmp"), "x").unwrap();
        fs::write(dir.path().join("IMG_02.xmp"), "x").unwrap();
        assert_eq!(find_sidecar(&photo), None);
        fs::write(dir.path().join("IMG_01.XMP"), "x").unwrap();
        let found = find_sidecar(&photo).expect("an upper-case extension matches");
        assert!(found.file_name().unwrap().to_string_lossy().eq_ignore_ascii_case("IMG_01.xmp"));
    }

    #[test]
    fn a_photo_without_xmp_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        let result = read_for(&photo, Some(1)).unwrap();
        assert_eq!(result.import, None);
        assert_eq!(result.source, None);
        assert_eq!(result.orientation_change, None);
    }

    #[test]
    fn lightroom_sidecar_next_to_a_lisbon_photo_imports_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        fs::write(dir.path().join("IMG_01.xmp"), LIGHTROOM_SIDECAR).unwrap();

        let result = read_for(&photo, Some(1)).unwrap();
        assert_eq!(result.source, Some(XmpSource::Sidecar));
        assert_eq!(result.format, Some(XmpFormat::Crs));
        assert_eq!(result.orientation_change, None);
        assert!(result.sidecar_path.as_deref().unwrap().ends_with("IMG_01.xmp"));
        let import = result.import.unwrap();
        assert_eq!(import.process_version.as_deref(), Some("15.4"));
        assert!(!import.already_applied);

        // The same JSON the editor receives.
        let json = serde_json::to_value(&import).unwrap();
        let s = &json["settings"];
        assert_eq!(s["light"], json!({ "exposure": 0.45, "contrast": 12.0, "highlights": -35.0, "shadows": 28.0, "whites": 6.0, "blacks": -10.0 }));
        assert_eq!(s["whiteBalance"], json!({ "mode": "incremental", "temperature": 8.0, "tint": -3.0 }));
        assert_eq!(s["color"]["vibrance"], json!(18.0));
        assert_eq!(s["color"]["saturation"], json!(-4.0));
        assert_eq!(s["color"]["mix"]["orange"]["saturation"], json!(15.0));
        assert_eq!(s["detail"]["texture"], json!(10.0));
        assert_eq!(s["detail"]["clarity"], json!(16.0));
        assert_eq!(s["detail"]["dehaze"], json!(5.0));
        assert_eq!(s["detail"]["sharpen"]["amount"], json!(45.0));
        let luma = s["curve"]["luma"].as_array().unwrap();
        assert_eq!(luma.len(), 3);
        assert!((luma[1][0].as_f64().unwrap() - 64.0 / 255.0).abs() < 1e-9);
        assert!((luma[1][1].as_f64().unwrap() - 58.0 / 255.0).abs() < 1e-9);
        let crop = &s["geometry"]["crop"];
        assert!((crop["angle"].as_f64().unwrap() - 1.5).abs() < 1e-9);
        assert!((crop["rect"]["x"].as_f64().unwrap() - 0.05).abs() < 1e-9);
        assert!((crop["rect"]["w"].as_f64().unwrap() - 0.9).abs() < 1e-9);
        // camelCase for the editor.
        assert!(json.get("processVersion").is_some());
        assert!(json.get("alreadyApplied").is_some());
        assert_eq!(json["ignored"], json!(["CameraProfile"]));
    }

    #[test]
    fn the_full_name_sidecar_is_read_too() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        fs::write(dir.path().join("IMG_01.jpg.xmp"), LIGHTROOM_SIDECAR).unwrap();
        let result = read_for(&photo, None).unwrap();
        assert!(result.sidecar_path.unwrap().ends_with("IMG_01.jpg.xmp"));
        assert_eq!(result.import.unwrap().settings.light.contrast, 12.0);
    }

    #[test]
    fn a_rotated_sidecar_reports_the_orientation_change() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        fs::write(dir.path().join("IMG_01.xmp"), LIGHTROOM_SIDECAR.replace("tiff:Orientation=\"1\"", "tiff:Orientation=\"6\"")).unwrap();
        // File orientation 1, sidecar 6: the photo was rotated clockwise in Lightroom.
        let result = read_for(&photo, Some(1)).unwrap();
        assert_eq!(result.orientation_change, Some(OrientationChange { rotate: 90, flip_h: false }));
        // Same orientation: nothing to apply. Unknown file orientation: nothing either.
        assert_eq!(read_for(&photo, Some(6)).unwrap().orientation_change, None);
        assert_eq!(read_for(&photo, None).unwrap().orientation_change, None);
    }

    #[test]
    fn a_packet_embedded_in_a_jpeg_is_read_when_there_is_no_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        // Insert an APP1 XMP segment right after SOI.
        let mut jpeg = fs::read(&photo).unwrap();
        let mut payload = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        payload.extend_from_slice(LIGHTROOM_SIDECAR.as_bytes());
        let mut segment = vec![0xFF, 0xE1];
        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(&payload);
        jpeg.splice(2..2, segment);
        fs::write(&photo, jpeg).unwrap();

        let result = read_for(&photo, Some(1)).unwrap();
        assert_eq!(result.source, Some(XmpSource::Embedded));
        assert_eq!(result.sidecar_path, None);
        assert_eq!(result.import.unwrap().settings.light.exposure, 0.45);
    }

    #[test]
    fn photobook_export_is_read_back_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        let mut settings = DevelopSettings::default();
        settings.light.exposure = 0.37;
        settings.color.mix.blue.hue = -12.0;
        let path = write_for(&photo, &settings, Some(1), Some(1600), Some(1067), XmpMode::Photobook).unwrap();
        assert_eq!(path, dir.path().join("IMG_01.xmp"));
        let result = read_for(&photo, Some(1)).unwrap();
        assert_eq!(result.format, Some(XmpFormat::Photobook));
        assert_eq!(result.import.unwrap().settings, settings);
    }

    #[test]
    fn crs_export_merges_into_an_existing_sidecar_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        let sidecar = dir.path().join("IMG_01.xmp");
        fs::write(&sidecar, LIGHTROOM_SIDECAR).unwrap();

        let mut settings = DevelopSettings::default();
        settings.light.exposure = -0.5;
        let path = write_for(&photo, &settings, Some(1), Some(1600), Some(1067), XmpMode::Crs).unwrap();
        assert_eq!(path, sidecar);
        let text = fs::read_to_string(&sidecar).unwrap();
        // Non-crs properties of the old sidecar survive; the old crs ones are replaced.
        assert!(text.contains("Rating"), "{text}");
        assert!(text.contains("-0.5") || text.contains("-0.50"), "{text}");
        assert!(!text.contains("+0.45"), "{text}");
        assert!(text.contains("ExportWarning"), "{text}");
        let bak = dir.path().join("IMG_01.xmp.bak");
        assert_eq!(fs::read_to_string(bak).unwrap(), LIGHTROOM_SIDECAR);
        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        // And our own importer reads the lossy export back at the slider level.
        let back = read_for(&photo, Some(1)).unwrap();
        assert_eq!(back.format, Some(XmpFormat::Crs));
        assert!((back.import.unwrap().settings.light.exposure + 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_backup_symlink_is_replaced_and_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, "keep me").unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        let sidecar = dir.path().join("IMG_01.xmp");
        fs::write(&sidecar, LIGHTROOM_SIDECAR).unwrap();
        let bak = dir.path().join("IMG_01.xmp.bak");
        std::os::unix::fs::symlink(&victim, &bak).unwrap();

        write_for(&photo, &DevelopSettings::default(), Some(1), None, None, XmpMode::Photobook).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert!(!fs::symlink_metadata(&bak).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&bak).unwrap(), LIGHTROOM_SIDECAR);
    }

    #[test]
    fn an_unparsable_sidecar_is_an_error_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let photo = photo_in(dir.path(), "IMG_01.jpg");
        let sidecar = dir.path().join("IMG_01.xmp");
        fs::write(&sidecar, "this is <not xmp").unwrap();
        assert!(read_for(&photo, Some(1)).is_err());
        let err = write_for(&photo, &DevelopSettings::default(), Some(1), None, None, XmpMode::Photobook);
        assert!(err.is_err());
        assert_eq!(fs::read_to_string(&sidecar).unwrap(), "this is <not xmp");
    }
}
