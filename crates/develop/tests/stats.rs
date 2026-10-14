//! Plan 38: the photo stats on the synthetic fixtures of `tests/fixtures/stats/` (`scripts/make-stats-fixtures.py`).
//!
//! - the sharp frame ranks above every other on `sharpnessMax`, and the bokeh portrait is not below the defocused one;
//! - `motion` is above 0.6 on the panned frame only;
//! - the clip shares and the median luma are within 1 % of the script's Python reference (`reference.json`);
//! - the perceptual hash is near for frames of one scene and far for different scenes;
//! - the capture time, lens and focal length come out of the fixtures' Exif;
//! - plan 56: the palette is five hex colours, the same on every run, darker for the dark frame than the high-key one;
//!   and its time on a proxy-sized frame is printed (`--nocapture`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use photobook_develop::decode::camera_exif;
use photobook_develop::stats::{luma, palette, phash, photo_stats, PhotoStats};

const FRAMES: [&str; 8] = [
    "sharp.jpg",
    "defocused.jpg",
    "panned.jpg",
    "bokeh-portrait.jpg",
    "blown.jpg",
    "dark.jpg",
    "silhouette.jpg",
    "high-key.jpg",
];

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stats")
}

/// Decoded RGB, width, height.
fn decode(name: &str) -> (Vec<u8>, u32, u32) {
    let bytes = std::fs::read(dir().join(name)).unwrap();
    let image = turbojpeg::decompress(&bytes, turbojpeg::PixelFormat::RGB).unwrap();
    assert_eq!(image.pitch, image.width * 3);
    (image.pixels, image.width as u32, image.height as u32)
}

fn all() -> BTreeMap<&'static str, (PhotoStats, u64)> {
    FRAMES
        .iter()
        .map(|&name| {
            let (rgb, w, h) = decode(name);
            let gray = luma(&rgb);
            (name, (photo_stats(&gray, &rgb, w, h, None), phash(&gray, w, h)))
        })
        .collect()
}

#[test]
fn stats_tell_the_fixture_frames_apart() {
    let stats = all();
    for (name, (s, hash)) in &stats {
        println!("{name:20} {s:?} phash {hash:016x}");
    }
    let s = |name: &str| stats[name].0;

    // Sharpness ranks frames of one scene (a hard silhouette edge against a clipped sky is legitimately sharper).
    let sharp = s("sharp.jpg").sharpness_max;
    for name in ["defocused.jpg", "panned.jpg", "bokeh-portrait.jpg", "blown.jpg", "dark.jpg", "high-key.jpg"] {
        assert!(s(name).sharpness_max < sharp, "{name} is not below sharp.jpg on sharpnessMax");
    }
    assert!(s("bokeh-portrait.jpg").sharpness_max >= s("defocused.jpg").sharpness_max);
    // The portrait's sharp subject sits in the middle of the frame (tiles of rows 2-5, columns 2-5).
    let tile = s("bokeh-portrait.jpg").sharpest_tile as usize;
    assert!((2..6).contains(&(tile / 8)) && (2..6).contains(&(tile % 8)), "sharpest tile {tile}");

    for name in FRAMES {
        let motion = s(name).motion;
        if name == "panned.jpg" {
            assert!(motion > 0.6, "{name}: motion {motion}");
        } else {
            assert!(motion <= 0.6, "{name}: motion {motion}");
        }
    }
}

#[test]
fn clip_shares_match_the_python_reference() {
    let text = std::fs::read_to_string(dir().join("reference.json")).unwrap();
    let reference: BTreeMap<String, BTreeMap<String, f64>> = serde_json::from_str(&text).unwrap();
    for (name, (s, _)) in all() {
        let r = &reference[name];
        for (field, ours) in [("clipHigh", s.clip_high), ("clipLow", s.clip_low), ("medianLum", s.median_lum)] {
            let theirs = r[field];
            assert!((ours as f64 - theirs).abs() <= 0.01, "{name} {field}: {ours} vs the reference {theirs}");
        }
    }
}

#[test]
fn phash_groups_one_scene_and_splits_another() {
    let stats = all();
    let distance = |a: &str, b: &str| (stats[a].1 ^ stats[b].1).count_ones();
    // One scene, a little brighter or softer: near. A different scene: far.
    assert!(distance("sharp.jpg", "defocused.jpg") <= 16, "{}", distance("sharp.jpg", "defocused.jpg"));
    assert!(distance("sharp.jpg", "dark.jpg") <= 16, "{}", distance("sharp.jpg", "dark.jpg"));
    assert!(distance("sharp.jpg", "silhouette.jpg") > 16, "{}", distance("sharp.jpg", "silhouette.jpg"));
}

#[test]
fn the_fixtures_carry_capture_time_and_lens() {
    let first = camera_exif(&dir().join("sharp.jpg"));
    let second = camera_exif(&dir().join("defocused.jpg"));
    // 2026-10-13 10:00:00.050 and one second later, SubSecTimeOriginal "05".
    assert_eq!(first.taken, Some(1_791_885_600_050));
    assert_eq!(second.taken.zip(first.taken).map(|(b, a)| b - a), Some(1000));
    assert_eq!(first.lens.as_deref(), Some("Fixture 35mm F2"));
    assert_eq!(first.focal, Some(35.0));
    assert_eq!((first.make.as_deref(), first.model.as_deref()), (Some("Photobook"), Some("Synthetic")));
}

#[test]
fn palette_is_stable_and_follows_the_frame() {
    // Rec. 709 luma of a `#rrggbb`, 0 to 255.
    let lum = |hex: &str| {
        let v = u32::from_str_radix(&hex[1..], 16).unwrap();
        0.2126 * (v >> 16) as f64 + 0.7152 * ((v >> 8) & 255) as f64 + 0.0722 * (v & 255) as f64
    };
    let mut first = BTreeMap::new();
    for name in FRAMES {
        let (rgb, w, h) = decode(name);
        let start = std::time::Instant::now();
        let p = palette(&rgb, w, h);
        println!("{name:20} {p:?} in {:?} ({w}x{h})", start.elapsed());
        assert_eq!(p.len(), 5);
        assert!(p.iter().all(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|d| d.is_ascii_hexdigit())));
        assert_eq!(palette(&rgb, w, h), p, "{name}: not deterministic");
        first.insert(name, p);
    }
    let mean = |name: &str| first[name].iter().map(|c| lum(c)).sum::<f64>() / 5.0;
    assert!(mean("dark.jpg") < mean("sharp.jpg") && mean("sharp.jpg") < mean("high-key.jpg"));
}
