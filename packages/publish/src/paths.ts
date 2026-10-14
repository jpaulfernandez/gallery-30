import { homedir } from 'node:os';
import { join } from 'node:path';
import { developRenderName, type OutputProfile } from '@photobook/shared';

/** Tauri identifier of the editor; its app data dir holds the settings file the CLI reads. */
export const APP_IDENTIFIER = 'com.photobook.editor';
export const SETTINGS_FILE_NAME = 'publish.env';

/** The editor's app data dir (Tauri's `app_data_dir`), per platform. */
export function appDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_IDENTIFIER);
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_IDENTIFIER);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_IDENTIFIER);
  }
}

/** Where the settings live unless `--env` or `PHOTOBOOK_ENV` says otherwise. */
export function defaultSettingsPath(): string {
  return join(appDataDir(), SETTINGS_FILE_NAME);
}

/** Per-project work dir next to the project file: `.photobook-publish/`. */
export function workDir(projectPath: string): string {
  return join(projectPath, '..', '.photobook-publish');
}

/** Where the editor writes full-resolution developed renders, inside the source folder. */
export const DEVELOP_CACHE_DIR = join('.photobook-cache', 'develop');

/**
 * `<root>/.photobook-cache/develop/<assetHash>-<developHash>[-p3].jpg`: the render of one developed photo in the
 * book's output profile (`developRenderName`; sRGB when omitted).
 */
export function developRenderPath(
  root: string,
  assetHash: string,
  developHash: string,
  outputProfile: OutputProfile = 'srgb',
): string {
  return join(root, DEVELOP_CACHE_DIR, developRenderName(assetHash, developHash, outputProfile));
}
