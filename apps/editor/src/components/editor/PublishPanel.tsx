import { useState } from 'react';
import { pendingDenoiseCount } from '../../lib/denoiseQueue';
import type { PublishStep } from '../../lib/publishRunner';
import { useBookStore } from '../../store/book';
import { isActive, type JobKind, type JobsState, useJobsStore } from '../../store/jobs';
import { Button } from '../ui/Button';
import { cancelPublishSession, startPublishSession, usePublishSession } from './publishSession';

const STEPS: Array<{ id: PublishStep; label: string }> = [
  { id: 'denoise', label: 'Denoising' },
  { id: 'develop', label: 'Render edited photos' },
  { id: 'freeze', label: 'Freeze project' },
  { id: 'images', label: 'Image versions' },
  { id: 'pages', label: 'Page images' },
  { id: 'plan', label: 'Compare with R2' },
  { id: 'upload', label: 'Upload' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'site', label: 'Site file' },
];

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** How many of `ids` (the publish's gate jobs) of `kind` are still queued or running. */
const pendingOf = (s: JobsState, ids: readonly string[], kind: JobKind) =>
  ids.filter((id) => {
    const job = s.jobs[id];
    return job?.kind === kind && isActive(job);
  }).length;

/** "3 photos still rendering · 1 still denoising" from the queue, or null when none of the publish's are left. */
export function pendingPhotosText(rendering: number, denoising: number): string | null {
  const photos = (n: number) => (n === 1 ? '1 photo' : `${n} photos`);
  const parts = [
    ...(rendering > 0 ? [`${photos(rendering)} still rendering`] : []),
    ...(denoising > 0 ? [`${photos(denoising)} still denoising`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Step 2.7: runs the publish CLI for the open book and streams its progress: one row per step
 * with timing, a log of warnings, and on success the reader link with a copy button. The publish
 * record (`lastPublishedAt`, `publishedFingerprint`) is written into the open document when the run succeeds; the
 * CLI runs with `--no-record` because the editor owns the project file.
 *
 * Plan 09: the run is a `publish` job (`publishSession.ts`) that waits for its denoise and render jobs; the dialog
 * shows how many of the project's photos are still in the queue. Closing the dialog leaves the run going (the jobs
 * bar has it); reopening it shows the run again.
 */
export function PublishPanel({ onClose }: { onClose: () => void }) {
  const project = useBookStore((s) => s.projectId);
  const slug = useBookStore((s) => s.book?.publish.slug ?? '');
  const session = usePublishSession();
  const mine = session.project === project;
  const phase = mine ? session.phase : 'idle';
  const steps = mine ? session.steps : {};
  const log = mine ? session.log : [];
  const result = mine ? session.result : null;
  const error = mine ? session.error : null;
  const gateJobs = mine ? session.gateJobs : [];
  const rendering = useJobsStore((s) => pendingOf(s, gateJobs, 'render'));
  const denoising = useJobsStore((s) => pendingOf(s, gateJobs, 'denoise'));
  const pending = phase === 'running' ? pendingPhotosText(rendering, denoising) : null;
  // Plan 27: denoise queued ahead of time (Denoise selected, Apply, leaving a photo) for this book's photos.
  const book = useBookStore((s) => s.book);
  const queuedDenoise = useJobsStore((s) => pendingDenoiseCount(s, book));
  const [dryRun, setDryRun] = useState(false);
  const [prune, setPrune] = useState(false);
  const [copied, setCopied] = useState(false);

  const start = () => {
    setCopied(false);
    void startPublishSession({ dryRun, prune });
  };

  const link = result?.link ?? result?.url ?? null;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog (a running publish goes on); Escape is handled by the Close button focus
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-stage/60"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Publish"
        className="w-[520px] max-w-[90vw] rounded-lg border border-line bg-panel p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium text-base">Publish to the web</h2>
          <span className="font-mono text-fg-muted text-xs">/{slug}</span>
        </div>

        {phase === 'idle' && (
          <div className="space-y-3 text-xs">
            <p className="text-fg-muted leading-relaxed">
              Renders edited photos at full size, freezes the project, derives the image versions, uploads what is new
              to R2 and rewrites the manifest and site file. Settings come from the Settings screen.
            </p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run (process images, upload nothing)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
              Prune objects this book no longer uses
            </label>
            {queuedDenoise > 0 && (
              <p className="text-fg-muted" data-testid="publish-queued-denoise">
                {pendingPhotosText(0, queuedDenoise)}; Publish waits for them.
              </p>
            )}
          </div>
        )}

        {phase !== 'idle' && (
          <ol className="space-y-1.5 text-xs">
            {STEPS.map(({ id, label }) => {
              const st = steps[id];
              // Only books with edited photos have this step.
              if ((id === 'develop' || id === 'denoise') && !st) return null;
              const status = st?.status ?? 'pending';
              const icon = status === 'done' ? '✓' : status === 'running' ? '…' : status === 'skipped' ? '–' : '·';
              return (
                <li key={id} className={`flex items-baseline gap-2 ${status === 'pending' ? 'text-fg-muted/60' : ''}`}>
                  <span className="w-3 text-center">{icon}</span>
                  <span className="w-36">{label}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-muted">
                    {status === 'running' && st?.progress
                      ? `${st.progress.done} / ${st.progress.total}${st.progress.detail ? ` · ${st.progress.detail}` : ''}`
                      : (st?.detail ?? '')}
                  </span>
                  {st?.ms !== undefined && <span className="tabular-nums text-fg-muted">{fmtMs(st.ms)}</span>}
                </li>
              );
            })}
          </ol>
        )}

        {pending && (
          <p className="mt-3 text-fg-muted text-xs" data-testid="publish-pending">
            {pending}
          </p>
        )}

        {log.length > 0 && (
          <pre className="scrollbar mt-3 max-h-32 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[11px] text-warn/90 leading-relaxed">
            {log.join('\n')}
          </pre>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-2 text-danger text-xs">
            <p>{error.message}</p>
            {error.keys && (
              <pre className="scrollbar mt-1 max-h-24 overflow-auto font-mono text-[11px]">{error.keys.join('\n')}</pre>
            )}
          </div>
        )}

        {phase === 'done' && result && (
          <div className="mt-3 space-y-2 text-xs">
            <p className="text-fg-muted">
              {result.dryRun
                ? `Dry run: ${result.uploaded} object(s) would upload, ${result.skipped} already on R2.`
                : `Published: ${result.uploaded} uploaded, ${result.skipped} skipped, ${(result.bytes / 1e6).toFixed(1)} MB.`}
            </p>
            {!result.dryRun && link && (
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={link}
                  aria-label="Published link"
                  className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-[11px]"
                />
                <Button size="sm" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2 text-xs">
          {phase === 'running' && (
            <Button variant="danger" onClick={cancelPublishSession}>
              Cancel
            </Button>
          )}
          <Button
            onClick={onClose}
            title={phase === 'running' ? 'The publish goes on in the background (see the jobs list)' : undefined}
          >
            Close
          </Button>
          {phase !== 'running' && (
            <Button variant="primary" onClick={start}>
              {phase === 'idle' ? (dryRun ? 'Run dry run' : 'Publish') : 'Run again'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
