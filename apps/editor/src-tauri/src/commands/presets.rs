//! Develop presets (step D6.3): named subsets of `DevelopSettings`, stored one file each in
//! `<appdata>/presets/<id>.json` (never in the book: they belong to the machine and apply to any photo).
//!
//! - `list_presets` returns the saved presets sorted by name (a file that does not validate is skipped, not fatal).
//! - `save_preset(preset)` validates and writes `<id>.json` atomically.
//! - `delete_preset(id)` removes it (already gone is fine).
//!
//! The built-in presets ("Black & white", "Faded") live in the editor (`lib/develop/presets.ts`) and are never
//! written here, so `built_in` is always false on disk. A preset carries only the tone, colour and effects sections
//! (`light`, `whiteBalance`, `curve`, `color`, `detail`, `effects`, and the LUT `look` of plan 18): geometry and masks
//! belong to the photo. A look (plan 20) is a preset with `look: true`.

use std::fs;
use std::path::{Path, PathBuf};

use photobook_develop::settings::DevelopSettings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::commands::assets::write_atomic;
use crate::error::{Error, IoContext, Result};
use crate::scope::{app_data_dir, ensure_allowed};

const PRESETS_DIR: &str = "presets";
/// The sections a preset may carry (the keys of `DevelopSettings` that are tone, colour and effects).
pub const SECTIONS: [&str; 7] = ["light", "whiteBalance", "curve", "color", "detail", "effects", "look"];
const MAX_NAME_CHARS: usize = 80;
/// Largest preset file read or written (a preset is a few KB; this stops a stray file from being loaded).
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// A ULID, minted by the editor.
    pub id: String,
    pub name: String,
    /// Which of [`SECTIONS`] the preset applies, in the order shown.
    pub sections: Vec<String>,
    /// `Partial<DevelopSettings>`: exactly the keys named in `sections`.
    pub settings: Value,
    #[serde(default)]
    pub built_in: bool,
    /// A look (workflow plan 20): the Looks strip lists it and applies it with an Amount. Written only when true.
    #[serde(default, skip_serializing_if = "is_false")]
    pub look: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A 26-character Crockford base32 ULID (no `I`, `L`, `O`, `U`; the first digit at most 7). The id becomes a
/// file name, so nothing else is accepted.
pub fn is_ulid(id: &str) -> bool {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    id.len() == 26
        && id.bytes().all(|b| ALPHABET.contains(&b))
        && id.as_bytes().first().is_some_and(|b| *b <= b'7')
}

/// Check everything the file name and the settings rely on.
pub fn validate(preset: &Preset) -> Result<()> {
    if !is_ulid(&preset.id) {
        return Err(Error::Invalid(format!("Invalid preset id {:?}", preset.id)));
    }
    let name = preset.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::Invalid(format!("A preset name has 1 to {MAX_NAME_CHARS} characters")));
    }
    if preset.sections.is_empty() {
        return Err(Error::Invalid("A preset needs at least one section".into()));
    }
    for (i, section) in preset.sections.iter().enumerate() {
        if !SECTIONS.contains(&section.as_str()) {
            return Err(Error::Invalid(format!("Unknown preset section {section:?}: presets never contain geometry or masks")));
        }
        if preset.sections[..i].contains(section) {
            return Err(Error::Invalid(format!("Duplicate preset section {section:?}")));
        }
    }
    let Value::Object(settings) = &preset.settings else {
        return Err(Error::Invalid("Preset settings must be an object".into()));
    };
    for key in settings.keys() {
        if !preset.sections.iter().any(|s| s == key) {
            return Err(Error::Invalid(format!("Preset settings contain {key:?}, which is not one of its sections")));
        }
    }
    // The settings must be the right shape: serde fills the rest with defaults.
    serde_json::from_value::<DevelopSettings>(preset.settings.clone())
        .map_err(|e| Error::Invalid(format!("Invalid preset settings: {e}")))?;
    Ok(())
}

fn file_for(dir: &Path, id: &str) -> Result<PathBuf> {
    if !is_ulid(id) {
        return Err(Error::Invalid(format!("Invalid preset id {id:?}")));
    }
    Ok(dir.join(format!("{id}.json")))
}

/// Every valid preset in `dir`, by name (case-insensitive), then id. Unreadable or invalid files are skipped.
pub fn list_in(dir: &Path) -> Vec<Preset> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut presets: Vec<Preset> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let stem = path.file_stem()?.to_str()?.to_string();
            if path.extension()?.to_str()? != "json" || !is_ulid(&stem) {
                return None;
            }
            if e.metadata().ok()?.len() > MAX_BYTES {
                return None;
            }
            let mut preset: Preset = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            // The file name is the identity; a renamed file would otherwise shadow another preset.
            if preset.id != stem || validate(&preset).is_err() {
                return None;
            }
            preset.built_in = false;
            Some(preset)
        })
        .collect();
    presets.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    presets
}

/// Validate and write `preset` into `dir`.
pub fn save_in(dir: &Path, preset: &Preset) -> Result<()> {
    validate(preset)?;
    let stored = Preset { name: preset.name.trim().to_string(), built_in: false, ..preset.clone() };
    let json = serde_json::to_vec_pretty(&stored).map_err(|e| Error::Invalid(e.to_string()))?;
    if json.len() as u64 > MAX_BYTES {
        return Err(Error::Invalid("This preset is too large".into()));
    }
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    write_atomic(&file_for(dir, &preset.id)?, &json)
}

/// Remove a preset from `dir`; a preset that is already gone is not an error.
pub fn delete_in(dir: &Path, id: &str) -> Result<()> {
    let file = file_for(dir, id)?;
    match fs::remove_file(&file) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(Error::Io(format!("deleting {}", file.display()), err)),
    }
}

fn presets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    ensure_allowed(app, app_data_dir(app)?.join(PRESETS_DIR))
}

/// The user's saved presets (the built-in ones are the editor's).
#[tauri::command]
pub async fn list_presets<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Preset>> {
    let dir = presets_dir(&app)?;
    Ok(list_in(&dir))
}

#[tauri::command]
pub async fn save_preset<R: Runtime>(app: AppHandle<R>, preset: Preset) -> Result<()> {
    save_in(&presets_dir(&app)?, &preset)
}

#[tauri::command]
pub async fn delete_preset<R: Runtime>(app: AppHandle<R>, id: String) -> Result<()> {
    delete_in(&presets_dir(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID_A: &str = "01J9ZK3Y8M0Q4R5T6V7W8X9YAB";
    const ID_B: &str = "01J9ZK3Y8M0Q4R5T6V7W8X9YCD";

    fn preset(id: &str, name: &str) -> Preset {
        Preset {
            id: id.into(),
            name: name.into(),
            sections: vec!["color".into()],
            settings: json!({ "color": { "saturation": -30 } }),
            built_in: false,
            look: false,
        }
    }

    #[test]
    fn ulid_check_is_strict() {
        assert!(is_ulid(ID_A));
        assert!(!is_ulid(""));
        assert!(!is_ulid("01J9ZK3Y8M0Q4R5T6V7W8X9YA")); // 25
        assert!(!is_ulid("01J9ZK3Y8M0Q4R5T6V7W8X9YABC")); // 27
        assert!(!is_ulid("01j9zk3y8m0q4r5t6v7w8x9yab")); // lower case
        assert!(!is_ulid("01J9ZK3Y8M0Q4R5T6V7W8X9YAI")); // I is not in the alphabet
        assert!(!is_ulid("81J9ZK3Y8M0Q4R5T6V7W8X9YAB")); // overflows 128 bits
        assert!(!is_ulid("../../../etc/passwd.............."));
        assert!(!is_ulid("01J9ZK3Y8M0Q4R5T6V7W8X9Y/B"));
    }

    #[test]
    fn validation_rejects_bad_presets() {
        assert!(validate(&preset(ID_A, "Warm")).is_ok());
        assert!(validate(&preset("not-an-id", "Warm")).is_err());
        assert!(validate(&preset(ID_A, "   ")).is_err());
        assert!(validate(&preset(ID_A, &"x".repeat(81))).is_err());

        let mut p = preset(ID_A, "Warm");
        p.sections = vec![];
        assert!(validate(&p).is_err());

        let mut p = preset(ID_A, "Warm");
        p.sections = vec!["geometry".into()];
        p.settings = json!({ "geometry": { "rotate": 90 } });
        assert!(validate(&p).is_err(), "geometry never goes into a preset");

        let mut p = preset(ID_A, "Warm");
        p.sections = vec!["masks".into()];
        p.settings = json!({ "masks": [] });
        assert!(validate(&p).is_err(), "masks never go into a preset");

        let mut p = preset(ID_A, "Warm");
        p.sections = vec!["color".into(), "color".into()];
        assert!(validate(&p).is_err());

        // A settings key that its sections do not list.
        let mut p = preset(ID_A, "Warm");
        p.settings = json!({ "color": { "saturation": -30 }, "light": { "exposure": 1 } });
        assert!(validate(&p).is_err());

        // Not an object, or the wrong shape.
        let mut p = preset(ID_A, "Warm");
        p.settings = json!([]);
        assert!(validate(&p).is_err());
        let mut p = preset(ID_A, "Warm");
        p.settings = json!({ "color": { "saturation": "lots" } });
        assert!(validate(&p).is_err());
    }

    #[test]
    fn save_list_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path().join("presets");
        assert!(list_in(&presets).is_empty(), "a missing folder lists as empty");

        save_in(&presets, &preset(ID_B, "b second")).unwrap();
        save_in(&presets, &preset(ID_A, "  A first ")).unwrap();
        let listed = list_in(&presets);
        assert_eq!(listed.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["A first", "b second"]);
        assert!(listed.iter().all(|p| !p.built_in));

        // Saving again with the same id replaces it.
        let mut changed = preset(ID_A, "A renamed");
        changed.built_in = true; // never stored as built in
        save_in(&presets, &changed).unwrap();
        let listed = list_in(&presets);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "A renamed");
        assert!(!listed[0].built_in);

        delete_in(&presets, ID_A).unwrap();
        delete_in(&presets, ID_A).unwrap();
        assert_eq!(list_in(&presets).len(), 1);
        assert!(delete_in(&presets, "../x").is_err());
        let names: Vec<_> = fs::read_dir(&presets).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [format!("{ID_B}.json")], "no temp files left behind");
    }

    #[test]
    fn listing_skips_files_that_do_not_belong() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path();
        save_in(presets, &preset(ID_A, "Good")).unwrap();
        fs::write(presets.join("notes.json"), "{}").unwrap();
        fs::write(presets.join(format!("{ID_B}.json")), "not json").unwrap();
        // A valid preset under another preset's file name is not trusted.
        fs::write(presets.join("01J9ZK3Y8M0Q4R5T6V7W8X9YEF.json"), serde_json::to_vec(&preset(ID_A, "Imposter")).unwrap()).unwrap();
        // A geometry-carrying file is invalid.
        let mut bad = preset("01J9ZK3Y8M0Q4R5T6V7W8X9YGH", "Bad");
        bad.sections = vec!["geometry".into()];
        bad.settings = json!({ "geometry": {} });
        fs::write(presets.join("01J9ZK3Y8M0Q4R5T6V7W8X9YGH.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
        fs::write(presets.join(".hidden.tmp"), "x").unwrap();

        let listed = list_in(presets);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Good");
    }

    #[test]
    fn the_look_flag_is_persisted_and_left_out_of_plain_presets() {
        let dir = tempfile::tempdir().unwrap();
        let mut look = preset(ID_A, "Warm film");
        look.look = true;
        look.sections = vec!["effects".into(), "look".into()];
        look.settings = json!({ "effects": { "grain": { "amount": 30 } }, "look": { "lut": null } });
        save_in(dir.path(), &look).unwrap();
        save_in(dir.path(), &preset(ID_B, "Plain")).unwrap();
        let listed = list_in(dir.path());
        assert!(listed.iter().find(|p| p.id == ID_A).unwrap().look);
        assert!(!listed.iter().find(|p| p.id == ID_B).unwrap().look);
        let raw: Value = serde_json::from_slice(&fs::read(dir.path().join(format!("{ID_B}.json"))).unwrap()).unwrap();
        assert!(raw.get("look").is_none(), "a plain preset file is unchanged");
        let raw: Value = serde_json::from_slice(&fs::read(dir.path().join(format!("{ID_A}.json"))).unwrap()).unwrap();
        assert_eq!(raw["look"], json!(true));
    }

    #[test]
    fn the_json_shape_is_camel_case() {
        let value = serde_json::to_value(preset(ID_A, "Warm")).unwrap();
        assert_eq!(value["builtIn"], json!(false));
        let back: Preset = serde_json::from_value(json!({
            "id": ID_A, "name": "Warm", "sections": ["color"], "settings": { "color": {} }
        }))
        .unwrap();
        assert!(!back.built_in, "builtIn may be left out");
    }
}
