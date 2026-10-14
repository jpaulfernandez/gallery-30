import type { Library } from '@photobook/shared';
import { useMemo } from 'react';
import { create } from 'zustand';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { readProject, type TrashResult, trashPhotos } from '../../lib/tauri';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { projectPaths } from '../../store/collections';
import { enqueue, JobCancelled } from '../../store/jobs';
import {
  assetFolderPath,
  type LibraryFolder,
  libraryFolderAt,
  type PhotoFile,
  parsePhotoKey,
  photoKey,
  useLibraryStore,
} from '../../store/library';
import { useProjectsStore } from '../../store/projects';
import { useUiStore } from '../../store/ui';

/**
 * Plan 42 (CULL_PLAN 4.5): the reject pile and the move to the Trash. The pile is every reject of the folders the Cull
 * list draws from, whatever the filter shows (the Lightroom lesson); `RejectPileView` shows it, and `moveToTrash` is the
 * only way a photo leaves its folder: `trashPhotos` per folder in chunks, then `dropPhotos` for what moved.
 */

/** One reject of the pile, by library key (`photoKey`). */
export interface PileEntry {
  key: string;
  folderId: string;
  folderPath: string;
  relPath: string;
  size: number;
}

/** `${folderPath}\n${relPath}`: a photo the same way across library keys, project assets and project files. */
const placeKey = (folderPath: string, relPath: string) => `${folderPath}\n${relPath}`;

/** The library folders (registry ids) the photos `ids` (library keys or the open project's asset ids) are in. */
export function pileFolders(ids: readonly string[], folders: Record<string, LibraryFolder>): string[] {
  const { book, folder: primary } = useBookStore.getState();
  const out = new Set<string>();
  for (const id of ids) {
    const parsed = parsePhotoKey(id);
    if (parsed && Object.hasOwn(folders, parsed.folder)) {
      out.add(parsed.folder);
      continue;
    }
    const asset = book?.assets[id];
    const path = asset ? assetFolderPath(book, asset, primary) : null;
    const folder = libraryFolderAt({ folders }, path);
    if (folder) out.add(folder.id);
  }
  return [...out];
}

/** Every reject of `folderIds` (hashed photos whose library entry is flagged reject), folder by folder, by path. */
export function rejectPile(
  folderIds: readonly string[],
  folders: Record<string, LibraryFolder>,
  libraries: Readonly<Record<string, Library>>,
): PileEntry[] {
  const out: PileEntry[] = [];
  for (const folderId of folderIds) {
    const folder = folders[folderId];
    const library = folder ? libraries[folder.path] : undefined;
    if (!folder || !library) continue;
    const paths = Object.keys(folder.photos).sort();
    for (const relPath of paths) {
      const photo: PhotoFile | undefined = folder.photos[relPath];
      const hash = photo?.hash;
      if (!photo || !hash || !Object.hasOwn(library.photos, hash) || library.photos[hash]?.flag !== 'reject') continue;
      out.push({
        key: photoKey({ folder: folderId, path: relPath }),
        folderId,
        folderPath: folder.path,
        relPath,
        size: photo.size,
      });
    }
  }
  return out;
}

const NO_IDS: readonly string[] = [];

/** The reject pile of the Cull list shown now (`ui.review`): every reject of its folders, never the filtered view. */
export function useRejectPile(): PileEntry[] {
  const ids = useUiStore((s) => s.review?.ids) ?? NO_IDS;
  const folders = useLibraryStore((s) => s.folders);
  const libraries = useBookStore((s) => s.libraries);
  const book = useBookStore((s) => s.book);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `book` stands for the store read by `pileFolders`
  return useMemo(() => rejectPile(pileFolders(ids, folders), folders, libraries), [ids, folders, libraries, book]);
}

/** Whether the pile view is open (over the Cull stage's view; another source or leaving Cull closes it). */
export const useRejectPileStore = create<{ open: boolean }>()(() => ({ open: false }));
export const openRejectPile = (): void => useRejectPileStore.setState({ open: true });
export const closeRejectPile = (): void => useRejectPileStore.setState({ open: false });

/** "3.1 GB", "420 MB" (decimal, like Finder). */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/**
 * Which pile photos a project holds (the open one from memory, the others from their files), and those projects. A
 * project that could not be checked (its file unreadable or not JSON, listed with an error, or the list itself not
 * read) is named in `unchecked`, and its folders' photos (every pile folder when its folders are unknown) are in
 * `uncheckedFolders`: kept like placed ones, so the check never fails open.
 */
export interface Placement {
  keys: Set<string>;
  titles: string[];
  /** The ids of the projects in `titles`, in the same order (plan 52's Photo pane links them). */
  ids: string[];
  unchecked: string[];
  uncheckedFolders: Set<string>;
}

/** The assets of a project file read loosely: `{ path, folder? }` by id; null when the text is not a project. */
function fileAssets(text: string): Array<{ path: string; folder?: string }> | null {
  try {
    const assets = (JSON.parse(text) as { assets?: unknown }).assets;
    if (!assets || typeof assets !== 'object') return null;
    return Object.values(assets as Record<string, unknown>).flatMap((a) => {
      if (!a || typeof a !== 'object') return [];
      const { path, folder } = a as { path?: unknown; folder?: unknown };
      return typeof path === 'string' ? [{ path, ...(typeof folder === 'string' ? { folder } : {}) }] : [];
    });
  } catch {
    return null;
  }
}

/** A folder path as compared here: without a trailing slash. */
const samePath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * The pile photos placed in any project (as an asset, like *Hide in project*): the open project from the book store,
 * every other listed project from its file, through the folder paths Home resolved for it. Whatever cannot be read is
 * `unchecked` (see `Placement`), never skipped.
 */
export async function placedInProjects(entries: readonly PileEntry[]): Promise<Placement> {
  const wanted = new Map(entries.map((e) => [placeKey(e.folderPath, e.relPath), e.key]));
  const pileFolders = new Set(entries.map((e) => e.folderPath));
  const keys = new Set<string>();
  const titles: string[] = [];
  const ids: string[] = [];
  const unchecked: string[] = [];
  const uncheckedFolders = new Set<string>();
  const take = (id: string, title: string, places: Iterable<string>) => {
    let hit = false;
    for (const place of places) {
      const key = wanted.get(place);
      if (key) {
        keys.add(key);
        hit = true;
      }
    }
    if (hit) {
      titles.push(title || 'Untitled');
      ids.push(id);
    }
  };
  const notChecked = (title: string, folders: readonly string[] | null) => {
    const ours = folders?.filter((f) => pileFolders.has(f)) ?? [...pileFolders];
    if (folders !== null && ours.length === 0) return;
    unchecked.push(title || 'Untitled');
    for (const f of ours.length > 0 ? ours : pileFolders) uncheckedFolders.add(f);
  };
  const { book, folder: primary, projectId } = useBookStore.getState();
  if (book) take(projectId ?? '', book.title, projectPaths(book, primary));
  let projects = useProjectsStore.getState().projects;
  if (projects.length === 0) {
    try {
      projects = await useProjectsStore.getState().load();
    } catch (err) {
      devLog('cull', 'projects not listed for the pile', { error: errorMessage(err) });
      notChecked('the project list', null);
      projects = [];
    }
  }
  for (const project of projects) {
    if (project.id === projectId) continue;
    const folders = project.folders.map((f) => samePath(f.path));
    if (project.error !== null) {
      notChecked(project.title, folders.length > 0 ? folders : null);
      continue;
    }
    if (!folders.some((f) => pileFolders.has(f))) continue;
    try {
      const assets = fileAssets(await readProject(project.id));
      if (assets === null) throw new Error('not a project file');
      const byId = new Map(project.folders.map((f) => [f.id, samePath(f.path)]));
      const fallback = folders[0];
      const places = assets.flatMap((a) => {
        const path = (a.folder !== undefined ? byId.get(a.folder) : undefined) ?? fallback;
        return path ? [placeKey(path, a.path)] : [];
      });
      take(project.id, project.title, places);
    } catch (err) {
      devLog('cull', 'project not read for the pile', { project: project.id, error: errorMessage(err) });
      notChecked(project.title, folders);
    }
  }
  return { keys, titles, ids, unchecked, uncheckedFolders };
}

/** The pile photos the dialog keeps in the folder by default: the placed ones and those of unchecked folders. */
export function keptByDefault(entries: readonly PileEntry[], placement: Placement): Set<string> {
  const kept = new Set(placement.keys);
  for (const e of entries) if (placement.uncheckedFolders.has(e.folderPath)) kept.add(e.key);
  return kept;
}

/** Files per `trashPhotos` call: a cancel stops between chunks, and each chunk's photos are dropped as they go. */
export const TRASH_CHUNK = 20;
/** Up to this many photos move inline (seconds); a bigger pile runs as a `trash` job with progress and cancel. */
export const TRASH_INLINE_MAX = 10;

export interface TrashOutcome {
  moved: number;
  failed: Array<{ path: string; error: string }>;
  cancelled: boolean;
}

/**
 * Move the Cull focus off photos that went or may still go: onto the next photo of the list that stays (the next
 * unit). Called before each drop, so a photo that failed to move can take the focus.
 */
function focusPastMoving(entries: readonly PileEntry[]): void {
  const ui = useUiStore.getState();
  const review = ui.review;
  if (!review) return;
  const { book, folder: primary } = useBookStore.getState();
  const { folders } = useLibraryStore.getState();
  const going = new Set(entries.map((e) => placeKey(e.folderPath, e.relPath)));
  const placeOf = (id: string): string | null => {
    const parsed = parsePhotoKey(id);
    const folder = parsed ? folders[parsed.folder] : undefined;
    if (parsed && folder) return placeKey(folder.path, parsed.path);
    const asset = book?.assets[id];
    const path = asset ? assetFolderPath(book, asset, primary) : null;
    return asset && path ? placeKey(path, asset.path) : null;
  };
  const stays = (id: string) => !going.has(placeOf(id) ?? '');
  const current = review.ids[review.index];
  if (current === undefined || stays(current)) return;
  const after = review.ids.slice(review.index + 1).find(stays);
  const before = review.ids.slice(0, review.index).reverse().find(stays);
  const next = after ?? before;
  if (next !== undefined) ui.setReviewIndex(review.ids.indexOf(next));
}

/** The open project's assets whose file just went to the Trash show as Missing, as after a relink that found nothing. */
function markMissing(folderPath: string, relPaths: readonly string[]): void {
  const { book, folder: primary } = useBookStore.getState();
  if (!book) return;
  const gone = new Set(relPaths);
  const missing = { ...useAssetsStore.getState().missing };
  let changed = false;
  for (const [assetId, asset] of Object.entries(book.assets)) {
    if (assetFolderPath(book, asset, primary) !== folderPath || !gone.has(asset.path)) continue;
    missing[assetId] = {
      assetId,
      path: asset.path,
      ...(folderPath !== primary ? { folder: folderPath } : {}),
      ...(asset.hash ? { hash: asset.hash } : {}),
      ...(asset.size !== undefined ? { size: asset.size } : {}),
    };
    changed = true;
  }
  if (changed) useAssetsStore.setState({ missing });
}

/**
 * Move `entries` to the Trash folder by folder, `TRASH_CHUNK` files per call; after each call the moved photos leave
 * the library, the index and the store (`dropPhotos`). Not an undo step. `progress` and `cancelled` come from the job.
 */
export async function trashEntries(
  entries: readonly PileEntry[],
  progress?: (done: number, total: number) => void,
  cancelled?: () => boolean,
  outcome: TrashOutcome = { moved: 0, failed: [], cancelled: false },
): Promise<TrashOutcome> {
  const byFolder = new Map<string, PileEntry[]>();
  for (const e of entries) byFolder.set(e.folderId, [...(byFolder.get(e.folderId) ?? []), e]);
  // What may still go: shrinks as each chunk reports, so the focus never lands on a photo about to leave.
  const pending = new Set(entries);
  let done = 0;
  for (const [folderId, list] of byFolder) {
    const folderPath = list[0]?.folderPath ?? '';
    for (let i = 0; i < list.length; i += TRASH_CHUNK) {
      if (cancelled?.()) {
        outcome.cancelled = true;
        return outcome;
      }
      const chunk = list.slice(i, i + TRASH_CHUNK).map((e) => e.relPath);
      let results: TrashResult[];
      try {
        results = await trashPhotos(folderPath, chunk);
      } catch (err) {
        results = chunk.map((path) => ({ path, ok: false, error: errorMessage(err), sidecars: [] }));
      }
      const moved = results.filter((r) => r.ok).map((r) => r.path);
      for (const r of results) if (!r.ok) outcome.failed.push({ path: r.path, error: r.error ?? 'Not moved' });
      // Counted before anything else can throw: these files are in the Trash whatever happens next.
      outcome.moved += moved.length;
      const gone = new Set(moved);
      const reported = new Set(chunk);
      for (const e of list) if (reported.has(e.relPath) && !gone.has(e.relPath)) pending.delete(e);
      if (moved.length > 0) {
        focusPastMoving([...pending]);
        await useBookStore.getState().dropPhotos(folderId, moved);
        markMissing(folderPath, moved);
        for (const e of list) if (gone.has(e.relPath)) pending.delete(e);
      }
      done += chunk.length;
      progress?.(done, entries.length);
    }
  }
  devLog('cull', 'moved to the Trash', { moved: outcome.moved, failed: outcome.failed.length });
  return outcome;
}

/** Up to three failures named, then "and N more". */
export function failureText(failed: TrashOutcome['failed']): string {
  const named = failed.slice(0, 3).map((f) => (f.path ? `${f.path} (${f.error})` : f.error));
  const more = failed.length > 3 ? `, and ${failed.length - 3} more` : '';
  return `${named.join(', ')}${more}`;
}

/** What the toast says when the move is over. */
export function outcomeText(outcome: TrashOutcome): string {
  const moved = `Moved ${outcome.moved} ${outcome.moved === 1 ? 'photo' : 'photos'} to the Trash`;
  const stopped = outcome.cancelled ? ' (stopped)' : '';
  if (outcome.failed.length === 0) return `${moved}${stopped}`;
  return `${moved}${stopped}. Not moved: ${failureText(outcome.failed)}`;
}

/**
 * Move `entries` to the Trash: inline for a few, else as a `trash` job (progress and cancel in the jobs bar). Resolves
 * with what happened, the files moved before an error included; never rejects.
 */
export async function moveToTrash(entries: readonly PileEntry[]): Promise<TrashOutcome> {
  const outcome: TrashOutcome = { moved: 0, failed: [], cancelled: false };
  if (entries.length <= TRASH_INLINE_MAX) {
    try {
      await trashEntries(entries, undefined, undefined, outcome);
    } catch (err) {
      outcome.failed.push({ path: '', error: errorMessage(err) });
    }
    return outcome;
  }
  const handle = enqueue({
    kind: 'trash',
    label: `Move ${entries.length} to the Trash`,
    run: async (ctx) => {
      ctx.onCancel(() => {});
      ctx.progress(0, entries.length);
      await trashEntries(
        entries,
        (done, total) => ctx.progress(done, total),
        () => ctx.cancelled,
        outcome,
      );
      if (outcome.cancelled) throw new JobCancelled();
      return outcome;
    },
  });
  const result = await handle.result;
  if (result.state === 'failed') outcome.failed.push({ path: '', error: result.error });
  return outcome;
}
