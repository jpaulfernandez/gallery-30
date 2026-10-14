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
import { currentDesignBook, useDesignBook } from '../../store/design';
import { resolvedAssets } from '../../store/library';
import { clampZoom, effectiveZoom, PAGE_PX_PER_UNIT, useUiStore, ZOOM_MAX, ZOOM_MIN } from '../../store/ui';
import { SafeAreaGuides } from '../design/SafeAreaGuides';
import { makeResolver } from '../preview/resolve';
import { Button, IconButton } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { canvasPill } from './AlignToolbar';
import { CanvasGuides } from './CanvasGuides';
import { type DragData, type DropData, pageDropDndId, useSlotDragRegistry } from './dnd';
import { FrameDrawLayer } from './FrameDrawLayer';
import { nudgeSelection } from './frameActions';
import { startElementMove, startElementSelectionMove } from './frameMove';
import {
  doubleClickAction,
  isEditableTarget,
  type PressTarget,
  pressAction,
  trackPointerDrag,
  useIdleGesture,
} from './gestures';
import { CursorIcon, FrameIcon } from './icons';
import { Rulers } from './Rulers';
import { SelectionOverlay } from './SelectionOverlay';
import { addTextToCurrentPage } from './textActions';

/** Space around the page when fitting, px. */
const FIT_PADDING = 48;

/**
 * The current page, editable. Size: zoom 'fit' is the largest page that fits the canvas with 48 px
 * padding; a number z draws it z * template.width * PAGE_PX_PER_UNIT px wide (100% = 540 px for
 * the 1080 px templates). Larger pages scroll.
 *
 * Gestures (workflow plan 29; the table is `pressAction` / `doubleClickAction` in gestures.ts): a
 * drag on any frame moves it with snapping (frameMove.ts; Cmd skips snapping), also from a selected
 * photo frame's outline band. Alt + drag on a filled photo frame moves the photo to another slot
 * (dnd-kit, swap). Double-click on a filled photo frame enters *Adjust photo* (`ui.canvas.adjusting`,
 * also the floating toolbar's Adjust button): there a drag pans the photo (one undo step) and the
 * wheel or a pinch zooms it around the pointer; Escape, a press anywhere else or another selection
 * leaves. Space + drag on the selected photo frame pans once without the mode. Double-click on a
 * text box edits it. Pinch (ctrl + wheel) elsewhere zooms the canvas.
 *
 * Over the page: grid and margin helpers plus live snap guides (CanvasGuides), rulers and the page's
 * ruler guides (Rulers, workflow plan 31), a hint on blank
 * pages, and the page itself is the drop target for layout cards and for photos dropped outside
 * any slot (`page-drop:<pageId>`).
 *
 * A drag on a member of a multi-selection moves the whole selection, its bounding box snapped
 * (`startSelectionMove`); a click on one selects it alone. The alignment toolbar sits over a
 * multi-selection (AlignToolbar, workflow plan 30).
 *
 * Tools (top-left group): Select (V) and Frame (F). Frame draws empty photo frames by dragging
 * (FrameDrawLayer); so does Select on a page with no elements. Shift+click adds to or removes from
 * the selection. Arrow keys nudge the selection one grid step (Shift: ten; a single frame snaps
 * along the step and the guides flash, see `nudgeSelection`) or, with nothing selected, change page
 * (left / right). The first hand edit that turns a layout page custom shows a toast with Undo
 * (`noticeCustomPage`, in the toast host since plan 48).
 */
export function Canvas() {
  const book = useDesignBook();
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
  const adjusting = useUiStore((s) => s.canvas.adjusting);
  const setAdjusting = useUiStore((s) => s.setAdjusting);
  const slotDrag = useSlotDragRegistry();
  /** Space is held: a drag on the selected photo frame pans it (see `pressAction`). */
  const spaceRef = useRef(false);

  const areaRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });

  // Edits read through the folder's library.
  const assets = useBookStore(resolvedAssets);
  const profile = book?.outputProfile ?? 'srgb';
  const resolve = useMemo(() => makeResolver(assets, files, 'proxy', profile), [assets, files, profile]);
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
    // Whole pixels, floored: the scroll box's content is sized from this and must never be a fraction too big.
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setArea({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    };
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
  // Plan 43: the scroll area scrolls only past fit (a fitted page never flashes a scrollbar or moves under a
  // two-finger scroll), and its content box is whole pixels: the page plus its padding, at least the area.
  const pastFit = zoom !== 'fit' && z > fitZoom;
  const contentWidth = Math.max(area.width, Math.ceil(pageWidth + 2 * FIT_PADDING));
  const contentHeight = Math.max(
    area.height,
    Math.ceil((pageWidth * template.height) / template.width + 2 * FIT_PADDING),
  );

  // Pan a filled photo slot by dragging it (Adjust photo mode, or Space + drag).
  const startPan = useCallback(
    (pageId: string, el: PhotoElement, event: ElementPointerEvent) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const start = el.crop;
      const fit = cropFit(currentDesignBook(), el);
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
      trackPointerDrag(move, () => {
        if (began) endGesture();
      });
    },
    [setCrop],
  );

  const onElementPointerDown = useCallback(
    (elementId: string, event: ElementPointerEvent) => {
      if (event.button !== 0 || !page) return;
      const el = page.elements.find((e) => e.id === elementId);
      if (!el) return;
      const ui = useUiStore.getState();
      const { action, adjusting: next } = pressAction({
        target: pressTarget(el),
        adjusting: ui.canvas.adjusting,
        selectedId: ui.selectedElementId,
        selectedIds: ui.selectedElementIds,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        space: spaceRef.current,
      });
      if (next !== ui.canvas.adjusting) setAdjusting(next);
      if (action === 'toggle-selection') {
        // Shift+click builds a multi-selection (Merge); no drag.
        toggleSelection(elementId);
        return;
      }
      if (action === 'move-selection') {
        // A drag moves the whole selection as one block; a click selects this member alone.
        startElementSelectionMove(page.id, ui.selectedElementIds, event, () => select(elementId));
        return;
      }
      if (ui.selectedElementId !== elementId || ui.selectedElementIds.length !== 1) select(elementId);
      if (action === 'swap') {
        // Alt + drag: hand the event to the slot's dnd-kit draggable (activates after 6 px).
        slotDrag.get(elementId)?.(event as unknown as ReactPointerEvent);
      } else if (action === 'pan' && el.type === 'photo') {
        startPan(page.id, el, event);
      } else if (action === 'move') {
        // A plain drag moves the frame (snapped); double-click adjusts a photo or edits a text box.
        startElementMove(page.id, elementId, event);
      }
    },
    [page, select, toggleSelection, slotDrag, startPan, setAdjusting],
  );

  // Adjust photo mode ends on a press outside the canvas (panels, filmstrip, top bar) and when the canvas goes
  // (Preview, another stage).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const ui = useUiStore.getState();
      if (ui.canvas.adjusting === null) return;
      if (e.target instanceof Node && areaRef.current?.contains(e.target)) return;
      ui.setAdjusting(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      if (useUiStore.getState().canvas.adjusting !== null) useUiStore.getState().setAdjusting(null);
    };
  }, []);

  // Space held (outside text fields) turns a drag on the selected photo frame into a pan.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || isEditableTarget(e.target)) return;
      spaceRef.current = true;
      // No page scroll or button press from the canvas itself.
      if (e.target instanceof Element && e.target.matches('.editor-canvas')) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceRef.current = false;
    };
    const blur = () => {
      spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Adjust photo mode: the wheel or a pinch over the adjusted frame zooms the photo around the
  // pointer. Elsewhere a pinch (ctrl + wheel) zooms the canvas and the wheel scrolls. React's wheel
  // listener is passive, so this one is native to be able to preventDefault.
  const touchPinch = useIdleGesture(300);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const ui = useUiStore.getState();
      const adjustingId = ui.canvas.adjusting;
      const slot = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-element-type="photo"]') : null;
      const overAdjusted = adjustingId !== null && slot?.dataset.elementId === adjustingId;
      if (!e.ctrlKey && !overAdjusted) return;
      e.preventDefault();
      // A pinch reports small deltas; a mouse wheel or a two-finger scroll larger ones.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const current = currentDesignBook()?.pages[ui.pageIndex];
      const el = current?.elements.find((x) => x.id === slot?.dataset.elementId);
      if (current && slot && overAdjusted && el?.type === 'photo' && el.asset) {
        touchPinch();
        const r = slot.getBoundingClientRect();
        const anchor = {
          x: (e.clientX - (r.left + r.width / 2)) / r.width,
          y: (e.clientY - (r.top + r.height / 2)) / r.height,
        };
        const { setCrop: set } = useBookStore.getState();
        const latest = currentDesignBook();
        set(current.id, el.id, zoomCrop(el.crop, el.crop.scale * factor, anchor, cropFit(latest, el)));
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
    if (e.shiftKey || e.altKey) return;
    const node = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-element-id]') : null;
    const el = page?.elements.find((x) => x.id === node?.dataset.elementId);
    if (!el) return;
    const action = doubleClickAction(pressTarget(el));
    if (action === 'edit-text') editText(el.id);
    else if (action === 'adjust') setAdjusting(el.id);
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
      className="editor-canvas dot-grid relative min-h-0 min-w-0 bg-canvas outline-none"
      data-adjusting={adjusting ?? undefined}
    >
      <div
        ref={scrollRef}
        // Past fit the wheel and the trackpad scroll the page; no bar takes room from it.
        className={`absolute inset-0 ${pastFit ? 'overflow-auto overscroll-contain [&::-webkit-scrollbar]:hidden' : 'overflow-hidden'}`}
      >
        {book && page && (
          <div
            className="grid place-items-center"
            style={{ padding: FIT_PADDING, width: contentWidth, height: contentHeight, boxSizing: 'border-box' }}
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
              {/* A social post's safe area (plan 14): its own layer, from the network's template. */}
              <SafeAreaGuides width={pageWidth} height={(pageWidth * book.template.height) / book.template.width} />
              {/* Rulers and ruler guides (workflow plan 31): over the frames, under the selection's handles. */}
              <Rulers
                key={page.id}
                pageId={page.id}
                template={book.template}
                guides={page.guides}
                width={pageWidth}
                raised={tool === 'frame' || page.elements.length === 0}
              />
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

/** What `pressAction` / `doubleClickAction` need to know about a page element. */
function pressTarget(el: { id: string; type: 'photo' | 'text'; asset?: string | null }): PressTarget {
  return { id: el.id, type: el.type, filled: el.type === 'photo' && Boolean(el.asset) };
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
      className="relative shadow-stage/50 shadow-xl"
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
    { id: 'select', name: 'Select', label: 'Select', shortcut: 'V', icon: <CursorIcon /> },
    {
      id: 'frame',
      name: 'Frame',
      label: 'Frame: drag on the page to draw a photo frame, Shift to keep drawing',
      shortcut: 'F',
      icon: <FrameIcon />,
    },
  ] as const;
  return (
    <div
      data-canvas-ui
      role="toolbar"
      aria-label="Canvas tools"
      className={`absolute top-3 left-3 flex gap-0.5 rounded-lg p-0.5 ${canvasPill}`}
    >
      {tools.map((t) => (
        <IconButton
          key={t.id}
          variant="toggle"
          pressed={tool === t.id}
          label={t.label}
          shortcut={t.shortcut}
          aria-label={t.name}
          icon={t.icon}
          onClick={() => setTool(t.id)}
        />
      ))}
    </div>
  );
}

/** The zoom HUD, bottom-right: a pill "Fit · − ━━ + · 100 %"; the readout in mono. */
function ZoomControl({ zoom, fit }: { zoom: number; fit: boolean }) {
  const setZoom = useUiStore((s) => s.setZoom);
  const stepZoom = useUiStore((s) => s.stepZoom);
  const percent = Math.round(zoom * 100);
  return (
    <div
      data-canvas-ui
      className={`absolute right-3 bottom-3 flex items-center gap-1 rounded-pill py-0.5 pr-3 pl-0.5 ${canvasPill}`}
    >
      <Tooltip label="Fit to window" shortcut="⌘0">
        <Button variant="toggle" size="sm" pressed={fit} onClick={() => setZoom('fit')} shape="pill">
          Fit
        </Button>
      </Tooltip>
      <span aria-hidden="true" className="text-fg-muted">
        ·
      </span>
      <IconButton
        size="sm"
        label="Zoom out"
        shortcut="⌘−"
        icon={<span aria-hidden="true">−</span>}
        onClick={() => stepZoom(-1)}
        shape="pill"
      />
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
      <IconButton
        size="sm"
        label="Zoom in"
        shortcut="⌘="
        icon={<span aria-hidden="true">+</span>}
        onClick={() => stepZoom(1)}
        shape="pill"
      />
      <span aria-hidden="true" className="text-fg-muted">
        ·
      </span>
      <output aria-label="Zoom" className="w-12 text-right font-mono text-fg-2 text-xs tabular-nums">
        {percent} %
      </output>
    </div>
  );
}
