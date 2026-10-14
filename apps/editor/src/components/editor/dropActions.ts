import type { AssetDraft } from '@photobook/shared';
import { type AssetFile, fileKey, fileOfAsset, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { currentDesignBook } from '../../store/design';
import { parsePhotoKey, useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import type { DragData, DropData } from './dnd';

/**
 * The book.assets entry for a filmstrip file (only what is known so far; the scan fills the rest). The store puts it in
 * the open folder.
 */
export function assetEntry(file: AssetFile): AssetDraft {
  return {
    path: file.relPath,
    size: file.size,
    mtime: file.mtime,
    ...(file.hash ? { hash: file.hash } : {}),
    ...(file.width && file.height ? { width: file.width, height: file.height } : {}),
    ...(file.orientation ? { orientation: file.orientation } : {}),
  };
}

/**
 * What a finished drag does (EditorDnd's `onDragEnd`, kept free of React so it is testable):
 * - layout -> canvas page or page strip tile: apply the layout to that page;
 * - page tile -> page tile: reorder;
 * - filmstrip photo -> background well: full-bleed photo background;
 * - filmstrip photo -> slot: put it in the slot; slot -> slot on the same page: swap;
 * - filmstrip photo -> the page outside any slot: fill the first empty frame, or add a frame for
 *   the photo (largest of its aspect inside the safe margins, centred; the page becomes custom),
 *   and select it.
 * Anything else does nothing.
 */
export function handleDrop(drag: DragData | undefined, drop: DropData | undefined): void {
  if (!drag || !drop) return;
  if (drag.kind === 'library') {
    // Only drops that place a photo add it to the project.
    if (drop.kind !== 'slot' && drop.kind !== 'page-bg' && drop.kind !== 'page-drop') return;
    const assetId = addLibraryPhoto(drag.key);
    if (!assetId) return;
    const file = fileOfAsset(useAssetsStore.getState().files, assetId);
    handleDrop({ kind: 'asset', assetId, relPath: file ? fileKey(file) : '' }, drop);
    return;
  }
  const store = useBookStore.getState();
  if (drag.kind === 'layout') {
    if (drop.kind === 'page-drop' || drop.kind === 'page') store.applyLayout(drop.pageId, drag.layoutId);
    return;
  }
  if (drag.kind === 'page') {
    if (drop.kind === 'page') reorderPages(drag.pageId, drop.pageId);
    return;
  }
  if (drop.kind === 'page-bg') {
    if (drag.kind !== 'asset') return;
    const file = useAssetsStore.getState().files[drag.relPath];
    store.setPageBackground(drop.pageId, { asset: drag.assetId }, file ? assetEntry(file) : undefined);
    return;
  }
  if (drop.kind === 'page-drop') {
    if (drag.kind !== 'asset') return;
    const file = useAssetsStore.getState().files[drag.relPath];
    const id = store.dropPhotoOnPage(drop.pageId, drag.assetId, file ? assetEntry(file) : undefined);
    if (id) useUiStore.getState().select(id);
    return;
  }
  if (drop.kind !== 'slot') return;
  if (drag.kind === 'asset') {
    const file = useAssetsStore.getState().files[drag.relPath];
    store.setElementAsset(drop.pageId, drop.elementId, drag.assetId, file ? assetEntry(file) : undefined);
  } else {
    if (drag.pageId !== drop.pageId || drag.elementId === drop.elementId) return;
    store.swapAssets(drop.pageId, drag.elementId, drop.elementId);
  }
  useUiStore.getState().select(drop.elementId);
}

/**
 * Add a hashed library photo (by key) to the open project and return its asset id (the existing one when the project
 * already has that file); null when the photo is unknown or not hashed yet.
 */
export function addLibraryPhoto(key: string): string | null {
  const parsed = parsePhotoKey(key);
  const folder = parsed ? useLibraryStore.getState().folders[parsed.folder] : undefined;
  const photo = parsed ? folder?.photos[parsed.path] : undefined;
  if (!parsed || !folder || !photo?.hash) return null;
  const [id] = useBookStore.getState().addPhotos([
    {
      folder: folder.id,
      folderPath: folder.path,
      path: photo.relPath,
      hash: photo.hash,
      size: photo.size,
      mtime: photo.mtime,
      width: photo.width,
      height: photo.height,
      orientation: photo.orientation,
    },
  ]);
  return id ?? null;
}

/** Move the dragged page to the drop tile's index; the page on the canvas stays the same page. */
export function reorderPages(activeId: string, overId: string): void {
  const pages = currentDesignBook()?.pages ?? [];
  const from = pages.findIndex((p) => p.id === activeId);
  const to = pages.findIndex((p) => p.id === overId);
  if (from < 0 || to < 0 || from === to) return;
  const ui = useUiStore.getState();
  const currentId = pages[ui.pageIndex]?.id;
  useBookStore.getState().movePage(from, to);
  const index = currentDesignBook()?.pages.findIndex((p) => p.id === currentId) ?? -1;
  if (index >= 0 && index !== ui.pageIndex) useUiStore.setState({ pageIndex: index });
}
