// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DenoiseBatchPlan } from '../../lib/denoiseQueue';

const mocks = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn() }));
vi.mock('../../lib/denoiseQueue', () => ({
  planDenoiseBatch: mocks.plan,
  startDenoiseBatch: mocks.start,
  PlanAborted: class PlanAborted extends Error {},
}));

const { BatchBar } = await import('./BatchBar');
const { DenoiseBatchDialog, batchSummary, closeDenoiseBatch, durationLabel, estimateLine } = await import(
  './DenoiseBatch'
);

const item = (id: string, ready = false) => ({
  id,
  label: `${id}.jpg`,
  folder: '/p',
  relPath: `${id}.jpg`,
  hash: id,
  settings: {} as never,
  switchOn: null,
  ready,
  estimateMs: 15_000,
  modelMissing: false,
});

function planOf(force: boolean): DenoiseBatchPlan {
  const items = [item('a'), item('b'), item('c', true)];
  const todo = force ? items : items.filter((i) => !i.ready);
  return {
    force,
    items,
    todo,
    blocked: 0,
    skipped: items.length - todo.length,
    queued: 0,
    unreadable: 0,
    missingModel: null,
    estimateMs: todo.length * 15_000,
    unestimated: 0,
  };
}

beforeEach(() => {
  mocks.plan.mockReset();
  mocks.start.mockReset();
  mocks.plan.mockImplementation(async (_ids: string[], o: { force?: boolean }) => planOf(o.force ?? false));
});
afterEach(() => {
  cleanup();
  closeDenoiseBatch();
});

const ui = () =>
  render(
    <>
      <BatchBar ids={['a', 'b', 'c']} current="a" />
      <DenoiseBatchDialog />
    </>,
  );

describe('Denoise selected', () => {
  it('confirms with the count, the skipped ones and the estimate, then starts the batch', async () => {
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Denoise selected…' }));
    await act(async () => {});
    expect(mocks.plan).toHaveBeenCalledWith(['a', 'b', 'c'], expect.objectContaining({ force: false }));
    expect(screen.getByTestId('denoise-batch-summary').textContent).toBe(
      '2 photos to denoise · 1 already denoised (Shift to run again).',
    );
    expect(screen.getByTestId('denoise-batch-estimate').textContent).toContain('about 30 s');
    fireEvent.click(screen.getByRole('button', { name: 'Denoise 2 photos' }));
    expect(mocks.start).toHaveBeenCalledWith(planOf(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Shift-click plans with force (the already denoised ones too)', async () => {
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Denoise selected…' }), { shiftKey: true });
    await act(async () => {});
    expect(mocks.plan).toHaveBeenCalledWith(['a', 'b', 'c'], expect.objectContaining({ force: true }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Denoise 3 photos' })).toBeTruthy();
  });

  it('names a missing model and the photos it leaves out, and still runs the others', async () => {
    mocks.plan.mockResolvedValue({
      ...planOf(false),
      blocked: 3,
      missingModel: { title: 'NAFNet (w32)', bytes: 117_115_760 },
    });
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Denoise selected…' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain(
      'NAFNet (w32) is not installed (117 MB), so 3 photos are left out',
    );
    expect((screen.getByRole('button', { name: 'Denoise 2 photos' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('closing the confirm, or changing Run again, aborts the plan in progress', async () => {
    const signals: AbortSignal[] = [];
    mocks.plan.mockImplementation((_ids: string[], o: { signal: AbortSignal }) => {
      signals.push(o.signal);
      return new Promise(() => {});
    });
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Denoise selected…' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => {});
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(signals[1]?.aborted).toBe(true);
  });

  it('estimate line: about, at least, unknown', () => {
    expect(estimateLine(planOf(false))).toBe('Estimated time: about 30 s (from the last run).');
    expect(estimateLine({ ...planOf(false), estimateMs: 15_000, unestimated: 1 })).toBe(
      'Estimated time: at least 15 s (1 photo not estimated).',
    );
    expect(estimateLine({ ...planOf(false), estimateMs: null })).toBe(
      'Estimated time: unknown until a first denoise has run on this Mac.',
    );
  });

  it('labels', () => {
    expect(durationLabel(40_000)).toBe('about 40 s');
    expect(durationLabel(15 * 60_000)).toBe('about 15 min');
    expect(batchSummary({ ...planOf(false), queued: 1, unreadable: 2 })).toBe(
      '2 photos to denoise · 1 already denoised (Shift to run again) · 1 already in the queue · 2 not ready (still scanning or unreadable)',
    );
  });
});
