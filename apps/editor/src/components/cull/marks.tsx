import { useRef } from 'react';
import { isActive, type Job, useJobsStore } from '../../store/jobs';
import { FlagIcon, RejectIcon } from '../filmstrip/FilmstripCell';

/**
 * Plan 47: the marks a Cull tile carries (ODDHALLS_UI_PLAN 3), shared by the grid, Survey, Compare, Decide and the
 * reject pile so a selection, a focus and a flag read the same everywhere: selected is a 2 px `fg` ring plus the
 * check; focused (what the keys act on) is the 2 px `accent` ring 2 px out, outside the photo; a keep stamps in, a
 * reject dims the photo over `base`.
 */

/** A tile's selection and focus rings (Survey and the reject pile; the grid draws one sliding focus ring instead). */
export function tileRings({ selected, focused }: { selected: boolean; focused?: boolean }): string {
  return `${selected ? 'ring-2 ring-fg' : ''} ${focused ? 'outline-2 outline-accent outline-offset-2' : 'outline-none'}`;
}

/** The reject dim of a tile's photo, faded over `base`. */
export const dimClass = (flag: string | null | undefined): string =>
  `transition-opacity duration-base ease-out ${flag === 'reject' ? 'opacity-35' : ''}`;

/** The selection check: a white disc with a dark check, beside the flag at the top left. */
export function SelectCheck() {
  return (
    <span
      role="img"
      aria-label="Selected"
      className="flex size-4 items-center justify-center rounded-full bg-fg text-stage shadow-raised"
    >
      <svg viewBox="0 0 16 16" className="size-2.5" fill="none" aria-hidden="true">
        <path
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * True once `value` has changed since the component mounted or `reset` last changed: a mark that was already there
 * when a tile appeared (or when the tile took another photo, `reset`) does not pop, one the user just set does.
 */
export function useChanged<T>(value: T, reset?: unknown): boolean {
  const first = useRef({ value, reset });
  const changed = useRef(false);
  if (reset !== first.current.reset) {
    first.current = { value, reset };
    changed.current = false;
  } else if (value !== first.current.value) changed.current = true;
  return changed.current;
}

/** The flag badge: Kept (`pick`) or Rejected (`danger`); `stamp` replays the stamp (scale .6 to 1) when it changes. */
export function FlagStamp({
  flag,
  stamp = false,
  className = 'size-4',
}: {
  flag: 'pick' | 'reject';
  stamp?: boolean;
  className?: string;
}) {
  return (
    <span
      key={stamp ? flag : undefined}
      role="img"
      aria-label={flag === 'pick' ? 'Kept' : 'Rejected'}
      className={`flex items-center justify-center rounded-full shadow-raised ${className} ${
        flag === 'pick' ? 'bg-pick text-canvas' : 'bg-danger text-fg'
      } ${stamp ? 'flag-stamp' : ''}`}
    >
      {flag === 'pick' ? <FlagIcon /> : <RejectIcon />}
    </span>
  );
}

/**
 * ODDHALLS_LAYOUT_PLAN 6, many of something: while jobs run, each photo of the batch (the jobs queued since the
 * oldest one still active) has a value: how far its running job is (0 while queued), or 1 once its jobs ended. No
 * active job anywhere: no batch, no values. Computed once per jobs-store state and shared by every cell.
 */
const workCache = new WeakMap<Readonly<Record<string, Job>>, ReadonlyMap<string, number>>();

export function batchWork(jobs: Readonly<Record<string, Job>>): ReadonlyMap<string, number> {
  const cached = workCache.get(jobs);
  if (cached) return cached;
  const all = Object.values(jobs);
  const active = all.filter(isActive);
  const out = new Map<string, number>();
  if (active.length > 0) {
    const start = Math.min(...active.map((j) => j.queuedAt));
    const running = new Map<string, number>();
    for (const job of all) {
      if (job.ref === undefined || job.queuedAt < start) continue;
      if (isActive(job)) {
        const part = job.state === 'running' && job.total > 0 ? job.done / job.total : 0;
        running.set(job.ref, Math.min(running.get(job.ref) ?? 1, part));
      } else if (!out.has(job.ref)) out.set(job.ref, 1);
    }
    for (const [ref, part] of running) out.set(ref, part);
  }
  workCache.set(jobs, out);
  return out;
}

/**
 * The thin `accent` underline under a cell in the gap below it, filling as the photo's item of a batch finishes
 * (export, Describe, Denoise selected). Its own component, so a job's progress re-renders this line, not the cell.
 */
export function WorkLine({ id }: { id: string }) {
  const part = useJobsStore((s) => {
    const v = batchWork(s.jobs).get(id);
    return v === undefined ? undefined : Math.round(v * 20) / 20;
  });
  if (part === undefined) return null;
  return (
    <span
      role="progressbar"
      aria-label="Batch progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(part * 100)}
      className="pointer-events-none absolute inset-x-0.5 -bottom-[3px] h-0.5 overflow-hidden rounded-pill bg-fg/12"
    >
      <span
        className="block h-full origin-left rounded-pill bg-accent transition-transform duration-base ease-out"
        style={{ transform: `scaleX(${part})` }}
      />
    </span>
  );
}
