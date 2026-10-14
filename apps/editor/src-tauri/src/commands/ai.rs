//! Settings → AI and the AI commands (workflow plan 32).
//!
//! The key lives in `<appdata>/ai.env` (dotenv style, owner read/write only, written like `publish.env`) and is read
//! from disk on every call. It never goes into the project file, the library or the webview: `read_ai_settings`
//! returns whether there is one and its last four characters. The webview sends photo refs (content hash and
//! develop hash, resolved to the cached 1600 px proxy here) or a page render's path, never image bytes; the images
//! are downscaled to 768 px and sent from Rust (`crate::ai`).
//!
//! Long requests (`ai_describe`, `ai_caption`) take a job number; `ai_cancel(job)` stops them mid-request or between
//! retries, and they resolve `{ status: "cancelled" }`. A refusal resolves `{ status: "refused", message, reason }`;
//! other failures reject with a readable message.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::ai::anthropic::Anthropic;
use crate::ai::image::load_downscaled;
use crate::ai::provider::{CaptionOptions, DescribeOptions, Provider};
use crate::ai::{
    self, AiError, CancelToken, CaptionPrompt, Captions, DescribeEntry, Effort, PreparedImage, Reply, ReplyMeta,
};
use crate::atomic::write_secret;
use crate::commands::assets::{cache_entry_dir, cache_root, PROXY_FILE};
use crate::commands::develop::PendingCancels;
use crate::commands::publish::parse_env;
use crate::error::{Error, Result};
use crate::scope;

pub const SETTINGS_FILE_NAME: &str = "ai.env";
const PROVIDER_VAR: &str = "AI_PROVIDER";
const MODEL_VAR: &str = "AI_MODEL";
const INDEX_MODEL_VAR: &str = "AI_INDEX_MODEL";
const KEY_VAR: &str = "ANTHROPIC_API_KEY";
pub const PROVIDERS: &[&str] = &["anthropic"];
/// Images in one request (the index sends 8; a page has a handful).
const MAX_IMAGES: usize = 20;
const MIN_EDGE: u32 = 256;
const MAX_EDGE: u32 = 1600;
const NO_KEY: &str = "No Anthropic API key yet. Paste one in Settings → AI and press Save.";

// ---------------------------------------------------------------------------------------------
// Settings

/// What the webview sees of `ai.env`: never the key itself.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    /// Default model for captions.
    pub model: String,
    /// Default model for the photo index.
    pub index_model: String,
    pub has_key: bool,
    /// `…` and the key's last four characters, to tell keys apart.
    pub key_hint: Option<String>,
}

/// A change to the settings; absent fields are kept. `key: ""` removes the key.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsUpdate {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub index_model: Option<String>,
    pub key: Option<String>,
}

fn settings_file(app_data: &Path) -> PathBuf {
    app_data.join(SETTINGS_FILE_NAME)
}

pub(crate) fn read_env(app_data: &Path) -> Result<BTreeMap<String, String>> {
    let path = settings_file(app_data);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(parse_env(&text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(err) => Err(Error::Io(format!("reading {}", path.display()), err)),
    }
}

fn settings_of(env: &BTreeMap<String, String>) -> AiSettings {
    let pick = |var: &str, default: &str| {
        env.get(var).filter(|m| ai::is_model(m)).cloned().unwrap_or_else(|| default.to_string())
    };
    let key = env.get(KEY_VAR).filter(|k| !k.is_empty());
    AiSettings {
        provider: env.get(PROVIDER_VAR).filter(|p| PROVIDERS.contains(&p.as_str())).cloned().unwrap_or("anthropic".into()),
        model: pick(MODEL_VAR, ai::DEFAULT_MODEL),
        index_model: pick(INDEX_MODEL_VAR, ai::DEFAULT_INDEX_MODEL),
        has_key: key.is_some(),
        key_hint: key.map(|k| format!("…{}", k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect::<String>())),
    }
}

fn serialize_env(values: &BTreeMap<String, String>) -> String {
    let mut text = String::from("# Photobook AI settings (Settings → AI). Holds the API key: keep it private.\n");
    for (key, value) in values.iter().filter(|(_, v)| !v.is_empty()) {
        text.push_str(&format!("{key}={value}\n"));
    }
    text
}

/// Apply `update` to `<app_data>/ai.env` (atomic, owner-only) and return the new settings.
pub(crate) fn write_settings(app_data: &Path, update: AiSettingsUpdate) -> Result<AiSettings> {
    let mut env = read_env(app_data)?;
    if let Some(provider) = update.provider {
        if !PROVIDERS.contains(&provider.as_str()) {
            return Err(Error::Invalid(format!("Unknown AI provider {provider}")));
        }
        env.insert(PROVIDER_VAR.into(), provider);
    }
    for (var, model) in [(MODEL_VAR, update.model), (INDEX_MODEL_VAR, update.index_model)] {
        if let Some(model) = model {
            if !ai::is_model(&model) {
                return Err(Error::Invalid(format!("Unknown model {model}")));
            }
            env.insert(var.into(), model);
        }
    }
    if let Some(key) = update.key {
        let key = key.trim();
        if key.is_empty() {
            env.remove(KEY_VAR);
        } else if !key.chars().all(|c| c.is_ascii_graphic()) || key.contains(['"', '\'', '#']) {
            return Err(Error::Invalid("That does not look like an API key (it has spaces or quotes)".into()));
        } else {
            env.insert(KEY_VAR.into(), key.to_string());
        }
    }
    // The file holds a secret: created owner read and write only.
    write_secret(&settings_file(app_data), serialize_env(&env).as_bytes())?;
    Ok(settings_of(&env))
}

/// The stored key, or the "add a key" error.
pub(crate) fn api_key(app_data: &Path) -> Result<String> {
    read_env(app_data)?.remove(KEY_VAR).filter(|k| !k.is_empty()).ok_or_else(|| Error::Invalid(NO_KEY.into()))
}

#[tauri::command]
pub async fn read_ai_settings<R: Runtime>(app: AppHandle<R>) -> Result<AiSettings> {
    Ok(settings_of(&read_env(&scope::app_data_dir(&app)?)?))
}

#[tauri::command]
pub async fn write_ai_settings<R: Runtime>(app: AppHandle<R>, update: AiSettingsUpdate) -> Result<AiSettings> {
    write_settings(&scope::app_data_dir(&app)?, update)
}

// ---------------------------------------------------------------------------------------------
// Jobs

/// Running AI requests by job number, and cancels that came before their request started.
#[derive(Default)]
pub struct AiJobs {
    running: Mutex<HashMap<u64, CancelToken>>,
    pending: PendingCancels,
}

impl AiJobs {
    fn start(&self, job: u64) -> CancelToken {
        let mut running = self.running.lock().expect("ai lock poisoned");
        let token = if self.pending.take(job) { CancelToken::cancelled_already() } else { CancelToken::default() };
        running.insert(job, token.clone());
        token
    }

    fn finish(&self, job: u64) {
        self.running.lock().expect("ai lock poisoned").remove(&job);
    }

    fn cancel(&self, job: u64) -> bool {
        let running = self.running.lock().expect("ai lock poisoned");
        match running.get(&job) {
            Some(token) => {
                token.cancel();
                true
            }
            None => {
                self.pending.remember(job);
                false
            }
        }
    }
}

/// Stop the AI request `job` now (it resolves `{ status: "cancelled" }`). False when it has not started yet; it is then
/// cancelled as soon as it does.
#[tauri::command]
pub async fn ai_cancel<R: Runtime>(app: AppHandle<R>, job: u64) -> Result<bool> {
    Ok(app.state::<AiJobs>().cancel(job))
}

// ---------------------------------------------------------------------------------------------
// Requests

/// An image to send. `id` comes back on the answer and is never sent; `label` is the text placed before the image
/// (`ai_caption` only; `ai_describe` labels them `Photo N` so no names or paths leave the machine).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiImageRef {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub source: AiImageSource,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AiImageSource {
    /// A photo by content hash: `<appdata>/cache/<hash>/proxy-<developHash>.jpg` when that render exists, else the
    /// plain `proxy.jpg`.
    Photo { hash: String, develop_hash: Option<String> },
    /// An image file (a page render), inside an imported folder or app data.
    File { path: String },
}

/// The answer of an AI request, or why there is none. A refusal is an answer, not an error.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AiOutcome<T> {
    Ok {
        #[serde(flatten)]
        value: T,
        /// `model`, `servedBy`, `fellBack`, `usage` (billed, every attempt), `attempts` (per model, for pricing).
        #[serde(flatten)]
        meta: ReplyMeta,
    },
    Refused {
        /// "The model declined this page: <reason>", ready to show.
        message: String,
        reason: String,
        category: Option<String>,
        #[serde(flatten)]
        meta: ReplyMeta,
    },
    Cancelled,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiDescribed {
    /// In ref order; a photo the model skipped is absent.
    pub entries: Vec<DescribeEntry>,
    /// Ids of refs with no cached proxy (not sent): prepare them and ask again.
    pub missing: Vec<String>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiRequestOptions {
    /// One of the offered models; the settings' default for the command when absent.
    pub model: Option<String>,
    pub effort: Option<Effort>,
    /// Long edge of the images sent, 256 to 1600 (768 when absent).
    pub max_edge: Option<u32>,
    /// Output limit of a caption request (thinking included), 1,024 to 16,000; 16,000 when absent (plan 35).
    pub max_tokens: Option<u32>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiCaptionRequest {
    pub images: Vec<AiImageRef>,
    #[serde(flatten)]
    pub prompt: CaptionPrompt,
    #[serde(default)]
    pub options: AiRequestOptions,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiTokenCount {
    pub model: String,
    pub input_tokens: u64,
}

fn is_hex_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The file behind `source`; `None` when a photo has no cached proxy yet.
pub(crate) fn resolve_source(
    cache: &Path,
    source: &AiImageSource,
    allow: &dyn Fn(&Path) -> Result<PathBuf>,
) -> Result<Option<PathBuf>> {
    match source {
        AiImageSource::Photo { hash, develop_hash } => {
            let dir = cache_entry_dir(cache, hash)?;
            if let Some(dh) = develop_hash.as_deref().filter(|dh| is_hex_hash(dh)) {
                let developed = dir.join(format!("proxy-{dh}.jpg"));
                if developed.is_file() {
                    return Ok(Some(developed));
                }
            }
            let proxy = dir.join(PROXY_FILE);
            Ok(proxy.is_file().then_some(proxy))
        }
        AiImageSource::File { path } => {
            let path = allow(Path::new(path))?;
            if path.is_file() {
                Ok(Some(path))
            } else {
                Err(Error::Invalid(format!("{} does not exist", path.display())))
            }
        }
    }
}

/// Load and downscale every ref. `label(i, ref)` is the text before image `i` (of those found). Returns the images and
/// the ids of the photos without a proxy.
pub(crate) fn prepare_images(
    refs: &[AiImageRef],
    cache: &Path,
    edge: u32,
    allow: &dyn Fn(&Path) -> Result<PathBuf>,
    label: &dyn Fn(usize, &AiImageRef) -> String,
) -> Result<(Vec<PreparedImage>, Vec<String>)> {
    if refs.len() > MAX_IMAGES {
        return Err(Error::Invalid(format!("At most {MAX_IMAGES} images per request ({} given)", refs.len())));
    }
    let mut images = Vec::new();
    let mut missing = Vec::new();
    for r in refs {
        match resolve_source(cache, &r.source, allow)? {
            Some(path) => {
                let (jpeg, width, height) = load_downscaled(&path, edge)?;
                let label = label(images.len(), r);
                images.push(PreparedImage { id: r.id.clone(), label, jpeg, width, height });
            }
            None => missing.push(r.id.clone()),
        }
    }
    Ok((images, missing))
}

/// Bounds of a caller's caption output limit (`AiRequestOptions::max_tokens`).
const MIN_OUTPUT_TOKENS: u32 = 1024;
const MAX_OUTPUT_TOKENS: u32 = 16_000;

fn edge_of(options: &AiRequestOptions) -> u32 {
    options.max_edge.unwrap_or(ai::DEFAULT_IMAGE_EDGE).clamp(MIN_EDGE, MAX_EDGE)
}

fn model_of(options: &AiRequestOptions, default: &str) -> Result<String> {
    let model = options.model.clone().unwrap_or_else(|| default.to_string());
    if ai::is_model(&model) {
        Ok(model)
    } else {
        Err(Error::Invalid(format!("Unknown model {model}")))
    }
}

/// A provider reply as the command's outcome; `what` completes "The model declined …".
pub(crate) fn outcome<T, U>(
    result: std::result::Result<Reply<T>, AiError>,
    what: &str,
    map: impl FnOnce(T) -> U,
) -> Result<AiOutcome<U>> {
    match result {
        Ok(Reply::Ok { value, meta }) => Ok(AiOutcome::Ok { value: map(value), meta }),
        Ok(Reply::Refused { reason, category, meta }) => Ok(AiOutcome::Refused {
            message: format!("The model declined {what}: {reason}"),
            reason,
            category,
            meta,
        }),
        Err(AiError::Cancelled) => Ok(AiOutcome::Cancelled),
        Err(AiError::Message(message)) => Err(Error::Invalid(message)),
    }
}

/// Describe photos for the index: `{ status: "ok", entries, missing, model, usage }` (entries in ref order). Images go
/// as `Photo 1…N` at the request's long edge, effort `low` and the index model unless `options` say otherwise.
pub(crate) async fn describe<P: Provider>(
    provider: &P,
    images: Vec<PreparedImage>,
    missing: Vec<String>,
    options: DescribeOptions,
    cancel: &CancelToken,
) -> Result<AiOutcome<AiDescribed>> {
    if images.is_empty() {
        return Err(Error::Invalid("None of these photos has a preview yet; open them in the library first".into()));
    }
    let result = provider.describe_photos(&images, &options, cancel).await;
    outcome(result, "these photos", |d| AiDescribed { entries: d.entries, missing })
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| Error::Invalid(format!("AI image preparation failed: {e}")))?
}

fn allow_for<R: Runtime>(app: &AppHandle<R>) -> Result<impl Fn(&Path) -> Result<PathBuf> + Send + 'static> {
    let roots = app.state::<scope::ImportedRoots>().roots();
    let app_data = scope::app_data_dir(app)?;
    Ok(move |path: &Path| scope::check_allowed(path, &roots, &app_data))
}

/// Plan 33: describe up to 20 photos (send 8) in one request. See [`describe`].
#[tauri::command]
pub async fn ai_describe<R: Runtime>(
    app: AppHandle<R>,
    refs: Vec<AiImageRef>,
    options: Option<AiRequestOptions>,
    job: u64,
) -> Result<AiOutcome<AiDescribed>> {
    let token = app.state::<AiJobs>().start(job);
    let work = async {
        let app_data = scope::app_data_dir(&app)?;
        let settings = settings_of(&read_env(&app_data)?);
        let key = api_key(&app_data)?;
        let options = options.unwrap_or_default();
        let model = model_of(&options, &settings.index_model)?;
        let effort = options.effort.unwrap_or(Effort::Low);
        let (cache, edge, allow) = (cache_root(&app)?, edge_of(&options), allow_for(&app)?);
        let (images, missing) = blocking(move || {
            prepare_images(&refs, &cache, edge, &allow, &|i, _| format!("Photo {}", i + 1))
        })
        .await?;
        if token.is_cancelled() {
            return Ok(AiOutcome::Cancelled);
        }
        let provider = Anthropic::new(key).map_err(|e| Error::Invalid(e.to_string()))?;
        describe(&provider, images, missing, DescribeOptions { model, effort }, &token).await
    };
    let result = work.await;
    app.state::<AiJobs>().finish(job);
    result
}

/// Plans 34 and 35: captions for a page from its render (or its photos) and the cached system text (style sheet,
/// brief, photo index). `{ status: "ok", captions: [{ target, text, alt }], model, usage }`; a refusal resolves
/// `{ status: "refused", message: "The model declined this page: <reason>", … }`.
#[tauri::command]
pub async fn ai_caption<R: Runtime>(app: AppHandle<R>, request: AiCaptionRequest, job: u64) -> Result<AiOutcome<Captions>> {
    let token = app.state::<AiJobs>().start(job);
    let work = async {
        let app_data = scope::app_data_dir(&app)?;
        let settings = settings_of(&read_env(&app_data)?);
        let key = api_key(&app_data)?;
        let AiCaptionRequest { images: refs, prompt, options } = request;
        if prompt.prompt.trim().is_empty() {
            return Err(Error::Invalid("The caption request has no prompt".into()));
        }
        let model = model_of(&options, &settings.model)?;
        let effort = options.effort.unwrap_or(Effort::Medium);
        let (cache, edge, allow) = (cache_root(&app)?, edge_of(&options), allow_for(&app)?);
        let (images, missing) = blocking(move || {
            prepare_images(&refs, &cache, edge, &allow, &|i, r| {
                r.label.clone().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| format!("Image {}", i + 1))
            })
        })
        .await?;
        if let Some(id) = missing.first() {
            return Err(Error::Invalid(format!("No preview yet for {id}; open the photo once and try again")));
        }
        if token.is_cancelled() {
            return Ok(AiOutcome::Cancelled);
        }
        let provider = Anthropic::new(key).map_err(|e| Error::Invalid(e.to_string()))?;
        let max_tokens = options.max_tokens.map(|n| n.clamp(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS));
        let result =
            provider.caption_page(&images, &prompt, &CaptionOptions { model, effort, max_tokens }, &token).await;
        outcome(result, "this page", |c| c)
    };
    let result = work.await;
    app.state::<AiJobs>().finish(job);
    result
}

/// Input tokens of `text` (and `system`) on `model` (the caption model by default). Free; the Book dialog uses it for
/// the text part of its estimate.
#[tauri::command]
pub async fn ai_count_tokens<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    system: Option<String>,
    model: Option<String>,
) -> Result<AiTokenCount> {
    let app_data = scope::app_data_dir(&app)?;
    let settings = settings_of(&read_env(&app_data)?);
    let key = api_key(&app_data)?;
    let model = model_of(&AiRequestOptions { model, ..Default::default() }, &settings.model)?;
    let provider = Anthropic::new(key).map_err(|e| Error::Invalid(e.to_string()))?;
    count(&provider, &model, system.as_deref(), &text).await
}

/// Settings → AI's Test button: counts the tokens of a short text with the stored key and model, so it proves the key
/// works without paying for a message.
#[tauri::command]
pub async fn ai_test<R: Runtime>(app: AppHandle<R>) -> Result<AiTokenCount> {
    let app_data = scope::app_data_dir(&app)?;
    let settings = settings_of(&read_env(&app_data)?);
    let key = api_key(&app_data)?;
    let provider = Anthropic::new(key).map_err(|e| Error::Invalid(e.to_string()))?;
    count(&provider, &settings.model, None, "Photobook key check").await
}

pub(crate) async fn count<P: Provider>(
    provider: &P,
    model: &str,
    system: Option<&str>,
    text: &str,
) -> Result<AiTokenCount> {
    let input_tokens = provider
        .count_tokens(model, system, text, &CancelToken::default())
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(AiTokenCount { model: model.to_string(), input_tokens })
}

// ---------------------------------------------------------------------------------------------
// Capture time and place (workflow plan 34): the caption brief's "Where and when?" is pre-filled from the photos'
// Exif. Read on demand (the brief dialog opens once per project), not stored: nothing here is sent anywhere.

/// Photos read per call.
const MAX_CAPTURE_PATHS: usize = 1000;

/// When and where one photo was taken.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    /// Relative path as given.
    pub path: String,
    /// `DateTimeOriginal` (else `DateTime`) as local time `YYYY-MM-DDTHH:MM:SS`; Exif has no zone.
    pub taken: Option<String>,
    /// Decimal degrees, north positive.
    pub lat: Option<f64>,
    /// Decimal degrees, east positive.
    pub lon: Option<f64>,
}

fn exif_taken(exif: &exif::Exif) -> Option<String> {
    [exif::Tag::DateTimeOriginal, exif::Tag::DateTime].iter().find_map(|tag| {
        let field = exif.get_field(*tag, exif::In::PRIMARY)?;
        let exif::Value::Ascii(parts) = &field.value else { return None };
        let dt = exif::DateTime::from_ascii(parts.first()?).ok()?;
        (dt.year >= 1900 && (1..=12).contains(&dt.month) && (1..=31).contains(&dt.day)).then(|| {
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
                dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second
            )
        })
    })
}

/// Degrees, minutes and seconds with their N/S or E/W reference as signed decimal degrees.
fn exif_coordinate(exif: &exif::Exif, tag: exif::Tag, reference: exif::Tag, negative: u8, limit: f64) -> Option<f64> {
    let exif::Value::Rational(dms) = &exif.get_field(tag, exif::In::PRIMARY)?.value else { return None };
    let part = |i: usize| dms.get(i).filter(|r| r.denom != 0).map(|r| r.to_f64());
    let degrees = part(0)? + part(1).unwrap_or(0.0) / 60.0 + part(2).unwrap_or(0.0) / 3600.0;
    let sign = match &exif.get_field(reference, exif::In::PRIMARY)?.value {
        exif::Value::Ascii(parts) if parts.first().and_then(|p| p.first()).map(u8::to_ascii_uppercase) == Some(negative) => -1.0,
        exif::Value::Ascii(_) => 1.0,
        _ => return None,
    };
    let value = sign * degrees;
    (value.is_finite() && value.abs() <= limit).then_some(value)
}

/// What the Exif of `file` says about when and where it was taken (all `None` when it has no Exif).
pub(crate) fn capture_of(file: &Path, path: String) -> CaptureInfo {
    let read = std::fs::File::open(file)
        .ok()
        .and_then(|f| exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)).ok());
    let Some(exif) = read else { return CaptureInfo { path, ..Default::default() } };
    let lat = exif_coordinate(&exif, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, b'S', 90.0);
    let lon = exif_coordinate(&exif, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, b'W', 180.0);
    let (lat, lon) = match (lat, lon) {
        (Some(lat), Some(lon)) => (Some(lat), Some(lon)),
        _ => (None, None),
    };
    CaptureInfo { path, taken: exif_taken(&exif), lat, lon }
}

/// Plan 34: capture time and GPS position of `paths` (relative to the imported folder `folder`), from their Exif.
/// A file outside the folder is refused; one that cannot be read comes back with nothing known.
#[tauri::command]
pub async fn photo_capture_info<R: Runtime>(app: AppHandle<R>, folder: String, paths: Vec<String>) -> Result<Vec<CaptureInfo>> {
    let root = scope::ensure_imported_root(&app, &folder)?;
    if paths.len() > MAX_CAPTURE_PATHS {
        return Err(Error::Invalid(format!("At most {MAX_CAPTURE_PATHS} photos per call ({} given)", paths.len())));
    }
    blocking(move || {
        paths
            .into_iter()
            .map(|rel| {
                let file = scope::normalize(&root.join(&rel))?;
                if !scope::is_within(&file, &root) {
                    return Err(Error::OutOfScope(file.display().to_string()));
                }
                Ok(capture_of(&file, rel))
            })
            .collect()
    })
    .await
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    use exif::experimental::Writer;
    use exif::{Field, In, Rational, Tag, Value};

    fn ascii(tag: Tag, text: &str) -> Field {
        Field { tag, ifd_num: In::PRIMARY, value: Value::Ascii(vec![text.as_bytes().to_vec()]) }
    }

    fn dms(tag: Tag, d: u32, m: u32, s100: u32) -> Field {
        let value = vec![Rational { num: d, denom: 1 }, Rational { num: m, denom: 1 }, Rational { num: s100, denom: 100 }];
        Field { tag, ifd_num: In::PRIMARY, value: Value::Rational(value) }
    }

    /// A JPEG holding only an Exif APP1 segment with `fields`.
    fn jpeg_with(fields: &[Field]) -> Vec<u8> {
        let mut writer = Writer::new();
        for field in fields {
            writer.push_field(field);
        }
        let mut tiff = std::io::Cursor::new(Vec::new());
        writer.write(&mut tiff, false).unwrap();
        let tiff = tiff.into_inner();
        let len = (2 + 6 + tiff.len()) as u16;
        [&[0xFF, 0xD8, 0xFF, 0xE1][..], &len.to_be_bytes(), b"Exif\0\0", &tiff, &[0xFF, 0xD9]].concat()
    }

    #[test]
    fn reads_capture_time_and_signed_gps() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tram.jpg");
        std::fs::write(
            &file,
            jpeg_with(&[
                ascii(Tag::DateTimeOriginal, "2026:06:03 09:12:05"),
                dms(Tag::GPSLatitude, 38, 42, 3600),
                ascii(Tag::GPSLatitudeRef, "N"),
                dms(Tag::GPSLongitude, 9, 8, 2400),
                ascii(Tag::GPSLongitudeRef, "W"),
            ]),
        )
        .unwrap();
        let info = capture_of(&file, "tram.jpg".into());
        assert_eq!(info.taken.as_deref(), Some("2026-06-03T09:12:05"));
        assert!((info.lat.unwrap() - 38.71).abs() < 1e-9, "{:?}", info.lat);
        assert!((info.lon.unwrap() + 9.14).abs() < 1e-9, "{:?}", info.lon);
    }

    #[test]
    fn a_file_without_exif_or_with_half_a_position_knows_nothing_of_it() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.jpg");
        std::fs::write(&plain, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
        assert_eq!(capture_of(&plain, "plain.jpg".into()), CaptureInfo { path: "plain.jpg".into(), ..Default::default() });
        assert_eq!(capture_of(&dir.path().join("gone.jpg"), "gone.jpg".into()).taken, None);
        let half = dir.path().join("half.jpg");
        std::fs::write(
            &half,
            jpeg_with(&[ascii(Tag::DateTime, "2025:12:30 23:59:59"), dms(Tag::GPSLatitude, 1, 0, 0), ascii(Tag::GPSLatitudeRef, "S")]),
        )
        .unwrap();
        let info = capture_of(&half, "half.jpg".into());
        assert_eq!(info.taken.as_deref(), Some("2025-12-30T23:59:59"));
        assert_eq!((info.lat, info.lon), (None, None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::anthropic::RetryPolicy;
    use serde_json::json;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const KEY: &str = "sk-ant-api03-SECRET-photobook-test-key-7f3a";

    fn update(key: Option<&str>) -> AiSettingsUpdate {
        AiSettingsUpdate { key: key.map(str::to_string), ..Default::default() }
    }

    #[test]
    fn settings_round_trip_without_exposing_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = settings_of(&read_env(dir.path()).unwrap());
        assert_eq!(fresh.model, "claude-opus-5-5");
        assert_eq!(fresh.index_model, "claude-haiku-5-5");
        assert!(!fresh.has_key);
        assert_eq!(api_key(dir.path()).unwrap_err().to_string(), NO_KEY);

        let saved = write_settings(
            dir.path(),
            AiSettingsUpdate { key: Some(format!("  {KEY}\n")), model: Some("claude-sonnet-5-5".into()), ..Default::default() },
        )
        .unwrap();
        assert!(saved.has_key);
        assert_eq!(saved.key_hint.as_deref(), Some("…7f3a"));
        assert_eq!(saved.model, "claude-sonnet-5-5");
        assert!(!serde_json::to_string(&saved).unwrap().contains(KEY));
        assert_eq!(api_key(dir.path()).unwrap(), KEY);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(SETTINGS_FILE_NAME)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Absent fields are kept; an empty key removes it.
        let kept = write_settings(dir.path(), AiSettingsUpdate { index_model: Some("claude-opus-5-5".into()), ..Default::default() }).unwrap();
        assert!(kept.has_key);
        assert_eq!(kept.model, "claude-sonnet-5-5");
        assert!(write_settings(dir.path(), AiSettingsUpdate { model: Some("gpt-4".into()), ..Default::default() }).is_err());
        assert!(write_settings(dir.path(), update(Some("two words"))).is_err());
        assert!(write_settings(dir.path(), update(Some("sk-ant-é"))).is_err());
        let removed = write_settings(dir.path(), update(Some(""))).unwrap();
        assert!(!removed.has_key);
        assert!(!std::fs::read_to_string(dir.path().join(SETTINGS_FILE_NAME)).unwrap().contains(KEY));
    }

    #[test]
    fn photos_resolve_to_the_developed_proxy_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let hash = "a".repeat(64);
        let dh = "b".repeat(64);
        let entry = dir.path().join(&hash);
        std::fs::create_dir_all(&entry).unwrap();
        let deny = |p: &Path| -> Result<PathBuf> { Err(Error::OutOfScope(p.display().to_string())) };
        let photo = |dh: Option<&str>| AiImageSource::Photo { hash: hash.clone(), develop_hash: dh.map(str::to_string) };
        assert_eq!(resolve_source(dir.path(), &photo(None), &deny).unwrap(), None);
        std::fs::write(entry.join(PROXY_FILE), b"x").unwrap();
        assert_eq!(resolve_source(dir.path(), &photo(Some(&dh)), &deny).unwrap(), Some(entry.join(PROXY_FILE)));
        std::fs::write(entry.join(format!("proxy-{dh}.jpg")), b"x").unwrap();
        assert_eq!(resolve_source(dir.path(), &photo(Some(&dh)), &deny).unwrap(), Some(entry.join(format!("proxy-{dh}.jpg"))));
        assert!(resolve_source(dir.path(), &AiImageSource::Photo { hash: "../x".into(), develop_hash: None }, &deny).is_err());
        assert!(resolve_source(dir.path(), &AiImageSource::File { path: "/etc/hosts".into() }, &deny).is_err());
    }

    #[test]
    fn image_refs_deserialize_from_the_webview_shape() {
        let refs: Vec<AiImageRef> = serde_json::from_value(json!([
            { "id": "f1/a.jpg", "kind": "photo", "hash": "a".repeat(64), "developHash": "b".repeat(64) },
            { "id": "page-1", "kind": "file", "path": "/tmp/page.png", "label": "The page" },
        ]))
        .unwrap();
        assert!(matches!(&refs[0].source, AiImageSource::Photo { develop_hash: Some(_), .. }));
        assert!(matches!(&refs[1].source, AiImageSource::File { path } if path == "/tmp/page.png"));
        assert_eq!(refs[1].label.as_deref(), Some("The page"));
        let request: AiCaptionRequest = serde_json::from_value(json!({
            "images": [{ "id": "p", "kind": "file", "path": "/x.png" }],
            "system": "s",
            "prompt": "p",
            "targets": ["el-1"],
            "options": { "model": "claude-haiku-5-5", "effort": "high", "maxEdge": 1080 },
        }))
        .unwrap();
        assert_eq!(request.prompt.targets, vec!["el-1"]);
        assert_eq!(edge_of(&request.options), 1080);
        assert_eq!(request.options.effort, Some(Effort::High));
        assert_eq!(request.options.max_tokens, None);
        // Plan 35: page captions ask for a lower output limit.
        let capped: AiRequestOptions = serde_json::from_value(json!({ "effort": "low", "maxTokens": 4096 })).unwrap();
        assert_eq!(capped.max_tokens, Some(4096));
    }

    fn all_files(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
            if entry.file_type().is_file() {
                out.push(entry.path().to_path_buf());
            }
        }
        out
    }

    /// Plan 32's check: after a run, the key is in `ai.env` and in no other file under app data or the source folder,
    /// and it never reaches what the webview gets back.
    #[tokio::test]
    async fn the_key_is_only_in_ai_env_after_a_run() {
        let app_data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip/DSCF1004.jpg");
        std::fs::copy(&fixture, source.path().join("DSCF1004.jpg")).unwrap();
        let hash = crate::commands::assets::hash_file(&source.path().join("DSCF1004.jpg")).unwrap();
        let cache = app_data.path().join("cache");
        let entry = cache_entry_dir(&cache, &hash).unwrap();
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::copy(&fixture, entry.join(PROXY_FILE)).unwrap();

        write_settings(app_data.path(), update(Some(KEY))).unwrap();

        let server = MockServer::start().await;
        let answer = json!({ "photos": [{ "photo": 1, "description": "Two lines.", "people": 1, "setting": "street", "timeOfDay": "midday", "mood": "bright" }] });
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", KEY))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "claude-haiku-5-5",
                "content": [{ "type": "text", "text": answer.to_string() }],
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 700, "output_tokens": 90 },
            })))
            .expect(1)
            .mount(&server)
            .await;

        let refs: Vec<AiImageRef> = serde_json::from_value(json!([
            { "id": "f1/DSCF1004.jpg", "kind": "photo", "hash": hash },
            { "id": "f1/missing.jpg", "kind": "photo", "hash": "c".repeat(64) },
        ]))
        .unwrap();
        let roots = vec![source.path().canonicalize().unwrap()];
        let data = app_data.path().canonicalize().unwrap();
        let allow = move |p: &Path| scope::check_allowed(p, &roots, &data);
        let (images, missing) =
            prepare_images(&refs, &cache, 768, &allow, &|i, _| format!("Photo {}", i + 1)).unwrap();
        assert_eq!(images[0].width.max(images[0].height), 768);
        let key = api_key(app_data.path()).unwrap();
        let retry = RetryPolicy {
            attempts: 2,
            base: Duration::from_millis(5),
            max_wait: Duration::from_millis(5),
            ..RetryPolicy::default()
        };
        let provider = Anthropic::with_base_url(key, &server.uri(), retry).unwrap();
        let options = DescribeOptions { model: "claude-haiku-5-5".into(), effort: Effort::Low };
        let outcome = describe(&provider, images, missing, options, &CancelToken::default()).await.unwrap();
        let returned = serde_json::to_string(&outcome).unwrap();
        assert!(!returned.contains(KEY));
        let AiOutcome::Ok { value, meta } = outcome else { panic!("expected an answer") };
        let usage = meta.usage;
        assert_eq!(value.entries[0].id, "f1/DSCF1004.jpg");
        assert_eq!(value.missing, vec!["f1/missing.jpg"]);
        assert_eq!(usage.input_tokens, 700);

        let mut holders = Vec::new();
        for file in all_files(app_data.path()).into_iter().chain(all_files(source.path())) {
            let bytes = std::fs::read(&file).unwrap();
            if bytes.windows(KEY.len()).any(|w| w == KEY.as_bytes()) {
                holders.push(file.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
        assert_eq!(holders, vec![SETTINGS_FILE_NAME.to_string()]);
    }

    #[tokio::test]
    async fn a_cancelled_job_resolves_cancelled() {
        let jobs = AiJobs::default();
        assert!(!jobs.cancel(7), "not running yet: remembered");
        let token = jobs.start(7);
        assert!(token.is_cancelled());
        jobs.finish(7);
        let token = jobs.start(8);
        assert!(jobs.cancel(8));
        let result = token.run(async { Ok::<_, AiError>(1) }).await;
        assert_eq!(result, Err(AiError::Cancelled));
        let outcome = outcome::<Captions, Captions>(Err(AiError::Cancelled), "this page", |c| c).unwrap();
        assert_eq!(serde_json::to_value(outcome).unwrap(), json!({ "status": "cancelled" }));
    }
}
