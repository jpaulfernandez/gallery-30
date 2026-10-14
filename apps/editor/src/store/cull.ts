import {
  type AssetFlag,
  type GroupEntry,
  type GroupOverride,
  type GroupSpacing,
  groupPhotos,
  groupSettingsFor,
  type Library,
  newId,
  type PhotoGroup,
  suggestedBest,
} from '@photobook/shared';
import { useLayoutEffect, useMemo } from 'react';
import { create } from 'zustand';
import { devLog } from '../lib/log';
import { type AssetFile, useAssetsStore } from './assets';
import { useBookStore, withoutHistory } from './book';
import {
  type LibraryFolder,
  type PhotoFile,
  parsePhotoKey,
  photoEntryPlace,
  photoKey,
  useLibraryStore,
} from './library';
import { useUiStore } from './ui';

/**
 * Cull groups in the editor (plan 39): the groups of the photos a Cull list draws from, computed from the folder
 * index (`groupPhotos` in `@photobook/shared`) and the overrides in the folder libraries, and the actions that write
 * those overrides (`photos[hash].cull.group`). Overrides are library data written through `patchPhoto` outside undo,
 * like ratings and flags (RULES 6). The grid turns a list into units (`cullUnits`) and shows each group's frame
 * (`shownFrame`); filters, search, Cmd+A and the counts keep working on photo ids.
 */

/** The groups of a source: every group, and each photo's group by photo id. */
export interface CullGroups {
  groups: PhotoGroup[];
  byPhoto: ReadonlyMap<string, PhotoGroup>;
  /** What grouping saw of each photo, by photo id (the suggested best of a filtered group ranks on it). */
  entries: ReadonlyMap<string, GroupEntry>;
}

interface CullStore {
  /** The Group menu's *Grouping: tighter / looser* (scales the two gaps); per session. */
  spacing: GroupSpacing;
  /** The frame `,` and `.` last showed per group id, per session. */
  shown: Record<string, string>;
  /** Cull stages mounted (`useCullStageMark`): Cull's filter-bar fragment shows only while one is. */
  stages: number;
  setSpacing: (spacing: GroupSpacing) => void;
  setShown: (groupId: string, photoId: string) => void;
}

export const useCullStore = create<CullStore>()((set) => ({
  spacing: 'normal',
  shown: {},
  stages: 0,
  setSpacing: (spacing) => set({ spacing }),
  setShown: (groupId, photoId) => set((s) => ({ shown: { ...s.shown, [groupId]: photoId } })),
}));

/**
 * Mark the Cull stage as on screen while the calling component is mounted (`CullStage`), so `CullFilters` never shows
 * in the filter bar of Develop or the Design stage's Library tab, which share `LibraryFilterBar`.
 */
export function useCullStageMark(): void {
  useLayoutEffect(() => {
    useCullStore.setState((s) => ({ stages: s.stages + 1 }));
    return () => useCullStore.setState((s) => ({ stages: s.stages - 1 }));
  }, []);
}

const EMPTY_GROUPS: CullGroups = { groups: [], byPhoto: new Map(), entries: new Map() };

function entryOf(id: string, photo: PhotoFile): GroupEntry {
  const { taken, make, model, lens, focal, phash, stats } = photo;
  return { id, name: photo.relPath, taken, make, model, lens, focal, phash, stats };
}

/** What `cullGroups` reads, so a test can pass it and the hook can memoise on it. */
export interface CullGroupsInput {
  folders: Record<string, LibraryFolder>;
  libraries: Record<string, Library>;
  /** The open project's files (project asset ids), from `useAssetsStore`. */
  files: Record<string, AssetFile>;
  spacing: GroupSpacing;
}

let cache: { key: unknown[]; value: CullGroups } | null = null;

/**
 * The groups of the photos `ids` draws from. A library key's whole folder is grouped (so a group that is only partly
 * in a filter keeps its other frames, and filtering never splits or joins a burst); a project asset id groups the
 * open project's files. One result is cached, so the grid and the filter bar share it; it is keyed on the photos and
 * the overrides only, so a rating or a flag (a new `libraries` record) does not regroup.
 */
export function cullGroups(ids: readonly string[], input: CullGroupsInput): CullGroups {
  const book = useBookStore.getState();
  const folderIds = new Set<string>();
  let project = false;
  for (const id of ids) {
    if (book.book?.assets[id]) project = true;
    else {
      const parsed = parsePhotoKey(id);
      if (parsed) folderIds.add(parsed.folder);
    }
  }
  const folders = [...folderIds].sort().map((id) => input.folders[id]);

  // The overrides (and, in a project, which files are its assets) first: with the photos they are the cache key.
  const overrides = new Map<string, GroupOverride>();
  const sources: { id: string; photo: PhotoFile }[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    const photos = input.libraries[folder.path]?.photos;
    for (const photo of Object.values(folder.photos)) {
      const id = photoKey({ folder: folder.id, path: photo.relPath });
      sources.push({ id, photo });
      const group =
        photo.hash && photos && Object.hasOwn(photos, photo.hash) ? photos[photo.hash]?.cull?.group : undefined;
      if (group) overrides.set(id, group);
    }
  }
  if (project) {
    const view = { ...book, libraries: input.libraries };
    for (const file of Object.values(input.files)) {
      if (!book.book?.assets[file.assetId]) continue;
      sources.push({ id: file.assetId, photo: file });
      const place = photoEntryPlace(view, file.assetId);
      const group = place ? input.libraries[place.folder]?.photos[place.hash]?.cull?.group : undefined;
      if (group) overrides.set(file.assetId, group);
    }
  }
  const signature = [
    ...[...overrides].map(([id, group]) => `${id}=${group}`),
    ...(project ? sources.map((s) => s.id) : []),
  ].join('\n');
  const key = [...folders, project ? input.files : null, input.spacing, signature];
  if (cache && cache.key.length === key.length && cache.key.every((k, i) => k === key[i])) return cache.value;

  const entries = sources.map(({ id, photo }) => entryOf(id, photo));
  const groups = groupPhotos(entries, overrides, groupSettingsFor(input.spacing));
  const byPhoto = new Map<string, PhotoGroup>();
  for (const group of groups) for (const id of group.frames) byPhoto.set(id, group);
  const value =
    groups.length === 0 ? EMPTY_GROUPS : { groups, byPhoto, entries: new Map(entries.map((e) => [e.id, e])) };
  cache = { key, value };
  return value;
}

/** `cullGroups` as a hook: recomputed when the photos, the libraries, the project or the spacing change. */
export function useGroups(ids: readonly string[]): CullGroups {
  const folders = useLibraryStore((s) => s.folders);
  const libraries = useBookStore((s) => s.libraries);
  const book = useBookStore((s) => s.book);
  const files = useAssetsStore((s) => s.files);
  const spacing = useCullStore((s) => s.spacing);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `book` is read by `cullGroups` through the store
  return useMemo(
    () => cullGroups(ids, { folders, libraries, files, spacing }),
    [ids, folders, libraries, files, spacing, book],
  );
}

/** One cell's worth of the Cull list: a photo, or a group of two or more of the list's photos. */
export type CullUnit =
  | { kind: 'photo'; id: string }
  /** `frames`: the group's photos that are in the list, in capture order (a filter can leave only some). */
  | { kind: 'group'; group: PhotoGroup; frames: string[] };

/**
 * The list `ids` as units, in list order: a group takes the place of its first photo in the list and holds the
 * group's photos the list has. A group the list holds only one photo of is that photo. `groups` null: one unit a photo.
 */
export function cullUnits(ids: readonly string[], groups: CullGroups | null): CullUnit[] {
  if (!groups || groups.groups.length === 0) return ids.map((id) => ({ kind: 'photo', id }));
  const inList = new Set(ids);
  const done = new Set<string>();
  const units: CullUnit[] = [];
  for (const id of ids) {
    const group = groups.byPhoto.get(id);
    if (!group) {
      units.push({ kind: 'photo', id });
      continue;
    }
    if (done.has(group.id)) continue;
    const frames = group.frames.filter((f) => inList.has(f));
    if (frames.length < 2) {
      units.push({ kind: 'photo', id });
      continue;
    }
    done.add(group.id);
    units.push({ kind: 'group', group, frames });
  }
  return units;
}

/**
 * The frame a collapsed group cell shows: the focused photo when it is one of the frames, else the frame `,` / `.`
 * last showed, else the kept one when exactly one is kept, else the suggested best of the frames shown.
 */
export function shownFrame(
  unit: Extract<CullUnit, { kind: 'group' }>,
  groups: CullGroups,
  flagOf: (id: string) => AssetFlag | undefined,
  focused?: string,
  shown?: string,
): string {
  const { frames, group } = unit;
  if (focused !== undefined && frames.includes(focused)) return focused;
  if (shown !== undefined && frames.includes(shown)) return shown;
  const kept = frames.filter((id) => flagOf(id) === 'pick');
  if (kept.length === 1) return kept[0] as string;
  if (frames.includes(group.best)) return group.best;
  const entries = frames.flatMap((id) => {
    const entry = groups.entries.get(id);
    return entry ? [entry] : [];
  });
  return suggestedBest(entries) || (frames[0] as string);
}

/** Kept and rejected frames of a group cell. */
export function groupCounts(
  frames: readonly string[],
  flagOf: (id: string) => AssetFlag | undefined,
): { kept: number; rejected: number } {
  let kept = 0;
  let rejected = 0;
  for (const id of frames) {
    const flag = flagOf(id);
    if (flag === 'pick') kept++;
    else if (flag === 'reject') rejected++;
  }
  return { kept, rejected };
}

// Overrides ---------------------------------------------------------------------------------------

/**
 * Write group overrides (`undefined` clears one) to the photos' library entries, outside undo. A photo that has no
 * entry to write (not hashed yet, or its library is not loaded) is skipped and logged. Returns how many were written.
 */
function writeOverrides(assignments: ReadonlyArray<readonly [string, GroupOverride | undefined]>): number {
  let written = 0;
  withoutHistory(() => {
    for (const [id, group] of assignments) {
      const place = photoEntryPlace(useBookStore.getState(), id);
      if (!place) {
        devLog('cull', 'group override not written', { photo: id });
        continue;
      }
      useBookStore.getState().patchPhoto(place.folder, place.hash, (photo) => {
        if (group === undefined) delete photo.cull;
        else photo.cull = { group };
      });
      written++;
    }
  });
  if (written > 0) devLog('cull', 'group overrides written', { photos: written });
  return written;
}

/** Group on or off (the filter bar's *Group*); off closes the group open in place. */
export function setGrouped(on: boolean): void {
  useUiStore.getState().setCull(on ? { grouped: true } : { grouped: false, expanded: null });
}

/** Open group `id` in place in the grid (null closes it). */
export function expandGroup(id: string | null): void {
  useUiStore.getState().setCull({ expanded: id });
}

/** Detach: each of `ids` that is in a group leaves it (`'solo'`). Returns how many were written. */
export function detach(ids: readonly string[], groups: CullGroups): number {
  return writeOverrides(ids.filter((id) => groups.byPhoto.has(id)).map((id) => [id, 'solo'] as const));
}

/** Ungroup: every frame of `group` leaves it. */
export function ungroup(group: PhotoGroup): number {
  return writeOverrides(group.frames.map((id) => [id, 'solo'] as const));
}

/** The photos *Merge selected* puts in one group: `ids` and every frame of the groups they are in. */
export function mergeTargets(ids: readonly string[], groups: CullGroups): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const group = groups.byPhoto.get(id);
    for (const frame of group ? group.frames : [id]) out.add(frame);
  }
  return [...out];
}

/** True when merging `ids` would change something: two photos or more that are not already one group. */
export function canMerge(ids: readonly string[], groups: CullGroups): boolean {
  const targets = mergeTargets(ids, groups);
  if (targets.length < 2) return false;
  const first = groups.byPhoto.get(targets[0] as string);
  return !first || targets.some((id) => groups.byPhoto.get(id) !== first);
}

/** Merge selected: `ids` and the frames of their groups become one group (a new ULID). Returns how many were written. */
export function mergeSelected(ids: readonly string[], groups: CullGroups): number {
  if (!canMerge(ids, groups)) return 0;
  const merge = newId();
  return writeOverrides(mergeTargets(ids, groups).map((id) => [id, merge] as const));
}

/** True when `id`'s group can be split before it (it is in a group and not its first frame). */
export function canSplit(id: string, groups: CullGroups): boolean {
  const group = groups.byPhoto.get(id);
  return group !== undefined && group.frames.indexOf(id) > 0;
}

/**
 * Split `id`'s group before `id`: the frames before it and the frames from it on become two groups, each a new ULID;
 * a side of one frame becomes a single photo (`'solo'`). Returns how many were written.
 */
export function splitGroup(id: string, groups: CullGroups): number {
  const group = groups.byPhoto.get(id);
  const at = group ? group.frames.indexOf(id) : -1;
  if (!group || at <= 0) return 0;
  const side = (frames: number): GroupOverride => (frames > 1 ? newId() : 'solo');
  const before = side(at);
  const after = side(group.frames.length - at);
  return writeOverrides(group.frames.map((frame, i) => [frame, i < at ? before : after] as const));
}
