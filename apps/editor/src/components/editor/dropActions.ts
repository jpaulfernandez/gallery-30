import type { Asset } from '@photobook/shared';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import type { DragData, DropData } from './dnd';

/** The book.assets entry for a filmstrip file (only what is known so far; the scan fills the rest). */
export function assetEntry(file: AssetFile): Asset {
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

/** Move the dragged page to the drop tile's index; the page on the canvas stays the same page. */
export function reorderPages(activeId: string, overId: string): void {
  const pages = useBookStore.getState().book?.pages ?? [];
  const from = pages.findIndex((p) => p.id === activeId);
  const to = pages.findIndex((p) => p.id === overId);
  if (from < 0 || to < 0 || from === to) return;
  const ui = useUiStore.getState();
  const currentId = pages[ui.pageIndex]?.id;
  useBookStore.getState().movePage(from, to);
  const index = useBookStore.getState().book?.pages.findIndex((p) => p.id === currentId) ?? -1;
  if (index >= 0 && index !== ui.pageIndex) useUiStore.setState({ pageIndex: index });
}
