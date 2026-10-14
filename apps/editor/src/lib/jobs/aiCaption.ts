import {
  attemptsCost,
  type Book,
  type BookTemplate,
  briefReady,
  buildSystem,
  existingCaptions,
  type Frame,
  indexEntries,
  indexText,
  locatePage,
  normalizeAlt,
  OUTPUT_KIND_LABELS,
  type Page,
  ALT_MAX as SHARED_ALT_MAX,
  type TextElement,
} from '@photobook/shared';
import { captionPage, nextAiJob } from '../../store/ai';
import { type AssetFile, currentDeveloped, fileOfAsset } from '../../store/assets';
import { enqueue, JobCancelled, useJobsStore } from '../../store/jobs';
import { assetDevelop, assetFolderPath, type LibraryView } from '../../store/library';
import { devLog } from '../log';
import { basename } from '../path';
import { type AiCaptionRequest, type AiImageRef, aiCancel } from '../tauri';

/**
 * Workflow plan 34: the Element scope of AI captions. One text box gets three captions that differ in angle (what is
 * happening, where we are, a detail), each with the alt text of the photo it is about. The request carries the cached
 * system block (`buildSystem`: the Editorial style sheet, the project's brief, the photo index of the book's placed
 * photos) and, per request, the photos and the instructions (`prompt`). The photo is the one the text box belongs to
 * (`captionSubject`), or the page's photos when it sits between several; each is sent as its cached proxy by hash and
 * the develop hash on screen, labelled with its number in the index. A fix-up chip (Shorter, More specific, Different
 * angle) asks again with a short instruction and the previous captions.
 *
 * `requestElementCaptions` queues the request as an `ai` job (one at a time with Describe photos and the book
 * captions); `cancel()` stops it, through `ai_cancel` when it is running. It never rejects.
 */

/** The three angles, as the request's targets, in the order the cards show them. */
export const CAPTION_ANGLES = ['what', 'where', 'detail'] as const;
export type CaptionAngle = (typeof CAPTION_ANGLES)[number];

export const ANGLE_LABELS: Record<CaptionAngle, string> = {
  what: 'What is happening',
  where: 'Where we are',
  detail: 'A detail',
};

/** The fix-up chips. */
export const CAPTION_FIXES = ['shorter', 'specific', 'angle'] as const;
export type CaptionFix = (typeof CAPTION_FIXES)[number];

export const FIX_LABELS: Record<CaptionFix, string> = {
  shorter: 'Shorter',
  specific: 'More specific',
  angle: 'Different angle',
};

/** The short instruction each chip adds to the request. */
export const FIX_INSTRUCTIONS: Record<CaptionFix, string> = {
  shorter: 'Make each caption clearly shorter than the previous ones, about half the words, keeping its angle.',
  specific:
    'Make each caption more specific than the previous ones: concrete places, things and times from the brief and ' +
    'the photo index, fewer general words.',
  angle: 'Find new angles, different from the previous captions; still one caption per target.',
};

/** Photos sent at most when the text box sits between several. */
export const MAX_PAGE_PHOTOS = 6;
/** A text box this close to one photo (fraction of the page width) is that photo's caption... */
const NEAR = 0.08;
/** ...when every other photo is at least this much further away. */
const MARGIN = 0.02;

/** What a text box is about. */
export interface CaptionSubject {
  /** The photos of the page (asset ids: the background first, then the photo elements in page order), unique. */
  photos: string[];
  /** The photo the text box is nearest to, or null when the page has none. */
  subject: string | null;
  /** True when the text box belongs to `subject` alone (only that photo is sent). */
  one: boolean;
}

/** Gap between two frames (0 when they touch or overlap), in page widths: `aspect` is the page's height / width. */
function gap(a: Frame, b: Frame, aspect: number): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)) * aspect;
  return Math.hypot(dx, dy);
}

/**
 * The photo text element `elementId` of `page` belongs to: the nearest photo element (by the gap between frames), or
 * the background photo on a page without photo elements. It is the only one sent (`one`) when the page has one photo,
 * or when the text box is within 0.08 of the page width of it and the others are clearly further away.
 */
export function captionSubject(
  page: Page,
  elementId: string,
  template: Pick<BookTemplate, 'width' | 'height'>,
): CaptionSubject {
  const text = page.elements.find((e) => e.id === elementId);
  const background = typeof page.background === 'object' ? page.background.asset : null;
  const slots = page.elements.filter((e) => e.type === 'photo' && e.asset !== null);
  const photos = [
    ...new Set([...(background ? [background] : []), ...slots.map((e) => (e.type === 'photo' ? e.asset : null))]),
  ].filter((id): id is string => typeof id === 'string');
  if (photos.length === 0) return { photos, subject: null, one: false };
  if (!text || slots.length === 0) return { photos, subject: photos[0] as string, one: photos.length === 1 };
  const aspect = template.height / template.width;
  const ranked = slots
    .map((e) => ({ id: e.type === 'photo' ? (e.asset as string) : '', gap: gap(text.frame, e.frame, aspect) }))
    .sort((a, b) => a.gap - b.gap);
  const nearest = ranked[0] as { id: string; gap: number };
  const others = ranked.filter((r) => r.id !== nearest.id);
  const one =
    photos.length === 1 ||
    (nearest.gap <= NEAR && others.every((r) => r.gap >= 2 * nearest.gap + MARGIN) && !background);
  return { photos, subject: nearest.id, one };
}

/** A caption the model wrote. */
export interface CaptionVariant {
  angle: string;
  text: string;
  /** Alt text of the subject photo ('' when the page has none). */
  alt: string;
}

/** A request for one text box, ready to queue. */
export interface ElementCaptionPlan {
  request: AiCaptionRequest;
  /** The photo the alt text is for (`writeCaption`), or null. */
  subject: string | null;
  /** Asset ids of the photos sent. */
  sent: string[];
  /** File names of the photos sent, by asset id (an error naming an id names the file instead). */
  names: Record<string, string>;
  /** The open project (closing it cancels the job). */
  project: string | null;
}

export interface ElementCaptionOptions {
  fix?: CaptionFix;
  /** The captions shown before a fix-up: the model is told not to repeat them. */
  previous?: readonly string[];
}

/** What the plan reads from the stores: the book store's view plus the assets store's files. */
export interface CaptionView extends LibraryView {
  projectId: string | null;
  files: Record<string, AssetFile>;
}

const STYLE_HINTS: Record<TextElement['style'], string> = {
  caption: 'a photo caption: follow the style sheet.',
  body: 'a short passage of two to four sentences.',
  quote: 'a pull quote: one line of at most 20 words.',
  title: 'a title of 2 to 6 words, without a full stop.',
  date: 'a date or place line of a few words, without a full stop.',
};

const quoted = (text: string): string => `"${text.replace(/\s+/g, ' ').trim()}"`;

/** Where the text box is, for the prompt: "page 4 of the book", "frame 2 of the social post "Carousel"". */
function placeOf(book: Book, pageId: string): string {
  const at = locatePage(book, pageId);
  if (!at) return 'a page of the book';
  const output = book.outputs.find((o) => o.id === at.outputId);
  if (!output) return `page ${at.index + 1} of the book`;
  return `frame ${at.index + 1} of the ${OUTPUT_KIND_LABELS[output.kind].toLowerCase()} ${quoted(output.name)}`;
}

/**
 * The request for text element `elementId` on page `pageId` (a book page or an output's frame), or an error message
 * when it cannot be made (no brief, no such element).
 */
export function planElementCaption(
  view: CaptionView,
  pageId: string,
  elementId: string,
  options: ElementCaptionOptions = {},
): ElementCaptionPlan | { error: string } {
  const book = view.book;
  const brief = book?.captions.brief;
  if (!book || !briefReady(brief)) return { error: 'Write the caption brief first.' };
  const at = locatePage(book, pageId);
  const page = at?.pages[at.index];
  const element = page?.elements.find((e) => e.id === elementId);
  if (!at || !page || element?.type !== 'text') return { error: 'This text box is gone.' };

  const { photos, subject, one } = captionSubject(page, elementId, at.template);
  const sent = photosToSend(photos, subject, one).filter((id) => book.assets[id]?.hash);
  const libraryOf = (asset: Book['assets'][string]) => {
    const folder = assetFolderPath(book, asset, view.folder);
    return folder ? view.libraries[folder] : undefined;
  };
  // Book-wide `Photo N` numbers: the placed photos, then the ones only this page (an output's frame) shows.
  const entries = indexEntries(book, libraryOf, { scope: 'placed', include: photos });
  const numberOf = new Map(entries.map((e) => [e.assetId, e.n]));
  const label = (id: string) => `Photo ${numberOf.get(id) ?? '?'}`;
  const index = entries.some((e) => e.ai) ? indexText(book, libraryOf, { scope: 'placed', include: photos }) : '';
  // The box being written is never its own example, so Use does not change the block for its next request.
  const system = buildSystem(brief, index, { existing: existingCaptions(book, undefined, elementId) });

  const images: AiImageRef[] = sent.map((id) => {
    const asset = book.assets[id];
    const developed = currentDeveloped(fileOfAsset(view.files, id), assetDevelop(view, id), book.outputProfile);
    return {
      id,
      kind: 'photo',
      hash: asset?.hash as string,
      developHash: developed?.developHash ?? null,
      label: label(id),
    };
  });

  const lines = [`Write three captions for one text box on ${placeOf(book, pageId)}.`];
  lines.push(`The text box is ${STYLE_HINTS[element.style]}`);
  if (!subject) {
    lines.push('The page has no photos: write from the brief and the photo index, and leave alt empty.');
  } else if (images.length === 0) {
    lines.push(`It is about ${label(subject)}, which has no preview to show yet: use its line in the photo index.`);
  } else if (one) {
    lines.push(`It is about ${label(subject)}, shown above.`);
  } else {
    lines.push(
      `The page's photos are shown above. The text box sits nearest ${label(subject)}: write about it, using the ` +
        'other photos for context.',
    );
  }
  lines.push(
    element.text.trim() ? `The text box now reads: ${quoted(element.text)}` : 'The text box is empty for now.',
  );
  lines.push(
    'Write one caption for each target, in this order: what (what is happening), where (where we are), detail (a ' +
      'detail). They are alternatives that differ in angle, not in tone.',
  );
  if (subject) lines.push(`Give each caption the alt text of ${label(subject)}.`);
  if (options.fix) lines.push(FIX_INSTRUCTIONS[options.fix]);
  const previous = (options.previous ?? []).map((p) => p.trim()).filter(Boolean);
  if (previous.length > 0) {
    lines.push('Previous captions (do not repeat them):');
    for (const p of previous) lines.push(`- ${quoted(p)}`);
  }

  return {
    request: { images, system, prompt: lines.join('\n'), targets: [...CAPTION_ANGLES] },
    subject,
    sent,
    names: Object.fromEntries(sent.map((id) => [id, basename(book.assets[id]?.path ?? id)])),
    project: view.projectId,
  };
}

/**
 * The photos a request sends: the subject alone when the text box is its caption (`one`), else up to
 * `MAX_PAGE_PHOTOS` of the page's photos that always include the subject, in page order.
 */
export function photosToSend(photos: readonly string[], subject: string | null, one: boolean): string[] {
  if (one && subject) return [subject];
  const chosen = new Set([...new Set([...(subject ? [subject] : []), ...photos])].slice(0, MAX_PAGE_PHOTOS));
  return photos.filter((id) => chosen.has(id));
}

/** Quote pairs a model may wrap a whole caption in, and the characters that must not appear inside to strip them. */
const QUOTE_PAIRS: ReadonlyArray<[string, string, RegExp]> = [
  ['"', '"', /"/],
  ['\u201c', '\u201d', /[\u201c\u201d]/],
  ["'", "'", /'/],
  ['\u2018', '\u2019', /[\u2018\u2019]/],
];

/**
 * Strip a pair of quotes the model wrapped a whole caption in, and spaces. Only when no quote of the same kind is
 * inside: `"Never again," she said. "Not here."` is a caption that quotes, and stays as it is.
 */
export function cleanCaption(text: string): string {
  const trimmed = text.trim();
  for (const [open, close, inner] of QUOTE_PAIRS) {
    if (trimmed.length < 2 || !trimmed.startsWith(open) || !trimmed.endsWith(close)) continue;
    const body = trimmed.slice(open.length, trimmed.length - close.length);
    return inner.test(body) ? trimmed : body.trim();
  }
  return trimmed;
}

/** Alt text is one sentence for screen readers: at most this many characters (cut at a word; shared, plan 35). */
export const ALT_MAX = SHARED_ALT_MAX;

/** `alt` trimmed and cut to {@link ALT_MAX} characters at a word boundary (`normalizeAlt`, shared with publishing). */
export function capAlt(alt: string): string {
  return normalizeAlt(alt);
}

/** The answer's captions as up to three variants: one per angle in angle order, then any repeats. */
export function toVariants(captions: readonly { target: string; text: string; alt: string }[]): CaptionVariant[] {
  const clean = captions
    .map((c) => ({ angle: c.target, text: cleanCaption(c.text), alt: capAlt(c.alt) }))
    .filter((c) => c.text.length > 0);
  const first: CaptionVariant[] = [];
  for (const angle of CAPTION_ANGLES) {
    const hit = clean.find((c) => c.angle === angle);
    if (hit) first.push(hit);
  }
  const rest = clean.filter((c) => !first.includes(c));
  return [...first, ...rest].slice(0, 3);
}

export type ElementCaptionResult =
  | { status: 'ok'; variants: CaptionVariant[]; model: string; servedBy: string; fellBack: boolean; usd: number }
  | { status: 'refused'; message: string; usd: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface ElementCaptionHandle {
  /** The `ai` job. */
  jobId: string;
  /** Stop it (dequeued, or `ai_cancel` on the request in flight); the result resolves `cancelled`. */
  cancel: () => void;
  result: Promise<ElementCaptionResult>;
}

/** `message` with each sent photo's asset id replaced by its file name ("No preview yet for IMG_1.jpg; ..."). */
export function withFileNames(message: string, names: Readonly<Record<string, string>>): string {
  let out = message;
  for (const [id, name] of Object.entries(names)) out = out.split(id).join(name);
  return out;
}

/** The `ref` of caption jobs. */
export const CAPTION_JOB_REF = 'caption-element';

/** Queue `plan` as an `ai` job. */
export function requestElementCaptions(plan: ElementCaptionPlan): ElementCaptionHandle {
  const handle = enqueue({
    kind: 'ai',
    label: 'Write a caption',
    ref: CAPTION_JOB_REF,
    project: plan.project,
    run: async (ctx) => {
      if (ctx.cancelled) throw new JobCancelled();
      const job = nextAiJob();
      ctx.onCancel(() => aiCancel(job));
      ctx.progress(0, 1, plan.sent.length === 1 ? '1 photo' : `${plan.sent.length} photos`);
      devLog('ai', 'caption request', { photos: plan.sent.length, fix: plan.request.prompt.includes('Previous') });
      const outcome = await captionPage(plan.request, job);
      if (outcome.status === 'cancelled') throw new JobCancelled();
      ctx.progress(1, 1);
      return outcome;
    },
  });
  const result = handle.result.then((outcome): ElementCaptionResult => {
    if (outcome.state === 'cancelled') return { status: 'cancelled' };
    if (outcome.state === 'failed') return { status: 'error', message: withFileNames(outcome.error, plan.names) };
    const answer = outcome.value;
    const usd = attemptsCost(answer.attempts).usd;
    if (answer.status === 'refused') {
      devLog('ai', 'caption refused', { reason: answer.reason });
      return { status: 'refused', message: answer.message, usd };
    }
    const variants = toVariants(answer.captions);
    devLog('ai', 'caption done', { variants: variants.length, servedBy: answer.servedBy, usd: Number(usd.toFixed(4)) });
    if (variants.length === 0) return { status: 'error', message: 'The model wrote no caption. Try again.' };
    return {
      status: 'ok',
      variants,
      model: answer.model,
      servedBy: answer.servedBy,
      fellBack: answer.fellBack,
      usd,
    };
  });
  return { jobId: handle.id, cancel: () => useJobsStore.getState().cancel(handle.id), result };
}
