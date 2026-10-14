import { describe, expect, it } from 'vitest';
import {
  advancedTouched,
  amountPatch,
  colourFollows,
  colourForAmount,
  denoiseFromAmount,
  estimateLabel,
  isNotNeeded,
  MID_GREY,
  noiseBadge,
  notNeededLabel,
  profileEvidence,
  resetAdvancedPatch,
  suggestedAmount,
  switchOnDenoise,
} from './denoise';

/** σ for a noise level given as a fraction of mid-grey. */
const sigma = (relative: number) => relative * MID_GREY;

describe('suggestedAmount', () => {
  it('maps σ monotonically from 0 to 100', () => {
    const levels = [0.001, 0.003, 0.007, 0.01, 0.015, 0.023, 0.035, 0.05, 0.2];
    const amounts = levels.map((r) => suggestedAmount({ sigma: sigma(r) }) ?? -1);
    for (let i = 1; i < amounts.length; i += 1) expect(amounts[i]).toBeGreaterThanOrEqual(amounts[i - 1] ?? 0);
    expect(amounts[0]).toBe(0);
    expect(amounts.at(-1)).toBe(100);
  });

  it('calls a clean low-ISO frame "Not needed" and a high-ISO JPEG high (the Rust fixtures)', () => {
    // crates/develop/tests/noise_profile.rs: 8-bit quantisation alone ≈ 0.35 %, an ISO 12800-like JPEG ≈ 2.3 %.
    const clean = suggestedAmount({ sigma: sigma(0.0035), iso: 200 });
    expect(clean).toBe(0);
    expect(isNotNeeded(clean)).toBe(true);
    const noisy = suggestedAmount({ sigma: sigma(0.023), iso: 12800 });
    expect(noisy).toBeGreaterThanOrEqual(55);
    expect(noisy).toBeLessThanOrEqual(70);
    expect(isNotNeeded(noisy)).toBe(false);
  });

  it('reads a RAW on its own scale (the ON1 sample RAWs)', () => {
    const raw = (r: number) => suggestedAmount({ sigma: sigma(r), source: 'raw' }) ?? -1;
    // Base ISO RAWs (ISO 100–200: 1.1–1.9 %) are "Not needed"; ISO 1600 (4.0 %) and 12800 (12 %) are not.
    for (const r of [0.0107, 0.0122, 0.0159, 0.019]) expect(isNotNeeded(raw(r))).toBe(true);
    expect(raw(0.0395)).toBeGreaterThan(45);
    expect(raw(0.1196)).toBe(100);
    // The same σ suggests more for a processed file, which has had its noise reduced already.
    expect(suggestedAmount({ sigma: sigma(0.02) })).toBeGreaterThan(raw(0.02));
  });

  it('prefers σ and falls back to the ISO', () => {
    expect(suggestedAmount({ sigma: sigma(0.0035), iso: 25600 })).toBe(0);
    expect(suggestedAmount({ iso: 200 })).toBe(0);
    expect(suggestedAmount({ iso: 3200 })).toBe(50);
    expect(suggestedAmount({ iso: 25600 })).toBe(100);
    expect(suggestedAmount({ sigma: null, iso: 6400 })).toBe(67);
    expect(suggestedAmount({})).toBeNull();
    expect(suggestedAmount(null)).toBeNull();
    expect(isNotNeeded(null)).toBe(false);
  });
});

describe('denoiseFromAmount', () => {
  it('keeps chroma above luminance, clamped', () => {
    expect(denoiseFromAmount(50)).toEqual({ luminance: 50, chroma: 75 });
    expect(denoiseFromAmount(90)).toEqual({ luminance: 90, chroma: 100 });
    expect(denoiseFromAmount(-3)).toEqual({ luminance: 0, chroma: 25 });
  });
});

describe('switchOnDenoise', () => {
  it('is monotone in the suggestion, with a floor, and the defaults when nothing is known', () => {
    expect(switchOnDenoise(null)).toEqual({});
    expect(switchOnDenoise(0)).toEqual({ luminance: 10, chroma: 35 });
    expect(switchOnDenoise(14)).toEqual({ luminance: 14, chroma: 39 });
    expect(switchOnDenoise(15)).toEqual({ luminance: 15, chroma: 40 });
    expect(switchOnDenoise(61)).toEqual({ luminance: 61, chroma: 86 });
  });
});

describe('noiseBadge', () => {
  it('reads like the plan', () => {
    expect(noiseBadge({ make: 'Fujifilm', model: 'X-T5', iso: 6400, amount: 55, photos: 12 })).toBe(
      'Fujifilm X-T5 · ISO 6400 · suggests 55 · learned from 12 photos',
    );
    expect(noiseBadge({ iso: 100, amount: 0, photos: 1 })).toBe('ISO 100 · Not needed');
    expect(noiseBadge({ amount: null })).toBe('');
  });
});

describe('profileEvidence', () => {
  it('trusts a confident profile and falls back to the ISO for a busy picture', () => {
    expect(profileEvidence({ sigma: 0.004, confidence: 0.9, iso: 6400, source: 'raw' })).toEqual({
      sigma: 0.004,
      iso: 6400,
      source: 'raw',
    });
    // No flat patch and nothing learned: σ 0 must not read as clean.
    const busy = profileEvidence({ sigma: 0, confidence: 0, source: 'processed' }, 6400);
    expect(busy).toEqual({ sigma: null, iso: 6400, source: 'processed' });
    expect(suggestedAmount(busy)).toBe(67);
    expect(profileEvidence(null, 800)).toEqual({ sigma: null, iso: 800 });
  });
});

describe('Amount mapping (plan 28)', () => {
  const defaults = { model: 'nafnet-w32', sharpen: 25, chromaMode: 'filter' } as const;
  const base = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' } as const;

  it('Colour follows Amount at 25 above, capped at 100', () => {
    expect(colourForAmount(0)).toBe(25);
    expect(colourForAmount(55)).toBe(80);
    expect(colourForAmount(75)).toBe(100);
    expect(colourForAmount(90)).toBe(100);
    expect(colourFollows({ luminance: 90, chroma: 100 })).toBe(true);
    expect(colourFollows({ luminance: 50, chroma: 60 })).toBe(false);
  });

  it('moves Colour with Amount while it follows, and leaves it once Advanced set it apart', () => {
    expect(amountPatch({ luminance: 50, chroma: 75 }, 55)).toEqual({ luminance: 55, chroma: 80 });
    expect(amountPatch({ luminance: 90, chroma: 100 }, 40)).toEqual({ luminance: 40, chroma: 65 });
    expect(amountPatch({ luminance: 50, chroma: 60 }, 70)).toEqual({ luminance: 70 });
    expect(amountPatch({ luminance: 50, chroma: 75 }, 140)).toEqual({ luminance: 100, chroma: 100 });
  });

  it('Reset returns Colour to the mapping and the rest to the defaults, keeping Amount', () => {
    const touched = { ...base, luminance: 70, chroma: 40, sharpen: 60, chromaMode: 'model', model: 'scunet' } as const;
    expect(advancedTouched(touched, defaults)).toBe(true);
    const patch = resetAdvancedPatch(touched, defaults);
    expect(patch).toEqual({ chroma: 95, sharpen: 25, chromaMode: 'filter', model: 'nafnet-w32' });
    expect(advancedTouched({ ...touched, ...patch }, defaults)).toBe(false);
    expect(advancedTouched(base, defaults)).toBe(false);
    expect(advancedTouched({ ...base, sharpen: 30 }, defaults)).toBe(true);
  });

  it('labels the estimate and the folded group', () => {
    expect(estimateLabel(400)).toBe('~1 s');
    expect(estimateLabel(14_200)).toBe('~14 s');
    expect(estimateLabel(185_000)).toBe('~3 min');
    expect(notNeededLabel(200)).toBe('Not needed at ISO 200');
    expect(notNeededLabel(undefined)).toBe('Not needed: little noise');
    // Clean by measurement although the ISO alone would suggest denoise.
    expect(notNeededLabel(6400, true)).toBe('Not needed (clean at ISO 6400)');
    expect(notNeededLabel(200, true)).toBe('Not needed at ISO 200');
  });
});
