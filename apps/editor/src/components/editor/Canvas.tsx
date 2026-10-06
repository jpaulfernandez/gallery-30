import { useDroppable } from '@dnd-kit/core';
import { type ElementPointerEvent, Page, type PhotoElement } from '@photobook/shared';
import '@photobook/shared/renderer.css';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cropFit, panCrop, zoomCrop } from '../../lib/crop';
import { devLog } from '../../lib/log';
import { useAssetsStore } from '../../store/assets';
import { beginGesture, endGesture, useBookStore } from '../../store/book';
import { clampZoom, effectiveZoom, PAGE_PX_PER_UNIT, useUiStore, ZOOM_MAX, ZOOM_MIN } from '../../store/ui';
import { makeResolver } from '../preview/resolve';
import { CanvasGuides } from './CanvasGuides';
import { type DragData, type DropData, pageDropDndId, useSlotDragRegistry } from './dnd';
import { FrameDrawLayer } from './FrameDrawLayer';
import { nudgeSelection } from './frameActions';
import { isEditableTarget, useIdleGesture } from './gestures';
import { CursorIcon, FrameIcon } from './icons';
import { SelectionOverlay } from './SelectionOverlay';
import { addTextToCurrentPage, startTextMove } from './textActions';

/** Space around the page when fitting, px. */
const FIT_PADDING = 48;

/**
 * The current page, editable. Size: zoom 'fit' is the largest page that fits the canvas with 48 px
 * padding; a number z draws it z * template.width * PAGE_PX_PER_UNIT px wide (100% = 540 px for
 * the 1080 px templates). Larger pages scroll.
 *
 * Gestures on a filled photo slot: drag pans (one undo step), Alt + drag moves the photo to another
 * slot (dnd-kit, swap), pinch (ctrl + wheel) zooms the photo around the pointer, double-click opens
 * the original. Dragging a selected slot's outline band or a text box moves the frame with
 * snapping (see frameMove.ts; Cmd skips snapping). Pinch elsewhere zooms the canvas.
 *
 * Over the page: grid and margin helpers plus live snap guides (CanvasGuides), a hint on blank
 * pages, and the page itself is the drop target for layout cards and for photos dropped outside
 * any slot (`page-drop:<pageId>`).
 *
 * Tools (top-left group): Select (V) and Frame (F). Frame draws empty photo frames by dragging
 * (FrameDrawLayer); so does Select on a page with no elements. Shift+click adds to or removes from
 * the selection. Arrow keys nudge the selection one grid step (Shift: ten) or, with nothing
 * selected, change page (left / right).
 */
export function Canvas() {
  const book = useBookStore((s) => s.book);
  const setCrop = useBookStore((s) => s.setCrop);
  const files = useAssetsStore((s) => s.files);
  const pageIndex = useUiStore((s) => s.pageIndex);
  const selectedId = useUiStore((s) => s.selectedElementId);
  const editingTextId = useUiStore((s) => s.editingTextId);
  const editText = useUiStore((s) => s.editText);
  const zoom = useUiStore((s) => s.zoom);
  const fitZoom = useUiStore((s) => s.fitZoom);
  const select = useUiStore((s) => s.select);
  const toggleSelection = useUiStore((s) => s.toggleSelection);
  const tool = useUiStore((s) => s.tool);
  const setFitZoom = useUiStore((s) => s.setFitZoom);
  const setPageIndex = useUiStore((s) => s.setPageIndex);
  const openOriginal = useUiStore((s) => s.openOriginal);
  const slotDrag = useSlotDragRegistry();

  const areaRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });

  const assets = book?.assets;
  const resolve = useMemo(() => makeResolver(assets, files, 'proxy'), [assets, files]);
  const page = book?.pages[pageIndex];
  const template = book?.template ?? { width: 1080, height: 1350 };
  // The text box being edited inline is drawn by the overlay's TextEditor instead.
  const shownPage = useMemo(
    () => (page && editingTextId ? { ...page, elements: page.elements.filter((e) => e.id !== editingTextId) } : page),
    [page, editingTextId],
  );

  // Track the canvas size for 'fit'.
  useLayoutEffect(() => {
    const node = areaRef.current;
    if (!node) return;
    const measure = () => setArea({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (area.width === 0 || area.height === 0) return;
    const availW = Math.max(area.width - 2 * FIT_PADDING, 40);
    const availH = Math.max(area.height - 2 * FIT_PADDING, 40);
    const width = Math.min(availW, (availH * template.width) / template.height);
    setFitZoom(width / (template.width * PAGE_PX_PER_UNIT));
  }, [area, template.width, template.height, setFitZoom]);

  const z = effectiveZoom({ zoom, fitZoom });
  const pageWidth = Math.max(40, Math.round(z * template.width * PAGE_PX_PER_UNIT));

  // Pan a filled photo slot by dragging it.
  const startPan = useCallback(
    (pageId: string, el: PhotoElement, event: ElementPointerEvent) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const start = el.crop;
      const fit = cropFit(useBookStore.getState().book, el);
      const x0 = event.clientX;
      const y0 = event.clientY;
      let began = false;
      const move = (e: PointerEvent) => {
        const dx = e.clientX - x0;
        const dy = e.clientY - y0;
        if (!began) {
          if (Math.hypot(dx, dy) < 2) return;
          began = true;
          beginGesture();
        }
        setCrop(pageId, el.id, panCrop(start, dx, dy, rect.width, rect.height, fit));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (began) endGesture();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [setCrop],
  );

  const onElementPointerDown = useCallback(
    (elementId: string, event: ElementPointerEvent) => {
      if (event.button !== 0 || !page) return;
      const el = page.elements.find((e) => e.id === elementId);
      if (!el) return;
      if (event.shiftKey) {
        // Shift+click builds a multi-selection (Merge); no drag.
        toggleSelection(elementId);
        return;
      }
      select(elementId);
      if (el.type === 'text') {
        // Drag moves the text box (snapped to guides); double-click or Enter edits it.
        startTextMove(page.id, el, event);
        return;
      }
      if (!el.asset) return;
      if (event.altKey) {
        // Alt + drag: hand the event to the slot's dnd-kit draggable (activates after 6 px).
        slotDrag.get(elementId)?.(event as unknown as ReactPointerEvent);
        return;
      }
      startPan(page.id, el, event);
    },
    [page, select, toggleSelection, slotDrag, startPan],
  );

  // Pinch (ctrl + wheel): photo zoom over a filled slot, canvas zoom elsewhere. React's wheel
  // listener is passive, so this one is native to be able to preventDefault.
  const touchPinch = useIdleGesture(300);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.01);
      const ui = useUiStore.getState();
      const current = useBookStore.getState().book?.pages[ui.pageIndex];
      const slot = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-element-type="photo"]') : null;
      const el = current?.elements.find((x) => x.id === slot?.dataset.elementId);
      if (current && slot && el?.type === 'photo' && el.asset) {
        touchPinch();
        const r = slot.getBoundingClientRect();
        const anchor = {
          x: (e.clientX - (r.left + r.width / 2)) / r.width,
          y: (e.clientY - (r.top + r.height / 2)) / r.height,
        };
        const { book: latest, setCrop: set } = useBookStore.getState();
        set(current.id, el.id, zoomCrop(el.crop, el.crop.scale * factor, anchor, cropFit(latest, el)));
        if (ui.selectedElementId !== el.id) ui.select(el.id);
      } else {
        ui.setZoom(clampZoom(effectiveZoom(ui) * factor));
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [touchPinch]);

  // Image load failures (error events do not bubble; capture them).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onError = (e: Event) => {
      if (e.target instanceof HTMLImageElement)
        devLog('canvas', 'image error', { url: e.target.currentSrc || e.target.src });
    };
    node.addEventListener('error', onError, true);
    return () => node.removeEventListener('error', onError, true);
  }, []);

  function onBackgroundPointerDown(e: ReactPointerEvent) {
    if (e.target instanceof Element && e.target.closest('[data-element-id],[data-canvas-ui]')) return;
    select(null);
  }

  function onDoubleClick(e: ReactMouseEvent) {
    const textNode = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-element-type="text"]') : null;
    const text = page?.elements.find((x) => x.id === textNode?.dataset.elementId);
    if (text?.type === 'text') {
      editText(text.id);
      return;
    }
    const slot = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-element-type="photo"]') : null;
    const el = page?.elements.find((x) => x.id === slot?.dataset.elementId);
    if (el?.type === 'photo' && el.asset) openOriginal(el.asset);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (isEditableTarget(e.target) || (e.target instanceof HTMLInputElement && e.target.type === 'range')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow && !editingTextId && useUiStore.getState().selectedElementIds.length > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudgeSelection((arrow[0] ?? 0) * step, (arrow[1] ?? 0) * step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setPageIndex(pageIndex + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      addTextToCurrentPage();
    } else if (
      e.key === 'Enter' &&
      e.target === e.currentTarget &&
      page?.elements.find((x) => x.id === selectedId)?.type === 'text' &&
      selectedId
    ) {
      e.preventDefault();
      editText(selectedId);
    }
  }

  return (
    <main
      ref={areaRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas takes focus for arrow-key page navigation
      tabIndex={0}
      aria-label={book && page ? `Canvas, page ${pageIndex + 1} of ${book.pages.length}` : 'Canvas'}
      onKeyDown={onKeyDown}
      onPointerDown={onBackgroundPointerDown}
      className="editor-canvas dot-grid relative min-h-0 min-w-0 outline-none"
    >
      <div ref={scrollRef} className="absolute inset-0 overflow-auto">
        {book && page && (
          <div
            className="grid min-h-full min-w-full place-items-center"
            style={{ padding: FIT_PADDING, width: 'max-content', boxSizing: 'border-box' }}
          >
            <PageDropTarget pageId={page.id} width={pageWidth} onDoubleClick={onDoubleClick}>
              <Page
                page={shownPage ?? page}
                template={book.template}
                theme={book.theme}
                resolve={resolve}
                pageWidthPx={pageWidth}
                editable
                selectedId={selectedId}
                onElementPointerDown={onElementPointerDown}
              />
              <CanvasGuides pageId={page.id} template={book.template} theme={book.theme} width={pageWidth} />
              {page.elements.length === 0 && <BlankPageHint />}
              <SelectionOverlay page={page} selectedId={selectedId} />
              {(tool === 'frame' || page.elements.length === 0) && (
                <FrameDrawLayer pageId={page.id} template={book.template} />
              )}
            </PageDropTarget>
          </div>
        )}
      </div>
      {book && <ToolGroup />}
      <ZoomControl zoom={z} fit={zoom === 'fit'} />
    </main>
  );
}

/**
 * The page on the canvas: the droppable `page-drop:<pageId>` for layout drags and for filmstrip
 * photos over no slot (EditorDnd decides who sees it), outlined dashed in accent while one hovers.
 */
function PageDropTarget({
  pageId,
  width,
  onDoubleClick,
  children,
}: {
  pageId: string;
  width: number;
  onDoubleClick: (e: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  const data: DropData = { kind: 'page-drop', pageId };
  const { setNodeRef, isOver, active } = useDroppable({ id: pageDropDndId(pageId), data });
  const kind = (active?.data.current as DragData | undefined)?.kind;
  const layoutOver = isOver && (kind === 'layout' || kind === 'asset');
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click is a pointer shortcut; the toolbar has the same action
    <div
      ref={setNodeRef}
      data-page-box
      className="relative shadow-black/50 shadow-xl"
      style={{ width }}
      onDoubleClick={onDoubleClick}
    >
      {children}
      {layoutOver && (
        <div className="pointer-events-none absolute -inset-1.5 rounded-sm border-2 border-accent border-dashed" />
      )}
    </div>
  );
}

/** Centred hint on a page with no elements. */
function BlankPageHint() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-[12%]">
      <p className="text-balance text-center text-[13px] text-fg-muted leading-relaxed">
        Drag a layout or photos here, or draw a frame
      </p>
    </div>
  );
}

/** Floating tool group, top-left of the canvas: Select (V) and Frame (F). */
function ToolGroup() {
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);
  const tools = [
    { id: 'select', label: 'Select (V)', icon: <CursorIcon /> },
    {
      id: 'frame',
      label: 'Frame (F): drag on the page to draw a photo frame, Shift to keep drawing',
      icon: <FrameIcon />,
    },
  ] as const;
  return (
    <div
      data-canvas-ui
      role="toolbar"
      aria-label="Canvas tools"
      className="absolute top-3 left-3 flex gap-0.5 rounded-lg border border-line bg-panel-2/95 p-0.5 shadow-black/30 shadow-md"
    >
      {tools.map((t) => (
        <button
          key={t.id}
          type="button"
          title={t.label}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          onClick={() => setTool(t.id)}
          className={`flex size-7 items-center justify-center rounded-md ${
            tool === t.id ? 'bg-accent text-white' : 'text-fg-muted hover:bg-white/10 hover:text-fg'
          }`}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );
}

function ZoomControl({ zoom, fit }: { zoom: number; fit: boolean }) {
  const setZoom = useUiStore((s) => s.setZoom);
  const stepZoom = useUiStore((s) => s.stepZoom);
  const percent = Math.round(zoom * 100);
  const button = 'rounded px-1.5 py-0.5 text-fg-muted hover:bg-white/10 hover:text-fg';
  return (
    <div
      data-canvas-ui
      className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-lg border border-line bg-panel-2/95 px-2 py-1 text-[11px] shadow-black/30 shadow-md"
    >
      <button
        type="button"
        onClick={() => setZoom('fit')}
        className={`${button} ${fit ? 'text-accent' : ''}`}
        title="Fit to window (Cmd+0)"
      >
        Fit
      </button>
      <button
        type="button"
        onClick={() => stepZoom(-1)}
        className={button}
        aria-label="Zoom out"
        title="Zoom out (Cmd+-)"
      >
        −
      </button>
      <input
        type="range"
        min={ZOOM_MIN * 100}
        max={ZOOM_MAX * 100}
        step={1}
        value={Math.min(Math.max(percent, ZOOM_MIN * 100), ZOOM_MAX * 100)}
        onChange={(e) => setZoom(Number(e.target.value) / 100)}
        aria-label="Canvas zoom"
        className="w-28 accent-accent"
      />
      <button type="button" onClick={() => stepZoom(1)} className={button} aria-label="Zoom in" title="Zoom in (Cmd+=)">
        +
      </button>
      <span className="w-9 text-right text-fg-muted tabular-nums">{percent}%</span>
    </div>
  );
}
