//! The pinned model manifest (`crates/develop/models.toml`, compiled in). See the comments at the top of that file
//! for what each field means and where the sizes and hashes come from.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::{Error, Result};

/// The manifest as shipped.
pub const MANIFEST: &str = include_str!("../../models.toml");

/// What a model is used for. Serialised kebab-case (`people-detect`, `sam-encoder`, ...), as in `models.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    Subject,
    /// A smaller, quicker subject model for instant previews.
    SubjectFast,
    Sky,
    PeopleDetect,
    SamEncoder,
    SamDecoder,
    Depth,
    Denoise,
}

/// One file of a model: the ONNX graph or one of its external data files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelFile {
    /// File name inside `<models>/<name>/<version>/` (a plain name: external data is found by it).
    pub path: String,
    pub url: String,
    pub bytes: u64,
    /// Lower-case hex SHA-256; empty for an unverified entry.
    pub sha256: String,
}

/// One `[[model]]` of the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelEntry {
    /// Stable id, also the folder name.
    pub name: String,
    /// Display name.
    pub title: String,
    /// Changes whenever a file changes; part of the install path and of cache keys.
    pub version: String,
    pub task: Task,
    /// SPDX id.
    pub licence: String,
    pub licence_url: String,
    pub homepage: String,
    /// The static NCHW input shape we feed (empty when the inputs are dynamic prompts).
    pub input: Vec<i64>,
    /// Overrides for the graph's symbolic dimensions, applied when loading (static shapes for CoreML).
    #[serde(default)]
    pub dims: BTreeMap<String, i64>,
    /// False for models whose inputs stay dynamic (the SAM decoder's prompts).
    #[serde(default = "yes")]
    pub static_input: bool,
    /// False while a file's hash is not pinned; such a model cannot be downloaded.
    pub verified: bool,
    /// The graph first, then its external data files.
    pub files: Vec<ModelFile>,
}

fn yes() -> bool {
    true
}

impl ModelEntry {
    /// Sum of the files' sizes.
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.bytes).sum()
    }

    /// The ONNX graph a session loads.
    pub fn primary_file(&self) -> &ModelFile {
        &self.files[0]
    }

    /// Verified with every hash pinned.
    pub fn downloadable(&self) -> bool {
        self.verified && self.files.iter().all(|f| is_sha256(&f.sha256))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    model: Vec<ModelEntry>,
}

/// Every model in the manifest, in manifest order.
#[derive(Debug, Clone)]
pub struct Registry {
    pub models: Vec<ModelEntry>,
}

impl Registry {
    pub fn get(&self, name: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.name == name)
    }

    /// The first model for `task` (the manifest lists the primary one first).
    pub fn for_task(&self, task: Task) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.task == task)
    }
}

/// The compiled-in manifest, parsed once. Panics if `models.toml` is invalid, which `tests::manifest_is_valid`
/// catches before anything ships.
pub fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| parse_manifest(MANIFEST).expect("models.toml is valid"))
}

/// Parse and validate a manifest.
pub fn parse_manifest(text: &str) -> Result<Registry> {
    let manifest: Manifest = toml::from_str(text).map_err(|e| Error::Manifest(e.to_string()))?;
    let mut names = std::collections::HashSet::new();
    for m in &manifest.model {
        let bad = |why: &str| Err(Error::Manifest(format!("{}: {why}", m.name)));
        if !is_slug(&m.name) {
            return bad("name must be lower-case letters, digits, '.', '-' or '_'");
        }
        if !names.insert(m.name.as_str()) {
            return bad("duplicate name");
        }
        if !is_slug(&m.version) {
            return bad("version must be lower-case letters, digits, '.', '-' or '_'");
        }
        if m.files.is_empty() {
            return bad("no files");
        }
        if !m.files[0].path.ends_with(".onnx") {
            return bad("the first file must be the .onnx graph");
        }
        let mut paths = std::collections::HashSet::new();
        for f in &m.files {
            if !is_file_name(&f.path) || !paths.insert(f.path.as_str()) {
                return bad(&format!("bad or duplicate file name {:?}", f.path));
            }
            if !f.url.starts_with("https://") {
                return bad(&format!("{} must be an https URL", f.path));
            }
            if f.bytes == 0 {
                return bad(&format!("{} has no size", f.path));
            }
            if m.verified && !is_sha256(&f.sha256) {
                return bad(&format!("{} is verified but has no lower-case hex SHA-256", f.path));
            }
            if !f.sha256.is_empty() && !is_sha256(&f.sha256) {
                return bad(&format!("{} has a malformed SHA-256", f.path));
            }
        }
        if !m.homepage.starts_with("https://") || !m.licence_url.starts_with("https://") {
            return bad("homepage and licence_url must be https URLs");
        }
        if m.static_input && m.input.iter().any(|&d| d <= 0) {
            return bad("static input shape must be positive");
        }
        if m.dims.values().any(|&d| d <= 0) {
            return bad("dimension overrides must be positive");
        }
    }
    Ok(Registry { models: manifest.model })
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// A plain file name: no separators, no `..`, nothing hidden.
fn is_file_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub(crate) fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        let r = registry();
        assert!(r.models.len() >= 7);
        for task in [Task::Subject, Task::Sky, Task::PeopleDetect, Task::SamEncoder, Task::SamDecoder, Task::Depth] {
            let m = r.for_task(task).unwrap_or_else(|| panic!("no model for {task:?}"));
            assert!(m.downloadable(), "{} must be pinned", m.name);
        }
        let sky = r.get("skywater-seg").unwrap();
        assert_eq!(sky.input, vec![1, 3, 384, 384]);
        assert_eq!(sky.total_bytes(), 49_867_699);
        // Only permissive licences ship (plan section 2).
        for m in &r.models {
            assert!(["MIT", "Apache-2.0", "BSD-3-Clause"].contains(&m.licence.as_str()), "{}", m.name);
        }
    }

    #[test]
    fn rejects_bad_entries() {
        let ok = r#"
            [[model]]
            name = "x"
            title = "X"
            version = "1"
            task = "sky"
            licence = "MIT"
            licence_url = "https://example.com"
            homepage = "https://example.com"
            input = [1, 3, 8, 8]
            verified = true
            [[model.files]]
            path = "x.onnx"
            url = "https://example.com/x.onnx"
            bytes = 10
            sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
        "#;
        assert!(parse_manifest(ok).is_ok());
        assert!(parse_manifest(&ok.replace("x.onnx\"\n", "../x.onnx\"\n")).is_err());
        assert!(parse_manifest(&ok.replace("path = \"x.onnx\"", "path = \"x.bin\"")).is_err());
        assert!(parse_manifest(&ok.replace("name = \"x\"", "name = \"X/\"")).is_err());
        assert!(parse_manifest(&ok.replace("https://example.com/x.onnx", "http://example.com/x.onnx")).is_err());
        assert!(parse_manifest(&ok.replace("0000000000000000000000000000000000000000000000000000000000000000", "")).is_err());
        assert!(parse_manifest(&ok.replace("task = \"sky\"", "task = \"weather\"")).is_err());
        // Unverified entries may leave the hash empty.
        let unverified = ok
            .replace("verified = true", "verified = false")
            .replace("0000000000000000000000000000000000000000000000000000000000000000", "");
        let r = parse_manifest(&unverified).unwrap();
        assert!(!r.models[0].downloadable());
    }
}
