import type { OutputProfile } from './schema.js';

/** How the UI names each output profile. */
export const OUTPUT_PROFILE_LABELS: Record<OutputProfile, string> = { srgb: 'sRGB', 'display-p3': 'Display P3' };

/**
 * What a developed render's file name carries after the develop hash for each output profile: nothing for sRGB
 * (so every render from before Display P3 keeps its name), `-p3` for Display P3. Equal to
 * `OutputProfile::file_suffix` in `crates/develop`.
 */
export function outputProfileSuffix(profile: OutputProfile = 'srgb'): '' | '-p3' {
  return profile === 'display-p3' ? '-p3' : '';
}

/**
 * `<assetHash>-<developHash>[-p3].jpg`: the full-resolution render of one developed photo in
 * `<folder>/.photobook-cache/develop/`, written by the editor (`render_develop_full`) and published by the CLI.
 */
export function developRenderName(assetHash: string, developHash: string, profile: OutputProfile = 'srgb'): string {
  return `${assetHash}-${developHash}${outputProfileSuffix(profile)}.jpg`;
}
