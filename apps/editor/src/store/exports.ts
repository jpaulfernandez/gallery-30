import {
  BUILT_IN_EXPORT_PRESETS,
  builtInExportPresets,
  type ExportCapabilities,
  type ExportPreset,
  newId,
  parseExportPreset,
  presetHash,
  uniquePresetName,
  watermarkProblem,
} from '@photobook/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors';
import { enqueueExport, planExport, resolveExportPhotos } from '../lib/jobs/export';
import { devLog } from '../lib/log';
import { deleteExportPreset, exportCapabilities, listExportPresets, saveExportPreset } from '../lib/tauri';

/**
 * Export from Develop (workflow plan 11): the user's export presets (`<appdata>/export-presets/`, next to the built-ins
 * of `@photobook/shared`), the Export dialog's target (photo ids from Develop, the Cull grid, a folder or a collection)
 * and the runs, which the completion toasts show with Reveal. Not undoable, never in a project file.
 */

/** Where the last preset used is remembered (per machine, a convenience: Cmd+Shift+E opens on it). */
const LAST_PRESET_KEY = 'photobook:export:last-preset';

export interface ExportDialogTarget {
  /** Photo ids (project asset ids or library keys), in export order. */
  ids: string[];
  /** What the dialog's title names, e.g. `DSCF1001.jpg`, `12 photos`, `Picks`. */
  title: string;
}

/** One export run, counted as its jobs settle. */
export interface ExportRun {
  id: number;
  preset: string;
  total: number;
  encoded: number;
  copied: number;
  skipped: number;
  failed: number;
  cancelled: number;
  /** Photos that could not be exported at all (not hashed yet, folder unknown). */
  missing: number;
  /** The exported files (done, skipped included), in the order they finished. */
  paths: string[];
  /** Every job settled. */
  over: boolean;
}

interface ExportsState {
  /** Saved presets, by name. */
  saved: ExportPreset[];
  loaded: boolean;
  /** What this machine can write (HEIC on macOS; plan 12), asked once with the presets. */
  caps: ExportCapabilities;
  lastPresetId: string;
  dialog: ExportDialogTarget | null;
  /** Runs (the toasts), oldest first, each until dismissed; a second Export does not hide the first one's. */
  runs: ExportRun[];
  load: () => Promise<void>;
  /** Save (create or overwrite, by id) a preset; returns it as stored. */
  save: (preset: ExportPreset) => Promise<ExportPreset>;
  remove: (id: string) => Promise<void>;
  setLastPreset: (id: string) => void;
  openDialog: (ids: readonly string[], title?: string) => void;
  closeDialog: () => void;
  dismissRun: (id: number) => void;
}

function readLast(): string {
  try {
    return localStorage.getItem(LAST_PRESET_KEY) ?? BUILT_IN_EXPORT_PRESETS[0]?.id ?? '';
  } catch {
    return BUILT_IN_EXPORT_PRESETS[0]?.id ?? '';
  }
}

const byName = (a: ExportPreset, b: ExportPreset) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

export const useExportsStore = create<ExportsState>()((set, get) => ({
  saved: [],
  loaded: false,
  caps: { heic: false },
  lastPresetId: readLast(),
  dialog: null,
  runs: [],

  load: async () => {
    // Asked alongside the presets (HEIC needs macOS); until it answers the built-ins are the portable ones.
    const caps = (async () => {
      try {
        set({ caps: await exportCapabilities() });
      } catch (err) {
        devLog('export', 'capabilities unavailable', { error: errorMessage(err) });
      }
    })();
    try {
      const files = await listExportPresets();
      const saved = files.flatMap((f) => {
        const preset = parseExportPreset(f);
        return preset && !preset.builtIn ? [preset] : [];
      });
      set({ saved: saved.sort(byName), loaded: true });
    } catch (err) {
      devLog('export', 'presets not listed', { error: errorMessage(err) });
      set({ loaded: true });
    }
    await caps;
  },

  save: async (preset) => {
    // Names are unique (two presets would share `Exports/<name>/`): a taken one gets ` 2`, ` 3`, …
    const taken = allExportPresets(get().saved, get().caps)
      .filter((p) => p.id !== preset.id)
      .map((p) => p.name);
    const stored = parseExportPreset({ ...preset, name: uniquePresetName(preset.name, taken), builtIn: false });
    if (!stored) throw new Error('This preset is not valid');
    await saveExportPreset(stored);
    set((s) => ({ saved: [...s.saved.filter((p) => p.id !== stored.id), stored].sort(byName) }));
    return stored;
  },

  remove: async (id) => {
    await deleteExportPreset(id);
    set((s) => ({ saved: s.saved.filter((p) => p.id !== id) }));
    if (get().lastPresetId === id) get().setLastPreset(BUILT_IN_EXPORT_PRESETS[0]?.id ?? '');
  },

  setLastPreset: (id) => {
    set({ lastPresetId: id });
    try {
      localStorage.setItem(LAST_PRESET_KEY, id);
    } catch {
      // Storage unavailable: the choice lasts this session.
    }
  },

  openDialog: (ids, title) => {
    if (ids.length === 0) return;
    set({ dialog: { ids: [...ids], title: title ?? (ids.length === 1 ? '1 photo' : `${ids.length} photos`) } });
  },
  closeDialog: () => set({ dialog: null }),
  dismissRun: (id) => set((s) => ({ runs: s.runs.filter((r) => r.id !== id) })),
}));

/**
 * Every preset the dialog lists: the built-ins for this machine (Full quality is HEIC where HEIC can be written),
 * then the saved ones by name.
 */
export const allExportPresets = (
  saved: readonly ExportPreset[],
  caps: ExportCapabilities = { heic: false },
): ExportPreset[] => [...builtInExportPresets(caps), ...saved];

/** A new saved preset from `draft`, named `name`. */
export const presetFromDraft = (draft: ExportPreset, name: string): ExportPreset => ({
  ...draft,
  id: newId(),
  name: name.trim(),
  builtIn: false,
});

let runSeq = 0;

/** The run with this id, for tests and the toast. */
export const exportRun = (id: number): ExportRun | undefined =>
  useExportsStore.getState().runs.find((r) => r.id === id);

/**
 * Export `ids` with `preset`: one `export` job per photo (an equal job already queued is joined), counted into a run
 * of its own (a toast) as they settle. `replace` lets it overwrite destination files that are not exports of these
 * photos (the dialog asks first). Resolves once every job is over, with the run.
 */
export async function startExport(
  ids: readonly string[],
  preset: ExportPreset,
  { replace = false }: { replace?: boolean } = {},
): Promise<ExportRun> {
  // Checked once before anything is queued: an incomplete watermark would fail every job.
  const problem = watermarkProblem(preset.options.watermark);
  if (problem) throw new Error(problem);
  const { photos, missing } = await resolveExportPhotos(ids);
  const planned = await planExport(photos, preset);
  const hash = await presetHash(preset.options);
  const id = ++runSeq;
  const run: ExportRun = {
    id,
    preset: preset.name,
    total: planned.length,
    encoded: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    missing,
    paths: [],
    over: planned.length === 0,
  };
  useExportsStore.setState((s) => ({ runs: [...s.runs, run] }));
  devLog('export', 'start', { preset: preset.name, photos: planned.length, missing, presetHash: hash });
  const update = (change: (r: ExportRun) => Partial<ExportRun>) =>
    useExportsStore.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...change(r) } : r)) }));
  const handles = planned.map((p) =>
    enqueueExport({
      planned: p,
      exportOptions: preset.options,
      presetHash: hash,
      skipExported: preset.skipExported,
      replace,
    }),
  );
  await Promise.all(
    handles.map(async (handle) => {
      const outcome = await handle.result;
      if (outcome.state === 'done') {
        const r = outcome.value;
        update((s) => ({
          encoded: s.encoded + (r.encoded ? 1 : 0),
          copied: s.copied + (!r.encoded && !r.skipped ? 1 : 0),
          skipped: s.skipped + (r.skipped ? 1 : 0),
          paths: [...s.paths, r.path],
        }));
      } else if (outcome.state === 'failed') update((s) => ({ failed: s.failed + 1 }));
      else update((s) => ({ cancelled: s.cancelled + 1 }));
    }),
  );
  update(() => ({ over: true }));
  const summary = exportRun(id) ?? { ...run, over: true };
  devLog('export', 'done', {
    preset: preset.name,
    encoded: summary.encoded,
    copied: summary.copied,
    skipped: summary.skipped,
    failed: summary.failed,
    cancelled: summary.cancelled,
  });
  return summary;
}
