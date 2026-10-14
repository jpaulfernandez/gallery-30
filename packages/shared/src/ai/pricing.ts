/**
 * Workflow plan 32: what the AI models cost, for the estimate shown before a run and the usage line in Settings → AI.
 * Prices are US dollars per million tokens on the Anthropic API, taken from the `claude-api` reference (model table
 * cached 2026-10-06) on {@link AI_PRICING_DATE}. Check https://www.anthropic.com/pricing before trusting a total.
 */

export const AI_PRICING_DATE = '2026-10-13';

/** The models offered in Settings → AI, in picker order. */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];

/** Default for captions. */
export const DEFAULT_AI_MODEL: AiModel = 'claude-opus-5-5';
/** Default for the photo index (plan 33). */
export const DEFAULT_AI_INDEX_MODEL: AiModel = 'claude-haiku-5-5';

export interface AiModelPrice {
  label: string;
  /** $ per million input tokens. */
  input: number;
  /** $ per million output tokens (thinking included). */
  output: number;
  /** $ per million tokens read from the prompt cache. */
  cacheRead: number;
  /** $ per million tokens written to the 1 h prompt cache (2× input; the system block uses the 1 h TTL). */
  cacheWrite1h: number;
  /** A second rate card above this many input tokens per request (Haiku 5.5 above 100K). */
  longContext?: { above: number; input: number; output: number };
}

export const AI_PRICING: Record<AiModel, AiModelPrice> = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, cacheWrite1h: 4 },
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite1h: 0.2,
    longContext: { above: 100_000, input: 0.5, output: 2.5 },
  },
};

/**
 * Models a server-side fallback can answer with (Opus 5.5 and Sonnet 5.5 send `fallbacks: "default"`): not offered in
 * the picker, priced so the usage line counts what they cost. From the same reference and date.
 */
export const AI_FALLBACK_PRICING: Record<string, AiModelPrice> = {
  'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5, cacheWrite1h: 10 },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite1h: 10 },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10, cacheRead: 0.2, cacheWrite1h: 4 },
};

export function isAiModel(model: string): model is AiModel {
  return (AI_MODELS as readonly string[]).includes(model);
}

/** The price of `model` (offered or a fallback target), or null when it is not in the table. */
export function priceOf(model: string): AiModelPrice | null {
  return isAiModel(model) ? AI_PRICING[model] : (AI_FALLBACK_PRICING[model] ?? null);
}

/** A model's display name, or its id when unknown. */
export function aiModelLabel(model: string): string {
  return priceOf(model)?.label ?? model;
}

/** Tokens of one request, as `ai_describe` / `ai_caption` return them (the Messages API `usage`). */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const EMPTY_AI_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** The size an image is sent at: its long edge fitted to `edge` (768 px by default), never upscaled. */
export function fitLongEdge(width: number, height: number, edge = 768): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= edge || long <= 0) return { width, height };
  const scale = edge / long;
  return width >= height
    ? { width: edge, height: Math.max(1, Math.round(height * scale)) }
    : { width: Math.max(1, Math.round(width * scale)), height: edge };
}

/** Input tokens of one image: about `width × height / 750` (the size it is sent at). */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

/** One attempt of a request on the model that ran it (`attempts` on an AI answer; several after a fallback). */
export interface AiAttempt {
  model: string;
  usage: AiUsage;
}

/** Dollars for one request's `usage` on `model`, or null when the model has no price in the table. */
export function usageCost(model: string, usage: AiUsage): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const prompt = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  const long = price.longContext && prompt > price.longContext.above ? price.longContext : null;
  const input = long?.input ?? price.input;
  const scale = input / price.input;
  return (
    (usage.inputTokens * input +
      usage.outputTokens * (long?.output ?? price.output) +
      usage.cacheReadInputTokens * price.cacheRead * scale +
      usage.cacheCreationInputTokens * price.cacheWrite1h * scale) /
    1_000_000
  );
}

/** Dollars for every attempt of a request, plus the tokens of attempts on models without a price (not in `usd`). */
export function attemptsCost(attempts: readonly AiAttempt[]): { usd: number; unpricedTokens: number } {
  let usd = 0;
  let unpricedTokens = 0;
  for (const { model, usage } of attempts) {
    const cost = usageCost(model, usage);
    if (cost === null) {
      unpricedTokens +=
        usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    } else {
      usd += cost;
    }
  }
  return { usd, unpricedTokens };
}

/** Add two usages. */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}
