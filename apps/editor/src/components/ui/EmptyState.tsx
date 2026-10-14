import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** The one line: what is missing, said plainly ("No photos in this folder"). */
  children: ReactNode;
  /** What to do about it, under the line (a button or two). */
  action?: ReactNode;
  /** `lg` (24 px) fills a stage or a page; `md` (18 px) sits in a panel or a section. */
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * Plan 49: every empty state (ODDHALLS_UI_PLAN 4.4): one line in Instrument Serif italic, `fg-2`, with the action
 * beneath, instead of 11 px muted text. Used by Home, the Cull and Develop wells, the Design filmstrip and library,
 * the reject pile and the Downloads sections.
 */
export function EmptyState({ children, action, size = 'lg', className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center gap-3 text-center ${className}`}>
      <p
        className={`m-0 font-['Instrument_Serif'] text-fg-2 italic leading-tight ${size === 'lg' ? 'text-2xl' : 'text-lg'}`}
      >
        {children}
      </p>
      {action}
    </div>
  );
}
