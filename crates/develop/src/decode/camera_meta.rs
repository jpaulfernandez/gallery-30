//! Camera make, model and ISO of a photo file (workflow plan 23), read from its metadata only (no pixel decode).
//!
//! JPEG, TIFF-based RAWs (DNG, NEF, ARW, CR2, PEF, ...), HEIC and PNG through `kamadak-exif` (it reads only the
//! headers); with the `raw` feature a RAW file whose Exif lacks a field is then read through `rawler` (CR3 and RAF
//! are not TIFF), which maps the whole file. ISO 0 and 65535 (the "too high to say" value) count as absent, and the
//! next ISO tag is tried. Names are normalised ([`clean_make`], [`clean_model`]) so a camera's JPEGs and RAWs
//! agree: `FUJIFILM` + `X-T5` and rawler's `Fujifilm` + `X-T5` are both "Fujifilm X-T5".
//!
//! Plan 38 adds what the cull groups on: the capture time (`taken`), the lens, the focal length and the body serial.
//! `taken` is the camera's wall clock (`DateTimeOriginal` + `SubSecTimeOriginal`, else `DateTime` + `SubSecTime`)
//! read as if it were UTC, in epoch ms: the offset tags are ignored, so photos of one camera always compare on the
//! clock it showed, whether or not it wrote an offset.
//!
//! Plan 52 adds what the Photo pane shows: the exposure time (`shutter`, seconds), the f-number (`aperture`) and the
//! location (`gps`, decimal degrees from the GPS IFD; `0, 0` and out-of-range values count as absent).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the noise profile (plan 23) and the cull (plan 38) need to know about the camera and the moment. Every field
/// is optional: a scan, a screenshot or an exported file often has none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraExif {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// ISO speed (`PhotographicSensitivity`, else `ISOSpeed`, else `RecommendedExposureIndex`; 0 and 65535 skipped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// Capture time, epoch ms of the camera's clock read as UTC (see the module notes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<i64>,
    /// `LensModel`, trimmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    /// `FocalLength`, mm (0 counts as absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal: Option<f64>,
    /// `BodySerialNumber`, trimmed: tells two bodies of one model apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// `ExposureTime`, seconds (0 counts as absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shutter: Option<f64>,
    /// `FNumber` (0 counts as absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aperture: Option<f64>,
    /// Where the photo was taken (the GPS IFD), decimal degrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gps: Option<Gps>,
}

/// A position in decimal degrees: latitude north positive, longitude east positive.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Gps {
    pub lat: f64,
    pub lon: f64,
}

impl Gps {
    /// The position when it is one: finite, in range, and not `0, 0` (what a camera without a fix often writes).
    pub fn valid(lat: f64, lon: f64) -> Option<Gps> {
        let ok = lat.is_finite()
            && lon.is_finite()
            && (-90.0..=90.0).contains(&lat)
            && (-180.0..=180.0).contains(&lon)
            && !(lat == 0.0 && lon == 0.0);
        ok.then_some(Gps { lat, lon })
    }
}

impl CameraExif {
    /// "Fujifilm X-T5" (or whichever of the two is known), `None` when neither is.
    pub fn camera_name(&self) -> Option<String> {
        match (&self.make, &self.model) {
            (Some(make), Some(model)) => Some(format!("{make} {model}")),
            (Some(one), None) | (None, Some(one)) => Some(one.clone()),
            (None, None) => None,
        }
    }

    #[cfg_attr(not(feature = "raw"), allow(dead_code))]
    fn is_complete(&self) -> bool {
        self.make.is_some() && self.model.is_some() && self.iso.is_some() && self.taken.is_some()
    }

    /// Fill the fields this one lacks from `other`.
    #[cfg_attr(not(feature = "raw"), allow(dead_code))]
    fn or(self, other: CameraExif) -> CameraExif {
        CameraExif {
            make: self.make.or(other.make),
            model: self.model.or(other.model),
            iso: self.iso.or(other.iso),
            taken: self.taken.or(other.taken),
            lens: self.lens.or(other.lens),
            focal: self.focal.or(other.focal),
            serial: self.serial.or(other.serial),
            shutter: self.shutter.or(other.shutter),
            aperture: self.aperture.or(other.aperture),
            gps: self.gps.or(other.gps),
        }
    }
}

/// The camera metadata of `path`; empty fields when the file has none or cannot be read (never an error).
pub fn camera_exif(path: &Path) -> CameraExif {
    let exif = kamadak_exif(path);
    #[cfg(feature = "raw")]
    let exif = if !exif.is_complete() && super::is_raw_path(path) { exif.or(raw_exif(path)) } else { exif };
    normalised(exif)
}

/// An ISO value that means something: not 0, not 65535 (the 16-bit tag's "65535 or higher"; the 32-bit
/// `ISOSpeed` and `RecommendedExposureIndex` carry higher values).
fn real_iso(iso: u32) -> Option<u32> {
    (iso > 0 && iso != 65535).then_some(iso)
}

fn normalised(exif: CameraExif) -> CameraExif {
    let make = exif.make.as_deref().map(clean_make).filter(|m| !m.is_empty());
    let model = exif.model.as_deref().map(|m| clean_model(make.as_deref(), m)).filter(|m| !m.is_empty());
    let trimmed = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    CameraExif {
        make,
        model,
        iso: exif.iso.and_then(real_iso),
        taken: exif.taken,
        lens: trimmed(exif.lens),
        focal: exif.focal.filter(|f| f.is_finite() && *f > 0.0),
        serial: trimmed(exif.serial),
        shutter: exif.shutter.filter(|s| s.is_finite() && *s > 0.0),
        aperture: exif.aperture.filter(|a| a.is_finite() && *a > 0.0),
        gps: exif.gps.and_then(|g| Gps::valid(g.lat, g.lon)),
    }
}

/// Epoch ms of an Exif date (`YYYY:MM:DD HH:MM:SS`) read as UTC, plus its subsecond string (decimal digits after
/// the point: "05" is 50 ms, "5" is 500 ms). `None` for a blank, malformed or out-of-range date.
pub fn taken_ms(date: &str, subsec: Option<&str>) -> Option<i64> {
    let trim = |s: &str| s.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
    let mut dt = exif::DateTime::from_ascii(trim(date).as_bytes()).ok()?;
    if let Some(sub) = subsec {
        let sub = trim(sub);
        if !sub.is_empty() {
            // A malformed subsecond keeps the whole-second date.
            let _ = dt.parse_subsec(sub.as_bytes());
        }
    }
    let (y, m, d) = (dt.year as i64, dt.month as i64, dt.day as i64);
    let valid = (1900..=9999).contains(&y)
        && (1..=12).contains(&m)
        && (1..=31).contains(&d)
        && dt.hour < 24
        && dt.minute < 60
        && dt.second <= 60;
    if !valid {
        return None;
    }
    // Days from 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + dt.hour as i64 * 3600 + dt.minute as i64 * 60 + dt.second as i64;
    Some(secs * 1000 + dt.nanosecond.unwrap_or(0) as i64 / 1_000_000)
}

fn kamadak_exif(path: &Path) -> CameraExif {
    let Ok(file) = File::open(path) else { return CameraExif::default() };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else {
        return CameraExif::default();
    };
    let text = |tag: exif::Tag| -> Option<String> {
        match &exif.get_field(tag, exif::In::PRIMARY)?.value {
            exif::Value::Ascii(parts) => {
                let joined = parts.iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect::<Vec<_>>().join(" ");
                let trimmed = joined.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            _ => None,
        }
    };
    let number =
        |tag: exif::Tag| exif.get_field(tag, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)).and_then(real_iso);
    let iso = number(exif::Tag::PhotographicSensitivity)
        .or_else(|| number(exif::Tag::ISOSpeed))
        .or_else(|| number(exif::Tag::RecommendedExposureIndex));
    let read_taken = |date: exif::Tag, subsec: exif::Tag| taken_ms(&text(date)?, text(subsec).as_deref());
    let taken = read_taken(exif::Tag::DateTimeOriginal, exif::Tag::SubSecTimeOriginal)
        .or_else(|| read_taken(exif::Tag::DateTime, exif::Tag::SubSecTime));
    let rational = |tag: exif::Tag| match &exif.get_field(tag, exif::In::PRIMARY).map(|f| &f.value) {
        Some(exif::Value::Rational(r)) => r.first().filter(|r| r.denom != 0).map(|r| r.to_f64()),
        _ => None,
    };
    // Degrees, minutes and seconds (a zero denominator in the minutes or seconds reads as 0), signed by the ref tag.
    let degrees = |tag: exif::Tag, sign_tag: exif::Tag, negative: &str| -> Option<f64> {
        let exif::Value::Rational(r) = &exif.get_field(tag, exif::In::PRIMARY)?.value else { return None };
        let part = |i: usize| r.get(i).filter(|r| r.denom != 0).map(|r| r.to_f64());
        let value = part(0)? + part(1).unwrap_or(0.0) / 60.0 + part(2).unwrap_or(0.0) / 3600.0;
        let south_or_west = text(sign_tag).is_some_and(|s| s.eq_ignore_ascii_case(negative));
        Some(if south_or_west { -value } else { value })
    };
    let lat = degrees(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, "S");
    let lon = degrees(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, "W");
    CameraExif {
        make: text(exif::Tag::Make),
        model: text(exif::Tag::Model),
        iso,
        taken,
        lens: text(exif::Tag::LensModel),
        focal: rational(exif::Tag::FocalLength),
        serial: text(exif::Tag::BodySerialNumber),
        shutter: rational(exif::Tag::ExposureTime),
        aperture: rational(exif::Tag::FNumber),
        gps: lat.zip(lon).and_then(|(lat, lon)| Gps::valid(lat, lon)),
    }
}

#[cfg(feature = "raw")]
fn raw_exif(path: &Path) -> CameraExif {
    use rawler::decoders::RawDecodeParams;
    use rawler::rawsource::RawSource;
    // rawler panics on some unusual files; metadata is never worth a crash.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let source = RawSource::new(path).ok()?;
        let decoder = rawler::get_decoder(&source).ok()?;
        let md = decoder.raw_metadata(&source, &RawDecodeParams::default()).ok()?;
        let e = &md.exif;
        let iso = e
            .iso_speed_ratings
            .map(u32::from)
            .and_then(real_iso)
            .or(e.iso_speed.and_then(real_iso))
            .or(e.recommended_exposure_index.and_then(real_iso));
        let some = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
        let taken = e.date_time_original.as_deref().and_then(|d| taken_ms(d, e.sub_sec_time_original.as_deref()));
        let ratio = |r: rawler::formats::tiff::Rational| (r.d != 0).then(|| r.n as f64 / r.d as f64);
        let focal = e.focal_length.and_then(ratio);
        let degrees = |dms: Option<[rawler::formats::tiff::Rational; 3]>, sign: Option<&str>, negative: &str| {
            let [d, m, s] = dms?;
            let value = ratio(d)? + ratio(m).unwrap_or(0.0) / 60.0 + ratio(s).unwrap_or(0.0) / 3600.0;
            Some(if sign.is_some_and(|s| s.trim().eq_ignore_ascii_case(negative)) { -value } else { value })
        };
        let gps = e.gps.as_ref().and_then(|g| {
            let lat = degrees(g.gps_latitude, g.gps_latitude_ref.as_deref(), "S")?;
            let lon = degrees(g.gps_longitude, g.gps_longitude_ref.as_deref(), "W")?;
            Gps::valid(lat, lon)
        });
        Some(CameraExif {
            make: some(&md.make),
            model: some(&md.model),
            iso,
            taken,
            lens: e.lens_model.as_deref().and_then(some),
            focal,
            serial: e.serial_number.as_deref().and_then(some),
            shutter: e.exposure_time.and_then(ratio),
            aperture: e.fnumber.and_then(ratio),
            gps,
        })
    }))
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// The maker as people write it: `FUJIFILM` → `Fujifilm`, `NIKON CORPORATION` → `Nikon`, `OLYMPUS IMAGING CORP.` →
/// `Olympus`, ...; an unknown maker keeps its spelling (trimmed), an all-caps one is title-cased.
pub fn clean_make(make: &str) -> String {
    let trimmed = make.trim();
    let upper = trimmed.to_ascii_uppercase();
    const KNOWN: &[(&str, &str)] = &[
        ("FUJIFILM", "Fujifilm"),
        ("FUJI PHOTO FILM", "Fujifilm"),
        ("NIKON", "Nikon"),
        ("CANON", "Canon"),
        ("SONY", "Sony"),
        ("OLYMPUS", "Olympus"),
        ("OM DIGITAL", "OM System"),
        ("PANASONIC", "Panasonic"),
        ("LEICA", "Leica"),
        ("RICOH", "Ricoh"),
        ("PENTAX", "Pentax"),
        ("HASSELBLAD", "Hasselblad"),
        ("SIGMA", "Sigma"),
        ("SAMSUNG", "Samsung"),
        ("APPLE", "Apple"),
        ("GOOGLE", "Google"),
        ("DJI", "DJI"),
        ("GOPRO", "GoPro"),
        ("PHASE ONE", "Phase One"),
        ("MINOLTA", "Minolta"),
        ("KONICA MINOLTA", "Konica Minolta"),
        ("EASTMAN KODAK", "Kodak"),
        ("KODAK", "Kodak"),
    ];
    for (prefix, name) in KNOWN {
        if upper.starts_with(prefix) {
            return (*name).to_string();
        }
    }
    let all_caps = trimmed.chars().any(|c| c.is_ascii_alphabetic()) && !trimmed.chars().any(|c| c.is_ascii_lowercase());
    if !all_caps {
        return trimmed.to_string();
    }
    trimmed
        .split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_string() + &chars.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The model without the maker repeated in front (`Canon EOS R5` → `EOS R5`, `NIKON Z 6` → `Z 6`), trimmed.
pub fn clean_model(make: Option<&str>, model: &str) -> String {
    let trimmed = model.trim();
    let Some(make) = make else { return trimmed.to_string() };
    let first = make.split_whitespace().next().unwrap_or(make);
    let lower = trimmed.to_ascii_lowercase();
    for prefix in [make, first] {
        let p = prefix.to_ascii_lowercase();
        if !p.is_empty() && lower.starts_with(&p) && lower.len() > p.len() {
            let rest = trimmed[p.len()..].trim_start_matches(|c: char| c.is_whitespace() || c == '-' || c == '_');
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    trimmed.to_string()
}

// ---------- Workflow plan 22: the Fujifilm film simulation tag ----------

/// Most bytes read from a file (or from the JPEG preview inside a RAF) to find its film simulation: a JPEG's Exif
/// segment, maker note included, is at most 64 KB and comes first.
const FILM_HEAD_BYTES: u64 = 128 * 1024;

/// The film simulation a Fujifilm camera recorded and the camera's name ("Fujifilm X-T5").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmTag {
    /// As the camera menus show it: `Classic Chrome`, `Acros + R`, ...
    pub simulation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<String>,
}

/// The film simulation of `path` ([`film_tag`]), without the camera.
pub fn film_simulation(path: &Path) -> Option<String> {
    film_tag(path).map(|t| t.simulation)
}

/// The film simulation a Fujifilm camera recorded, read from the Fujifilm maker note of a JPEG through
/// `kamadak-exif`, or of a RAF through the JPEG preview it embeds (the RAF header's offset 84 and length 88). At most
/// [`FILM_HEAD_BYTES`] are read (a HEIF or TIFF whose Exif lies further in reads as untagged). `None` for other
/// cameras, a file without the tag (an edited export usually drops the maker note), or a short or damaged file. A
/// monochrome simulation is recorded in the `Saturation` tag (0x1003) and wins over `FilmMode` (0x1401), as in
/// ExifTool.
pub fn film_tag(path: &Path) -> Option<FilmTag> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let head = if ext == "raf" { raf_preview_head(path)? } else { read_head(path, 0, FILM_HEAD_BYTES)? };
    film_tag_in(&head)
}

/// [`film_tag`] of the first bytes of a file (a JPEG, or a TIFF-based container).
fn film_tag_in(head: &[u8]) -> Option<FilmTag> {
    let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(head)).ok()?;
    let text = |tag: exif::Tag| -> Option<String> {
        match &exif.get_field(tag, exif::In::PRIMARY)?.value {
            exif::Value::Ascii(parts) => {
                let joined = parts.iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect::<Vec<_>>().join(" ");
                let trimmed = joined.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            }
            _ => None,
        }
    };
    let make = text(exif::Tag::Make)?;
    if !make.to_ascii_uppercase().contains("FUJI") {
        return None;
    }
    let note = match &exif.get_field(exif::Tag::MakerNote, exif::In::PRIMARY)?.value {
        exif::Value::Undefined(bytes, _) => bytes.clone(),
        _ => return None,
    };
    let (film_mode, saturation) = fuji_note_tags(&note)?;
    let simulation = simulation_name(film_mode, saturation)?;
    let camera = normalised(CameraExif { make: Some(make), model: text(exif::Tag::Model), ..CameraExif::default() })
        .camera_name();
    Some(FilmTag { simulation, camera })
}

/// Up to `len` bytes of `path` from `offset`.
fn read_head(path: &Path, offset: u64, len: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut head = Vec::new();
    file.take(len).read_to_end(&mut head).ok()?;
    Some(head)
}

/// The first [`FILM_HEAD_BYTES`] of the JPEG preview embedded in a RAF (enough for its Exif segment).
fn raf_preview_head(path: &Path) -> Option<Vec<u8>> {
    raf_preview_head_of(&read_head(path, 0, 92)?, |offset, len| read_head(path, offset, len))
}

/// [`raf_preview_head`] from the RAF header and a reader of the rest.
fn raf_preview_head_of(header: &[u8], read: impl FnOnce(u64, u64) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    if header.len() < 92 || &header[..8] != b"FUJIFILM" {
        return None;
    }
    let offset = u32::from_be_bytes(header[84..88].try_into().ok()?) as u64;
    let len = u32::from_be_bytes(header[88..92].try_into().ok()?) as u64;
    if offset < 92 || len < 4 {
        return None;
    }
    let head = read(offset, len.min(FILM_HEAD_BYTES))?;
    head.starts_with(&[0xFF, 0xD8]).then_some(head)
}

/// `FilmMode` (0x1401) and `Saturation` (0x1003) from a Fujifilm maker note: `FUJIFILM`, a little-endian offset to
/// the IFD (from the note's start), then a little-endian IFD whose offsets are also from the note's start. Only a
/// SHORT with one value counts. Never reads out of bounds (a truncated note gives what it holds, or `None`).
fn fuji_note_tags(note: &[u8]) -> Option<(Option<u16>, Option<u16>)> {
    if note.len() < 14 || &note[..8] != b"FUJIFILM" {
        return None;
    }
    let u16_at = |i: usize| note.get(i..i.checked_add(2)?).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |i: usize| note.get(i..i.checked_add(4)?).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let ifd = u32_at(8)? as usize;
    let count = u16_at(ifd)? as usize;
    let (mut film_mode, mut saturation) = (None, None);
    for k in 0..count.min(512) {
        let e = ifd + 2 + k * 12;
        let (Some(tag), Some(kind), Some(n)) = (u16_at(e), u16_at(e + 2), u32_at(e + 4)) else { break };
        // SHORT (3), one value, stored in the first two bytes of the value field.
        if kind != 3 || n != 1 {
            continue;
        }
        match tag {
            0x1401 => film_mode = u16_at(e + 8),
            0x1003 => saturation = u16_at(e + 8),
            _ => {}
        }
    }
    Some((film_mode, saturation))
}

/// The simulation's name as the camera menus show it.
fn simulation_name(film_mode: Option<u16>, saturation: Option<u16>) -> Option<String> {
    let mono = match saturation {
        Some(0x300) => Some("Monochrome"),
        Some(0x301) => Some("Monochrome + R"),
        Some(0x302) => Some("Monochrome + Ye"),
        Some(0x303) => Some("Monochrome + G"),
        Some(0x310) => Some("Sepia"),
        Some(0x500) => Some("Acros"),
        Some(0x501) => Some("Acros + R"),
        Some(0x502) => Some("Acros + Ye"),
        Some(0x503) => Some("Acros + G"),
        _ => None,
    };
    if let Some(name) = mono {
        return Some(name.to_string());
    }
    let name = match film_mode? {
        0x000 => "Provia",
        0x100 | 0x110 | 0x130 | 0x300 => "Studio Portrait",
        0x120 => "Astia",
        0x200 | 0x400 => "Velvia",
        0x500 => "Pro Neg. Std",
        0x501 => "Pro Neg. Hi",
        0x600 => "Classic Chrome",
        0x700 => "Eterna",
        0x800 => "Classic Negative",
        0x900 => "Eterna Bleach Bypass",
        0xa00 => "Nostalgic Neg.",
        0xb00 => "Reala Ace",
        _ => return None,
    };
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_and_models_are_cleaned() {
        assert_eq!(clean_make("FUJIFILM"), "Fujifilm");
        assert_eq!(clean_make("NIKON CORPORATION"), "Nikon");
        assert_eq!(clean_make("OLYMPUS IMAGING CORP.  "), "Olympus");
        assert_eq!(clean_make("Canon"), "Canon");
        assert_eq!(clean_make("ACME OPTICS"), "Acme Optics");
        assert_eq!(clean_make("Zeiss"), "Zeiss");
        assert_eq!(clean_model(Some("Canon"), "Canon EOS R5"), "EOS R5");
        assert_eq!(clean_model(Some("Nikon"), "NIKON Z 6_2"), "Z 6_2");
        assert_eq!(clean_model(Some("Fujifilm"), "X-T5"), "X-T5");
        assert_eq!(clean_model(Some("Sony"), "ILCE-7M4"), "ILCE-7M4");
        assert_eq!(clean_model(None, " iPhone 15 Pro "), "iPhone 15 Pro");
    }

    #[test]
    fn iso_65535_and_0_are_absent() {
        assert_eq!(real_iso(65535), None);
        assert_eq!(real_iso(0), None);
        assert_eq!(real_iso(51200), Some(51200));
        let exif = normalised(CameraExif {
            make: Some("SONY".into()),
            model: Some("ILCE-1".into()),
            iso: Some(65535),
            ..CameraExif::default()
        });
        assert_eq!(exif.iso, None);
        // A JPEG whose PhotographicSensitivity is 65535 falls through to RecommendedExposureIndex.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hi.jpg");
        std::fs::write(&path, jpeg_with_isos(65535, 102400)).unwrap();
        assert_eq!(camera_exif(&path).iso, Some(102400));
    }

    /// A minimal JPEG (SOI, APP1 Exif, EOI) whose Exif IFD has PhotographicSensitivity (SHORT) and
    /// RecommendedExposureIndex (LONG).
    fn jpeg_with_isos(photographic: u16, rei: u32) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend_from_slice(b"MM\0\x2a");
        t.extend_from_slice(&8u32.to_be_bytes());
        // IFD0: one entry, the Exif IFD pointer, at 8 + 2 + 12 + 4 = 26.
        t.extend_from_slice(&1u16.to_be_bytes());
        t.extend_from_slice(&0x8769u16.to_be_bytes());
        t.extend_from_slice(&4u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&26u32.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        // Exif IFD: two entries.
        t.extend_from_slice(&2u16.to_be_bytes());
        t.extend_from_slice(&0x8827u16.to_be_bytes());
        t.extend_from_slice(&3u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&photographic.to_be_bytes());
        t.extend_from_slice(&[0, 0]);
        t.extend_from_slice(&0x8832u16.to_be_bytes());
        t.extend_from_slice(&4u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&rei.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        let payload = [&b"Exif\0\0"[..], &t[..]].concat();
        let len = (payload.len() + 2) as u16;
        [&[0xFF, 0xD8, 0xFF, 0xE1][..], &len.to_be_bytes(), &payload, &[0xFF, 0xD9]].concat()
    }

    /// A minimal big-endian JPEG whose IFD0 holds only the Exif pointer and whose Exif IFD holds `entries`
    /// (tag, type, count, value bytes; values over 4 bytes go after the IFD).
    fn jpeg_with_exif_ifd(entries: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
        jpeg_with_sub_ifd(0x8769, entries)
    }

    /// [`jpeg_with_exif_ifd`] with another IFD0 pointer (`0x8825`: the GPS IFD).
    fn jpeg_with_sub_ifd(pointer: u16, entries: &[(u16, u16, u32, Vec<u8>)]) -> Vec<u8> {
        let mut t = Vec::new();
        t.extend_from_slice(b"MM\0\x2a");
        t.extend_from_slice(&8u32.to_be_bytes());
        t.extend_from_slice(&1u16.to_be_bytes());
        t.extend_from_slice(&pointer.to_be_bytes());
        t.extend_from_slice(&4u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&26u32.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        let mut data_at = 26 + 2 + 12 * entries.len() as u32 + 4;
        let mut data = Vec::new();
        t.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        for (tag, kind, count, value) in entries {
            t.extend_from_slice(&tag.to_be_bytes());
            t.extend_from_slice(&kind.to_be_bytes());
            t.extend_from_slice(&count.to_be_bytes());
            if value.len() <= 4 {
                let mut inline = value.clone();
                inline.resize(4, 0);
                t.extend_from_slice(&inline);
            } else {
                t.extend_from_slice(&data_at.to_be_bytes());
                data.extend_from_slice(value);
                data_at += value.len() as u32;
            }
        }
        t.extend_from_slice(&0u32.to_be_bytes());
        t.extend_from_slice(&data);
        let payload = [&b"Exif\0\0"[..], &t[..]].concat();
        let len = (payload.len() + 2) as u16;
        [&[0xFF, 0xD8, 0xFF, 0xE1][..], &len.to_be_bytes(), &payload, &[0xFF, 0xD9]].concat()
    }

    fn ascii(s: &str) -> (u32, Vec<u8>) {
        let bytes = [s.as_bytes(), b"\0"].concat();
        (bytes.len() as u32, bytes)
    }

    #[test]
    fn capture_time_lens_focal_and_serial() {
        let (date_n, date) = ascii("2026:10:13 14:05:09");
        let (sub_n, sub) = ascii("05");
        let (lens_n, lens) = ascii("XF23mmF1.4 R LM WR ");
        let (serial_n, serial) = ascii("7DM12345");
        let focal = [230u32.to_be_bytes(), 10u32.to_be_bytes()].concat();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("burst.jpg");
        let bytes = jpeg_with_exif_ifd(&[
            (0x9003, 2, date_n, date),
            (0x920a, 5, 1, focal),
            (0x9291, 2, sub_n, sub),
            (0xa431, 2, serial_n, serial),
            (0xa434, 2, lens_n, lens),
        ]);
        std::fs::write(&path, bytes).unwrap();
        let exif = camera_exif(&path);
        // 2026-10-13T14:05:09.050 read as UTC: SubSecTimeOriginal "05" is 50 ms.
        assert_eq!(exif.taken, Some(1_791_900_309_050));
        assert_eq!(exif.taken.unwrap() % 1000, 50);
        assert_eq!(exif.lens.as_deref(), Some("XF23mmF1.4 R LM WR"));
        assert_eq!(exif.focal, Some(23.0));
        assert_eq!(exif.serial.as_deref(), Some("7DM12345"));
    }

    fn rationals(values: &[(u32, u32)]) -> Vec<u8> {
        values.iter().flat_map(|(n, d)| [n.to_be_bytes(), d.to_be_bytes()].concat()).collect()
    }

    #[test]
    fn shutter_aperture_and_gps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("exposure.jpg");
        let exposure = (0x829a, 5, 1, rationals(&[(1, 250)]));
        let bytes = jpeg_with_exif_ifd(&[exposure, (0x829d, 5, 1, rationals(&[(28, 10)]))]);
        std::fs::write(&path, bytes).unwrap();
        let exif = camera_exif(&path);
        assert_eq!((exif.shutter, exif.aperture), (Some(0.004), Some(2.8)));
        assert_eq!(exif.gps, None);

        // Lisbon: 38° 42' 36" N, 9° 8' 24.6" W.
        let (n, n_ref) = ascii("N");
        let (w, w_ref) = ascii("W");
        let gps = jpeg_with_sub_ifd(
            0x8825,
            &[
                (0x0001, 2, n, n_ref),
                (0x0002, 5, 3, rationals(&[(38, 1), (42, 1), (36, 1)])),
                (0x0003, 2, w, w_ref),
                (0x0004, 5, 3, rationals(&[(9, 1), (8, 1), (246, 10)])),
            ],
        );
        std::fs::write(&path, gps).unwrap();
        let at = camera_exif(&path).gps.unwrap();
        assert!((at.lat - 38.71).abs() < 1e-9 && (at.lon - -9.140_166_666_666_667).abs() < 1e-9, "{at:?}");

        // No fix (0, 0) and an exposure of 0 are absent.
        let lat = (0x0002, 5, 3, rationals(&[(0, 1), (0, 1), (0, 1)]));
        let zero = jpeg_with_sub_ifd(0x8825, &[lat, (0x0004, 5, 3, rationals(&[(0, 1), (0, 0), (0, 0)]))]);
        std::fs::write(&path, zero).unwrap();
        assert_eq!(camera_exif(&path).gps, None);
        assert_eq!(Gps::valid(91.0, 0.0), None);
        assert_eq!(Gps::valid(-33.9, 151.2), Some(Gps { lat: -33.9, lon: 151.2 }));
        let none = normalised(CameraExif { shutter: Some(0.0), aperture: Some(f64::NAN), ..CameraExif::default() });
        assert_eq!((none.shutter, none.aperture), (None, None));
        // JSON as `meta.json` stores it.
        let json = serde_json::to_value(CameraExif { gps: Gps::valid(1.5, 2.5), ..CameraExif::default() }).unwrap();
        assert_eq!(json, serde_json::json!({ "gps": { "lat": 1.5, "lon": 2.5 } }));
    }

    #[test]
    fn exif_dates_to_epoch_ms() {
        assert_eq!(taken_ms("1970:01:01 00:00:00", None), Some(0));
        assert_eq!(taken_ms("2000:02:29 12:00:00", Some("5")), Some(951_825_600_500));
        assert_eq!(taken_ms("2024:12:31 23:59:59\0", Some("999 ")), Some(1_735_689_599_999));
        // A bad SubSecTimeOriginal keeps the date, without the subsecond.
        assert_eq!(taken_ms("1970:01:01 00:00:01", Some("x5")), Some(1000));
        assert_eq!(taken_ms("    :  :     :  :  ", None), None);
        assert_eq!(taken_ms("0000:00:00 00:00:00", None), None);
        assert_eq!(taken_ms("2024:13:01 00:00:00", None), None);
        assert_eq!(taken_ms("2024-01-01 00:00:00", None), None);
    }

    #[test]
    fn a_file_without_exif_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.jpg");
        std::fs::write(&path, b"not a jpeg").unwrap();
        assert_eq!(camera_exif(&path), CameraExif::default());
        assert_eq!(camera_exif(&dir.path().join("missing.jpg")), CameraExif::default());
    }
}

#[cfg(test)]
mod film_simulation_tests {
    use super::*;

    /// A Fujifilm maker note with `FilmMode` and, optionally, `Saturation` (and a `FilmMode` with count 2 first,
    /// which must be ignored).
    fn note(film_mode: u16, saturation: Option<u16>) -> Vec<u8> {
        let mut n = b"FUJIFILM".to_vec();
        n.extend_from_slice(&12u32.to_le_bytes());
        let mut entries: Vec<(u16, u32, u16)> = vec![(0x1401, 2, 0x0700)];
        if let Some(s) = saturation {
            entries.push((0x1003, 1, s));
        }
        entries.push((0x1401, 1, film_mode));
        n.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, count, value) in entries {
            n.extend_from_slice(&tag.to_le_bytes());
            n.extend_from_slice(&3u16.to_le_bytes());
            n.extend_from_slice(&count.to_le_bytes());
            n.extend_from_slice(&value.to_le_bytes());
            n.extend_from_slice(&[0, 0]);
        }
        n.extend_from_slice(&0u32.to_le_bytes());
        n
    }

    /// A minimal JPEG whose Exif has `Make`, `Model` and a maker note.
    fn jpeg(make: &str, maker_note: &[u8]) -> Vec<u8> {
        let make = format!("{make}\0");
        let model = "X-T5\0";
        let mut t = Vec::new();
        t.extend_from_slice(b"MM\0\x2a");
        t.extend_from_slice(&8u32.to_be_bytes());
        // IFD0 at 8: Make, Model and the Exif pointer (3 entries: 2 + 36 + 4 = 42 bytes), then the two texts, then
        // the Exif IFD.
        let make_at = 8 + 42u32;
        let model_at = make_at + make.len() as u32;
        let exif_at = model_at + model.len() as u32;
        t.extend_from_slice(&3u16.to_be_bytes());
        for (tag, at, len) in [(0x010fu16, make_at, make.len()), (0x0110, model_at, model.len())] {
            t.extend_from_slice(&tag.to_be_bytes());
            t.extend_from_slice(&2u16.to_be_bytes());
            t.extend_from_slice(&(len as u32).to_be_bytes());
            t.extend_from_slice(&at.to_be_bytes());
        }
        t.extend_from_slice(&0x8769u16.to_be_bytes());
        t.extend_from_slice(&4u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&exif_at.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        t.extend_from_slice(make.as_bytes());
        t.extend_from_slice(model.as_bytes());
        // Exif IFD: the maker note (UNDEFINED), its bytes right after the IFD (2 + 12 + 4 = 18 bytes).
        let note_at = exif_at + 18;
        t.extend_from_slice(&1u16.to_be_bytes());
        t.extend_from_slice(&0x927cu16.to_be_bytes());
        t.extend_from_slice(&7u16.to_be_bytes());
        t.extend_from_slice(&(maker_note.len() as u32).to_be_bytes());
        t.extend_from_slice(&note_at.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        t.extend_from_slice(maker_note);
        let payload = [&b"Exif\0\0"[..], &t[..]].concat();
        let len = (payload.len() + 2) as u16;
        [&[0xFF, 0xD8, 0xFF, 0xE1][..], &len.to_be_bytes(), &payload, &[0xFF, 0xD9]].concat()
    }

    /// A RAF: the 92-byte header (padded to 100) pointing at an embedded JPEG.
    fn raf(preview: &[u8]) -> Vec<u8> {
        let mut raf = vec![0u8; 100];
        raf[..16].copy_from_slice(b"FUJIFILMCCD-RAW ");
        raf[84..88].copy_from_slice(&100u32.to_be_bytes());
        raf[88..92].copy_from_slice(&(preview.len() as u32).to_be_bytes());
        raf.extend_from_slice(preview);
        raf
    }

    #[test]
    fn names_from_the_tags() {
        assert_eq!(simulation_name(Some(0x600), None).as_deref(), Some("Classic Chrome"));
        assert_eq!(simulation_name(Some(0x600), Some(0x8000)).as_deref(), Some("Classic Chrome"));
        assert_eq!(simulation_name(Some(0x000), Some(0x501)).as_deref(), Some("Acros + R"));
        assert_eq!(simulation_name(None, Some(0x300)).as_deref(), Some("Monochrome"));
        assert_eq!(simulation_name(Some(0x7777), None), None);
        assert_eq!(simulation_name(None, None), None);
    }

    #[test]
    fn reads_a_fuji_jpeg_and_raf() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("DSCF0001.JPG");
        std::fs::write(&path, jpeg("FUJIFILM", &note(0x600, Some(0x8000)))).unwrap();
        // The count-2 FilmMode (Eterna) is skipped; the count-1 one is read.
        assert_eq!(
            film_tag(&path),
            Some(FilmTag { simulation: "Classic Chrome".into(), camera: Some("Fujifilm X-T5".into()) })
        );
        let raf_path = dir.path().join("DSCF0001.RAF");
        std::fs::write(&raf_path, raf(&jpeg("FUJIFILM", &note(0x000, Some(0x500))))).unwrap();
        assert_eq!(film_simulation(&raf_path).as_deref(), Some("Acros"));
        // Another maker, or no maker note: nothing.
        let other = dir.path().join("other.jpg");
        std::fs::write(&other, jpeg("Canon", &note(0x600, None))).unwrap();
        assert_eq!(film_simulation(&other), None);
        std::fs::write(&other, b"not a jpeg").unwrap();
        assert_eq!(film_simulation(&other), None);
    }

    /// Every prefix of a valid maker note, JPEG and RAF reads without panicking (a damaged or cut-off file).
    #[test]
    fn truncated_files_never_panic() {
        let full_note = note(0x600, Some(0x8000));
        for n in 0..=full_note.len() {
            let _ = fuji_note_tags(&full_note[..n]);
        }
        assert_eq!(fuji_note_tags(&full_note), Some((Some(0x600), Some(0x8000))));
        let full_jpeg = jpeg("FUJIFILM", &full_note);
        for n in 0..=full_jpeg.len() {
            let _ = film_tag_in(&full_jpeg[..n]);
        }
        let full_raf = raf(&full_jpeg);
        for n in 0..=full_raf.len() {
            let cut = &full_raf[..n];
            let _ = raf_preview_head_of(&cut[..n.min(92)], |offset, len| {
                let start = (offset as usize).min(cut.len());
                Some(cut[start..(start + len as usize).min(cut.len())].to_vec())
            })
            .and_then(|head| film_tag_in(&head));
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cut.RAF");
        for n in [0, 10, 91, 92, 100, 140] {
            std::fs::write(&path, &full_raf[..n]).unwrap();
            assert_eq!(film_simulation(&path), None, "a RAF cut at {n} bytes");
        }
    }
}
