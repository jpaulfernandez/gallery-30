//! Plan 55: the engine bump to `develop-engine/4` changes nothing but the hash for settings without the new grading
//! fields (`luminance` 0 on every wheel, no Global wheel). This ignored test renders the ON1 sample RAWs
//! (`PHOTOBOOK_RAW_DIR`, default `~/Pictures/ON1 Samples`) at the 1600 px proxy size with every settings fixture that
//! needs no AI model (the parity fixtures and the built-in looks), on the CPU and on the GPU, and compares one SHA-256
//! of the 8-bit output per render with the committed baseline of the current engine,
//! `tests/fixtures/engine-bump/digests-engine-<n>.txt`. `UPDATE_ENGINE_DIGESTS=1` writes that baseline instead;
//! `PHOTOBOOK_BUMP_OUT=<file>` also writes the digests there. Without the ON1 samples it prints a line and passes.
//!
//! The digests are those of the machine that wrote them (Apple M3 Pro, Metal, macOS): another GPU or CPU may differ
//! in the last bit, so regenerate the baseline on the machine that checks it. The bump procedure is in the crate
//! README ("Engine version").
//!
//! `cargo test -p photobook-develop --release --test engine_bump -- --ignored --nocapture`

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use photobook_develop::decode::is_raw_path;
use photobook_develop::geometry::Quality;
use photobook_develop::{
    decode_file, render_full_with_options, DevelopSettings, RenderBackend, RenderOptions, ENGINE_VERSION,
};
use sha2::{Digest, Sha256};

/// Settings fixtures without AI masks or denoise (those need downloaded models).
const SETTINGS: &[&str] = &[
    "defaults.json",
    "light-only.json",
    "effects.json",
    "look.json",
    "numbers.json",
    "white-balance-absolute.json",
    "looks/dove.json",
    "looks/egret.json",
    "looks/heron.json",
    "looks/kestrel.json",
    "looks/kingfisher.json",
    "looks/magpie.json",
    "looks/oriole.json",
    "looks/owl.json",
    "looks/robin.json",
    "looks/rook.json",
    "looks/sparrow.json",
    "looks/starling.json",
];

/// The committed baseline of the current engine (`develop-engine/4` → `digests-engine-4.txt`).
fn baseline(fixtures: &Path) -> PathBuf {
    let n = ENGINE_VERSION.rsplit('/').next().unwrap_or(ENGINE_VERSION);
    fixtures.join(format!("engine-bump/digests-engine-{n}.txt"))
}

fn settings(fixtures: &Path, name: &str) -> DevelopSettings {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fixtures.join(name)).unwrap()).unwrap();
    serde_json::from_value(json["settings"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
#[ignore = "needs the ON1 sample RAWs (PHOTOBOOK_RAW_DIR or ~/Pictures/ON1 Samples); run with --release"]
fn on1_sample_digests() {
    let dir = std::env::var_os("PHOTOBOOK_RAW_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Pictures/ON1 Samples"));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("no RAW directory at {}", dir.display());
        return;
    };
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    photobook_develop::lut::set_lut_dir(Some(fixtures.join("luts")));
    let all: Vec<(&str, DevelopSettings)> = SETTINGS.iter().map(|n| (*n, settings(&fixtures, n))).collect();
    let mut files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| is_raw_path(p)).collect();
    files.sort();
    let mut out = String::new();
    for path in files {
        let file = path.file_name().unwrap().to_string_lossy().to_string();
        let image = decode_file(&path, Some(1600)).unwrap_or_else(|e| panic!("{file}: {e}"));
        for (name, s) in &all {
            for backend in [RenderBackend::Cpu, RenderBackend::Gpu] {
                let options = RenderOptions { backend, ..RenderOptions::for_image(&image.meta) };
                let rendered = render_full_with_options(&image, s, Quality::for_size(image.width, image.height), &options)
                    .unwrap_or_else(|e| panic!("{file} {name}: {e}"));
                let digest = Sha256::digest(&rendered.data);
                let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                writeln!(out, "{file}\t{name}\t{backend:?}\t{}x{}\t{hex}", rendered.width, rendered.height).unwrap();
            }
        }
        eprintln!("{file}: done");
    }
    if let Some(target) = std::env::var_os("PHOTOBOOK_BUMP_OUT") {
        std::fs::write(&target, &out).unwrap();
        eprintln!("wrote {}", PathBuf::from(target).display());
    }
    let base = baseline(&fixtures);
    if std::env::var_os("UPDATE_ENGINE_DIGESTS").is_some() {
        std::fs::create_dir_all(base.parent().unwrap()).unwrap();
        std::fs::write(&base, &out).unwrap();
        eprintln!("wrote the baseline {}", base.display());
        return;
    }
    let stored = std::fs::read_to_string(&base).unwrap_or_else(|e| {
        panic!("{}: {e} (write it with UPDATE_ENGINE_DIGESTS=1, see the crate README)", base.display())
    });
    let differ: Vec<String> = stored
        .lines()
        .zip(out.lines())
        .filter(|(a, b)| a != b)
        .map(|(a, b)| format!("  was {a}\n  now {b}"))
        .collect();
    assert_eq!(stored.lines().count(), out.lines().count(), "{}: a different set of renders", base.display());
    assert!(differ.is_empty(), "{} renders differ from {}:\n{}", differ.len(), base.display(), differ.join("\n"));
    eprintln!("{} renders byte-identical to {}", out.lines().count(), base.display());
}
