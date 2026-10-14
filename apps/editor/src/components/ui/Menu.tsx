import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { isTextField, keepsNativeMenu } from '../../lib/nativeShell';
import { type ButtonSize, type ButtonVariant, buttonClass } from './Button';
import { type Anchor, useFloating } from './floating';

/**
 * Plan 45: one menu for the app (ODDHALLS_UI_PLAN 3, 4.1): Project ▾, the document drop-down, View ▾, the sidebar and
 * strip context menus. `panel-3`, hairline, the float shadow, 6 px radius, 2 px inset; 28 px rows with the shortcut in
 * mono at the right; a hairline separator with 4 px margins; danger rows in `danger`.
 *
 * Keys: the trigger opens on Enter, Space and ArrowDown (focus on the first item); in the menu ArrowDown / ArrowUp
 * (and Home / End) move, Enter and Space choose, Escape closes and returns the focus to the trigger (or, for a context
 * menu, to what had it), Tab closes. Keys the menu handles stay out of the stage shortcuts.
 */

const ITEM = '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])';

interface MenuContextValue {
  /** Close the menu (focus goes back where it came from). */
  close: () => void;
  /** Focus the first item (after the menu swapped its content, e.g. a sub-list). */
  focusFirst: () => void;
}

const MenuCtx = createContext<MenuContextValue>({ close: () => {}, focusFirst: () => {} });

/** The open menu's `close` and `focusFirst`, for content that switches lists or closes itself. */
export const useMenu = (): MenuContextValue => useContext(MenuCtx);

function items(panel: HTMLElement | null): HTMLElement[] {
  return [...(panel?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
}

/** The keys of an open menu panel; `close` returns the focus. */
function onPanelKeyDown(e: ReactKeyboardEvent<HTMLElement>, panel: HTMLElement | null, close: () => void) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === 'Tab') {
    close();
    return;
  }
  // A text field in the menu (a rename) keeps its own keys.
  if (isTextField(e.target)) return;
  const list = items(panel);
  if (list.length === 0) return;
  const at = list.indexOf(document.activeElement as HTMLElement);
  let next: HTMLElement | undefined;
  if (e.key === 'ArrowDown') next = list[(at + 1) % list.length];
  else if (e.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length];
  else if (e.key === 'Home') next = list[0];
  else if (e.key === 'End') next = list[list.length - 1];
  else if (e.key === 'Enter' || e.key === ' ') {
    // The focused item's own click runs (Space on a button would otherwise wait for keyup).
    e.stopPropagation();
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  next?.focus();
}

/** The menu's floating panel (portaled, fixed). */
function Panel({
  panelRef,
  anchor,
  label,
  width,
  alignEnd,
  above,
  onClose,
  children,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  anchor: () => Anchor | null;
  label: string;
  width: number;
  alignEnd?: boolean;
  above?: boolean;
  /** Close, and return the focus when asked. */
  onClose: (returnFocus: boolean) => void;
  children: ReactNode;
}) {
  const pos = useFloating(true, anchor, panelRef, width, { alignEnd, above });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ctx = useMemo<MenuContextValue>(
    () => ({
      close: () => onCloseRef.current(true),
      focusFirst: () => items(panelRef.current)[0]?.focus({ preventScroll: true }),
    }),
    [panelRef],
  );

  // On open, the first item takes the focus (unless content took it, e.g. an autofocused field).
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) items(panel)[0]?.focus({ preventScroll: true });
  }, [panelRef]);

  return createPortal(
    <MenuCtx.Provider value={ctx}>
      <div
        ref={panelRef}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        data-canvas-ui
        onKeyDown={(e) => onPanelKeyDown(e, panelRef.current, () => onCloseRef.current(true))}
        className="fixed z-50 flex flex-col rounded-sm border border-hairline bg-panel-3 p-0.5 text-fg text-xs shadow-float outline-none transition-[opacity,translate] duration-fast ease-out starting:-translate-y-1 starting:opacity-0"
        style={{ width, left: pos.left, top: pos.top }}
      >
        {children}
      </div>
    </MenuCtx.Provider>,
    document.body,
  );
}

/** Close on a press outside `inside` (the panel and the trigger). */
function useOutsidePress(open: boolean, inside: Array<RefObject<Element | null>>, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (insideRef.current.some((r) => r.current?.contains(t))) return;
      closeRef.current();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
}

export interface MenuProps {
  /** The trigger's content ("Project ▾"). */
  label: ReactNode;
  /** The menu's accessible name. */
  menuLabel: string;
  /** The trigger's accessible name when its content is an icon or not its name. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** Trigger look (default `ghost`, `sm`). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Trigger classes added to the button's. */
  className?: string;
  /** Panel width, px. */
  width?: number;
  /** Align the panel's right edge with the trigger's. */
  alignEnd?: boolean;
  /** The items; a function gets `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** A menu button: the trigger (a `Button`) and its menu. */
function MenuButton({
  label,
  menuLabel,
  ariaLabel,
  title,
  disabled,
  variant = 'ghost',
  size = 'sm',
  className = '',
  width = 220,
  alignEnd,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const anchor = useCallback((): Anchor | null => {
    const r = trigger.current?.getBoundingClientRect();
    return r ? { kind: 'rect', rect: r } : null;
  }, []);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const panel = useRef<HTMLDivElement>(null);
  useOutsidePress(open, [trigger, panel], () => close(false));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      // The default is cancelled, so Enter and Space send no click (the focus moves into the menu anyway).
      if (open && e.key !== 'ArrowDown') return close(true);
      setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(true);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
        onClick={() => setOpen((o) => !o)}
        className={`${buttonClass({ variant, size, pressed: open })} ${open && variant === 'ghost' ? 'bg-fg/6 text-fg' : ''} ${className}`}
      >
        {label}
      </button>
      {open && (
        <Panel panelRef={panel} anchor={anchor} label={menuLabel} width={width} alignEnd={alignEnd} onClose={close}>
          {typeof children === 'function' ? children(() => close(true)) : children}
        </Panel>
      )}
    </>
  );
}

export interface ContextMenuProps {
  /** Where it opens (the pointer), or null while closed. */
  at: { x: number; y: number } | null;
  /** The menu's accessible name (the row's name). */
  label: string;
  onClose: () => void;
  width?: number;
  /** Open above the point (a strip at the bottom of the window). */
  above?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * A context menu anchored at a point: `Menu.Context`. Open it from `useContextMenu().onContextMenu`, which leaves the
 * system menu to text fields and `data-native-menu` (the plan 43 guard) and takes every other right-click. On close
 * the focus goes back to what had it when the menu opened.
 */
function ContextMenu({ at, label, onClose, width = 180, above, children }: ContextMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = at !== null;
  const point = useRef(at);
  point.current = at;
  const anchor = useCallback((): Anchor | null => {
    const p = point.current;
    return p ? { kind: 'point', x: p.x, y: p.y } : null;
  }, []);
  // What had the focus when the menu opened (before the menu takes it), to give it back on close.
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback((returnFocus: boolean) => {
    const back = returnTo.current;
    returnTo.current = null;
    onCloseRef.current();
    if (returnFocus && back?.isConnected) back.focus({ preventScroll: true });
  }, []);
  useOutsidePress(open, [panel], () => close(false));
  useEffect(() => {
    if (!open) return;
    const onBlur = () => close(false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [open, close]);

  if (!open) return null;
  return (
    <Panel panelRef={panel} anchor={anchor} label={label} width={width} above={above} onClose={close}>
      {typeof children === 'function' ? children(() => close(true)) : children}
    </Panel>
  );
}

/**
 * The state of a context menu: `onContextMenu(e, data)` on the row opens it at the pointer (the context-menu key
 * opens it at the row's corner), unless the right-click belongs to the system menu (a text field, `data-native-menu`).
 */
export function useContextMenu<T = undefined>() {
  const [menu, setMenu] = useState<{ x: number; y: number; data: T } | null>(null);
  const onContextMenu = useCallback((e: ReactMouseEvent<Element>, data: T) => {
    if (keepsNativeMenu(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    let { clientX: x, clientY: y } = e;
    // The context-menu key sends no pointer position.
    if (x === 0 && y === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.left;
      y = r.bottom;
    }
    setMenu({ x, y, data });
  }, []);
  const openAt = useCallback((x: number, y: number, data: T) => setMenu({ x, y, data }), []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, at: menu ? { x: menu.x, y: menu.y } : null, onContextMenu, openAt, close };
}

export interface MenuItemProps {
  children: ReactNode;
  /** Runs after the menu closes (unless `keepOpen`). */
  onSelect?: () => void;
  /** The key that does the same, in mono at the right. */
  shortcut?: string;
  /** A second line under the label. */
  hint?: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** A check item (`menuitemcheckbox`); it keeps the menu open unless `keepOpen` is false. */
  checked?: boolean;
  /** Keep the menu open after choosing (a sub-list, a toggle). */
  keepOpen?: boolean;
  /** Marks the current entry (the document on screen). */
  current?: boolean;
}

/** One row of a menu: 28 px, `xs` radius inside the panel's 2 px inset. */
export function MenuItem({
  children,
  onSelect,
  shortcut,
  hint,
  icon,
  danger,
  disabled,
  title,
  checked,
  keepOpen,
  current,
}: MenuItemProps) {
  const { close } = useMenu();
  const check = checked !== undefined;
  const stays = keepOpen ?? check;
  return (
    <button
      type="button"
      {...(check ? { role: 'menuitemcheckbox', 'aria-checked': checked } : { role: 'menuitem' })}
      aria-disabled={disabled || undefined}
      aria-current={current ? 'page' : undefined}
      tabIndex={-1}
      title={title}
      onClick={() => {
        if (disabled) return;
        if (!stays) close();
        onSelect?.();
      }}
      className={`flex w-full shrink-0 items-center gap-2 rounded-xs px-2 text-left outline-none transition-colors duration-fast hover:bg-fg/6 focus:bg-fg/10 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent ${
        hint ? 'min-h-7 py-1' : 'h-7'
      } ${danger ? 'text-danger' : current ? 'bg-fg/6 text-fg' : 'text-fg'}`}
    >
      {check && (
        <span aria-hidden="true" className="w-3 shrink-0 text-accent">
          {checked ? '✓' : ''}
        </span>
      )}
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {hint && <span className="text-[11px] text-fg-muted leading-snug">{hint}</span>}
      </span>
      {shortcut && <kbd className="ml-auto shrink-0 pl-4 font-mono text-[11px] text-fg-muted">{shortcut}</kbd>}
    </button>
  );
}

/** A hairline between groups of items. */
export function MenuSeparator() {
  return <hr className="mx-1 my-1 border-0 border-hairline border-t" />;
}

/** A small title over a group of items ("Open"). */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="section-title m-0 truncate px-2 pt-1.5 pb-0.5">{children}</p>;
}

/** `Menu` (a menu button) and `Menu.Context` (a context menu at a point). */
export const Menu = Object.assign(MenuButton, { Context: ContextMenu });
