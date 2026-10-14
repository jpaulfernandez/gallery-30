//! AI mask rasters on disk and in memory (D4.3), and how renders read them.
//!
//! **Frame.** A raster is stored on the **source grid**: the decoded picture (EXIF-upright, before the user's
//! rotate/flip, Upright, Transform, straighten and crop), at the working image's size (the editor's 1600 px proxy).
//! The models run on the picture turned as the user turned it ([`crate::ai::segment::InferenceFrame`]) and their
//! output is permuted back exactly. A render maps each output pixel through the plan's inverse
//! ([`crate::GeometryPlan::inverse`], output → source pixels) and samples the raster bilinearly
//! ([`MaskPlane::warp_into`]), so a raster follows the content through every geometry change (crop, straighten,
//! Upright, rotate, flip) without being regenerated, and the preview and the full-size export read the same file.
//!
//! **Files.** `<entry>/develop/masks/<componentHash>.png` (8-bit grey, `0..255` → `0..1`) per AI component, where
//! `<entry>` is the photo's cache folder (`<appdata>/cache/<hash>`) and `componentHash` is
//! [`crate::masks::component_hash`] (target, model, model version, prompts, depth range). A depth component reads
//! the depth map instead, `depth-<model>-<version>.png` (16-bit grey, `0` near … `65535` far), and makes its range
//! mask on the fly ([`depth_range_plane`]), so moving the range never needs the model. Files are
//! written to a temporary name and renamed into place.
//!
//! **Memory.** [`AiRasterCache`] is an LRU (bytes-bounded) over those files keyed by `(folder, key)`; a miss reads
//! the PNG, and a missing file is not remembered (the next render looks again, so a raster generated meanwhile is
//! picked up). [`ImageRasters`] binds the cache to one photo's folder and is the [`AiRasterSource`] a
//! [`crate::Developer`] reads ([`crate::Developer::set_ai_rasters`]); one-shot renders
//! ([`crate::render::render_full`], `render_preview`) read the source installed with [`with_ai_source`] on the
//! calling thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;

use super::hash::component_hash;
use super::raster::MaskPlane;
use crate::geometry::GeometryPlan;
use crate::settings::{AiMaskTarget, MaskComponent, MaskShape};

/// Folder of the AI rasters inside a photo's cache folder.
pub const MASKS_SUBDIR: &str = "develop/masks";
/// Feather of a depth component's range (normalised depth units).
pub const DEPTH_RANGE_FEATHER: f64 = 0.05;

/// `<entry>/develop/masks`.
pub fn masks_dir(entry_dir: &Path) -> PathBuf {
    entry_dir.join(MASKS_SUBDIR)
}

/// `<dir>/<componentHash>.png`.
pub fn raster_path(dir: &Path, component_hash: &str) -> PathBuf {
    dir.join(format!("{component_hash}.png"))
}

/// `<dir>/depth-<model>-<version>.png`.
pub fn depth_path(dir: &Path, model: &str, version: &str) -> PathBuf {
    dir.join(format!("depth-{model}-{version}.png"))
}

/// What a render reads for an AI component, as a cache key: `("raster", componentHash)` or
/// `("depth", model-version)` with the range applied on top.
fn file_for(dir: &Path, component: &MaskComponent) -> Option<(PathBuf, bool)> {
    let MaskShape::Ai { target, model, model_version, .. } = &component.shape else { return None };
    Some(if *target == AiMaskTarget::Depth {
        (depth_path(dir, model, model_version), true)
    } else {
        (raster_path(dir, &component_hash(component)), false)
    })
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

fn png_bytes(plane: &MaskPlane, sixteen: bool) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let enc = image::codecs::png::PngEncoder::new(&mut out);
    let (w, h) = (plane.width, plane.height);
    let res = if sixteen {
        let data: Vec<u8> =
            plane.data.iter().flat_map(|v| ((v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16).to_ne_bytes()).collect();
        image::ImageEncoder::write_image(enc, &data, w, h, image::ExtendedColorType::L16)
    } else {
        let data: Vec<u8> = plane.data.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8).collect();
        image::ImageEncoder::write_image(enc, &data, w, h, image::ExtendedColorType::L8)
    };
    res.map_err(io::Error::other)?;
    Ok(out)
}

/// Write a mask raster as an 8-bit grey PNG (atomically).
pub fn write_mask_png(path: &Path, plane: &MaskPlane) -> io::Result<()> {
    write_atomic(path, &png_bytes(plane, false)?)
}

/// Write a depth map (0 near … 1 far) as a 16-bit grey PNG (atomically).
pub fn write_depth_png(path: &Path, plane: &MaskPlane) -> io::Result<()> {
    write_atomic(path, &png_bytes(plane, true)?)
}

/// Read a grey PNG (8 or 16 bit; other layouts are converted to luma) as a plane in 0..1. `None` when the file is
/// missing or unreadable.
pub fn read_png_plane(path: &Path) -> Option<MaskPlane> {
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let (w, h) = (img.width(), img.height());
    let data: Vec<f32> = match img {
        image::DynamicImage::ImageLuma8(b) => b.into_raw().iter().map(|&v| v as f32 / 255.0).collect(),
        image::DynamicImage::ImageLuma16(b) => b.into_raw().iter().map(|&v| v as f32 / 65535.0).collect(),
        other => other.to_luma16().into_raw().iter().map(|&v| v as f32 / 65535.0).collect(),
    };
    Some(MaskPlane::new(w, h, data))
}

/// Supplies AI component rasters on the source grid (see the module docs).
pub trait AiRasterSource: Send + Sync + std::fmt::Debug {
    /// The raster of an AI component on the source grid (any resolution; normalised coordinates are what count),
    /// or `None` when it has not been generated.
    fn raster(&self, component: &MaskComponent) -> Option<Arc<MaskPlane>>;
}

#[derive(Debug, Default)]
struct Lru {
    entries: HashMap<(PathBuf, String), (Arc<MaskPlane>, u64)>,
    tick: u64,
    bytes: usize,
}

/// A bytes-bounded LRU of AI rasters and depth maps read from (or written to) the PNG files.
#[derive(Debug)]
pub struct AiRasterCache {
    lru: Mutex<Lru>,
    budget: usize,
}

impl Default for AiRasterCache {
    /// 96 MB: about 14 planes at 1600 × 1067.
    fn default() -> Self {
        Self::new(96 << 20)
    }
}

impl AiRasterCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self { lru: Mutex::new(Lru::default()), budget: budget_bytes }
    }

    /// Bytes held in memory.
    pub fn bytes(&self) -> usize {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).bytes
    }

    pub fn len(&self) -> usize {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        lru.entries.clear();
        lru.bytes = 0;
    }

    fn lookup(&self, key: &(PathBuf, String)) -> Option<Arc<MaskPlane>> {
        let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        lru.tick += 1;
        let tick = lru.tick;
        lru.entries.get_mut(key).map(|(p, used)| {
            *used = tick;
            p.clone()
        })
    }

    fn insert(&self, key: (PathBuf, String), plane: Arc<MaskPlane>) {
        let size = plane.data.len() * std::mem::size_of::<f32>();
        let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((old, _)) = lru.entries.remove(&key) {
            lru.bytes -= old.data.len() * std::mem::size_of::<f32>();
        }
        if size > self.budget {
            return;
        }
        while lru.bytes + size > self.budget {
            let Some(oldest) = lru.entries.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| k.clone()) else { break };
            if let Some((p, _)) = lru.entries.remove(&oldest) {
                lru.bytes -= p.data.len() * std::mem::size_of::<f32>();
            }
        }
        lru.tick += 1;
        let tick = lru.tick;
        lru.bytes += size;
        lru.entries.insert(key, (plane, tick));
    }

    /// A plane stored at `path`: from memory, else read from disk (and remembered). A missing file is not
    /// remembered.
    fn load(&self, path: &Path) -> Option<Arc<MaskPlane>> {
        let key = (path.to_path_buf(), String::new());
        if let Some(p) = self.lookup(&key) {
            return Some(p);
        }
        let plane = Arc::new(read_png_plane(path)?);
        self.insert(key, plane.clone());
        Some(plane)
    }

    /// Whether `component`'s raster (or, for depth, its depth map) is in memory or on disk under `dir`.
    pub fn exists(&self, dir: &Path, component: &MaskComponent) -> bool {
        let Some((path, _)) = file_for(dir, component) else { return false };
        self.lookup(&(path.clone(), String::new())).is_some() || path.is_file()
    }

    /// The raster of `component` on the source grid, from the files under `dir`. Depth components apply their
    /// range to the stored depth map (remembered per range).
    pub fn get(&self, dir: &Path, component: &MaskComponent) -> Option<Arc<MaskPlane>> {
        let (path, is_depth) = file_for(dir, component)?;
        if !is_depth {
            return self.load(&path);
        }
        let MaskShape::Ai { depth_range, .. } = &component.shape else { return None };
        let range = depth_range.unwrap_or([0.0, 1.0]);
        let key = (path.clone(), format!("{:?}", range));
        if let Some(p) = self.lookup(&key) {
            return Some(p);
        }
        let depth = self.load(&path)?;
        let plane = Arc::new(depth_range_plane(&depth, range, DEPTH_RANGE_FEATHER));
        self.insert(key, plane.clone());
        Some(plane)
    }

    /// Store `component`'s raster (source grid) under `dir`: writes `<componentHash>.png` and remembers the
    /// written (8-bit quantised) plane, so memory and disk agree. Returns the file. For a depth component use
    /// [`put_depth`](Self::put_depth).
    pub fn put(&self, dir: &Path, component: &MaskComponent, plane: &MaskPlane) -> io::Result<PathBuf> {
        let path = raster_path(dir, &component_hash(component));
        write_mask_png(&path, plane)?;
        let quantised: Vec<f32> = plane.data.iter().map(|v| ((v.clamp(0.0, 1.0) * 255.0 + 0.5).floor()) / 255.0).collect();
        self.insert((path.clone(), String::new()), Arc::new(MaskPlane::new(plane.width, plane.height, quantised)));
        Ok(path)
    }

    /// Store a normalised depth map (source grid) for `model`/`version` under `dir` (16-bit PNG) and forget the
    /// range masks made from an older one. Returns the file.
    pub fn put_depth(&self, dir: &Path, model: &str, version: &str, depth: &MaskPlane) -> io::Result<PathBuf> {
        let path = depth_path(dir, model, version);
        write_depth_png(&path, depth)?;
        {
            let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
            let stale: Vec<_> = lru.entries.keys().filter(|(p, _)| *p == path).cloned().collect();
            for k in stale {
                if let Some((p, _)) = lru.entries.remove(&k) {
                    lru.bytes -= p.data.len() * std::mem::size_of::<f32>();
                }
            }
        }
        let quantised: Vec<f32> =
            depth.data.iter().map(|v| ((v.clamp(0.0, 1.0) * 65535.0 + 0.5).floor()) / 65535.0).collect();
        self.insert((path.clone(), String::new()), Arc::new(MaskPlane::new(depth.width, depth.height, quantised)));
        Ok(path)
    }
}

/// A depth range mask over a normalised depth plane (0 near … 1 far): 1 for `lo <= d <= hi` (`range` swapped when
/// reversed), falling to 0 over `feather` depth units outside each end (smoothstep); `feather <= 0` is a hard range.
pub fn depth_range_plane(depth: &MaskPlane, range: [f64; 2], feather: f64) -> MaskPlane {
    let (lo, hi) = if range[0] <= range[1] { (range[0], range[1]) } else { (range[1], range[0]) };
    let e = feather.max(0.0);
    let smooth = |e0: f64, e1: f64, x: f64| {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let data = depth
        .data
        .par_iter()
        .map(|&d| {
            let d = d as f64;
            if e <= 0.0 {
                return if (lo..=hi).contains(&d) { 1.0 } else { 0.0 };
            }
            (smooth(lo - e, lo, d) * (1.0 - smooth(hi, hi + e, d))) as f32
        })
        .collect();
    MaskPlane::new(depth.width, depth.height, data)
}

/// One photo's AI rasters: an [`AiRasterCache`] and the photo's masks folder.
#[derive(Debug, Clone)]
pub struct ImageRasters {
    pub cache: Arc<AiRasterCache>,
    pub dir: PathBuf,
}

impl ImageRasters {
    pub fn new(cache: Arc<AiRasterCache>, dir: impl Into<PathBuf>) -> Self {
        Self { cache, dir: dir.into() }
    }
}

impl AiRasterSource for ImageRasters {
    fn raster(&self, component: &MaskComponent) -> Option<Arc<MaskPlane>> {
        self.cache.get(&self.dir, component)
    }
}

impl MaskPlane {
    /// This plane, stored on a plan's **source** grid (any resolution), sampled onto the plan's output grid:
    /// each output pixel centre goes through [`GeometryPlan::inverse`] to source pixels, is normalised by the
    /// plan's source size and sampled bilinearly (edges clamped).
    pub fn warp_into(&self, plan: &GeometryPlan) -> MaskPlane {
        let (w, h) = (plan.output_width, plan.output_height);
        let mut out = MaskPlane::zeros(w, h);
        if w == 0 || h == 0 || self.data.is_empty() {
            return out;
        }
        let (kx, ky) = (self.width as f64 / plan.source_width as f64, self.height as f64 / plan.source_height as f64);
        out.data.par_chunks_mut(w as usize).enumerate().for_each(|(y, row)| {
            for (x, o) in row.iter_mut().enumerate() {
                let [sx, sy] = plan.inverse.apply([x as f64 + 0.5, y as f64 + 0.5]);
                *o = if sx.is_finite() && sy.is_finite() { self.sample(sx * kx, sy * ky) } else { 0.0 };
            }
        });
        out
    }
}

/// An `ai_rasters` lookup for one render: the AI component with that id among `masks`, its raster from `source`,
/// warped onto `plan`'s output grid.
pub fn lookup_on_plan<'a>(
    source: &'a dyn AiRasterSource,
    masks: &'a [crate::settings::Mask],
    plan: &'a GeometryPlan,
) -> impl Fn(&str) -> Option<Arc<MaskPlane>> + Sync + 'a {
    move |id: &str| {
        let component = masks.iter().flat_map(|m| m.components.iter()).find(|c| c.id == id)?;
        let raster = source.raster(component)?;
        Some(Arc::new(raster.warp_into(plan)))
    }
}

thread_local! {
    static SCOPED: RefCell<Option<Arc<dyn AiRasterSource>>> = const { RefCell::new(None) };
}

/// Run `f` with `source` as the AI raster source of one-shot renders on this thread ([`crate::render::render_full`],
/// [`crate::render::render_preview`] and their variants), restoring the previous one afterwards (also on panic).
pub fn with_ai_source<T>(source: Option<Arc<dyn AiRasterSource>>, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<dyn AiRasterSource>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            SCOPED.with(|s| *s.borrow_mut() = prev);
        }
    }
    let prev = SCOPED.with(|s| std::mem::replace(&mut *s.borrow_mut(), source));
    let _restore = Restore(prev);
    f()
}

/// The source installed by [`with_ai_source`] on this thread, if any.
pub fn scoped_ai_source() -> Option<Arc<dyn AiRasterSource>> {
    SCOPED.with(|s| s.borrow().clone())
}
