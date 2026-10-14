import { DEVELOP_DEFAULTS, type DevelopSettings } from '@photobook/shared';
import { deepEqual } from './merge';

/** The parts of the settings the Develop panel can reset on their own. */
export const DEVELOP_SECTION_KEYS = ['light', 'whiteBalance', 'curve', 'color', 'detail', 'effects', 'look'] as const;
export type DevelopSectionKey = (typeof DEVELOP_SECTION_KEYS)[number];

/** True when `section` of `settings` equals the defaults (an absent `settings` is all defaults). */
export function isSectionDefault(settings: DevelopSettings | undefined, section: DevelopSectionKey): boolean {
  return settings === undefined || deepEqual(settings[section], DEVELOP_DEFAULTS[section]);
}
