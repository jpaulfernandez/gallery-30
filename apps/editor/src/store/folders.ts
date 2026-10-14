import { open } from '@tauri-apps/plugin-dialog';
import { create } from 'zustand';
import { devLog } from '../lib/log';
import { type Folder, importFolder, listFolders, removeFolder, renameFolder } from '../lib/tauri';

/**
 * The imported folders (`<appData>/folders.json`, owned by Rust). Not part of any project file and never undone:
 * every action goes straight to its command and then mirrors the result here.
 */
export interface FoldersState {
  folders: Folder[];
  /** Read the registry. */
  load: () => Promise<Folder[]>;
  /** Pick a folder in the native dialog and import it. Null when the dialog was cancelled. */
  import: () => Promise<Folder | null>;
  /** Forget a folder (its `.photobook/` files stay on disk). */
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
}

export const useFoldersStore = create<FoldersState>()((set, get) => ({
  folders: [],

  load: async () => {
    const folders = await listFolders();
    set({ folders });
    devLog('folders', 'loaded', { count: folders.length, missing: folders.filter((f) => f.missing).length });
    return folders;
  },

  import: async () => {
    const path = await open({ directory: true, multiple: false, title: 'Import a photo folder' });
    if (typeof path !== 'string') return null;
    const folder = await importFolder(path);
    set({ folders: upsert(get().folders, folder) });
    devLog('folders', 'imported', { id: folder.id, name: folder.name });
    return folder;
  },

  remove: async (id) => {
    await removeFolder(id);
    set({ folders: get().folders.filter((f) => f.id !== id) });
    devLog('folders', 'removed', { id });
  },

  rename: async (id, name) => {
    const folder = await renameFolder(id, name);
    set({ folders: upsert(get().folders, folder) });
  },
}));

/** Replace the folder with the same id in place, or append it (the registry's import order). */
function upsert(folders: Folder[], folder: Folder): Folder[] {
  const i = folders.findIndex((f) => f.id === folder.id);
  if (i === -1) return [...folders, folder];
  return folders.map((f, j) => (j === i ? folder : f));
}
