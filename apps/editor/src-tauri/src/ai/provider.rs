//! The provider interface. Nothing else in the editor knows which provider is in use; Anthropic is the one
//! implementation (`anthropic.rs`), and another adapter would implement the same four calls.

use super::{AiError, CancelToken, CaptionPrompt, Captions, Described, Effort, PreparedImage, Reply};

/// Options of a describe (photo index) request.
#[derive(Clone, Debug)]
pub struct DescribeOptions {
    pub model: String,
    pub effort: Effort,
}

/// Options of a caption request.
#[derive(Clone, Debug)]
pub struct CaptionOptions {
    pub model: String,
    pub effort: Effort,
    /// Output limit (thinking included); the default (`MAX_TOKENS`, 16,000) when absent. Plan 35 caps page captions.
    pub max_tokens: Option<u32>,
}

#[allow(async_fn_in_trait)]
pub trait Provider {
    /// A description of each photo (one request; send at most about 8 at a time).
    async fn describe_photos(
        &self,
        images: &[PreparedImage],
        options: &DescribeOptions,
        cancel: &CancelToken,
    ) -> Result<Reply<Described>, AiError>;

    /// Captions and alt text for a page (its render, or its photos), with the system text cached.
    async fn caption_page(
        &self,
        images: &[PreparedImage],
        prompt: &CaptionPrompt,
        options: &CaptionOptions,
        cancel: &CancelToken,
    ) -> Result<Reply<Captions>, AiError>;

    /// Input tokens of `system` + `text` as one user message on `model` (free; also the key check).
    async fn count_tokens(
        &self,
        model: &str,
        system: Option<&str>,
        text: &str,
        cancel: &CancelToken,
    ) -> Result<u64, AiError>;

    /// Input tokens an image of `width × height` costs. Dollars are worked out in TypeScript
    /// (`packages/shared/src/ai/pricing.ts`) from these counts and the reported `usage`.
    fn estimate_image_tokens(&self, width: u32, height: u32) -> u64;

    /// Input tokens of a request with these image sizes and `text_tokens` of text (from `count_tokens`).
    fn estimate_cost(&self, images: &[(u32, u32)], text_tokens: u64) -> u64 {
        images.iter().map(|&(w, h)| self.estimate_image_tokens(w, h)).sum::<u64>() + text_tokens
    }
}
