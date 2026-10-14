import { DEVELOP_DEFAULTS, type DevelopSettings, isDefaultDevelop } from './schema.js';

/**
 * Camera RAW extensions (lower case), the same list as `RAW_EXTENSIONS` in `crates/develop/src/decode/mod.rs`
 * (the editor's scan and the Rust decoder use that one; keep the two in sync).
 */
export const RAW_EXTENSIONS: readonly string[] = [
  'dng',
  'cr2',
  'cr3',
  'crw',
  'arw',
  'srf',
  'sr2',
  'raf',
  'nef',
  'nrw',
  'orf',
  'rw2',
  'rwl',
  'pef',
  'srw',
  'erf',
  '3fr',
  'fff',
  'iiq',
  'mos',
  'mef',
  'mrw',
  'kdc',
  'dcr',
  'x3f',
];

/** True when `path` has a camera RAW extension (case-insensitive). */
export function isRawPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && RAW_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/**
 * The settings an asset is published (and shown on the canvas) with, or undefined when the original file is used
 * as it is. Edited photos use their `develop`. A camera RAW always goes through the develop render, unedited ones
 * with the defaults (`develop` stays optional in the file), so its publish key is `developHash(develop ?? defaults)`.
 */
export function renderedDevelop(asset: { path: string; develop?: DevelopSettings }): DevelopSettings | undefined {
  if (isRawPath(asset.path)) return asset.develop ?? DEVELOP_DEFAULTS;
  return asset.develop && !isDefaultDevelop(asset.develop) ? asset.develop : undefined;
}
