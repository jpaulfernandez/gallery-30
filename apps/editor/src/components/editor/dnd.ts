import { createContext, type PointerEvent as ReactPointerEvent, useContext } from 'react';

/**
 * Drag and drop between the filmstrip and the canvas (dnd-kit, one DndContext in EditorDnd).
 *
 * Draggables:
 * - filmstrip cell: id = asset id, data `{ kind: 'asset' }`.
 * - Library tab cell: id `library:<photoKey>`, data `{ kind: 'library', key }` (hashed photos only); a drop adds the
 *   photo to the project (`addPhotos`) and then acts like a filmstrip photo.
 * - photo slot: id `slot:<elementId>`, started by Alt + drag on a filled slot (Canvas forwards the
 *   pointerdown to the slot's dnd-kit listener through `SlotDragRegistry`).
 * - the floating toolbar's Move handle: id `move:<elementId>`, plain drag.
 * - page strip tile (dnd-kit sortable): id `page:<pageId>`, data `{ kind: 'page' }`. Sortable items
 *   are droppables too; page drags only collide with page tiles and every other drag ignores them
 *   (see `collisionDetection` in EditorDnd).
 * - Layouts tab card: id `layout:<layoutId>`, data `{ kind: 'layout', layoutId }`. Layout drags only
 *   collide with the canvas page droppable and the page strip tiles (drop applies the layout there).
 * Droppables: every photo slot on the canvas, id = element id, data `{ kind: 'slot' }`; the
 * inspector's background photo well, id `page-bg:<pageId>`, data `{ kind: 'page-bg' }`; the whole
 * canvas page, id `page-drop:<pageId>`, data `{ kind: 'page-drop' }` (layout drags, and filmstrip
 * photos that are over no slot).
 */

/** Drags that carry a photo (they get the thumbnail drag overlay). */
export type PhotoDragData =
  /** A filmstrip photo. `relPath` is the file's key in the assets store (`fileKey`: its relPath in the primary folder). */
  | { kind: 'asset'; assetId: string; relPath: string }
  /** A photo from the Library tab (`key` = `photoKey`): dropping it adds it to the project first. */
  | { kind: 'library'; key: string }
  | { kind: 'slot'; pageId: string; elementId: string; assetId: string };

export type LayoutDragData = { kind: 'layout'; layoutId: string };

export type DragData = PhotoDragData | LayoutDragData | { kind: 'page'; pageId: string };

export type DropData =
  | { kind: 'slot'; pageId: string; elementId: string }
  | { kind: 'page-bg'; pageId: string }
  | { kind: 'page'; pageId: string }
  | { kind: 'page-drop'; pageId: string };

export const PAGE_DND_PREFIX = 'page:';
export const pageDndId = (pageId: string): string => `${PAGE_DND_PREFIX}${pageId}`;
export const isPageDndId = (id: string | number): boolean => String(id).startsWith(PAGE_DND_PREFIX);
export const pageBgDndId = (pageId: string): string => `page-bg:${pageId}`;

export const LAYOUT_DND_PREFIX = 'layout:';
export const layoutDndId = (layoutId: string): string => `${LAYOUT_DND_PREFIX}${layoutId}`;
export const isLayoutDndId = (id: string | number): boolean => String(id).startsWith(LAYOUT_DND_PREFIX);

export const PAGE_DROP_DND_PREFIX = 'page-drop:';
export const pageDropDndId = (pageId: string): string => `${PAGE_DROP_DND_PREFIX}${pageId}`;
export const isPageDropDndId = (id: string | number): boolean => String(id).startsWith(PAGE_DROP_DND_PREFIX);

export type PointerDownListener = (event: ReactPointerEvent) => void;

/** Element id -> the slot draggable's dnd-kit pointerdown listener, for Alt + drag. */
export const SlotDragRegistry = createContext<Map<string, PointerDownListener>>(new Map());

export const useSlotDragRegistry = () => useContext(SlotDragRegistry);
