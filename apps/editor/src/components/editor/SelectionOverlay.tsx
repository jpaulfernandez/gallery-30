import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import type { Frame, Page, PhotoElement } from '@photobook/shared';
import { type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent, useEffect } from 'react';
import { boundingBox } from '../../lib/frames';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { type DragData, type DropData, type PointerDownListener, useSlotDragRegistry } from './dnd';
import { deleteSelection, mergeSelection } from './frameActions';
import { startFrameMove } from './frameMove';
import { HANDLE_CURSOR, RESIZE_HANDLES, type ResizeHandle, startFrameResize } from './frameResize';
import { ExpandIcon, MergeIcon, MoveIcon, ReplaceIcon, RotateIcon, TrashIcon } from './icons';
import { TextEditor } from './TextEditor';

const pct = (n: number) => `${n * 100}%`;
const frameBox = (f: Frame): CSSProperties => ({
  position: 'absolute',
  left: pct(f.x),
  top: pct(f.y),
  width: pct(f.w),
  height: pct(f.h),
});

/**
 * Editor chrome drawn over the page, in the same box: a drop target per photo slot, the selection
 * outline with eight resize handles (see `startFrameResize`) and (photo slots) a move band, the
 * floating toolbar, and the inline text editor. With several elements selected (Shift+click) each
 * gets an outline, their bounding box a dashed one, and a toolbar offers Merge. Pointer events pass
 * through to the page except on the band, the handles, the toolbars and the text editor.
 *
 * With the Frame tool on, the handles and the move band are hidden (only the outline shows): the
 * draw layer covers the whole page, frames included, so a press anywhere starts a new frame.
 */
export function SelectionOverlay({ page, selectedId }: { page: Page; selectedId: string | null }) {
  const selected = page.elements.find((e) => e.id === selectedId);
  const selectedIds = useUiStore((s) => s.selectedElementIds);
  const editingId = useUiStore((s) => s.editingTextId);
  const template = useBookStore((s) => s.book?.template);
  const drawing = useUiStore((s) => s.tool === 'frame');
  const many = page.elements.filter((e) => selectedIds.includes(e.id));
  const multi = many.length > 1;
  const box = multi ? boundingBox(many.map((e) => e.frame)) : null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {page.elements.map((el) =>
        el.type === 'photo' ? <SlotTarget key={el.id} pageId={page.id} element={el} /> : null,
      )}
      {multi ? (
        <>
          {many.map((el) => (
            <div key={el.id} style={frameBox(el.frame)} className="outline-2 outline-accent" />
          ))}
          {box && (
            <>
              <div style={frameBox(box)} className="outline-1 outline-accent/70 outline-dashed outline-offset-2" />
              <MultiToolbar box={box} frames={many.filter((e) => e.type === 'photo').length} count={many.length} />
            </>
          )}
        </>
      ) : (
        selected && (
          <div style={frameBox(selected.frame)} className="outline-2 outline-accent">
            {selected.type === 'photo' && !drawing && <MoveBand pageId={page.id} elementId={selected.id} />}
            {selected.id !== editingId && !drawing && <Handles pageId={page.id} elementId={selected.id} />}
          </div>
        )
      )}
      {!multi && selected?.type === 'photo' && <FloatingToolbar pageId={page.id} element={selected} />}
      {selected?.type === 'text' && selected.id === editingId && template && (
        <TextEditor key={selected.id} pageId={page.id} element={selected} template={template} />
      )}
    </div>
  );
}

/** Where each handle sits on the selection outline. */
const HANDLE_POSITION: Record<ResizeHandle, string> = {
  nw: '-top-[5px] -left-[5px]',
  ne: '-top-[5px] -right-[5px]',
  se: '-right-[5px] -bottom-[5px]',
  sw: '-bottom-[5px] -left-[5px]',
  n: '-top-[5px] left-1/2 -translate-x-1/2',
  s: '-bottom-[5px] left-1/2 -translate-x-1/2',
  e: 'top-1/2 -right-[5px] -translate-y-1/2',
  w: 'top-1/2 -left-[5px] -translate-y-1/2',
};

/** Eight resize handles (corners and edge midpoints); drag one to resize the frame. */
function Handles({ pageId, elementId }: { pageId: string; elementId: string }) {
  const onPointerDown = (handle: ResizeHandle) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const box = e.currentTarget.closest('[data-page-box]');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    startFrameResize({
      pageId,
      elementId,
      handle,
      clientX: e.clientX,
      clientY: e.clientY,
      pageRect: box.getBoundingClientRect(),
    });
  };
  return (
    <>
      {RESIZE_HANDLES.map((h) => (
        <span
          key={h}
          data-canvas-ui
          data-resize-handle={h}
          title="Drag to resize (Shift: free ratio, Cmd: no snapping)"
          className={`pointer-events-auto absolute z-[1] size-2.5 rounded-[1px] border border-accent bg-white ${HANDLE_POSITION[h]}`}
          style={{ cursor: HANDLE_CURSOR[h] }}
          onPointerDown={onPointerDown(h)}
        />
      ))}
    </>
  );
}

/** Toolbar beside a multi-selection: Merge (photo frames) and Delete. */
function MultiToolbar({ box, frames, count }: { box: Frame; frames: number; count: number }) {
  return (
    <div
      data-canvas-ui
      role="toolbar"
      aria-label={`${count} elements selected`}
      className="pointer-events-auto absolute z-10 flex flex-col gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5 shadow-black/40 shadow-lg"
      style={{ left: `calc(${pct(box.x + box.w)} + 10px)`, top: pct(box.y) }}
    >
      <button
        type="button"
        title={frames >= 2 ? 'Merge frames (Cmd+Shift+M)' : 'Select two or more photo frames to merge'}
        aria-label="Merge frames"
        disabled={frames < 2}
        onClick={() => mergeSelection()}
        className="flex size-8 items-center justify-center rounded-md text-fg hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <MergeIcon />
      </button>
      <ToolButton label="Delete (empties filled frames first)" onClick={() => deleteSelection()}>
        <TrashIcon />
      </ToolButton>
    </div>
  );
}

/** Width of the grab band along the selection outline, CSS px (half inside, half outside). */
const BAND = 8;

/**
 * The selected photo slot's outline is a move handle: an 8 px band along each edge drags the
 * frame (snapped, see `startFrameMove`); dragging inside the slot still pans the photo.
 */
function MoveBand({ pageId, elementId }: { pageId: string; elementId: string }) {
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const box = e.currentTarget.closest('[data-page-box]');
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    startFrameMove({
      pageId,
      elementId,
      clientX: e.clientX,
      clientY: e.clientY,
      pageRect: box.getBoundingClientRect(),
    });
  };
  const edge = 'pointer-events-auto absolute cursor-move';
  const h = BAND / 2;
  return (
    <>
      {[
        { top: -h, left: -h, right: -h, height: BAND },
        { bottom: -h, left: -h, right: -h, height: BAND },
        { left: -h, top: h, bottom: h, width: BAND },
        { right: -h, top: h, bottom: h, width: BAND },
      ].map((style, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: four fixed edges
          key={i}
          data-canvas-ui
          data-move-band
          title="Drag to move the frame (hold Cmd to skip snapping)"
          className={edge}
          style={style}
          onPointerDown={onPointerDown}
        />
      ))}
    </>
  );
}

/** Droppable (and Alt + drag source) at a photo slot's frame. */
function SlotTarget({ pageId, element }: { pageId: string; element: PhotoElement }) {
  const drop: DropData = { kind: 'slot', pageId, elementId: element.id };
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: element.id, data: drop });
  const dragData: DragData | undefined = element.asset
    ? { kind: 'slot', pageId, elementId: element.id, assetId: element.asset }
    : undefined;
  const {
    setNodeRef: setDragRef,
    listeners,
    isDragging,
  } = useDraggable({ id: `slot:${element.id}`, data: dragData, disabled: !element.asset });
  const { active } = useDndContext();
  const registry = useSlotDragRegistry();

  const onPointerDown = listeners?.onPointerDown as PointerDownListener | undefined;
  useEffect(() => {
    if (!onPointerDown) return;
    registry.set(element.id, onPointerDown);
    return () => {
      if (registry.get(element.id) === onPointerDown) registry.delete(element.id);
    };
  }, [registry, element.id, onPointerDown]);

  const dragging = active !== null;
  return (
    <div
      ref={(node) => {
        setDropRef(node);
        setDragRef(node);
      }}
      style={frameBox(element.frame)}
      className={
        isOver && !isDragging
          ? 'bg-accent/25 outline-2 outline-accent'
          : isDragging
            ? 'bg-black/30'
            : dragging
              ? 'outline-1 outline-accent/50 outline-dashed -outline-offset-1'
              : undefined
      }
    />
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-fg hover:bg-white/10"
    >
      {children}
    </button>
  );
}

/** Klaviyo-style vertical toolbar beside the selected photo slot. */
function FloatingToolbar({ pageId, element }: { pageId: string; element: PhotoElement }) {
  const rotate = useBookStore((s) => s.rotateElement);
  const setAsset = useBookStore((s) => s.setElementAsset);
  const removeElement = useBookStore((s) => s.removeElement);
  const openOriginal = useUiStore((s) => s.openOriginal);
  const f = element.frame;
  const asset = element.asset;
  const moveData: DragData | undefined = asset
    ? { kind: 'slot', pageId, elementId: element.id, assetId: asset }
    : undefined;
  const move = useDraggable({ id: `move:${element.id}`, data: moveData, disabled: !asset });

  return (
    <div
      data-canvas-ui
      role="toolbar"
      aria-label="Photo actions"
      className="pointer-events-auto absolute z-10 flex flex-col gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5 shadow-black/40 shadow-lg"
      style={{ left: `calc(${pct(f.x + f.w)} + 10px)`, top: pct(f.y) }}
    >
      {asset && (
        <ToolButton label="Rotate 90°" onClick={() => rotate(pageId, element.id)}>
          <RotateIcon />
        </ToolButton>
      )}
      <ToolButton label={asset ? 'Replace photo' : 'Add photo'} onClick={focusFilmstripSearch}>
        <ReplaceIcon />
      </ToolButton>
      {asset && (
        <>
          <button
            type="button"
            ref={move.setNodeRef}
            {...move.listeners}
            {...move.attributes}
            title="Move: drag onto another slot to swap (or Alt + drag the photo)"
            aria-label="Move photo to another slot"
            className="flex size-8 cursor-grab items-center justify-center rounded-md text-fg hover:bg-white/10"
          >
            <MoveIcon />
          </button>
          <ToolButton label="Open original" onClick={() => openOriginal(asset)}>
            <ExpandIcon />
          </ToolButton>
          <ToolButton label="Remove photo" onClick={() => setAsset(pageId, element.id, null)}>
            <TrashIcon />
          </ToolButton>
        </>
      )}
      {!asset && (
        <ToolButton label="Delete frame" onClick={() => removeElement(pageId, element.id)}>
          <TrashIcon />
        </ToolButton>
      )}
    </div>
  );
}

/** "Replace" for now: point the user at the filmstrip (drag a photo onto the slot). */
export function focusFilmstripSearch() {
  const focus = () => {
    const input = document.getElementById('filmstrip-search');
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  };
  if (useUiStore.getState().leftTab === 'photos') focus();
  else {
    useUiStore.getState().setPref('leftTab', 'photos');
    requestAnimationFrame(focus);
  }
}
