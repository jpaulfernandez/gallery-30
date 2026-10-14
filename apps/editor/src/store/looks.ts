import { useMemo } from 'react';
import { create } from 'zustand';
import {
  allLooks,
  chosenLookId,
  isLook,
  lookDefaultAmount,
  NO_LOOK,
  setLookLookup,
  stepLookId,
} from '../lib/develop/looks';
import type { Preset } from '../lib/develop/presets';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';
import { deletePreset, listPresets, savePreset } from '../lib/tauri';
import { useBookStore } from './book';
import { assetDevelop } from './library';

/**
 * Looks (workflow plan 20): the user's saved looks (presets with `look: true` in `<appdata>/presets/`) for the Looks
 * strip, the batch bar's Apply look… and the filmstrip badge. Not undoable and not part of any project. The built-in
 * looks (plan 21) come first through `allLooks`.
 */
interface LooksState {
  /** The saved looks, by name (after `load`). */
  saved: Preset[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Write a look (new or renamed) and list it. */
  save: (look: Preset) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const byName = (a: Preset, b: Preset) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** The listing in flight, shared by every caller of `load`. */
let loading: Promise<void> | null = null;

export const useLooksStore = create<LooksState>((set) => ({
  saved: [],
  loaded: false,
  error: null,

  load: () => {
    // One listing at a time (every filmstrip badge may ask at once).
    loading ??= listLooks().finally(() => {
      loading = null;
    });
    return loading;
  },

  save: async (look) => {
    const stored: Preset = { ...look, look: true, builtIn: false };
    await savePreset(stored);
    set((s) => ({ saved: [...s.saved.filter((l) => l.id !== look.id), stored].sort(byName) }));
  },

  remove: async (id) => {
    await deletePreset(id);
    set((s) => ({ saved: s.saved.filter((l) => l.id !== id) }));
  },
}));

async function listLooks(): Promise<void> {
  const set = useLooksStore.setState;
  try {
    // Through a promise, so a missing command (tests, an older backend) is an error here, not a throw.
    const presets = await Promise.resolve().then(() => listPresets());
    set({ saved: presets.filter(isLook).sort(byName), loaded: true, error: null });
  } catch (err) {
    devLog('develop', 'could not list looks', { error: String(err) });
    set({ loaded: true, error: errorMessage(err) });
  }
}

/** Built-in looks, then the saved ones. */
export const useAllLooks = (): Preset[] => {
  const saved = useLooksStore((s) => s.saved);
  return useMemo(() => allLooks(saved), [saved]);
};

/** The look with `id` among the built-in and saved ones (for `replaceLook`, the badge, the locked Amount). */
export function findLook(id: string): Preset | undefined {
  return allLooks(useLooksStore.getState().saved).find((l) => l.id === id);
}

// Sync and Copy (lib/develop/sync.ts) ask through this whether a copied `look.applied` still holds.
setLookLookup(findLook);

/**
 * Switch photos to the look `id` (`none`: no look) at `amount` (default `lookDefaultAmount`: a built-in look's own,
 * 100 for a saved one), one undo step. Returns how many changed; an unknown id changes nothing.
 */
export function applyLookTo(ids: readonly string[], id: string, amount?: number): number {
  const look = id === NO_LOOK ? null : findLook(id);
  if (id !== NO_LOOK && !look) return 0;
  // Plan 21: without an Amount a built-in look starts at its own, a saved look at 100.
  const at = amount ?? lookDefaultAmount(look);
  const changed = useBookStore.getState().applyDevelopLook(ids, look ?? null, at, findLook);
  devLog('develop', 'applied look', { id, amount: at, photos: ids.length, changed });
  return changed;
}

/** `[` / `]` in Develop: the previous / next look (None first) on the photo shown, at its starting Amount. */
export function stepLook(assetId: string, dir: 1 | -1): boolean {
  const state = useBookStore.getState();
  const settings = assetDevelop(state, assetId);
  const chosen = settings ? chosenLookId(settings) : NO_LOOK;
  const next = stepLookId(allLooks(useLooksStore.getState().saved), chosen, dir);
  if (next === null) return false;
  applyLookTo([assetId], next);
  return true;
}

/** The name of the look a photo's settings name (`look.applied`), else its LUT's; null without either. */
export function lookNameOf(
  saved: readonly Preset[],
  look: { applied: { presetId: string } | null; lut: { name: string } | null } | undefined,
): string | null {
  if (!look) return null;
  if (look.applied) {
    const id = look.applied.presetId;
    return allLooks(saved).find((l) => l.id === id)?.name ?? null;
  }
  return look.lut?.name ?? null;
}
