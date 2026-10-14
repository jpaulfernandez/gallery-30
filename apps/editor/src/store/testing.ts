import { type AssetFile, useAssetsStore } from './assets';
import { useBookStore } from './book';
import { assetFolderPath, type LibraryFolder, useLibraryStore } from './library';

/**
 * Test support: put project files (the shape `useAssetsStore.files` derives) into the library store, each under the
 * folder its asset lives in (the book's folder id; the absolute `folder` of a file in another folder), so `files`,
 * `photoFileOf` and the develop renders find them. Call after the book is in the book store.
 */
export function seedFiles(files: Record<string, AssetFile>): void {
  const { book, folder: primary } = useBookStore.getState();
  const folders: Record<string, LibraryFolder> = { ...useLibraryStore.getState().folders };
  for (const file of Object.values(files)) {
    const asset = book?.assets[file.assetId];
    const path = file.folder ?? assetFolderPath(book, asset, primary) ?? primary ?? '/';
    const id = Object.entries(book?.folders ?? {}).find(([, f]) => f.path === path)?.[0] ?? path;
    const { assetId: _assetId, folder: _folder, ...photo } = file;
    const known = folders[id];
    folders[id] = {
      id,
      path,
      progress: { hashed: 0, prepared: 0, total: 0 },
      busy: false,
      error: null,
      scanned: true,
      ...known,
      photos: { ...known?.photos, [file.relPath]: photo },
    };
  }
  if (primary !== null) useAssetsStore.setState({ folder: primary });
  useLibraryStore.setState({ folders });
}
