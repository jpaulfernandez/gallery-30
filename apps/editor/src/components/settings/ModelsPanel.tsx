import type { UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import {
  cancelModelDownload,
  deleteModel,
  downloadModel,
  listModels,
  type ModelInfo,
  type ModelTask,
  modelsDir,
  onModelProgress,
  openModelLink,
} from '../../lib/tauri';
import { buttonClass as buttonLook } from '../ui/Button';
import { DenoiseDefaults } from './DenoiseDefaults';

const TASK_LABELS: Record<ModelTask, string> = {
  subject: 'Subject',
  'subject-fast': 'Subject (fast)',
  sky: 'Sky',
  'people-detect': 'People',
  'sam-encoder': 'Refine (encoder)',
  'sam-decoder': 'Refine (decoder)',
  depth: 'Depth',
  denoise: 'Denoise',
};

/** Decimal units, like Finder. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

interface Received {
  received: number;
  total: number;
}

let nextJob = Date.now();

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = buttonLook({ size: 'sm' });

/**
 * Settings → Models (D4.2): the pinned ONNX models (crates/develop/models.toml) with task, size, licence and state;
 * download (resumes a partial file), cancel and delete. Nothing ships with the app; masks and denoise ask for their
 * model on first use.
 */
export function ModelsPanel() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, Received>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels(await listModels());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    onModelProgress((e) => {
      setProgress((p) => ({ ...p, [e.name]: { received: e.received, total: e.total } }));
      // A download started before this view was opened has no promise here: pick up its result from the list.
      if (e.received >= e.total) void refresh();
    }).then(
      (u) => {
        if (alive) unlisten = u;
        else u();
      },
      () => {},
    );
    void refresh();
    modelsDir().then(
      (d) => alive && setDir(d),
      () => {},
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [refresh]);

  const replace = (info: ModelInfo) => setModels((ms) => ms?.map((m) => (m.name === info.name ? info : m)) ?? ms);
  const setRowError = (name: string, message: string | null) =>
    setRowErrors((errs) => {
      const { [name]: _, ...rest } = errs;
      return message ? { ...rest, [name]: message } : rest;
    });
  const clearProgress = (name: string) =>
    setProgress((p) => {
      const { [name]: _, ...rest } = p;
      return rest;
    });

  const download = async (m: ModelInfo) => {
    const job = nextJob++;
    setRowError(m.name, null);
    setProgress((p) => ({
      ...p,
      [m.name]: { received: m.status.state === 'partial' ? m.status.bytes : 0, total: m.bytes },
    }));
    replace({ ...m, job });
    try {
      replace(await downloadModel(m.name, job));
    } catch (err) {
      const message = errorMessage(err);
      if (message !== 'cancelled') setRowError(m.name, message);
      await refresh();
    } finally {
      clearProgress(m.name);
    }
  };

  const cancel = async (m: ModelInfo) => {
    if (m.job === undefined) return;
    await cancelModelDownload(m.job).catch(() => false);
    // A download this view started settles through its promise; one started earlier only shows up in the list.
    window.setTimeout(() => void refresh(), 500);
  };

  const remove = async (m: ModelInfo) => {
    setConfirming(null);
    setDeleting(m.name);
    setRowError(m.name, null);
    try {
      replace(await deleteModel(m.name));
    } catch (err) {
      setRowError(m.name, errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const openLink = (m: ModelInfo, page: 'licence' | 'homepage') =>
    openModelLink(m.name, page).catch((err) => setRowError(m.name, errorMessage(err)));

  const used = models?.reduce((sum, m) => sum + m.installedBytes, 0) ?? 0;

  return (
    <section className="space-y-3" aria-labelledby="models-heading">
      <h2 id="models-heading" className="section-title">
        Models
      </h2>
      <p className="text-[11px] text-fg-muted">
        AI masks and denoise run on this Mac with these models. Nothing is bundled: each is downloaded once, checked
        against a pinned SHA-256, and can be deleted at any time.
      </p>
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
      {!models && !error && <p className="text-fg-muted text-xs">Loading…</p>}
      {models && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {models.map((m) => {
            const running = m.job !== undefined;
            const p = progress[m.name];
            const pct = p && p.total > 0 ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
            const state = m.status.state;
            return (
              <li key={m.name} className="space-y-1.5 px-3 py-2.5" aria-label={m.title}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <button
                        type="button"
                        onClick={() => void openLink(m, 'homepage')}
                        className="font-medium text-fg text-xs hover:underline"
                        title={m.homepage}
                      >
                        {m.title}
                      </button>
                      <span className="rounded bg-panel-2 px-1.5 py-px text-[10px] text-fg-muted">
                        {TASK_LABELS[m.task]}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 text-[11px] text-fg-muted">
                      <span>{formatBytes(m.bytes)}</span>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        onClick={() => void openLink(m, 'licence')}
                        className="underline decoration-dotted hover:text-fg"
                        title={m.licenceUrl}
                        aria-label={`${m.title} licence: ${m.licence}`}
                      >
                        {m.licence}
                      </button>
                      <span aria-hidden="true">·</span>
                      <span data-testid={`status-${m.name}`}>
                        {running
                          ? 'Downloading…'
                          : state === 'installed'
                            ? `Installed${m.installedBytes > 0 ? ` · ${formatBytes(m.installedBytes)} on disk` : ''}`
                            : state === 'partial'
                              ? `Partial · ${formatBytes(m.status.state === 'partial' ? m.status.bytes : 0)} of ${formatBytes(m.bytes)}`
                              : m.downloadable
                                ? 'Not downloaded'
                                : 'Not available yet (checksum not pinned)'}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {running ? (
                      <button
                        type="button"
                        onClick={() => void cancel(m)}
                        className={buttonClass}
                        aria-label={`Cancel ${m.title} download`}
                      >
                        Cancel
                      </button>
                    ) : confirming === m.name ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void remove(m)}
                          className="rounded-md bg-danger/80 px-2.5 py-1 text-canvas text-xs hover:bg-danger"
                          aria-label={`Confirm deleting ${m.title}`}
                        >
                          Delete {formatBytes(m.installedBytes)}
                        </button>
                        <button type="button" onClick={() => setConfirming(null)} className={buttonClass}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        {state !== 'installed' && (
                          <button
                            type="button"
                            onClick={() => void download(m)}
                            disabled={!m.downloadable}
                            className={buttonClass}
                            aria-label={`${state === 'partial' ? 'Resume' : 'Download'} ${m.title}`}
                          >
                            {state === 'partial' ? 'Resume' : 'Download'}
                          </button>
                        )}
                        {state !== 'missing' && (
                          <button
                            type="button"
                            onClick={() => setConfirming(m.name)}
                            disabled={deleting === m.name}
                            className={buttonClass}
                            aria-label={`Delete ${m.title}`}
                          >
                            {deleting === m.name ? 'Deleting…' : 'Delete'}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {running && (
                  <div className="flex items-center gap-2">
                    <div
                      role="progressbar"
                      aria-label={`${m.title} download`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      className="h-1 flex-1 overflow-hidden rounded bg-panel-2"
                    >
                      <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-28 text-right text-[11px] text-fg-muted tabular-nums">
                      {p ? `${formatBytes(p.received)} / ${formatBytes(p.total)}` : ''}
                    </span>
                  </div>
                )}
                {rowErrors[m.name] && (
                  <p role="alert" className="break-words text-[11px] text-danger">
                    {rowErrors[m.name]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <DenoiseDefaults />
      <div className="space-y-0.5 text-[11px] text-fg-muted">
        <p>
          Total on disk: <span className="text-fg">{formatBytes(used)}</span>
        </p>
        {dir && (
          <p className="break-all">
            Folder: <span className="select-text font-mono">{dir}</span>
          </p>
        )}
      </div>
    </section>
  );
}
