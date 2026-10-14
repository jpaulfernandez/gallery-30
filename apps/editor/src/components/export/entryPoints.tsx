import { basename } from '../../lib/path';
import { useBookStore } from '../../store/book';
import { type LibrarySource, sourceItems } from '../../store/collections';
import { useExportsStore } from '../../store/exports';
import { photoMeta, useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { isEditableTarget } from '../cull/keys';
import { BatchButton } from '../develop/BatchBar';
import { type BatchContext, registerBatchSlot } from '../develop/batchSlots';
import { dialogOpen } from '../ui/DialogShell';

/**
 * Where the Export dialog opens from (workflow plan 11): Cmd+Shift+E (the photo Develop shows, or the Cull selection
 * and else the focused photo), the Develop batch bar (registered here, order 60), the Cull grid's menu and the
 * sidebar's folders and collections (`exportLibrarySource`).
 */

const nameOf = (id: string): string => basename(photoMeta(useBookStore.getState(), id)?.path ?? id);

/** Open the dialog on `ids`, titled by the one photo's name or the count. */
export function openExport(ids: readonly string[], title?: string): void {
  if (ids.length === 0) return;
  const first = ids[0];
  useExportsStore
    .getState()
    .openDialog(ids, title ?? (ids.length === 1 && first ? nameOf(first) : `${ids.length} photos`));
}

/** What Cmd+Shift+E exports now: the photo Develop shows, else the Cull selection (or the focused photo); none outside. */
export function exportTargetNow(): string[] {
  const ui = useUiStore.getState();
  if (ui.develop) {
    const id = ui.develop.ids[ui.develop.index];
    return id ? [id] : [];
  }
  if (ui.review) {
    if (ui.selection.keys.length > 0) return [...ui.selection.keys];
    const id = ui.review.ids[ui.review.index];
    return id ? [id] : [];
  }
  return [];
}

let installed = false;

/** Cmd+Shift+E (Ctrl on other systems) opens the dialog on `exportTargetNow`, unless a field or a dialog has the keys. */
export function installExportShortcut(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'e' && e.code !== 'KeyE') return;
    if (isEditableTarget(e.target) || dialogOpen() || useExportsStore.getState().dialog) return;
    const ids = exportTargetNow();
    if (ids.length === 0) return;
    e.preventDefault();
    openExport(ids);
  });
}

/**
 * Export every photo of a folder or a collection (the sidebar), by name. A folder not read this session is read from
 * its index first; photos not hashed yet are left out.
 */
export async function exportLibrarySource(source: LibrarySource, name: string, folderPath?: string): Promise<void> {
  const library = useLibraryStore.getState();
  if (source.kind === 'folder' && folderPath && Object.keys(library.folders[source.id]?.photos ?? {}).length === 0) {
    library.addFolder(source.id, folderPath);
    await library.loadIndex(source.id);
  }
  const { folders } = useLibraryStore.getState();
  // Libraries decide collection membership (Picks, Edited): read the ones not loaded yet.
  if (source.kind !== 'folder') {
    for (const folder of Object.values(folders)) {
      if (!Object.hasOwn(useBookStore.getState().libraries, folder.path)) {
        await useBookStore
          .getState()
          .loadLibrary(folder.path)
          .catch(() => {});
      }
    }
  }
  const items = sourceItems(source, folders, useBookStore.getState().libraries).sort(
    (a, b) => a.photo.relPath.localeCompare(b.photo.relPath) || a.folderId.localeCompare(b.folderId),
  );
  openExport(
    items.map((i) => i.key),
    name,
  );
}

/** The batch bar's Export… (order 60): the selection, or the photo shown when nothing is selected. */
function ExportSlot({ ids, current }: BatchContext) {
  const targets = ids.length > 0 ? ids : [current];
  return (
    <BatchButton
      onClick={() => openExport(targets)}
      title={`Export ${ids.length > 0 ? 'the selected photos' : 'this photo'} as new files (Cmd+Shift+E)`}
    >
      Export…
    </BatchButton>
  );
}

registerBatchSlot({ id: 'export', order: 60, render: (ctx) => <ExportSlot {...ctx} /> });
