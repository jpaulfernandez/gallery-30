//! The Anthropic provider: `POST /v1/messages` over `reqwest` (there is no official Rust SDK), raw JSON as the
//! Messages API documents it. Request shape (workflow plan 12.4, checked against the `claude-api` reference on
//! Oct 13, 2026):
//!
//! - `thinking: { type: "adaptive" }` with `output_config.effort` (`low` for the index, `medium` for captions);
//!   Opus 5.5 and Haiku 5.5 default to `medium`, so it is always sent explicitly.
//! - Structured output through `output_config.format` (`json_schema`), so nothing is parsed from prose.
//! - Images as base64 JPEG blocks, each after a short text label.
//! - The caption system text carries `cache_control` with the 1 h TTL; the book's page requests read it from cache.
//! - `stop_reason` is checked before `content`: `refusal` becomes [`Reply::Refused`] with the reason, `max_tokens`
//!   an error, and only `end_turn` is parsed.
//! - Opus and Sonnet requests opt into server-side fallbacks (`fallbacks: "default"`, beta
//!   `server-side-fallback-2026-07-01`): a classifier decline is retried on Anthropic's recommended model inside the
//!   same call, and only a decline of the whole chain comes back as a refusal. Haiku has no server-side fallback.
//! - 429, 5xx and 529 are retried with exponential backoff, or after `retry-after` when it is at most two minutes
//!   (longer fails at once with the rate-limit message). Dropped connections are retried; a request that timed out
//!   is not (it may still be running and billed). A refusal with `stop_details.recommended_model` means the fallback
//!   could not run (rate limit or overload) and is retried the same way. Every wait and request stops on the job's
//!   cancel token.
//! - Billing reads `usage.iterations` (one entry per attempt when a fallback ran), so declined attempts are counted
//!   and each attempt is priced on its own model.
//! - Redirects are not followed, so the `x-api-key` header never goes to another host.

use std::time::Duration;

use base64::Engine;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::provider::{CaptionOptions, DescribeOptions, Provider};
use super::{
    AiError, Attempt, CancelToken, CaptionPrompt, Captions, DescribeEntry, Described, PreparedImage, Reply, ReplyMeta,
    TimeOfDay, Usage, TIMES_OF_DAY,
};

pub const API_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Non-streaming requests: room for adaptive thinking plus the JSON, under the HTTP timeout.
const MAX_TOKENS: u32 = 16_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

const DESCRIBE_SYSTEM: &str = "You describe photographs for the person writing captions for a photo book. \
Each photo is preceded by its label, \"Photo N\". For every photo, give: a factual description in two short lines \
(what is in the frame, where it seems to be, what is happening); the number of people clearly visible; the kind of \
setting in a word or two (street, beach, kitchen, market, mountain trail, ...); the time of day when the light shows \
it, else unknown; and one mood word. Describe only what you can see. Do not guess names, brands or exact places \
unless a sign or a landmark makes them plain. Answer with one entry per photo, with N as `photo`.";

/// When to retry, how long to wait, and how long one request may take.
#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    /// Attempts in all, the first included.
    pub attempts: u32,
    /// Wait before the first retry; doubled each time.
    pub base: Duration,
    /// Cap on one computed backoff wait.
    pub max_wait: Duration,
    /// The longest `retry-after` honoured; a longer one fails at once with the rate-limit message.
    pub max_retry_after: Duration,
    /// Whole-request timeout (never retried).
    pub timeout: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 4,
            base: Duration::from_secs(2),
            max_wait: Duration::from_secs(30),
            max_retry_after: Duration::from_secs(120),
            timeout: REQUEST_TIMEOUT,
        }
    }
}

/// A fallback model was named but could not run (it was rate-limited or overloaded).
const FALLBACK_BUSY: &str =
    "The model declined and its fallback model is busy right now (rate-limited or overloaded); try again in a minute.";

/// The client. Holds the key for the length of one command; never `Debug`, never serialized.
pub struct Anthropic {
    key: String,
    base_url: String,
    client: reqwest::Client,
    retry: RetryPolicy,
}

impl Anthropic {
    pub fn new(key: impl Into<String>) -> Result<Self, AiError> {
        Self::with_base_url(key, API_URL, RetryPolicy::default())
    }

    /// Against another server (the tests' mock).
    pub fn with_base_url(key: impl Into<String>, base_url: &str, retry: RetryPolicy) -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(retry.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|err| AiError::Message(format!("Could not start the HTTP client: {err}")))?;
        Ok(Self { key: key.into(), base_url: base_url.trim_end_matches('/').to_string(), client, retry })
    }

    /// POST `body` to `path`, retrying 429/5xx/529 and dropped connections; the parsed JSON of a 2xx.
    async fn post(&self, path: &str, body: &Value, beta: Option<&str>, cancel: &CancelToken) -> Result<Value, AiError> {
        let url = format!("{}{path}", self.base_url);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let sent = cancel.run(async { Ok(self.send_once(&url, body, beta).await) }).await?;
            let wait = match sent {
                Ok((status, _, text)) if status.is_success() => {
                    return serde_json::from_str(&text)
                        .map_err(|err| AiError::Message(format!("Anthropic sent an unreadable answer: {err}")));
                }
                Ok((status, retry_after, text)) => {
                    if !retryable(status) || attempt >= self.retry.attempts {
                        return Err(http_error(status, &text));
                    }
                    if retry_after.is_some_and(|wait| wait > self.retry.max_retry_after) {
                        // Waiting that long inside one command is worse than saying so.
                        return Err(http_error(status, &text));
                    }
                    log::warn!("[photobook:ai] {path} HTTP {status}, retry {attempt}");
                    retry_after.unwrap_or_else(|| self.backoff(attempt))
                }
                Err((message, transient)) => {
                    if !transient || attempt >= self.retry.attempts {
                        return Err(AiError::Message(format!("Could not reach Anthropic: {message}")));
                    }
                    log::warn!("[photobook:ai] {path} {message}, retry {attempt}");
                    self.backoff(attempt)
                }
            };
            self.sleep(wait, cancel).await?;
        }
    }

    async fn sleep(&self, wait: Duration, cancel: &CancelToken) -> Result<(), AiError> {
        cancel
            .run(async {
                tokio::time::sleep(wait).await;
                Ok(())
            })
            .await
    }

    /// The computed wait before retry `attempt` (1-based), capped at `max_wait`.
    fn backoff(&self, attempt: u32) -> Duration {
        self.retry.base.saturating_mul(1 << (attempt - 1).min(8)).min(self.retry.max_wait)
    }

    /// One request: status, `retry-after` and body text, or a transport error (message, worth retrying).
    async fn send_once(
        &self,
        url: &str,
        body: &Value,
        beta: Option<&str>,
    ) -> Result<(StatusCode, Option<Duration>, String), (String, bool)> {
        let mut request = self
            .client
            .post(url)
            .header("x-api-key", &self.key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .body(body.to_string());
        if let Some(beta) = beta {
            request = request.header("anthropic-beta", beta);
        }
        let response = request.send().await.map_err(transport_error)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|s| s.is_finite() && *s >= 0.0)
            .map(Duration::from_secs_f64);
        let text = response.text().await.map_err(transport_error)?;
        Ok((status, retry_after, text))
    }

    async fn messages<T: DeserializeOwned>(
        &self,
        body: Value,
        images: &[PreparedImage],
        cancel: &CancelToken,
    ) -> Result<Reply<T>, AiError> {
        let model = body["model"].as_str().unwrap_or_default().to_string();
        let sizes: Vec<(u32, u32)> = images.iter().map(|i| (i.width, i.height)).collect();
        log::info!("[photobook:ai] {model}: {} images, about {} image tokens", images.len(), self.estimate_cost(&sizes, 0));
        let beta = has_server_fallback(&model).then_some(FALLBACK_BETA);
        let mut attempt = 0;
        let json = loop {
            attempt += 1;
            let json = self.post("/v1/messages", &body, beta, cancel).await?;
            if !fallback_busy(&json) {
                break json;
            }
            if attempt >= self.retry.attempts {
                return Err(AiError::Message(FALLBACK_BUSY.into()));
            }
            log::warn!("[photobook:ai] fallback model busy, retry {attempt}");
            self.sleep(self.backoff(attempt), cancel).await?;
        };
        let reply = read_reply(&json, &model)?;
        let (Reply::Ok { meta, .. } | Reply::Refused { meta, .. }) = &reply;
        let usage = meta.usage;
        log::info!(
            "[photobook:ai] {} in={} out={} cache_write={} cache_read={}{}{}",
            meta.served_by,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_creation_input_tokens,
            usage.cache_read_input_tokens,
            if meta.fell_back { " (fallback)" } else { "" },
            if matches!(reply, Reply::Refused { .. }) { " refused" } else { "" }
        );
        Ok(reply)
    }
}

impl Provider for Anthropic {
    async fn describe_photos(
        &self,
        images: &[PreparedImage],
        options: &DescribeOptions,
        cancel: &CancelToken,
    ) -> Result<Reply<Described>, AiError> {
        if images.is_empty() {
            return Err(AiError::Message("No photos to describe".into()));
        }
        let reply: Reply<RawDescribed> = self.messages(describe_body(images, options), images, cancel).await?;
        Ok(match reply {
            Reply::Ok { value, meta } => Reply::Ok { value: value.into_entries(images), meta },
            Reply::Refused { reason, category, meta } => Reply::Refused { reason, category, meta },
        })
    }

    async fn caption_page(
        &self,
        images: &[PreparedImage],
        prompt: &CaptionPrompt,
        options: &CaptionOptions,
        cancel: &CancelToken,
    ) -> Result<Reply<Captions>, AiError> {
        let reply: Reply<Captions> = self.messages(caption_body(images, prompt, options), images, cancel).await?;
        if let Reply::Ok { value, .. } = &reply {
            if !prompt.targets.is_empty() {
                if let Some(bad) = value.captions.iter().find(|c| !prompt.targets.contains(&c.target)) {
                    return Err(AiError::Message(format!("The model answered for an unknown target {:?}", bad.target)));
                }
            }
        }
        Ok(reply)
    }

    async fn count_tokens(
        &self,
        model: &str,
        system: Option<&str>,
        text: &str,
        cancel: &CancelToken,
    ) -> Result<u64, AiError> {
        if text.trim().is_empty() {
            return Err(AiError::Message("There is no text to count".into()));
        }
        let mut body = json!({
            "model": model,
            "messages": [{ "role": "user", "content": text }],
        });
        if let Some(system) = system.filter(|s| !s.is_empty()) {
            body["system"] = json!(system);
        }
        let json = self.post("/v1/messages/count_tokens", &body, None, cancel).await?;
        json["input_tokens"]
            .as_u64()
            .ok_or_else(|| AiError::Message("Anthropic's token count had no input_tokens".into()))
    }

    /// About `width × height / 750` tokens per image.
    fn estimate_image_tokens(&self, width: u32, height: u32) -> u64 {
        (width as u64 * height as u64).div_ceil(750)
    }
}

/// Opus and Sonnet take `fallbacks: "default"`; Haiku has no server-side fallback.
fn has_server_fallback(model: &str) -> bool {
    model.starts_with("claude-opus-") || model.starts_with("claude-sonnet-")
}

fn retryable(status: StatusCode) -> bool {
    matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504 | 529)
}

/// A transport failure: its message, and whether to retry. Connect errors and dropped connections are retried; a
/// timeout is not (the request may still be running, and billed).
fn transport_error(err: reqwest::Error) -> (String, bool) {
    if err.is_timeout() {
        return ("Anthropic did not answer in time; try again, with fewer images if it keeps happening".into(), false);
    }
    let transient = err.is_connect() || err.is_request();
    (err.without_url().to_string(), transient)
}

/// A refusal whose fallback could not run: `stop_details.recommended_model` is set only then.
fn fallback_busy(json: &Value) -> bool {
    json["stop_reason"] == "refusal" && json["stop_details"]["recommended_model"].as_str().is_some_and(|m| !m.is_empty())
}

/// A readable message for a non-2xx answer (the API's own `error.message` included). Never contains the key.
fn http_error(status: StatusCode, body: &str) -> AiError {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| body.chars().take(200).collect());
    let message = match status.as_u16() {
        401 => format!("Anthropic rejected the API key ({detail}). Check it in Settings → AI."),
        403 => format!("The API key may not do this: {detail}"),
        404 => format!("Not found at Anthropic: {detail}"),
        413 => format!("The request is too large for Anthropic: {detail}"),
        429 => format!("Anthropic's rate limit was hit; try again in a minute ({detail})."),
        529 => "Anthropic is overloaded right now; try again in a minute.".to_string(),
        400 => format!("Anthropic refused the request: {detail}"),
        code => format!("Anthropic answered HTTP {code}: {detail}"),
    };
    AiError::Message(message)
}

/// The label and image blocks, in order.
fn image_blocks(images: &[PreparedImage]) -> Vec<Value> {
    let b64 = base64::engine::general_purpose::STANDARD;
    images
        .iter()
        .flat_map(|image| {
            [
                json!({ "type": "text", "text": image.label }),
                json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": "image/jpeg", "data": b64.encode(&image.jpeg) },
                }),
            ]
        })
        .collect()
}

fn base_body(
    model: &str,
    effort: super::Effort,
    max_tokens: u32,
    schema: Value,
    system: Value,
    content: Vec<Value>,
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "thinking": { "type": "adaptive" },
        "output_config": { "effort": effort.as_str(), "format": { "type": "json_schema", "schema": schema } },
        "system": system,
        "messages": [{ "role": "user", "content": content }],
    });
    if has_server_fallback(model) {
        body["fallbacks"] = json!("default");
    }
    body
}

pub(crate) fn describe_body(images: &[PreparedImage], options: &DescribeOptions) -> Value {
    let schema = json!({
        "type": "object",
        "properties": {
            "photos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "photo": { "type": "integer" },
                        "description": { "type": "string" },
                        "people": { "type": "integer" },
                        "setting": { "type": "string" },
                        "timeOfDay": { "type": "string", "enum": TIMES_OF_DAY },
                        "mood": { "type": "string" },
                    },
                    "required": ["photo", "description", "people", "setting", "timeOfDay", "mood"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["photos"],
        "additionalProperties": false,
    });
    let mut content = image_blocks(images);
    content.push(json!({ "type": "text", "text": format!("Describe these {} photos.", images.len()) }));
    let system = json!([{ "type": "text", "text": DESCRIBE_SYSTEM }]);
    base_body(&options.model, options.effort, MAX_TOKENS, schema, system, content)
}

pub(crate) fn caption_body(images: &[PreparedImage], prompt: &CaptionPrompt, options: &CaptionOptions) -> Value {
    // One constant schema for every page (compiled once, cached by the API); `targets` is checked after parsing.
    let target = json!({ "type": "string" });
    let schema = json!({
        "type": "object",
        "properties": {
            "captions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "target": target, "text": { "type": "string" }, "alt": { "type": "string" } },
                    "required": ["target", "text", "alt"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["captions"],
        "additionalProperties": false,
    });
    let mut content = image_blocks(images);
    content.push(json!({ "type": "text", "text": prompt.prompt }));
    let system = json!([{
        "type": "text",
        "text": prompt.system,
        "cache_control": { "type": "ephemeral", "ttl": "1h" },
    }]);
    let max_tokens = options.max_tokens.unwrap_or(MAX_TOKENS);
    base_body(&options.model, options.effort, max_tokens, schema, system, content)
}

#[derive(Deserialize)]
struct RawDescribed {
    photos: Vec<RawPhoto>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPhoto {
    photo: i64,
    description: String,
    people: i64,
    setting: String,
    time_of_day: TimeOfDay,
    mood: String,
}

impl RawDescribed {
    /// Map `Photo N` back to the refs' ids, in ref order; out-of-range and repeated numbers are dropped.
    fn into_entries(self, images: &[PreparedImage]) -> Described {
        let mut slots: Vec<Option<DescribeEntry>> = vec![None; images.len()];
        for photo in self.photos {
            let Some(index) = usize::try_from(photo.photo - 1).ok().filter(|i| *i < images.len()) else { continue };
            if slots[index].is_some() {
                continue;
            }
            slots[index] = Some(DescribeEntry {
                id: images[index].id.clone(),
                description: photo.description.trim().to_string(),
                people: photo.people.clamp(0, u32::MAX as i64) as u32,
                setting: photo.setting.trim().to_string(),
                time_of_day: photo.time_of_day,
                mood: photo.mood.trim().to_string(),
            });
        }
        Described { entries: slots.into_iter().flatten().collect() }
    }
}

fn usage_of(value: &Value) -> Usage {
    let n = |key: &str| value[key].as_u64().unwrap_or(0);
    Usage {
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_creation_input_tokens: n("cache_creation_input_tokens"),
        cache_read_input_tokens: n("cache_read_input_tokens"),
    }
}

/// Who answered and the billed usage. `usage.iterations`, when present, has one entry per attempt (a declined attempt
/// and the fallback's `fallback_message`); the top-level `usage` then covers only the attempt that answered.
pub(crate) fn read_meta(json: &Value, requested: &str) -> ReplyMeta {
    let served_by = json["model"].as_str().filter(|m| !m.is_empty()).unwrap_or(requested).to_string();
    let iterations = json["usage"]["iterations"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut fell_back = served_by != requested;
    let mut attempts: Vec<Attempt> = Vec::new();
    for entry in iterations {
        let is_fallback = entry["type"] == "fallback_message";
        fell_back |= is_fallback;
        let model = match entry["model"].as_str() {
            Some(m) if !m.is_empty() => m.to_string(),
            _ if is_fallback => served_by.clone(),
            _ => requested.to_string(),
        };
        let usage = usage_of(entry);
        match attempts.iter_mut().find(|a| a.model == model) {
            Some(a) => a.usage = a.usage.add(usage),
            None => attempts.push(Attempt { model, usage }),
        }
    }
    if attempts.iter().all(|a| a.usage.is_empty()) {
        attempts = vec![Attempt { model: served_by.clone(), usage: usage_of(&json["usage"]) }];
    }
    let usage = attempts.iter().fold(Usage::default(), |sum, a| sum.add(a.usage));
    ReplyMeta { model: requested.to_string(), served_by, fell_back, usage, attempts }
}

/// `stop_reason` first, then the structured output (the text after the last `fallback` block, if any). `requested`
/// is the model the request named.
pub(crate) fn read_reply<T: DeserializeOwned>(json: &Value, requested: &str) -> Result<Reply<T>, AiError> {
    let meta = read_meta(json, requested);
    match json["stop_reason"].as_str() {
        Some("refusal") => {
            let details = &json["stop_details"];
            let category = details["category"].as_str().map(str::to_string);
            let reason = details["explanation"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| category.as_ref().map(|c| format!("it was flagged by the {c} safeguard")))
                .unwrap_or_else(|| "no reason was given".to_string());
            Ok(Reply::Refused { reason, category, meta })
        }
        Some("max_tokens") => Err(AiError::Message(
            "The answer reached the output limit before it was complete; try again.".into(),
        )),
        Some("end_turn") | Some("stop_sequence") => {
            let blocks = json["content"].as_array().map(Vec::as_slice).unwrap_or_default();
            let start = blocks.iter().rposition(|b| b["type"] == "fallback").map_or(0, |i| i + 1);
            let text: String =
                blocks[start..].iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
            if text.trim().is_empty() {
                return Err(AiError::Message("The model sent an empty answer".into()));
            }
            let value = serde_json::from_str(&text)
                .map_err(|err| AiError::Message(format!("The model's answer did not match the expected format: {err}")))?;
            Ok(Reply::Ok { value, meta })
        }
        Some(other) => Err(AiError::Message(format!("The model stopped unexpectedly ({other})"))),
        None => Err(AiError::Message("Anthropic's answer had no stop_reason".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::Effort;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const KEY: &str = "sk-ant-test-0123456789abcdef";

    fn fast() -> RetryPolicy {
        RetryPolicy {
            attempts: 3,
            base: Duration::from_millis(10),
            max_wait: Duration::from_millis(50),
            max_retry_after: Duration::from_secs(2),
            timeout: Duration::from_secs(5),
        }
    }

    fn image(id: &str, label: &str) -> PreparedImage {
        PreparedImage { id: id.into(), label: label.into(), jpeg: vec![0xFF, 0xD8, 1, 2, 3], width: 768, height: 614 }
    }

    fn message(model: &str, stop_reason: &str, content: Value) -> Value {
        json!({
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": stop_reason,
            "stop_details": null,
            "usage": {
                "input_tokens": 1200,
                "output_tokens": 300,
                "cache_creation_input_tokens": 5000,
                "cache_read_input_tokens": 0,
            },
        })
    }

    fn body_of(request: &Request) -> Value {
        serde_json::from_slice(&request.body).unwrap()
    }

    fn caption_prompt() -> CaptionPrompt {
        CaptionPrompt {
            system: "Editorial style sheet. Brief. Index.".into(),
            prompt: "Caption the photo on this page.".into(),
            targets: vec!["el-1".into(), "el-2".into()],
        }
    }

    #[tokio::test]
    async fn caption_request_shape_and_structured_output() {
        let server = MockServer::start().await;
        let answer = json!({ "captions": [
            { "target": "el-1", "text": "Morning light on the tram stop.", "alt": "A yellow tram at a stop." },
            { "target": "el-2", "text": "Tiles, up close.", "alt": "Blue and white tiles." },
        ]});
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", KEY))
            .and(header("anthropic-version", "2023-06-01"))
            .and(header("anthropic-beta", FALLBACK_BETA))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "claude-opus-5-5",
                "end_turn",
                json!([{ "type": "thinking", "thinking": "", "signature": "x" }, { "type": "text", "text": answer.to_string() }]),
            )))
            .expect(1)
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let options = CaptionOptions { model: "claude-opus-5-5".into(), effort: Effort::Medium, max_tokens: None };
        let reply = provider
            .caption_page(&[image("page-1", "The page")], &caption_prompt(), &options, &CancelToken::default())
            .await
            .unwrap();
        let Reply::Ok { value, meta } = reply else { panic!("expected an answer") };
        assert_eq!((meta.model.as_str(), meta.served_by.as_str(), meta.fell_back), ("claude-opus-5-5", "claude-opus-5-5", false));
        assert_eq!(value.captions.len(), 2);
        assert_eq!(value.captions[0].target, "el-1");
        assert_eq!(meta.usage.cache_creation_input_tokens, 5000);
        assert_eq!(meta.attempts, vec![Attempt { model: "claude-opus-5-5".into(), usage: meta.usage }]);

        let requests = server.received_requests().await.unwrap();
        let body = body_of(&requests[0]);
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["thinking"], json!({ "type": "adaptive" }));
        assert_eq!(body["output_config"]["effort"], "medium");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        let item = &body["output_config"]["format"]["schema"]["properties"]["captions"]["items"];
        // A constant schema: the targets are checked after parsing, not compiled into each request.
        assert_eq!(item["properties"]["target"], json!({ "type": "string" }));
        assert_eq!(item["required"], json!(["target", "text", "alt"]));
        assert_eq!(item["additionalProperties"], false);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["system"][0]["text"], "Editorial style sheet. Brief. Index.");
        assert_eq!(body["system"][0]["cache_control"], json!({ "type": "ephemeral", "ttl": "1h" }));
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0], json!({ "type": "text", "text": "The page" }));
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[1]["source"]["data"], "/9gBAgM=");
        assert_eq!(content[2], json!({ "type": "text", "text": "Caption the photo on this page." }));
        // The key travels in the header only.
        assert!(!String::from_utf8_lossy(&requests[0].body).contains(KEY));
    }

    #[tokio::test]
    async fn a_refusal_is_a_reply_with_the_reason_not_an_empty_caption() {
        let server = MockServer::start().await;
        let mut refused = message("claude-opus-5-5", "refusal", json!([]));
        refused["stop_details"] =
            json!({ "type": "refusal", "category": "bio", "explanation": "the page shows lab equipment" });
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refused))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let options = CaptionOptions { model: "claude-opus-5-5".into(), effort: Effort::Medium, max_tokens: None };
        let reply =
            provider.caption_page(&[image("p", "Page")], &caption_prompt(), &options, &CancelToken::default()).await;
        let outcome = crate::commands::ai::outcome(reply, "this page", |c: Captions| c).unwrap();
        match outcome {
            crate::commands::ai::AiOutcome::Refused { message, category, meta, .. } => {
                assert_eq!(message, "The model declined this page: the page shows lab equipment");
                assert_eq!(category.as_deref(), Some("bio"));
                assert_eq!(meta.usage.input_tokens, 1200);
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        let json = serde_json::to_value(crate::commands::ai::outcome(
            Ok::<_, AiError>(Reply::<Captions>::Refused {
                reason: "no reason was given".into(),
                category: None,
                meta: ReplyMeta::default(),
            }),
            "this page",
            |c| c,
        )
        .unwrap())
        .unwrap();
        assert_eq!(json["status"], "refused");
        assert_eq!(json["message"], "The model declined this page: no reason was given");
    }

    #[tokio::test]
    async fn describe_maps_photo_numbers_back_to_ids() {
        let server = MockServer::start().await;
        let answer = json!({ "photos": [
            { "photo": 2, "description": "A market stall.\nOranges in crates.", "people": 3, "setting": "market", "timeOfDay": "morning", "mood": "busy" },
            { "photo": 1, "description": "A tram.", "people": 0, "setting": "street", "timeOfDay": "evening", "mood": "calm" },
            { "photo": 9, "description": "Out of range", "people": 0, "setting": "x", "timeOfDay": "unknown", "mood": "x" },
            { "photo": 1, "description": "Repeated", "people": 0, "setting": "x", "timeOfDay": "unknown", "mood": "x" },
        ]});
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "claude-haiku-5-5",
                "end_turn",
                json!([{ "type": "text", "text": answer.to_string() }]),
            )))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let options = DescribeOptions { model: "claude-haiku-5-5".into(), effort: Effort::Low };
        let images = [image("folder/a.jpg", "Photo 1"), image("folder/b.jpg", "Photo 2"), image("c", "Photo 3")];
        let Reply::Ok { value, .. } =
            provider.describe_photos(&images, &options, &CancelToken::default()).await.unwrap()
        else {
            panic!("expected an answer")
        };
        assert_eq!(value.entries.len(), 2);
        assert_eq!(value.entries[0].id, "folder/a.jpg");
        assert_eq!(value.entries[0].description, "A tram.");
        assert_eq!(value.entries[0].time_of_day, TimeOfDay::Evening);
        assert_eq!(value.entries[1].id, "folder/b.jpg");
        assert_eq!(value.entries[1].people, 3);
        assert_eq!(
            serde_json::to_value(&value.entries[1]).unwrap(),
            json!({ "id": "folder/b.jpg", "description": "A market stall.\nOranges in crates.", "people": 3, "setting": "market", "timeOfDay": "morning", "mood": "busy" })
        );

        let request = &server.received_requests().await.unwrap()[0];
        let body = body_of(request);
        assert_eq!(body["output_config"]["effort"], "low");
        assert!(body.get("fallbacks").is_none(), "Haiku has no server-side fallback");
        assert!(request.headers.get("anthropic-beta").is_none());
        assert_eq!(body["output_config"]["format"]["schema"]["properties"]["photos"]["items"]["properties"]["timeOfDay"]["enum"], json!(TIMES_OF_DAY));
        // No ids or paths reach the provider: only the Photo N labels.
        assert!(!String::from_utf8_lossy(&request.body).contains("folder/"));
    }

    #[tokio::test]
    async fn the_answer_after_a_fallback_block_is_read() {
        let answer = json!({ "captions": [{ "target": "el-1", "text": "Served by the fallback.", "alt": "x" }] });
        let json = message(
            "claude-opus-4-8",
            "end_turn",
            json!([
                { "type": "text", "text": "{\"captions\": [" },
                { "type": "fallback", "from": { "model": "claude-opus-5-5" }, "to": { "model": "claude-opus-4-8" } },
                { "type": "text", "text": answer.to_string() },
            ]),
        );
        let Reply::Ok { value, meta } = read_reply::<Captions>(&json, "claude-opus-5-5").unwrap() else { panic!() };
        assert_eq!((meta.model.as_str(), meta.served_by.as_str()), ("claude-opus-5-5", "claude-opus-4-8"));
        assert!(meta.fell_back);
        assert_eq!(value.captions[0].text, "Served by the fallback.");
        let cut = message("claude-opus-5-5", "max_tokens", json!([{ "type": "text", "text": "{" }]));
        assert!(matches!(read_reply::<Captions>(&cut, "claude-opus-5-5"), Err(AiError::Message(m)) if m.contains("output limit")));
    }

    #[test]
    fn iterations_bill_every_attempt_on_its_own_model() {
        let mut json = message("claude-opus-4-8", "end_turn", json!([{ "type": "text", "text": "{}" }]));
        json["usage"] = json!({
            "input_tokens": 900, "output_tokens": 200,
            "iterations": [
                { "type": "message", "input_tokens": 1000, "output_tokens": 0 },
                { "type": "fallback_message", "input_tokens": 900, "output_tokens": 200, "cache_read_input_tokens": 50 },
            ],
        });
        let meta = read_meta(&json, "claude-opus-5-5");
        assert!(meta.fell_back);
        assert_eq!(meta.served_by, "claude-opus-4-8");
        assert_eq!(meta.attempts.len(), 2);
        assert_eq!(meta.attempts[0].model, "claude-opus-5-5");
        assert_eq!(meta.attempts[0].usage.input_tokens, 1000);
        assert_eq!(meta.attempts[1].model, "claude-opus-4-8");
        assert_eq!(meta.attempts[1].usage.cache_read_input_tokens, 50);
        assert_eq!(meta.usage.input_tokens, 1900);
        assert_eq!(meta.usage.output_tokens, 200);
        // Sticky routing: served by the fallback with no iterations at all.
        let sticky = message("claude-opus-4-8", "end_turn", json!([]));
        let meta = read_meta(&sticky, "claude-opus-5-5");
        assert!(meta.fell_back);
        assert_eq!(meta.attempts, vec![Attempt { model: "claude-opus-4-8".into(), usage: meta.usage }]);
    }

    #[tokio::test]
    async fn overloaded_is_retried_and_a_bad_key_is_readable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages/count_tokens"))
            .respond_with(ResponseTemplate::new(529).set_body_json(
                json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
            ))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/messages/count_tokens"))
            .and(header("x-api-key", KEY))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "input_tokens": 7 })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/messages/count_tokens"))
            .respond_with(ResponseTemplate::new(401).set_body_json(
                json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } }),
            ))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let n = provider.count_tokens("claude-opus-5-5", None, "hello", &CancelToken::default()).await.unwrap();
        assert_eq!(n, 7);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2, "one 529, one retry");
        let body = body_of(&requests[1]);
        assert_eq!(body, json!({ "model": "claude-opus-5-5", "messages": [{ "role": "user", "content": "hello" }] }));

        let wrong = Anthropic::with_base_url("sk-ant-wrong", &server.uri(), fast()).unwrap();
        let err = wrong.count_tokens("claude-opus-5-5", None, "hello", &CancelToken::default()).await.unwrap_err();
        let message = err.to_string();
        assert_eq!(message, "Anthropic rejected the API key (invalid x-api-key). Check it in Settings → AI.");
        assert!(!message.contains("sk-ant-wrong"));
        assert_eq!(server.received_requests().await.unwrap().len(), 3, "a 401 is not retried");
    }

    #[tokio::test]
    async fn rate_limits_give_up_after_the_last_attempt() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "0").set_body_json(
                json!({ "type": "error", "error": { "type": "rate_limit_error", "message": "slow down" } }),
            ))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let err = provider.count_tokens("claude-haiku-5-5", None, "x", &CancelToken::default()).await.unwrap_err();
        assert!(err.to_string().contains("rate limit"), "{err}");
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn cancel_stops_a_request_in_flight() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(20)).set_body_json(json!({})))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let token = CancelToken::default();
        let canceller = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            canceller.cancel();
        });
        let started = std::time::Instant::now();
        let options = DescribeOptions { model: "claude-haiku-5-5".into(), effort: Effort::Low };
        let result = provider.describe_photos(&[image("a", "Photo 1")], &options, &token).await;
        assert_eq!(result.unwrap_err(), AiError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    fn busy_refusal() -> Value {
        let mut refused = message("claude-opus-5-5", "refusal", json!([]));
        refused["stop_details"] =
            json!({ "type": "refusal", "category": "cyber", "explanation": null, "recommended_model": "claude-opus-4-8" });
        refused
    }

    #[tokio::test]
    async fn a_refusal_whose_fallback_was_busy_is_retried_not_shown_as_a_decline() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(busy_refusal()))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        let answer = json!({ "captions": [{ "target": "el-1", "text": "t", "alt": "a" }] });
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "claude-opus-5-5",
                "end_turn",
                json!([{ "type": "text", "text": answer.to_string() }]),
            )))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let options = CaptionOptions { model: "claude-opus-5-5".into(), effort: Effort::Medium, max_tokens: None };
        let reply = provider
            .caption_page(&[image("p", "Page")], &caption_prompt(), &options, &CancelToken::default())
            .await
            .unwrap();
        assert!(matches!(reply, Reply::Ok { .. }));
        assert_eq!(server.received_requests().await.unwrap().len(), 2);

        let busy = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(busy_refusal()))
            .mount(&busy)
            .await;
        let provider = Anthropic::with_base_url(KEY, &busy.uri(), fast()).unwrap();
        let err = provider
            .caption_page(&[image("p", "Page")], &caption_prompt(), &options, &CancelToken::default())
            .await
            .unwrap_err();
        assert_eq!(err, AiError::Message(FALLBACK_BUSY.into()));
        assert_eq!(busy.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn retry_after_is_honoured_and_too_long_a_wait_fails_fast() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "1").set_body_json(
                json!({ "type": "error", "error": { "type": "rate_limit_error", "message": "slow down" } }),
            ))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "input_tokens": 3 })))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let started = std::time::Instant::now();
        let n = provider.count_tokens("claude-opus-5-5", None, "x", &CancelToken::default()).await.unwrap();
        assert_eq!(n, 3);
        assert!(started.elapsed() >= Duration::from_secs(1), "waited {:?}", started.elapsed());

        let long = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "600").set_body_json(
                json!({ "type": "error", "error": { "type": "rate_limit_error", "message": "slow down" } }),
            ))
            .mount(&long)
            .await;
        let provider = Anthropic::with_base_url(KEY, &long.uri(), fast()).unwrap();
        let started = std::time::Instant::now();
        let err = provider.count_tokens("claude-opus-5-5", None, "x", &CancelToken::default()).await.unwrap_err();
        assert!(err.to_string().contains("rate limit"), "{err}");
        assert_eq!(long.received_requests().await.unwrap().len(), 1);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_timed_out_request_is_not_sent_again() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(3)).set_body_json(json!({})))
            .mount(&server)
            .await;
        let policy = RetryPolicy { timeout: Duration::from_millis(300), ..fast() };
        let provider = Anthropic::with_base_url(KEY, &server.uri(), policy).unwrap();
        let err = provider.count_tokens("claude-opus-5-5", None, "x", &CancelToken::default()).await.unwrap_err();
        assert!(err.to_string().contains("did not answer in time"), "{err}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
        assert!(provider.count_tokens("claude-opus-5-5", None, " ", &CancelToken::default()).await.is_err());
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(307).insert_header("location", "http://example.invalid/v1/messages"))
            .mount(&server)
            .await;
        let provider = Anthropic::with_base_url(KEY, &server.uri(), fast()).unwrap();
        let err = provider.count_tokens("claude-opus-5-5", None, "x", &CancelToken::default()).await.unwrap_err();
        assert!(err.to_string().contains("307"), "{err}");
    }

    #[test]
    fn image_tokens_follow_width_times_height_over_750() {
        let provider = Anthropic::with_base_url(KEY, "http://localhost", fast()).unwrap();
        assert_eq!(provider.estimate_image_tokens(768, 614), 629);
        assert_eq!(provider.estimate_image_tokens(1080, 1350), 1944);
        assert_eq!(provider.estimate_cost(&[(768, 614), (768, 614)], 100), 1358);
    }

    // Plan 35: page captions send effort `low` and a lower output limit; without one the default stays.
    #[test]
    fn caption_body_takes_the_output_limit() {
        let low = CaptionOptions { model: "claude-opus-5-5".into(), effort: Effort::Low, max_tokens: Some(4096) };
        let body = caption_body(&[image("p", "Photo 1")], &caption_prompt(), &low);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["output_config"]["effort"], "low");
        let default = CaptionOptions { max_tokens: None, ..low };
        assert_eq!(caption_body(&[image("p", "Photo 1")], &caption_prompt(), &default)["max_tokens"], MAX_TOKENS);
    }
}
