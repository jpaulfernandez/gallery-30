import type { OutputProfile } from '@photobook/shared';

/**
 * Workflow plan 36 (platform budgets): the raw preview experiment. With `localStorage['photobook.rawPreview'] = '1'`
 * in a dev build, the Develop live preview is fetched as raw RGBA8 over the debug-only `pbraw` scheme
 * (`src-tauri/src/commands/raw_preview.rs`) and drawn by `RawPreviewCanvas` into a WebGL canvas, instead of a JPEG
 * through `render_develop_preview` into an `<img>`. Off by default and never on in a release build. The fetch lives in
 * `rawPreviewFetch.ts`, imported dynamically so a release bundle leaves it out.
 */

export const RAW_PREVIEW_KEY = 'photobook.rawPreview';

let override: boolean | null = null;

/** Force the path on or off regardless of `localStorage` (the budgets bench); `null` follows the flag again. */
export function setRawPreviewOverride(on: boolean | null): void {
  override = on;
}

/** The raw path is on: a dev build and the flag (or the bench's override). */
export function rawPreviewEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (override !== null) return override;
  try {
    return globalThis.localStorage?.getItem(RAW_PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
}

/** One raw preview frame (packed RGBA8, rows top to bottom, in `profile`). */
export interface RawFrame {
  job: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  profile: OutputProfile;
  /** Rust render and RGB → RGBA pack, ms. */
  renderMs: number;
  packMs: number;
}
