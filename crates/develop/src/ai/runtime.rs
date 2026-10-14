//! ONNX Runtime sessions (`ort` 2.0 rc, statically linked) with the CoreML execution provider on macOS.
//!
//! CoreML EP settings follow plan section 4.7: ML Program format, all compute units, static input shapes, a model
//! cache directory (compilation can take minutes; the cache is keyed on graph metadata, so it lives under the model's
//! version folder), graph optimisation level 1 (higher levels fuse nodes into ops CoreML does not know, which splits
//! the graph), and the EP registered without `error_on_failure`, so a model or machine CoreML cannot handle runs on
//! the CPU EP instead.
//!
//! Partitions: ONNX Runtime logs `number of partitions supported by CoreML: N` while it assigns nodes. Each session
//! captures its own log (a per-session logger) and [`Session::log_compute_plan`] prints that summary once per model
//! per process (`[photobook:ai]` lines). One partition means the whole graph runs in Core ML; more mean CPU islands
//! and copies between them. CoreML's own per-operation compute plan (`ProfileComputePlan`) is printed by Core ML
//! itself to stderr, outside our logger, when [`SessionOptions::profile_compute_plan`] is set.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use half::f16;
use ndarray::{ArrayD, ArrayViewD, IxDyn};
use ort::ep;
use ort::logging::LogLevel;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::{DynValue, TensorElementType, TensorRef, ValueType};

use super::{Error, ModelDir, ModelEntry, Result};

/// How to build a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOptions {
    /// Register the CoreML EP (macOS only; ignored elsewhere). Off = CPU EP only.
    pub coreml: bool,
    /// Compile to an ML Program (Core ML 5+) instead of a NeuralNetwork. ML Programs support fp16 and more ops.
    pub ml_program: bool,
    /// CoreML's compiled-model cache. `None` recompiles on every load.
    pub cache_dir: Option<PathBuf>,
    /// Tell CoreML the inputs are static (`RequireStaticInputShapes`): nodes with dynamic shapes stay on the CPU
    /// instead of making Core ML fall back to slower dynamic shapes. Pair with [`dims`](Self::dims).
    pub static_shape: bool,
    /// Symbolic dimension overrides (ONNX `dim_param` name, size), from the manifest's `dims`.
    pub dims: Vec<(String, i64)>,
    /// Intra-op threads for the CPU EP (0 = up to 8, one per core).
    pub intra_threads: usize,
    /// Ask Core ML to print its per-operation compute plan (stderr, macOS 14.4+). Debugging only.
    pub profile_compute_plan: bool,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            coreml: cfg!(target_os = "macos"),
            ml_program: true,
            cache_dir: None,
            static_shape: true,
            dims: Vec::new(),
            intra_threads: 0,
            profile_compute_plan: false,
        }
    }
}

impl SessionOptions {
    /// The defaults for a manifest model installed under `dir`: its dimension overrides, static shapes unless the
    /// manifest says otherwise, and the CoreML cache in its version folder.
    pub fn for_model(entry: &ModelEntry, dir: &ModelDir) -> Self {
        Self {
            cache_dir: Some(dir.coreml_cache_dir(entry)),
            static_shape: entry.static_input,
            dims: entry.dims.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            ..Self::default()
        }
    }

    /// The same options on the CPU EP only.
    pub fn cpu(mut self) -> Self {
        self.coreml = false;
        self
    }
}

/// An input or output's name, element type and shape (`-1` for a dynamic dimension).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TensorInfo {
    pub name: String,
    pub dtype: String,
    pub shape: Vec<i64>,
}

/// What loading found out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub path: PathBuf,
    pub load_time: Duration,
    /// CoreML was asked for (on macOS).
    pub coreml_requested: bool,
    /// From ONNX Runtime's partitioning log: partitions assigned to CoreML, and supported / total nodes.
    pub coreml_partitions: Option<usize>,
    pub coreml_nodes: Option<(usize, usize)>,
    /// Operator types CoreML rejected (from the verbose `supported: [0]` lines), with counts, most frequent first.
    pub unsupported_ops: Vec<(String, usize)>,
    pub inputs: Vec<TensorInfo>,
    pub outputs: Vec<TensorInfo>,
}

impl SessionInfo {
    /// `"CoreML (1 partition, 812/812 nodes)"`, `"CPU"`, or `"CoreML requested, no partition"`.
    pub fn provider_summary(&self) -> String {
        match (self.coreml_requested, self.coreml_partitions, self.coreml_nodes) {
            (false, ..) => "CPU".to_owned(),
            (true, Some(0), _) | (true, None, _) => "CPU (CoreML took no nodes)".to_owned(),
            (true, Some(p), Some((sup, total))) => format!(
                "CoreML ({p} partition{}, {sup}/{total} nodes{})",
                if p == 1 { "" } else { "s" },
                if sup < total { ", rest on CPU" } else { "" }
            ),
            (true, Some(p), None) => format!("CoreML ({p} partitions)"),
        }
    }
}

/// An input tensor.
#[derive(Debug, Clone)]
pub enum Tensor<'a> {
    F32(ArrayViewD<'a, f32>),
    F16(ArrayViewD<'a, f16>),
    I64(ArrayViewD<'a, i64>),
}

/// Outputs by name, converted to `f32` (f16, f64 and integer outputs are cast).
#[derive(Debug, Clone, Default)]
pub struct Outputs {
    pub values: Vec<(String, ArrayD<f32>)>,
}

impl Outputs {
    pub fn get(&self, name: &str) -> Option<&ArrayD<f32>> {
        self.values.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    /// The first output.
    pub fn first(&self) -> Option<&ArrayD<f32>> {
        self.values.first().map(|(_, v)| v)
    }
}

/// A loaded model. `run` takes `&self` (the `ort` session sits behind a mutex), so a `Session` can be shared.
pub struct Session {
    inner: Mutex<ort::session::Session>,
    info: SessionInfo,
    /// Every message ONNX Runtime logged for this session while loading.
    load_log: Vec<String>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("info", &self.info).finish_non_exhaustive()
    }
}

type LogSink = Arc<Mutex<Vec<String>>>;

impl Session {
    /// Load `path` (an ONNX graph; external data files must sit next to it).
    pub fn load(path: &Path, opts: &SessionOptions) -> Result<Session> {
        if !path.is_file() {
            return Err(Error::NotInstalled(path.display().to_string()));
        }
        let start = Instant::now();
        let coreml_requested = opts.coreml && cfg!(target_os = "macos");
        let mut attempt = build(path, opts, coreml_requested);
        if coreml_requested && attempt.is_err() {
            // A process killed while Core ML compiled leaves a half-written cache that makes every later load fail
            // ("couldn't be moved ... already exists"): start the cache over, then give up on CoreML.
            let err = attempt.as_ref().err().map(ToString::to_string).unwrap_or_default();
            if let Some(dir) = &opts.cache_dir {
                log::warn!("[photobook:ai] {}: CoreML load failed ({err}); clearing its cache", path.display());
                let _ = std::fs::remove_dir_all(dir);
                attempt = build(path, opts, true);
            }
            if let Err(err) = &attempt {
                log::warn!("[photobook:ai] {}: CoreML load failed ({err}); using the CPU", path.display());
                attempt = build(path, opts, false);
            }
        }
        let (session, load_log, coreml_used) = attempt?;
        let load_time = start.elapsed();
        let (coreml_partitions, coreml_nodes) = parse_partitions(&load_log);
        let info = SessionInfo {
            path: path.to_owned(),
            load_time,
            coreml_requested: coreml_used,
            coreml_partitions: if coreml_used { coreml_partitions } else { None },
            coreml_nodes: if coreml_used { coreml_nodes } else { None },
            unsupported_ops: if coreml_used { parse_unsupported(&load_log) } else { Vec::new() },
            inputs: session.inputs().iter().map(|o| tensor_info(o.name(), o.dtype())).collect(),
            outputs: session.outputs().iter().map(|o| tensor_info(o.name(), o.dtype())).collect(),
        };
        Ok(Session { inner: Mutex::new(session), info, load_log })
    }

    /// Load a manifest model with [`SessionOptions::for_model`].
    pub fn load_model(entry: &ModelEntry, dir: &ModelDir) -> Result<Session> {
        Session::load(&dir.primary_path(entry), &SessionOptions::for_model(entry, dir))
    }

    pub fn info(&self) -> &SessionInfo {
        &self.info
    }

    /// ONNX Runtime's log lines from loading (verbose level included).
    pub fn load_log(&self) -> &[String] {
        &self.load_log
    }

    /// Log the provider summary (partitions, supported nodes, load time, inputs and outputs) once per model file
    /// per process.
    pub fn log_compute_plan(&self) {
        static SEEN: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
        let seen = SEEN.get_or_init(Mutex::default);
        if !seen.lock().expect("seen lock").insert(self.info.path.clone()) {
            return;
        }
        let name = self.info.path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        log::info!(
            "[photobook:ai] {name}: {} loaded in {} ms; inputs {}; outputs {}",
            self.info.provider_summary(),
            self.info.load_time.as_millis(),
            describe(&self.info.inputs),
            describe(&self.info.outputs)
        );
        if !self.info.unsupported_ops.is_empty() {
            let ops: Vec<String> = self.info.unsupported_ops.iter().map(|(op, n)| format!("{op}×{n}")).collect();
            log::info!("[photobook:ai] {name}: ops left on the CPU: {}", ops.join(", "));
        }
        if self.info.coreml_requested && self.info.coreml_partitions.is_none() {
            log::info!("[photobook:ai] {name}: ONNX Runtime logged no CoreML partition summary");
        }
    }

    /// Run the model. Inputs are matched by name; outputs come back in the graph's order, as `f32`.
    pub fn run(&self, inputs: &[(&str, Tensor<'_>)]) -> Result<Outputs> {
        let mut values: Vec<(String, ort::session::SessionInputValue<'_>)> = Vec::with_capacity(inputs.len());
        for (name, tensor) in inputs {
            let value = match tensor {
                Tensor::F32(a) => TensorRef::from_array_view(a.view())?.into_dyn().into(),
                Tensor::F16(a) => TensorRef::from_array_view(a.view())?.into_dyn().into(),
                Tensor::I64(a) => TensorRef::from_array_view(a.view())?.into_dyn().into(),
            };
            values.push(((*name).to_owned(), value));
        }
        let mut session = self.inner.lock().map_err(|_| Error::Runtime("session poisoned".into()))?;
        let outputs = session.run(values)?;
        let mut out = Outputs::default();
        for (name, value) in outputs.iter() {
            out.values.push((name.to_owned(), to_f32(&value)?));
        }
        Ok(out)
    }

    /// Run `runs` times on zero inputs of the static shapes (dynamic dimensions taken as 1) and return the last
    /// run's time. CoreML's first run or two are slow (specialisation); call this right after loading.
    pub fn warm_up(&self, runs: usize) -> Result<Duration> {
        let arrays: Vec<(String, Zeros)> = self
            .info
            .inputs
            .iter()
            .map(|i| {
                let shape: Vec<usize> = i.shape.iter().map(|&d| if d > 0 { d as usize } else { 1 }).collect();
                let zeros = match i.dtype.as_str() {
                    "f16" => Zeros::F16(ArrayD::from_elem(IxDyn(&shape), f16::ZERO)),
                    "i64" => Zeros::I64(ArrayD::zeros(IxDyn(&shape))),
                    _ => Zeros::F32(ArrayD::zeros(IxDyn(&shape))),
                };
                (i.name.clone(), zeros)
            })
            .collect();
        let inputs: Vec<(&str, Tensor<'_>)> = arrays.iter().map(|(n, z)| (n.as_str(), z.view())).collect();
        let mut last = Duration::ZERO;
        for _ in 0..runs.max(1) {
            let t = Instant::now();
            self.run(&inputs)?;
            last = t.elapsed();
        }
        Ok(last)
    }
}

/// Build one `ort` session; returns it with the log ONNX Runtime wrote while loading and whether CoreML was asked.
fn build(path: &Path, opts: &SessionOptions, coreml: bool) -> Result<(ort::session::Session, Vec<String>, bool)> {
    let sink: LogSink = Arc::default();
    let logger_sink = sink.clone();
    let threads = match opts.intra_threads {
        0 => std::thread::available_parallelism().map_or(4, |n| n.get()).min(8),
        n => n,
    };
    let mut builder = ort::session::Session::builder()?
        .with_logger(Arc::new(move |level: LogLevel, _category: &str, _id: &str, _loc: &str, message: &str| {
            forward_log(level, message);
            if let Ok(mut lines) = logger_sink.lock() {
                lines.push(message.to_owned());
            }
        }))?
        // Verbose while loading: CoreML's per-node support is logged at that level. Lines are kept in memory, not
        // printed (forward_log drops verbose ones).
        .with_log_level(LogLevel::Verbose)?
        .with_optimization_level(GraphOptimizationLevel::Level1)?
        .with_intra_threads(threads)?;
    for (name, size) in &opts.dims {
        builder = builder.with_dimension_override(name, *size)?;
    }
    if coreml {
        let format =
            if opts.ml_program { ep::coreml::ModelFormat::MLProgram } else { ep::coreml::ModelFormat::NeuralNetwork };
        let mut ep = ep::CoreML::default()
            .with_model_format(format)
            .with_compute_units(ep::coreml::ComputeUnits::All)
            .with_static_input_shapes(opts.static_shape)
            .with_profile_compute_plan(opts.profile_compute_plan);
        if let Some(dir) = &opts.cache_dir {
            std::fs::create_dir_all(dir)?;
            ep = ep.with_model_cache_dir(dir.display());
        }
        // No `error_on_failure`: if CoreML cannot be registered, ONNX Runtime continues on the CPU EP.
        builder = builder.with_execution_providers([ep.build()])?;
    }
    let session = builder.commit_from_file(path)?;
    let log = std::mem::take(&mut *sink.lock().expect("log sink"));
    Ok((session, log, coreml))
}

enum Zeros {
    F32(ArrayD<f32>),
    F16(ArrayD<f16>),
    I64(ArrayD<i64>),
}

impl Zeros {
    fn view(&self) -> Tensor<'_> {
        match self {
            Zeros::F32(a) => Tensor::F32(a.view()),
            Zeros::F16(a) => Tensor::F16(a.view()),
            Zeros::I64(a) => Tensor::I64(a.view()),
        }
    }
}

fn to_f32(value: &DynValue) -> Result<ArrayD<f32>> {
    let ty = value.dtype().tensor_type();
    Ok(match ty {
        Some(TensorElementType::Float32) => value.try_extract_array::<f32>()?.to_owned(),
        Some(TensorElementType::Float16) => value.try_extract_array::<f16>()?.mapv(f32::from),
        Some(TensorElementType::Float64) => value.try_extract_array::<f64>()?.mapv(|v| v as f32),
        Some(TensorElementType::Int64) => value.try_extract_array::<i64>()?.mapv(|v| v as f32),
        Some(TensorElementType::Int32) => value.try_extract_array::<i32>()?.mapv(|v| v as f32),
        Some(TensorElementType::Uint8) => value.try_extract_array::<u8>()?.mapv(f32::from),
        Some(TensorElementType::Bool) => value.try_extract_array::<bool>()?.mapv(|v| if v { 1.0 } else { 0.0 }),
        other => return Err(Error::Runtime(format!("unsupported output type {other:?}"))),
    })
}

fn tensor_info(name: &str, ty: &ValueType) -> TensorInfo {
    let dtype = match ty.tensor_type() {
        Some(TensorElementType::Float32) => "f32",
        Some(TensorElementType::Float16) => "f16",
        Some(TensorElementType::Int64) => "i64",
        Some(TensorElementType::Int32) => "i32",
        Some(TensorElementType::Uint8) => "u8",
        Some(TensorElementType::Bool) => "bool",
        Some(_) => "other",
        None => "non-tensor",
    };
    TensorInfo {
        name: name.to_owned(),
        dtype: dtype.to_owned(),
        shape: ty.tensor_shape().map(|s| s.iter().copied().collect()).unwrap_or_default(),
    }
}

fn describe(list: &[TensorInfo]) -> String {
    list.iter().map(|t| format!("{} {}{:?}", t.name, t.dtype, t.shape)).collect::<Vec<_>>().join(", ")
}

/// ONNX Runtime's own messages: warnings and errors go to `log`; info is kept at debug (it is chatty); verbose is
/// only captured.
fn forward_log(level: LogLevel, message: &str) {
    match level {
        LogLevel::Fatal | LogLevel::Error => log::error!("[photobook:ai] ort: {message}"),
        LogLevel::Warning => log::warn!("[photobook:ai] ort: {message}"),
        LogLevel::Info => log::debug!("[photobook:ai] ort: {message}"),
        LogLevel::Verbose => {}
    }
}

/// Find `number of partitions supported by CoreML: N number of nodes in the graph: T number of nodes supported by
/// CoreML: S` in the load log. With several lines (subgraphs, or capability passes), the last one wins.
pub(crate) fn parse_partitions(lines: &[String]) -> (Option<usize>, Option<(usize, usize)>) {
    let number_after = |line: &str, key: &str| -> Option<usize> {
        let rest = &line[line.find(key)? + key.len()..];
        rest.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
    };
    let mut partitions = None;
    let mut nodes = None;
    for line in lines {
        if let Some(p) = number_after(line, "number of partitions supported by CoreML:") {
            partitions = Some(p);
            let total = number_after(line, "number of nodes in the graph:");
            let supported = number_after(line, "number of nodes supported by CoreML:");
            nodes = supported.zip(total);
        }
    }
    (partitions, nodes)
}

/// Count operator types from ONNX Runtime's verbose `Operator type: [Op] index: [i] name: [n] supported: [0]` lines.
pub(crate) fn parse_unsupported(lines: &[String]) -> Vec<(String, usize)> {
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for line in lines {
        if !line.contains("supported: [0]") {
            continue;
        }
        let Some(rest) = line.split("Operator type: [").nth(1) else { continue };
        if let Some(op) = rest.split(']').next() {
            *counts.entry(op.to_owned()).or_default() += 1;
        }
    }
    let mut list: Vec<(String, usize)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_partition_summary() {
        let lines = vec![
            "something else".to_owned(),
            "CoreMLExecutionProvider::GetCapability, number of partitions supported by CoreML: 3 number of nodes in \
             the graph: 120 number of nodes supported by CoreML: 117"
                .to_owned(),
        ];
        assert_eq!(parse_partitions(&lines), (Some(3), Some((117, 120))));
        assert_eq!(parse_partitions(&[]), (None, None));
        let ops = vec![
            "Operator type: [Erf] index: [3] name: [a] supported: [0]".to_owned(),
            "Operator type: [Conv] index: [4] name: [b] supported: [1]".to_owned(),
            "Operator type: [Erf] index: [9] name: [c] supported: [0]".to_owned(),
            "Operator type: [Cast] index: [10] name: [d] supported: [0]".to_owned(),
        ];
        assert_eq!(parse_unsupported(&ops), vec![("Erf".to_owned(), 2), ("Cast".to_owned(), 1)]);
        let info = SessionInfo {
            path: PathBuf::new(),
            load_time: Duration::ZERO,
            coreml_requested: true,
            coreml_partitions: Some(1),
            coreml_nodes: Some((10, 10)),
            unsupported_ops: vec![],
            inputs: vec![],
            outputs: vec![],
        };
        assert_eq!(info.provider_summary(), "CoreML (1 partition, 10/10 nodes)");
    }

    #[test]
    fn missing_model_is_not_installed() {
        let err = Session::load(Path::new("/nonexistent/model.onnx"), &SessionOptions::default()).unwrap_err();
        assert!(matches!(err, Error::NotInstalled(_)));
    }
}
