import type { AssetFlag, CullTarget, Library, PhotoGroup } from '@photobook/shared';
import { devLog } from '../lib/log';
import { useAssetsStore } from './assets';
import { useBookStore, withoutHistory } from './book';
import { type CullGroups, type CullUnit, cullGroups, cullUnits, shownFrame, useCullStore } from './cull';
import { assetFlag, type LibraryFolder, photoEntryPlace, useLibraryStore, writePhotoFields } from './library';
import { type CullDecide, type CullDecision, useUiStore } from './ui';

/**
 * The Decide pass (plan 40, CULL_PLAN 4.3): the units of the Cull list (a photo, or a group's frames in the list) that
 * still hold an undecided photo, walked one at a time with Keep (P) and Reject (X). The photo shown is the `review`
 * session's current one, so Esc lands the grid on the unit left and D develops it. Flags are written through the
 * library (`writePhotoFields`) outside undo, one store update a decision; the pass keeps its own log in
 * `ui.cull.decide` (U undoes the last decision). The folder's target and `culledAt` are library top-level fields
 * (`patchLibrary`).
 */

/** "Good place to stop?" after this long since the pass started, ms. */
export const PAUSE_AFTER_MS = 45 * 60_000;
/** ... or after this many decisions. */
export const PAUSE_AFTER_DECISIONS = 300;
/** A pass reopened after this long without a decision starts its clock again (a break was taken), ms. */
export const BREAK_MS = 15 * 60_000;

export function freshDecide(now = Date.now()): CullDecide {
  return { log: [], startedAt: now, decisions: 0, pauseDismissed: false };
}

/** The photos of a unit, in capture order. */
export const unitFrames = (unit: CullUnit): string[] => (unit.kind === 'photo' ? [unit.id] : unit.frames);

/** The flag of photo id `id` now (the library's). */
const flagNow = (id: string): AssetFlag | undefined => assetFlag(useBookStore.getState(), id);

/** Everything a Decide key reads, from the stores as they are now; null without a Cull list. */
interface DecideContext {
  ids: string[];
  groups: CullGroups | null;
  units: CullUnit[];
  /** The photo shown, and its unit's index (-1 when it is in none). */
  current: string;
  at: number;
}

/** The groups of the list, when the grid groups (`ui.cull.grouped`). */
export function decideGroups(ids: readonly string[], grouped: boolean): CullGroups | null {
  if (!grouped) return null;
  const groups = cullGroups(ids, {
    folders: useLibraryStore.getState().folders,
    libraries: useBookStore.getState().libraries,
    files: useAssetsStore.getState().files,
    spacing: useCullStore.getState().spacing,
  });
  return groups.groups.length > 0 ? groups : null;
}

function context(): DecideContext | null {
  const { review, cull } = useUiStore.getState();
  const current = review?.ids[review.index];
  if (!review || current === undefined) return null;
  const groups = decideGroups(review.ids, cull.grouped);
  const units = cullUnits(review.ids, groups);
  const at = units.findIndex((unit) => unitFrames(unit).includes(current));
  return { ids: review.ids, groups, units, current, at };
}

const undecided = (id: string) => flagNow(id) === undefined;
const hasUndecided = (unit: CullUnit) => unitFrames(unit).some(undecided);

/**
 * The frame Decide shows on arriving at a unit: a photo itself; in a group the frame the grid shows (the kept one,
 * else the suggested best) when it is undecided, else the group's first undecided frame.
 */
export function arrivalFrame(unit: CullUnit, groups: CullGroups | null, flagOf = flagNow): string {
  if (unit.kind === 'photo') return unit.id;
  const shown = groups ? shownFrame(unit, groups, flagOf) : unit.group.best;
  if (unit.frames.includes(shown) && flagOf(shown) === undefined) return shown;
  return unit.frames.find((id) => flagOf(id) === undefined) ?? unit.frames[0] ?? shown;
}

/** The nearest unit from `at` in `dir` that still holds an undecided photo, wrapping round; null when none does. */
function nextOpenUnit(units: readonly CullUnit[], at: number, dir: 1 | -1): CullUnit | null {
  const n = units.length;
  // From no unit (the photo shown left the list): every unit, from the first (or the last going back).
  const from = at < 0 ? (dir === 1 ? -1 : n) : at;
  const steps = at < 0 ? n : n - 1;
  for (let step = 1; step <= steps; step += 1) {
    const unit = units[(((from + dir * step) % n) + n) % n];
    if (unit && hasUndecided(unit)) return unit;
  }
  return null;
}

/** Show photo `id`; nothing when the list no longer holds it (a filter changed). */
function show(id: string): void {
  const { review, setReviewIndex } = useUiStore.getState();
  const at = review ? review.ids.indexOf(id) : -1;
  if (at >= 0) setReviewIndex(at);
}

/** Move on after a decision: the next open unit, else an undecided frame left in this one, else stay (the end). */
function advance(ctx: DecideContext): void {
  const next = nextOpenUnit(ctx.units, ctx.at, 1);
  if (next) {
    show(arrivalFrame(next, ctx.groups));
    return;
  }
  const unit = ctx.units[ctx.at];
  const left = unit ? unitFrames(unit).find(undecided) : undefined;
  if (left) show(left);
}

/** The group's next undecided frame after `from`, wrapping; undefined when none is left. */
function nextUndecidedFrame(frames: readonly string[], from: string): string | undefined {
  const at = frames.indexOf(from);
  for (let step = 1; step < frames.length; step += 1) {
    const id = frames[(at + step) % frames.length];
    if (id !== undefined && undecided(id)) return id;
  }
  return undefined;
}

/**
 * Write flags in one store update, outside undo (flags are never undo steps). A photo with no library entry to hold
 * it (not hashed yet) is skipped by `writePhotoFields`, which logs it.
 */
export function writeFlags(flags: Record<string, AssetFlag | null>): void {
  const entries = Object.entries(flags);
  if (entries.length === 0) return;
  withoutHistory(() =>
    useBookStore.setState((s) => {
      for (const [id, flag] of entries) writePhotoFields(s, id, { flag: flag ?? undefined });
    }),
  );
}

/** Flag photos as one decision of the pass: logged with their flags before, then written. */
function decide(ctx: DecideContext, flags: Record<string, AssetFlag>): void {
  if (Object.keys(flags).length === 0) return;
  const before: CullDecision['before'] = {};
  for (const id of Object.keys(flags)) before[id] = flagNow(id) ?? null;
  const { cull, setCull } = useUiStore.getState();
  const pass = cull.decide ?? freshDecide();
  setCull({
    decide: {
      ...pass,
      log: [...pass.log, { at: ctx.current, before }],
      decisions: pass.decisions + 1,
      lastAt: Date.now(),
    },
  });
  writeFlags(flags);
  devLog('cull', 'decide', { photos: Object.keys(flags).length, decisions: pass.decisions + 1 });
}

/** P (`stay`: Shift+P). Returns false when there is nothing to keep (no list). */
export function decideKeep(stay: boolean): boolean {
  const ctx = context();
  const unit = ctx?.units[ctx.at];
  if (!ctx || !unit) return false;
  if (unit.kind === 'photo') {
    decide(ctx, { [ctx.current]: 'pick' });
    if (!stay) advance(ctx);
    return true;
  }
  if (stay) {
    decide(ctx, { [ctx.current]: 'pick' });
    const next = nextUndecidedFrame(unit.frames, ctx.current);
    if (next) show(next);
    else advance(ctx);
    return true;
  }
  const flags: Record<string, AssetFlag> = { [ctx.current]: 'pick' };
  for (const id of unit.frames) if (id !== ctx.current && undecided(id)) flags[id] = 'reject';
  decide(ctx, flags);
  advance(ctx);
  return true;
}

/** X (`all`: Shift+X, every undecided frame of the group). */
export function decideReject(all: boolean): boolean {
  const ctx = context();
  const unit = ctx?.units[ctx.at];
  if (!ctx || !unit) return false;
  if (unit.kind === 'photo' || all) {
    const flags: Record<string, AssetFlag> = { [ctx.current]: 'reject' };
    if (all) for (const id of unitFrames(unit)) if (undecided(id)) flags[id] = 'reject';
    if (all && !undecided(ctx.current)) delete flags[ctx.current];
    decide(ctx, flags);
    advance(ctx);
    return true;
  }
  decide(ctx, { [ctx.current]: 'reject' });
  const next = nextUndecidedFrame(unit.frames, ctx.current);
  if (next) show(next);
  else advance(ctx);
  return true;
}

/** U: take back the last decision of the pass (its flags as they were) and show its photo. False with none. */
export function decideUndo(): boolean {
  const { cull, setCull } = useUiStore.getState();
  const last = cull.decide?.log.at(-1);
  if (!cull.decide || !last) return false;
  setCull({ decide: { ...cull.decide, log: cull.decide.log.slice(0, -1) } });
  writeFlags(last.before);
  show(last.at);
  return true;
}

/** ← / →: the previous / next open unit, deciding nothing. */
export function decideStep(dir: 1 | -1): boolean {
  const ctx = context();
  if (!ctx) return false;
  const next = nextOpenUnit(ctx.units, ctx.at, dir);
  if (next) show(arrivalFrame(next, ctx.groups));
  return true;
}

/** `,` / `.`: the previous / next frame of the group shown, wrapping. */
export function decideFrame(dir: 1 | -1): boolean {
  const ctx = context();
  const unit = ctx?.units[ctx.at];
  if (!ctx || unit?.kind !== 'group') return false;
  const next = unit.frames[(unit.frames.indexOf(ctx.current) + dir + unit.frames.length) % unit.frames.length];
  if (next) show(next);
  return true;
}

/** The group of the photo shown, with its frames in the list; null for a single photo. */
export function decideGroupOf(): { group: PhotoGroup; frames: string[] } | null {
  const ctx = context();
  const unit = ctx?.units[ctx.at];
  return unit?.kind === 'group' ? { group: unit.group, frames: unit.frames } : null;
}

/** C: Compare the shown frame with the group's suggested best (the next frame when it is the best); Esc comes back. */
export function decideCompare(): boolean {
  const ctx = context();
  const unit = ctx?.units[ctx.at];
  if (!ctx || unit?.kind !== 'group') return false;
  const { frames, group } = unit;
  const select =
    group.best !== ctx.current && frames.includes(group.best)
      ? group.best
      : frames[(frames.indexOf(ctx.current) + 1) % frames.length];
  if (!select || select === ctx.current) return false;
  useUiStore.getState().setCull({ view: 'compare', compare: { candidate: ctx.current, select, back: 'decide' } });
  return true;
}

/**
 * Enter on the grid (or the filter bar's *Decide*): open the pass on the focused unit, or on the next one that still
 * holds an undecided photo. The log of a pass already started on this source is kept.
 */
export function openDecide(): boolean {
  const ctx = context();
  if (!ctx) return false;
  const { cull, setCull } = useUiStore.getState();
  const unit = ctx.units[ctx.at];
  const open = unit && hasUndecided(unit) ? unit : nextOpenUnit(ctx.units, ctx.at, 1);
  if (open)
    show(
      unitFrames(open).includes(ctx.current) && undecided(ctx.current) ? ctx.current : arrivalFrame(open, ctx.groups),
    );
  // A pass reopened after a break (no decision for `BREAK_MS`) restarts the nudge's clock; the log is kept.
  const now = Date.now();
  const pass = cull.decide;
  const restart = pass && now - Math.max(pass.lastAt ?? 0, pass.startedAt) > BREAK_MS;
  setCull({ view: 'decide', decide: !pass ? freshDecide(now) : restart ? { ...pass, startedAt: now } : pass });
  return true;
}

/** Whether the pause nudge is due: 45 minutes since the pass started, or 300 decisions. */
export function pauseDue(pass: CullDecide | undefined, now: number): boolean {
  if (!pass || pass.pauseDismissed) return false;
  return pass.decisions >= PAUSE_AFTER_DECISIONS || now - pass.startedAt >= PAUSE_AFTER_MS;
}

export function dismissPause(): void {
  const { cull, setCull } = useUiStore.getState();
  if (cull.decide) setCull({ decide: { ...cull.decide, pauseDismissed: true } });
}

// Progress and target ----------------------------------------------------------------------------

export interface DecideProgress {
  total: number;
  decided: number;
  kept: number;
  rejected: number;
}

/** Decided, kept and rejected photos of a list. */
export function decideProgress(
  ids: readonly string[],
  flagOf: (id: string) => AssetFlag | undefined = flagNow,
): DecideProgress {
  let kept = 0;
  let rejected = 0;
  for (const id of ids) {
    const flag = flagOf(id);
    if (flag === 'pick') kept += 1;
    else if (flag === 'reject') rejected += 1;
  }
  return { total: ids.length, decided: kept + rejected, kept, rejected };
}

/** The number of photos a target asks to keep: itself, or its share of the list (`total`), at least one. */
export function targetCount(target: CullTarget | undefined, total: number): number | undefined {
  if (target === undefined) return undefined;
  if (typeof target === 'number') return target;
  return Math.max(1, Math.round(target.share * total));
}

/** The one folder library (its path) every photo of `ids` is in; null for a list over several folders or none. */
export function listFolder(ids: readonly string[]): string | null {
  const state = useBookStore.getState();
  let folder: string | null = null;
  for (const id of ids) {
    const place = photoEntryPlace(state, id);
    if (!place) continue;
    if (folder !== null && place.folder !== folder) return null;
    folder = place.folder;
  }
  return folder;
}

/** Set (or with undefined clear) the target of folder library `folder`; not an undo step. */
export function setCullTarget(folder: string, target: CullTarget | undefined): void {
  useBookStore.getState().patchLibrary(folder, (library) => {
    const cull = { ...library.cull, target };
    if (target === undefined) delete cull.target;
    library.cull = cull;
  });
  devLog('cull', 'target', { folder, target: target ?? null });
}

// Culled folders ---------------------------------------------------------------------------------

/** Photos of a folder that can be culled (hashed, readable), and how many of them have no flag. */
export function folderUndecided(
  folder: LibraryFolder,
  library: Library | undefined,
): { total: number; undecided: number } {
  let total = 0;
  let open = 0;
  for (const photo of Object.values(folder.photos)) {
    if (photo.hash === undefined || photo.status === 'error') continue;
    total += 1;
    const entry = library && Object.hasOwn(library.photos, photo.hash) ? library.photos[photo.hash] : undefined;
    if (entry?.flag === undefined) open += 1;
  }
  return { total, undecided: open };
}

/**
 * Whether folder `folderId` shows as culled (the sidebar's check): `culledAt` is set and no photo of it is undecided,
 * so a new photo arriving takes the check away until it is decided.
 */
export function folderCulled(folder: LibraryFolder | undefined, libraries: Readonly<Record<string, Library>>): boolean {
  const library = folder ? libraries[folder.path] : undefined;
  if (!folder || !library?.cull?.culledAt) return false;
  const { total, undecided: open } = folderUndecided(folder, library);
  return total > 0 && open === 0;
}

/** At the end of a pass: stamp `culledAt` on each folder of `ids` that has no undecided photo left (once). */
export function markCulled(ids: readonly string[]): string[] {
  const state = useBookStore.getState();
  const paths = new Set<string>();
  for (const id of ids) {
    const place = photoEntryPlace(state, id);
    if (place) paths.add(place.folder);
  }
  const folders = Object.values(useLibraryStore.getState().folders);
  const stamped: string[] = [];
  for (const path of paths) {
    const folder = folders.find((f) => f.path === path);
    const library = useBookStore.getState().libraries[path];
    if (!folder || !library || library.cull?.culledAt) continue;
    const { total, undecided: open } = folderUndecided(folder, library);
    if (total === 0 || open > 0) continue;
    useBookStore.getState().patchLibrary(path, (draft) => {
      draft.cull = { ...draft.cull, culledAt: new Date().toISOString() };
    });
    stamped.push(path);
  }
  if (stamped.length > 0) devLog('cull', 'culled', { folders: stamped.length });
  return stamped;
}
