import type { UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import {
  cancelToolDownload,
  checkTool,
  deleteTool,
  downloadTool,
  onToolProgress,
  type ToolCheck,
  type ToolStatus,
  toolStatus,
} from '../../lib/tauri';
import { buttonClass as buttonLook } from '../ui/Button';
import { formatBytes } from './ModelsPanel';

const FFMPEG = 'ffmpeg';
// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = buttonLook({ size: 'sm' });

let nextJob = Date.now();

/**
 * Settings → Tools (workflow plan 16): FFmpeg, which slideshow videos are encoded with. Nothing is bundled: the LGPL
 * build pinned in `tools.toml` downloads once (checked against its SHA-256), or an FFmpeg already installed (Homebrew)
 * is used. Check runs it once and says whether it has the H.264 encoder (VideoToolbox on macOS).
 */
export function ToolsPanel() {
  const [tool, setTool] = useState<ToolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [check, setCheck] = useState<ToolCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTool(await toolStatus(FFMPEG));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    onToolProgress((e) => {
      if (e.name === FFMPEG) setProgress({ received: e.received, total: e.total });
    }).then(
      (u) => {
        if (alive) unlisten = u;
        else u();
      },
      () => {},
    );
    void refresh();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [refresh]);

  const download = async () => {
    if (!tool) return;
    const job = nextJob++;
    setError(null);
    setCheck(null);
    setProgress({ received: 0, total: tool.bytes ?? 0 });
    setTool({ ...tool, job });
    try {
      setTool(await downloadTool(FFMPEG, job));
    } catch (err) {
      const message = errorMessage(err);
      if (!/cancelled/i.test(message)) setError(message);
      await refresh();
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    setError(null);
    setCheck(null);
    try {
      setTool(await deleteTool(FFMPEG));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await checkTool(FFMPEG));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const running = tool?.job != null;
  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;

  return (
    <section className="space-y-3" aria-labelledby="tools-heading">
      <h2 id="tools-heading" className="section-title">
        Tools
      </h2>
      <p className="text-[11px] text-fg-muted">
        Slideshow videos are encoded with FFmpeg. Nothing is bundled: download the LGPL build below (checked against a
        pinned SHA-256), or install FFmpeg yourself, e.g. with Homebrew; the downloaded one is used first.
      </p>
      {!tool && !error && <p className="text-fg-muted text-xs">Loading…</p>}
      {tool && (
        <section className="space-y-2 rounded-md border border-line px-3 py-2.5" aria-label={tool.title}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium text-fg text-xs">{tool.title}</p>
              <p className="text-[11px] text-fg-muted">
                {tool.bytes !== null ? `${formatBytes(tool.bytes)} download · ` : ''}
                <span title={tool.licenceUrl}>{tool.licence}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {running ? (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => tool.job != null && void cancelToolDownload(tool.job)}
                >
                  Cancel
                </button>
              ) : tool.installedPath ? (
                <button type="button" className={buttonClass} onClick={() => void remove()}>
                  Delete
                </button>
              ) : (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={tool.bytes === null}
                  title={tool.bytes === null ? 'No build for this Mac: install FFmpeg yourself' : undefined}
                  onClick={() => void download()}
                >
                  Download
                </button>
              )}
              <button
                type="button"
                className={buttonClass}
                disabled={!tool.activePath || running || busy}
                onClick={() => void runCheck()}
              >
                Check
              </button>
            </div>
          </div>
          {running && (
            <div
              className="h-1 overflow-hidden rounded bg-panel-2"
              role="progressbar"
              aria-valuenow={pct}
              aria-label="Downloading FFmpeg"
            >
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="break-all text-[11px] text-fg-muted">
            {tool.activePath
              ? `Slideshows use ${tool.activePath}${tool.installedPath ? ' (downloaded)' : ' (installed on this Mac)'}.`
              : 'Not available: slideshow videos cannot be exported until FFmpeg is downloaded or installed.'}
          </p>
          {check && (
            <p className={`text-[11px] ${check.h264 ? 'text-fg-muted' : 'text-warn'}`}>
              {check.version}.{' '}
              {check.h264
                ? `Has the ${check.encoder} encoder slideshows use.`
                : `It has no ${check.encoder} encoder: slideshows will fail with it.`}
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
