import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Typed wrappers around the Rust commands in src-tauri/src/commands.
 * Add one function here per new command so components never call `invoke` with strings.
 */

/** Raw text of `<folder>/book.photobook.json`, or null when the folder has no project file. */
export function openBook(folder: string): Promise<string | null> {
  return invoke<string | null>('open_book', { folder });
}

/** Atomically write the project file (temp file + rename) inside `folder`. */
export function writeBook(folder: string, json: string): Promise<void> {
  return invoke('write_book', { folder, json });
}

/** Last opened source folder, from `<appData>/recent.json`. */
export function getRecent(): Promise<string | null> {
  return invoke<string | null>('get_recent');
}

export function setRecent(folder: string): Promise<void> {
  return invoke('set_recent', { folder });
}

// Assets (src-tauri/src/commands/assets.rs). These mirror Rust payloads, not the book schema.

export type AssetKind = 'jpeg' | 'png' | 'heic';

export interface ScannedFile {
  /** Relative to the source folder, `/`-separated. */
  relPath: string;
  /** Bytes. */
  size: number;
  /** Modification time, epoch milliseconds. */
  mtimeMs: number;
  kind: AssetKind;
}

export interface AssetInfo {
  /** Upright pixel size of the original (EXIF orientation applied). */
  width: number;
  height: number;
  /** EXIF orientation 1 to 8 (1 when absent). */
  orientation: number;
  /** Absolute path of the 256 px upright JPEG thumbnail; load it with `fileUrl`. */
  thumbPath: string;
  /** Absolute path of the 1600 px upright JPEG proxy the canvas renders. */
  proxyPath: string;
}

/** Payload of `asset:hashed`, one per file. Exactly one of `hash` and `error` is set. */
export interface AssetHashedEvent {
  job: number;
  relPath: string;
  hash: string | null;
  error: string | null;
}

/** Payload of `asset:hash-progress`, sent after every file. */
export interface HashProgressEvent {
  job: number;
  done: number;
  total: number;
}

/** Every JPEG, PNG and HEIC under `folder` (recursive, hidden and project files skipped), sorted by path. */
export function scanFolder(folder: string): Promise<ScannedFile[]> {
  return invoke<ScannedFile[]>('scan_folder', { folder });
}

/**
 * SHA-256 of `relPaths` in order, on a few Rust threads. Results arrive as `asset:hashed` and
 * `asset:hash-progress` events tagged with `job`; listen before calling. A new call cancels the
 * previous job. Resolves when every file has been reported (or the job was cancelled).
 */
export function hashFiles(folder: string, relPaths: string[], job: number): Promise<void> {
  return invoke('hash_files', { folder, relPaths, job });
}

/** Ensure `<appdata>/cache/<hash>/{thumb,proxy}.jpg` exist (instant when cached) and return their info. */
export function prepareAsset(folder: string, relPath: string, hash: string): Promise<AssetInfo> {
  return invoke<AssetInfo>('prepare_asset', { folder, relPath, hash });
}

/** Absolute path of the thumbnail and proxy cache root, `<appdata>/cache`. */
export function readCacheDir(): Promise<string> {
  return invoke<string>('read_cache_dir');
}

export function onAssetHashed(handler: (event: AssetHashedEvent) => void): Promise<UnlistenFn> {
  return listen<AssetHashedEvent>('asset:hashed', (e) => handler(e.payload));
}

export function onHashProgress(handler: (event: HashProgressEvent) => void): Promise<UnlistenFn> {
  return listen<HashProgressEvent>('asset:hash-progress', (e) => handler(e.payload));
}

/** Webview URL (asset protocol) for an absolute path in the cache or the source folder. */
export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

// Publish (src-tauri/src/commands/publish.rs).

/** Keys of `<appdata>/publish.env`; the CLI reads the same file (packages/publish/src/config.ts). */
export const PUBLISH_SETTING_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
  'R2_TRANSPORT',
  'VIEWER_URL',
  'SITE_PASSWORD',
  'SITE_PASSWORD_EXPIRES_AT',
  'DOWNLOAD_MAX_EDGE',
  'DOWNLOAD_QUALITY',
  'PUBLISH_CONCURRENCY',
  'SOCIAL_API_URL',
  'SOCIAL_ADMIN_TOKEN',
] as const;
export type PublishSettingKey = (typeof PUBLISH_SETTING_KEYS)[number];
export type PublishSettings = Partial<Record<PublishSettingKey, string>>;

export function readPublishSettings(): Promise<PublishSettings> {
  return invoke<PublishSettings>('read_publish_settings');
}

/** Write the given keys (an empty value removes the key); other keys in the file are kept. */
export function writePublishSettings(values: PublishSettings): Promise<void> {
  return invoke('write_publish_settings', { values });
}

export type PublishCommand = 'publish' | 'unpublish' | 'password-sync' | 'password-clear' | 'doctor';

export interface PublishLineEvent {
  job: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface PublishExitEvent {
  job: number;
  /** Exit code; null when killed. */
  code: number | null;
}

/**
 * Run the publish CLI. Output arrives as `publish:line` events (stdout lines are JSON events of
 * the CLI's `--json` mode) and one `publish:exit`; listen before calling. Resolves on exit.
 */
export function runPublish(options: {
  job: number;
  command: PublishCommand;
  folder?: string | null;
  dryRun?: boolean;
  prune?: boolean;
}): Promise<void> {
  return invoke('run_publish', {
    job: options.job,
    command: options.command,
    folder: options.folder ?? null,
    dryRun: options.dryRun ?? false,
    prune: options.prune ?? false,
  });
}

export function cancelPublish(job: number): Promise<void> {
  return invoke('cancel_publish', { job });
}

export function onPublishLine(handler: (event: PublishLineEvent) => void): Promise<UnlistenFn> {
  return listen<PublishLineEvent>('publish:line', (e) => handler(e.payload));
}

export function onPublishExit(handler: (event: PublishExitEvent) => void): Promise<UnlistenFn> {
  return listen<PublishExitEvent>('publish:exit', (e) => handler(e.payload));
}
