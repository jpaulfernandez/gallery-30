import { info } from '@tauri-apps/plugin-log';
import { errorMessage } from './errors';

/**
 * Dev logging that reaches the terminal running `tauri dev`: `info()` from the log plugin goes to
 * the Rust logger (stdout in debug builds, see src-tauri/src/lib.rs). Every line also goes to the
 * webview console. Lines look like `[photobook:<scope>] <msg> {json}`.
 *
 * A no-op outside Tauri (plain browser, tests) except for the console line.
 */

const inTauri = (): boolean =>
  typeof window !== 'undefined' && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

function format(scope: string, msg: string, data?: unknown): string {
  let line = `[photobook:${scope}] ${msg}`;
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`;
    } catch {
      line += ` ${String(data)}`;
    }
  }
  return line;
}

export function devLog(scope: string, msg: string, data?: unknown): void {
  const line = format(scope, msg, data);
  console.log(line);
  if (!inTauri()) return;
  // Release builds do not register the plugin; the rejected invoke is expected there.
  info(line).catch(() => {});
}

/** Log a caught error with its message. */
export function devError(scope: string, msg: string, err: unknown): void {
  devLog(scope, msg, { error: errorMessage(err) });
}

let installed = false;

/** Forward uncaught errors and unhandled rejections to the dev log. Call once at startup. */
export function installErrorForwarding(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    devLog('error', 'window.onerror', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      col: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    devLog('error', 'unhandledrejection', { reason: errorMessage(event.reason) });
  });
}
