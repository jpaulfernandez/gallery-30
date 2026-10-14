import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeJobCount,
  activeJobFor,
  cancelJob,
  cancelProjectJobs,
  enqueue,
  JobCancelled,
  type JobContext,
  type JobKind,
  jobList,
  jobsByRef,
  resetJobs,
  useJobsStore,
} from './jobs';

/** A job whose `run` waits until the test settles it. */
function pending(kind: JobKind, label: string = kind, extra: { ref?: string; project?: string; dedupe?: string } = {}) {
  const control = {
    started: false,
    ctx: null as JobContext | null,
    resolve: (_value?: unknown) => {},
    reject: (_err: unknown) => {},
  };
  const handle = enqueue({
    kind,
    label,
    ...extra,
    run: (ctx) =>
      new Promise((resolve, reject) => {
        control.started = true;
        control.ctx = ctx;
        control.resolve = resolve;
        control.reject = reject;
      }),
  });
  return { handle, control };
}

const state = (id: string) => useJobsStore.getState().jobs[id]?.state;
/** Let the queue start the next job (it does so on the next task after one ends). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetJobs();
});

describe('job queue', () => {
  it('runs renders and denoise one at a time (they share the GPU), in the order queued', async () => {
    const a = pending('render', 'a');
    const b = pending('denoise', 'b');
    const c = pending('render', 'c');
    expect([a.control.started, b.control.started, c.control.started]).toEqual([true, false, false]);
    expect([state(a.handle.id), state(b.handle.id), state(c.handle.id)]).toEqual(['running', 'queued', 'queued']);
    expect(activeJobCount(useJobsStore.getState())).toBe(3);

    a.control.resolve('a done');
    await expect(a.handle.result).resolves.toEqual({ state: 'done', value: 'a done' });
    await settle();
    expect([b.control.started, c.control.started]).toEqual([true, false]);
    b.control.resolve();
    await b.handle.result;
    await settle();
    expect(c.control.started).toBe(true);
  });

  it('runs other lanes alongside: one publish, two exports', () => {
    const render = pending('render');
    const publish = pending('publish');
    const exports = [pending('export'), pending('export'), pending('export')];
    expect(render.control.started).toBe(true);
    expect(publish.control.started).toBe(true);
    expect(exports.map((e) => e.control.started)).toEqual([true, true, false]);
    expect(pending('publish').control.started).toBe(false);
  });

  it('never starts a queued job that was cancelled', async () => {
    const a = pending('render', 'a');
    const b = pending('render', 'b');
    cancelJob(b.handle.id);
    expect(state(b.handle.id)).toBe('cancelled');
    await expect(b.handle.result).resolves.toEqual({ state: 'cancelled' });
    a.control.resolve();
    await settle();
    expect(b.control.started).toBe(false);
    expect(activeJobCount(useJobsStore.getState())).toBe(0);
  });

  it('keeps the rest running when one fails, and the failure stays until dismissed', async () => {
    const a = pending('render', 'a');
    const b = pending('render', 'b');
    const other = pending('export', 'x');
    a.control.reject(new Error('cannot decode'));
    await expect(a.handle.result).resolves.toMatchObject({ state: 'failed', error: 'cannot decode' });
    await settle();
    expect(b.control.started).toBe(true);
    expect(state(other.handle.id)).toBe('running');
    expect(useJobsStore.getState().jobs[a.handle.id]?.error).toBe('cannot decode');

    b.control.resolve();
    await b.handle.result;
    useJobsStore.getState().clearDone();
    expect(state(b.handle.id)).toBeUndefined();
    expect(state(a.handle.id)).toBe('failed');
    useJobsStore.getState().dismiss(a.handle.id);
    expect(state(a.handle.id)).toBeUndefined();
  });

  it('asks a running job to stop and ends it cancelled when its run stops', async () => {
    const a = pending('denoise', 'a');
    const stop = vi.fn();
    a.control.ctx?.onCancel(stop);
    expect(useJobsStore.getState().jobs[a.handle.id]?.cancel).toBeTypeOf('function');
    useJobsStore.getState().jobs[a.handle.id]?.cancel?.();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(a.control.ctx?.cancelled).toBe(true);
    expect(useJobsStore.getState().jobs[a.handle.id]).toMatchObject({ state: 'running', cancelling: true });
    // A second cancel does not call the handler again.
    cancelJob(a.handle.id);
    expect(stop).toHaveBeenCalledTimes(1);
    a.control.reject(new Error('stopped'));
    await expect(a.handle.result).resolves.toEqual({ state: 'cancelled' });
    expect(useJobsStore.getState().jobs[a.handle.id]).toMatchObject({ state: 'cancelled' });
    expect(useJobsStore.getState().jobs[a.handle.id]?.cancelling).toBeUndefined();
  });

  it('ends done with its value when the run completes although a cancel came too late', async () => {
    const a = pending('publish', 'uploaded');
    cancelJob(a.handle.id);
    a.control.resolve('published');
    await expect(a.handle.result).resolves.toEqual({ state: 'done', value: 'published' });
    expect(state(a.handle.id)).toBe('done');
  });

  it('queues equal work anew while a cancelled run is still stopping, and starts it after', async () => {
    const a = pending('denoise', 'a', { dedupe: 'k' });
    cancelJob(a.handle.id);
    const b = pending('denoise', 'b', { dedupe: 'k' });
    expect(b.handle).toMatchObject({ created: true });
    expect(b.handle.id).not.toBe(a.handle.id);
    expect(b.control.started).toBe(false);
    a.control.reject(new JobCancelled());
    await a.handle.result;
    await settle();
    expect(b.control.started).toBe(true);
  });

  it('a job joined by another project or a library Apply goes on when its project closes', () => {
    const a = pending('denoise', 'a', { dedupe: 'k', project: 'P' });
    enqueue({ kind: 'denoise', label: 'apply', dedupe: 'k', run: async () => {} });
    const b = pending('render', 'b', { dedupe: 'r', project: 'P' });
    enqueue({ kind: 'render', label: 'b again', dedupe: 'r', project: 'Q', run: async () => {} });
    expect(cancelProjectJobs('P')).toBe(0);
    expect(state(a.handle.id)).toBe('running');
    expect(useJobsStore.getState().jobs[a.handle.id]?.project).toBeUndefined();
    expect(useJobsStore.getState().jobs[b.handle.id]?.project).toBe('Q');
    expect(cancelProjectJobs('Q')).toBe(1);
    expect(state(b.handle.id)).toBe('cancelled');
  });

  it('ends cancelled when the run throws JobCancelled (the command stopped on its own)', async () => {
    const a = pending('denoise');
    a.control.reject(new JobCancelled());
    await expect(a.handle.result).resolves.toEqual({ state: 'cancelled' });
  });

  it('reports progress and a line log while running', () => {
    const a = pending('publish', 'Publish', { ref: 'P' });
    const b = pending('publish', 'queued');
    a.control.ctx?.progress(3, 10, 'upload');
    a.control.ctx?.log('warning: big file');
    expect(useJobsStore.getState().jobs[a.handle.id]).toMatchObject({
      done: 3,
      total: 10,
      detail: 'upload',
      log: ['warning: big file'],
    });
    expect(useJobsStore.getState().jobs[a.handle.id]?.startedAt).toEqual(expect.any(Number));
    expect(useJobsStore.getState().jobs[b.handle.id]?.startedAt).toBeNull();
    expect(jobsByRef(useJobsStore.getState(), 'P').map((j) => j.id)).toEqual([a.handle.id]);
    expect(jobList(useJobsStore.getState()).map((j) => j.label)).toEqual(['queued', 'Publish']);
  });

  it('joins an equal job already queued or running instead of queueing it twice', async () => {
    const a = pending('denoise', 'a', { dedupe: 'hash:nafnet:50', ref: 'f1' });
    const run = vi.fn(async () => 'never');
    const again = enqueue({ kind: 'denoise', label: 'again', dedupe: 'hash:nafnet:50', run });
    expect(again).toMatchObject({ id: a.handle.id, created: false });
    expect(run).not.toHaveBeenCalled();
    expect(activeJobFor(useJobsStore.getState(), 'denoise', 'f1')?.id).toBe(a.handle.id);
    a.control.resolve('one run');
    await expect(again.result).resolves.toEqual({ state: 'done', value: 'one run' });
    // Once over, the same key queues anew.
    expect(enqueue({ kind: 'denoise', label: 'later', dedupe: 'hash:nafnet:50', run }).created).toBe(true);
  });

  it('cancels the jobs of a closed project and says so', async () => {
    const mine = pending('render', 'a', { project: 'P' });
    const queued = pending('denoise', 'b', { project: 'P' });
    const library = pending('export', 'c');
    const stop = vi.fn();
    mine.control.ctx?.onCancel(stop);
    expect(cancelProjectJobs('P', 'Lisbon')).toBe(2);
    expect(stop).toHaveBeenCalled();
    expect(state(queued.handle.id)).toBe('cancelled');
    expect(state(library.handle.id)).toBe('running');
    expect(useJobsStore.getState().notice).toBe('Closing “Lisbon” cancelled 2 jobs.');
    useJobsStore.getState().dismissNotice();
    expect(useJobsStore.getState().notice).toBeNull();
    expect(cancelProjectJobs('nothing')).toBe(0);
    expect(useJobsStore.getState().notice).toBeNull();
  });

  it('a job that throws synchronously fails without stopping the queue', async () => {
    const bad = enqueue({
      kind: 'render',
      label: 'bad',
      run: () => {
        throw new Error('boom');
      },
    });
    const next = pending('render', 'next');
    await expect(bad.result).resolves.toMatchObject({ state: 'failed', error: 'boom' });
    await settle();
    expect(next.control.started).toBe(true);
  });
});
