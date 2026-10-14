import type { DevelopSettings } from '@photobook/shared';
import { useDenoisePrefs } from '../../store/denoisePrefs';
import { enqueue, JobCancelled, type JobHandle } from '../../store/jobs';
import { missingModelMessage, nextDenoiseJob } from '../denoise';
import { type AiModelInfo, cancelDenoise, type DenoiseResult, onDenoiseProgress, runDenoise } from '../tauri';

/** A denoise job failed because its model is not downloaded (the job's `cause`); `model` says which and how big. */
export class MissingModelError extends Error {
  constructor(readonly model: AiModelInfo) {
    super(missingModelMessage(model));
    this.name = 'MissingModelError';
  }
}

/**
 * The key under which equal denoise runs share one job: the same bytes and the same `detail.denoise` settings, as
 * Rust's `denoise_key` tells intermediates apart (workflow plan 28): with the chroma filter (`chromaMode: 'filter'`,
 * plan 24) the colour comes from the filter at render time, so Colour is not part of the run and two runs that differ
 * only in it are one; with the model's colour it is (`model:<chroma>`).
 */
export function denoiseJobKey(hash: string, settings: DevelopSettings): string {
  const d = settings.detail.denoise;
  if (!d) return `${hash}:off`;
  const colour = d.chromaMode === 'model' ? `model:${d.chroma}` : 'filter';
  return `${hash}:${d.model}:${d.luminance}:${d.sharpen}:${colour}`;
}

/**
 * Queue the full-resolution denoise of one photo (`runDenoise`, which writes its intermediate) as a `denoise` job:
 * tile progress from `develop:denoise-progress`, Cancel through `cancelDenoise` (between tiles; nothing is written).
 * The job fails with a `MissingModelError` when the model is not downloaded and ends cancelled when the run stopped.
 * A denoise of the same bytes and settings already queued or running is joined, not queued again (`created: false`).
 * `force` runs it again when its intermediate is already on disk (plan 27, Shift + Denoise selected). A finished run's
 * per-tile timing is remembered (`useDenoisePrefs.recordTiming`) for the batch estimate.
 */
export function enqueueDenoise(options: {
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  label: string;
  /** The photo id (project asset id or library key): Develop finds the job by it. */
  ref?: string;
  project?: string | null;
  force?: boolean;
}): JobHandle<DenoiseResult> {
  const { folder, relPath, hash, settings, label, ref, project, force } = options;
  return enqueue({
    kind: 'denoise',
    label,
    ref,
    project,
    // A forced re-run is not joined to (nor joined by) a plain run of the same settings, which would not re-run.
    dedupe: force ? `${denoiseJobKey(hash, settings)}:force` : denoiseJobKey(hash, settings),
    run: async (ctx) => {
      const job = nextDenoiseJob();
      ctx.progress(0, 0, 'preparing');
      const unlisten = await onDenoiseProgress((e) => {
        if (e.job !== job) return;
        ctx.progress(e.done, e.total, e.total > 0 ? `tile ${e.done}/${e.total}` : 'preparing');
      });
      ctx.onCancel(() => cancelDenoise(job));
      try {
        // Cancelled while the listener was being attached: there is no run to stop yet.
        if (ctx.cancelled) throw new JobCancelled();
        const outcome = force
          ? await runDenoise(folder, relPath, hash, settings, job, true)
          : await runDenoise(folder, relPath, hash, settings, job);
        if (outcome.status === 'cancelled') throw new JobCancelled();
        if (outcome.status === 'missingModel') throw new MissingModelError(outcome.model);
        const { status: _done, ...result } = outcome;
        const model = settings.detail.denoise?.model;
        if (model && result.elapsedMs > 0) useDenoisePrefs.getState().recordTiming(model, result);
        return result;
      } finally {
        unlisten();
      }
    },
  });
}
