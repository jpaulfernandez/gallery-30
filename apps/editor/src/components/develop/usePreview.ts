import { type DevelopSettings, isDefaultDevelop, type OutputProfile } from '@photobook/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { renderDevelopPreview } from '../../lib/tauri';
import { useLutsStore } from '../../store/luts';
import { useUiStore } from '../../store/ui';
import { commitDevelop } from './commit';
// Workflow plan 36: slider→paint timing and the dev-only raw preview experiment.
import { expectPaint, takeInput } from './previewTiming';
import { type RawFrame, rawPreviewEnabled } from './rawPreview';
import { setRenderPending } from './renderProgress';

/** Renders are coalesced to at most one request per this many ms while settings change. */
export const PREVIEW_COALESCE_MS = 16;
/** After the last change without a pointer release (key nudges, typed values, undo) the edit is committed. */
export const COMMIT_IDLE_MS = 300;

let lastJob = 0;

/** Increasing preview job id; time-based so it stays ahead of jobs from before a dev reload (like `hash_files`). */
export function nextPreviewJob(): number {
  lastJob = Math.max(lastJob + 1, Date.now());
  return lastJob;
}

const warned = new Set<string>();

/** Log a failure once per distinct message: a missing command would otherwise log on every slider tick. */
function warnOnce(err: unknown): void {
  const message = errorMessage(err);
  if (warned.has(message)) return;
  warned.add(message);
  devLog('develop', 'live preview unavailable, showing the cached proxy', { error: message });
}

/** Forget which failures were logged (tests). */
export function resetPreviewWarnings(): void {
  warned.clear();
}

/** Wait until the browser has decoded `url`, so swapping the `<img>` source never flashes blank. */
async function decoded(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  if (typeof img.decode !== 'function') return;
  try {
    await img.decode();
  } catch {
    // A bad image is reported by the <img> itself; the swap still happens.
  }
}

export interface PreviewSource {
  folder: string | null;
  assetId: string;
  /** Path relative to the folder. */
  relPath: string | undefined;
  /** Content hash of the source file; no preview until the scan has it. */
  hash: string | undefined;
}

export interface Preview {
  /** Blob URL of the latest live render for the current photo, or null (unedited, not rendered yet, or failed). */
  url: string | null;
  /** The last render attempt failed (the command is missing or errored). */
  unavailable: boolean;
  /** Plan 36 experiment (dev builds with `photobook.rawPreview`): the latest live render as raw RGBA, else null. */
  frame: RawFrame | null;
}

/**
 * Live preview for the Develop view: whenever `settings` change, render the proxy through
 * `render_develop_preview` and expose the JPEG as a blob URL.
 *
 * Requests are numbered (`nextPreviewJob`); a newer job supersedes older ones, whose results are dropped. Changes are
 * coalesced to one request per `PREVIEW_COALESCE_MS` that always carries the newest settings, so a fast drag
 * keeps rendering instead of waiting for the pointer to pause. Unedited settings clear the preview (the cached
 * proxy shows). Failures keep the previous image, log once, and set `unavailable`.
 *
 * `outputProfile` is the colour space the render is made in and tagged with (the book's, or the soft-proof choice);
 * changing it renders again.
 */
export function usePreview(
  source: PreviewSource,
  settings: DevelopSettings,
  outputProfile: OutputProfile = 'srgb',
): Preview {
  const { folder, assetId, relPath, hash } = source;
  const sourceKey = folder && relPath && hash ? `${folder}\n${assetId}\n${relPath}\n${hash}` : null;
  const isDefault = useMemo(() => isDefaultDevelop(settings), [settings]);
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);
  /** Bumped when a denoise intermediate changed: the settings are the same but the pixels they start from are not. */
  const denoiseEpoch = useUiStore((s) => s.denoise.epoch);
  /** Bumped when a LUT file came back (plan 18): same settings, new pixels. Only photos with a LUT follow it. */
  const lutEpoch = useLutsStore((s) => (settings.look?.lut ? s.epoch : 0));

  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const urlRef = useRef<string | null>(null);
  const [rawFrame, setRawFrame] = useState<{ key: string; frame: RawFrame } | null>(null);
  /** When the newest settings change happened (plan 36's slider→paint clock). */
  const changedAt = useRef(0);
  const latestJob = useRef(0);
  /** Plan 46: bumped on every settings change; a render that lands for the newest one clears the pending dot. */
  const wanted = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ folder, relPath, hash, settings, sourceKey, outputProfile });
  live.current = { folder, relPath, hash, settings, sourceKey, outputProfile };

  const drop = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setShown(null);
    setRawFrame(null);
  }, []);

  // Leaving a photo (or the view): stop pending work, ignore in-flight renders, free the blob.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceKey is the trigger; the cleanup uses refs only
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      latestJob.current = nextPreviewJob();
      setFailed(false);
      setRenderPending(false);
      drop();
    },
    [sourceKey, drop],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: settingsKey stands for settings; outputProfile, denoiseEpoch and lutEpoch trigger a re-render; the run reads the newest from `live`
  useEffect(() => {
    if (!sourceKey) return;
    changedAt.current = takeInput(performance.now());
    wanted.current += 1;
    if (isDefault) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      latestJob.current = nextPreviewJob();
      setRenderPending(false);
      drop();
      return;
    }
    setRenderPending(true);
    // A request is already queued: it will read the newest settings when it fires.
    if (timer.current) return;
    timer.current = setTimeout(async () => {
      timer.current = null;
      const now = live.current;
      if (!now.folder || !now.relPath || !now.hash || isDefaultDevelop(now.settings)) {
        setRenderPending(false);
        return;
      }
      const asked = wanted.current;
      const settle = () => {
        if (asked === wanted.current) setRenderPending(false);
      };
      const job = nextPreviewJob();
      latestJob.current = job;
      const started = performance.now();
      const since = changedAt.current;
      try {
        // `import.meta.env.DEV` is a constant, so a release bundle drops this branch and the fetch module.
        if (import.meta.env.DEV && rawPreviewEnabled()) {
          const { fetchRawPreview } = await import('./rawPreviewFetch');
          const frame = await fetchRawPreview({
            folder: now.folder,
            relPath: now.relPath,
            hash: now.hash,
            settings: now.settings,
            job,
            outputProfile: now.outputProfile,
          });
          if (!frame || job !== latestJob.current) {
            if (job === latestJob.current) settle();
            return;
          }
          const ms = Math.round(performance.now() - started);
          expectPaint(`raw:${job}`, { changedAt: since, path: 'raw', job, request: ms, decode: 0 });
          setRawFrame({ key: now.sourceKey ?? '', frame });
          setFailed(false);
          settle();
          devLog('develop', `raw preview ${ms}ms job ${job}`, { render: frame.renderMs, pack: frame.packMs });
          return;
        }
        const bytes = await renderDevelopPreview(
          now.folder,
          now.relPath,
          now.hash,
          now.settings,
          job,
          undefined,
          now.outputProfile,
        );
        // null: the backend dropped this job for a newer one.
        if (!bytes || job !== latestJob.current) {
          if (job === latestJob.current) settle();
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        const ms = Math.round(performance.now() - started);
        const decodeStart = performance.now();
        await decoded(url);
        const decodeMs = performance.now() - decodeStart;
        if (job !== latestJob.current) {
          URL.revokeObjectURL(url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        expectPaint(url, { changedAt: since, path: 'jpeg', job, request: ms, decode: decodeMs });
        setShown({ key: now.sourceKey ?? '', url });
        setFailed(false);
        settle();
        devLog('develop', `preview ${ms}ms job ${job}`);
      } catch (err) {
        if (job !== latestJob.current) return;
        warnOnce(err);
        setFailed(true);
        settle();
      }
    }, PREVIEW_COALESCE_MS);
  }, [sourceKey, settingsKey, outputProfile, denoiseEpoch, lutEpoch, isDefault, drop]);

  return {
    url: shown && shown.key === sourceKey ? shown.url : null,
    unavailable: failed,
    frame: rawFrame && rawFrame.key === sourceKey ? rawFrame.frame : null,
  };
}

/**
 * Commit edits to `assetId` through `commitDevelop` once per burst: when a pointer is released anywhere
 * (a slider drag ended), `COMMIT_IDLE_MS` after the last change otherwise (key nudges, typed values, undo,
 * paste), and when the view moves to another photo or closes with a change pending. An unchanged photo never commits.
 *
 * `hold` (the crop tool is open) defers every commit until it turns false (Done / Cancel), or the photo changes.
 */
export function useCommitOnIdle(assetId: string, settings: DevelopSettings, hold = false): void {
  const key = useMemo(() => JSON.stringify(settings), [settings]);
  const state = useRef({
    assetId,
    committed: key,
    latest: key,
    dirty: false,
    hold,
    timer: null as ReturnType<typeof setTimeout> | null,
  });
  state.current.hold = hold;

  const flush = useCallback(() => {
    const st = state.current;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    if (!st.dirty) return;
    st.dirty = false;
    if (st.latest === st.committed) return;
    st.committed = st.latest;
    void commitDevelop(st.assetId);
  }, []);

  // Leaving a photo or the view: commit what is pending for the photo being left (runs before the effect below).
  // biome-ignore lint/correctness/useExhaustiveDependencies: assetId is the trigger; the cleanup flushes the photo recorded in the ref
  useEffect(() => flush, [assetId, flush]);

  useEffect(() => {
    const st = state.current;
    st.latest = key;
    if (st.assetId !== assetId) {
      st.assetId = assetId;
      st.committed = key;
      st.dirty = false;
      return;
    }
    if (key === st.committed) {
      st.dirty = false;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      return;
    }
    st.dirty = true;
    if (st.timer) clearTimeout(st.timer);
    st.timer = st.hold ? null : setTimeout(flush, COMMIT_IDLE_MS);
  }, [assetId, key, flush]);

  // Releasing the hold commits what piled up meanwhile.
  useEffect(() => {
    if (!hold) flush();
  }, [hold, flush]);

  // A released pointer ends a drag; give React a beat to apply the last move before committing.
  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        if (!state.current.hold) flush();
      }, 32);
    };
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [flush]);
}
