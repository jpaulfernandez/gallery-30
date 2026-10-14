import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ButtonSize, type ButtonVariant, buttonClass } from './Button';
import { type Anchor, FOCUSABLE, useFloating } from './floating';

export interface PopoverButtonProps {
  /** Trigger content. */
  label: ReactNode;
  /** Trigger tooltip. */
  title?: string;
  /** Accessible name of the trigger when its content is an icon. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Trigger look when `className` is not given (default `ghost`, `sm`). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Trigger classes (replace the button look). */
  className?: string;
  /** Accessible name of the panel. */
  panelLabel: string;
  /** Panel width, px. */
  width?: number;
  /** Align the panel's right edge with the trigger's (default: left edges). */
  alignEnd?: boolean;
  /** Panel content; `close` closes the popover. */
  children: (close: () => void) => ReactNode;
}

/**
 * Plan 45 (moved from `components/editor/Popover.tsx`): a button that opens a small floating panel under it (portaled
 * with fixed positioning, so scrolling panels never clip it), `panel-3`, hairline, the float shadow, 6 px radius.
 * Opening focuses the panel's first control (unless a child already took focus). Clicking outside, Escape (in the
 * panel or on the trigger) or `close()` closes it; Escape is kept from the editor shortcuts and returns the focus to
 * the trigger. For a list of actions use `Menu`.
 */
export function PopoverButton({
  label,
  title,
  ariaLabel,
  disabled,
  variant = 'ghost',
  size = 'sm',
  className,
  panelLabel,
  width = 240,
  alignEnd,
  children,
}: PopoverButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const anchor = useCallback((): Anchor | null => {
    const r = buttonRef.current?.getBoundingClientRect();
    return r ? { kind: 'rect', rect: r } : null;
  }, []);
  const pos = useFloating(open, anchor, panelRef, width, { alignEnd });

  // On open, focus the panel's first control (unless something in it already took focus, e.g. `autoFocus`).
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || panel.contains(document.activeElement)) return;
    panel.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // Escape closes an open panel from the trigger too (and stays away from the editor shortcuts).
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={className ?? `${buttonClass({ variant, size })} ${open ? 'bg-fg/6 text-fg' : ''}`}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={panelLabel}
            data-canvas-ui
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
            className="fixed z-50 rounded-sm border border-hairline bg-panel-3 p-3 text-xs shadow-float transition-[opacity,translate] duration-fast ease-out starting:-translate-y-1 starting:opacity-0"
            style={{ width, left: pos.left, top: pos.top }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The same component under its primitive name. */
export const Popover = PopoverButton;
