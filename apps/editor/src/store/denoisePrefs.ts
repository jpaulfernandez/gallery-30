import { DEFAULT_DENOISE, DENOISE_MODELS, type DenoiseModel } from '@photobook/shared';
import { create } from 'zustand';

/**
 * Denoise defaults and suggestions (workflow plan 27), per machine in `localStorage` (never in a project or a library,
 * never undone): the model *Denoise selected* switches photos on with, the thresholds from which a photo is marked as
 * needing denoise (the thumbnail badge, the *Needs denoise* collection and its sidebar count), and the timing of the
 * last full run per model, for the batch's estimate. Settings → Models edits the first three.
 */
export interface DenoiseTiming {
  /** Milliseconds per tile of the last full run (load, decode and write included). */
  msPerTile: number;
  /** Tiles per megapixel of that run (the model's tile size and overlap). */
  tilesPerMp: number;
}

export interface DenoisePrefs {
  /** The model a batch switches denoise on with. */
  model: DenoiseModel;
  /** From this ISO a photo with no measured noise needs denoise. */
  iso: number;
  /** From this suggested amount (`suggestedAmount` of the measured σ) a photo with a noise profile needs denoise. */
  amount: number;
  timing: Partial<Record<DenoiseModel, DenoiseTiming>>;
}

export const DEFAULT_NEEDS_ISO = 3200;
export const DEFAULT_NEEDS_AMOUNT = 40;

export const DENOISE_PREFS_KEY = 'photobook.denoise.prefs';

export const DEFAULT_DENOISE_PREFS: DenoisePrefs = {
  model: DEFAULT_DENOISE.model,
  iso: DEFAULT_NEEDS_ISO,
  amount: DEFAULT_NEEDS_AMOUNT,
  timing: {},
};

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The saved prefs, each field checked (anything unreadable is its default). */
export function loadDenoisePrefs(): DenoisePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(DENOISE_PREFS_KEY);
    if (!raw) return DEFAULT_DENOISE_PREFS;
    const v = JSON.parse(raw) as Partial<Record<keyof DenoisePrefs, unknown>>;
    const timing: DenoisePrefs['timing'] = {};
    if (v.timing && typeof v.timing === 'object') {
      for (const [model, t] of Object.entries(v.timing as Record<string, Partial<DenoiseTiming>>)) {
        if (
          (DENOISE_MODELS as readonly string[]).includes(model) &&
          positive(t?.msPerTile) &&
          positive(t?.tilesPerMp)
        ) {
          timing[model as DenoiseModel] = { msPerTile: t.msPerTile, tilesPerMp: t.tilesPerMp };
        }
      }
    }
    return {
      model: (DENOISE_MODELS as readonly unknown[]).includes(v.model)
        ? (v.model as DenoiseModel)
        : DEFAULT_DENOISE.model,
      iso: positive(v.iso) ? Math.round(v.iso) : DEFAULT_NEEDS_ISO,
      amount: typeof v.amount === 'number' && v.amount >= 0 && v.amount <= 100 ? v.amount : DEFAULT_NEEDS_AMOUNT,
      timing,
    };
  } catch {
    return DEFAULT_DENOISE_PREFS;
  }
}

function save(prefs: DenoisePrefs): void {
  try {
    globalThis.localStorage?.setItem(DENOISE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the prefs last this session.
  }
}

interface DenoisePrefsState extends DenoisePrefs {
  set: (patch: Partial<Omit<DenoisePrefs, 'timing'>>) => void;
  /** Remember a finished full run's timing for `model` (ignored when nothing ran: an intermediate already there). */
  recordTiming: (model: DenoiseModel, run: { elapsedMs: number; tiles: number; width: number; height: number }) => void;
}

const prefsOf = (s: DenoisePrefs): DenoisePrefs => ({ model: s.model, iso: s.iso, amount: s.amount, timing: s.timing });

export const useDenoisePrefs = create<DenoisePrefsState>()((set, get) => ({
  ...loadDenoisePrefs(),
  set: (patch) => {
    set(patch);
    save(prefsOf(get()));
  },
  recordTiming: (model, run) => {
    const mp = (run.width * run.height) / 1e6;
    if (!positive(run.elapsedMs) || !positive(run.tiles) || !positive(mp)) return;
    set((s) => ({
      timing: { ...s.timing, [model]: { msPerTile: run.elapsedMs / run.tiles, tilesPerMp: run.tiles / mp } },
    }));
    save(prefsOf(get()));
  },
}));

/** The thresholds `needsDenoise` uses now. */
export const denoiseThresholds = (): { iso: number; amount: number } => {
  const { iso, amount } = useDenoisePrefs.getState();
  return { iso, amount };
};

/** Estimated milliseconds of a full run of `model` on a `width × height` photo, or null before any timed run. */
export function estimateDenoiseMs(
  timing: DenoiseTiming | undefined,
  width: number | undefined,
  height: number | undefined,
): number | null {
  if (!timing || !width || !height) return null;
  const tiles = Math.max(1, Math.round(((width * height) / 1e6) * timing.tilesPerMp));
  return tiles * timing.msPerTile;
}
