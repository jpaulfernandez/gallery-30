# 32 · AI settings and the Messages command

Status: done 2026-10-13. Landed: `src-tauri/src/ai/` (`mod.rs` types, `provider.rs` the `Provider` trait with
`describe_photos`, `caption_page`, `count_tokens`, `estimate_image_tokens` / `estimate_cost`; `anthropic.rs` the one
implementation, raw `reqwest` to `POST /v1/messages` and `/v1/messages/count_tokens`; `image.rs` proxy → 768 px JPEG;
`cancel.rs` the job token), `src-tauri/src/commands/ai.rs`, `packages/shared/src/ai/pricing.ts` (dated 2026-10-13,
from the `claude-api` reference: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 up to 100K-token prompts
and $0.50/$2.50 above; cache reads $0.20/$0.20/$0.01; 1 h cache writes 2× input), `lib/ai/cost.ts`, `store/ai.ts`,
`components/settings/AiPanel.tsx` (in `routes/settings.tsx` above Models). **Contract for plans 33–35** (Rust structs
in `ai/mod.rs` and `commands/ai.rs`, TS types in the AI block of `lib/tauri.ts`; do not reshape):
`read_ai_settings() → AiSettings { provider: 'anthropic', model, indexModel, hasKey, keyHint }` (never the key);
`write_ai_settings(update: { provider?, model?, indexModel?, key? })` (`key: ''` removes it); `ai_test() →
{ model, inputTokens }`; `ai_count_tokens(text, system?, model?) → { model, inputTokens }`;
`ai_describe(refs: AiImageRef[], options?: { model?, effort?, maxEdge? }, job) → AiOutcome<{ entries:
{ id, description, people: number, setting, timeOfDay: 'dawn'|'morning'|'midday'|'afternoon'|'evening'|'night'|'unknown',
mood }[], missing: string[] }>`; `ai_caption(request: { images: AiImageRef[], system, prompt, targets: string[],
options? }, job) → AiOutcome<{ captions: { target, text, alt }[] }>`; `ai_cancel(job) → bool`. `AiImageRef` is
`{ id, kind: 'photo', hash, developHash? , label? }` (the cached `proxy-<developHash>.jpg`, else `proxy.jpg`) or
`{ id, kind: 'file', path, label? }` (a page render inside an imported folder or app data); `id` is echoed, never sent.
`AiOutcome<T>` is `{ status: 'ok', ...AiReplyMeta, ...T } | { status: 'refused', message, reason, category,
...AiReplyMeta } | { status: 'cancelled' }`, where `AiReplyMeta` is `{ model (requested), servedBy (the model that
answered), fellBack, usage (billed: every attempt summed), attempts: { model, usage }[] (per model, for pricing) }` and
`usage` is `{ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }`; price it with
`attemptsCost(attempts)` from `@photobook/shared` (`usageCost` returns null for a model without a price);
`describePhotos` / `captionPage` in `store/ai.ts` wrap the two commands and add `usage` to this month's line;
`nextAiJob()` gives job numbers. Deviations: (1) `ai_caption` takes one request object instead of
`(pageImageRef, index, brief, scope, job)`: the style sheet, brief and index are joined in TypeScript into `system`
(cached, 1 h TTL; keep it byte-identical across a book's requests) and the scope becomes `prompt` + `targets` (the
`target` enum of the schema; captions may repeat a target, which is how plan 34 asks for variants); images are a list
so a page can go as its render or as its photos. (2) A refusal resolves as `{ status: 'refused', message: "The model
declined this page: <reason>" }` (describe: "…these photos…") instead of rejecting, and a cancel resolves
`{ status: 'cancelled' }`; network, key and format failures reject with readable strings. (3) `ai_cancel` added (the
job token is a number, like denoise). (4) `estimate_cost` in Rust returns input tokens (`w × h / 750` per image plus
text); dollars are computed only in TypeScript from the shared table, so prices live in one place. (5) Opus and
Sonnet requests send `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, as the `claude-api`
reference recommends for these models; a decline is retried on Anthropic's recommended model inside the call, and
only a decline of the whole chain is a refusal. Haiku has no server-side fallback. The answer is read after the last
`fallback` block; billing sums `usage.iterations` (each attempt on its own model; fallback targets Opus 5, Opus 4.8
and Sonnet 5 are priced in `AI_FALLBACK_PRICING`), and a refusal carrying `stop_details.recommended_model` (the
fallback could not run) is retried with backoff, then fails with a "try again" message, never shown as a decline. (6)
Settings also hold `indexModel` (default `claude-haiku-5-5`) next to `model` (default `claude-opus-5-5`). (7) Usage
this month is per machine in `localStorage` (`photobook.ai.usage`). (8) `ai_describe` labels images `Photo N` and maps
the numbers back, so no ids, names or paths are sent; at most 20 images per request. Request details: adaptive
thinking, effort `low` (describe) / `medium` (captions) sent explicitly, `max_tokens` 16000 non-streaming, one
constant output schema per command (`target` is a plain string, checked against `targets` after parsing), connect
timeout 15 s, request timeout 300 s (a timed-out request is not re-sent), retries on 429/500/502/503/504/529 and
dropped connections (4 attempts, 2 s doubling capped at 30 s, or `retry-after` up to 120 s; a longer `retry-after`
fails at once with the rate-limit message), redirects not followed. `ai.env` and `publish.env` are written through
`atomic::write_secret` (temp file created 0600, mode checked), and the asset protocol scope is narrowed from
`$APPDATA/**` to `$APPDATA/cache/**` with both files denied. The cost estimate assumes 2000 output tokens per request
(JSON plus thinking), a rough guide. Tests: Rust (wiremock, no real API) for the request shape, the refusal
message, the structured output parse (describe and captions, and after a fallback block), retries, a 401's readable
message, cancel mid-request, busy-fallback retry, `retry-after` honoured and fail-fast, no retry after a timeout,
redirects refused, `usage.iterations` billing, image downscaling, settings round trip with 0600 permissions, and the key appearing
only in `ai.env` across app data and the source folder after a run; Vitest for the cost estimate, the pricing table,
the monthly usage and the panel. Not done: the Test button was not run against the real API with a valid key (no
key here, and the tests must not call the API); the job-queue adapters and an `ai` job kind are left to plans 33–34.

WORKFLOW_PLAN [12.4](../WORKFLOW_PLAN.md#124-bring-your-own-key), [12.5](../WORKFLOW_PLAN.md#125-ui) (W8). Size: 2 days.
Depends on: nothing.

**Goal.** Settings → AI with a bring-your-own key, and one Rust command that talks to the Anthropic Messages API
with structured output, so no later plan touches networking or secrets.

## Decisions

- Key in `<appdata>/ai.env` with owner-only permissions, written like `write_publish_settings`; read from disk per
  call; never in the project file, the library or the webview. The webview sends asset refs and page ids, never bytes.
- Provider interface in Rust (`ai/provider.rs`): `describe_photos`, `caption_page`, `count_tokens`, `estimate_cost`;
  one implementation, Anthropic over `reqwest` to `POST /v1/messages` (no official Rust SDK). Models offered:
  `claude-opus-5-5` (default for captions), `claude-sonnet-5-5`, `claude-haiku-5-5` (default for the index).
  Read the `claude-api` skill before writing the request shape; verify pricing from it, not from memory.
- Request shape: images are the 1600 px proxies downscaled to 768 px long edge (JPEG, base64); adaptive thinking
  with effort `low` for the index and `medium` for captions; structured output with a JSON schema
  `{ captions: [{ target, text, alt }] }`; `cache_control` on the system block (1 h TTL); `stop_reason` checked
  before reading content (a refusal becomes a typed error with the reason). `usage` is returned to the caller.
- Cost table in `packages/shared/src/ai/pricing.ts` with a date; image tokens ≈ `w × h / 750`.

## Steps

1. **Rust.** `commands/ai.rs`: `read_ai_settings`, `write_ai_settings` (key, provider, model), `ai_test` (calls
   `count_tokens`), `ai_describe(refs[], job)`, `ai_caption(pageImageRef, index, brief, scope, job)`,
   `ai_count_tokens(text)`. `crates`? No: this stays in the editor crate (it needs app data and the cache); the
   provider module lives under `src-tauri/src/ai/`. Timeouts, retries on 429/529 with backoff, cancel through the
   job token.
2. **TS.** `lib/tauri.ts` wrappers and types; `lib/ai/cost.ts` (`estimate(images, text, model)`); `store/ai.ts`
   (settings, usage this month kept locally from `usage`).
3. **Settings → AI.** `components/settings/AiPanel.tsx`: provider (Anthropic), key (masked, Test button), model,
   usage line, the privacy sentence.
4. **Tests.** Rust unit tests with a mocked HTTP server (`httpmock` or `wiremock`) for the request shape, the refusal
   path and the structured output parse; Vitest for the cost estimate.

## Check

- Test button succeeds with a valid key and reports the model; an invalid key gives a readable error.
- `grep` the source folder and app data after a run: the key appears only in `ai.env` (test in Rust).
- A mocked refusal surfaces as "The model declined this page: <reason>", never as an empty caption.

## Docs

- `docs/ACCOUNTS.md` AI section (key, pricing, privacy); `CLAUDE.md` Layout (`commands/ai.rs`, `ai.env`).
