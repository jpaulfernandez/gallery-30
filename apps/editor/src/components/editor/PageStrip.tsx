import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Page as PageData } from '@photobook/shared';
import { type BookTemplate, Page, type ResolveImage, type Theme } from '@photobook/shared';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { previewHref } from '../preview/pageParam';
import { makeResolver } from '../preview/resolve';
import { type DragData, pageDndId } from './dnd';
import { LayoutIcon, MoreIcon, PlusIcon } from './icons';

const THUMB_HEIGHT = 90;
/** The 9:16 thumbnail is only 51 px wide; the add tile stays big enough for its two buttons. */
const ADD_TILE_MIN_WIDTH = 56;
const MENU_WIDTH = 168;

interface MenuState {
  pageId: string;
  /** Viewport point the menu opens above. */
  x: number;
  y: number;
}

/**
 * Bottom strip: numbered page thumbnails (the shared `<Page>` at 90 px height), the current page
 * outlined in accent, a `+` tile that adds a blank page (its lower "Choose layout…" part adds one
 * and opens the layout picker). Tiles reorder by drag (dnd-kit sortable inside EditorDnd's
 * context), accept layout cards dropped from the Layouts tab, and have a context menu
 * (right-click or the hover `…` button): Duplicate, Delete, Open in preview.
 */
export function PageStrip() {
  const book = useBookStore((s) => s.book);
  const addPage = useBookStore((s) => s.addPage);
  const files = useAssetsStore((s) => s.files);
  const pageIndex = useUiStore((s) => s.pageIndex);
  const setPageIndex = useUiStore((s) => s.setPageIndex);
  const openLayoutPicker = useUiStore((s) => s.openLayoutPicker);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const assets = book?.assets;
  const resolve = useMemo(() => makeResolver(assets, files, 'thumb'), [assets, files]);
  const pages = book?.pages;
  const pageCount = pages?.length ?? 0;
  const sortableIds = useMemo(() => (pages ?? []).map((p) => pageDndId(p.id)), [pages]);

  // Keep the current tile in view (page changes, adds, duplicates, reorders).
  useEffect(() => {
    if (pageCount === 0) return;
    listRef.current
      ?.querySelector(`[data-page-index="${pageIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pageIndex, pageCount]);

  const selectPage = useCallback(
    (pageId: string) => {
      const index = useBookStore.getState().book?.pages.findIndex((p) => p.id === pageId) ?? -1;
      if (index >= 0) setPageIndex(index);
    },
    [setPageIndex],
  );
  const openMenu = useCallback((pageId: string, x: number, y: number) => setMenu({ pageId, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  if (!book) return null;
  const width = Math.round((THUMB_HEIGHT * book.template.width) / book.template.height);

  // `+` adds a blank page at the end and shows it; "Layout…" does the same, then opens the picker.
  function add(withPicker: boolean) {
    const id = addPage();
    if (!id) return;
    setPageIndex((useBookStore.getState().book?.pages.length ?? 1) - 1);
    if (withPicker) openLayoutPicker(id);
  }

  return (
    <nav aria-label="Pages" className="h-full border-line border-t bg-panel">
      <div ref={listRef} className="flex h-full items-end gap-3 overflow-x-auto px-4 pb-3">
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {book.pages.map((page, i) => (
            <PageTile
              key={page.id}
              index={i}
              page={page}
              template={book.template}
              theme={book.theme}
              resolve={resolve}
              width={width}
              current={i === pageIndex}
              menuOpen={menu?.pageId === page.id}
              onSelect={selectPage}
              onMenu={openMenu}
            />
          ))}
        </SortableContext>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <span className="text-[11px] text-transparent">+</span>
          <div
            className="flex flex-col overflow-hidden rounded-[3px] border border-line border-dashed text-fg-muted"
            style={{ width: Math.max(width, ADD_TILE_MIN_WIDTH), height: THUMB_HEIGHT }}
          >
            <button
              type="button"
              onClick={() => add(false)}
              aria-label="Add blank page"
              title="Add a blank page (Cmd+N)"
              className="flex min-h-0 flex-1 items-center justify-center outline-none hover:bg-white/5 hover:text-fg focus-visible:bg-white/5 focus-visible:text-fg"
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              onClick={() => add(true)}
              aria-label="Add page and choose layout"
              title="Choose layout…"
              className="flex h-5 shrink-0 items-center justify-center gap-0.5 border-line border-t border-dashed text-[10px] outline-none hover:bg-white/5 hover:text-fg focus-visible:bg-white/5 focus-visible:text-fg"
            >
              <LayoutIcon className="size-3" />
              <ChevronIcon />
            </button>
          </div>
        </div>
      </div>
      {menu && <PageMenu menu={menu} onClose={closeMenu} />}
    </nav>
  );
}

const PageTile = memo(function PageTile({
  index,
  page,
  template,
  theme,
  resolve,
  width,
  current,
  menuOpen,
  onSelect,
  onMenu,
}: {
  index: number;
  page: PageData;
  template: BookTemplate;
  theme: Theme;
  resolve: ResolveImage;
  width: number;
  current: boolean;
  menuOpen: boolean;
  onSelect: (pageId: string) => void;
  onMenu: (pageId: string, x: number, y: number) => void;
}) {
  const data: DragData = { kind: 'page', pageId: page.id };
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging, isOver, active } = useSortable(
    {
      id: pageDndId(page.id),
      data,
    },
  );
  const layoutOver = isOver && (active?.data.current as DragData | undefined)?.kind === 'layout';
  // Horizontal strip: ignore vertical pointer travel.
  const style = {
    transform: CSS.Translate.toString(transform && { ...transform, y: 0 }),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  function onContextMenu(e: ReactMouseEvent) {
    e.preventDefault();
    onMenu(page.id, e.clientX, e.clientY);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-page-index={index}
      className={`group relative flex shrink-0 flex-col items-center gap-1 ${isDragging ? 'opacity-80' : ''}`}
    >
      <span className={`text-[11px] tabular-nums ${current ? 'text-fg' : 'text-fg-muted'}`}>{index + 1}</span>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        onClick={() => onSelect(page.id)}
        onContextMenu={onContextMenu}
        aria-label={`Page ${index + 1}`}
        aria-current={current ? 'page' : undefined}
        title="Click to open, drag to reorder, right-click for more"
        className={`block overflow-hidden rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
          current ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-fg-muted'
        } ${isDragging ? 'cursor-grabbing shadow-black/50 shadow-lg' : ''} ${
          layoutOver ? 'outline-2 outline-accent outline-dashed outline-offset-2' : ''
        }`}
        style={{ width }}
      >
        <Page page={page} template={template} theme={theme} resolve={resolve} pageWidthPx={width} />
      </button>
      <button
        type="button"
        aria-label={`Page ${index + 1} actions`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(page.id, r.left, r.top);
        }}
        className={`absolute top-5 right-1 flex size-5 items-center justify-center rounded bg-panel-2/90 text-fg shadow-black/40 shadow-sm hover:bg-line ${
          menuOpen ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
        }`}
      >
        <MoreIcon />
      </button>
    </div>
  );
});

/** Duplicate / Delete / Open in preview for one page, opened above the given viewport point. */
function PageMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const index = useBookStore((s) => s.book?.pages.findIndex((p) => p.id === menu.pageId) ?? -1);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  // The page went away (undo, another delete): nothing to act on.
  useEffect(() => {
    if (index < 0) onClose();
  }, [index, onClose]);
  if (index < 0) return null;

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  const duplicate = () => {
    const id = useBookStore.getState().duplicatePage(menu.pageId);
    const next = useBookStore.getState().book?.pages.findIndex((p) => p.id === id) ?? -1;
    if (next >= 0) useUiStore.getState().setPageIndex(next);
  };

  const remove = () => {
    const ui = useUiStore.getState();
    const before = useBookStore.getState().book?.pages ?? [];
    const currentId = before[ui.pageIndex]?.id;
    useBookStore.getState().deletePage(menu.pageId);
    // Deleting another page keeps the current page on the canvas.
    if (currentId && currentId !== menu.pageId) {
      const next = useBookStore.getState().book?.pages.findIndex((p) => p.id === currentId) ?? -1;
      if (next >= 0) useUiStore.setState({ pageIndex: next });
    }
  };

  const openPreview = () => {
    window.location.hash = previewHref(index + 1);
  };

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  const left = Math.min(Math.max(menu.x, 8), window.innerWidth - MENU_WIDTH - 8);
  const item =
    'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs outline-none hover:bg-white/10 focus-visible:bg-white/10';

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Page ${index + 1}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-50 rounded-lg border border-line bg-panel-2 p-1 text-fg shadow-black/50 shadow-xl"
      style={{ left, bottom: window.innerHeight - menu.y + 4, width: MENU_WIDTH }}
    >
      <button type="button" role="menuitem" onClick={run(duplicate)} className={item}>
        Duplicate <span className="text-fg-muted">⌘D</span>
      </button>
      <button type="button" role="menuitem" onClick={run(remove)} className={item}>
        Delete <span className="text-fg-muted">⌘⌫</span>
      </button>
      <button type="button" role="menuitem" onClick={run(openPreview)} className={item}>
        Open in preview
      </button>
    </div>,
    document.body,
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 10 10"
      className="size-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path d="M2.5 4l2.5 2.5L7.5 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
