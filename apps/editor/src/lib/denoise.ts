import type { ChromaMode, DenoiseModel } from '@photobook/shared';
import type { AiModelInfo, NoiseSource } from './tauri';

let lastJob = 0;

/**
 * Increasing job id for `runDenoise` / `downloadModel` / `renderDevelopFull`; time-based so it stays ahead of jobs from
 * before a dev reload.
 */
export function nextDenoiseJob(): number {
  lastJob = Math.max(lastJob + 1, Date.now());
  return lastJob;
}

/** "117 MB" (whole megabytes, decimal like Finder); smaller sizes keep their unit. */
export function modelSizeLabel(bytes: number): string {
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** The model is known but not (fully) on disk. */
export function isModelMissing(model: AiModelInfo | null | undefined): model is AiModelInfo {
  return !!model && model.status.state !== 'installed';
}

/** "NAFNet (w32) needs a 117 MB download." for the message a missing model produces. */
export function missingModelMessage(model: AiModelInfo): string {
  return `${model.title} is not installed (${modelSizeLabel(model.bytes)} download).`;
}

// Suggestions from the noise profile (workflow plan 23).

/** Linear mid-grey: `NoiseProfile.sigma` is read off the curve there. */
export const MID_GREY = 0.18;
/**
 * σ / mid-grey (at the 1600 px working size) at which the suggestion is 0 and 100, per source. A RAW decode has no
 * noise reduction at all and reads 1 to 2 % even at base ISO (the ON1 sample RAWs: ISO 100–200 1.1–2.1 %, ISO 800–1600
 * 2.8–4.6 %, ISO 12800 12 %), a camera JPEG has had its noise reduced and compressed (8-bit quantisation alone about
 * 0.3 %, a synthetic ISO 12800-like JPEG 2.3 %).
 */
export const SUGGEST_RANGE: Record<NoiseSource, readonly [from: number, full: number]> = {
  raw: [0.015, 0.1],
  processed: [0.007, 0.05],
};
/** Suggestions below this read "Not needed". */
export const NOT_NEEDED_BELOW = 15;
/** ISO fallback (no profile): the suggestion is 0 at this ISO and 100 at `ISO_FULL`, log-linear between. */
export const ISO_FROM = 400;
export const ISO_FULL = 25600;

/** What a suggestion can be made from: a measured σ (preferred), else the ISO. */
export interface NoiseEvidence {
  /** σ at mid-grey, linear (`NoiseProfile.sigma`, `PhotoFile.noise`). */
  sigma?: number | null;
  iso?: number | null;
  /** Where σ was measured; processed when absent. */
  source?: NoiseSource;
}

const clampAmount = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

/** A profile less confident than this (a busy picture with few flat patches, no learned curve) is not trusted. */
export const MIN_PROFILE_CONFIDENCE = 0.1;

/**
 * The evidence a noise profile gives: its blended σ when it is confident enough, and its ISO (or `iso`, the file's,
 * when the profile has none), so a busy picture falls back to the ISO rather than reading as clean.
 */
export function profileEvidence(
  profile: { sigma: number; confidence: number; iso?: number; source: NoiseSource } | null | undefined,
  iso?: number,
): NoiseEvidence {
  const trusted = profile && profile.confidence >= MIN_PROFILE_CONFIDENCE;
  return {
    sigma: trusted ? profile.sigma : null,
    iso: profile?.iso ?? iso ?? null,
    ...(profile ? { source: profile.source } : {}),
  };
}

/**
 * The Denoise amount (0–100) a photo's noise suggests: a monotone, log-scale map of σ / mid-grey over the source's
 * `SUGGEST_RANGE` (a processed file: 0.35 % → 0, 2.3 % → 61; a RAW: ISO 100–200 → 0–12, ISO 1250–1600 → 33–55,
 * ISO 12800 → 100). Without σ the ISO decides (400 → 0, 3200 → 50, 25600 → 100). Null when neither is known.
 */
export function suggestedAmount(evidence: NoiseEvidence | null | undefined): number | null {
  const sigma = evidence?.sigma;
  if (typeof sigma === 'number' && Number.isFinite(sigma) && sigma >= 0) {
    const [from, full] = SUGGEST_RANGE[evidence?.source ?? 'processed'];
    const relative = sigma / MID_GREY;
    if (relative <= from) return 0;
    return clampAmount((100 * Math.log(relative / from)) / Math.log(full / from));
  }
  const iso = evidence?.iso;
  if (typeof iso === 'number' && iso > 0) {
    if (iso <= ISO_FROM) return 0;
    return clampAmount((100 * Math.log(iso / ISO_FROM)) / Math.log(ISO_FULL / ISO_FROM));
  }
  return null;
}

/** A suggestion low enough that denoise is not worth running. */
export const isNotNeeded = (amount: number | null): boolean => amount !== null && amount < NOT_NEEDED_BELOW;

// Amount (workflow plan 28): the Denoise group's one slider in front. The schema is unchanged: Amount *is* Luminance,
// and Colour (`chroma`) follows it at `COLOUR_LEAD` above until Advanced sets it apart. Whether Colour still follows
// is read off the values themselves (`colourFollows`), so it holds across sessions and undo without any extra state.

/** How far Colour sits above Amount while it follows it (the defaults are 50 / 75). */
export const COLOUR_LEAD = 25;

/** The Colour that follows an Amount: `min(100, amount + 25)`. */
export const colourForAmount = (amount: number): number => clampAmount(clampAmount(amount) + COLOUR_LEAD);

/** The denoise strengths an Amount stands for: Luminance is the amount, Colour follows it. */
export function denoiseFromAmount(amount: number): { luminance: number; chroma: number } {
  const luminance = clampAmount(amount);
  return { luminance, chroma: colourForAmount(luminance) };
}

/** Colour still follows Amount: nobody set it apart in Advanced (or it was set back onto the mapping). */
export const colourFollows = (d: { luminance: number; chroma: number }): boolean =>
  d.chroma === colourForAmount(d.luminance);

/**
 * What moving Amount (or Advanced › Luminance, the same value) writes: Luminance, and Colour too while it follows.
 * Sharpen, the colour mode and the model are never touched, so anything set in Advanced survives.
 */
export function amountPatch(
  d: { luminance: number; chroma: number },
  amount: number,
): { luminance: number; chroma?: number } {
  const luminance = clampAmount(amount);
  return colourFollows(d) ? { luminance, chroma: colourForAmount(luminance) } : { luminance };
}

/**
 * Advanced › Reset: back to the mapping for the current Amount (Colour follows again), Sharpen and the colour mode at
 * their defaults and the model at Settings → Models' default. Amount itself is kept.
 */
export function resetAdvancedPatch(
  d: { luminance: number },
  defaults: { model: DenoiseModel; sharpen: number; chromaMode: ChromaMode },
): { chroma: number; sharpen: number; chromaMode: ChromaMode; model: DenoiseModel } {
  return {
    chroma: colourForAmount(d.luminance),
    sharpen: defaults.sharpen,
    chromaMode: defaults.chromaMode,
    model: defaults.model,
  };
}

/** Advanced differs from the mapping and the defaults (its Reset is live). */
export function advancedTouched(
  d: { luminance: number; chroma: number; sharpen: number; chromaMode: ChromaMode; model: DenoiseModel },
  defaults: { model: DenoiseModel; sharpen: number; chromaMode: ChromaMode },
): boolean {
  return (
    !colourFollows(d) ||
    d.sharpen !== defaults.sharpen ||
    d.chromaMode !== defaults.chromaMode ||
    d.model !== defaults.model
  );
}

/** "~14 s", "~3 min": an Apply estimate. */
export function estimateLabel(ms: number): string {
  if (ms < 60_000) return `~${Math.max(1, Math.round(ms / 1000))} s`;
  return `~${Math.round(ms / 60_000)} min`;
}

/**
 * "Not needed at ISO 200"; "Not needed (clean at ISO 6400)" when the photo's measured noise says so although its ISO
 * alone would suggest denoise; without the ISO when only the measured noise is known.
 */
export function notNeededLabel(iso: number | null | undefined, byMeasurement = false): string {
  if (!iso) return 'Not needed: little noise';
  if (byMeasurement && !isNotNeeded(suggestedAmount({ iso }))) return `Not needed (clean at ISO ${iso})`;
  return `Not needed at ISO ${iso}`;
}

/** The denoise models people can pick (the Denoise group's Advanced and Settings → Models), in order. */
export const DENOISE_MODEL_CHOICES: ReadonlyArray<{
  id: DenoiseModel;
  name: string;
  recommended?: boolean;
  hint: string;
}> = [
  { id: 'nafnet-w32', name: 'NAFNet', recommended: true, hint: 'About 15 s for a 24 MP photo on Apple silicon.' },
  {
    id: 'scunet',
    name: 'SCUNet',
    hint: 'Slow, CPU only, for small or heavily compressed images: about 12 minutes.',
  },
];

/** The least Luminance switching denoise on at a suggestion starts from (Chroma 25 above it). */
export const SWITCH_ON_FLOOR = 10;

/**
 * What switching denoise on starts from: the suggestion (never under `SWITCH_ON_FLOOR`, so a "Not needed" photo
 * starts gentle rather than at the defaults: monotone in the suggestion), or the defaults (`{}`) when nothing is known.
 */
export function switchOnDenoise(
  suggestion: number | null,
): { luminance: number; chroma: number } | Record<string, never> {
  return suggestion === null ? {} : denoiseFromAmount(Math.max(suggestion, SWITCH_ON_FLOOR));
}

/** "Fujifilm X-T5 · ISO 6400 · suggests 55 · learned from 12 photos" (the parts that are known). */
export function noiseBadge(input: {
  make?: string;
  model?: string;
  iso?: number;
  amount: number | null;
  photos?: number;
}): string {
  const camera = [input.make, input.model].filter(Boolean).join(' ');
  const parts: string[] = [];
  if (camera) parts.push(camera);
  if (input.iso) parts.push(`ISO ${input.iso}`);
  if (input.amount !== null) parts.push(isNotNeeded(input.amount) ? 'Not needed' : `suggests ${input.amount}`);
  if (input.photos && input.photos > 1) parts.push(`learned from ${input.photos} photos`);
  return parts.join(' · ');
}
