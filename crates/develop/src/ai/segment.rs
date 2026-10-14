//! Segmentation models (D4.3): subject, sky (and water, person, background), people, SAM prompts.
//!
//! Every function takes the picture as a [`LinearImage`] (the frame the model should see) and returns planes on
//! that picture's grid (`image.width × image.height`, 0..1), **unrefined**: [`super::refine`] snaps them to the
//! picture's edges afterwards, and [`generate`] (the whole flow behind the editor's commands) does both and maps
//! the result into the cache's frame.
//!
//! | Target | Model | Input | Output |
//! | --- | --- | --- | --- |
//! | Subject | BiRefNet lite | 1024², letterboxed, ImageNet | `output_image` logits → sigmoid |
//! | Subject (fast) | U²-Netp, when BiRefNet lite is not installed and it is | 320², letterboxed, ImageNet | fused side output (`1959`), already a sigmoid |
//! | Sky | SkyWater-Seg | 384², stretched, ImageNet | `output_fp32` 4 class logits → softmax (background, sky, water, person) |
//! | People | RT-DETR v2 → SAM 2.1 tiny | 640² stretched, RGB/255 → 1024² letterboxed, ImageNet | person boxes (score > 0.5, NMS) → one SAM box prompt each |
//! | Prompts | SAM 2.1 tiny | 1024² letterboxed | points/boxes → 3 masks, the best by predicted IoU |
//! | Background | BiRefNet lite | as Subject | `1 − subject` (optionally ∪ sky) |

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ndarray::{Array, ArrayD, IxDyn};
use rayon::prelude::*;

use super::depth::{depth, depth_range_plane, DepthMap, DEPTH_FEATHER};
use super::preprocess::{prepare, remap_exact, sigmoid, unletterbox, Filter, Fit, InputFrame, Norm};
use super::refine::refine;
use super::runtime::{Session, SessionOptions, Tensor};
use super::{registry, status, Error, ModelDir, ModelEntry, ModelStatus, Result, Task};
use crate::geometry::orientation::{orientation_matrix, oriented_size};
use crate::geometry::transform::{has_perspective, perspective_matrix};
use crate::geometry::Homography;
use crate::image::LinearImage;
use crate::masks::MaskPlane;
use crate::settings::{AiMaskTarget, Geometry, MaskComponent, MaskPrompt, MaskShape, Point, PromptKind};

/// BiRefNet and SAM input side.
pub const SUBJECT_INPUT: u32 = 1024;
pub const SAM_INPUT: u32 = 1024;
pub const SKY_INPUT: u32 = 384;
pub const DETR_INPUT: u32 = 640;
/// RT-DETR person score threshold and the NMS overlap.
pub const PERSON_SCORE: f32 = 0.5;
pub const PERSON_NMS_IOU: f32 = 0.5;
/// COCO class index of "person" in RT-DETR's 80 logits.
pub const COCO_PERSON: usize = 0;

/// U²-Netp input side (task `subject-fast`).
pub const SUBJECT_FAST_INPUT: u32 = 320;

/// Subject (salient object) probability, 0..1, at the image's size.
pub fn subject(session: &Session, image: &LinearImage) -> Result<MaskPlane> {
    let input = prepare(image, SUBJECT_INPUT, SUBJECT_INPUT, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear)?;
    let out = session.run(&[("input_image", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let logits = out.get("output_image").or_else(|| out.first()).ok_or_else(|| Error::Runtime("subject: no output".into()))?;
    let (h, w) = last_two(logits.shape(), "subject")?;
    let data: Vec<f32> = logits.iter().copied().collect();
    let mut plane = unletterbox(&data, w, h, &input.frame, image.width, image.height)?;
    plane.data.iter_mut().for_each(|v| *v = sigmoid(*v));
    Ok(plane)
}

/// Subject probability from U²-Netp (task `subject-fast`: 320², letterboxed, ImageNet), at the image's size. Its
/// fused side output (`1959`, the first) is already a sigmoid.
pub fn subject_fast(session: &Session, image: &LinearImage) -> Result<MaskPlane> {
    let input =
        prepare(image, SUBJECT_FAST_INPUT, SUBJECT_FAST_INPUT, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear)?;
    let out = session.run(&[("input.1", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let fused = out.get("1959").or_else(|| out.first()).ok_or_else(|| Error::Runtime("subject-fast: no output".into()))?;
    let (h, w) = last_two(fused.shape(), "subject-fast")?;
    let data: Vec<f32> = fused.iter().copied().collect();
    let mut plane = unletterbox(&data, w, h, &input.frame, image.width, image.height)?;
    plane.data.iter_mut().for_each(|v| *v = v.clamp(0.0, 1.0));
    Ok(plane)
}

/// SkyWater-Seg's four class probabilities at the image's size (a softmax per pixel, so they sum to 1).
#[derive(Debug, Clone, PartialEq)]
pub struct SkyResult {
    pub background: MaskPlane,
    pub sky: MaskPlane,
    pub water: MaskPlane,
    pub person: MaskPlane,
}

/// Run SkyWater-Seg (384² stretched, ImageNet). The logits are resized to the image first and the softmax taken
/// there, so class boundaries are interpolated in logit space.
pub fn sky(session: &Session, image: &LinearImage) -> Result<SkyResult> {
    let input = prepare(image, SKY_INPUT, SKY_INPUT, Fit::Stretch, Norm::ImageNet, Filter::Bilinear)?;
    let out = session.run(&[("input", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let logits = out.get("output_fp32").or_else(|| out.first()).ok_or_else(|| Error::Runtime("sky: no output".into()))?;
    let shape = logits.shape().to_vec();
    if shape.len() != 4 || shape[1] < 4 {
        return Err(Error::Runtime(format!("sky: unexpected output shape {shape:?}")));
    }
    let (h, w) = (shape[2] as u32, shape[3] as u32);
    let mut planes = Vec::with_capacity(4);
    for k in 0..4 {
        let data: Vec<f32> = logits.index_axis(ndarray::Axis(1), k).iter().copied().collect();
        planes.push(unletterbox(&data, w, h, &input.frame, image.width, image.height)?.data);
    }
    let softmax: Vec<[f32; 4]> = (0..image.width as usize * image.height as usize)
        .into_par_iter()
        .map(|i| {
            let v = [planes[0][i], planes[1][i], planes[2][i], planes[3][i]];
            let m = v.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            let e = v.map(|x| (x - m).exp());
            let s = e.iter().sum::<f32>();
            e.map(|x| x / s)
        })
        .collect();
    let mut it = (0..4).map(|k| MaskPlane::new(image.width, image.height, softmax.iter().map(|p| p[k]).collect()));
    Ok(SkyResult {
        background: it.next().expect("4 planes"),
        sky: it.next().expect("4 planes"),
        water: it.next().expect("4 planes"),
        person: it.next().expect("4 planes"),
    })
}

/// `1 − subject`, optionally unioned (max) with a sky plane of the same size.
pub fn background(subject: &MaskPlane, sky: Option<&MaskPlane>) -> MaskPlane {
    let mut out = subject.clone();
    out.data.iter_mut().for_each(|v| *v = 1.0 - *v);
    if let Some(s) = sky {
        let s = s.resized(out.width, out.height);
        out.data.iter_mut().zip(&s.data).for_each(|(v, s)| *v = v.max(*s));
    }
    out
}

/// A detected person: box in image fractions `[x0, y0, x1, y1]` and score.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PersonBox {
    pub bbox: [f64; 4],
    pub score: f32,
}

fn iou(a: &[f64; 4], b: &[f64; 4]) -> f64 {
    let ix = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let iy = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = ix * iy;
    let area = |r: &[f64; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    let union = area(a) + area(b) - inter;
    if union > 0.0 {
        inter / union
    } else {
        0.0
    }
}

/// Greedy non-maximum suppression: highest score first, drop boxes overlapping a kept one by more than `max_iou`.
pub fn nms(mut boxes: Vec<PersonBox>, max_iou: f32) -> Vec<PersonBox> {
    boxes.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<PersonBox> = Vec::new();
    for b in boxes {
        if kept.iter().all(|k| iou(&k.bbox, &b.bbox) <= max_iou as f64) {
            kept.push(b);
        }
    }
    kept
}

/// RT-DETR person boxes (score > [`PERSON_SCORE`], NMS at [`PERSON_NMS_IOU`]), highest score first.
pub fn detect_people(session: &Session, image: &LinearImage) -> Result<Vec<PersonBox>> {
    let input = prepare(image, DETR_INPUT, DETR_INPUT, Fit::Stretch, Norm::Unit, Filter::Bilinear)?;
    let out = session.run(&[("pixel_values", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let logits = out.get("logits").ok_or_else(|| Error::Runtime("people: no logits".into()))?;
    let boxes = out.get("pred_boxes").ok_or_else(|| Error::Runtime("people: no pred_boxes".into()))?;
    let (ls, bs) = (logits.shape(), boxes.shape());
    if ls.len() != 3 || bs.len() != 3 || ls[1] != bs[1] || bs[2] != 4 || ls[2] <= COCO_PERSON {
        return Err(Error::Runtime(format!("people: unexpected shapes {ls:?} {bs:?}")));
    }
    let mut found = Vec::new();
    for q in 0..ls[1] {
        let score = sigmoid(logits[[0, q, COCO_PERSON]]);
        if score <= PERSON_SCORE {
            continue;
        }
        let (cx, cy, w, h) = (boxes[[0, q, 0]] as f64, boxes[[0, q, 1]] as f64, boxes[[0, q, 2]] as f64, boxes[[0, q, 3]] as f64);
        let bbox = [(cx - w / 2.0).clamp(0.0, 1.0), (cy - h / 2.0).clamp(0.0, 1.0), (cx + w / 2.0).clamp(0.0, 1.0), (cy + h / 2.0).clamp(0.0, 1.0)];
        if bbox[2] > bbox[0] && bbox[3] > bbox[1] {
            found.push(PersonBox { bbox, score });
        }
    }
    Ok(nms(found, PERSON_NMS_IOU))
}

/// SAM 2.1's image embeddings for one picture (the expensive half; prompts reuse it).
#[derive(Debug, Clone)]
pub struct SamEncoding {
    pub embeddings: [ArrayD<f32>; 3],
    /// Where the picture sits in the 1024² input.
    pub frame: InputFrame,
}

/// Names of the encoder outputs, in the order the decoder takes them.
const SAM_EMBEDDINGS: [&str; 3] = ["image_embeddings.0", "image_embeddings.1", "image_embeddings.2"];

/// Run SAM's image encoder (1024² letterboxed, ImageNet).
pub fn sam_encode(encoder: &Session, image: &LinearImage) -> Result<SamEncoding> {
    let input = prepare(image, SAM_INPUT, SAM_INPUT, Fit::Letterbox, Norm::ImageNet, Filter::Bilinear)?;
    let out = encoder.run(&[("pixel_values", Tensor::F32(input.tensor.view().into_dyn()))])?;
    let get = |name: &str| out.get(name).cloned().ok_or_else(|| Error::Runtime(format!("SAM encoder: no {name}")));
    Ok(SamEncoding { embeddings: [get(SAM_EMBEDDINGS[0])?, get(SAM_EMBEDDINGS[1])?, get(SAM_EMBEDDINGS[2])?], frame: input.frame })
}

/// One SAM prompt set in image fractions: points with labels (1 include, 0 exclude) and at most one box.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SamPrompt {
    pub points: Vec<([f64; 2], bool)>,
    pub bbox: Option<[f64; 4]>,
}

/// Decode one prompt set: the best of SAM's three masks by its predicted IoU, as probabilities at the encoded
/// image's size, with that IoU.
pub fn sam_decode(decoder: &Session, enc: &SamEncoding, prompt: &SamPrompt) -> Result<(MaskPlane, f32)> {
    let f = &enc.frame;
    // SAM wants at least one point; with a box only, a single padding point (label −1) stands in.
    let mut pts: Vec<f32> = Vec::new();
    let mut labels: Vec<i64> = Vec::new();
    for (p, positive) in &prompt.points {
        let q = f.to_input(*p);
        pts.extend([q[0] as f32, q[1] as f32]);
        labels.push(i64::from(*positive));
    }
    if pts.is_empty() {
        pts.extend([0.0, 0.0]);
        labels.push(-1);
    }
    let n = labels.len();
    let points = Array::from_shape_vec(IxDyn(&[1, 1, n, 2]), pts).expect("shape");
    let labels = Array::from_shape_vec(IxDyn(&[1, 1, n]), labels).expect("shape");
    // The graph always takes `input_boxes`; no box is an empty `[1, 0, 4]`.
    let boxes = match prompt.bbox {
        Some(b) => {
            let (p0, p1) = (f.to_input([b[0], b[1]]), f.to_input([b[2], b[3]]));
            Array::from_shape_vec(IxDyn(&[1, 1, 4]), vec![p0[0] as f32, p0[1] as f32, p1[0] as f32, p1[1] as f32])
        }
        None => Array::from_shape_vec(IxDyn(&[1, 0, 4]), Vec::new()),
    }
    .expect("shape");
    let inputs: Vec<(&str, Tensor<'_>)> = vec![
        ("input_points", Tensor::F32(points.view())),
        ("input_labels", Tensor::I64(labels.view())),
        (SAM_EMBEDDINGS[0], Tensor::F32(enc.embeddings[0].view())),
        (SAM_EMBEDDINGS[1], Tensor::F32(enc.embeddings[1].view())),
        (SAM_EMBEDDINGS[2], Tensor::F32(enc.embeddings[2].view())),
        ("input_boxes", Tensor::F32(boxes.view())),
    ];
    let out = decoder.run(&inputs)?;
    let masks = out.get("pred_masks").ok_or_else(|| Error::Runtime("SAM decoder: no pred_masks".into()))?;
    let scores = out.get("iou_scores").ok_or_else(|| Error::Runtime("SAM decoder: no iou_scores".into()))?;
    let ms = masks.shape().to_vec();
    if ms.len() != 5 {
        return Err(Error::Runtime(format!("SAM decoder: unexpected mask shape {ms:?}")));
    }
    let k = ms[2];
    let best = (0..k).max_by(|&a, &b| scores[[0, 0, a]].total_cmp(&scores[[0, 0, b]])).unwrap_or(0);
    let (h, w) = (ms[3] as u32, ms[4] as u32);
    let data: Vec<f32> = masks.slice(ndarray::s![0, 0, best, .., ..]).iter().copied().collect();
    let mut plane = unletterbox(&data, w, h, f, f.source_width, f.source_height)?;
    plane.data.iter_mut().for_each(|v| *v = sigmoid(*v));
    Ok((plane, scores[[0, 0, best]]))
}

/// Click and box prompts → one plane at the encoded image's size. `prompts` are in fractions of that image. Points
/// go in together (positive include, negative exclude); each box is decoded with all the points and the results
/// are merged by max. No usable prompt → an empty plane.
pub fn sam_refine(decoder: &Session, enc: &SamEncoding, prompts: &[MaskPrompt]) -> Result<MaskPlane> {
    let (w, h) = (enc.frame.source_width, enc.frame.source_height);
    let points: Vec<([f64; 2], bool)> = prompts
        .iter()
        .filter(|p| p.kind == PromptKind::Point)
        .filter_map(|p| p.point.filter(|q| q[0].is_finite() && q[1].is_finite()).map(|q| (q, p.positive)))
        .collect();
    let boxes: Vec<[f64; 4]> = prompts
        .iter()
        .filter(|p| p.kind == PromptKind::Box && p.positive)
        .filter_map(|p| p.bbox)
        .map(|[a, b]| [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])])
        .filter(|b| b.iter().all(|v| v.is_finite()) && b[2] > b[0] && b[3] > b[1])
        .collect();
    if boxes.is_empty() {
        if !points.iter().any(|(_, positive)| *positive) {
            return Ok(MaskPlane::zeros(w, h));
        }
        return Ok(sam_decode(decoder, enc, &SamPrompt { points, bbox: None })?.0);
    }
    let mut acc = MaskPlane::zeros(w, h);
    for b in boxes {
        let (plane, _) = sam_decode(decoder, enc, &SamPrompt { points: points.clone(), bbox: Some(b) })?;
        acc.data.iter_mut().zip(&plane.data).for_each(|(a, v)| *a = a.max(*v));
    }
    Ok(acc)
}

/// People: RT-DETR person boxes, each one a SAM box prompt. One plane per person (highest score first), or a
/// single plane merged by max when `merge` (empty when nobody is found). Also returns the boxes.
pub fn people(
    detector: &Session,
    encoder: &Session,
    decoder: &Session,
    image: &LinearImage,
    merge: bool,
) -> Result<(Vec<MaskPlane>, Vec<PersonBox>)> {
    let boxes = detect_people(detector, image)?;
    let enc = sam_encode(encoder, image)?;
    people_from(decoder, &enc, &boxes, merge)
}

/// [`people`] with the boxes and the SAM encoding already made.
pub fn people_from(decoder: &Session, enc: &SamEncoding, boxes: &[PersonBox], merge: bool) -> Result<(Vec<MaskPlane>, Vec<PersonBox>)> {
    let (w, h) = (enc.frame.source_width, enc.frame.source_height);
    let mut planes = Vec::with_capacity(boxes.len());
    for b in boxes {
        planes.push(sam_decode(decoder, enc, &SamPrompt { points: Vec::new(), bbox: Some(b.bbox) })?.0);
    }
    if merge {
        let mut acc = MaskPlane::zeros(w, h);
        for p in &planes {
            acc.data.iter_mut().zip(&p.data).for_each(|(a, v)| *a = a.max(*v));
        }
        planes = vec![acc];
    }
    Ok((planes, boxes.to_vec()))
}

fn last_two(shape: &[usize], what: &str) -> Result<(u32, u32)> {
    match shape {
        [.., h, w] if shape.len() >= 2 => Ok((*h as u32, *w as u32)),
        _ => Err(Error::Runtime(format!("{what}: unexpected output shape {shape:?}"))),
    }
}

// ---------------------------------------------------------------------------------------------
// The whole flow: models for a component, sessions, frames, generation.

/// Loaded sessions by model name, loaded on first use and kept (the editor holds one while the Develop view is
/// open and drops it afterwards).
#[derive(Debug, Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

impl Sessions {
    /// The session for `entry` (loading it under `dir` on a miss and logging its compute plan once).
    pub fn get(&self, entry: &ModelEntry, dir: &ModelDir) -> Result<Arc<Session>> {
        let key = format!("{}@{}", entry.name, entry.version);
        if let Some(s) = self.map.lock().expect("sessions lock").get(&key) {
            return Ok(s.clone());
        }
        let session = Arc::new(load_session(entry, dir)?);
        session.log_compute_plan();
        self.map.lock().expect("sessions lock").insert(key, session.clone());
        Ok(session)
    }

    /// Drop every session (frees the models' memory).
    pub fn clear(&self) {
        self.map.lock().expect("sessions lock").clear();
    }

    pub fn len(&self) -> usize {
        self.map.lock().expect("sessions lock").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Marker file in a model's version folder: CoreML could not compile this model here, so it loads on the CPU EP
/// straight away. (BiRefNet lite's fp16 graph fails Core ML's ML Program parser on a dilated `Conv` without `pads`;
/// each failed attempt costs minutes.) Deleting or updating the model removes the folder and the marker with it.
pub const COREML_UNSUPPORTED: &str = "coreml-unsupported";

/// Load a manifest model: with CoreML unless an earlier load found CoreML cannot compile it
/// ([`COREML_UNSUPPORTED`]); a load that had to fall back to the CPU writes that marker and drops the CoreML cache.
pub fn load_session(entry: &ModelEntry, dir: &ModelDir) -> Result<Session> {
    let marker = dir.version_dir(entry).join(COREML_UNSUPPORTED);
    let opts = SessionOptions::for_model(entry, dir);
    if opts.coreml && marker.is_file() {
        return Session::load(&dir.primary_path(entry), &opts.cpu());
    }
    let session = Session::load(&dir.primary_path(entry), &opts)?;
    if opts.coreml && cfg!(target_os = "macos") && !session.info().coreml_requested {
        log::info!("[photobook:ai] {}: CoreML cannot compile this model; later loads use the CPU directly", entry.name);
        let _ = std::fs::write(&marker, "CoreML failed to compile this model; it runs on the CPU EP.\n");
        let _ = std::fs::remove_dir_all(dir.coreml_cache_dir(entry));
    }
    Ok(session)
}

/// Whether a component runs SAM on its own prompts (a promptable target with at least one prompt).
pub fn uses_prompts(component: &MaskComponent) -> bool {
    match &component.shape {
        MaskShape::Ai { target, prompts, .. } => {
            matches!(target, AiMaskTarget::Subject | AiMaskTarget::Background | AiMaskTarget::People) && !prompts.is_empty()
        }
        _ => false,
    }
}

/// The model of `task` named `name` when the manifest has it for that task, else the task's primary model.
fn model_for(task: Task, name: &str) -> Option<&'static ModelEntry> {
    registry().get(name).filter(|m| m.task == task).or_else(|| registry().for_task(task))
}

/// The model Subject and Background (without prompts) run: the `subject` model `name` names, else BiRefNet lite (the
/// task's primary), except that U²-Netp
/// (task `subject-fast`, coarser but about 30× faster) stands in when BiRefNet lite is not installed in `dir` and
/// U²-Netp is. Nothing else is offered: with neither installed (or no `dir`) it is BiRefNet lite, the one the
/// download prompt asks for. A component stamped with U²-Netp goes back to BiRefNet lite once that is installed (the
/// UI then shows it as outdated and offers Regenerate).
fn subject_model(name: &str, dir: Option<&ModelDir>) -> Option<&'static ModelEntry> {
    let primary = model_for(Task::Subject, name);
    let Some(dir) = dir else { return primary };
    let installed = |m: &&'static ModelEntry| status(m, dir) == ModelStatus::Installed;
    match primary {
        Some(p) if installed(&p) => Some(p),
        _ => registry().for_task(Task::SubjectFast).filter(installed).or(primary),
    }
}

/// The models a component needs, primary first: the one its `model` names (when it fits the target) or the
/// target's default, plus SAM's encoder and decoder for people and prompted components. Empty for a non-AI
/// component. Without a model folder, Subject and Background name BiRefNet lite; see [`required_models_in`].
pub fn required_models(component: &MaskComponent) -> Vec<&'static ModelEntry> {
    required_models_in(component, None)
}

/// [`required_models`] for the models installed in `dir`: Subject and Background fall back to U²-Netp when only that
/// one is installed ([`subject_model`]).
pub fn required_models_in(component: &MaskComponent, dir: Option<&ModelDir>) -> Vec<&'static ModelEntry> {
    let MaskShape::Ai { target, model, .. } = &component.shape else { return Vec::new() };
    let sam = || [registry().for_task(Task::SamEncoder), registry().for_task(Task::SamDecoder)];
    let list: Vec<Option<&'static ModelEntry>> = if uses_prompts(component) {
        sam().to_vec()
    } else {
        match target {
            AiMaskTarget::Subject | AiMaskTarget::Background => vec![subject_model(model, dir)],
            AiMaskTarget::Sky => vec![model_for(Task::Sky, model)],
            AiMaskTarget::Depth => vec![model_for(Task::Depth, model)],
            AiMaskTarget::People => {
                let mut v = vec![model_for(Task::PeopleDetect, model)];
                v.extend(sam());
                v
            }
        }
    };
    list.into_iter().flatten().collect()
}

/// The required models that are not installed under `dir`.
pub fn missing_models(component: &MaskComponent, dir: &ModelDir) -> Vec<&'static ModelEntry> {
    required_models_in(component, Some(dir)).into_iter().filter(|m| status(m, dir) != ModelStatus::Installed).collect()
}

/// `component` with `model` and `modelVersion` set to the primary model that generates it (what the cache key
/// and the UI's "regenerate when the version changes" use). Non-AI components come back unchanged.
pub fn stamp_model(component: &MaskComponent) -> MaskComponent {
    stamp_model_in(component, None)
}

/// [`stamp_model`] with the model [`required_models_in`] picks for the models installed in `dir`.
pub fn stamp_model_in(component: &MaskComponent, dir: Option<&ModelDir>) -> MaskComponent {
    let mut c = component.clone();
    let primary = required_models_in(component, dir).first().copied();
    if let (MaskShape::Ai { model, model_version, .. }, Some(m)) = (&mut c.shape, primary) {
        *model = m.name.clone();
        *model_version = m.version.clone();
    }
    c
}

/// The frame the models see: the decoded picture turned and flipped as the user's rotate/flip says (an exact
/// pixel permutation; Upright, Transform, straighten and crop are left out: models want the natural photo).
#[derive(Debug, Clone)]
pub struct InferenceFrame {
    pub image: LinearImage,
    /// Normalised inference frame → normalised source (decoded) frame.
    pub to_source: Homography,
    /// Normalised source → normalised inference frame (the orientation matrix).
    pub from_source: Homography,
    /// Normalised transformed frame (where prompts live) → normalised inference frame.
    pub from_prompt_frame: Homography,
    /// Normalised inference frame → normalised transformed frame.
    pub to_prompt_frame: Homography,
}

impl InferenceFrame {
    pub fn new(source: &LinearImage, geometry: &Geometry) -> InferenceFrame {
        let o = orientation_matrix(geometry);
        let o_inv = o.invert().unwrap_or_default();
        let (w, h) = oriented_size(geometry.rotate, source.width, source.height);
        let data = remap_exact(&source.data, 3, (source.width, source.height), (w, h), &o_inv);
        let image = LinearImage::new(w, h, data).with_meta(source.meta.clone());
        let p = if has_perspective(geometry) { perspective_matrix(geometry, w as f64, h as f64) } else { Homography::identity() };
        let p_inv = p.invert().unwrap_or_default();
        InferenceFrame { image, to_source: o_inv, from_source: o, from_prompt_frame: p_inv, to_prompt_frame: p }
    }

    /// A plane on the inference grid brought back to the source grid (`sw × sh`, exact permutation).
    pub fn plane_to_source(&self, plane: &MaskPlane, sw: u32, sh: u32) -> MaskPlane {
        let data = remap_exact(&plane.data, 1, (plane.width, plane.height), (sw, sh), &self.from_source);
        MaskPlane::new(sw, sh, data)
    }

    /// Prompts from the transformed frame (fractions, as stored in the settings) into inference-frame fractions.
    pub fn prompts_in(&self, prompts: &[MaskPrompt]) -> Vec<MaskPrompt> {
        let map = |p: Point| self.from_prompt_frame.apply(p);
        prompts
            .iter()
            .map(|p| MaskPrompt {
                kind: p.kind,
                point: p.point.map(map),
                bbox: p.bbox.map(|[a, b]| {
                    // A box maps to a quadrilateral under a perspective; keep its bounding box.
                    let c = [map(a), map([b[0], a[1]]), map(b), map([a[0], b[1]])];
                    let (x0, x1) = c.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q[0]), hi.max(q[0])));
                    let (y0, y1) = c.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q[1]), hi.max(q[1])));
                    [[x0, y0], [x1, y1]]
                }),
                positive: p.positive,
            })
            .collect()
    }

    /// A box in inference-frame fractions as a box prompt in the transformed frame (the bounding box of its image).
    pub fn box_to_prompt_frame(&self, b: [f64; 4]) -> [Point; 2] {
        let c = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(|p| self.to_prompt_frame.apply(p));
        let (x0, x1) = c.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q[0]), hi.max(q[0])));
        let (y0, y1) = c.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), q| (lo.min(q[1]), hi.max(q[1])));
        [[x0, y0], [x1, y1]]
    }
}

/// The key of a SAM encoding: the picture and the rotate/flip it was encoded under.
pub fn sam_key(image_id: &str, geometry: &Geometry) -> String {
    format!("{image_id}|{:?}|{}|{}", geometry.rotate, geometry.flip_h, geometry.flip_v)
}

/// The stage [`generate`] is in, for progress events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Loading (and on first use compiling) a model.
    Loading,
    /// Running a model.
    Running,
    /// Guided-filter refinement and mapping into the cache frame.
    Refining,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Loading => "loading",
            Stage::Running => "running",
            Stage::Refining => "refining",
        }
    }
}

/// What [`generate`] made.
#[derive(Debug, Clone)]
pub struct Generated {
    /// The component as generated ([`stamp_model`]): store the raster under its hash.
    pub component: MaskComponent,
    /// The refined raster on the **source** grid (the decoded picture's frame, before rotate/flip and the rest of
    /// the geometry): what the cache stores. For depth, the range mask of `depth`.
    pub raster: MaskPlane,
    /// For a depth component: the refined normalised depth map on the source grid (the cache stores it so the range
    /// can move without the model).
    pub depth: Option<DepthMap>,
    /// For people: the person boxes found, as box prompts in the transformed frame (fractions), highest score
    /// first, so the UI can make one component per person.
    pub people: Vec<[Point; 2]>,
    /// Time per model run (`(model name, duration)`), loading excluded.
    pub timings: Vec<(String, Duration)>,
}

/// A cache of SAM encodings (the editor keeps the current picture's).
pub trait SamCache: Sync {
    fn get(&self, key: &str) -> Option<Arc<SamEncoding>>;
    fn put(&self, key: &str, enc: Arc<SamEncoding>);
}

/// A one-entry [`SamCache`].
#[derive(Debug, Default)]
pub struct LastSamEncoding {
    slot: Mutex<Option<(String, Arc<SamEncoding>)>>,
}

impl SamCache for LastSamEncoding {
    fn get(&self, key: &str) -> Option<Arc<SamEncoding>> {
        self.slot.lock().expect("sam lock").as_ref().filter(|(k, _)| k == key).map(|(_, e)| e.clone())
    }

    fn put(&self, key: &str, enc: Arc<SamEncoding>) {
        *self.slot.lock().expect("sam lock") = Some((key.to_owned(), enc));
    }
}

impl LastSamEncoding {
    pub fn clear(&self) {
        *self.slot.lock().expect("sam lock") = None;
    }
}

/// Everything [`generate`] needs besides the component.
pub struct GenerateContext<'a> {
    /// The decoded picture (the editor's 1600 px proxy).
    pub image: &'a LinearImage,
    /// The picture's identity for the SAM cache (the content hash).
    pub image_id: &'a str,
    /// The settings' geometry: rotate/flip pick the inference frame, the perspective maps prompts.
    pub geometry: &'a Geometry,
    pub models: &'a ModelDir,
    pub sessions: &'a Sessions,
    pub sam: Option<&'a dyn SamCache>,
    pub progress: &'a (dyn Fn(Stage) + Sync),
}

/// Generate an AI component's raster: pick its models ([`required_models`]; errors with
/// [`Error::NotInstalled`] when one is missing), run them on the inference frame, refine against the picture
/// ([`super::refine::refine`]), and bring the result back to the source grid.
pub fn generate(component: &MaskComponent, ctx: &GenerateContext) -> Result<Generated> {
    let MaskShape::Ai { target, prompts, depth_range, .. } = &component.shape else {
        return Err(Error::Runtime("not an AI mask component".into()));
    };
    if let Some(m) = missing_models(component, ctx.models).first() {
        return Err(Error::NotInstalled(m.name.clone()));
    }
    let models = required_models_in(component, Some(ctx.models));
    let component = stamp_model_in(component, Some(ctx.models));
    let frame = InferenceFrame::new(ctx.image, ctx.geometry);
    let img = &frame.image;
    (ctx.progress)(Stage::Loading);
    let sessions: Vec<Arc<Session>> = models.iter().map(|m| ctx.sessions.get(m, ctx.models)).collect::<Result<_>>()?;
    let mut timings = Vec::new();
    let mut timed = |name: &str, t: Instant| timings.push((name.to_owned(), t.elapsed()));
    (ctx.progress)(Stage::Running);
    let mut people_boxes = Vec::new();
    let mut depth_map = None;
    let sam_encoding = |enc_session: &Session, timed: &mut dyn FnMut(&str, Instant)| -> Result<Arc<SamEncoding>> {
        let key = sam_key(ctx.image_id, ctx.geometry);
        if let Some(e) = ctx.sam.and_then(|c| c.get(&key)) {
            return Ok(e);
        }
        let t = Instant::now();
        let e = Arc::new(sam_encode(enc_session, img)?);
        timed("sam-encoder", t);
        if let Some(c) = ctx.sam {
            c.put(&key, e.clone());
        }
        Ok(e)
    };
    let plane = if uses_prompts(&component) {
        let enc = sam_encoding(&sessions[0], &mut timed)?;
        let t = Instant::now();
        let p = sam_refine(&sessions[1], &enc, &frame.prompts_in(prompts))?;
        timed("sam-decoder", t);
        if *target == AiMaskTarget::Background {
            background(&p, None)
        } else {
            p
        }
    } else {
        match target {
            AiMaskTarget::Subject | AiMaskTarget::Background => {
                let t = Instant::now();
                let s = if models[0].task == Task::SubjectFast {
                    subject_fast(&sessions[0], img)?
                } else {
                    subject(&sessions[0], img)?
                };
                timed(&models[0].name, t);
                if *target == AiMaskTarget::Background {
                    background(&s, None)
                } else {
                    s
                }
            }
            AiMaskTarget::Sky => {
                let t = Instant::now();
                let s = sky(&sessions[0], img)?;
                timed(&models[0].name, t);
                s.sky
            }
            AiMaskTarget::People => {
                let t = Instant::now();
                let boxes = detect_people(&sessions[0], img)?;
                timed(&models[0].name, t);
                let enc = sam_encoding(&sessions[1], &mut timed)?;
                let t = Instant::now();
                let (planes, boxes) = people_from(&sessions[2], &enc, &boxes, true)?;
                timed("sam-decoder", t);
                people_boxes = boxes.iter().map(|b| frame.box_to_prompt_frame(b.bbox)).collect();
                planes.into_iter().next().unwrap_or_else(|| MaskPlane::zeros(img.width, img.height))
            }
            AiMaskTarget::Depth => {
                let t = Instant::now();
                let d = depth(&sessions[0], img)?;
                timed(&models[0].name, t);
                depth_map = Some(d);
                MaskPlane::zeros(img.width, img.height)
            }
        }
    };
    (ctx.progress)(Stage::Refining);
    let (sw, sh) = (ctx.image.width, ctx.image.height);
    let (raster, depth) = match depth_map {
        Some(d) => {
            let refined = refine(&d.depth, img);
            let src = frame.plane_to_source(&refined, sw, sh);
            let raw = if d.raw.is_empty() { Vec::new() } else { frame.plane_to_source(&MaskPlane::new(img.width, img.height, d.raw), sw, sh).data };
            let map = DepthMap { depth: src, raw };
            (depth_range_plane(&map.depth, depth_range.unwrap_or([0.0, 1.0]), DEPTH_FEATHER), Some(map))
        }
        None => (frame.plane_to_source(&refine(&plane, img), sw, sh), None),
    };
    Ok(Generated { component, raster, depth, people: people_boxes, timings })
}

