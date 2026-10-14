import type { Brief } from '../schema.js';

/**
 * Workflow plan 34 (WORKFLOW_PLAN 12.2): the fixed system block of every caption request. The Editorial style sheet is
 * a constant; the brief and the photo index are appended by {@link buildSystem}. The result is cached by the API for an
 * hour, so it must be byte-identical across a book's requests: it is a pure function of the brief, the index text and
 * the example captions, with every field put on one line and nothing time- or request-dependent in it (the element,
 * page and fix-up instructions go in the request's `prompt`).
 */

/** The voices of the brief, in the order the dialog offers them. */
export const CAPTION_VOICES = ['editorial', 'diary', 'minimal', 'playful'] as const satisfies readonly Brief['voice'][];
export type CaptionVoice = Brief['voice'];

export const VOICE_LABELS: Record<CaptionVoice, string> = {
  editorial: 'Editorial',
  diary: 'Diary',
  minimal: 'Minimal',
  playful: 'Playful',
};

/** One line under each voice in the brief dialog. */
export const VOICE_HINTS: Record<CaptionVoice, string> = {
  editorial: 'Present tense, concrete, one or two sentences.',
  diary: 'First person, like a travel journal.',
  minimal: 'One short line or a fragment.',
  playful: 'A light, wry touch; still no exclamation marks.',
};

/** What the model is and who it writes for. */
export const CAPTION_ROLE =
  'You write captions for a photo book that is printed and published online. Each request shows one or more photos, ' +
  'each after its label ("Photo N", the number it has in the photo index below), and says which text box to write ' +
  'for. Write in English unless the brief is written in another language; then write in that language.';

/** The Editorial style sheet: the default voice, and the base every other voice adjusts. */
export const EDITORIAL_STYLE = [
  'Style sheet (Editorial):',
  '- Present tense.',
  '- Concrete nouns and plain verbs; no abstractions, no clichés.',
  '- One or two sentences, 12 to 30 words in all, unless the request asks for another length.',
  '- Name the place and the time when they are known from the brief or the photo index; never invent them.',
  '- No exclamation marks, no hashtags, no emoji, no superlatives.',
  '- Do not restate what is obvious in the picture; add what the photo cannot say on its own.',
  '- Name only the people listed in the brief. Anyone else stays unnamed ("a woman", "our host").',
  '- Variants differ in angle (what is happening / where we are / a detail), never in tone.',
].join('\n');

/** How each voice adjusts the style sheet. */
export const VOICE_NOTES: Record<CaptionVoice, string> = {
  editorial: 'Voice: Editorial. Follow the style sheet as written.',
  diary:
    'Voice: Diary. Follow the style sheet, but write as the photographer keeping a journal, in the first person ' +
    '(as the brief says to refer to them), still in the present tense.',
  minimal:
    'Voice: Minimal. Follow the style sheet, but keep each caption to one short sentence or a fragment of 4 to 12 ' +
    'words.',
  playful:
    'Voice: Playful. Follow the style sheet with a light, wry touch; still no exclamation marks, emoji or puns that ' +
    'need explaining.',
};

/** Alt text rules, the same for every voice. */
export const ALT_RULES =
  'Alt text: one plain sentence for screen readers, at most 125 characters, saying what is visible in the photo the ' +
  'caption is about (people, place, light, action). No "image of" or "photo of", no names unless the brief lists ' +
  'them, no interpretation.';

/** The answer's shape, said once in the cached block (the output schema is constant too). */
export const OUTPUT_RULES =
  'Answer with captions only. Each has a target (one of the targets the request names), the caption text, and the ' +
  'alt text of the photo it is about. Write no notes, quotes around the text or explanations.';

/** One line: newlines and runs of spaces become single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The brief as the system block's section (fields on one line each; empty fields left out). */
export function briefSection(brief: Brief, existing: readonly string[] = []): string {
  const lines = ['Project brief (from the author):', `- About: ${oneLine(brief.about)}`];
  const photographer = oneLine(brief.photographer);
  if (photographer) lines.push(`- Photographer, and how to refer to them: ${photographer}`);
  const placeTime = oneLine(brief.placeTime);
  if (placeTime) lines.push(`- Place and time: ${placeTime}`);
  const people = brief.people.map(oneLine).filter(Boolean);
  lines.push(
    people.length > 0
      ? `- People who may be named: ${people.join(', ')}. Anyone else stays unnamed.`
      : '- People: name no one; describe people without names.',
  );
  const avoid = oneLine(brief.avoid);
  if (avoid) lines.push(`- Avoid: ${avoid}`);
  const examples = [...brief.examples, ...existing].map(oneLine).filter(Boolean);
  const unique = [...new Set(examples)];
  if (unique.length > 0) {
    lines.push('Example captions in the author’s own words (match their voice and length, not their content):');
    for (const example of unique) lines.push(`- ${example}`);
  }
  return lines.join('\n');
}

export interface BuildSystemOptions {
  /**
   * The book's own captions to add to the examples (the brief's `useExisting`; see `existingCaptions`). Ignored when
   * `brief.useExisting` is false.
   */
  existing?: readonly string[];
}

/**
 * The system block of a caption request: role, style sheet, voice, alt and output rules, the brief, then the photo
 * index (`indexText`; left out when empty). Deterministic: the same inputs give the same bytes.
 */
export function buildSystem(brief: Brief, index: string, options: BuildSystemOptions = {}): string {
  const existing = brief.useExisting ? (options.existing ?? []) : [];
  const parts = [
    CAPTION_ROLE,
    EDITORIAL_STYLE,
    VOICE_NOTES[brief.voice],
    ALT_RULES,
    OUTPUT_RULES,
    briefSection(brief, existing),
  ];
  const photos = index.trim();
  if (photos) parts.push(photos);
  return parts.join('\n\n');
}
