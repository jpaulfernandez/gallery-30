/**
 * Progress reporting. Human mode prints lines; `--json` prints one JSON object per line so the
 * editor can stream a publish into its panel. Every message also carries the elapsed time.
 */

export type StepName =
  | 'freeze'
  | 'plan'
  | 'images'
  | 'pages'
  | 'upload'
  | 'manifest'
  | 'site'
  | 'prune'
  | 'record'
  /** `render-frames` (workflow plan 14): a social post's frames and its caption file. */
  | 'frames'
  | 'caption'
  /** `print` (workflow plan 15): the print-size photos, then the PDF (or proof PNGs). */
  | 'print'
  /** `render-slideshow` (workflow plan 16): every video frame of a slideshow as a still. */
  | 'slideshow';

export type ReportEvent =
  | { type: 'step'; step: StepName; status: 'start' | 'done' | 'skipped'; ms?: number; detail?: string }
  | { type: 'progress'; step: StepName; done: number; total: number; detail?: string }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  | {
      type: 'result';
      /** Manifest URL on R2. */
      url: string;
      /** Reader link, when VIEWER_URL is configured. */
      link?: string;
      publishedAt: string;
      fingerprint: string;
      uploaded: number;
      skipped: number;
      bytes: number;
      dryRun: boolean;
    }
  | { type: 'error'; message: string; keys?: string[] };

export interface Reporter {
  emit(event: ReportEvent): void;
  info(message: string): void;
  warn(message: string): void;
  /** Time a step; emits start and done. */
  step<T>(step: StepName, fn: () => Promise<T>, detail?: (result: T) => string | undefined): Promise<T>;
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function createReporter(mode: 'human' | 'json', out: (line: string) => void = (l) => console.log(l)): Reporter {
  const started = performance.now();
  const emit = (event: ReportEvent): void => {
    if (mode === 'json') {
      out(JSON.stringify({ ...event, t: Math.round(performance.now() - started) }));
      return;
    }
    switch (event.type) {
      case 'step':
        if (event.status === 'start') out(`▸ ${event.step}`);
        else if (event.status === 'done')
          out(`  ${event.step} done in ${fmtMs(event.ms ?? 0)}${event.detail ? ` · ${event.detail}` : ''}`);
        else out(`  ${event.step} skipped${event.detail ? ` · ${event.detail}` : ''}`);
        break;
      case 'progress':
        out(`  [${event.done}/${event.total}] ${event.detail ?? ''}`.trimEnd());
        break;
      case 'log':
        out(event.level === 'warn' ? `! ${event.message}` : event.message);
        break;
      case 'result':
        out(
          event.dryRun
            ? `Dry run: nothing uploaded. ${event.uploaded} object(s) would upload, ${event.skipped} already on R2.`
            : `Published ${event.link ?? event.url} (${event.uploaded} uploaded, ${event.skipped} skipped, ${(event.bytes / 1e6).toFixed(1)} MB)`,
        );
        break;
      case 'error':
        out(`✗ ${event.message}`);
        for (const k of event.keys ?? []) out(`    ${k}`);
        break;
    }
  };
  return {
    emit,
    info: (message) => emit({ type: 'log', level: 'info', message }),
    warn: (message) => emit({ type: 'log', level: 'warn', message }),
    async step(step, fn, detail) {
      emit({ type: 'step', step, status: 'start' });
      const t0 = performance.now();
      const result = await fn();
      emit({ type: 'step', step, status: 'done', ms: performance.now() - t0, detail: detail?.(result) });
      return result;
    },
  };
}
