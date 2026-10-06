import { useEffect, useRef, useState } from 'react';
import { type PublishEvent, type PublishRun, type PublishStep, startPublish } from '../../lib/publishRunner';
import { flush } from '../../store/autosave';
import { useBookStore } from '../../store/book';

const STEPS: Array<{ id: PublishStep; label: string }> = [
  { id: 'freeze', label: 'Freeze project' },
  { id: 'images', label: 'Image versions' },
  { id: 'pages', label: 'Page images' },
  { id: 'plan', label: 'Compare with R2' },
  { id: 'upload', label: 'Upload' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'site', label: 'Site file' },
];

type StepState = {
  status: 'pending' | 'running' | 'done' | 'skipped';
  ms?: number;
  detail?: string;
  progress?: { done: number; total: number; detail?: string };
};

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Step 2.7: runs the publish CLI for the open book and streams its progress: one row per step
 * with timing, a log of warnings, and on success the reader link with a copy button. The publish
 * record (`lastPublishedAt`, `publishedFingerprint`) is written into the open document here, the
 * CLI runs with `--no-record` because the editor owns the project file.
 */
export function PublishPanel({ onClose }: { onClose: () => void }) {
  const folder = useBookStore((s) => s.folder);
  const slug = useBookStore((s) => s.book?.publish.slug ?? '');
  const setPublish = useBookStore((s) => s.setPublish);
  const [dryRun, setDryRun] = useState(false);
  const [prune, setPrune] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<Extract<PublishEvent, { type: 'result' }> | null>(null);
  const [error, setError] = useState<{ message: string; keys?: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const runRef = useRef<PublishRun | null>(null);

  useEffect(
    () => () => {
      void runRef.current?.cancel();
    },
    [],
  );

  const onEvent = (e: PublishEvent) => {
    switch (e.type) {
      case 'step':
        setSteps((s) => ({
          ...s,
          [e.step]: {
            ...s[e.step],
            status: e.status === 'start' ? 'running' : e.status,
            ms: e.ms,
            detail: e.detail ?? s[e.step]?.detail,
          },
        }));
        break;
      case 'progress':
        setSteps((s) => ({
          ...s,
          [e.step]: {
            ...(s[e.step] ?? { status: 'running' }),
            progress: { done: e.done, total: e.total, detail: e.detail },
          },
        }));
        break;
      case 'log':
        if (e.level === 'warn') setLog((l) => [...l, e.message]);
        break;
      case 'result':
        setResult(e);
        break;
      case 'error':
        setError({ message: e.message, keys: e.keys });
        break;
      case 'raw':
        if (e.stream === 'stderr' && e.line.trim()) setLog((l) => [...l, e.line]);
        break;
    }
  };

  const start = async () => {
    if (!folder) return;
    setPhase('running');
    setSteps({});
    setLog([]);
    setResult(null);
    setError(null);
    setCopied(false);
    // The CLI reads the project file from disk: write pending edits first.
    await flush();
    const run = await startPublish({ command: 'publish', folder, dryRun, prune }, onEvent);
    runRef.current = run;
    const code = await run.done;
    runRef.current = null;
    setPhase(code === 0 ? 'done' : 'failed');
    if (code !== 0 && code !== null)
      setError((err) => err ?? { message: `The publish command exited with code ${code}` });
    if (code === null) setError((err) => err ?? { message: 'Cancelled' });
  };

  // Record the publish in the document once the CLI reports success (not for dry runs).
  useEffect(() => {
    if (phase === 'done' && result && !result.dryRun) {
      setPublish({ lastPublishedAt: result.publishedAt, publishedFingerprint: result.fingerprint });
    }
  }, [phase, result, setPublish]);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog; Escape is handled by the Close button focus
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'running') onClose();
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
              Freezes the project, derives the image versions, uploads what is new to R2 and rewrites the manifest and
              site file. Settings come from the Settings screen.
            </p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry run (process images, upload nothing)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
              Prune objects this book no longer uses
            </label>
          </div>
        )}

        {phase !== 'idle' && (
          <ol className="space-y-1.5 text-xs">
            {STEPS.map(({ id, label }) => {
              const st = steps[id];
              const status = st?.status ?? 'pending';
              const icon = status === 'done' ? '✓' : status === 'running' ? '…' : status === 'skipped' ? '–' : '·';
              return (
                <li key={id} className={`flex items-baseline gap-2 ${status === 'pending' ? 'text-fg-muted/60' : ''}`}>
                  <span className="w-3 text-center">{icon}</span>
                  <span className="w-32">{label}</span>
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

        {log.length > 0 && (
          <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[11px] text-amber-300/90 leading-relaxed">
            {log.join('\n')}
          </pre>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-red-300 text-xs">
            <p>{error.message}</p>
            {error.keys && (
              <pre className="mt-1 max-h-24 overflow-auto font-mono text-[11px]">{error.keys.join('\n')}</pre>
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
                <button
                  type="button"
                  onClick={copy}
                  className="rounded-md border border-line px-2.5 py-1 hover:border-accent"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2 text-xs">
          {phase === 'running' ? (
            <button
              type="button"
              onClick={() => void runRef.current?.cancel()}
              className="rounded-md border border-line px-3 py-1.5 hover:border-red-400"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-3 py-1.5 hover:border-accent"
            >
              Close
            </button>
          )}
          {phase !== 'running' && (
            <button
              type="button"
              onClick={() => void start()}
              className="rounded-md bg-accent px-3 py-1.5 text-white hover:brightness-110"
            >
              {phase === 'idle' ? (dryRun ? 'Run dry run' : 'Publish') : 'Run again'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
