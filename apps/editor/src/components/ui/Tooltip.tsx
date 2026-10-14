import {
  cloneElement,
  isValidElement,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { placePanel } from './floating';

/** Hover this long before a tooltip shows, ms (ODDHALLS_UI_PLAN 4.1); keyboard focus shows it at once. */
export const TOOLTIP_DELAY_MS = 600;

/** Whether the last input was a key (a focus then comes from the keyboard), tracked once for every tooltip. */
let keyboard = false;
let tracking = false;
function trackModality(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('keydown', () => (keyboard = true), true);
  document.addEventListener('pointerdown', () => (keyboard = false), true);
}

export interface TooltipProps {
  /** What the control does. */
  label: string;
  /** Its key, in mono at the right ("⌘Z"). */
  shortcut?: string;
  /** One element; it gets `aria-describedby` while the tooltip shows. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** The wrapper's classes (default `inline-flex`); a grid cell passes `flex [&>*]:flex-1` so its button still fills. */
  className?: string;
}

/**
 * A tooltip: `panel-3`, 11 px, the shortcut in mono. Shown after 600 ms of hover, at once on keyboard focus; hidden on
 * leave, blur, a press and Escape. Placed under the control (above it when there is no room).
 */
export function Tooltip({ label, shortcut, children, className = 'inline-flex' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(trackModality, []);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hide = useCallback(() => {
    clear();
    setOpen(false);
  }, [clear]);
  useEffect(() => clear, [clear]);

  useEffect(() => {
    if (!open) return setPos(null);
    const target = wrap.current?.firstElementChild ?? wrap.current;
    const width = tip.current?.offsetWidth ?? 0;
    if (target) {
      setPos(placePanel({ kind: 'rect', rect: target.getBoundingClientRect() }, width, tip.current?.offsetHeight ?? 0));
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hide]);

  const onFocus = () => {
    // Keyboard focus only; a click focuses too and must not pop the tooltip.
    if (keyboard) setOpen(true);
  };

  const child = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': open ? id : children.props['aria-describedby'] })
    : children;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only listens for hover and focus on its child
    <span
      ref={wrap}
      className={className}
      onPointerEnter={() => {
        clear();
        timer.current = setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={onFocus}
      onBlur={hide}
    >
      {child}
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[70] flex items-center gap-2 whitespace-nowrap rounded-xs border border-hairline bg-panel-3 px-1.5 py-0.5 text-[11px] text-fg shadow-float"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          >
            <span>{label}</span>
            {shortcut && <kbd className="font-mono text-fg-muted">{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}
