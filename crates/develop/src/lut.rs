//! 3D LUTs (workflow plan 18): the `.cube` parser, HALD CLUT conversion, tetrahedral interpolation and the
//! process-wide store the render reads them from by id.
//!
//! - [`parse_cube`] reads Adobe/Resolve `.cube` text: `LUT_3D_SIZE` 2 to 129, `DOMAIN_MIN` / `DOMAIN_MAX` (or Resolve's
//!   `LUT_3D_INPUT_RANGE`), `TITLE`, comments; a 1D LUT (`LUT_1D_SIZE`) is refused with a message, other keywords are
//!   ignored. Entries are in `.cube` order: red changes fastest, then green, then blue.
//! - [`hald_from_rgb`] / [`decode_hald_png`] read a HALD CLUT image (level `L`: `L³ × L³` pixels, a `L²` cube) and
//!   [`to_cube`] writes any LUT as `.cube` text, so the editor stores one format.
//! - [`Lut3d::apply`]: tetrahedral interpolation of a triple in the LUT's input domain, inputs clamped to it.
//! - Ids: a LUT's id is the SHA-256 of its [`canonical_cube`] text (no title or comments, LF, six decimals), which is
//!   also what the editor stores, so CRLF copies, re-commented files and HALD images under other names share one id.
//! - The store: LUT files live as `<dir>/<id>.cube` ([`set_lut_dir`], the editor's `<appdata>/luts`); [`get`]
//!   loads one by id after checking it parses and hashes to its id (a small cache of parsed LUTs, re-read when the
//!   file is deleted or changed; failures are remembered for 5 s), [`insert`] adds an in-memory one (tests),
//!   [`forget`] drops one. A settings `look.lut` whose file is missing or corrupt is skipped by the render
//!   ([`crate::ops::lut::LutParams::new`]).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use crate::error::{Error, Result};

/// Smallest and largest `LUT_3D_SIZE` accepted.
pub const MIN_SIZE: usize = 2;
pub const MAX_SIZE: usize = 129;
/// Parsed LUTs kept in memory (a 65³ LUT is about 3 MB).
const CACHE_LEN: usize = 6;

/// A 3D LUT: `size³` output triples in `.cube` order (red fastest), for inputs in `domain_min..domain_max`.
#[derive(Debug, Clone, PartialEq)]
pub struct Lut3d {
    pub size: usize,
    pub data: Vec<[f32; 3]>,
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    /// The file's `TITLE`, if any.
    pub title: Option<String>,
}

impl Lut3d {
    /// The identity LUT of `size³` entries on 0..1.
    pub fn identity(size: usize) -> Lut3d {
        let n = size.max(2);
        let step = 1.0 / (n - 1) as f32;
        let mut data = Vec::with_capacity(n * n * n);
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    data.push([r as f32 * step, g as f32 * step, b as f32 * step]);
                }
            }
        }
        Lut3d { size: n, data, domain_min: [0.0; 3], domain_max: [1.0; 3], title: None }
    }

    /// The entry at lattice point `(r, g, b)`.
    #[inline]
    pub fn at(&self, r: usize, g: usize, b: usize) -> [f32; 3] {
        self.data[(b * self.size + g) * self.size + r]
    }

    /// The lattice position of each channel: `1 / (max − min)` per channel, for [`Self::apply`] and the GPU.
    pub fn domain_scale(&self) -> [f32; 3] {
        std::array::from_fn(|c| 1.0 / (self.domain_max[c] - self.domain_min[c]))
    }

    /// Tetrahedral interpolation of `rgb` (clamped to the domain). The GPU (`lut_apply` in chain.wgsl) does the same
    /// arithmetic in the same order.
    pub fn apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        let scale = self.domain_scale();
        let last = (self.size - 1) as f32;
        let mut i = [0usize; 3];
        let mut f = [0.0f32; 3];
        for c in 0..3 {
            let t = ((rgb[c] - self.domain_min[c]) * scale[c]).clamp(0.0, 1.0) * last;
            let k = t.floor().min(last - 1.0);
            i[c] = k as usize;
            f[c] = t - k;
        }
        let [r, g, b] = i;
        let [fr, fg, fb] = f;
        let c000 = self.at(r, g, b);
        let c111 = self.at(r + 1, g + 1, b + 1);
        // The tetrahedron holding (fr, fg, fb): the two inner corners and the four weights.
        let (c1, c2, w) = if fr >= fg {
            if fg >= fb {
                (self.at(r + 1, g, b), self.at(r + 1, g + 1, b), [1.0 - fr, fr - fg, fg - fb, fb])
            } else if fr >= fb {
                (self.at(r + 1, g, b), self.at(r + 1, g, b + 1), [1.0 - fr, fr - fb, fb - fg, fg])
            } else {
                (self.at(r, g, b + 1), self.at(r + 1, g, b + 1), [1.0 - fb, fb - fr, fr - fg, fg])
            }
        } else if fb >= fg {
            (self.at(r, g, b + 1), self.at(r, g + 1, b + 1), [1.0 - fb, fb - fg, fg - fr, fr])
        } else if fb >= fr {
            (self.at(r, g + 1, b), self.at(r, g + 1, b + 1), [1.0 - fg, fg - fb, fb - fr, fr])
        } else {
            (self.at(r, g + 1, b), self.at(r + 1, g + 1, b), [1.0 - fg, fg - fr, fr - fb, fb])
        };
        std::array::from_fn(|c| w[0] * c000[c] + w[1] * c1[c] + w[2] * c2[c] + w[3] * c111[c])
    }
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

fn floats<'a>(parts: impl Iterator<Item = &'a str>, line: usize, what: &str) -> Result<[f32; 3]> {
    let values: Vec<f32> = parts
        .map(|p| p.parse::<f32>().ok().filter(|v| v.is_finite()))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid(format!("line {line}: {what} needs three numbers")))?;
    match values.as_slice() {
        [a, b, c] => Ok([*a, *b, *c]),
        _ => Err(invalid(format!("line {line}: {what} needs three numbers"))),
    }
}

/// Parse `.cube` text; see the module docs. A leading UTF-8 byte order mark is ignored.
pub fn parse_cube(text: &str) -> Result<Lut3d> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut size: Option<usize> = None;
    let mut domain_min = [0.0f32; 3];
    let mut domain_max = [1.0f32; 3];
    let mut title = None;
    let mut data: Vec<[f32; 3]> = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = n + 1;
        // A title may contain `#`; read it before comments are stripped.
        if let Some(rest) = raw.trim_start().strip_prefix("TITLE") {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                title = Some(rest.trim().trim_matches('"').to_string());
                continue;
            }
        }
        let content = raw.split('#').next().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let first = content.split_whitespace().next().unwrap_or("");
        if first.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '+' || c == '.') {
            let Some(n) = size else {
                return Err(invalid(format!("line {line}: data before LUT_3D_SIZE")));
            };
            if data.len() == n * n * n {
                return Err(invalid(format!("LUT_3D_SIZE {n} needs {} entries, the file has more", n * n * n)));
            }
            data.push(floats(content.split_whitespace(), line, "a LUT entry")?);
            continue;
        }
        let rest = content[first.len()..].trim();
        match first {
            "LUT_1D_SIZE" | "LUT_1D_INPUT_RANGE" => {
                return Err(invalid("This is a 1D LUT; only 3D LUTs (LUT_3D_SIZE) can be imported"));
            }
            "LUT_3D_SIZE" => {
                let n: usize = rest.parse().map_err(|_| invalid(format!("line {line}: LUT_3D_SIZE must be a whole number")))?;
                if !(MIN_SIZE..=MAX_SIZE).contains(&n) {
                    return Err(invalid(format!("LUT_3D_SIZE {n} is outside {MIN_SIZE} to {MAX_SIZE}")));
                }
                if size.replace(n).is_some() {
                    return Err(invalid(format!("line {line}: LUT_3D_SIZE given twice")));
                }
                data.reserve_exact(n * n * n);
            }
            "DOMAIN_MIN" => domain_min = floats(rest.split_whitespace(), line, "DOMAIN_MIN")?,
            "DOMAIN_MAX" => domain_max = floats(rest.split_whitespace(), line, "DOMAIN_MAX")?,
            "LUT_3D_INPUT_RANGE" => {
                let v: Option<Vec<f32>> =
                    rest.split_whitespace().map(|p| p.parse::<f32>().ok().filter(|v| v.is_finite())).collect();
                let Some([lo, hi]) = v.as_deref().and_then(|v| <[f32; 2]>::try_from(v).ok()) else {
                    return Err(invalid(format!("line {line}: LUT_3D_INPUT_RANGE needs two numbers")));
                };
                domain_min = [lo; 3];
                domain_max = [hi; 3];
            }
            // Other keywords (vendor extensions) carry nothing the LUT needs.
            _ => {}
        }
    }
    let size = size.ok_or_else(|| invalid("Not a 3D .cube LUT: no LUT_3D_SIZE"))?;
    // `floats` refuses non-finite values, so this also rules out an infinite span.
    if (0..3).any(|c| !(domain_max[c] > domain_min[c]) || !(domain_max[c] - domain_min[c]).is_finite()) {
        return Err(invalid("DOMAIN_MAX must be above DOMAIN_MIN in every channel"));
    }
    let want = size * size * size;
    if data.len() != want {
        return Err(invalid(format!("LUT_3D_SIZE {size} needs {want} entries, the file has {}", data.len())));
    }
    Ok(Lut3d { size, data, domain_min, domain_max, title })
}

/// The HALD level of a `width × height` image, if it is one (square, `level³` pixels, a 2..129 cube).
fn hald_level(width: u32, height: u32) -> Result<u32> {
    let level = (1..=12u32).find(|l| l * l * l == width);
    let Some(level) = level.filter(|_| width == height) else {
        return Err(invalid(format!("A {width}×{height} image is not a HALD CLUT (a square of level³ pixels)")));
    };
    let size = (level * level) as usize;
    if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
        return Err(invalid(format!("HALD level {level} gives a {size}³ LUT, outside {MIN_SIZE} to {MAX_SIZE}")));
    }
    Ok(level)
}

/// A HALD CLUT from `width × height` RGB values in 0..1 (row-major triples). Level `L` images are `L³` pixels
/// square and hold an `L²` cube, red fastest along the rows.
pub fn hald_from_rgb(width: u32, height: u32, rgb: &[f32]) -> Result<Lut3d> {
    let level = hald_level(width, height)?;
    let size = (level * level) as usize;
    let n = size * size * size;
    if rgb.len() < n * 3 {
        return Err(invalid("HALD image data is too short"));
    }
    let data = rgb[..n * 3].chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect();
    Ok(Lut3d { size, data, domain_min: [0.0; 3], domain_max: [1.0; 3], title: None })
}

/// A HALD CLUT PNG (8 or 16 bit; its pixel values are used as they are, without colour management). The size is
/// checked from the header before anything is decoded.
pub fn decode_hald_png(path: &Path) -> Result<Lut3d> {
    let (w, h) = image::image_dimensions(path)?;
    hald_level(w, h)?;
    let img = image::open(path)?;
    hald_from_rgb(img.width(), img.height(), &img.to_rgb32f().into_raw())
}

/// `.cube` text for `lut` (six decimals, `DOMAIN_MIN/MAX` only when not 0..1).
pub fn to_cube(lut: &Lut3d, title: Option<&str>) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(lut.data.len() * 27 + 128);
    if let Some(t) = title.or(lut.title.as_deref()) {
        let t: String = t.chars().filter(|c| !c.is_control()).map(|c| if c == '"' { '\'' } else { c }).collect();
        let _ = writeln!(s, "TITLE \"{}\"", t.trim());
    }
    let _ = writeln!(s, "LUT_3D_SIZE {}", lut.size);
    if lut.domain_min != [0.0; 3] || lut.domain_max != [1.0; 3] {
        let [a, b, c] = lut.domain_min;
        let _ = writeln!(s, "DOMAIN_MIN {a} {b} {c}");
        let [a, b, c] = lut.domain_max;
        let _ = writeln!(s, "DOMAIN_MAX {a} {b} {c}");
    }
    for [r, g, b] in &lut.data {
        let _ = writeln!(s, "{r:.6} {g:.6} {b:.6}");
    }
    s
}

/// The canonical `.cube` text of `lut`: no title or comments, LF line ends, six decimals. This is what the editor
/// stores, so the same LUT imported from a CRLF copy, with other comments or as a HALD image under another file name
/// gets the same id ([`lut_id`]).
pub fn canonical_cube(lut: &Lut3d) -> String {
    to_cube(&Lut3d { title: None, ..lut.clone() }, None)
}

/// SHA-256 hex of `text`: a LUT's id is that of its [`canonical_cube`] text, which is also the stored file's content.
pub fn text_id(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// The id of `lut` (the SHA-256 of its canonical text).
pub fn lut_id(lut: &Lut3d) -> String {
    text_id(&canonical_cube(lut))
}

/// True for a LUT id: 64 lowercase hex characters (the SHA-256 of the stored `.cube` file).
pub fn is_lut_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `<dir>/<id>.cube`.
pub fn lut_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.cube"))
}

// ---------- the store ----------

/// How long a file that failed to load (missing, corrupt, wrong content) is not read again.
const FAILURE_TTL: Duration = Duration::from_secs(5);

struct Cached {
    id: String,
    lut: Arc<Lut3d>,
    /// The file's modification time when it was read: a hit whose file is gone or changed is dropped.
    mtime: Option<SystemTime>,
}

static DIR: RwLock<Option<PathBuf>> = RwLock::new(None);
/// Most recently used first.
static CACHE: Mutex<Vec<Cached>> = Mutex::new(Vec::new());
/// LUTs added with [`insert`], never evicted and never checked against a file.
static PINNED: Mutex<Vec<(String, Arc<Lut3d>)>> = Mutex::new(Vec::new());
/// Ids whose file failed to load, and when.
static FAILED: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

/// Where [`get`] reads `<id>.cube` from (the editor's `<appdata>/luts`); `None` reads nothing from disk.
pub fn set_lut_dir(dir: Option<PathBuf>) {
    *DIR.write().unwrap_or_else(|e| e.into_inner()) = dir;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
    FAILED.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// The directory set by [`set_lut_dir`].
pub fn lut_dir() -> Option<PathBuf> {
    DIR.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Make `lut` available under `id` without a file (tests, or a LUT the caller already holds).
pub fn insert(id: &str, lut: Arc<Lut3d>) {
    let mut pinned = PINNED.lock().unwrap_or_else(|e| e.into_inner());
    pinned.retain(|(k, _)| k != id);
    pinned.push((id.to_string(), lut));
}

/// Drop everything remembered about `id` (its file was written, deleted or replaced).
pub fn forget(id: &str) {
    PINNED.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| k != id);
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).retain(|c| c.id != id);
    FAILED.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| k != id);
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok())
}

/// Read and check `<dir>/<id>.cube`: it must parse and hash to `id`.
pub fn load_file(dir: &Path, id: &str) -> Result<Lut3d> {
    let path = lut_file(dir, id);
    let text = std::fs::read_to_string(&path)?;
    if text_id(&text) != id {
        return Err(invalid(format!("{} does not match its id (the file was changed)", path.display())));
    }
    parse_cube(&text)
}

/// The LUT `id`: from memory (a cached file is re-read when it was deleted or changed), else read and checked from
/// `<dir>/<id>.cube` ([`load_file`]). `None` when it is not there or is corrupt (logged; not retried for 5 s).
pub fn get(id: &str) -> Option<Arc<Lut3d>> {
    if let Some((_, lut)) = PINNED.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| k == id) {
        return Some(Arc::clone(lut));
    }
    if !is_lut_id(id) {
        return None;
    }
    let dir = lut_dir()?;
    let path = lut_file(&dir, id);
    let now = mtime(&path);
    {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pos) = cache.iter().position(|c| c.id == id) {
            let hit = cache.remove(pos);
            if now.is_some() && hit.mtime == now {
                let lut = Arc::clone(&hit.lut);
                cache.insert(0, hit);
                return Some(lut);
            }
        }
    }
    {
        let mut failed = FAILED.lock().unwrap_or_else(|e| e.into_inner());
        failed.retain(|(_, at)| at.elapsed() < FAILURE_TTL);
        if failed.iter().any(|(k, _)| k == id) {
            return None;
        }
    }
    if now.is_none() {
        FAILED.lock().unwrap_or_else(|e| e.into_inner()).push((id.to_string(), Instant::now()));
        return None;
    }
    let lut = match load_file(&dir, id) {
        Ok(lut) => Arc::new(lut),
        Err(err) => {
            log::warn!("[photobook:develop] LUT {} cannot be used: {err}", path.display());
            FAILED.lock().unwrap_or_else(|e| e.into_inner()).push((id.to_string(), Instant::now()));
            return None;
        }
    };
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|c| c.id != id);
    cache.insert(0, Cached { id: id.to_string(), lut: Arc::clone(&lut), mtime: now });
    cache.truncate(CACHE_LEN);
    Some(lut)
}

/// Whether [`get`] finds `id` (its file is there, parses and matches its id).
pub fn present(id: &str) -> bool {
    get(id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [f32; 3], b: [f32; 3], tol: f32) -> bool {
        a.iter().zip(&b).all(|(x, y)| (x - y).abs() <= tol)
    }

    #[test]
    fn identity_33_is_a_no_op() {
        let lut = parse_cube(&to_cube(&Lut3d::identity(33), Some("id"))).unwrap();
        assert_eq!(lut.size, 33);
        let mut worst = 0.0f32;
        for i in 0..4096u32 {
            let p = [(i % 16) as f32 / 15.0, ((i / 16) % 16) as f32 / 15.0 * 0.97 + 0.01, (i / 256) as f32 / 15.0];
            let q = [p[0] * 0.993 + 0.003, p[1], (p[2] * 7.3).fract()];
            for v in [p, q] {
                let out = lut.apply(v);
                worst = worst.max(out.iter().zip(&v).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max));
            }
        }
        assert!(worst <= 1.0 / 4096.0, "identity error {worst}");
    }

    #[test]
    fn a_known_2_cube() {
        // Swap red and blue, and invert green.
        let mut text = String::from("# test\nTITLE \"swap\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    text.push_str(&format!("{b} {} {r}\n", 1 - g));
                }
            }
        }
        let lut = parse_cube(&text).unwrap();
        assert_eq!(lut.title.as_deref(), Some("swap"));
        for p in [[0.2f32, 0.7, 0.4], [0.9, 0.1, 0.5], [0.0, 1.0, 1.0], [0.33, 0.33, 0.9]] {
            let out = lut.apply(p);
            assert!(close(out, [p[2], 1.0 - p[1], p[0]], 1e-6), "{p:?} → {out:?}");
        }
        // Inputs outside the domain clamp to it.
        assert!(close(lut.apply([1.5, -0.2, 0.5]), [0.5, 1.0, 1.0], 1e-6));
    }

    #[test]
    fn domain_is_honoured() {
        let text = "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
        let lut = parse_cube(text).unwrap();
        assert!(close(lut.apply([1.0, 0.5, 2.0]), [0.5, 0.25, 1.0], 1e-6));
        let resolve = text.replace("DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2", "LUT_3D_INPUT_RANGE 0 2");
        assert_eq!(parse_cube(&resolve).unwrap().domain_max, [2.0; 3]);
        assert!(to_cube(&lut, None).contains("DOMAIN_MAX 2 2 2"));
    }

    #[test]
    fn malformed_files_are_refused() {
        let msg = |t: &str| parse_cube(t).unwrap_err().to_string();
        assert!(msg("LUT_1D_SIZE 1024\n0 0 0\n").contains("1D"));
        assert!(msg("0 0 0\n").contains("LUT_3D_SIZE"));
        assert!(msg("TITLE \"x\"\n").contains("no LUT_3D_SIZE"));
        assert!(msg("LUT_3D_SIZE 1\n0 0 0\n").contains("outside"));
        assert!(msg("LUT_3D_SIZE 130\n").contains("outside"));
        assert!(msg("LUT_3D_SIZE 2\n0 0 0\n").contains("needs 8 entries"));
        assert!(msg("LUT_3D_SIZE 2\n0 0\n").contains("three numbers"));
        assert!(msg("LUT_3D_SIZE 2\n0 0 x\n").contains("three numbers"));
        assert!(msg("LUT_3D_SIZE two\n").contains("whole number"));
        assert!(msg("LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1\n").contains("DOMAIN_MAX"));
        assert!(parse_cube("LUT_3D_SIZE 129\n").unwrap_err().to_string().contains("2146689"));
    }

    #[test]
    fn hald_level_2_is_a_4_cube() {
        let id = Lut3d::identity(4);
        let rgb: Vec<f32> = id.data.iter().flatten().copied().collect();
        let lut = hald_from_rgb(8, 8, &rgb).unwrap();
        assert_eq!(lut, id);
        assert!(hald_from_rgb(9, 9, &rgb).is_err());
        assert!(hald_from_rgb(8, 9, &rgb).is_err());
    }

    #[test]
    fn store_reads_checked_files_by_id() {
        let dir = std::env::temp_dir().join(format!("photobook-lut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = canonical_cube(&Lut3d::identity(3));
        let id = text_id(&text);
        std::fs::write(lut_file(&dir, &id), &text).unwrap();
        // Only this test sets the directory in the unit-test binary.
        set_lut_dir(Some(dir.clone()));
        assert_eq!(get(&id).unwrap().size, 3);
        assert!(!present(&"cd".repeat(32)));
        assert!(!present("../etc"));
        // Deleted while cached: no longer there.
        std::fs::remove_file(lut_file(&dir, &id)).unwrap();
        assert!(!present(&id));
        // Back (after a forget, as an import does): found again at once.
        std::fs::write(lut_file(&dir, &id), &text).unwrap();
        forget(&id);
        assert!(present(&id));
        // A file whose content does not hash to its name is refused.
        let bad = "ef".repeat(32);
        std::fs::write(lut_file(&dir, &bad), &text).unwrap();
        assert!(!present(&bad));
        assert!(load_file(&dir, &bad).unwrap_err().to_string().contains("does not match"));
        insert("mem", Arc::new(Lut3d::identity(2)));
        assert!(present("mem"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn canonical_text_dedupes_copies() {
        let lut = Lut3d::identity(3);
        let plain = canonical_cube(&lut);
        let noisy = format!("\u{feff}# made by X\r\nTITLE \"A # B\"\r\n{}", plain.replace('\n', "\r\n"));
        let parsed = parse_cube(&noisy).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("A # B"));
        assert_eq!(lut_id(&parsed), lut_id(&lut));
        assert_eq!(parse_cube(&plain).unwrap(), lut);
        assert!(!to_cube(&lut, Some("a\u{7}b\nc")).contains('\u{7}'));
        assert!(to_cube(&lut, Some("a\u{7}b\nc")).starts_with("TITLE \"abc\"\n"));
    }

    #[test]
    fn non_finite_domains_and_extra_entries_are_refused() {
        let msg = |t: &str| parse_cube(t).unwrap_err().to_string();
        assert!(msg("LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 inf\n").contains("two numbers"));
        assert!(msg("LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 NaN\n").contains("two numbers"));
        assert!(msg("LUT_3D_SIZE 2\nDOMAIN_MAX 1 inf 1\n").contains("three numbers"));
        assert!(msg("LUT_3D_SIZE 2\nDOMAIN_MIN -3e38 0 0\nDOMAIN_MAX 3e38 1 1\n").contains("DOMAIN_MAX"));
        let mut text = canonical_cube(&Lut3d::identity(2));
        text.push_str("0 0 0\n");
        assert!(msg(&text).contains("has more"));
    }

    /// Tetrahedral, not trilinear: a random 5³ LUT against an independent reference that sorts the fractions and
    /// walks the lattice one axis at a time.
    #[test]
    fn apply_matches_a_sorted_axis_reference() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / (1u64 << 24) as f32
        };
        let n = 5usize;
        let mut lut = Lut3d::identity(n);
        for v in &mut lut.data {
            *v = [rnd(), rnd(), rnd()];
        }
        let (mut worst, mut worst_tri) = (0.0f32, 0.0f32);
        for _ in 0..20_000 {
            let p = [rnd(), rnd(), rnd()];
            let got = lut.apply(p);
            let t = p.map(|v| v * (n - 1) as f32);
            let base = t.map(|v| (v.floor() as usize).min(n - 2));
            let f: [f32; 3] = std::array::from_fn(|c| t[c] - base[c] as f32);
            let mut order = [0usize, 1, 2];
            order.sort_by(|&a, &b| f[b].total_cmp(&f[a]));
            let mut pos = base;
            let mut want = lut.at(pos[0], pos[1], pos[2]).map(|v| v * (1.0 - f[order[0]]));
            for k in 0..3 {
                pos[order[k]] += 1;
                let w = f[order[k]] - if k < 2 { f[order[k + 1]] } else { 0.0 };
                let c = lut.at(pos[0], pos[1], pos[2]);
                for ch in 0..3 {
                    want[ch] += w * c[ch];
                }
            }
            let mut tri = [0.0f32; 3];
            for corner in 0..8usize {
                let d = [corner & 1, (corner >> 1) & 1, corner >> 2];
                let w: f32 = (0..3).map(|c| if d[c] == 1 { f[c] } else { 1.0 - f[c] }).product();
                let c = lut.at(base[0] + d[0], base[1] + d[1], base[2] + d[2]);
                for ch in 0..3 {
                    tri[ch] += w * c[ch];
                }
            }
            for ch in 0..3 {
                worst = worst.max((want[ch] - got[ch]).abs());
                worst_tri = worst_tri.max((tri[ch] - got[ch]).abs());
            }
        }
        assert!(worst < 1e-5, "tetrahedral reference differs by {worst}");
        assert!(worst_tri > 0.05, "trilinear would be indistinguishable ({worst_tri})");
    }
}
