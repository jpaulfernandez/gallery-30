import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Page as PageData } from '@photobook/shared';
import {
  BOOK_OUTPUT_ID,
  type BookTemplate,
  findOutput,
  frameCapMessage,
  Page,
  type ResolveImage,
  socialTemplate,
  type Theme,
} from '@photobook/shared';
import { memo, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepsNativeMenu } from '../../lib/nativeShell';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { currentDesignBook, useDesignBook } from '../../store/design';
import { resolvedAssets } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { openCaptionPage } from '../ai/CaptionPageSheet';
import { openSendPage } from '../design/postActions';
import { SendPageDialog } from '../design/SendPageDialog';
import { previewHref } from '../preview/pageParam';
import { makeResolver } from '../preview/resolve';
import { Menu, MenuItem } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { type DragData, pageDndId } from './dnd';
import { LayoutIcon, MoreIcon, PlusIcon } from './icons';
import { showToast } from './Toast';

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
 * Bottom strip: numbered page thumbnails (the shared `<Page>` at 90 px height, 4 px radius, the numbers in mono), the
 * current page with the accent ring 2 px out (plan 48), a `+` tile with a dashed hairline that adds a blank page (its
 * lower "Choose layout…" part adds one and opens the layout picker). Tiles reorder by drag (dnd-kit sortable inside EditorDnd's
 * context), accept layout cards dropped from the Layouts tab, and have a context menu
 * (right-click or the hover `…` button): Duplicate, Delete, Open in preview.
 */
export function PageStrip() {
  const book = useDesignBook();
  const addPage = useBookStore((s) => s.addPage);
  const files = useAssetsStore((s) => s.files);
  const pageIndex = useUiStore((s) => s.pageIndex);
  const setPageIndex = useUiStore((s) => s.setPageIndex);
  const openLayoutPicker = useUiStore((s) => s.openLayoutPicker);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const assets = useBookStore(resolvedAssets);
  const profile = book?.outputProfile ?? 'srgb';
  const resolve = useMemo(() => makeResolver(assets, files, 'thumb', profile), [assets, files, profile]);
  const pages = book?.pages;
  const pageCount = pages?.length ?? 0;
  const sortableIds = useMemo(() => (pages ?? []).map((p) => pageDndId(p.id)), [pages]);
  // A social post (plan 14): frames are numbered like the exported files (01, 02, …) and capped by the network.
  const outputId = useUiStore((s) => s.design.outputId);
  const post = useBookStore((s) => {
    const output = s.book ? findOutput(s.book, outputId) : undefined;
    return output?.kind === 'social' ? output : undefined;
  });
  const maxFrames = post ? socialTemplate(post.network).maxFrames : undefined;

  // Keep the current tile in view (page changes, adds, duplicates, reorders).
  useEffect(() => {
    if (pageCount === 0) return;
    listRef.current
      ?.querySelector(`[data-page-index="${pageIndex}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pageIndex, pageCount]);

  const selectPage = useCallback(
    (pageId: string) => {
      const index = currentDesignBook()?.pages.findIndex((p) => p.id === pageId) ?? -1;
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
    if (!id) {
      if (post && maxFrames !== undefined && pageCount >= maxFrames) showToast(frameCapMessage(post.network));
      return;
    }
    setPageIndex((currentDesignBook()?.pages.length ?? 1) - 1);
    if (withPicker) openLayoutPicker(id);
  }

  return (
    <nav aria-label="Pages" className="h-full border-line border-t bg-panel">
      <div ref={listRef} className="scrollbar flex h-full items-end gap-3 overflow-x-auto px-4 pb-3">
        <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
          {book.pages.map((page, i) => (
            <PageTile
              key={page.id}
              index={i}
              label={post ? String(i + 1).padStart(2, '0') : String(i + 1)}
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
          {maxFrames !== undefined ? (
            <span
              className="font-mono text-[11px] text-fg-muted tabular-nums"
              title={`This post holds up to ${maxFrames} frames`}
            >
              {pageCount}/{maxFrames}
            </span>
          ) : (
            <span className="text-[11px] text-transparent">+</span>
          )}
          <div
            className="flex flex-col overflow-hidden rounded-xs border border-hairline border-dashed text-fg-muted"
            style={{ width: Math.max(width, ADD_TILE_MIN_WIDTH), height: THUMB_HEIGHT }}
          >
            <Tooltip label="Add a blank page" shortcut="⌘N" className="flex min-h-0 flex-1 [&>*]:flex-1">
              <button
                type="button"
                onClick={() => add(false)}
                aria-label="Add blank page"
                className="flex min-h-0 items-center justify-center outline-none hover:bg-fg/5 hover:text-fg focus-visible:bg-fg/5 focus-visible:text-fg"
              >
                <PlusIcon />
              </button>
            </Tooltip>
            <Tooltip label="Add a page and choose its layout" className="flex shrink-0 [&>*]:flex-1">
              <button
                type="button"
                onClick={() => add(true)}
                aria-label="Add page and choose layout"
                className="flex h-5 items-center justify-center gap-0.5 border-hairline border-t border-dashed text-[10px] outline-none hover:bg-fg/5 hover:text-fg focus-visible:bg-fg/5 focus-visible:text-fg"
              >
                <LayoutIcon className="size-3" />
                <ChevronIcon />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {menu && <PageMenu menu={menu} onClose={closeMenu} />}
      <SendPageDialog />
    </nav>
  );
}

const PageTile = memo(function PageTile({
  index,
  label,
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
  /** The number shown above the tile: the page number, or a post frame's file number ("01"). */
  label: string;
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
    // Plan 43's guard leaves the system menu to text fields and `data-native-menu`; every other right-click is ours.
    if (keepsNativeMenu(e.target)) return;
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
      <span className={`font-mono text-[11px] tabular-nums ${current ? 'text-fg' : 'text-fg-muted'}`}>{label}</span>
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...listeners}
        onClick={() => onSelect(page.id)}
        onContextMenu={onContextMenu}
        aria-label={`Page ${index + 1}`}
        aria-current={current ? 'page' : undefined}
        title="Click to open, drag to reorder, right-click for more"
        className={`block overflow-hidden rounded-xs outline-none transition-shadow duration-fast focus-visible:ring-2 focus-visible:ring-accent/60 ${
          current ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel' : 'ring-1 ring-line hover:ring-fg-muted'
        } ${isDragging ? 'cursor-grabbing shadow-float' : ''} ${
          layoutOver ? 'outline-2 outline-accent outline-dashed outline-offset-2' : ''
        }`}
        style={{ width }}
      >
        <Page page={page} template={template} theme={theme} resolve={resolve} pageWidthPx={width} />
      </button>
      <Tooltip label="Page actions" className="absolute top-5 right-1 flex">
        <button
          type="button"
          aria-label={`Page ${index + 1} actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(page.id, r.left, r.top);
          }}
          className={`flex size-5 items-center justify-center rounded-xs border border-hairline bg-panel-3 text-fg shadow-raised outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent ${
            menuOpen ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
          }`}
        >
          <MoreIcon />
        </button>
      </Tooltip>
    </div>
  );
});

/**
 * Duplicate / Delete / Send to post / Caption / Open in preview for one page, opened above the given viewport point.
 * Plan 45: on `Menu.Context`.
 */
function PageMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const index = useDesignBook()?.pages.findIndex((p) => p.id === menu.pageId) ?? -1;
  const onBook = useUiStore((s) => s.design.outputId === BOOK_OUTPUT_ID);

  // The page went away (undo, another delete): nothing to act on.
  useEffect(() => {
    if (index < 0) onClose();
  }, [index, onClose]);
  if (index < 0) return null;

  const duplicate = () => {
    const id = useBookStore.getState().duplicatePage(menu.pageId);
    const output = findOutput(useBookStore.getState().book ?? { outputs: [] }, useUiStore.getState().design.outputId);
    if (!id && output?.kind === 'social') showToast(frameCapMessage(output.network));
    const next = currentDesignBook()?.pages.findIndex((p) => p.id === id) ?? -1;
    if (next >= 0) useUiStore.getState().setPageIndex(next);
  };

  const remove = () => {
    const ui = useUiStore.getState();
    const before = currentDesignBook()?.pages ?? [];
    const currentId = before[ui.pageIndex]?.id;
    useBookStore.getState().deletePage(menu.pageId);
    // Deleting another page keeps the current page on the canvas.
    if (currentId && currentId !== menu.pageId) {
      const next = currentDesignBook()?.pages.findIndex((p) => p.id === currentId) ?? -1;
      if (next >= 0) useUiStore.setState({ pageIndex: next });
    }
  };

  const openPreview = () => {
    const id = useBookStore.getState().projectId;
    if (id) window.location.hash = previewHref(id, index + 1);
  };

  return (
    <Menu.Context at={{ x: menu.x, y: menu.y }} label={`Page ${index + 1}`} onClose={onClose} width={MENU_WIDTH} above>
      <MenuItem shortcut="⌘D" onSelect={duplicate}>
        Duplicate
      </MenuItem>
      <MenuItem shortcut="⌘⌫" onSelect={remove}>
        Delete
      </MenuItem>
      <MenuItem onSelect={() => openSendPage(menu.pageId)}>Send to post…</MenuItem>
      {/* Workflow plan 35. */}
      <MenuItem onSelect={() => openCaptionPage(menu.pageId)}>Caption this page…</MenuItem>
      {onBook && (
        // The phone preview shows the book only.
        <MenuItem onSelect={openPreview}>Open in preview</MenuItem>
      )}
    </Menu.Context>
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
