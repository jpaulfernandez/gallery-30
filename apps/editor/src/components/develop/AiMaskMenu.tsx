import type { UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import { AI_TARGET_BUSY, AI_TARGET_LABEL } from '../../lib/develop/masks';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import {
  type AiMaskStage,
  type AiModelInfo,
  cancelModelDownload,
  downloadModel,
  onModelProgress,
  openModelLink,
} from '../../lib/tauri';
import { formatBytes } from '../settings/ModelsPanel';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { type AiJob, cancelAiJob, registryModels, splitPeople, useAiMaskStore } from './useAiMask';
import { nextPreviewJob } from './usePreview';

const STAGE_TEXT: Record<AiMaskStage, string> = {
  loading: 'loading model',
  running: 'running',
  refining: 'refining',
};

/** "Finding the subject…", "Refining the mask…", "Separating person 2 of 5…". */
export function aiJobLabel(job: AiJob): string {
  if (job.kind === 'refine') return 'Refining the mask…';
  if (job.kind === 'people') return `Separating person ${job.step?.[0] ?? 1} of ${job.step?.[1] ?? 1}…`;
  return `${AI_TARGET_BUSY[job.target]}…`;
}

/**
 * The AI rows of the Masks panel for the photo `assetId`: the busy row of a running job (label, stage from
 * `develop:ai-progress`, Cancel), its error, and after a People mask with several people the per-person offer.
 */
export function AiMaskStatusRows({ assetId }: { assetId: string }) {
  const job = useAiMaskStore((s) => (s.job?.assetId === assetId ? s.job : null));
  const error = useAiMaskStore((s) => (s.error?.assetId === assetId ? s.error : null));
  const people = useAiMaskStore((s) => (s.people?.assetId === assetId ? s.people : null));
  if (!job && !error && !people) return null;
  return (
    <div className="space-y-1.5">
      {job && (
        <div
          role="status"
          aria-label="AI mask in progress"
          className="flex items-center gap-2 rounded-sm border border-accent/50 bg-accent/10 px-2 py-1 text-[11px]"
          data-ai-busy={job.kind}
        >
          <span
            className="size-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-fg">
            {aiJobLabel(job)} <span className="text-fg-muted">{job.stage ? STAGE_TEXT[job.stage] : 'starting'}</span>
          </span>
          <button
            type="button"
            onClick={cancelAiJob}
            className="rounded-sm px-1 text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 text-[11px] text-danger">
          <span className="min-w-0 flex-1 break-words">{error.message}</span>
          <button
            type="button"
            aria-label="Dismiss the error"
            onClick={() => useAiMaskStore.setState({ error: null })}
            className="rounded-sm px-1 text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            ✕
          </button>
        </div>
      )}
      {people && (
        <fieldset
          className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 rounded-sm border border-line px-2 py-1 text-[11px]"
          aria-label="People"
        >
          <span className="mr-auto text-fg-muted">Found {people.boxes.length} people.</span>
          <button
            type="button"
            aria-pressed={true}
            onClick={() => useAiMaskStore.setState({ people: null })}
            title="Keep one component with everybody"
            className="rounded-sm bg-accent/30 px-1.5 py-0.5 text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            All people
          </button>
          <button
            type="button"
            aria-pressed={false}
            onClick={() => void splitPeople(people)}
            title="Replace it with one component per person (Person 1, Person 2, …) in this mask"
            className="rounded-sm border border-line px-1.5 py-0.5 text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            One per person
          </button>
        </fieldset>
      )}
    </div>
  );
}

interface Received {
  received: number;
  total: number;
}

/**
 * First-use prompt when an AI mask needs models that are not installed: each model with its size and licence, the
 * total, and Download, which fetches them one after the other with progress (the same commands as Settings →
 * Models) and then runs the mask again. Cancel stops a download (its partial file is kept for next time) and drops
 * the job. Errors (offline, checksum) show in the dialog with Retry.
 */
export function AiModelDownloadDialog() {
  const request = useAiMaskStore((s) => s.download);
  if (!request) return null;
  return <DownloadDialog key={request.models.map((m) => m.name).join(',')} />;
}

function DownloadDialog() {
  const request = useAiMaskStore((s) => s.download);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Received>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const jobRef = useRef<number | null>(null);
  const closed = useRef(false);

  useEffect(
    () => () => {
      closed.current = true;
    },
    [],
  );

  if (!request) return null;
  const models = request.models;
  const total = models.reduce((sum, m) => sum + m.bytes, 0);
  const label = AI_TARGET_LABEL[request.target];

  const close = () => {
    closed.current = true;
    const job = jobRef.current;
    if (job !== null) {
      cancelModelDownload(job).catch(() => false);
      devLog('develop', 'model download cancelled', { job });
    }
    useAiMaskStore.setState({ download: null });
  };

  const run = async () => {
    setError(null);
    setRunning(true);
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await onModelProgress((e) =>
        setProgress((p) => ({ ...p, [e.name]: { received: e.received, total: e.total } })),
      );
    } catch {
      // No progress events: the bars stay empty until each model is done.
    }
    try {
      for (const m of models) {
        if (closed.current) return;
        if (done[m.name] || m.status.state === 'installed') continue;
        const job = nextPreviewJob();
        jobRef.current = job;
        const info = await downloadModel(m.name, job);
        jobRef.current = null;
        setDone((d) => ({ ...d, [m.name]: true }));
        devLog('develop', 'model downloaded', { name: info.name, version: info.version });
      }
      if (closed.current) return;
      await registryModels(true).catch(() => null);
      const retry = request.retry;
      useAiMaskStore.setState({ download: null });
      retry();
    } catch (err) {
      jobRef.current = null;
      const message = errorMessage(err);
      if (!closed.current && message !== 'cancelled') setError(message);
    } finally {
      unlisten?.();
      if (!closed.current) setRunning(false);
    }
  };

  return (
    <DialogShell title={`Download the models for ${label}`} onClose={close} widthClass="w-[30rem]">
      <DialogBody>
        <p className="text-fg-muted">
          {label} masks run on this Mac. They need {models.length === 1 ? 'this model' : 'these models'}, downloaded
          once and checked against a pinned checksum (Settings → Models lists and deletes them).
        </p>
        <ul className="divide-y divide-line rounded-md border border-line" aria-label="Models to download">
          {models.map((m) => (
            <ModelRow key={m.name} model={m} progress={progress[m.name]} done={done[m.name] === true} />
          ))}
        </ul>
        <p>
          Total: <span className="text-fg tabular-nums">{formatBytes(total)}</span>
        </p>
        {error && (
          <p role="alert" className="break-words text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton primary disabled={running} onClick={() => void run()}>
          {running ? 'Downloading…' : error ? 'Retry' : 'Download'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

function ModelRow({ model: m, progress, done }: { model: AiModelInfo; progress?: Received; done: boolean }) {
  const pct = done ? 100 : progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0;
  const partial = m.status.state === 'partial' ? m.status.bytes : 0;
  return (
    <li className="space-y-1 px-3 py-2" aria-label={m.title}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-fg">{m.title}</span>
        <span className="text-[11px] text-fg-muted tabular-nums">
          {done
            ? 'Installed'
            : partial > 0
              ? `${formatBytes(partial)} of ${formatBytes(m.bytes)}`
              : formatBytes(m.bytes)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-fg-muted">
        <span>Licence:</span>
        <button
          type="button"
          onClick={() => {
            openModelLink(m.name, 'licence').catch((err: unknown) =>
              devLog('develop', 'licence link failed', { error: errorMessage(err) }),
            );
          }}
          title={m.licenceUrl}
          aria-label={`${m.title} licence: ${m.licence}`}
          className="underline decoration-dotted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          {m.licence}
        </button>
      </div>
      {(progress || done) && (
        <div
          role="progressbar"
          aria-label={`${m.title} download`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-1 overflow-hidden rounded bg-panel-2"
        >
          <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}
