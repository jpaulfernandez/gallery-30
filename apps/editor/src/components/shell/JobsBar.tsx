import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isActive, JOB_KINDS, type Job, jobList, useJobsStore } from '../../store/jobs';
import { Button, IconButton } from '../ui/Button';
import { PopoverButton } from '../ui/Popover';
import { ProgressRing } from '../ui/ProgressRing';

/** "Render", "Denoise", ... for the list. */
const kindName = (job: Job) => {
  const noun = JOB_KINDS[job.kind].noun;
  return noun.charAt(0).toUpperCase() + noun.slice(1);
};

/** What the row says under its label. */
export function jobStatusText(job: Job): string {
  switch (job.state) {
    case 'queued':
      return 'Queued';
    case 'running':
      if (job.cancelling) return 'Cancelling…';
      if (job.total > 0 && job.detail) return `${job.done}/${job.total} · ${job.detail}`;
      if (job.total > 0) return `${job.done}/${job.total}`;
      return job.detail ?? 'Running…';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return job.error ?? 'Failed';
  }
}

/** A job's progress, 0–1, or undefined while it has no count yet. */
const fraction = (job: Job): number | undefined => (job.total > 0 ? Math.min(1, job.done / job.total) : undefined);

function JobRow({ job }: { job: Job }) {
  const store = useJobsStore.getState;
  return (
    <li className="space-y-1 px-2 py-1.5" data-testid="job-row">
      <div className="flex items-center gap-2 text-xs">
        {/* Plan 45: one ring per job, never a bar (ODDHALLS_LAYOUT_PLAN 6). */}
        {job.state === 'running' && <ProgressRing value={fraction(job)} label={`${job.label} progress`} />}
        <span className="shrink-0 text-fg-muted">{kindName(job)}</span>
        <span className="min-w-0 flex-1 truncate text-fg" title={job.label}>
          {job.label}
        </span>
        {isActive(job) ? (
          !job.cancelling && (
            <Button variant="ghost" size="sm" onClick={() => store().cancel(job.id)}>
              Cancel
            </Button>
          )
        ) : (
          <IconButton
            size="sm"
            label={`Dismiss ${job.label}`}
            icon={<span aria-hidden="true">✕</span>}
            onClick={() => store().dismiss(job.id)}
          />
        )}
      </div>
      <p
        className={`truncate text-[11px] ${job.state === 'failed' ? 'text-danger' : 'text-fg-muted'}`}
        role={job.state === 'failed' ? 'alert' : undefined}
        title={jobStatusText(job)}
      >
        {jobStatusText(job)}
      </p>
      {job.state === 'failed' && job.log && job.log.length > 0 && (
        <pre className="scrollbar max-h-24 overflow-auto rounded bg-panel-2 p-1.5 font-mono text-[10px] text-warn/90 leading-relaxed">
          {job.log.slice(-8).join('\n')}
        </pre>
      )}
    </li>
  );
}

/**
 * The jobs pill (plan 45): a small progress ring (all running jobs' counts together; turning while none has a count)
 * and the count, `panel-3` and a hairline on a `pill` radius. A failure shows a `danger` dot instead.
 */
export function JobsPillLabel({
  active,
  failed,
  progress,
  running,
  done = false,
}: {
  active: number;
  failed: number;
  /** 0–1 over the running jobs that count, else undefined. */
  progress: number | undefined;
  /** The running job's label. */
  running?: string;
  /** Plan 49: the last job just finished; the ring completes with its check (the completion beat). */
  done?: boolean;
}) {
  const label = done
    ? 'Done'
    : active > 0
      ? `${active} job${active === 1 ? '' : 's'}`
      : failed > 0
        ? `${failed} failed`
        : 'Jobs';
  return (
    <>
      {(active > 0 || done) && <ProgressRing value={done ? 1 : progress} done={done} />}
      {failed > 0 && active === 0 && <span aria-hidden="true" className="size-1.5 rounded-pill bg-danger" />}
      <span className="font-mono tabular-nums">{label}</span>
      {running && <span className="max-w-40 truncate text-fg-muted">· {running}</span>}
    </>
  );
}

/** Classes of the pill. */
export const jobsPillClass =
  'flex h-7 items-center gap-1.5 rounded-pill border border-hairline bg-panel-3 pr-3 pl-2 text-fg text-xs shadow-float outline-none transition-colors duration-fast hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Plan 09: the status-bar list of the job queue (`store/jobs.ts`), in the bottom-right corner of every screen. A pill
 * with the number of queued and running jobs opens the list: progress bars and Cancel for active jobs, ✕ for finished
 * ones. Failures (and the note that closing a project cancelled its jobs) stay until dismissed; the pill hides when
 * nothing is active, failed or to be read. Plan 49, the completion beat: when the last active job finishes (and none
 * failed), the pill's ring completes with its check, holds `--dur-hold` and fades out (`beat-out`), then leaves.
 */
export function JobsBar() {
  const jobs = useJobsStore(useShallow(jobList));
  const notice = useJobsStore((s) => s.notice);
  const active = jobs.filter(isActive).length;
  const failed = jobs.filter((j) => j.state === 'failed').length;
  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'cancelled').length;
  // The beat starts when the active count falls to zero with no failure and a job done; a new job ends it.
  const [wasActive, setWasActive] = useState(active);
  const [beat, setBeat] = useState(false);
  if (wasActive !== active) {
    setWasActive(active);
    setBeat(wasActive > 0 && active === 0 && failed === 0 && jobs.some((j) => j.state === 'done'));
  }
  const beating = beat && active === 0 && failed === 0;
  if (active === 0 && failed === 0 && !notice && !beating) return null;
  const running = jobs.find((j) => j.state === 'running');
  const counted = jobs.filter((j) => j.state === 'running' && j.total > 0);
  const total = counted.reduce((n, j) => n + j.total, 0);
  const progress = total > 0 ? counted.reduce((n, j) => n + Math.min(j.done, j.total), 0) / total : undefined;

  return (
    <div className="fixed right-3 bottom-3 z-30 flex flex-col items-end gap-1.5">
      {notice && (
        <div
          role="status"
          className="flex max-w-80 items-center gap-2 rounded-md border border-hairline bg-panel-3 py-1.5 pr-1.5 pl-2.5 text-fg-2 text-xs shadow-float"
        >
          <span className="flex-1">{notice}</span>
          <IconButton
            size="sm"
            label="Dismiss"
            icon={<span aria-hidden="true">✕</span>}
            onClick={() => useJobsStore.getState().dismissNotice()}
          />
        </div>
      )}
      {beating && (
        <output
          aria-label="Jobs done"
          data-testid="jobs-done"
          // The ring's check draws first (`check-draw`); its animationend bubbles here and must not end the beat.
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setBeat(false);
          }}
          className={`${jobsPillClass} beat-out`}
        >
          <JobsPillLabel active={0} failed={0} progress={1} done />
        </output>
      )}
      {(active > 0 || failed > 0) && (
        <PopoverButton
          label={<JobsPillLabel active={active} failed={failed} progress={progress} running={running?.label} />}
          ariaLabel={`Jobs: ${active} active${failed > 0 ? `, ${failed} failed` : ''}`}
          title="Background jobs"
          panelLabel="Jobs"
          width={320}
          alignEnd
          className={jobsPillClass}
        >
          {() => (
            <div className="flex max-h-[60vh] flex-col">
              <ul className="min-h-0 flex-1 divide-y divide-hairline scrollbar overflow-x-hidden overflow-y-auto">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
              {finished > 0 && (
                <div className="flex justify-end border-hairline border-t p-1">
                  <Button variant="ghost" size="sm" onClick={() => useJobsStore.getState().clearDone()}>
                    Clear finished
                  </Button>
                </div>
              )}
            </div>
          )}
        </PopoverButton>
      )}
    </div>
  );
}
