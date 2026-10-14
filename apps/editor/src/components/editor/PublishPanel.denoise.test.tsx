// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { cancelJob, enqueue, resetJobs, useJobsStore } from '../../store/jobs';
import { usedAssetIds } from '../filmstrip/visible';

vi.mock('../../lib/publishRunner', () => ({ startPublish: vi.fn() }));
vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));

const { PublishPanel } = await import('./PublishPanel');
const { resetPublishSession } = await import('./publishSession');

beforeEach(() => {
  resetJobs();
  resetPublishSession();
  const book = structuredClone(fixtureBook);
  for (const [i, id] of [...usedAssetIds(book.pages)].entries()) {
    const asset = book.assets[id];
    if (asset) asset.hash = `hash-${i}`;
  }
  useBookStore.setState({ book, projectId: 'P', folder: '/photos' });
});

afterEach(async () => {
  for (const id of Object.keys(useJobsStore.getState().jobs)) cancelJob(id);
  cleanup();
  await useBookStore.getState().close();
});

describe('PublishPanel and denoise queued ahead (plan 27)', () => {
  it('says how many of the book’s photos are still denoising, and drops the line when they are done', async () => {
    const book = useBookStore.getState().book;
    const [a, b] = [...usedAssetIds(book?.pages ?? [])];
    let finish: () => void = () => {};
    enqueue({ kind: 'denoise', label: 'a', ref: a, run: () => new Promise<void>((r) => (finish = r)) });
    enqueue({ kind: 'denoise', label: 'b', ref: b, run: () => new Promise<void>(() => {}) });
    enqueue({ kind: 'denoise', label: 'x', ref: 'elsewhere', run: () => new Promise<void>(() => {}) });
    render(<PublishPanel onClose={() => {}} />);
    expect(screen.getByTestId('publish-queued-denoise').textContent).toBe(
      '2 photos still denoising; Publish waits for them.',
    );
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId('publish-queued-denoise').textContent).toBe(
      '1 photo still denoising; Publish waits for them.',
    );
  });

  it('shows no line with nothing queued', () => {
    render(<PublishPanel onClose={() => {}} />);
    expect(screen.queryByTestId('publish-queued-denoise')).toBeNull();
  });
});
