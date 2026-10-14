import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { modelSizeLabel } from '../../lib/denoise';
import { type DenoiseBatchPlan, PlanAborted, planDenoiseBatch, startDenoiseBatch } from '../../lib/denoiseQueue';
import { errorMessage } from '../../lib/errors';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { BatchButton } from './BatchBar';
import { type BatchContext, registerBatchSlot } from './batchSlots';

/**
 * Workflow plan 27: *Denoise selected* in the Develop batch bar (order 50) and the Cull menu. Opens a confirm with the
 * count and the estimate (`planDenoiseBatch`), then queues one denoise job per photo (`startDenoiseBatch`). Shift
 * (or the checkbox) re-runs photos already denoised.
 */
const useDenoiseBatchStore = create<{ dialog: { ids: string[]; force: boolean } | null }>(() => ({ dialog: null }));

/** Open the confirm for `ids` (Shift: `force`, re-run photos already denoised). */
export function openDenoiseBatch(ids: readonly string[], options: { force?: boolean } = {}): void {
  if (ids.length === 0) return;
  useDenoiseBatchStore.setState({ dialog: { ids: [...ids], force: options.force ?? false } });
}

/** Close the confirm (aborting its plan). */
export const closeDenoiseBatch = (): void => useDenoiseBatchStore.setState({ dialog: null });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "about 3 min" / "about 40 s". */
export function durationLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `about ${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `about ${min} min`;
  return `about ${(min / 60).toFixed(1)} h`;
}

/** The confirm's summary of a plan. */
export function batchSummary(plan: DenoiseBatchPlan): string {
  const parts = [`${plural(plan.todo.length, 'photo')} to denoise`];
  if (plan.skipped > 0) parts.push(`${plan.skipped} already denoised (Shift to run again)`);
  if (plan.queued > 0) parts.push(`${plan.queued} already in the queue`);
  if (plan.unreadable > 0) parts.push(`${plan.unreadable} not ready (still scanning or unreadable)`);
  if (plan.blocked > 0) parts.push(`${plan.blocked} waiting for a model download`);
  return parts.join(' · ');
}

/** The confirm's time line: the known estimates summed, "at least" when some photos have none. */
export function estimateLine(plan: DenoiseBatchPlan): string {
  if (plan.estimateMs === null) return 'Estimated time: unknown until a first denoise has run on this Mac.';
  if (plan.unestimated > 0) {
    return `Estimated time: at least ${durationLabel(plan.estimateMs).replace(/^about /, '')} (${plural(plan.unestimated, 'photo')} not estimated).`;
  }
  return `Estimated time: ${durationLabel(plan.estimateMs)} (from the last run).`;
}

export function DenoiseBatchDialog() {
  const dialog = useDenoiseBatchStore((s) => s.dialog);
  if (!dialog) return null;
  return <Confirm ids={dialog.ids} initialForce={dialog.force} />;
}

function Confirm({ ids, initialForce }: { ids: string[]; initialForce: boolean }) {
  const [force, setForce] = useState(initialForce);
  const [plan, setPlan] = useState<DenoiseBatchPlan | null>(null);
  const [measure, setMeasure] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = closeDenoiseBatch;

  // Closing the confirm or changing "Run again" aborts the plan in progress (no more measurements are started).
  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    setPlan(null);
    setError(null);
    planDenoiseBatch(ids, {
      force,
      signal: controller.signal,
      onMeasure: (done, total) => live() && setMeasure({ done, total }),
    }).then(
      (next) => live() && setPlan(next),
      (err) => live() && !(err instanceof PlanAborted) && setError(errorMessage(err)),
    );
    return () => controller.abort();
  }, [ids, force]);

  const switching = plan?.items.filter((i) => i.switchOn && !i.modelMissing).length ?? 0;
  const count = plan?.todo.length ?? 0;
  const start = () => {
    if (!plan) return;
    close();
    startDenoiseBatch(plan);
  };

  return (
    <DialogShell title="Denoise selected" onClose={close} widthClass="w-[30rem]">
      <DialogBody>
        <p className="text-fg-muted">
          Each photo is denoised at full size in the background, one at a time, so Develop shows it at once and Publish
          does not wait. Photos with denoise off are switched on with the model from Settings → Models and the amount
          their noise suggests.
        </p>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : !plan ? (
          <p className="text-fg-muted">
            {measure && measure.total > 0 ? `Measuring noise ${measure.done}/${measure.total}…` : 'Counting…'}
          </p>
        ) : (
          <>
            <p role="status" className="text-fg" data-testid="denoise-batch-summary">
              {batchSummary(plan)}.
            </p>
            {count > 0 && (
              <p className="text-fg" data-testid="denoise-batch-estimate">
                {estimateLine(plan)}
              </p>
            )}
            {switching > 0 && <p className="text-fg-muted">Switches denoise on for {plural(switching, 'photo')}.</p>}
            {plan.missingModel && (
              <p role="alert" className="text-fg">
                {plan.missingModel.title} is not installed ({modelSizeLabel(plan.missingModel.bytes)}), so{' '}
                {plural(plan.blocked, 'photo')} {plan.blocked === 1 ? 'is' : 'are'} left out. Download it in Settings →
                Models, then run Denoise selected again.
              </p>
            )}
          </>
        )}
        <label className="flex items-center gap-2 text-fg-muted">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Run again on photos already denoised
        </label>
      </DialogBody>
      <DialogFooter note="Cancel any photo from the jobs list.">
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton primary disabled={!plan || count === 0} onClick={start}>
          {count > 0 ? `Denoise ${plural(count, 'photo')}` : 'Denoise'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

/** The batch bar's Denoise selected (order 50): the selection, or the photo shown when nothing is selected. */
function DenoiseSlot({ ids, current }: BatchContext) {
  const targets = ids.length > 0 ? ids : current ? [current] : [];
  return (
    <BatchButton
      disabled={targets.length === 0}
      onClick={(e) => openDenoiseBatch(targets, { force: e.shiftKey })}
      title={`Denoise ${ids.length > 0 ? 'the selected photos' : 'this photo'} in the background (Shift: also run again on photos already denoised)`}
    >
      Denoise selected…
    </BatchButton>
  );
}

registerBatchSlot({ id: 'denoise', order: 50, render: (ctx) => <DenoiseSlot {...ctx} /> });
