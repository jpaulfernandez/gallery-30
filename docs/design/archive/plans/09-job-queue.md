# 09 · Job queue

Status: done 2026-10-12, with these deviations. Renders and denoise share one lane of one job (the plan's "one at a
time, the GPU is shared"), publish has its own lane of one and exports a lane of two; the job record also has
`queuedAt`, `detail`, `log` and `cancelling`, `startedAt` is null while queued and `cancel` is set only while a job runs.
`enqueue` takes a `dedupe` key (equal denoise or render work is joined, so publish waits on an Apply already running) and
the next job starts on the task after one ends, so a waiter can cancel the rest first. The publish gate queues one
`render` job per photo (not one batch per folder) and cancels the jobs it created (never ones it joined) through an
`AbortSignal`. The Rust audit: `render_develop_full` (`write_atomic`), the CLI writers (`state.ts`, `images.ts`,
`pages.ts`, `recordPublish`) and `write_intermediate` already wrote temp files and renamed them; fixed were
`write_intermediate` leaving its `.part` file on a failed write and a PNG without its sidecar, `run_denoise` writing
the intermediate after a cancel that came during the last tile and leaving a full-size intermediate without its
1600 px copy when that write failed (now `denoise_into_cache`), and a full render cancelled mid-photo, which used to
finish and write: it is now checked after the decode and after the render and writes nothing. The publish dialog's
state moved to `components/editor/publishSession.ts`: closing the dialog no longer cancels the run, and the publish
record is written on success even with the dialog closed. `JobsBar` floats bottom-right (mounted in `main.tsx`; there
is no status bar). Settings' Doctor and Clear password runs are `publish` jobs too (Rust kills a running CLI when
another starts, so they must not overlap). An Apply on a library photo belongs to no project, and Develop shows a
publish-queued denoise only for a project asset (jobs are found by photo id). Checked by Rust tests (a 2400 × 1600
fixture cancelled after the decode and after the render leaves nothing under `.photobook-cache/develop/`; the
installed NAFNet cancelled after its first tile leaves no `denoise-*` file; failed writes leave no temp file) and
Vitest (queue, gate, runner, dialog count, bar); the in-app smoke test (24 MP cancel, publish with pending denoise) is
not run yet. After review: a run that completes although a cancel came too late ends done with its value (cancelled
only when it stops); a cancel that reaches Rust before `run_denoise` or `run_publish` registered is remembered and
applied when they start (`PendingCancels`); a CLI that cannot start is a failure, not a cancel; an aborted publish stops
waiting on a joined job at once and leaves it running; closing a project cancels a job only when no other project or
library Apply joined it; the dialog counts only the jobs its gate waits for; and `run_denoise` keeps the two most
recent other intermediates of the same bytes (`KEEP_DENOISE_KEYS` 3: versions with other denoise settings no longer
delete each other's during a publish).

WORKFLOW_PLAN [1.1](../WORKFLOW_PLAN.md#11-three-stages-one-top-bar) (W2.4), [5.3](../WORKFLOW_PLAN.md#53-workflow-integration).
Size: 1 day. Depends on: 05.

**Goal.** One place for long work (full renders, denoise, publish, later exports and captions) with progress,
cancel and a status-bar list, fed by the events that already exist.

## Decisions

- `store/jobs.ts` (not undoable): `jobs: Record<id, { id, kind, label, ref?, done, total, state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled', error?, startedAt, cancel? }>`.
  Concurrency per kind: renders and denoise one at a time (the GPU is shared), publish one, exports two.
- A cancelled job leaves no partial file: every Rust writer in the path writes to a temp name and renames at the end
  (`render_develop_full`, `write_intermediate`, publish). Verify each, fix the ones that do not.
- The queue drains in the background across stage changes; closing the project cancels its jobs and says so.

## Steps

1. **Store.** `enqueue(job)`, `start`, `progress`, `finish`, `fail`, `cancel`, `clearDone`; a `runner` that starts
   queued jobs per the concurrency rule; `useJobs` selectors (active count, by ref).
2. **Adapters.** `lib/jobs/developRender.ts` wraps `renderDevelopFull` + `onDevelopProgress` + `cancelDevelop`;
   `lib/jobs/denoise.ts` wraps `run_denoise` + `cancel_denoise` (replacing the ad-hoc job map in `ui.denoise.jobs`);
   `lib/publishRunner.ts` reports as one job with the line log attached.
3. **Status bar.** `components/shell/JobsBar.tsx`: a pill with the active count, a popover listing jobs with progress
   bars and Cancel; errors stay until dismissed.
4. **Publish gate.** `lib/developPublish.ts` enqueues the denoise and full-render jobs and waits on them; the
   publish dialog shows "N photos still rendering" with the queue state.
5. **Rust audit.** Confirm temp + rename on every writer in the job paths; add a test for cancel mid-render leaving
   no file under `.photobook-cache/develop/`.

## Check

- Vitest on the store: concurrency, cancel of a queued job never starts it, failure keeps the rest running.
- Cancel a 24 MP render mid-way: no partial `.jpg`; cancel a denoise mid-tile: no `denoise-*.png` or `.json`.
- Publish of a project with pending denoise waits and succeeds; the dialog shows the count.

## Docs

- `CLAUDE.md` Layout (`store/jobs.ts`), `docs/DEVELOP.md` (background work).
