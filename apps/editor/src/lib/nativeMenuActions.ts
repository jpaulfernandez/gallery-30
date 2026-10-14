import { open } from '@tauri-apps/plugin-dialog';
import { saveProjectAs } from '../components/shell/ProjectMenu';
import { router } from '../router';
import { useBookStore } from '../store/book';
import { useFoldersStore } from '../store/folders';
import { useProjectsStore } from '../store/projects';
import { useUiStore } from '../store/ui';
import type { MenuAction } from './nativeMenu';

/** The library folder Cull and Develop open from the menu: the one shown last, else the first on disk. */
function libraryFolder(): string | null {
  const last = useUiStore.getState().libraryFolder;
  return last ?? useFoldersStore.getState().folders.find((f) => !f.missing)?.id ?? null;
}

/**
 * Plan 43: what the native menu's items without a key do (`lib/nativeMenu.ts`). Each calls the function the matching
 * button calls; New project opens Home, where the New project dialog lives.
 */
export const nativeMenuActions: Record<MenuAction, () => unknown> = {
  newProject: () => router.navigate({ to: '/' }),
  openProjectFile: async () => {
    const path = await open({
      multiple: false,
      directory: false,
      title: 'Open a project file',
      filters: [{ name: 'Photobook project', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    const project = await useProjectsStore.getState().openFile(path);
    await router.navigate({ to: '/project/$id/design', params: { id: project.id } });
  },
  importFolder: async () => {
    const folder = await useFoldersStore.getState().import();
    // Importing turns a legacy book.photobook.json in the folder into a project.
    if (folder) await useProjectsStore.getState().load();
  },
  saveAs: () => {
    const { projectId, book } = useBookStore.getState();
    if (projectId) return saveProjectAs(book?.title ?? '');
  },
  closeProject: async () => {
    if (!useBookStore.getState().projectId) return;
    await useBookStore.getState().close();
    await router.navigate({ to: '/' });
  },
  toggleGrid: () => useUiStore.getState().setPref('showGrid', !useUiStore.getState().showGrid),
  toggleRulers: () => useUiStore.getState().setPref('showRulers', !useUiStore.getState().showRulers),
  toggleMargins: () => useUiStore.getState().setPref('showMargins', !useUiStore.getState().showMargins),
  actualSize: () => useUiStore.getState().setZoom(1),
  stageCull: () => {
    const folderId = libraryFolder();
    if (folderId) return router.navigate({ to: '/library/$folderId/cull', params: { folderId } });
  },
  stageDevelop: () => {
    const folderId = libraryFolder();
    if (folderId) return router.navigate({ to: '/library/$folderId/develop', params: { folderId } });
  },
  stageDesign: () => {
    const id = useBookStore.getState().projectId;
    if (id) return router.navigate({ to: '/project/$id/design', params: { id } });
  },
};
