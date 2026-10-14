import { forwardRef, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

export interface PanelCardProps {
  /** Sentence case ("White balance"); also the section's accessible name and the reset's ("Reset Detail"). */
  title: string;
  open: boolean;
  onToggle: () => void;
  /** The title button's tooltip (a key that toggles the card). */
  toggleTitle?: string;
  /** After the title, inside the toggle: a count, the summary of a closed card, a key hint. */
  meta?: ReactNode;
  /** Before the reset in the title row: the card's own menu. */
  actions?: ReactNode;
  /** The per-card reset (a ghost icon in the title row, hidden while there is nothing to reset). */
  onReset?: () => void;
  resetDisabled?: boolean;
  /** The reset's tooltip; its accessible name stays `Reset <title>`. */
  resetTitle?: string;
  /** Classes of the body (default: 12 px sides, a 12 px gap between controls). */
  bodyClassName?: string;
  /** `data-*` attributes for the section (tests and the Masks focus hook). */
  data?: Record<`data-${string}`, string>;
  children: ReactNode;
}

/**
 * Plan 46: a card of the Develop panel (ODDHALLS_UI_PLAN 3, Develop): `panel-2`, 8 px radius, 8 px apart (the
 * panel's gap). The sentence-case title row toggles the card; the reset sits at its right as a ghost icon. Plan 48's
 * inspector uses the same card.
 */
export const PanelCard = forwardRef<HTMLElement, PanelCardProps>(function PanelCard(
  {
    title,
    open,
    onToggle,
    toggleTitle,
    meta,
    actions,
    onReset,
    resetDisabled = false,
    resetTitle,
    bodyClassName = 'space-y-3 px-3',
    data,
    children,
  },
  ref,
) {
  return (
    <section ref={ref} className="shrink-0 rounded-md bg-panel-2 shadow-raised" aria-label={title} {...data}>
      <div className="flex h-9 items-center gap-0.5 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title={toggleTitle}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        >
          <svg
            viewBox="0 0 16 16"
            className={`size-3 shrink-0 text-fg-muted transition-transform duration-fast ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="section-title shrink-0 text-fg">{title}</span>
          {meta}
        </button>
        {actions}
        {onReset && (
          <Tooltip label={resetTitle ?? `Reset ${title}`}>
            <Button
              variant="ghost"
              size="sm"
              icon={<ResetIcon />}
              aria-label={`Reset ${title}`}
              onClick={onReset}
              disabled={resetDisabled}
              className="disabled:invisible"
            />
          </Tooltip>
        )}
      </div>
      {open && <div className={`pt-0.5 pb-3 ${bodyClassName}`}>{children}</div>}
    </section>
  );
});

/** A counter-clockwise arrow: back to the defaults. */
export function ResetIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4v3h3" />
      <path d="M3.4 7A5 5 0 1 1 4 10.5" />
    </svg>
  );
}

/** The ⋯ glyph of a card's or the header's menu. */
export function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="12.5" cy="8" r="1.1" />
    </svg>
  );
}
