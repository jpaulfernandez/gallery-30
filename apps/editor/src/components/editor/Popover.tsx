import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Gap between the trigger and the panel, px. */
const OFFSET = 4;
/** Distance kept from the window edges, px. */
const EDGE = 8;

export interface PopoverButtonProps {
  /** Trigger content. */
  label: ReactNode;
  /** Trigger tooltip. */
  title?: string;
  /** Accessible name of the trigger when its content is an icon. */
  ariaLabel?: string;
  disabled?: boolean;
  /** Trigger classes. */
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
 * A button that opens a small floating panel under it (portaled to the body with fixed
 * positioning, so scrolling panels never clip it). Clicking outside, Escape or `close()` closes it;
 * Escape is kept from the editor shortcuts.
 */
export function PopoverButton({
  label,
  title,
  ariaLabel,
  disabled,
  className,
  panelLabel,
  width = 240,
  alignEnd,
  children,
}: PopoverButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const panelH = panelRef.current?.offsetHeight ?? 0;
    let left = alignEnd ? r.right - width : r.left;
    left = Math.min(Math.max(left, EDGE), window.innerWidth - width - EDGE);
    let top = r.bottom + OFFSET;
    if (panelH && top + panelH > window.innerHeight - EDGE) top = Math.max(EDGE, r.top - OFFSET - panelH);
    setPos({ left, top });
  }, [alignEnd, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

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
        className={className}
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
            className="fixed z-50 rounded-lg border border-line bg-panel-2 p-3 text-xs shadow-black/50 shadow-xl"
            style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
