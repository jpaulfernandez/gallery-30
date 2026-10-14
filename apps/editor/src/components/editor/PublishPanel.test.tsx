// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishEvent } from '../../lib/publishRunner';
import { useBookStore } from '../../store/book';
import { enqueue, resetJobs } from '../../store/jobs';

const mocks = vi.hoisted(() => ({
  startPublish: vi.fn(),
  flush: vi.fn(async () => {}),
}));
vi.mock('../../lib/publishRunner', () => ({ startPublish: mocks.startPublish }));
vi.mock('../../store/autosave', () => ({ flush: mocks.flush }));

const { PublishPanel } = await import('./PublishPanel');
const { resetPublishSession } = await import('./publishSession');

const PROJECT = '01K7A00000000000000000000A';

beforeEach(() => {
  resetJobs();
  resetPublishSession();
  mocks.startPublish.mockReset();
  useBookStore.setState({ book: structuredClone(fixtureBook), projectId: PROJECT, folder: '/photos' });
});

afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('PublishPanel with edited photos', () => {
  it('shows the render step with its progress, then hands over to the CLI steps', async () => {
    let emit: (e: PublishEvent) => void = () => {};
    let finish: (code: number | null) => void = () => {};
    mocks.startPublish.mockImplementation(async (_options, onEvent) => {
      emit = onEvent;
      return { done: new Promise((resolve) => (finish = resolve)), cancel: async () => {} };
    });
    render(<PublishPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {});

    // The saved book is passed along so the runner can render its edited photos first.
    expect(mocks.flush).toHaveBeenCalled();
    // The CLI runs on the project (Rust resolves its file); renders go to the photos' folders.
    expect(mocks.startPublish.mock.calls[0]?.[0]).toMatchObject({
      command: 'publish',
      project: PROJECT,
      folder: '/photos',
    });
    expect(mocks.startPublish.mock.calls[0]?.[0].book).toBe(useBookStore.getState().book);

    act(() => emit({ type: 'step', step: 'develop', status: 'start', t: 0 }));
    act(() => emit({ type: 'progress', step: 'develop', done: 2, total: 5, detail: 'DSCF1001.jpg', t: 0 }));
    expect(screen.getByText('Render edited photos')).toBeTruthy();
    expect(screen.getByText('2 / 5 · DSCF1001.jpg')).toBeTruthy();

    act(() => emit({ type: 'step', step: 'develop', status: 'done', ms: 1500, detail: '5 rendered', t: 0 }));
    expect(screen.getByText('5 rendered')).toBeTruthy();
    expect(screen.getByText('1.5 s')).toBeTruthy();

    act(() => emit({ type: 'error', message: 'DSCF1002.jpg: cannot decode', t: 0 }));
    await act(async () => finish(1));
    expect(screen.getByText('DSCF1002.jpg: cannot decode')).toBeTruthy();
  });

  it('has no render row for a book without edited photos', async () => {
    mocks.startPublish.mockImplementation(async (_options, onEvent) => {
      onEvent({ type: 'step', step: 'freeze', status: 'start', t: 0 });
      return { done: new Promise(() => {}), cancel: async () => {} };
    });
    render(<PublishPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {});
    expect(screen.queryByText('Render edited photos')).toBeNull();
    expect(screen.getByText('Freeze project')).toBeTruthy();
  });

  it("shows how many of the publish's photos are still in the queue, and keeps the run when closed", async () => {
    let finish: (code: number | null) => void = () => {};
    // Two renders and a denoise wait in the queue for the gate; an Apply of another photo of the project and another
    // project's render do not count.
    const never = () => new Promise<void>(() => {});
    enqueue({ kind: 'denoise', label: 'apply.jpg', project: PROJECT, run: never });
    const gate = [
      enqueue({ kind: 'denoise', label: 'a.jpg', project: PROJECT, run: never }),
      enqueue({ kind: 'render', label: 'b.jpg', project: PROJECT, run: never }),
      enqueue({ kind: 'render', label: 'c.jpg', project: PROJECT, run: never }),
    ];
    enqueue({ kind: 'render', label: 'd.jpg', project: 'another', run: never });
    mocks.startPublish.mockImplementation(async (options: { onJobs?: (ids: string[]) => void }) => {
      options.onJobs?.(gate.map((h) => h.id));
      return { done: new Promise((resolve) => (finish = resolve)), cancel: async () => {}, jobId: 'jx' };
    });
    const { unmount } = render(<PublishPanel onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await act(async () => {});
    expect(screen.getByTestId('publish-pending').textContent).toBe(
      '2 photos still rendering · 1 photo still denoising',
    );
    // Closing the dialog does not cancel; reopening shows the same run.
    unmount();
    render(<PublishPanel onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () => finish(0));
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
  });
});
