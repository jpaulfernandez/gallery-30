import { describe, expect, it } from 'vitest';
import { AI_MODELS, AI_PRICING, attemptsCost, fitLongEdge, imageTokens, usageCost } from './pricing.js';

describe('AI pricing', () => {
  it('prices every offered model', () => {
    for (const model of AI_MODELS) expect(AI_PRICING[model].input).toBeGreaterThan(0);
  });

  it('counts image tokens as width × height / 750 at the size sent', () => {
    const sent = fitLongEdge(1600, 1280);
    expect(sent).toEqual({ width: 768, height: 614 });
    expect(imageTokens(sent.width, sent.height)).toBe(629);
    expect(imageTokens(1080, 1350)).toBe(1944);
    expect(fitLongEdge(600, 400)).toEqual({ width: 600, height: 400 });
  });

  it('prices usage with cache reads and 1 h cache writes', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(usageCost('claude-opus-5-5', usage)).toBeCloseTo(4 + 2, 6);
    expect(
      usageCost('claude-opus-5-5', { ...usage, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(0.2, 6);
    expect(
      usageCost('claude-opus-5-5', { ...usage, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }),
    ).toBeCloseTo(8, 6);
    expect(usageCost('gpt-4', usage)).toBeNull();
  });

  it('uses the Haiku long-prompt rate card above 100K input tokens', () => {
    const short = { inputTokens: 100_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(usageCost('claude-haiku-5-5', short)).toBeCloseTo(0.01, 6);
    expect(usageCost('claude-haiku-5-5', { ...short, inputTokens: 200_000 })).toBeCloseTo(0.1, 6);
  });

  it('prices fallback attempts on their own model and reports unpriced ones', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const cost = attemptsCost([
      { model: 'claude-opus-5-5', usage },
      { model: 'claude-opus-4-8', usage },
      { model: 'claude-mystery-9', usage },
    ]);
    expect(cost.usd).toBeCloseTo(4 + 5, 6);
    expect(cost.unpricedTokens).toBe(1_000_000);
  });
});
