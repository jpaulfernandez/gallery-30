import { z } from 'zod';
import { type Book, type Brief, BriefSchema } from '../schema.js';

/**
 * Workflow plan 34: the caption brief (`book.captions.brief`) as the dialog edits it. The stored schema
 * (`BriefSchema`, plan 03) stays lenient so a hand-edited file never fails to open; {@link validateBrief} is what the
 * dialog saves through: `about` is required, every text is trimmed and capped, people and examples lose blank entries.
 */

export const BRIEF_LIMITS = {
  about: 600,
  photographer: 200,
  placeTime: 200,
  person: 80,
  people: 30,
  avoid: 300,
  example: 400,
  /** Example captions the author writes in the dialog. */
  examples: 3,
} as const;

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} is too long (at most ${max} characters)` })
    .default('');

const nonEmpty = (list: string[]) => list.filter((item) => item.length > 0);

/** The brief as the dialog saves it. */
export const BriefInputSchema = z.object({
  about: z
    .string()
    .trim()
    .min(1, { error: 'Say what the book is about' })
    .max(BRIEF_LIMITS.about, { error: `At most ${BRIEF_LIMITS.about} characters` }),
  photographer: text(BRIEF_LIMITS.photographer, 'Photographer'),
  placeTime: text(BRIEF_LIMITS.placeTime, 'Place and time'),
  people: z
    .array(
      z
        .string()
        .trim()
        .max(BRIEF_LIMITS.person, { error: `A name is at most ${BRIEF_LIMITS.person} characters` }),
    )
    .default([])
    .transform((list) => [...new Set(nonEmpty(list))])
    .pipe(z.array(z.string()).max(BRIEF_LIMITS.people, { error: `At most ${BRIEF_LIMITS.people} names` })),
  voice: BriefSchema.shape.voice,
  avoid: text(BRIEF_LIMITS.avoid, 'Avoid'),
  examples: z
    .array(
      z
        .string()
        .trim()
        .max(BRIEF_LIMITS.example, { error: `An example is at most ${BRIEF_LIMITS.example} characters` }),
    )
    .default([])
    .transform(nonEmpty)
    .pipe(z.array(z.string()).max(BRIEF_LIMITS.examples, { error: `At most ${BRIEF_LIMITS.examples} examples` })),
  useExisting: z.boolean().default(false),
});

export type BriefInput = z.input<typeof BriefInputSchema>;

/** Field name → first message, for the dialog. */
export type BriefErrors = Partial<Record<keyof Brief, string>>;

export type BriefValidation = { ok: true; brief: Brief } | { ok: false; errors: BriefErrors };

/** Check and normalise what the dialog holds. */
export function validateBrief(input: unknown): BriefValidation {
  const result = BriefInputSchema.safeParse(input);
  if (result.success) return { ok: true, brief: result.data };
  const errors: BriefErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof Brief | undefined;
    if (key && errors[key] === undefined) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/** Names typed as "Ana, Rui" or one per line. */
export function parsePeople(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * True when `brief` can be sent: it says what the book is about. A brief object without `about` (a hand-edited file:
 * the stored schema is lenient) counts as no brief, so the dialog opens instead of sending "- About: ".
 */
export function briefReady(brief: Pick<Brief, 'about'> | undefined | null): brief is Brief {
  return typeof brief?.about === 'string' && brief.about.trim().length > 0;
}

/** A new brief: Editorial, `useExisting` on when the book already has captions. */
export function emptyBrief(useExisting = false): Brief {
  return {
    about: '',
    photographer: '',
    placeTime: '',
    people: [],
    voice: 'editorial',
    avoid: '',
    examples: [],
    useExisting,
  };
}

/** Text styles whose elements count as captions (titles and dates are too short to show a voice). */
const CAPTION_STYLES = new Set(['caption', 'body', 'quote']);
/** Shorter texts are placeholders or labels, not examples of a voice. */
const MIN_WORDS = 4;

/**
 * The book's own captions to use as examples (`useExisting`): text elements in a caption, body or quote style with at
 * least four words, in book order, without repeats, each cut at `BRIEF_LIMITS.example` characters. Book pages only.
 * `exclude` leaves out one element (the text box being written is never its own example).
 */
export function existingCaptions(
  book: Pick<Book, 'pages'>,
  limit: number = BRIEF_LIMITS.examples,
  exclude?: string,
): string[] {
  const found: string[] = [];
  for (const page of book.pages) {
    for (const element of page.elements) {
      if (element.type !== 'text' || element.id === exclude || !CAPTION_STYLES.has(element.style)) continue;
      const value = element.text.replace(/\s+/g, ' ').trim();
      if (value.split(' ').length < MIN_WORDS || found.includes(value)) continue;
      found.push(value.slice(0, BRIEF_LIMITS.example));
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/** True when the book has a text element that would count as a caption (offers "Use my existing captions"). */
export function hasExistingCaptions(book: Pick<Book, 'pages'>): boolean {
  return existingCaptions(book, 1).length > 0;
}

/** When and where one photo was taken, from its Exif (`photo_capture_info`). */
export interface CaptureInfo {
  /** Local capture time `YYYY-MM-DDTHH:MM:SS` (Exif has no zone), absent when unknown. */
  taken?: string | null;
  lat?: number | null;
  lon?: number | null;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `[year, month (0-11), day]` of a capture time, or null when it does not parse. */
function dayOf(taken: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(taken);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (y < 1900 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return [y, mo, d];
}

/** "June 3, 2026", "June 3–9, 2026", "May 30 – June 2, 2026", "December 30, 2025 – January 2, 2026". */
export function dateRangeText(first: [number, number, number], last: [number, number, number]): string {
  const [y1, m1, d1] = first;
  const [y2, m2, d2] = last;
  if (y1 !== y2) return `${MONTHS[m1]} ${d1}, ${y1} – ${MONTHS[m2]} ${d2}, ${y2}`;
  if (m1 !== m2) return `${MONTHS[m1]} ${d1} – ${MONTHS[m2]} ${d2}, ${y1}`;
  if (d1 !== d2) return `${MONTHS[m1]} ${d1}–${d2}, ${y1}`;
  return `${MONTHS[m1]} ${d1}, ${y1}`;
}

/** "38.71° N, 9.14° W". */
export function coordinatesText(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * The brief's "Where and when?" pre-fill from the photos' Exif: the date range of their capture times and the median
 * of their GPS positions ("June 3–9, 2026; near 38.71° N, 9.14° W"). Empty when no photo has either. Coordinates, not
 * a place name: nothing is looked up, and the author edits the line before it is sent anywhere. `coordinates: false`
 * gives the dates alone (what the dialog saves when the author leaves the pre-fill untouched).
 */
export function captureSummary(infos: readonly CaptureInfo[], options: { coordinates?: boolean } = {}): string {
  const days = infos
    .map((info) => (info.taken ? dayOf(info.taken) : null))
    .filter((d): d is [number, number, number] => d !== null)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const spots = infos.filter(
    (info): info is CaptureInfo & { lat: number; lon: number } =>
      typeof info.lat === 'number' &&
      typeof info.lon === 'number' &&
      Number.isFinite(info.lat) &&
      Number.isFinite(info.lon) &&
      Math.abs(info.lat) <= 90 &&
      Math.abs(info.lon) <= 180 &&
      !(info.lat === 0 && info.lon === 0),
  );
  const parts: string[] = [];
  const first = days[0];
  const last = days[days.length - 1];
  if (first && last) parts.push(dateRangeText(first, last));
  if (spots.length > 0 && options.coordinates !== false) {
    parts.push(`near ${coordinatesText(median(spots.map((s) => s.lat)), median(spots.map((s) => s.lon)))}`);
  }
  return parts.join('; ');
}
