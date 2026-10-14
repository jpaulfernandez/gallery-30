import { create } from 'zustand';
import { nextDenoiseJob } from '../lib/denoise';
import { fittedPresetName } from '../lib/develop/cameraPairs';
import { isLook, makeLutLook } from '../lib/develop/looks';
import type { Preset } from '../lib/develop/presets';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';
import {
  cancelDevelop,
  deleteLut,
  type FilmTag,
  type FitLutResult,
  type FitPair,
  filmSimulation,
  fitLut,
  importLut,
  type LutInfo,
  listLuts,
  listPresets,
  lutPresent,
  onFitLutProgress,
  savePreset,
} from '../lib/tauri';
import { refreshLutMissing } from './assets';
import { enqueue, JobCancelled, type JobHandle } from './jobs';

/**
 * User 3D LUTs (workflow plan 18): the files in `<appData>/luts/` (`commands/luts.rs`) and which ids are on this
 * machine. Not undoable and not part of any project: a photo's `develop.look.lut` names a LUT by id and the render
 * reads the file; a missing one is skipped and the Look section says so.
 */
interface LutsState {
  /** The stored LUTs, by name (after `load`). */
  luts: LutInfo[];
  loaded: boolean;
  error: string | null;
  /** Whether each id asked about (or listed, imported, deleted) has its file. */
  present: Record<string, boolean>;
  /**
   * Bumped whenever a LUT file may have come back (an import, or a check that found a missing one present): the
   * settings did not change but the pixels do, so previews of photos with a LUT render again.
   */
  epoch: number;
  load: () => Promise<void>;
  /** Import a `.cube` or HALD `.png` picked in the open dialog; rejects with the reason (1D LUT, bad size, ...). */
  importFile: (path: string) => Promise<LutInfo>;
  /** Delete a stored LUT's file (photos that use it then show it as missing). */
  remove: (id: string) => Promise<void>;
  /** Ask whether `id`'s file exists (cached in `present`). */
  checkPresent: (id: string) => Promise<boolean>;
}

const byName = (a: LutInfo, b: LutInfo) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

export const useLutsStore = create<LutsState>((set, get) => ({
  luts: [],
  loaded: false,
  error: null,
  present: {},
  epoch: 0,

  load: async () => {
    try {
      const luts = await listLuts();
      set((s) => ({
        luts,
        loaded: true,
        error: null,
        present: { ...s.present, ...Object.fromEntries(luts.map((l) => [l.id, true])) },
      }));
    } catch (err) {
      devLog('develop', 'could not list LUTs', { error: String(err) });
      set({ error: errorMessage(err) });
    }
  },

  importFile: async (path) => {
    const info = await importLut(path);
    devLog('develop', 'imported LUT', { id: info.id, name: info.name, size: info.size });
    set((s) => ({
      luts: [...s.luts.filter((l) => l.id !== info.id), info].sort(byName),
      present: { ...s.present, [info.id]: true },
      // Even the same file again: it may have been missing or broken until now (Locate on the same file).
      epoch: s.epoch + 1,
    }));
    refreshLutMissing();
    return info;
  },

  remove: async (id) => {
    await deleteLut(id);
    set((s) => ({ luts: s.luts.filter((l) => l.id !== id), present: { ...s.present, [id]: false } }));
  },

  checkPresent: async (id) => {
    try {
      const ok = await lutPresent(id);
      const was = get().present[id];
      if (was !== ok) {
        const back = ok && was === false;
        set((s) => ({ present: { ...s.present, [id]: ok }, epoch: back ? s.epoch + 1 : s.epoch }));
        if (back) refreshLutMissing();
      }
      return ok;
    } catch (err) {
      devLog('develop', 'could not check a LUT', { id, error: String(err) });
      return true;
    }
  },
}));

// ---------- Workflow plan 22: Match camera JPEG ----------

/** The film tag of `${folder}/${relPath}`, read once per file (null for other cameras and untagged files). */
const simulations = new Map<string, Promise<FilmTag | null>>();
/** Most `film_simulation` reads at once (each reads up to 128 KB of one file). */
export const FILM_TAG_READS = 8;
let reading = 0;
const waiting: (() => void)[] = [];

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (reading >= FILM_TAG_READS) await new Promise<void>((resolve) => waiting.push(resolve));
  reading += 1;
  try {
    return await work();
  } finally {
    reading -= 1;
    waiting.shift()?.();
  }
}

/** Forget the tags read so far (tests). */
export function resetFilmSimulations(): void {
  simulations.clear();
}

/** The Fujifilm film simulation and camera of a file, read on demand, at most `FILM_TAG_READS` at a time. */
export function filmSimulationOf(folder: string, relPath: string): Promise<FilmTag | null> {
  const key = `${folder}\u0000${relPath}`;
  let known = simulations.get(key);
  if (!known) {
    // Through a promise, so a failure of any kind (even before the call) is a null, not a throw.
    known = limited(() => Promise.resolve().then(() => filmSimulation(folder, relPath))).catch((err) => {
      devLog('develop', 'could not read the film simulation', { relPath, error: String(err) });
      simulations.delete(key);
      return null;
    });
    simulations.set(key, known);
  }
  return known;
}

/** The LUT id a saved preset's `look` section names, if any. */
function presetLutId(preset: Preset): string | undefined {
  const look = (preset.settings as { look?: { lut?: { id?: string } | null } }).look;
  return look?.lut?.id;
}

/**
 * Save the look preset of a fitted LUT (plan 20's `makeLutLook`: `look: true`, the LUT at full strength), named after
 * it (`Classic Chrome (fitted)`). Nothing is added when a look already uses this LUT; a preset of the same name is
 * replaced (same id) rather than duplicated.
 */
export async function saveFittedLook(info: Pick<LutInfo, 'id' | 'name'>): Promise<void> {
  const saved = await listPresets();
  if (saved.some((p) => isLook(p) && presetLutId(p) === info.id)) return;
  const name = fittedPresetName(info.name);
  const same = saved.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
  await savePreset(makeLutLook(name, info, same?.id));
}

/** A fitted LUT joins the list, and its look preset is saved ([`saveFittedLook`]). */
async function adoptFitted(result: FitLutResult): Promise<void> {
  const info = result.lut;
  useLutsStore.setState((s) => ({
    luts: [...s.luts.filter((l) => l.id !== info.id), info].sort(byName),
    present: { ...s.present, [info.id]: true },
    // The same lattice may have been missing until now.
    epoch: s.epoch + 1,
  }));
  refreshLutMissing();
  try {
    await saveFittedLook(info);
  } catch (err) {
    devLog('develop', 'could not save the fitted look preset', { id: info.id, error: String(err) });
  }
}

/**
 * Queue a Match camera JPEG fit of `pairs` (RAW + JPEG, relative to `folder`) as a `render` job: progress from
 * `lut:fit-progress`, Cancel through `cancelDevelop`. On success the LUT is in the list and its look preset saved.
 */
export function enqueueLutFit(options: {
  folder: string;
  pairs: FitPair[];
  name: string;
  project?: string | null;
}): JobHandle<FitLutResult> {
  const { folder, pairs, name, project } = options;
  return enqueue({
    kind: 'render',
    label: `Match camera JPEG: ${name.trim() || 'camera look'}`,
    project,
    run: async (ctx) => {
      const job = nextDenoiseJob();
      ctx.progress(0, pairs.length * 2 + 20);
      const unlisten = await onFitLutProgress((e) => {
        if (e.job === job) ctx.progress(e.done, e.total, e.detail);
      });
      ctx.onCancel(() => cancelDevelop(job));
      try {
        if (ctx.cancelled) throw new JobCancelled();
        let result: FitLutResult;
        try {
          result = await fitLut(folder, pairs, name, job);
        } catch (err) {
          if (errorMessage(err) === 'Cancelled') throw new JobCancelled();
          throw err;
        }
        devLog('develop', 'fitted LUT', {
          id: result.lut.id,
          pairs: result.lut.fitted?.pairs ?? 0,
          meanDeltaE: Math.round(result.meanDeltaE * 100) / 100,
        });
        await adoptFitted(result);
        return result;
      } finally {
        unlisten();
      }
    },
  });
}
