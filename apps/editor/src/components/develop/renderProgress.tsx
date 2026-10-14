import { useEffect, useState } from 'react';
import { create } from 'zustand';

/**
 * Plan 46: whether the live preview is behind the settings (a render asked for and not painted yet), for the pulsing
 * accent dot in the Develop header and on the Looks tile that asked (ODDHALLS_UI_PLAN 4.4, LAYOUT 6). `usePreview`
 * writes it; nothing is shown for work under `RENDER_DOT_DELAY_MS`, so a fast render never flickers a dot.
 */
export const RENDER_DOT_DELAY_MS = 300;

export const useRenderProgress = create<{ pending: boolean }>(() => ({ pending: false }));

export function setRenderPending(pending: boolean): void {
  if (useRenderProgress.getState().pending !== pending) useRenderProgress.setState({ pending });
}

/** True once a render has been pending for `RENDER_DOT_DELAY_MS`; false as soon as it lands. */
export function useRenderSlow(): boolean {
  const pending = useRenderProgress((s) => s.pending);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), RENDER_DOT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return slow;
}

/** The pulsing 6 px accent dot: work is under way for the control it sits on. */
export function RenderDot({ className = '', label = 'Rendering' }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`size-1.5 shrink-0 pulse-dot rounded-pill bg-accent ${className}`}
    />
  );
}
