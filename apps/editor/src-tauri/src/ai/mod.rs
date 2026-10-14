//! AI captions (workflow plan 32): the provider interface, its Anthropic implementation, the images it sends and the
//! cancel token of a running request. No Tauri here, so the tests run it against a mocked HTTP server;
//! `commands/ai.rs` resolves refs and settings and calls in.
//!
//! The contract later plans build on (33 photo index, 34 brief and element captions, 35 page and book captions):
//! - [`DescribeEntry`] `{ id, description, people, setting, timeOfDay, mood }`, one per photo of an `ai_describe`.
//! - [`Caption`] `{ target, text, alt }`, in `{ captions: [...] }` of an `ai_caption`.
//! - [`ReplyMeta`] (`model`, `servedBy`, `fellBack`, billed `usage`, per-model `attempts`) on every answer and refusal,
//!   [`Reply::Refused`] instead of an empty answer.

pub mod anthropic;
pub mod cancel;
pub mod image;
pub mod provider;

use serde::{Deserialize, Serialize};

pub use cancel::CancelToken;

/// Models offered in Settings → AI. The first is the default for captions, the last for the photo index.
pub const MODELS: &[&str] = &["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
pub const DEFAULT_INDEX_MODEL: &str = "claude-haiku-5-5";
/// Long edge of the images sent (the 1600 px proxies downscaled), unless a request asks for another size.
pub const DEFAULT_IMAGE_EDGE: u32 = 768;

/// How hard the model thinks (`output_config.effort`; thinking is adaptive).
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

/// One image ready to send: a JPEG at most `edge` px on its long side.
#[derive(Clone, Debug)]
pub struct PreparedImage {
    /// The caller's id for it (a photo key or a page id); never sent to the provider.
    pub id: String,
    /// Text placed just before the image in the request (`Photo 3`, `Photo for target …`).
    pub label: String,
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Tokens of one request, as the provider reports them (`usage` of the Messages API).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Written to the prompt cache (billed at the cache write rate: 2x input for the 1 h TTL used here).
    pub cache_creation_input_tokens: u64,
    /// Read from the prompt cache (billed at the cache read rate).
    pub cache_read_input_tokens: u64,
}

/// What a photo shows, from `ai_describe` (plan 33 stores it as `photos[hash].ai` in the library, with model and date).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DescribeEntry {
    /// The ref's `id`, echoed back.
    pub id: String,
    /// Two short lines: what is in the frame, where, what is happening.
    pub description: String,
    /// People clearly visible.
    pub people: u32,
    /// Kind of place: "street", "beach", "kitchen", ….
    pub setting: String,
    pub time_of_day: TimeOfDay,
    /// One word.
    pub mood: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimeOfDay {
    Dawn,
    Morning,
    Midday,
    Afternoon,
    Evening,
    Night,
    Unknown,
}

pub const TIMES_OF_DAY: &[&str] = &["dawn", "morning", "midday", "afternoon", "evening", "night", "unknown"];

/// The answer to `ai_describe`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Described {
    /// In the order of the refs; a photo the model skipped is absent.
    pub entries: Vec<DescribeEntry>,
}

/// One caption from `ai_caption`: `target` is one of the request's targets (several captions may share one: variants).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub target: String,
    pub text: String,
    /// Alt text for the photo the caption belongs to.
    pub alt: String,
}

/// The answer to `ai_caption` (also the structured output schema the model fills).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Captions {
    pub captions: Vec<Caption>,
}

/// What a caption request carries besides its images. The text is built in TypeScript (the style sheet, the brief and
/// the photo index in `system`, the scope's instruction in `prompt`).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPrompt {
    /// Cached for an hour (`cache_control`), so a book's page requests read it at the cache price. Keep it identical
    /// across the requests of one run.
    pub system: String,
    /// The per-request instruction (which photos, which targets, how many variants, "shorter", …).
    pub prompt: String,
    /// The allowed `target` values (element ids, photo ids, `page`); empty allows any string.
    #[serde(default)]
    pub targets: Vec<String>,
}

/// Tokens one attempt of a request used, on the model that ran it (after a server-side fallback there are several,
/// each billed at its own model's price).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub model: String,
    pub usage: Usage,
}

/// Who answered and what it cost, on every reply (refusals included).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyMeta {
    /// The model the request asked for.
    pub model: String,
    /// The model that produced the answer: `model`, or a fallback model after a decline.
    pub served_by: String,
    /// A server-side fallback ran (`servedBy` may still equal `model` on a sticky turn).
    pub fell_back: bool,
    /// Every attempt's tokens summed: what the request is billed for.
    pub usage: Usage,
    /// Per attempt and model, for pricing (one entry without a fallback).
    pub attempts: Vec<Attempt>,
}

/// A provider's answer: the value, or the model declined (never an empty answer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply<T> {
    Ok { value: T, meta: ReplyMeta },
    Refused { reason: String, category: Option<String>, meta: ReplyMeta },
}

/// Why a request failed. `Cancelled` is the job token; everything else is a readable message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiError {
    Cancelled,
    Message(String),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::Cancelled => f.write_str("Cancelled"),
            AiError::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for AiError {}

impl Usage {
    pub fn add(self, other: Usage) -> Usage {
        Usage {
            input_tokens: self.input_tokens + other.input_tokens,
            output_tokens: self.output_tokens + other.output_tokens,
            cache_creation_input_tokens: self.cache_creation_input_tokens + other.cache_creation_input_tokens,
            cache_read_input_tokens: self.cache_read_input_tokens + other.cache_read_input_tokens,
        }
    }

    pub fn is_empty(&self) -> bool {
        *self == Usage::default()
    }
}

pub fn is_model(model: &str) -> bool {
    MODELS.contains(&model)
}
