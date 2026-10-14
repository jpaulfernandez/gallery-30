import { describe, expect, it } from 'vitest';
import { describeEstimate, estimate, formatUsd, roughTokens } from './cost';

describe('estimate', () => {
  it('counts images at the size sent', () => {
    // A 1600 × 1280 proxy goes at 768 × 614: 629 tokens.
    const e = estimate([{ width: 1600, height: 1280 }], 0, 'claude-opus-5-5', { outputTokens: 0 });
    expect(e.imageTokens).toBe(629);
    expect(e.inputTokens).toBe(629);
    expect(e.usd).toBeCloseTo((629 * 4) / 1e6, 9);
  });

  it('matches the workflow plan for a 90-photo index on Haiku', () => {
    const photos = Array.from({ length: 90 }, () => ({ width: 1280, height: 1600 }));
    const e = estimate(photos, 0, 'claude-haiku-5-5', { requests: 12, outputTokens: 90 * 80 });
    expect(e.imageTokens).toBe(90 * 629);
    // About $0.006 input + $0.004 output: a cent.
    expect(e.usd).toBeGreaterThan(0.005);
    expect(e.usd).toBeLessThan(0.02);
  });

  it('prices a cached system prefix as one write and a read per later request', () => {
    const pages = Array.from({ length: 30 }, () => ({ width: 1080, height: 1350 }));
    const e = estimate(pages, 30 * 200, 'claude-opus-5-5', { requests: 30, cachedTextTokens: 6000, maxEdge: 1350 });
    expect(e.imageTokens).toBe(30 * 1944);
    expect(e.cachedTokens).toBe(6000);
    expect(e.inputTokens).toBe(30 * 1944 + 6000 + 6000 * 30);
    const expected = ((30 * 1944 + 6000) * 4 + 6000 * 8 + 6000 * 29 * 0.2 + 30 * 2000 * 20) / 1e6;
    expect(e.usd).toBeCloseTo(expected, 9);
    expect(describeEstimate(e)).toMatch(/^about [\d,]+ tokens, roughly \$\d+\.\d\d on Claude Opus 5\.5$/);
  });

  it('estimates text it was not given a count for', () => {
    expect(roughTokens('a'.repeat(400))).toBe(100);
    expect(estimate([], 'a'.repeat(400), 'claude-sonnet-5-5', { outputTokens: 0 }).textTokens).toBe(100);
  });

  it('formats dollars', () => {
    expect(formatUsd(0.004)).toBe('under $0.01');
    expect(formatUsd(0.25)).toBe('$0.25');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
