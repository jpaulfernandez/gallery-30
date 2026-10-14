import { create } from 'zustand';
import { errorMessage } from '../../lib/errors';
import type { SocialExportOutcome, SocialExportRun } from '../../lib/jobs/socialExport';
import { devLog } from '../../lib/log';
import { revealExport } from '../../lib/tauri';
import { Toast } from '../ui/Toast';

/**
 * Post export toasts (workflow plan 14), bottom-left above the photo export toasts (plan 11's pattern): one per run,
 * "Exporting …" while its jobs run (the Jobs list has each frame), then what it wrote with Reveal in Finder for the
 * post's folder. Each stays until dismissed.
 */

interface PostExportToastRun {
  id: number;
  name: string;
  total: number;
  dir: string;
  outcome: SocialExportOutcome | null;
}

interface PostExportsState {
  runs: PostExportToastRun[];
}

export const usePostExportsStore = create<PostExportsState>()(() => ({ runs: [] }));

let nextRun = 1;

/** Show `run` in a toast until dismissed, updated when it is over. */
export function trackPostExport(run: SocialExportRun): void {
  const id = nextRun++;
  const entry: PostExportToastRun = {
    id,
    name: run.plan.name,
    total: run.plan.frames.length,
    dir: run.plan.dir,
    outcome: null,
  };
  usePostExportsStore.setState((s) => ({ runs: [...s.runs, entry] }));
  void run.done.then((outcome) =>
    usePostExportsStore.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, outcome } : r)) })),
  );
}

/** What the toast says about a run. */
export function postExportText(run: PostExportToastRun): string {
  const { outcome } = run;
  if (!outcome) return `Exporting “${run.name}”, ${run.total === 1 ? '1 frame' : `${run.total} frames`}…`;
  const written = outcome.written.length;
  const text = `Exported ${written === 1 ? '1 frame' : `${written} frames`} of “${run.name}”`;
  const problems: string[] = [];
  if (outcome.failed > 0) problems.push(`then it failed (see Jobs)`);
  if (outcome.cancelled > 0) problems.push('then it was cancelled');
  return `${text}${problems.length ? `; ${problems.join(', ')}` : ''}.`;
}

/** Plan 45: `Toast` cards inside the one `ToastHost` (`main.tsx`), which stacks them with the other export toasts. */
export function PostExportToast() {
  const runs = usePostExportsStore((s) => s.runs);
  return (
    <>
      {runs.map((run) => (
        <Toast
          key={run.id}
          progress={run.outcome ? undefined : 'busy'}
          done={run.outcome !== null && run.outcome.failed === 0 && run.outcome.cancelled === 0}
          actions={
            run.outcome && run.outcome.written.length > 0
              ? [
                  {
                    label: 'Reveal in Finder',
                    run: () =>
                      revealExport(run.dir).catch((err) =>
                        devLog('export', 'reveal failed', { error: errorMessage(err) }),
                      ),
                  },
                ]
              : undefined
          }
          onDismiss={() => usePostExportsStore.setState((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }))}
        >
          {postExportText(run)}
        </Toast>
      ))}
    </>
  );
}
