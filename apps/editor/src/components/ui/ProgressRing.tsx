/**
 * Plan 45: the progress ring of ODDHALLS_LAYOUT_PLAN 6, the one sign of a job (never a bar): 16 px, an `accent` arc
 * over an `fg` 12 % track. Without a `value` it is busy (an arc turning, still under reduced motion since its speed
 * is a duration token); at `done` it is full with a check, whose stroke draws in `--dur-check` (160 ms, plan 49). The
 * arc's travel is a `base` transition, so a cancelled ring (value back to 0) unwinds.
 */
export interface ProgressRingProps {
  /** Progress, 0–1; omitted while not known. */
  value?: number;
  /** Full, with a check. */
  done?: boolean;
  /** Diameter, px (default 16). */
  size?: number;
  /** Accessible name (the ring is a `progressbar`); without one it is decorative. */
  label?: string;
  className?: string;
}

const STROKE = 2;

export function ProgressRing({ value, done, size = 16, label, className = '' }: ProgressRingProps) {
  const r = (size - STROKE) / 2;
  const length = 2 * Math.PI * r;
  const busy = value === undefined && !done;
  const shown = done ? 1 : Math.min(1, Math.max(0, value ?? 0.25));
  const pct = Math.round(shown * 100);
  return (
    <span
      {...(label
        ? {
            role: 'progressbar',
            'aria-label': label,
            ...(busy ? {} : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }),
          }
        : { 'aria-hidden': true })}
      data-progress={busy ? 'busy' : pct}
      className={`relative inline-flex shrink-0 items-center justify-center text-accent ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="-rotate-90"
        style={busy ? { animation: 'spin calc(var(--dur-slow) * 3) linear infinite' } : undefined}
        aria-hidden="true"
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={STROKE} className="stroke-fg/12" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - shown)}
          className="transition-[stroke-dashoffset] duration-base ease-out"
        />
      </svg>
      {done && (
        <svg viewBox="0 0 16 16" className="absolute inset-0 m-auto size-[62%]" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.4l2.9 2.9 6-6.3"
            pathLength={1}
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="check-draw"
          />
        </svg>
      )}
    </span>
  );
}
