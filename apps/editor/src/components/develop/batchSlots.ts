import type { ReactNode } from 'react';
import { create } from 'zustand';

/**
 * The Develop batch bar's slots (workflow plan 08): every action on the selection is a slot the bar renders in `order`,
 * so a feature adds its button without touching `BatchBar`. Built in: Apply to all ▾ (0, plan 54; the one slot the
 * bar shows with nothing selected, acting on `all`), Sync selected… (10) and Reset edits (20); Paste to
 * selected (30, plan 10) is registered by `copyPaste.tsx`, Denoise selected… (50, plan 27) by `DenoiseBatch.tsx`, Apply
 * look… (40, plan 20) by `LooksSection.tsx`.
 *
 * Register at module load from a module the app imports (the feature's own component file), or from an effect that
 * returns the unregister function:
 *
 * ```tsx
 * registerBatchSlot({ id: 'paste', order: 30, render: (ctx) => <PasteButton ids={ctx.ids} /> });
 * ```
 *
 * `render` is called inside the bar on every render, so it may use hooks only through a component it returns. Style
 * buttons with `BatchButton` (`./BatchBar`). An action on several photos is one undo step: use a book store action that
 * writes them in one update (`resetDevelopMany`, `pasteDevelop`, `applyDevelopPreset`, `syncDevelop`).
 */
export interface BatchContext {
  /** Photo ids the batch acts on: the selection within the strip's list, in selection order (may be empty). */
  ids: readonly string[];
  /** The photo Develop shows (the source of Sync and Copy). */
  current: string;
  /** Plan 54: every photo the strip lists (Apply to all with nothing selected). */
  all?: readonly string[];
}

export interface BatchSlot {
  /** Unique; registering an id again replaces the slot. */
  id: string;
  /** Left to right. */
  order: number;
  render: (ctx: BatchContext) => ReactNode;
}

const useBatchSlotStore = create<{ slots: readonly BatchSlot[] }>(() => ({ slots: [] }));

/** Add (or replace, by id) a slot; returns the function that removes it. */
export function registerBatchSlot(slot: BatchSlot): () => void {
  useBatchSlotStore.setState((s) => ({
    slots: [...s.slots.filter((x) => x.id !== slot.id), slot].sort(
      (a, b) => a.order - b.order || (a.id < b.id ? -1 : 1),
    ),
  }));
  return () =>
    useBatchSlotStore.setState((s) => (s.slots.includes(slot) ? { slots: s.slots.filter((x) => x !== slot) } : s));
}

/** The registered slots in order (re-renders when one is added or removed). */
export const useBatchSlots = (): readonly BatchSlot[] => useBatchSlotStore((s) => s.slots);
