import { create } from 'zustand';
import { errorMessage } from '../../lib/errors';
import type { SlideshowExportOutcome, SlideshowExportRun } from '../../lib/jobs/slideshowExport';
import { devLog } from '../../lib/log';
import { revealExport } from '../../lib/tauri';
import { Toast } from '../ui/Toast';

/**
 * Slideshow video toasts (workflow plan 16), bottom-left above the photo, post and print export toasts: one per run,
 * "Making …" while its jobs run (the Jobs list has the frames and the encode), then the video with Reveal in Finder.
 * Each stays until dismissed.
 */

interface SlideshowExportToastRun {
  id: number;
  name: string;
  file: string;
  path: string;
  outcome: SlideshowExportOutcome | null;
}

export const useSlideshowExportsStore = create<{ runs: SlideshowExportToastRun[] }>()(() => ({ runs: [] }));

let nextRun = 1;

/** Show `run` in a toast until dismissed, updated when it is over. */
export function trackSlideshowExport(run: SlideshowExportRun): void {
  const id = nextRun++;
  const entry: SlideshowExportToastRun = {
    id,
    name: run.plan.name,
    file: run.plan.fileName,
    path: run.plan.path,
    outcome: null,
  };
  useSlideshowExportsStore.setState((s) => ({ runs: [...s.runs, entry] }));
  void run.done.then((outcome) =>
    useSlideshowExportsStore.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, outcome } : r)) })),
  );
}

/** What the toast says about a run. */
export function slideshowExportText(run: Pick<SlideshowExportToastRun, 'name' | 'file' | 'outcome'>): string {
  const { outcome } = run;
  if (!outcome) return `Making ${run.file} of “${run.name}”…`;
  if (outcome.state === 'done') return `Saved ${run.file} of “${run.name}”.`;
  if (outcome.state === 'cancelled') return `${run.file} of “${run.name}” cancelled.`;
  return `${run.file} of “${run.name}” failed: ${outcome.error}`;
}

/** Plan 45: `Toast` cards inside the one `ToastHost` (`main.tsx`), which stacks them with the other export toasts. */
export function SlideshowExportToast() {
  const runs = useSlideshowExportsStore((s) => s.runs);
  return (
    <>
      {runs.map((run) => (
        <Toast
          key={run.id}
          progress={run.outcome ? undefined : 'busy'}
          done={run.outcome?.state === 'done'}
          actions={
            run.outcome?.state === 'done'
              ? [
                  {
                    label: 'Reveal in Finder',
                    run: () =>
                      revealExport(run.path).catch((err) =>
                        devLog('export', 'reveal failed', { error: errorMessage(err) }),
                      ),
                  },
                ]
              : undefined
          }
          onDismiss={() => useSlideshowExportsStore.setState((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }))}
        >
          {slideshowExportText(run)}
        </Toast>
      ))}
    </>
  );
}
