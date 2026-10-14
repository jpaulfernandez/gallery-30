//! AI denoise (D5.1): tiled inference of an sRGB-trained denoiser, the Oklab luminance/chroma blend, an
//! edge-masked luminance unsharp mask, and the 16-bit intermediate the develop pipeline decodes instead of the source.
//!
//! Pipeline ([`denoise`]):
//!
//! 1. The linear Rec.2020 input is mapped to what the models were trained on: sRGB primaries, clamped to 0..1,
//!    sRGB-encoded, `f32` NCHW. This happens per tile while extracting it, so no encoded copy of the image is kept.
//! 2. [`tiling`](super::tiling): fixed `tile × tile` tiles (the model's static input, 512 px), at least
//!    [`TILE_OVERLAP`] px of overlap, the image reflect-padded to a multiple of [`TILE_MULTIPLE`]; one tile in flight,
//!    cancel and progress between tiles; outputs blended with a raised-cosine window normalised by accumulated weight.
//! 3. The model's change is applied as a residual in linear light, `x + dec(out) − dec(enc(x))`, so what the model
//!    could not see (highlights above 1, colours outside sRGB) passes through untouched.
//! 4. Oklab per channel: L by the frequency-aware merge of [`super::merge`] (workflow plan 25: the finest à trous
//!    band `lerp(in, out, luminance/100)`, the coarser bands and the residual the model's; this was the flat
//!    `lerp(L_in, L_out, luminance/100)`), `ab = lerp(ab_in, ab_out, chroma/100)` with `chromaMode: model`. With `chromaMode: filter` (the default, workflow plan 24) the intermediate keeps the input's
//!    a/b and the render applies the classical chroma filter ([`crate::ops::noise`]) at the Colour slider's strength,
//!    guided by the denoised L; the chroma strength is then not part of the key, so moving it never waits for the
//!    model.
//! 5. A luminance-only unsharp mask on Oklab L: `L += h·tanh(k·(L − G_σ(L))·mask / h)` with `k = sharpen/100`,
//!    σ = [`SHARPEN_SIGMA_REF`] reference px (scaled by `min(w, h)/1080` of the *full* image, as every other radius),
//!    `h` = [`SHARPEN_HALO`], and the mask a smoothstep of the Sobel magnitude of `G_σ(L)` so flat areas (where the
//!    remaining noise lives) are not sharpened.
//!
//! Intermediate ([`write_intermediate`] / [`read_intermediate`]): a 16-bit RGB PNG of the result with Rec.2020
//! primaries and the sRGB transfer curve, tagged with a matching ICC profile (iCCP) so any viewer shows it right,
//! divided by `scale ≥ 1` (the sidecar's) when the image has values above 1. The sidecar `<name>.json` holds the key,
//! size, engine, scale and the source's RAW metadata, so a substituted decode keeps its white balance data.

use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use half::f16;
use ndarray::{ArrayViewD, IxDyn};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::merge;
use super::runtime::{SessionOptions, Tensor};
use super::tiling::{tile_plan, Blender};
use super::{registry, status, Error, ModelDir, ModelEntry, ModelStatus, Result, Session};
use crate::color::camera::{CameraColor, CameraMatrix};
use crate::color::matrix::{self, apply_f32};
use crate::color::oklab::Oklab;
use crate::color::transfer::{linear_to_srgb, srgb_to_linear};
use crate::image::{ImageMeta, LinearImage};
use crate::local::{gaussian_blur, gaussian_blurred, prepass::sobel_magnitude, reference_scale};
use crate::ops::smoothstep;
use crate::settings::{ChromaMode, Denoise, DenoiseModel};

/// Minimum overlap between neighbouring tiles, px.
pub const TILE_OVERLAP: usize = 48;
/// The padded image is a multiple of this (NAFNet's four 2× downsamplings).
pub const TILE_MULTIPLE: usize = 16;
/// Part of [`denoise_key`]: bump when the blend, the sharpening or the intermediate format changes.
pub const DENOISE_ENGINE: &str = "denoise/2";
/// σ of the post-denoise unsharp mask, reference px (1080 px short side).
pub const SHARPEN_SIGMA_REF: f32 = 0.8;
/// Smallest σ in pixels (a 512 px crop of a small image would otherwise get a sub-pixel blur).
pub const MIN_SHARPEN_SIGMA: f32 = 0.5;
/// Soft limit on the sharpening change in Oklab L.
pub const SHARPEN_HALO: f32 = 0.05;
/// Edge mask: Sobel magnitude of the blurred Oklab L per reference pixel where sharpening starts and is full.
pub const EDGE_LOW: f32 = 0.02;
pub const EDGE_HIGH: f32 = 0.06;
/// Highest `scale` an intermediate uses for values above 1.
pub const MAX_INTERMEDIATE_SCALE: f32 = 16.0;
/// `encoding` of the intermediates this version writes.
pub const INTERMEDIATE_ENCODING: &str = "rgb16-rec2020-srgb-trc";
/// A CoreML load that splits the graph into more partitions than this is dropped for the CPU EP: every partition
/// boundary copies the tensors between Core ML and ONNX Runtime, and past a handful that costs more than it saves.
pub const MAX_COREML_PARTITIONS: usize = 8;
/// Models that run on the CPU EP without trying CoreML. SCUNet's Swin blocks (Einsum, dynamic reshapes) split into
/// 141 partitions with 687 of 1669 nodes on the CPU: one 512² tile took 72 s that way on an M3 Pro.
pub const CPU_ONLY_MODELS: &[&str] = &["scunet-color-real-psnr"];

/// The manifest model for a settings model; `None` for one not in the manifest (NAFNet width64 for now).
pub fn model_entry(model: DenoiseModel) -> Option<&'static ModelEntry> {
    registry().get(model_name(model))
}

/// The manifest name a settings model maps to.
pub fn model_name(model: DenoiseModel) -> &'static str {
    match model {
        DenoiseModel::NafnetW32 => "nafnet-sidd-width32",
        DenoiseModel::NafnetW64 => "nafnet-sidd-width64",
        DenoiseModel::Scunet => "scunet-color-real-psnr",
    }
}

// ---------------------------------------------------------------------------------------------
// Sessions

/// A loaded denoiser: its session and the tile size its static input fixes.
pub struct DenoiseEngine {
    pub name: String,
    pub version: String,
    pub tile: usize,
    session: Session,
    input: String,
    input_f16: bool,
}

impl std::fmt::Debug for DenoiseEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DenoiseEngine").field("name", &self.name).field("tile", &self.tile).finish_non_exhaustive()
    }
}

impl DenoiseEngine {
    /// Load an installed manifest model with [`SessionOptions::for_model`]: CoreML on macOS unless the model is in
    /// [`CPU_ONLY_MODELS`] or CoreML splits it into more than [`MAX_COREML_PARTITIONS`] partitions (then the CPU EP).
    pub fn load(entry: &ModelEntry, dir: &ModelDir) -> Result<DenoiseEngine> {
        let opts = SessionOptions::for_model(entry, dir);
        if CPU_ONLY_MODELS.contains(&entry.name.as_str()) {
            return Self::load_with(entry, dir, &opts.cpu());
        }
        let engine = Self::load_with(entry, dir, &opts)?;
        match engine.session.info().coreml_partitions {
            Some(p) if p > MAX_COREML_PARTITIONS => {
                log::info!("[photobook:ai] {}: {p} CoreML partitions, using the CPU EP instead", entry.name);
                drop(engine);
                Self::load_with(entry, dir, &opts.cpu())
            }
            _ => Ok(engine),
        }
    }

    /// Load with explicit options (`.cpu()` for the CPU EP).
    pub fn load_with(entry: &ModelEntry, dir: &ModelDir, opts: &SessionOptions) -> Result<DenoiseEngine> {
        if status(entry, dir) != ModelStatus::Installed {
            return Err(Error::NotInstalled(entry.name.clone()));
        }
        let tile = match entry.input.as_slice() {
            [1, 3, h, w] if h == w && *h > 0 => *h as usize,
            other => return Err(Error::Manifest(format!("{}: denoise input must be [1, 3, n, n], not {other:?}", entry.name))),
        };
        let session = Session::load(&dir.primary_path(entry), opts)?;
        session.log_compute_plan();
        let first = session.info().inputs.first().ok_or_else(|| Error::Runtime(format!("{} has no input", entry.name)))?;
        Ok(DenoiseEngine {
            name: entry.name.clone(),
            version: entry.version.clone(),
            tile,
            input: first.name.clone(),
            input_f16: first.dtype == "f16",
            session,
        })
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// An engine on a session loaded from any file, not a manifest model (workflow plan 26: evaluating our own
    /// exports before they are hosted and pinned). The session's first input must be `[1, 3, n, n]` (or symbolic,
    /// then `tile` is used).
    pub fn from_session(name: &str, version: &str, tile: usize, session: Session) -> Result<DenoiseEngine> {
        let first = session.info().inputs.first().ok_or_else(|| Error::Runtime(format!("{name} has no input")))?;
        match first.shape.as_slice() {
            [b, 3, h, w] if *b <= 1 && (*h <= 0 || *h as usize == tile) && (*w <= 0 || *w as usize == tile) => {}
            other => return Err(Error::Runtime(format!("{name}: input must be [1, 3, {tile}, {tile}], not {other:?}"))),
        }
        Ok(DenoiseEngine {
            name: name.to_owned(),
            version: version.to_owned(),
            tile,
            input: first.name.clone(),
            input_f16: first.dtype == "f16",
            session,
        })
    }

    /// Run one `3 × tile × tile` sRGB-encoded plane through the model; returns the output plane (same size).
    pub fn run_tile(&self, plane: &[f32]) -> Result<Vec<f32>> {
        let n = self.tile;
        let shape = IxDyn(&[1, 3, n, n]);
        let outputs = if self.input_f16 {
            let half: Vec<f16> = plane.iter().map(|&v| f16::from_f32(v)).collect();
            let view = ArrayViewD::from_shape(shape, &half).map_err(|e| Error::Runtime(e.to_string()))?;
            self.session.run(&[(self.input.as_str(), Tensor::F16(view))])?
        } else {
            let view = ArrayViewD::from_shape(shape, plane).map_err(|e| Error::Runtime(e.to_string()))?;
            self.session.run(&[(self.input.as_str(), Tensor::F32(view))])?
        };
        let out = outputs.first().ok_or_else(|| Error::Runtime(format!("{} returned nothing", self.name)))?;
        if out.len() != plane.len() {
            return Err(Error::Runtime(format!("{}: output shape {:?}, expected [1, 3, {n}, {n}]", self.name, out.shape())));
        }
        Ok(out.iter().copied().collect())
    }
}

/// Denoise sessions by model, loaded on first use and kept (a CoreML load takes seconds with its cache, minutes
/// without). Shareable: `engine` hands out `Arc`s; runs on one engine serialise on its session.
pub struct DenoiseSessions {
    dir: ModelDir,
    cpu_only: bool,
    engines: Mutex<HashMap<String, Arc<DenoiseEngine>>>,
}

impl DenoiseSessions {
    pub fn new(dir: ModelDir) -> Self {
        Self { dir, cpu_only: false, engines: Mutex::default() }
    }

    /// Sessions on the CPU EP only.
    pub fn cpu(dir: ModelDir) -> Self {
        Self { dir, cpu_only: true, engines: Mutex::default() }
    }

    pub fn dir(&self) -> &ModelDir {
        &self.dir
    }

    /// The engine for `model`, loading it if needed. [`Error::UnknownModel`] when the manifest has no such model,
    /// [`Error::NotInstalled`] when it is not downloaded.
    pub fn engine(&self, model: DenoiseModel) -> Result<Arc<DenoiseEngine>> {
        let entry = model_entry(model).ok_or_else(|| Error::UnknownModel(model_name(model).to_owned()))?;
        let mut engines = self.engines.lock().map_err(|_| Error::Runtime("denoise sessions poisoned".into()))?;
        if let Some(engine) = engines.get(&entry.name).filter(|e| e.version == entry.version) {
            return Ok(engine.clone());
        }
        let engine = Arc::new(if self.cpu_only {
            DenoiseEngine::load_with(entry, &self.dir, &SessionOptions::for_model(entry, &self.dir).cpu())?
        } else {
            DenoiseEngine::load(entry, &self.dir)?
        });
        engines.insert(entry.name.clone(), engine.clone());
        Ok(engine)
    }

    /// Drop a loaded engine (after its model was deleted or replaced).
    pub fn forget(&self, model: DenoiseModel) {
        if let Ok(mut engines) = self.engines.lock() {
            engines.remove(model_name(model));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Denoise

/// Extra inputs of [`denoise_with`].
#[derive(Debug, Clone, Default)]
pub struct DenoiseOptions {
    /// The full image's size when `image` is a crop of it (the tuning preview), so the sharpening radius matches the
    /// full run. `None`: the image's own size.
    pub reference_size: Option<(u32, u32)>,
}

/// Timings of one run.
#[derive(Debug, Clone, Default)]
pub struct DenoiseStats {
    pub tiles: usize,
    pub tile_size: usize,
    /// Model time per tile.
    pub tile_times: Vec<Duration>,
    pub inference: Duration,
    /// Blend and sharpen.
    pub post: Duration,
    pub total: Duration,
}

/// Denoise `image` with the model `settings.model` from `sessions`. `progress(done, total)` is called after each
/// tile; `cancel` is polled between tiles ([`Error::Cancelled`]).
pub fn denoise(
    sessions: &DenoiseSessions,
    image: &LinearImage,
    settings: &Denoise,
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<LinearImage> {
    let engine = sessions.engine(settings.model)?;
    Ok(denoise_with(&engine, image, settings, &DenoiseOptions::default(), progress, cancel)?.0)
}

/// [`denoise`] on a given engine, with options, returning timings too.
pub fn denoise_with(
    engine: &DenoiseEngine,
    image: &LinearImage,
    settings: &Denoise,
    opts: &DenoiseOptions,
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<(LinearImage, DenoiseStats)> {
    let start = Instant::now();
    let (raw, mut stats) = infer(engine, image, progress, cancel)?;
    let post = Instant::now();
    let out = finish(image, raw, settings, opts);
    stats.post = post.elapsed();
    stats.total = start.elapsed();
    Ok((out, stats))
}

/// Linear Rec.2020 → the models' input: sRGB primaries, clamped, sRGB-encoded.
#[inline]
fn to_model(m: &matrix::Mat3f, [r, g, b]: [f32; 3]) -> [f32; 3] {
    apply_f32(m, r, g, b).map(|v| linear_to_srgb(v.clamp(0.0, 1.0)))
}

/// The models' output → linear Rec.2020.
#[inline]
fn from_model(m: &matrix::Mat3f, [r, g, b]: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = [r, g, b].map(|v| srgb_to_linear(v.clamp(0.0, 1.0)));
    apply_f32(m, r, g, b)
}

/// Steps 1–3: the full-strength model result in linear Rec.2020 (no blend, no sharpening).
pub fn infer(
    engine: &DenoiseEngine,
    image: &LinearImage,
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<(LinearImage, DenoiseStats)> {
    let (w, h) = (image.width as usize, image.height as usize);
    let plan = tile_plan(w, h, engine.tile, TILE_OVERLAP, TILE_MULTIPLE);
    let to = matrix::to_f32(&matrix::rec2020_to_srgb());
    let from = matrix::to_f32(&matrix::srgb_to_rec2020());
    let total = plan.tiles.len();
    let mut stats = DenoiseStats { tiles: total, tile_size: engine.tile, ..DenoiseStats::default() };
    let mut blender = Blender::new(&plan);
    for (i, tile) in plan.tiles.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let input = plan.extract(&image.data, tile, |p| to_model(&to, p));
        let t = Instant::now();
        let output = engine.run_tile(&input)?;
        let dt = t.elapsed();
        stats.tile_times.push(dt);
        stats.inference += dt;
        blender.add(i, &output);
        progress(i + 1, total);
    }
    let mut data = blender.finish();
    data.par_chunks_mut(3).zip(image.data.par_chunks(3)).for_each(|(o, x)| {
        let x = [x[0], x[1], x[2]];
        let seen = from_model(&from, to_model(&to, x));
        let out = from_model(&from, [o[0], o[1], o[2]]);
        for c in 0..3 {
            o[c] = x[c] + out[c] - seen[c];
        }
    });
    Ok((LinearImage::new(image.width, image.height, data).with_meta(image.meta.clone()), stats))
}

/// Step 4 for one pixel: `L` from `lerp(L_in, L_out, luminance)`, `a`, `b` from `lerp(ab_in, ab_out, chroma)`
/// (strengths 0..1). Written as `a·(1 − t) + b·t` so 0 and 1 give exactly one side. The flat blend: [`finish`]
/// passes luminance 1 and replaces L with the wavelet merge ([`merge::merge_l`]) since workflow plan 25.
#[inline]
pub fn blend_lab(lab_in: [f32; 3], lab_out: [f32; 3], luminance: f32, chroma: f32) -> [f32; 3] {
    let lerp = |a: f32, b: f32, t: f32| a * (1.0 - t) + b * t;
    [lerp(lab_in[0], lab_out[0], luminance), lerp(lab_in[1], lab_out[1], chroma), lerp(lab_in[2], lab_out[2], chroma)]
}

/// Steps 4–5: blend `denoised` (the full-strength result of [`infer`]) with `input` in Oklab, sharpen L, back to
/// linear Rec.2020.
pub fn finish(input: &LinearImage, denoised: LinearImage, settings: &Denoise, opts: &DenoiseOptions) -> LinearImage {
    assert_eq!((input.width, input.height), (denoised.width, denoised.height), "denoised size differs");
    let (w, h) = (input.width as usize, input.height as usize);
    let ok = Oklab::new();
    let lum = (settings.luminance / 100.0).clamp(0.0, 1.0) as f32;
    // Filter mode: the model's a/b are not used; the render filters the input's a/b (`ops::noise`).
    let chroma = match settings.chroma_mode {
        ChromaMode::Model => (settings.chroma / 100.0).clamp(0.0, 1.0) as f32,
        ChromaMode::Filter => 0.0,
    };
    // Workflow plan 25: a/b per pixel as before (`blend_lab`), L first taken whole from the model and then replaced
    // by the frequency-aware merge (`merge::merge_l`; exactly L_out at Luminance 100, L_in at 0). The merge holds up
    // to five extra f32 planes at once (L_in, L_out, and the filter's three), about 0.5 GB at 24 MP; none at 100.
    let weights = merge::BandWeights::for_luminance(lum);
    let mut lab = denoised.data;
    let blend = |o: &mut [f32], i: &[f32]| -> f32 {
        let lab_in = ok.to_lab([i[0], i[1], i[2]]);
        let blended = blend_lab(lab_in, ok.to_lab([o[0], o[1], o[2]]), 1.0, chroma);
        o.copy_from_slice(&blended);
        lab_in[0]
    };
    if weights.levels() > 0 {
        let mut l_in = vec![0.0f32; w * h];
        lab.par_chunks_mut(3).zip(input.data.par_chunks(3)).zip(l_in.par_iter_mut()).for_each(|((o, i), li)| {
            *li = blend(o, i);
        });
        let l_out: Vec<f32> = lab.par_chunks(3).map(|p| p[0]).collect();
        let merged = merge::merge_l(&l_in, l_out, w, h, &weights);
        drop(l_in);
        lab.par_chunks_mut(3).zip(merged.par_iter()).for_each(|(p, &l)| p[0] = l);
    } else {
        lab.par_chunks_mut(3).zip(input.data.par_chunks(3)).for_each(|(o, i)| {
            blend(o, i);
        });
    }
    let amount = (settings.sharpen / 100.0).clamp(0.0, 1.5) as f32;
    if amount > 0.0 {
        let (rw, rh) = opts.reference_size.unwrap_or((input.width, input.height));
        let scale = reference_scale(rw as usize, rh as usize);
        sharpen_l(&mut lab, w, h, amount, scale);
    }
    lab.par_chunks_mut(3).for_each(|p| p.copy_from_slice(&ok.to_rgb([p[0], p[1], p[2]])));
    LinearImage::new(input.width, input.height, lab).with_meta(input.meta.clone())
}

/// Step 5 on interleaved Oklab: an edge-masked unsharp mask on L. `scale` is the full image's reference scale.
fn sharpen_l(lab: &mut [f32], w: usize, h: usize, amount: f32, scale: f32) {
    let sigma = (SHARPEN_SIGMA_REF * scale).max(MIN_SHARPEN_SIGMA);
    let l: Vec<f32> = lab.par_chunks(3).map(|p| p[0]).collect();
    let blurred = gaussian_blurred(&l, w, h, sigma);
    let mut mask = sobel_magnitude(&blurred, w, h);
    mask.par_iter_mut().for_each(|e| *e = smoothstep(EDGE_LOW, EDGE_HIGH, *e * scale));
    gaussian_blur(&mut mask, w, h, sigma);
    lab.par_chunks_mut(3).zip(l.par_iter().zip(&blurred).zip(&mask)).for_each(|(p, ((&l, &g), &m))| {
        if m > 0.0 {
            p[0] = l + SHARPEN_HALO * (amount * (l - g) * m / SHARPEN_HALO).tanh();
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Intermediate cache

/// The cache key of a denoise result: SHA-256 hex of the engine version, the source hash, the model and its
/// version, the luminance and sharpening strengths (to 2 decimals) and the chroma: `model:<chroma>` with
/// `chromaMode: model`, `filter` with `chromaMode: filter` (the intermediate then holds the input's a/b, whatever the
/// Colour slider says; the filter runs at render time, so its radius is not part of the key either), and the L merge
/// ([`merge::MERGE`], `merge:wavelet` since workflow plan 25, so intermediates made with the flat blend are redone).
#[allow(clippy::too_many_arguments)]
pub fn denoise_key(
    hash: &str,
    model: &str,
    model_version: &str,
    luminance: f64,
    chroma: f64,
    sharpen: f64,
    chroma_mode: ChromaMode,
) -> String {
    let chroma = match chroma_mode {
        ChromaMode::Model => format!("model:{chroma:.2}"),
        ChromaMode::Filter => "filter".to_owned(),
    };
    let merge = merge::MERGE;
    let input =
        format!("{DENOISE_ENGINE}\n{hash}\n{model}\n{model_version}\n{luminance:.2}\n{chroma}\n{sharpen:.2}\nmerge:{merge}");
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// [`denoise_key`] for settings; `None` when the model is not in the manifest.
pub fn denoise_key_for(hash: &str, settings: &Denoise) -> Option<String> {
    let entry = model_entry(settings.model)?;
    Some(denoise_key(
        hash,
        &entry.name,
        &entry.version,
        settings.luminance,
        settings.chroma,
        settings.sharpen,
        settings.chroma_mode,
    ))
}

/// `denoise-<key>.png`.
pub fn intermediate_name(key: &str) -> String {
    format!("denoise-{key}.png")
}

/// The sidecar of an intermediate: the same path with `.json`.
pub fn sidecar_path(png: &Path) -> PathBuf {
    png.with_extension("json")
}

/// One colour matrix of [`CameraMeta`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraMatrixMeta {
    pub temperature: f64,
    pub xyz_to_camera: [[f64; 3]; 3],
}

/// [`CameraColor`] as stored in a sidecar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraMeta {
    pub matrices: Vec<CameraMatrixMeta>,
    pub as_shot_neutral: [f64; 3],
}

/// The sidecar `denoise-<key>.json`, written after the PNG: its presence with the right key marks a complete file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateMeta {
    pub key: String,
    pub width: u32,
    pub height: u32,
    /// [`DENOISE_ENGINE`].
    pub engine: String,
    /// [`INTERMEDIATE_ENCODING`].
    pub encoding: String,
    /// Stored values are `encode(v / scale)`; 1 unless the image has values above 1.
    pub scale: f32,
    #[serde(default)]
    pub is_raw: bool,
    #[serde(default)]
    pub as_shot: Option<(f64, f64)>,
    #[serde(default)]
    pub camera: Option<CameraMeta>,
}

impl IntermediateMeta {
    fn image_meta(&self) -> ImageMeta {
        ImageMeta {
            is_raw: self.is_raw,
            as_shot: self.as_shot,
            camera: self.camera.as_ref().map(|c| {
                Arc::new(CameraColor {
                    matrices: c
                        .matrices
                        .iter()
                        .map(|m| CameraMatrix { temperature: m.temperature, xyz_to_camera: m.xyz_to_camera })
                        .collect(),
                    as_shot_neutral: c.as_shot_neutral,
                })
            }),
            noise_sigma: None,
        }
    }
}

fn io_err(context: &Path, err: impl std::fmt::Display) -> Error {
    Error::Io(std::io::Error::other(format!("{}: {err}", context.display())))
}

/// Rec.2020 primaries, D65, the sRGB tone curve: the profile of the intermediate's pixels.
fn intermediate_icc() -> Option<Vec<u8>> {
    let srgb = moxcms::ColorProfile::new_srgb();
    let mut profile = moxcms::ColorProfile::new_bt2020();
    profile.red_trc = srgb.red_trc.clone();
    profile.green_trc = srgb.green_trc.clone();
    profile.blue_trc = srgb.blue_trc.clone();
    profile.cicp = None;
    profile.encode().ok()
}

/// Write `image` as a 16-bit PNG at `path` (temp file + rename), then its sidecar (likewise). Returns the sidecar. On
/// failure nothing of this write is left: no temp file, and no PNG without its sidecar.
pub fn write_intermediate(path: &Path, image: &LinearImage, key: &str) -> Result<IntermediateMeta> {
    use image::{codecs::png, ExtendedColorType, ImageEncoder};
    let max = image.data.par_iter().copied().filter(|v| v.is_finite()).reduce(|| 0.0f32, f32::max);
    let scale = max.clamp(1.0, MAX_INTERMEDIATE_SCALE);
    let inv = 1.0 / scale;
    let mut bytes = vec![0u8; image.data.len() * 2];
    bytes.par_chunks_mut(2).zip(image.data.par_iter()).for_each(|(b, &v)| {
        let e = linear_to_srgb((v * inv).clamp(0.0, 1.0));
        let q = (e * 65535.0 + 0.5) as u16;
        // The encoder takes native-endian samples.
        b.copy_from_slice(&q.to_ne_bytes());
    });
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("png.part");
    let png = || -> Result<()> {
        let file = fs::File::create(&tmp)?;
        let mut writer = BufWriter::with_capacity(1 << 20, file);
        let mut encoder =
            png::PngEncoder::new_with_quality(&mut writer, png::CompressionType::Fast, png::FilterType::Adaptive);
        if let Some(icc) = intermediate_icc() {
            let _ = encoder.set_icc_profile(icc);
        }
        encoder
            .write_image(&bytes, image.width, image.height, ExtendedColorType::Rgb16)
            .map_err(|e| io_err(path, e))?;
        writer.flush()?;
        drop(writer);
        fs::rename(&tmp, path)?;
        Ok(())
    };
    // A failed write leaves neither a temp file nor a stale PNG behind.
    png().inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    let meta = IntermediateMeta {
        key: key.to_owned(),
        width: image.width,
        height: image.height,
        engine: DENOISE_ENGINE.to_owned(),
        encoding: INTERMEDIATE_ENCODING.to_owned(),
        scale,
        is_raw: image.meta.is_raw,
        as_shot: image.meta.as_shot,
        camera: image.meta.camera.as_ref().map(|c| CameraMeta {
            matrices: c
                .matrices
                .iter()
                .map(|m| CameraMatrixMeta { temperature: m.temperature, xyz_to_camera: m.xyz_to_camera })
                .collect(),
            as_shot_neutral: c.as_shot_neutral,
        }),
    };
    let json = serde_json::to_vec_pretty(&meta).map_err(|e| io_err(path, e))?;
    let sidecar = sidecar_path(path);
    let tmp = sidecar.with_extension("json.part");
    // The sidecar marks the PNG complete (`intermediate_ready`): without it the PNG goes too.
    fs::write(&tmp, json).and_then(|()| fs::rename(&tmp, &sidecar)).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(path);
    })?;
    Ok(meta)
}

/// The sidecar of the intermediate at `path`, if it exists and parses.
pub fn read_intermediate_meta(path: &Path) -> Option<IntermediateMeta> {
    let meta: IntermediateMeta = serde_json::from_slice(&fs::read(sidecar_path(path)).ok()?).ok()?;
    (meta.engine == DENOISE_ENGINE && meta.encoding == INTERMEDIATE_ENCODING).then_some(meta)
}

/// Whether a complete intermediate for `key` is at `path` (PNG present, sidecar with that key).
pub fn intermediate_ready(path: &Path, key: &str) -> bool {
    path.is_file() && read_intermediate_meta(path).is_some_and(|m| m.key == key)
}

/// Read an intermediate back to linear Rec.2020 (with the source's RAW metadata from the sidecar).
pub fn read_intermediate(path: &Path) -> Result<LinearImage> {
    read_intermediate_fit(path, None)
}

/// [`read_intermediate`], downscaled in linear light to fit `max_long_edge` when given (the 1600 px proxy).
pub fn read_intermediate_fit(path: &Path, max_long_edge: Option<u32>) -> Result<LinearImage> {
    use image::{ColorType, ImageDecoder};
    let meta = read_intermediate_meta(path).ok_or_else(|| io_err(path, "missing or unreadable sidecar"))?;
    let file = fs::File::open(path)?;
    let decoder = image::codecs::png::PngDecoder::new(BufReader::with_capacity(1 << 20, file)).map_err(|e| io_err(path, e))?;
    let (w, h) = decoder.dimensions();
    if decoder.color_type() != ColorType::Rgb16 || (w, h) != (meta.width, meta.height) {
        return Err(io_err(path, format!("not a {}×{} 16-bit RGB intermediate", meta.width, meta.height)));
    }
    let mut bytes = vec![0u8; decoder.total_bytes() as usize];
    decoder.read_image(&mut bytes).map_err(|e| io_err(path, e))?;
    // 65536-entry decode table: encoded code → linear (times the scale).
    let lut: Vec<f32> = (0..=u16::MAX).map(|q| srgb_to_linear(q as f32 / 65535.0) * meta.scale).collect();
    let data: Vec<f32> = bytes.par_chunks(2).map(|b| lut[u16::from_ne_bytes([b[0], b[1]]) as usize]).collect();
    let image = LinearImage::new(w, h, data).with_meta(meta.image_meta());
    match max_long_edge {
        Some(edge) if edge > 0 && w.max(h) > edge => {
            let (fw, fh) = crate::decode::fit(w, h, edge);
            crate::decode::resize_linear(image, fw, fh).map_err(|e| io_err(path, e))
        }
        _ => Ok(image),
    }
}

/// Remove `denoise-*` intermediates (PNG and sidecar) in `dir` except those of `keep`. Returns how many files went.
pub fn prune_intermediates(dir: &Path, keep: &[&str]) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = intermediate_key_of(&name) else { continue };
        if !keep.contains(&key) && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The key of a `denoise-<key>[-proxy].{png,json}[.part]` file name.
fn intermediate_key_of(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("denoise-")?;
    let stem = rest.split('.').next().unwrap_or_default();
    Some(stem.strip_suffix("-proxy").unwrap_or(stem))
}

/// [`prune_intermediates`] that also keeps the `recent` most recently written other keys: the same bytes denoised with
/// other settings (another version of the photo) may still be needed, e.g. by a publish that denoises both versions.
/// Returns how many files were removed.
pub fn prune_intermediates_keeping(dir: &Path, keep: &[&str], recent: usize) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut others: HashMap<String, std::time::SystemTime> = HashMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = intermediate_key_of(&name) else { continue };
        if keep.contains(&key) {
            continue;
        }
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
        let newest = others.entry(key.to_owned()).or_insert(modified);
        *newest = (*newest).max(modified);
    }
    let mut others: Vec<_> = others.into_iter().collect();
    others.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let kept: Vec<&str> = keep.iter().copied().chain(others.iter().take(recent).map(|(k, _)| k.as_str())).collect();
    prune_intermediates(dir, &kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_change_with_every_input() {
        let key = |h: &str, m: &str, v: &str, l: f64, c: f64, s: f64| denoise_key(h, m, v, l, c, s, ChromaMode::Model);
        let base = key("h", "m", "1", 50.0, 75.0, 25.0);
        assert_eq!(base.len(), 64);
        assert_eq!(base, key("h", "m", "1", 50.0, 75.0, 25.0));
        for other in [
            key("h2", "m", "1", 50.0, 75.0, 25.0),
            key("h", "m2", "1", 50.0, 75.0, 25.0),
            key("h", "m", "2", 50.0, 75.0, 25.0),
            key("h", "m", "1", 51.0, 75.0, 25.0),
            key("h", "m", "1", 50.0, 74.0, 25.0),
            key("h", "m", "1", 50.0, 75.0, 26.0),
            denoise_key("h", "m", "1", 50.0, 75.0, 25.0, ChromaMode::Filter),
        ] {
            assert_ne!(base, other);
        }
        // Filter mode: the Colour slider is applied at render time, so it does not change the key.
        let filter = |c: f64| denoise_key("h", "m", "1", 50.0, c, 25.0, ChromaMode::Filter);
        assert_eq!(filter(75.0), filter(10.0));
        let s = Denoise {
            model: DenoiseModel::NafnetW32,
            luminance: 50.0,
            chroma: 75.0,
            sharpen: 25.0,
            chroma_mode: ChromaMode::Model,
        };
        assert!(denoise_key_for("h", &s).is_some());
        assert!(denoise_key_for("h", &Denoise { model: DenoiseModel::NafnetW64, ..s }).is_none());
    }

    /// Workflow plan 25: the key names the L merge, so an intermediate made with the flat blend (the same inputs
    /// without `merge:wavelet`) is not reused.
    #[test]
    fn the_key_names_the_wavelet_merge() {
        let flat = hex::encode(Sha256::digest(format!("{DENOISE_ENGINE}\nh\nm\n1\n50.00\nfilter\n25.00").as_bytes()));
        let wavelet = hex::encode(Sha256::digest(
            format!("{DENOISE_ENGINE}\nh\nm\n1\n50.00\nfilter\n25.00\nmerge:wavelet").as_bytes(),
        ));
        let key = denoise_key("h", "m", "1", 50.0, 75.0, 25.0, ChromaMode::Filter);
        assert_ne!(key, flat);
        assert_eq!(key, wavelet);
        assert_eq!(merge::MERGE, "wavelet");
    }

    #[test]
    fn keeps_the_most_recent_other_keys() {
        let tmp = tempfile::tempdir().unwrap();
        for (i, key) in ["old", "mid", "new"].iter().enumerate() {
            for name in [format!("denoise-{key}.png"), format!("denoise-{key}.json")] {
                let path = tmp.path().join(name);
                fs::write(&path, b"x").unwrap();
                let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
                fs::File::options().write(true).open(&path).unwrap().set_modified(t).unwrap();
            }
        }
        fs::write(tmp.path().join("denoise-cur.png"), b"x").unwrap();
        // The current key and the newest other one stay; the older two go.
        assert_eq!(prune_intermediates_keeping(tmp.path(), &["cur"], 1), 4);
        let mut left: Vec<String> =
            fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["denoise-cur.png", "denoise-new.json", "denoise-new.png"]);
        assert_eq!(prune_intermediates_keeping(tmp.path(), &["cur"], 1), 0);
    }

    #[test]
    fn prunes_other_keys_only() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["denoise-a.png", "denoise-a.json", "denoise-a-proxy.png", "denoise-b.png", "denoise-b.json", "x.png"] {
            fs::write(tmp.path().join(name), b"x").unwrap();
        }
        assert_eq!(prune_intermediates(tmp.path(), &["a"]), 2);
        let mut left: Vec<String> =
            fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["denoise-a-proxy.png", "denoise-a.json", "denoise-a.png", "x.png"]);
    }
}
