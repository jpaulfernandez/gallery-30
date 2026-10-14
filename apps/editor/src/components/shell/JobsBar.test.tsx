// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installProjectJobCancel } from '../../lib/jobs/projectClose';
import { useBookStore } from '../../store/book';
import { enqueue, resetJobs, useJobsStore } from '../../store/jobs';
import { JobsBar } from './JobsBar';

const never = () => new Promise<void>(() => {});

/** jsdom has no `AnimationEvent`, so React listens for the prefixed name there; send both. */
function animationEnd(el: Element) {
  act(() => {
    el.dispatchEvent(new Event('animationend', { bubbles: true }));
    el.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }));
  });
}

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  cleanup();
});

describe('JobsBar', () => {
  it('holds a Done pill when the last job finishes, until its own fade ends (plan 49)', async () => {
    render(<JobsBar />);
    let finish: () => void = () => {};
    let handle: ReturnType<typeof enqueue> | null = null;
    act(() => {
      handle = enqueue({ kind: 'render', label: 'IMG_2.jpg', run: () => new Promise<void>((r) => (finish = r)) });
    });
    expect(screen.getByRole('button', { name: 'Jobs: 1 active' })).toBeTruthy();
    await act(async () => {
      finish();
      await handle?.result;
    });
    const pill = screen.getByTestId('jobs-done');
    expect(pill.textContent).toContain('Done');
    // The check's stroke ends first; its animationend bubbles to the pill and must not end the beat.
    const check = pill.querySelector('.check-draw');
    if (!check) throw new Error('no check');
    animationEnd(check);
    expect(screen.getByTestId('jobs-done')).toBeTruthy();
    animationEnd(pill);
    expect(screen.queryByTestId('jobs-done')).toBeNull();
  });

  it('is hidden with nothing to show, then counts the active jobs and lists them with Cancel', async () => {
    const { container } = render(<JobsBar />);
    expect(container.textContent).toBe('');
    const stop = vi.fn();
    let running: { progress: (d: number, t: number, detail?: string) => void } | null = null;
    act(() => {
      enqueue({
        kind: 'denoise',
        label: 'DSCF1001.jpg',
        run: (ctx) => {
          ctx.onCancel(stop);
          running = ctx;
          return never();
        },
      });
      enqueue({ kind: 'render', label: 'DSCF1002.jpg', run: never });
    });
    act(() => running?.progress(40, 117, 'tile 40/117'));
    const pill = screen.getByRole('button', { name: 'Jobs: 2 active' });
    expect(pill.textContent).toContain('2 jobs');
    fireEvent.click(pill);
    const rows = screen.getAllByTestId('job-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('RenderDSCF1002.jpgCancelQueued'),
      expect.stringContaining('DenoiseDSCF1001.jpgCancel40/117 · tile 40/117'),
    ]);
    expect(screen.getByRole('progressbar', { name: 'DSCF1001.jpg progress' }).getAttribute('aria-valuenow')).toBe('34');
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1] as HTMLElement);
    expect(stop).toHaveBeenCalled();
    expect(screen.getByText('Cancelling…')).toBeTruthy();
  });

  it('keeps a failure until it is dismissed', async () => {
    render(<JobsBar />);
    let fail: (err: unknown) => void = () => {};
    const handle = enqueue({
      kind: 'render',
      label: 'IMG_1.jpg',
      run: () => new Promise((_, reject) => (fail = reject)),
    });
    await act(async () => {
      fail(new Error('cannot decode'));
      await handle.result;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Jobs: 0 active, 1 failed' }));
    expect(screen.getByRole('alert').textContent).toBe('cannot decode');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss IMG_1.jpg' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Jobs/ })).toBeNull();
  });

  it('closing the project cancels its jobs and says so', async () => {
    const unsubscribe = installProjectJobCancel();
    try {
      useBookStore.setState({
        book: { ...structuredClone(fixtureBook), title: 'Lisbon' },
        projectId: 'P',
        folder: '/p',
      });
      render(<JobsBar />);
      const stop = vi.fn();
      act(() => {
        enqueue({
          kind: 'render',
          label: 'a.jpg',
          project: 'P',
          run: (ctx) => {
            ctx.onCancel(stop);
            return never();
          },
        });
        enqueue({ kind: 'render', label: 'b.jpg', project: 'P', run: never });
        enqueue({ kind: 'export', label: 'library photo', run: never });
      });
      await act(async () => {
        await useBookStore.getState().close();
      });
      expect(stop).toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toContain('Closing “Lisbon” cancelled 2 jobs.');
      // The running one stops at its next checkpoint, the queued one never starts, the library job goes on.
      expect(Object.values(useJobsStore.getState().jobs).map((j) => [j.state, j.cancelling ?? false])).toEqual([
        ['running', true],
        ['cancelled', false],
        ['running', false],
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
