import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToMonth, captionPage, emptyMonth, monthKey, useAiStore } from './ai';

const mocks = vi.hoisted(() => ({ aiCaption: vi.fn() }));
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  aiCaption: mocks.aiCaption,
}));

const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

describe('AI usage this month', () => {
  afterEach(() => {
    useAiStore.setState({ month: emptyMonth() });
    mocks.aiCaption.mockReset();
  });

  it('adds usage and dollars within a month and restarts in a new one', () => {
    const october = new Date(2026, 9, 13);
    let month = addToMonth(emptyMonth(october), [{ model: 'claude-opus-5-5', usage }], october);
    month = addToMonth(month, [{ model: 'claude-haiku-5-5', usage }], october);
    expect(month.month).toBe('2026-10');
    expect(month.requests).toBe(2);
    expect(month.usage.inputTokens).toBe(2_000_000);
    // Opus $4, Haiku on its above-100K rate card $0.50.
    expect(month.usd).toBeCloseTo(4.5, 6);
    const november = new Date(2026, 10, 1);
    const next = addToMonth(month, [{ model: 'claude-opus-5-5', usage }], november);
    expect(next).toMatchObject({ month: monthKey(november), requests: 1 });
    expect(next.usd).toBeCloseTo(4, 6);
  });

  it('prices a fallback on its own model and keeps unknown models out of the dollars', () => {
    const now = new Date(2026, 9, 13);
    const month = addToMonth(
      emptyMonth(now),
      [
        { model: 'claude-opus-5-5', usage },
        { model: 'claude-opus-4-8', usage },
        { model: 'claude-unknown', usage },
      ],
      now,
    );
    expect(month.requests).toBe(1);
    expect(month.usage.inputTokens).toBe(3_000_000);
    expect(month.usd).toBeCloseTo(9, 6);
    expect(month.unpricedTokens).toBe(1_000_000);
  });

  it('records the usage of a refusal but not of a cancelled request', async () => {
    mocks.aiCaption.mockResolvedValueOnce({
      status: 'refused',
      message: 'The model declined this page: x',
      reason: 'x',
      category: null,
      model: 'claude-opus-5-5',
      servedBy: 'claude-opus-5-5',
      fellBack: false,
      usage,
      attempts: [{ model: 'claude-opus-5-5', usage }],
    });
    mocks.aiCaption.mockResolvedValueOnce({ status: 'cancelled' });
    const request = { images: [], system: 's', prompt: 'p', targets: [] };
    expect((await captionPage(request, 1)).status).toBe('refused');
    expect((await captionPage(request, 2)).status).toBe('cancelled');
    expect(useAiStore.getState().month.requests).toBe(1);
    expect(useAiStore.getState().month.usd).toBeCloseTo(4, 6);
  });
});
