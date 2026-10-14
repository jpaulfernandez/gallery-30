/**
 * The develop clipboard's payload (workflow plan 10): the chosen sections of one photo's settings as JSON
 * `{ type, version, sections, settings }`, which travels as text on the system clipboard (so it outlives the app and
 * crosses projects) and is kept typed in memory (`components/develop/copyPaste.tsx`). `settings` holds only what
 * `sections` names, the rest at the defaults; pasting applies those sections and nothing else. Pure.
 */
import { createDevelop, DevelopSchema, type DevelopSettings } from '@photobook/shared';
import { z } from 'zod';
import { applySections, COPY_SECTIONS, type DevelopCopySection } from './sync';

/** What the JSON says it is: the clipboard type the plan names, inside the text since the system one holds text only. */
export const DEVELOP_CLIP_TYPE = 'application/x-photobook-develop';
/** The payload's format; a change that old builds cannot read bumps it. */
export const DEVELOP_CLIP_VERSION = 1;
/**
 * Bounds on what a paste reads, so a huge (if valid) payload cannot stall the window: parsing and then pasting it onto
 * every selected photo is linear in its size. Longer text is skipped without parsing; more masks or brush points than
 * these are refused before validation. A photo's own masks stay far below them (strokes are simplified as drawn).
 */
export const MAX_CLIP_CHARS = 4_000_000;
export const MAX_CLIP_MASKS = 100;
export const MAX_CLIP_POINTS = 100_000;

/** Sections in `COPY_SECTIONS` order; names a newer build added are dropped. */
const SectionsSchema = z
  .array(z.string())
  .transform((list) => COPY_SECTIONS.filter((s) => list.includes(s)))
  .refine((list) => list.length > 0, 'no known section');

const DevelopClipSchema = z.object({
  type: z.literal(DEVELOP_CLIP_TYPE),
  version: z.literal(DEVELOP_CLIP_VERSION),
  sections: SectionsSchema,
  settings: DevelopSchema,
});

export interface DevelopClip {
  version: typeof DEVELOP_CLIP_VERSION;
  sections: DevelopCopySection[];
  settings: DevelopSettings;
  /** The photo it was copied from, when copied in this session (not part of the text): a paste skips it. */
  source?: string;
}

/**
 * What clipboard text holds: a clip; `unreadable`, text marked as ours that this build cannot use (another payload
 * version, invalid settings, or past the size bounds), worth telling the user about; or `foreign`, anything else.
 */
export type DecodedClip =
  | { kind: 'clip'; clip: DevelopClip }
  | { kind: 'unreadable'; reason: 'version' | 'size' | 'invalid' }
  | { kind: 'foreign' };

/** The clip of `source` for `sections` (in `COPY_SECTIONS` order): those sections copied deeply, the rest defaults. */
export function clipOf(source: DevelopSettings, sections: readonly DevelopCopySection[]): DevelopClip {
  const chosen = COPY_SECTIONS.filter((s) => sections.includes(s));
  let settings = applySections(source, createDevelop(), chosen);
  const geometry = { ...settings.geometry };
  if (chosen.includes('crop')) geometry.crop = structuredClone(source.geometry.crop);
  if (chosen.includes('transform')) {
    geometry.upright = structuredClone(source.geometry.upright);
    geometry.transform = { ...source.geometry.transform };
  }
  settings = { ...settings, geometry };
  if (chosen.includes('masks')) settings.masks = structuredClone(source.masks);
  return { version: DEVELOP_CLIP_VERSION, sections: chosen, settings };
}

/** The clipboard text for `sections` of `settings`. */
export function encode(settings: DevelopSettings, sections: readonly DevelopCopySection[]): string {
  return JSON.stringify({ type: DEVELOP_CLIP_TYPE, ...clipOf(settings, sections) });
}

/** The clip in clipboard text, or null for anything else (other text, other JSON, a payload this build cannot read). */
export function decode(text: string): DevelopClip | null {
  const decoded = decodeClip(text);
  return decoded.kind === 'clip' ? decoded.clip : null;
}

/** Clipboard text classified (`DecodedClip`). */
export function decodeClip(text: string): DecodedClip {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return { kind: 'foreign' };
  if (trimmed.length > MAX_CLIP_CHARS) {
    // Too long to parse; the type sits near the start of a payload we wrote.
    return trimmed.slice(0, 200).includes(DEVELOP_CLIP_TYPE)
      ? { kind: 'unreadable', reason: 'size' }
      : { kind: 'foreign' };
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { kind: 'foreign' };
  }
  if (!json || typeof json !== 'object' || (json as { type?: unknown }).type !== DEVELOP_CLIP_TYPE) {
    return { kind: 'foreign' };
  }
  if ((json as { version?: unknown }).version !== DEVELOP_CLIP_VERSION)
    return { kind: 'unreadable', reason: 'version' };
  if (tooBig((json as { settings?: unknown }).settings)) return { kind: 'unreadable', reason: 'size' };
  const parsed = DevelopClipSchema.safeParse(json);
  if (!parsed.success) return { kind: 'unreadable', reason: 'invalid' };
  const { sections, settings } = parsed.data;
  return { kind: 'clip', clip: { version: DEVELOP_CLIP_VERSION, sections, settings } };
}

/** More masks than `MAX_CLIP_MASKS` or brush points than `MAX_CLIP_POINTS` in raw (unvalidated) settings. */
function tooBig(settings: unknown): boolean {
  const masks = (settings as { masks?: unknown } | null)?.masks;
  if (!Array.isArray(masks)) return false;
  if (masks.length > MAX_CLIP_MASKS) return true;
  let points = 0;
  for (const mask of masks) {
    const components = (mask as { components?: unknown } | null)?.components;
    if (!Array.isArray(components)) continue;
    for (const component of components) {
      const strokes = (component as { strokes?: unknown } | null)?.strokes;
      if (!Array.isArray(strokes)) continue;
      for (const stroke of strokes) {
        const list = (stroke as { points?: unknown } | null)?.points;
        if (Array.isArray(list)) points += list.length;
        if (points > MAX_CLIP_POINTS) return true;
      }
    }
  }
  return false;
}

/** The photo before `current` in `refs` (the strip or grid order as shown), or null for the first or an unlisted one. */
export function previousOf(refs: readonly string[], current: string): string | null {
  const at = refs.indexOf(current);
  return at > 0 ? (refs[at - 1] ?? null) : null;
}
