import { type FocusEvent, type ReactNode, useRef } from 'react';
import { create } from 'zustand';
import { Button, IconButton } from './Button';
import { ProgressRing } from './ProgressRing';

/**
 * Plan 45: the toasts of ODDHALLS_UI_PLAN 4.1. One host (`ToastHost`, mounted once in `main.tsx`) draws the stack
 * bottom-left: `panel-3`, hairline, `md` radius, entering with an 8 px rise and a fade (`slow`). A toast closes after
 * 6 s unless the pointer or the focus is on it; a job's toast carries a 16 px progress ring and stays until it is
 * dismissed. `toast.show` / `toast.update` / `toast.dismiss` drive the host's own toasts; a feature with its own run
 * store (the export toasts) renders `Toast` cards inside the host instead.
 *
 * Plan 49, the completion beat (ODDHALLS_LAYOUT_PLAN 6): when a job's toast turns `done`, its ring completes and the
 * check draws, the running text holds for `--dur-hold` (400 ms), then what landed and its actions (Reveal in Finder)
 * fade in where it was. The beat is CSS (`beat-out`, `beat-in` in `styles.css`), so reduced motion shows the result
 * at once and the final text is in the document from the start.
 */

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  text: ReactNode;
  /** Buttons after the text (Undo, Reveal in Finder). Choosing one closes the toast. */
  actions?: ToastAction[];
  /** A job's progress, 0–1, or `'busy'` before it is known; the ring completes and shows a check at `done`. */
  progress?: number | 'busy';
  done?: boolean;
  tone?: 'default' | 'danger';
  /** How long it stays, ms (default 6 s); `null` keeps it until dismissed. */
  durationMs?: number | null;
  /** Called once when the toast closes, whatever closed it. */
  onClose?: () => void;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastState {
  toasts: ToastEntry[];
}

export const useToasts = create<ToastState>()(() => ({ toasts: [] }));

const DEFAULT_MS = 6000;
/** Time a paused toast gets back at least, ms. */
const RESUME_MIN_MS = 1500;
let nextId = 1;
const timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; left: number; started: number }>();

function arm(id: number, ms: number) {
  const t = setTimeout(() => toast.dismiss(id), ms);
  timers.set(id, { timer: t, left: ms, started: Date.now() });
}

export const toast = {
  /** Show a toast; returns its id. */
  show(options: ToastOptions): number {
    const id = nextId++;
    useToasts.setState((s) => ({ toasts: [...s.toasts, { ...options, id }] }));
    const ms = options.durationMs === undefined ? DEFAULT_MS : options.durationMs;
    if (ms !== null) arm(id, ms);
    return id;
  },
  /** Change a toast in place (its progress, its text once done). */
  update(id: number, patch: Partial<ToastOptions>): void {
    useToasts.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    if (patch.durationMs !== undefined) {
      const old = timers.get(id);
      if (old?.timer) clearTimeout(old.timer);
      timers.delete(id);
      if (patch.durationMs !== null) arm(id, patch.durationMs);
    }
  },
  /** Close a toast (every toast without an id). */
  dismiss(id?: number): void {
    const closing = useToasts.getState().toasts.filter((t) => id === undefined || t.id === id);
    if (closing.length === 0) return;
    for (const t of closing) {
      const timer = timers.get(t.id);
      if (timer?.timer) clearTimeout(timer.timer);
      timers.delete(t.id);
    }
    const gone = new Set(closing.map((t) => t.id));
    useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => !gone.has(t.id)) }));
    for (const t of closing) t.onClose?.();
  },
  /** Stop a toast's countdown (pointer or focus on it). */
  pause(id: number): void {
    const t = timers.get(id);
    if (!t?.timer) return;
    clearTimeout(t.timer);
    timers.set(id, { timer: null, left: t.left - (Date.now() - t.started), started: 0 });
  },
  /** Restart it with the time it had left (at least 1.5 s). */
  resume(id: number): void {
    const t = timers.get(id);
    if (!t || t.timer) return;
    arm(id, Math.max(t.left, RESUME_MIN_MS));
  },
};

export interface ToastProps {
  children: ReactNode;
  actions?: ToastAction[];
  progress?: number | 'busy';
  done?: boolean;
  tone?: 'default' | 'danger';
  /** Shows ✕; the toast does not close itself. */
  onDismiss?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}

/** One toast card. Inside `ToastHost` it stacks with the others. */
export function Toast({
  children,
  actions,
  progress,
  done,
  tone = 'default',
  onDismiss,
  onPause,
  onResume,
}: ToastProps) {
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) onResume?.();
  };
  // The last running text, held through the beat; a toast that was never running has no beat.
  const running = progress !== undefined && !done;
  const held = useRef<ReactNode>(null);
  if (running) held.current = children;
  const beat = Boolean(done) && held.current !== null;
  return (
    <div
      role="status"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onBlur}
      className={`pointer-events-auto flex items-center gap-2 rounded-md border border-hairline bg-panel-3 py-1.5 pr-1.5 pl-2.5 text-xs shadow-float transition-[opacity,translate] duration-slow ease-out starting:translate-y-2 starting:opacity-0 ${
        tone === 'danger' ? 'text-danger' : 'text-fg'
      }`}
    >
      {(progress !== undefined || done) && (
        <ProgressRing value={done ? 1 : progress === 'busy' ? undefined : progress} done={done} />
      )}
      {beat ? (
        <span className="grid min-w-0 flex-1" data-beat>
          <span aria-hidden="true" className="beat-out [grid-area:1/1]">
            {held.current}
          </span>
          <span className="beat-in [grid-area:1/1]">{children}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1">{children}</span>
      )}
      {actions?.map((a) => (
        <Button key={a.label} variant="ghost" size="sm" className={beat ? 'beat-in' : ''} onClick={a.run}>
          {a.label}
        </Button>
      ))}
      {onDismiss && (
        <IconButton
          variant="ghost"
          size="sm"
          label="Dismiss"
          icon={<span aria-hidden="true">✕</span>}
          onClick={onDismiss}
        />
      )}
    </div>
  );
}

function HostToast({ entry }: { entry: ToastEntry }) {
  const id = entry.id;
  const close = () => toast.dismiss(id);
  return (
    <Toast
      actions={entry.actions?.map((a) => ({
        label: a.label,
        run: () => {
          close();
          a.run();
        },
      }))}
      progress={entry.progress}
      done={entry.done}
      tone={entry.tone}
      onDismiss={close}
      onPause={() => toast.pause(id)}
      onResume={() => toast.resume(id)}
    >
      {entry.text}
    </Toast>
  );
}

/**
 * The toast stack, bottom-left (the jobs pill is bottom-right): the feeds passed as `children` (the export toasts,
 * each with its own run store), then `toast.show`'s. Mounted once, in `main.tsx`. It sits above a dialog's scrim
 * (z 60) and under tooltips (z 70).
 */
export function ToastHost({ children }: { children?: ReactNode }) {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 left-3 z-[65] flex max-w-[28rem] flex-col gap-1.5"
      data-toast-host
    >
      {children}
      {toasts.map((t) => (
        <HostToast key={t.id} entry={t} />
      ))}
    </div>
  );
}
