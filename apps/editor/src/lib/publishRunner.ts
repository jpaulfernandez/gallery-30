import { errorMessage } from './errors';
import { devLog } from './log';
import { cancelPublish, onPublishExit, onPublishLine, type PublishCommand, runPublish } from './tauri';

/** The CLI's `--json` events (packages/publish/src/log.ts), as the editor reads them. */
export type PublishStep = 'freeze' | 'plan' | 'images' | 'pages' | 'upload' | 'manifest' | 'site' | 'prune' | 'record';

export type PublishEvent =
  | { type: 'step'; step: PublishStep; status: 'start' | 'done' | 'skipped'; ms?: number; detail?: string; t: number }
  | { type: 'progress'; step: PublishStep; done: number; total: number; detail?: string; t: number }
  | { type: 'log'; level: 'info' | 'warn'; message: string; t: number }
  | {
      type: 'result';
      url: string;
      link?: string;
      publishedAt: string;
      fingerprint: string;
      uploaded: number;
      skipped: number;
      bytes: number;
      dryRun: boolean;
      t: number;
    }
  | { type: 'error'; message: string; keys?: string[]; t: number }
  /** A line that was not JSON (stderr, a crash). */
  | { type: 'raw'; stream: 'stdout' | 'stderr'; line: string; t: number };

export interface PublishRun {
  /** Resolves with the exit code (null when cancelled) once the process has ended. */
  done: Promise<number | null>;
  cancel: () => Promise<void>;
}

let nextJob = Date.now();

/**
 * Start a CLI command and feed its events to `onEvent`. Listeners are attached before the
 * process starts and removed after it exits.
 */
export async function startPublish(
  options: { command: PublishCommand; folder?: string | null; dryRun?: boolean; prune?: boolean },
  onEvent: (event: PublishEvent) => void,
): Promise<PublishRun> {
  const job = ++nextJob;
  let settle: (code: number | null) => void = () => {};
  const done = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const unlistenLine = await onPublishLine((e) => {
    if (e.job !== job) return;
    onEvent(parseLine(e.stream, e.line));
  });
  const unlistenExit = await onPublishExit((e) => {
    if (e.job !== job) return;
    settle(e.code);
  });
  const finish = () => {
    unlistenLine();
    unlistenExit();
  };
  void done.then(finish);
  devLog('publish', 'start', { job, ...options });
  runPublish({ job, ...options }).catch((err) => {
    onEvent({ type: 'error', message: errorMessage(err), t: 0 });
    settle(null);
  });
  return { done, cancel: () => cancelPublish(job) };
}

export function parseLine(stream: 'stdout' | 'stderr', line: string): PublishEvent {
  if (stream === 'stdout' && line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line) as PublishEvent;
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) return parsed;
    } catch {
      // fall through
    }
  }
  return { type: 'raw', stream, line, t: 0 };
}
