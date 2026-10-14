import { type AiAttempt, type AiUsage, addUsage, attemptsCost, EMPTY_AI_USAGE } from '@photobook/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors';
import {
  type AiCaptionRequest,
  type AiCaptions,
  type AiDescribed,
  type AiImageRef,
  type AiOutcome,
  type AiRequestOptions,
  type AiSettings,
  type AiSettingsUpdate,
  aiCaption,
  aiDescribe,
  readAiSettings,
  writeAiSettings,
} from '../lib/tauri';

/**
 * Workflow plan 32: Settings → AI (read from and written to `<appdata>/ai.env` by Rust; the key never comes back) and
 * the spend this month, added up locally from the `usage` of every answer (per machine, in `localStorage`). Plans
 * 33–35 call {@link describePhotos} and {@link captionPage}, which record the usage for them.
 */

/** Tokens and estimated dollars of one calendar month. */
export interface AiMonthUsage {
  /** `YYYY-MM`, local time. */
  month: string;
  requests: number;
  usage: AiUsage;
  /** Estimated dollars of the priced attempts. */
  usd: number;
  /** Tokens on models the price table does not know (not in `usd`). */
  unpricedTokens: number;
}

export const AI_USAGE_KEY = 'photobook.ai.usage';

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function emptyMonth(date = new Date()): AiMonthUsage {
  return { month: monthKey(date), requests: 0, usage: { ...EMPTY_AI_USAGE }, usd: 0, unpricedTokens: 0 };
}

/** `current` plus one request's attempts (each on its own model); a new month starts from zero. */
export function addToMonth(current: AiMonthUsage, attempts: readonly AiAttempt[], now = new Date()): AiMonthUsage {
  const base = current.month === monthKey(now) ? current : emptyMonth(now);
  const cost = attemptsCost(attempts);
  return {
    month: base.month,
    requests: base.requests + 1,
    usage: attempts.reduce((sum, a) => addUsage(sum, a.usage), base.usage),
    usd: base.usd + cost.usd,
    unpricedTokens: (base.unpricedTokens ?? 0) + cost.unpricedTokens,
  };
}

function loadMonth(): AiMonthUsage {
  try {
    const raw = globalThis.localStorage?.getItem(AI_USAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as AiMonthUsage) : null;
    if (parsed && parsed.month === monthKey(new Date()) && typeof parsed.usd === 'number') {
      return { ...parsed, unpricedTokens: parsed.unpricedTokens ?? 0 };
    }
  } catch {
    // Unreadable or unavailable: start the month again.
  }
  return emptyMonth();
}

function saveMonth(month: AiMonthUsage): void {
  try {
    globalThis.localStorage?.setItem(AI_USAGE_KEY, JSON.stringify(month));
  } catch {
    // Storage full or blocked: the line resets next launch, nothing else depends on it.
  }
}

export interface AiState {
  settings: AiSettings | null;
  error: string | null;
  month: AiMonthUsage;
  /** Read the settings from Rust (no key, only whether there is one). */
  load: () => Promise<void>;
  /** Write a change; rejects with a readable message. */
  save: (update: AiSettingsUpdate) => Promise<AiSettings>;
  /** Add one request's `attempts` (from an answer or a refusal) to this month. */
  recordUsage: (attempts: readonly AiAttempt[]) => void;
}

export const useAiStore = create<AiState>()((set, get) => ({
  settings: null,
  error: null,
  month: loadMonth(),
  load: async () => {
    try {
      set({ settings: await readAiSettings(), error: null });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },
  save: async (update) => {
    const settings = await writeAiSettings(update);
    set({ settings, error: null });
    return settings;
  },
  recordUsage: (attempts) => {
    const month = addToMonth(get().month, attempts);
    saveMonth(month);
    set({ month });
  },
}));

let lastJob = Date.now();

/** A fresh job number for `aiDescribe` / `aiCaption` / `aiCancel`. */
export function nextAiJob(): number {
  lastJob += 1;
  return lastJob;
}

function record<T>(outcome: AiOutcome<T>): AiOutcome<T> {
  if (outcome.status !== 'cancelled') useAiStore.getState().recordUsage(outcome.attempts);
  return outcome;
}

/** `aiDescribe` that adds the answer's usage to this month's line. */
export async function describePhotos(
  refs: AiImageRef[],
  options: AiRequestOptions | undefined,
  job: number,
): Promise<AiOutcome<AiDescribed>> {
  return record(await aiDescribe(refs, options, job));
}

/** `aiCaption` that adds the answer's usage to this month's line. */
export async function captionPage(request: AiCaptionRequest, job: number): Promise<AiOutcome<AiCaptions>> {
  return record(await aiCaption(request, job));
}
