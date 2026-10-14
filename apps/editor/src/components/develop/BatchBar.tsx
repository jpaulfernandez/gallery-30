import { isDefaultDevelop } from '@photobook/shared';
import { type ButtonHTMLAttributes, Fragment, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { chosenLookId, NO_LOOK } from '../../lib/develop/looks';
import type { DevelopSyncSection } from '../../lib/develop/sync';
import { devLog } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { isActive, useJobsStore } from '../../store/jobs';
import { assetDevelop } from '../../store/library';
import { applyLookTo } from '../../store/looks';
import { useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Pill, PillCount, PillDivider } from '../ui/Pill';
import { type BatchContext, registerBatchSlot, useBatchSlots } from './batchSlots';

/** Reset edits asks first above this many photos. */
export const RESET_CONFIRM_ABOVE = 5;

/**
 * The Develop batch bar (workflow plan 08) as a floating pill (`ui/Pill`, plans 46 and 47) over the bottom of the
 * picture: how many photos are selected, Clear, and the registered slots (`batchSlots.ts`) acting on them. It slides
 * up while the selection is non-empty and is out of the way (and inert) otherwise. While jobs run for the selected photos it counts
 * them ("23 of 58"). `ids` is the selection within the strip's list; `current` the photo shown; `all` every photo the
 * strip lists.
 *
 * Plan 54 (ODDHALLS_LAYOUT_PLAN 4.6): with nothing selected and more than one photo in the strip the pill stays up
 * with one line, "Select photos in the strip to apply to several", and *Apply to all in the strip ▾* (the
 * `apply-all` slot), so the common case needs no selection.
 */
export function BatchBar({ ids, current, all = [] }: BatchContext) {
  const allSlots = useBatchSlots();
  const ctx: BatchContext = { ids, current, all };
  const selected = ids.length > 0;
  const shown = selected || all.length > 1;
  const slots = selected ? allSlots : allSlots.filter((slot) => slot.id === APPLY_ALL_SLOT);
  const progress = useBatchProgress(ids);
  return (
    <Pill shown={shown} label="Batch actions">
      {selected ? (
        <>
          <PillCount count={ids.length} progress={progress} />
          <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().clearSelection()}>
            Clear
          </Button>
        </>
      ) : (
        <span role="status" className="text-fg-muted" title="Cmd-click or Shift-click photos in the strip">
          Select photos in the strip to apply to several
        </span>
      )}
      <PillDivider />
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden">
        {slots.map((slot) => (
          <Fragment key={slot.id}>{slot.render(ctx)}</Fragment>
        ))}
      </div>
    </Pill>
  );
}

/**
 * Jobs (renders, denoise, exports) for the selected photos since the first of them was queued: `done` of `total`
 * while any is still queued or running, else null. The count starts over once they have all ended.
 */
export function useBatchProgress(ids: readonly string[]): { done: number; total: number } | null {
  const active = useJobsStore(
    useShallow((s) => {
      const refs = new Set(ids);
      return Object.values(s.jobs)
        .filter((j) => j.ref !== undefined && refs.has(j.ref) && isActive(j))
        .map((j) => j.id);
    }),
  );
  const seen = useRef(new Set<string>());
  for (const id of active) seen.current.add(id);
  useEffect(() => {
    if (active.length === 0) seen.current.clear();
  }, [active]);
  if (active.length === 0) return null;
  return { done: seen.current.size - active.length, total: seen.current.size };
}

/** A batch bar button, for slots. */
export function BatchButton({ className = '', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return <Button size="sm" {...props} className={className} />;
}

/** Sync selected…: the Sync dialog from the photo shown, with the selection (less that photo) checked. */
function SyncSlot({ ids, current }: BatchContext) {
  const targets = ids.filter((id) => id !== current);
  return (
    <BatchButton
      disabled={targets.length === 0}
      onClick={() => useUiStore.getState().openSyncDialog(current, targets)}
      title="Copy settings of this photo onto the selected photos"
    >
      Sync selected…
    </BatchButton>
  );
}

/** Reset edits: the selected photos back to the original, one undo step; asks first above `RESET_CONFIRM_ABOVE`. */
function ResetSlot({ ids }: BatchContext) {
  const [confirming, setConfirming] = useState(false);
  const edited = useBookStore((s) =>
    ids.reduce((n, id) => {
      const develop = assetDevelop(s, id);
      return develop && !isDefaultDevelop(develop) ? n + 1 : n;
    }, 0),
  );
  // A new selection asks again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` is the trigger
  useEffect(() => setConfirming(false), [ids]);
  const reset = () => {
    setConfirming(false);
    const changed = useBookStore.getState().resetDevelopMany(ids);
    devLog('develop', 'reset edits of the selection', { photos: ids.length, changed });
  };
  if (confirming) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-fg">
          Reset edits of {edited} photo{edited === 1 ? '' : 's'}?
        </span>
        <BatchButton onClick={reset} className="border-danger/60 text-fg">
          Reset
        </BatchButton>
        <BatchButton onClick={() => setConfirming(false)}>Cancel</BatchButton>
      </span>
    );
  }
  return (
    <BatchButton
      disabled={edited === 0}
      onClick={() => (edited > RESET_CONFIRM_ABOVE ? setConfirming(true) : reset())}
      title="Put the selected photos back to the original (one undo step)"
    >
      Reset edits
    </BatchButton>
  );
}

/** The sections *Apply Light & Color* copies: the Light card (light and the curve) and the Color card (white balance and color). */
export const LIGHT_AND_COLOR: readonly DevelopSyncSection[] = ['basic', 'curve', 'color'];

/** The slot id of Apply to all ▾, shown with nothing selected too. */
export const APPLY_ALL_SLOT = 'apply-all';

/**
 * Plan 54: *Apply to all ▾*, the pill's first action: the photo shown onto the selection (less that photo), or with
 * nothing selected onto every other photo of the strip. *Apply Light & Color to all n* syncs the Light and Color
 * cards in one click; *Apply these sections…* opens the Sync dialog with those photos checked; *Apply look to all n*
 * applies this photo's look at its Amount (`applyLookTo`). Each is one undo step; renders queue one job each as
 * before.
 */
function ApplyAllSlot({ ids, current, all = [] }: BatchContext) {
  const selected = ids.length > 0;
  const targets = (selected ? ids : all).filter((id) => id !== current);
  const n = targets.length;
  const lookId = useBookStore((s) => {
    const develop = assetDevelop(s, current);
    const id = develop ? chosenLookId(develop) : null;
    return id && id !== NO_LOOK ? id : null;
  });
  const lookAmount = useBookStore((s) => assetDevelop(s, current)?.look.applied?.amount);
  const applyLightColor = () => {
    const changed = useBookStore.getState().syncDevelop(current, targets, LIGHT_AND_COLOR);
    devLog('develop', 'applied light and color to all', { photos: n, changed });
  };
  return (
    <Menu
      label={
        <>
          {selected ? 'Apply to all' : 'Apply to all in the strip'}
          <svg
            viewBox="0 0 16 16"
            className="size-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      }
      ariaLabel={selected ? 'Apply to all' : 'Apply to all in the strip'}
      menuLabel="Apply to all"
      variant="soft"
      disabled={n === 0}
      title={`Apply this photo's settings to ${selected ? 'the selected photos' : 'every photo in the strip'}`}
      width={260}
    >
      <MenuItem onSelect={applyLightColor} hint="Light, curve, white balance and color; one undo step">
        Apply Light &amp; Color to all {n}
      </MenuItem>
      <MenuItem onSelect={() => useUiStore.getState().openSyncDialog(current, targets)}>Apply these sections…</MenuItem>
      <MenuSeparator />
      <MenuItem
        disabled={lookId === null}
        onSelect={() => {
          if (lookId) applyLookTo(targets, lookId, lookAmount);
        }}
        title={lookId === null ? 'This photo has no look' : undefined}
      >
        Apply look to all {n}
      </MenuItem>
    </Menu>
  );
}

registerBatchSlot({ id: APPLY_ALL_SLOT, order: 0, render: (ctx) => <ApplyAllSlot {...ctx} /> });
registerBatchSlot({ id: 'sync', order: 10, render: (ctx) => <SyncSlot {...ctx} /> });
registerBatchSlot({ id: 'reset', order: 20, render: (ctx) => <ResetSlot {...ctx} /> });
