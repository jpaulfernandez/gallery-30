import { devLog } from '../../lib/log';

/**
 * Workflow plan 36 (platform budgets): slider→paint latency of the Develop live preview, as a dev log line
 * `[photobook:develop] slider→paint <ms>ms {path, job, request, decode}`.
 *
 * The clock starts at the settings change a preview render carries (`usePreview` marks it when it sees new settings,
 * or earlier when a caller marked the input itself with `markInput`, as the budgets bench does at its store write) and
 * stops in the animation frame after the new picture is on the page: the `<img>`'s `load` (JPEG path) or the WebGL
 * draw (raw path, `RawPreviewCanvas`). The frame that callback runs in is the one that composites the picture, so the
 * screen shows it at most one refresh later.
 */

export type PreviewPath = 'jpeg' | 'raw';

export interface PaintSample {
  /** Settings change → the frame that shows it, ms. */
  ms: number;
  path: PreviewPath;
  job: number;
  /** Request → bytes in the webview (render, encode, transfer), ms. */
  request: number;
  /** JPEG: `HTMLImageElement.decode()`; raw: texture upload + draw call, ms. */
  decode: number;
}

interface Pending {
  changedAt: number;
  path: PreviewPath;
  job: number;
  request: number;
  decode: number;
}

const MAX_PENDING = 16;
const pending = new Map<string, Pending>();
const listeners = new Set<(sample: PaintSample) => void>();
let inputAt: number | null = null;

/** Mark the moment an input changed a setting (before the store write), for the next change `usePreview` sees. */
export function markInput(): void {
  inputAt = performance.now();
}

/** The marked input time if any (consumed), else `now`. */
export function takeInput(now: number): number {
  const at = inputAt ?? now;
  inputAt = null;
  return at;
}

/** Remember that the picture `key` (a blob URL, or `raw:<job>`) shows settings changed at `info.changedAt`. */
export function expectPaint(key: string, info: Pending): void {
  pending.set(key, info);
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/** The picture `key` is on the page: log the latency in the next animation frame. `decode` overrides the stage time. */
export function painted(key: string, decode?: number): void {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  const done = () => {
    const sample: PaintSample = {
      ms: Math.round(performance.now() - p.changedAt),
      path: p.path,
      job: p.job,
      request: p.request,
      decode: Math.round(decode ?? p.decode),
    };
    // Dev builds only: in a release build `devLog` is a console line plus a rejected log-plugin invoke per preview.
    if (import.meta.env.DEV) {
      devLog('develop', `slider→paint ${sample.ms}ms`, {
        path: sample.path,
        job: sample.job,
        request: sample.request,
        decode: sample.decode,
      });
    }
    for (const fn of listeners) fn(sample);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(done);
  else done();
}

/** Listen to every paint sample (the budgets bench); returns the unsubscribe. */
export function onPaint(fn: (sample: PaintSample) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
