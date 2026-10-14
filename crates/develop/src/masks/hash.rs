//! Component hashes and a small in-memory LRU of component rasters.

use std::collections::HashMap;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::composite::{rasterise_component, MaskContext};
use super::raster::MaskPlane;
use crate::canonical::canonical_json;
use crate::geometry::Homography;
use crate::settings::MaskComponent;

/// Mixed into [`component_hash`]; bump when a rasteriser's maths changes.
pub const MASK_RASTER_VERSION: &str = "mask-raster/1";

/// The string [`component_hash`] hashes: the canonical JSON of the component **without** `id`, `mode` and
/// `invert` (they do not change its own raster), a newline and [`MASK_RASTER_VERSION`].
pub fn component_hash_input(component: &MaskComponent) -> String {
    let mut value = serde_json::to_value(component).expect("mask components always serialise");
    if let Some(obj) = value.as_object_mut() {
        for key in ["id", "mode", "invert"] {
            obj.remove(key);
        }
    }
    format!("{}\n{}", canonical_json(&value), MASK_RASTER_VERSION)
}

/// SHA-256 hex of [`component_hash_input`]: the content key of a component's raster (the AI raster cache
/// adds the image identity; [`MaskCache`] adds the grid).
pub fn component_hash(component: &MaskComponent) -> String {
    hex::encode(Sha256::digest(component_hash_input(component).as_bytes()))
}

/// [`MaskCache`] key: component hash, grid size and the normalised frame → output map, each entry rounded
/// to 1e-6.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MaskKey {
    pub hash: String,
    pub width: u32,
    pub height: u32,
    pub map: [i64; 9],
}

impl MaskKey {
    pub fn new(component: &MaskComponent, width: u32, height: u32, frame_to_output: &Homography) -> MaskKey {
        let map = frame_to_output.normalized().0.map(|v| if v.is_finite() { (v * 1e6).round() as i64 } else { i64::MAX });
        MaskKey { hash: component_hash(component), width, height, map }
    }
}

/// An LRU of component rasters (before invert/mode), bounded by bytes. Luminance and colour rasters also
/// depend on the input image, which the key does not cover: keep one cache per source image (like
/// `PrePasses`) and [`MaskCache::clear`] it when the image changes. AI components whose raster is missing
/// are never cached, so they pick the raster up once it exists.
#[derive(Debug)]
pub struct MaskCache {
    entries: HashMap<MaskKey, (Arc<MaskPlane>, u64)>,
    tick: u64,
    bytes: usize,
    budget: usize,
}

impl Default for MaskCache {
    /// 128 MB: about 18 planes at 1600 × 1067.
    fn default() -> Self {
        Self::new(128 << 20)
    }
}

impl MaskCache {
    pub fn new(budget_bytes: usize) -> Self {
        Self { entries: HashMap::new(), tick: 0, bytes: 0, budget: budget_bytes }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Bytes held by the cached planes.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    /// The component's raster on `ctx`'s grid, from the cache or freshly rasterised (and stored, unless it is
    /// an AI component with a missing raster). The bool is "AI raster missing".
    pub fn get_or_rasterise(&mut self, component: &MaskComponent, ctx: &MaskContext) -> (Arc<MaskPlane>, bool) {
        let key = MaskKey::new(component, ctx.width, ctx.height, ctx.frame_to_output);
        self.tick += 1;
        if let Some((plane, used)) = self.entries.get_mut(&key) {
            *used = self.tick;
            return (plane.clone(), false);
        }
        let (plane, missing) = rasterise_component(component, ctx);
        let plane = Arc::new(plane);
        if !missing {
            self.insert(key, plane.clone());
        }
        (plane, missing)
    }

    fn insert(&mut self, key: MaskKey, plane: Arc<MaskPlane>) {
        let size = plane.data.len() * std::mem::size_of::<f32>();
        if size > self.budget {
            return;
        }
        while self.bytes + size > self.budget {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, t))| *t).map(|(k, _)| k.clone()) else { break };
            if let Some((p, _)) = self.entries.remove(&oldest) {
                self.bytes -= p.data.len() * std::mem::size_of::<f32>();
            }
        }
        self.bytes += size;
        self.entries.insert(key, (plane, self.tick));
    }
}
