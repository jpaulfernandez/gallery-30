import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { BookTemplate, LayoutData, Theme } from '@photobook/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { fileOfAsset, useAssetsStore, usePhotoFile } from '../../store/assets';
import { useDesignBook } from '../../store/design';
import { LayoutThumb, useLayoutItems } from '../layouts/LayoutThumb';
import { findLayout } from '../layouts/layoutGroups';
import {
  type DragData,
  type DropData,
  isLayoutDndId,
  isPageDndId,
  isPageDropDndId,
  type LayoutDragData,
  type PhotoDragData,
  type PointerDownListener,
  SlotDragRegistry,
} from './dnd';
import { handleDrop } from './dropActions';

const OVERLAY_SIZE = 96;

/**
 * Page strip reordering (sortable tiles, ids `page:<pageId>`), layout drags and photo drags share
 * the context: a page drag only sees page tiles (closest center, the sortable default); a layout
 * drag only sees the canvas page (`page-drop:`) and the page tiles (pointer within); every other
 * drag sees the slots and the background well (pointer within), and a filmstrip photo that is over
 * none of them falls through to the canvas page (adds a frame, see `handleDrop`).
 */
const collisionDetection: CollisionDetection = (args) => {
  const id = args.active.id;
  const only = (keep: (id: string | number) => boolean) => args.droppableContainers.filter((c) => keep(c.id));
  if (isPageDndId(id)) return closestCenter({ ...args, droppableContainers: only(isPageDndId) });
  if (isLayoutDndId(id)) {
    return pointerWithin({ ...args, droppableContainers: only((c) => isPageDropDndId(c) || isPageDndId(c)) });
  }
  const hits = pointerWithin({ ...args, droppableContainers: only((c) => !isPageDndId(c) && !isPageDropDndId(c)) });
  const kind = (args.active.data.current as DragData | undefined)?.kind;
  if (hits.length > 0 || (kind !== 'asset' && kind !== 'library')) return hits;
  return pointerWithin({ ...args, droppableContainers: only(isPageDropDndId) });
};

/**
 * One DndContext for the editor shell. Filmstrip -> slot puts the photo in the slot (replacing
 * what was there); slot -> slot on the same page swaps the two photos; filmstrip -> the inspector's
 * background well sets a full-bleed photo background; filmstrip -> the page outside any slot fills
 * its first empty frame or adds a frame for the photo; page tile -> page tile reorders the book;
 * layout card -> canvas page or page tile applies the layout to that page (see `handleDrop`).
 * Dropping anywhere else does nothing. Activation: 6 px of pointer movement.
 */
export function EditorDnd({ children }: { children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const registry = useMemo(() => new Map<string, PointerDownListener>(), []);
  const [active, setActive] = useState<PhotoDragData | LayoutDragData | null>(null);

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    // Page tiles move themselves (sortable transform); photo and layout drags get an overlay.
    setActive(data && data.kind !== 'page' ? data : null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    handleDrop(e.active.data.current as DragData | undefined, e.over?.data.current as DropData | undefined);
  }

  return (
    <SlotDragRegistry.Provider value={registry}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active?.kind === 'layout' ? (
            <LayoutDragPreview data={active} />
          ) : active ? (
            <DragPreview data={active} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </SlotDragRegistry.Provider>
  );
}

/** The dragged layout card's page, small, under the pointer. */
function LayoutDragPreview({ data }: { data: LayoutDragData }) {
  const book = useDesignBook();
  const layout = book ? findLayout(data.layoutId, book) : undefined;
  if (!book || !layout) return null;
  return <LayoutDragThumb layout={layout} template={book.template} theme={book.theme} />;
}

function LayoutDragThumb({ layout, template, theme }: { layout: LayoutData; template: BookTemplate; theme: Theme }) {
  const items = useLayoutItems(layout, template, theme);
  return (
    <div className="cursor-grabbing rounded-[2px] shadow-float ring-2 ring-accent" style={{ width: OVERLAY_SIZE }}>
      <LayoutThumb items={items} template={template} />
    </div>
  );
}

function DragPreview({ data }: { data: PhotoDragData }) {
  // A filmstrip drag carries the file's key; a slot drag only the asset id; a Library tab drag the photo key.
  const project = useAssetsStore((s) =>
    data.kind === 'asset'
      ? s.files[data.relPath]
      : data.kind === 'slot'
        ? fileOfAsset(s.files, data.assetId)
        : undefined,
  );
  const library = usePhotoFile(data.kind === 'library' ? data.key : null);
  const file = project ?? library;
  const src = file?.thumbUrl ?? file?.proxyUrl;
  return (
    <div
      className="cursor-grabbing overflow-hidden rounded-md bg-line shadow-float ring-2 ring-accent"
      style={{ width: OVERLAY_SIZE, height: OVERLAY_SIZE }}
    >
      {src && <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />}
    </div>
  );
}
