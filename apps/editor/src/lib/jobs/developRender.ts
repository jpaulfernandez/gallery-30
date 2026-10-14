import type { DevelopSettings, OutputProfile } from '@photobook/shared';
import { enqueue, JobCancelled, type JobHandle } from '../../store/jobs';
import { nextDenoiseJob } from '../denoise';
import { cancelDevelop, type DevelopFullResult, onDevelopProgress, renderDevelopFull } from '../tauri';

/** One photo of a full-render job. */
export interface RenderJobItem {
  assetId: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
}

/**
 * Queue a full-resolution render (`renderDevelopFull`) of `items` into `<folder>/.photobook-cache/develop/` as one
 * `render` job: progress from `develop:progress` (items done of total), Cancel through `cancelDevelop` (the photo in
 * flight is dropped before it is written). The job fails with the first item's error and ends cancelled when an item
 * reports `Cancelled`; its value is the summary. `dedupe` (e.g. the folder and render file name) joins an equal render
 * already queued or running instead of queueing another.
 */
export function enqueueRender(options: {
  folder: string;
  items: RenderJobItem[];
  label: string;
  outputProfile?: OutputProfile;
  ref?: string;
  project?: string | null;
  dedupe?: string;
}): JobHandle<DevelopFullResult[]> {
  const { folder, items, label, outputProfile, ref, project, dedupe } = options;
  return enqueue({
    kind: 'render',
    label,
    ref,
    project,
    dedupe,
    run: async (ctx) => {
      const job = nextDenoiseJob();
      ctx.progress(0, items.length);
      const unlisten = await onDevelopProgress((e) => {
        if (e.job !== job) return;
        ctx.progress(e.done, e.total);
        // A failed photo ends the job: the rest would be thrown away.
        if (e.error && e.error !== 'Cancelled') void cancelDevelop(job).catch(() => {});
      });
      ctx.onCancel(() => cancelDevelop(job));
      try {
        // Cancelled while the listener was being attached: there is nothing to stop yet.
        if (ctx.cancelled) throw new JobCancelled();
        const results = await renderDevelopFull(folder, items, job, outputProfile);
        const failure = results.find((r) => r.error && r.error !== 'Cancelled');
        if (failure?.error) throw new Error(failure.error);
        if (results.some((r) => r.error === 'Cancelled')) throw new JobCancelled();
        return results;
      } finally {
        unlisten();
      }
    },
  });
}
