import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonVariant } from './Button';

/** Attribute of every open shell: the Develop view and the editor shortcuts leave the keys to an open dialog. */
export const DIALOG_ATTR = 'data-develop-dialog';

/** True while a Sync / Import / Presets dialog is open (its keys are its own). */
export const dialogOpen = (): boolean => document.querySelector(`[${DIALOG_ATTR}]`) !== null;

interface DialogShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Panel width class; default `w-[34rem]`. */
  widthClass?: string;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal over the editor or the Develop view (z above both), portaled to the body. Escape closes it, Tab stays inside
 * it, and focus goes back to where it was on close. Every key is kept from the Develop view and the shortcuts behind it.
 *
 * Plan 45 (moved from `components/develop/`, which re-exports it until plan 49): ODDHALLS_UI_PLAN 3's one shell for
 * every dialog and sheet: `panel-2` on a 60 % `stage` scrim, `lg` radius (12 px), the title 15 px medium, the body
 * 13 px, the footer with the primary on the right; it enters with a fade and an 8 px rise (`slow`).
 */
export function DialogShell({ title, onClose, children, widthClass = 'w-[34rem]' }: DialogShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    // The first field if there is one (a name to type), else the dialog itself.
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const el = ref.current;
    if (!el) return;
    const focusable = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only swallows clicks; the dialog inside has the role
    <div
      {...{ [DIALOG_ATTR]: '' }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-stage/60 p-6 transition-opacity duration-slow ease-out starting:opacity-0"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex max-h-full max-w-full flex-col rounded-lg border border-hairline bg-panel-2 text-[13px] text-fg shadow-float outline-none transition-[opacity,translate] duration-slow ease-out starting:translate-y-2 starting:opacity-0 ${widthClass}`}
      >
        <h2 className="shrink-0 border-hairline border-b px-4 py-3 font-medium text-[15px]">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Body of a dialog: scrolls when long. */
export function DialogBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 space-y-3 scrollbar overflow-x-hidden overflow-y-auto px-4 py-3">{children}</div>
  );
}

/** Footer row of buttons, right-aligned. */
export function DialogFooter({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-hairline border-t px-4 py-3">
      {note && <div className="mr-auto min-w-0 text-fg-muted">{note}</div>}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A footer button: the dialog's one `primary` action, or `soft` (any other `variant` when asked). */
export function DialogButton({
  children,
  onClick,
  primary,
  variant,
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  variant?: ButtonVariant;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  return (
    <Button
      type={type}
      variant={variant ?? (primary ? 'primary' : 'soft')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </Button>
  );
}
