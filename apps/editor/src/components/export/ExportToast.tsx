import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { revealExport } from '../../lib/tauri';
import { type ExportRun, useExportsStore } from '../../store/exports';
import { Toast } from '../ui/Toast';

/** What the toast says about a run. */
export function exportRunText(run: ExportRun): string {
  const settled = run.encoded + run.copied + run.skipped + run.failed + run.cancelled;
  if (!run.over) return `Exporting with ${run.preset}… ${settled}/${run.total}`;
  const done = run.encoded + run.copied + run.skipped;
  const parts = [`Exported ${done === 1 ? '1 photo' : `${done} photos`} with ${run.preset}`];
  const detail: string[] = [];
  if (run.encoded > 0 && run.encoded < done) detail.push(`${run.encoded} encoded`);
  if (run.copied > 0) detail.push(`${run.copied} from the cache`);
  if (run.skipped > 0) detail.push(`${run.skipped} already there`);
  if (detail.length > 0) parts.push(`(${detail.join(', ')})`);
  const problems: string[] = [];
  if (run.failed > 0) problems.push(`${run.failed} failed (see Jobs)`);
  if (run.cancelled > 0) problems.push(`${run.cancelled} cancelled`);
  if (run.missing > 0) problems.push(`${run.missing} not ready`);
  return `${parts.join(' ')}${problems.length > 0 ? `; ${problems.join(', ')}` : ''}.`;
}

/**
 * The export completion toasts (workflow plan 11), one per run: progress while it goes (the ring; the Jobs list has
 * each photo), then what it did, with Reveal in Finder for its first exported file. Each stays until dismissed. Plan
 * 45: `Toast` cards inside the one `ToastHost` (bottom-left, `main.tsx`), which stacks them with the others.
 */
export function ExportToast() {
  const runs = useExportsStore((s) => s.runs);
  return (
    <>
      {runs.map((run) => (
        <RunToast key={run.id} run={run} />
      ))}
    </>
  );
}

function RunToast({ run }: { run: ExportRun }) {
  const first = run.paths[0];
  const reveal = () => {
    if (!first) return;
    revealExport(first).catch((err) => devLog('export', 'reveal failed', { error: errorMessage(err) }));
  };
  const settled = run.encoded + run.copied + run.skipped + run.failed + run.cancelled;
  return (
    <Toast
      progress={run.over ? undefined : run.total > 0 ? settled / run.total : 'busy'}
      done={run.over && run.failed === 0 && run.cancelled === 0}
      actions={run.over && first ? [{ label: 'Reveal in Finder', run: reveal }] : undefined}
      onDismiss={() => useExportsStore.getState().dismissRun(run.id)}
    >
      {exportRunText(run)}
    </Toast>
  );
}
