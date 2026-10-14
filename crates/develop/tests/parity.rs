//! Parity with the TypeScript schema: every fixture in `tests/fixtures/` is written by
//! `packages/shared/src/develop/parity.test.ts` as `{ settings, canonical, hash }`. The Rust mirror must
//! read `settings` and produce the same canonical string and hash byte for byte.
//!
//! Regenerate the fixtures with `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test`.

use std::fs;
use std::path::PathBuf;

use photobook_develop::settings::{CropAspect, MaskShape, UprightMode};
use photobook_develop::{canonical_json, develop_hash, develop_hash_input, DevelopSettings, ENGINE_VERSION};
use serde_json::Value;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// JSON tree equality that treats `1` and `1.0` as the same number (serde_json keeps integers and
/// floats apart; JS has only one number type).
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same_json(x, y)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same_json(v, w)))
        }
        _ => a == b,
    }
}

struct Fixture {
    name: String,
    settings: Value,
    canonical: String,
    hash: String,
}

fn load(name: &str) -> Fixture {
    let path = fixtures_dir().join(format!("{name}.json"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let json: Value = serde_json::from_str(&text).unwrap();
    Fixture {
        name: name.to_string(),
        settings: json["settings"].clone(),
        canonical: json["canonical"].as_str().unwrap().to_string(),
        hash: json["hash"].as_str().unwrap().to_string(),
    }
}

fn all() -> Vec<Fixture> {
    let mut names: Vec<String> = fs::read_dir(fixtures_dir())
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".json").map(str::to_string)
        })
        .collect();
    names.sort();
    names.iter().map(|n| load(n)).collect()
}

#[test]
fn every_fixture_round_trips_to_the_same_canonical_string_and_hash() {
    let fixtures = all();
    assert!(fixtures.len() >= 3, "expected the generated fixtures in {}", fixtures_dir().display());
    for f in fixtures {
        let settings: DevelopSettings =
            serde_json::from_value(f.settings.clone()).unwrap_or_else(|e| panic!("{}: {e}", f.name));
        // The canonical form of the JSON as written by TS, without going through the structs.
        assert_eq!(
            format!("{}\n{}", canonical_json(&f.settings), ENGINE_VERSION),
            f.canonical,
            "{}: canonical_json of the raw fixture",
            f.name
        );
        // Through the structs: every field present, same names, same number formatting.
        assert_eq!(develop_hash_input(&settings), f.canonical, "{}: canonical string", f.name);
        assert_eq!(develop_hash(&settings), f.hash, "{}: hash", f.name);
        // And the serialised struct equals the parsed TS settings as a JSON tree.
        assert!(same_json(&serde_json::to_value(&settings).unwrap(), &f.settings), "{}: settings tree", f.name);
    }
}

#[test]
fn default_settings_match_the_defaults_fixture() {
    let f = load("defaults");
    let default = DevelopSettings::default();
    assert!(default.is_default());
    assert!(same_json(&serde_json::to_value(&default).unwrap(), &f.settings));
    assert_eq!(develop_hash_input(&default), f.canonical);
    assert_eq!(develop_hash(&default), f.hash);
    let parsed: DevelopSettings = serde_json::from_value(f.settings).unwrap();
    assert_eq!(parsed, default);
}

#[test]
fn only_the_defaults_fixture_is_default() {
    for f in all() {
        let settings: DevelopSettings = serde_json::from_value(f.settings).unwrap();
        assert_eq!(settings.is_default(), f.name == "defaults", "{}", f.name);
    }
}

#[test]
fn everything_fixture_exercises_each_variant() {
    let settings: DevelopSettings = serde_json::from_value(load("everything").settings).unwrap();
    assert_eq!(settings.geometry.upright.mode, UprightMode::Guided);
    assert!(settings.geometry.upright.transform.is_some());
    let crop = settings.geometry.crop.as_ref().unwrap();
    assert_eq!(crop.aspect, CropAspect::Ratio(4.0, 5.0));
    assert!(settings.detail.denoise.is_some());
    let kinds: Vec<&str> = settings
        .masks
        .iter()
        .flat_map(|m| &m.components)
        .map(|c| match c.shape {
            MaskShape::Brush { .. } => "brush",
            MaskShape::Linear { .. } => "linear",
            MaskShape::Radial { .. } => "radial",
            MaskShape::Luminance { .. } => "luminance",
            MaskShape::Color { .. } => "color",
            MaskShape::Ai { .. } => "ai",
        })
        .collect();
    for kind in ["brush", "linear", "radial", "luminance", "color", "ai"] {
        assert!(kinds.contains(&kind), "no {kind} mask component");
    }
}
