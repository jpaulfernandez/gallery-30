import { AI_PRICING, type AiModel, type AiUsage, fitLongEdge, imageTokens, usageCost } from '@photobook/shared';

/**
 * Output tokens assumed per request when the caller does not say: the JSON plus adaptive thinking at `low` or `medium`
 * effort. Thinking varies a lot from request to request, so treat the dollars as a rough guide; the real usage of
 * every answer is recorded.
 */
export const DEFAULT_OUTPUT_TOKENS_PER_REQUEST = 2000;

export interface CostEstimate {
  model: AiModel;
  /** Images at the size they are sent (`maxEdge`, 768 px by default). */
  imageTokens: number;
  /** Uncached text: the `text` argument. */
  textTokens: number;
  /** The cached system prefix: written once, read by every later request. */
  cachedTokens: number;
  /** Everything the model reads, cached or not. */
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface EstimateOptions {
  /** Long edge the images are sent at (768 by default; Rust downscales to it). */
  maxEdge?: number;
  /** Requests in the run (1 by default). */
  requests?: number;
  /** Tokens of a system prefix sent with every request and cached (the style sheet, brief and index). */
  cachedTextTokens?: number;
  /** Total output tokens; {@link DEFAULT_OUTPUT_TOKENS_PER_REQUEST} per request when absent. */
  outputTokens?: number;
}

/** About four characters per token, for text not counted yet (`aiCountTokens` gives the exact figure). */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What a run costs before it runs: `images` are the source sizes of every image in the run (fitted to `maxEdge` and
 * counted at `width × height / 750`), `text` the uncached text (a token count, or the text itself, estimated at four
 * characters a token). A cached system prefix is priced as one 1 h cache write plus a read per later request.
 */
export function estimate(
  images: readonly { width: number; height: number }[],
  text: string | number,
  model: AiModel,
  options: EstimateOptions = {},
): CostEstimate {
  const requests = Math.max(1, options.requests ?? 1);
  const pixels = images.reduce((sum, { width, height }) => {
    const sent = fitLongEdge(width, height, options.maxEdge ?? 768);
    return sum + imageTokens(sent.width, sent.height);
  }, 0);
  const textTokens = typeof text === 'number' ? text : roughTokens(text);
  const cachedTokens = options.cachedTextTokens ?? 0;
  const outputTokens = options.outputTokens ?? DEFAULT_OUTPUT_TOKENS_PER_REQUEST * requests;
  const usage: AiUsage = {
    inputTokens: pixels + textTokens,
    outputTokens,
    cacheCreationInputTokens: cachedTokens,
    cacheReadInputTokens: cachedTokens * (requests - 1),
  };
  return {
    model,
    imageTokens: pixels,
    textTokens,
    cachedTokens,
    inputTokens: pixels + textTokens + cachedTokens * requests,
    outputTokens,
    usd: usageCost(model, usage) ?? 0,
  };
}

/** `$0.25`, `$1.20`, `under $0.01`. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
}

/** "about 60,000 tokens, roughly $0.25 on Claude Opus 5.5" (tokens rounded to two significant figures). */
export function describeEstimate(e: CostEstimate): string {
  const total = e.inputTokens + e.outputTokens;
  const rounded = total < 100 ? total : Number(total.toPrecision(2));
  return `about ${rounded.toLocaleString('en-US')} tokens, roughly ${formatUsd(e.usd)} on ${AI_PRICING[e.model].label}`;
}
