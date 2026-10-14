import { useEffect } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import type { Folder } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { useFoldersStore } from '../../store/folders';
import { useLibraryStore } from '../../store/library';

/** Folder paths whose library is being read right now (one read per folder). */
const loading = new Set<string>();

/**
 * Load `path`'s library into the book store (`loadLibrary`, not an undo step) unless it is there or being read. The
 * library is what ratings, flags and edits of the folder's photos are read from and written to, project or not.
 */
export function ensureLibrary(path: string): void {
  if (Object.hasOwn(useBookStore.getState().libraries, path) || loading.has(path)) return;
  loading.add(path);
  void useBookStore
    .getState()
    .loadLibrary(path)
    .catch((err) => devLog('library', 'not loaded', { folder: path, error: errorMessage(err) }))
    .finally(() => loading.delete(path));
}

/**
 * The imported folders, kept ready for the library views: each one on disk is known to the library store with its
 * index read (counts and collections without a scan), and its library is loaded (again after a project open or close
 * replaced the loaded libraries).
 */
export function useLibraryFolders(): Folder[] {
  const folders = useFoldersStore((s) => s.folders);
  const loaded = useBookStore((s) => Object.keys(s.libraries).sort().join('\n'));
  useEffect(() => {
    void useFoldersStore
      .getState()
      .load()
      .catch((err) => devLog('folders', 'not listed', { error: errorMessage(err) }));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a library dropped from the store (project switch) loads again
  useEffect(() => {
    const library = useLibraryStore.getState();
    for (const folder of folders) {
      if (folder.missing) continue;
      library.addFolder(folder.id, folder.path);
      void library.loadIndex(folder.id);
      ensureLibrary(folder.path);
    }
  }, [folders, loaded]);
  return folders;
}
