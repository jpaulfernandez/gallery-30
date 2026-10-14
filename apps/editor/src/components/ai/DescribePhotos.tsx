import { aiModelLabel } from '@photobook/shared';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { describeEstimate, formatUsd } from '../../lib/ai/cost';
import { errorMessage } from '../../lib/errors';
import {
  estimateIndex,
  INDEX_CONFIRM_ABOVE,
  INDEX_JOB_REF,
  type IndexPlan,
  type IndexResult,
  indexRequests,
  planIndex,
  runIndex,
} from '../../lib/jobs/aiIndex';
import { devLog } from '../../lib/log';
import { useAiStore } from '../../store/ai';
import { isActive, type JobOutcome, type JobsState, useJobsStore } from '../../store/jobs';
import { BatchButton } from '../develop/BatchBar';
import { type BatchContext, registerBatchSlot } from '../develop/batchSlots';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';

/**
 * Describe photos (workflow plan 33): the photo index from the Develop batch bar (order 70, the selection or the photo
 * shown; Shift-click always asks) and the Cull grid's menu. `describePhotosAction` runs at once when there is little to
 * send and the key is set; otherwise (more than `INDEX_CONFIRM_ABOVE` photos to send, nothing new to send, entries
 * Refresh would redo, no key, or the settings could not be read) it opens the dialog, which shows the cost first and
 * offers Refresh. One index run at a time: the action does nothing while one is queued or running. Each run ends in a
 * toast with what it did (`indexResultText`).
 */

interface DescribeToast {
  id: string;
  text: string;
}

interface DescribeDialogState {
  dialog: { ids: readonly string[]; plan: IndexPlan | null; error?: string } | null;
  toasts: readonly DescribeToast[];
  open: (ids: readonly string[], plan: IndexPlan | null, error?: string) => void;
  close: () => void;
  dismissToast: (id: string) => void;
}

export const useDescribeStore = create<DescribeDialogState>()((set) => ({
  dialog: null,
  toasts: [],
  open: (ids, plan, error) => set({ dialog: { ids, plan, ...(error ? { error } : {}) } }),
  close: () => set({ dialog: null }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const indexingIn = (s: JobsState): boolean => Object.values(s.jobs).some((j) => j.ref === INDEX_JOB_REF && isActive(j));

/** An index job is queued or running. */
export const useIndexing = (): boolean => useJobsStore(indexingIn);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Described 12 photos, 1 declined, 2 without a preview yet, about $0.01." */
export function indexResultText(outcome: JobOutcome<IndexResult>): string {
  if (outcome.state === 'cancelled') return 'Describing photos was cancelled; descriptions already received are kept.';
  if (outcome.state === 'failed') return `Describing photos failed: ${outcome.error}`;
  const r = outcome.value;
  const parts = [`Described ${plural(r.described, 'photo')}`];
  const copied = r.written - r.described;
  if (r.skipped > 0) parts.push(`${r.skipped} already described meanwhile`);
  else if (copied > 0 && r.described === 0) parts.push(`${plural(copied, 'description')} copied`);
  if (r.refused > 0) parts.push(`${r.refused} declined by the model`);
  if (r.missing > 0) parts.push(`${r.missing} without a preview yet`);
  if (r.failed > 0) parts.push(`${r.failed} not described (see Jobs)`);
  const usd = formatUsd(r.usd);
  const cost = r.requests === 0 ? '' : usd.startsWith('under') ? `, ${usd}` : `, about ${usd}`;
  return `${parts.join(', ')}${cost}.`;
}

/** Queue `plan`, log it, and toast its outcome. */
function start(plan: IndexPlan): void {
  const handle = runIndex(plan);
  devLog('ai', 'index queued', {
    photos: plan.todo.length,
    copies: plan.copies.length,
    skipped: plan.described,
    requests: indexRequests(plan),
    job: handle.id,
    joined: !handle.created,
  });
  if (!handle.created) return;
  void handle.result.then((outcome) =>
    useDescribeStore.setState((s) => ({ toasts: [...s.toasts, { id: handle.id, text: indexResultText(outcome) }] })),
  );
}

/**
 * Describe `ids`: at once when the key is set and at most `INDEX_CONFIRM_ABOVE` photos are new, else the dialog
 * (`ask` always opens it). Does nothing while an index run is queued or running.
 */
export async function describePhotosAction(ids: readonly string[], options: { ask?: boolean } = {}): Promise<void> {
  if (ids.length === 0) return;
  if (indexingIn(useJobsStore.getState())) {
    devLog('ai', 'describe photos: a run is already going', { photos: ids.length });
    return;
  }
  try {
    const ai = useAiStore.getState();
    if (!ai.settings) await ai.load();
    const { settings, error } = useAiStore.getState();
    if (!settings) {
      useDescribeStore.getState().open(ids, null, error ?? 'The AI settings could not be read.');
      return;
    }
    if (!settings.hasKey) {
      useDescribeStore.getState().open(ids, null);
      return;
    }
    const plan = await planIndex(ids);
    const sends = plan.todo.length;
    const nothing = sends === 0 && plan.copies.length === 0;
    if (options.ask || sends > INDEX_CONFIRM_ABOVE || nothing || plan.refreshable > 0) {
      useDescribeStore.getState().open(ids, plan);
      return;
    }
    start(plan);
  } catch (err) {
    devLog('ai', 'describe photos failed', { error: errorMessage(err) });
    useDescribeStore.getState().open(ids, null, errorMessage(err));
  }
}

/** "12 photos to describe, 4 already described, 1 not ready". */
export function planLine(plan: IndexPlan): string {
  const parts = [`${plural(plan.todo.length, 'photo')} to describe`];
  if (plan.copies.length > 0) parts.push(`${plural(plan.copies.length, 'description')} copied from another folder`);
  if (plan.described > 0) {
    parts.push(
      `${plan.described} already described${plan.refreshable > 0 && !plan.refresh ? ` (${plan.refreshable} by a cheaper model: Refresh redoes them)` : ''}`,
    );
  }
  if (plan.unavailable > 0)
    parts.push(`${plan.unavailable} not ready (not hashed yet, or its library cannot be written)`);
  return parts.join(', ');
}

const toastButton =
  'rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent';

/** The dialog and the run toasts (mounted once in `main.tsx`). */
export function DescribeDialog() {
  const dialog = useDescribeStore((s) => s.dialog);
  const toasts = useDescribeStore((s) => s.toasts);
  return (
    <>
      {dialog && (
        <DescribeDialogBody
          key={dialog.ids.join('\n')}
          ids={dialog.ids}
          initial={dialog.plan}
          initialError={dialog.error ?? null}
        />
      )}
      {toasts.length > 0 && (
        <div className="fixed bottom-3 left-3 z-30 flex max-w-[28rem] flex-col gap-1.5">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5 text-fg text-xs shadow-float"
            >
              <span className="min-w-0 flex-1">{t.text}</span>
              <button
                type="button"
                aria-label="Dismiss"
                className={toastButton}
                onClick={() => useDescribeStore.getState().dismissToast(t.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function DescribeDialogBody({
  ids,
  initial,
  initialError,
}: {
  ids: readonly string[];
  initial: IndexPlan | null;
  initialError: string | null;
}) {
  const settings = useAiStore((s) => s.settings);
  const indexing = useIndexing();
  const [refresh, setRefresh] = useState(false);
  const [plan, setPlan] = useState<IndexPlan | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const close = () => useDescribeStore.getState().close();
  const hasKey = settings?.hasKey ?? false;

  useEffect(() => {
    if (!hasKey || initialError) return;
    if (!refresh && initial) {
      setPlan(initial);
      return;
    }
    let live = true;
    setPlan(null);
    planIndex(ids, { refresh })
      .then((next) => live && setPlan(next))
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [ids, refresh, initial, hasKey, initialError]);

  const sends = plan ? plan.todo.length + plan.copies.length : 0;
  const cost = plan && plan.todo.length > 0 ? estimateIndex(plan) : null;
  const describe = () => {
    if (!plan || sends === 0 || indexingIn(useJobsStore.getState())) return;
    close();
    start(plan);
  };

  return (
    <DialogShell title="Describe photos" onClose={close} widthClass="w-[30rem]">
      <DialogBody>
        <p className="text-fg-muted">
          A two-line description of each photo, saved in its folder&rsquo;s library and shared by every project, so
          captions can use the whole book as text. Photos described before are skipped.
        </p>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : !hasKey ? (
          <p role="alert" className="text-fg">
            Add an Anthropic API key in Settings → AI first.
          </p>
        ) : !plan ? (
          <p className="text-fg-muted">Counting…</p>
        ) : (
          <>
            <p role="status" className="text-fg">
              {planLine(plan)}.
            </p>
            {cost && (
              <p className="text-fg">
                {plural(indexRequests(plan), 'request')} of up to 8 photos, {describeEstimate(cost)}.
              </p>
            )}
          </>
        )}
        {indexing && <p className="text-fg-muted">Another Describe photos run is going; wait for it to finish.</p>}
        {hasKey && !initialError && (
          <label className="flex items-center gap-2 text-fg-muted">
            <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
            Refresh: describe again the photos a cheaper model described
            {plan ? ` (now ${aiModelLabel(plan.model)})` : ''}
          </label>
        )}
        <p className="text-fg-muted">
          Each photo&rsquo;s preview (768 px) is sent to Anthropic with your key, and to nobody else. Nothing is sent
          until you press Describe.
        </p>
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton primary disabled={!hasKey || !plan || sends === 0 || indexing} onClick={describe}>
          {plan && sends > 0 ? `Describe ${plural(sends, 'photo')}` : 'Describe'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

/** The batch bar's Describe photos (order 70): the selection, or the photo shown when nothing is selected. */
function DescribeSlot({ ids, current }: BatchContext) {
  const indexing = useIndexing();
  const targets = ids.length > 0 ? ids : [current];
  return (
    <BatchButton
      disabled={indexing}
      onClick={(e) => void describePhotosAction(targets, { ask: e.shiftKey })}
      title={
        indexing
          ? 'Describing photos…'
          : `Describe ${ids.length > 0 ? 'the selected photos' : 'this photo'} with AI for captions (saved in the library; Shift-click to see the cost and Refresh first)`
      }
    >
      Describe photos
    </BatchButton>
  );
}

registerBatchSlot({ id: 'describe', order: 70, render: (ctx) => <DescribeSlot {...ctx} /> });
