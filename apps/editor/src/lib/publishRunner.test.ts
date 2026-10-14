import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJobs, useJobsStore } from '../store/jobs';
import type { PublishEvent } from './publishRunner';

const mocks = vi.hoisted(() => ({
  denoise: vi.fn(),
  render: vi.fn(),
  prune: vi.fn(async () => {}),
  runPublish: vi.fn(async () => {}),
  cancelPublish: vi.fn(async () => {}),
  exit: null as null | ((e: { job: number; code: number | null }) => void),
}));
vi.mock('./developPublish', () => ({
  denoiseBeforePublish: mocks.denoise,
  renderBeforePublish: mocks.render,
  pruneAfterPublish: mocks.prune,
}));
vi.mock('./tauri', () => ({
  runPublish: mocks.runPublish,
  cancelPublish: mocks.cancelPublish,
  onPublishLine: async () => () => {},
  onPublishExit: async (handler: (e: { job: number; code: number | null }) => void) => {
    mocks.exit = handler;
    return () => {};
  },
}));

const { startPublish } = await import('./publishRunner');

const book = structuredClone(fixtureBook);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.render.mockResolvedValue('done');
  mocks.denoise.mockResolvedValue('done');
});

describe('startPublish with edited photos', () => {
  it('renders before the CLI starts, then prunes after a successful publish', async () => {
    const order: string[] = [];
    mocks.render.mockImplementation(async () => {
      order.push('render');
      return 'done';
    });
    mocks.runPublish.mockImplementation(async () => {
      order.push('cli');
    });
    mocks.prune.mockImplementation(async () => {
      order.push('prune');
    });
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    const job = (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job;
    mocks.exit?.({ job, code: 0 });
    await expect(run.done).resolves.toBe(0);
    expect(order).toEqual(['render', 'cli', 'prune']);
  });

  it('does not prune after a dry run or a failed publish', async () => {
    const dry = await startPublish({ command: 'publish', folder: '/photos', book, dryRun: true }, () => {});
    await tick();
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job, code: 0 });
    await dry.done;
    const failed = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[1] as unknown as [{ job: number }])[0].job, code: 1 });
    await expect(failed.done).resolves.toBe(1);
    expect(mocks.prune).not.toHaveBeenCalled();
  });

  it('ends with the render error and never starts the CLI', async () => {
    mocks.render.mockRejectedValue(new Error('IMG_1.jpg: cannot decode'));
    const events: PublishEvent[] = [];
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, (e) => events.push(e));
    await expect(run.done).resolves.toBe(1);
    expect(events).toMatchObject([{ type: 'error', message: 'IMG_1.jpg: cannot decode' }]);
    expect(mocks.runPublish).not.toHaveBeenCalled();
  });

  it('cancel during the render aborts the render gate (it cancels its jobs) and skips the CLI', async () => {
    let finish: (outcome: string) => void = () => {};
    let signal: AbortSignal | undefined;
    mocks.render.mockImplementation((options: { signal?: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => (finish = resolve));
    });
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    expect(signal?.aborted).toBe(false);
    await run.cancel();
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(mocks.cancelPublish).not.toHaveBeenCalled();
    finish('cancelled');
    await expect(run.done).resolves.toBeNull();
    expect(mocks.runPublish).not.toHaveBeenCalled();
    expect(useJobsStore.getState().jobs[run.jobId]?.state).toBe('cancelled');
  });

  it('cancel after the render started stops the CLI instead', async () => {
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    await run.cancel();
    await tick();
    expect(mocks.cancelPublish).toHaveBeenCalledTimes(1);
  });

  it('does not render full-size files for a dry run; the CLI starts straight away', async () => {
    const run = await startPublish({ command: 'publish', folder: '/photos', book, dryRun: true }, () => {});
    await tick();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.runPublish).toHaveBeenCalledTimes(1);
    expect(mocks.runPublish).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job, code: 0 });
    await expect(run.done).resolves.toBe(0);
  });

  it('skips the render step for other commands and when no book is given', async () => {
    await startPublish({ command: 'doctor' }, () => {});
    await startPublish({ command: 'publish', folder: '/photos' }, () => {});
    await tick();
    // One CLI run at a time: the second starts when the first exits.
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job, code: 0 });
    await vi.waitFor(() => expect(mocks.runPublish).toHaveBeenCalledTimes(2));
    expect(mocks.render).not.toHaveBeenCalled();
  });
});

describe('startPublish with denoised photos', () => {
  it('denoises, then renders, then starts the CLI', async () => {
    const order: string[] = [];
    mocks.denoise.mockImplementation(async () => {
      order.push('denoise');
      return 'done';
    });
    mocks.render.mockImplementation(async () => {
      order.push('render');
      return 'done';
    });
    mocks.runPublish.mockImplementation(async () => {
      order.push('cli');
    });
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    expect(order).toEqual(['denoise', 'render', 'cli']);
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job, code: 0 });
    await expect(run.done).resolves.toBe(0);
  });

  it('ends with the denoise error (a missing model) before any render or CLI', async () => {
    mocks.denoise.mockRejectedValue(new Error('Denoise needs the NAFNet (w32) model (117 MB).'));
    const events: PublishEvent[] = [];
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, (e) => events.push(e));
    await expect(run.done).resolves.toBe(1);
    expect(events).toMatchObject([{ type: 'error', message: 'Denoise needs the NAFNet (w32) model (117 MB).' }]);
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.runPublish).not.toHaveBeenCalled();
  });

  it('cancel during denoise aborts the denoise gate, not the render or the CLI', async () => {
    let finish: (outcome: string) => void = () => {};
    let signal: AbortSignal | undefined;
    mocks.denoise.mockImplementation((options: { signal?: AbortSignal }) => {
      signal = options.signal;
      return new Promise((resolve) => (finish = resolve));
    });
    const run = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await tick();
    await run.cancel();
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(mocks.cancelPublish).not.toHaveBeenCalled();
    finish('cancelled');
    await expect(run.done).resolves.toBeNull();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.runPublish).not.toHaveBeenCalled();
  });

  it('skips denoise for a dry run and without a book', async () => {
    await startPublish({ command: 'publish', folder: '/photos', book, dryRun: true }, () => {});
    await startPublish({ command: 'publish', folder: '/photos' }, () => {});
    await tick();
    expect(mocks.denoise).not.toHaveBeenCalled();
  });
});

describe('startPublish in the job queue', () => {
  it('is one publish job at a time, with the project and the warnings and errors as its log', async () => {
    const first = await startPublish({ command: 'publish', project: 'P', folder: '/photos', book }, () => {});
    const second = await startPublish({ command: 'doctor' }, () => {});
    await tick();
    expect(mocks.runPublish).toHaveBeenCalledTimes(1);
    const jobs = useJobsStore.getState().jobs;
    expect(jobs[first.jobId]).toMatchObject({ kind: 'publish', project: 'P', ref: 'P', state: 'running' });
    expect(jobs[second.jobId]?.state).toBe('queued');

    const job = (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job;
    mocks.exit?.({ job, code: 1 });
    await expect(first.done).resolves.toBe(1);
    expect(useJobsStore.getState().jobs[first.jobId]).toMatchObject({ state: 'failed' });
    // The next one starts once the first is over.
    await vi.waitFor(() => expect(mocks.runPublish).toHaveBeenCalledTimes(2));
    await second.cancel();
  });

  it('cancelled while queued, it never starts', async () => {
    const first = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    const second = await startPublish({ command: 'publish', folder: '/photos', book }, () => {});
    await second.cancel();
    await expect(second.done).resolves.toBeNull();
    await tick();
    mocks.exit?.({ job: (mocks.runPublish.mock.calls[0] as unknown as [{ job: number }])[0].job, code: 0 });
    await expect(first.done).resolves.toBe(0);
    await tick();
    expect(mocks.runPublish).toHaveBeenCalledTimes(1);
  });

  it('a CLI that cannot start is a failure with the reason, not a cancel', async () => {
    mocks.runPublish.mockRejectedValueOnce('node not found');
    const events: PublishEvent[] = [];
    const run = await startPublish({ command: 'doctor' }, (e) => events.push(e));
    await expect(run.done).resolves.toBe(1);
    expect(events).toMatchObject([{ type: 'error', message: 'The publish command could not start: node not found' }]);
    expect(useJobsStore.getState().jobs[run.jobId]).toMatchObject({
      state: 'failed',
      error: 'The publish command could not start: node not found',
    });
  });
});
