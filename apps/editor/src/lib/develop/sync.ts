/**
 * Sync settings (step D6.3): copy chosen sections of one photo's develop settings onto others. The sections are the
 * ones a person thinks in; `basic` is light plus white balance. `transform` (the Upright result and the Transform
 * sliders) and `masks` are per photo and off by default; the crop, rotation and flips are never synced.
 */
import type { DevelopSettings } from '@photobook/shared';
import { appliedAfterCopy } from './looks';
import type { DevelopSectionKey } from './sections';

export const SYNC_SECTIONS = ['basic', 'curve', 'color', 'detail', 'effects', 'look', 'transform', 'masks'] as const;
export type DevelopSyncSection = (typeof SYNC_SECTIONS)[number];

export const SYNC_SECTION_LABELS: Record<DevelopSyncSection, string> = {
  basic: 'Basic (light and white balance)',
  curve: 'Curve',
  color: 'Color',
  detail: 'Detail',
  effects: 'Effects (grading, grain, vignette, halation)',
  look: 'Look (LUT)',
  transform: 'Transform and Upright',
  masks: 'Masks',
};

/** Checked when the dialog opens: the tone, colour, effects and look sections, which carry over between photos. */
export const DEFAULT_SYNC_SECTIONS: readonly DevelopSyncSection[] = [
  'basic',
  'curve',
  'color',
  'detail',
  'effects',
  'look',
];

/** Why `transform` and `masks` are not on by default. */
export const SYNC_WARNINGS: Partial<Record<DevelopSyncSection, string>> = {
  transform:
    'Upright corrections are worked out for one photo’s lines and the Transform sliders suit one camera position. They are copied as they are; the crop is never synced.',
  masks: 'Masks are drawn on one photo’s content and are copied to the same positions on the others.',
};

/**
 * The sections Copy Settings offers (workflow plan 10): Sync's, with the AI denoise of Detail as its own box and the
 * crop (rect, straighten angle and aspect) added. Rotation and flips are never copied.
 */
export const COPY_SECTIONS = [
  'basic',
  'curve',
  'color',
  'detail',
  'denoise',
  'effects',
  'look',
  'crop',
  'transform',
  'masks',
] as const;
export type DevelopCopySection = (typeof COPY_SECTIONS)[number];

export const COPY_SECTION_LABELS: Record<DevelopCopySection, string> = {
  basic: 'Basic (light and white balance)',
  curve: 'Curve',
  color: 'Color',
  detail: 'Detail (texture, clarity, dehaze, sharpening)',
  denoise: 'AI denoise',
  effects: 'Effects (grading, grain, vignette, halation)',
  look: 'Look (LUT)',
  crop: 'Crop and straighten',
  transform: 'Transform and Upright',
  masks: 'Masks',
};

/** On by default (and until the dialog remembers another choice): everything but the crop, Transform and masks. */
export const DEFAULT_COPY_SECTIONS: readonly DevelopCopySection[] = [
  'basic',
  'curve',
  'color',
  'detail',
  'denoise',
  'effects',
  'look',
];

/** Why the per-photo sections are off by default; shown under a checked box, as Sync does. */
export const COPY_WARNINGS: Partial<Record<DevelopCopySection, string>> = {
  crop: 'The crop is copied as fractions of the picture, so on a photo of another shape it frames a different part.',
  transform:
    'Upright corrections are worked out for one photo’s lines and the Transform sliders suit one camera position. They are copied as they are.',
  masks: SYNC_WARNINGS.masks,
};

/** A Sync choice as copy sections: Sync's Detail includes the AI denoise. */
export const copySectionsOf = (sections: readonly DevelopSyncSection[]): DevelopCopySection[] =>
  sections.flatMap((s): DevelopCopySection[] => (s === 'detail' ? ['detail', 'denoise'] : [s]));

/**
 * `target` with the tone and colour sections named in `sections` taken from `source` (`basic`: light and white
 * balance; `curve`; `color`; `detail` without the AI denoise; `denoise`; `effects`; `look`). The crop, Transform and masks are the
 * caller's business (they move the crop and the masks along). Returns `target` itself when nothing applies.
 */
export function applySections(
  source: DevelopSettings,
  target: DevelopSettings,
  sections: readonly DevelopCopySection[],
): DevelopSettings {
  const next: DevelopSettings = { ...target };
  let changed = false;
  const take = <K extends 'light' | 'whiteBalance' | 'curve' | 'color' | 'effects' | 'look'>(key: K) => {
    next[key] = structuredClone(source[key]);
    changed = true;
  };
  if (sections.includes('basic')) {
    take('light');
    take('whiteBalance');
  }
  if (sections.includes('curve')) take('curve');
  if (sections.includes('color')) take('color');
  if (sections.includes('detail')) {
    next.detail = { ...structuredClone(source.detail), denoise: target.detail.denoise };
    changed = true;
  }
  if (sections.includes('denoise')) {
    next.detail = { ...next.detail, denoise: structuredClone(source.detail.denoise) };
    changed = true;
  }
  if (sections.includes('effects')) take('effects');
  if (sections.includes('look')) {
    take('look');
    // Plan 20: which look wrote the values travels only with every section that look lists.
    const copied: DevelopSectionKey[] = [];
    if (sections.includes('basic')) copied.push('light', 'whiteBalance');
    for (const key of ['curve', 'color', 'detail', 'effects', 'look'] as const)
      if (sections.includes(key)) copied.push(key);
    next.look = { ...next.look, applied: appliedAfterCopy(source.look.applied, copied) };
  }
  return changed ? next : target;
}
