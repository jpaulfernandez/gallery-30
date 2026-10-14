import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui';

/** How long "Saved" stays after a write before it fades, ms (ODDHALLS_LAYOUT_PLAN 6, *Saving*). */
export const SAVED_SHOWN_MS = 1200;

/**
 * Plan 45: the top bar's save state. "Saved" fades in after a write, stays 1.2 s, then fades to nothing (`slow`); a
 * failed save stays as a red "Not saved" with the reason on hover. Never a spinner. Nothing shows (or is announced)
 * while editing.
 */
export function SaveIndicator({ className = '' }: { className?: string }) {
  const status = useUiStore((s) => s.saveStatus);
  const error = useUiStore((s) => s.saveError);
  const [flash, setFlash] = useState(false);
  const previous = useRef(status);

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'saved' || was === 'saved') return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), SAVED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const failed = status === 'error';
  const shown = failed || (flash && status === 'saved');
  const label = failed ? 'Not saved' : 'Saved';
  // The live region holds the words only while they show, so a reader hears each save and never a stale "Saved";
  // the visible copy is a separate, hidden-from-readers span so it can fade out after the words are gone.
  return (
    <span
      role="status"
      title={failed ? (error ?? undefined) : undefined}
      data-save={failed ? 'error' : shown ? 'saved' : 'idle'}
      className={`relative whitespace-nowrap text-xs ${failed ? 'text-danger' : 'text-fg-muted'} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`transition-opacity duration-slow ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
      >
        {label}
      </span>
      {shown && <span className="sr-only">{label}</span>}
    </span>
  );
}
