// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectPaint, markInput, onPaint, type PaintSample, painted, takeInput } from './previewTiming';
import { RAW_PREVIEW_KEY, rawPreviewEnabled, setRawPreviewOverride } from './rawPreview';

describe('previewTiming (plan 36)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setRawPreviewOverride(null);
    localStorage.removeItem(RAW_PREVIEW_KEY);
  });

  it('reports a paint once, in the next frame, from the change it carries', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const samples: PaintSample[] = [];
    const off = onPaint((s) => samples.push(s));
    const at = performance.now() - 40;
    expectPaint('blob:a', { changedAt: at, path: 'jpeg', job: 7, request: 10, decode: 5 });
    painted('blob:a');
    painted('blob:a');
    painted('blob:unknown');
    off();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ path: 'jpeg', job: 7, request: 10, decode: 5 });
    expect(samples[0]?.ms).toBeGreaterThanOrEqual(40);
  });

  it('a marked input wins over the time the hook saw the change, once', () => {
    markInput();
    const marked = takeInput(Number.MAX_SAFE_INTEGER);
    expect(marked).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(takeInput(5)).toBe(5);
  });

  it('the raw preview is off unless the flag or the override says so', () => {
    expect(rawPreviewEnabled()).toBe(false);
    localStorage.setItem(RAW_PREVIEW_KEY, '1');
    expect(rawPreviewEnabled()).toBe(true);
    setRawPreviewOverride(false);
    expect(rawPreviewEnabled()).toBe(false);
  });
});
