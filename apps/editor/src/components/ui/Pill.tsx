import type { ReactNode } from 'react';
import { ProgressRing } from './ProgressRing';

/**
 * Plan 47 (extracted from plan 46's Develop `BatchBar`): the floating batch pill of ODDHALLS_UI_PLAN 3, shared by
 * Develop and Cull. A `panel-3` toolbar, `lg` radius, the float shadow, centred over the foot of its positioned
 * parent; it slides up (`base`) while `shown` and is out of the way and inert otherwise. The content is the caller's:
 * a `PillCount`, `PillDivider`s and `Button`s (`sm`). `w-max`: an absolute box at `left: 50%` would otherwise
 * shrink to half its parent and let the content spill out.
 */
export interface PillProps {
  /** Slid up and usable (a non-empty selection); otherwise hidden and inert. */
  shown: boolean;
  /** The toolbar's accessible name ("Batch actions"). */
  label: string;
  children: ReactNode;
  className?: string;
}

export function Pill({ shown, label, children, className = '' }: PillProps) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      inert={!shown}
      data-shown={shown || undefined}
      className={`absolute bottom-3 left-1/2 z-20 flex h-10 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-lg bg-panel-3 pr-1.5 pl-3 text-xs shadow-float transition-[opacity,translate] duration-base ease-out ${
        shown ? '' : 'pointer-events-none translate-y-3 opacity-0'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Pixels a pill and its margin take over the foot of a scrolling list (the list pads its end by this). */
export const PILL_CLEARANCE = 64;

/**
 * "12 selected", and while jobs run for them the progress ring with "23 of 58" in mono (ODDHALLS_LAYOUT_PLAN 6, many
 * of something). A `status`, so the count is announced.
 */
export function PillCount({ count, progress }: { count: number; progress: { done: number; total: number } | null }) {
  return (
    <span role="status" className="flex shrink-0 items-center text-fg tabular-nums">
      {count} selected
      {progress && (
        <span className="ml-2 flex items-center gap-1.5 font-mono text-fg-2">
          <ProgressRing value={progress.total > 0 ? progress.done / progress.total : 0} size={14} />
          {progress.done} of {progress.total}
        </span>
      )}
    </span>
  );
}

/** A hairline between groups of the pill's content. */
export function PillDivider() {
  return <span aria-hidden="true" className="h-4 w-px shrink-0 bg-hairline" />;
}
