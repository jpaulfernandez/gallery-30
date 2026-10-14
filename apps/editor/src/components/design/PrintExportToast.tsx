import { create } from 'zustand';
import { errorMessage } from '../../lib/errors';
import type { PrintExportOutcome, PrintExportRun } from '../../lib/jobs/printExport';
import { devLog } from '../../lib/log';
import { revealExport } from '../../lib/tauri';
import { Toast } from '../ui/Toast';

/**
 * Print PDF toasts (workflow plan 15), bottom-left above the photo and post export toasts: one per run, "Making …"
 * while its job runs (the Jobs list has its progress), then the file with Reveal in Finder. Each stays until dismissed.
 */

interface PrintExportToastRun {
  id: number;
  name: string;
  file: string;
  path: string;
  outcome: PrintExportOutcome | null;
}

export const usePrintExportsStore = create<{ runs: PrintExportToastRun[] }>()(() => ({ runs: [] }));

let nextRun = 1;

/** Show `run` in a toast until dismissed, updated when it is over. */
export function trackPrintExport(run: PrintExportRun): void {
  const id = nextRun++;
  const entry: PrintExportToastRun = {
    id,
    name: run.plan.name,
    file: run.plan.file,
    path: run.plan.path,
    outcome: null,
  };
  usePrintExportsStore.setState((s) => ({ runs: [...s.runs, entry] }));
  void run.done.then((outcome) =>
    usePrintExportsStore.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, outcome } : r)) })),
  );
}

/** What the toast says about a run. */
export function printExportText(run: Pick<PrintExportToastRun, 'name' | 'file' | 'outcome'>): string {
  const { outcome } = run;
  if (!outcome) return `Making ${run.file} of “${run.name}”…`;
  if (outcome.state === 'done') return `Saved ${run.file} of “${run.name}”.`;
  if (outcome.state === 'cancelled') return `${run.file} of “${run.name}” cancelled.`;
  return `${run.file} of “${run.name}” failed: ${outcome.error}`;
}

/** Plan 45: `Toast` cards inside the one `ToastHost` (`main.tsx`), which stacks them with the other export toasts. */
export function PrintExportToast() {
  const runs = usePrintExportsStore((s) => s.runs);
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
          onDismiss={() => usePrintExportsStore.setState((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }))}
        >
          {printExportText(run)}
        </Toast>
      ))}
    </>
  );
}
