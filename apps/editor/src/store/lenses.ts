import { type LensEntry, type LensVerdict, lensOf } from '@photobook/shared';
import { useMemo } from 'react';
import { type AssetFile, fileOfAsset, useAssetsStore } from './assets';
import { folderLensStats, lensEntry } from './collections';
import { type LibraryFolder, type PhotoFile, parsePhotoKey, useLibraryStore } from './library';

/**
 * Technical lenses in the editor (plan 41): the shared `lensOf` over the Cull list's photos. A library key reads its
 * folder's Soft cut (`folderLensStats` over the folder's photos); a project asset id reads the open project's files as
 * one folder. Read-only: nothing here writes a flag or the library.
 */

/** A photo's lens reading: what the lenses read of it and where it stands. */
export interface LensReading {
  entry: LensEntry;
  verdict: LensVerdict;
}

/** The lens reading of a Cull list id; null for a photo without stats (or unknown). */
export function lensReading(
  id: string,
  folders: Record<string, LibraryFolder>,
  files: Record<string, AssetFile>,
): LensReading | null {
  const parsed = parsePhotoKey(id);
  const folder = parsed ? folders[parsed.folder] : undefined;
  if (parsed && folder && Object.hasOwn(folder.photos, parsed.path)) {
    const photo = folder.photos[parsed.path] as PhotoFile;
    const entry = lensEntry(photo);
    const verdict = lensOf(entry, folderLensStats(folder.photos));
    return verdict ? { entry, verdict } : null;
  }
  const file = fileOfAsset(files, id);
  if (!file) return null;
  const entry = lensEntry(file);
  const verdict = lensOf(entry, folderLensStats(files));
  return verdict ? { entry, verdict } : null;
}

/** `lensReading` as a hook: a function of the id, new when the folders or the project's files change. */
export function useLensReading(): (id: string) => LensReading | null {
  const folders = useLibraryStore((s) => s.folders);
  const files = useAssetsStore((s) => s.files);
  return useMemo(() => (id: string) => lensReading(id, folders, files), [folders, files]);
}
