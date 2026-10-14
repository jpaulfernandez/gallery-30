import {
  type AiModel,
  type AiUsage,
  attemptsCost,
  type Book,
  briefReady,
  buildSystem,
  existingCaptions,
  fitLongEdge,
  indexEntries,
  indexText,
  locatePage,
  OUTPUT_KIND_LABELS,
} from '@photobook/shared';
import { captionPage, nextAiJob } from '../../store/ai';
import { currentDeveloped, fileOfAsset } from '../../store/assets';
import { enqueue, JobCancelled, useJobsStore } from '../../store/jobs';
import { assetDevelop, assetFolderPath } from '../../store/library';
import { type CostEstimate, estimate, roughTokens } from '../ai/cost';
import { captionSlots, type PageCaption, pagePhotoIds } from '../ai/placeCaptions';
import { devLog } from '../log';
import { basename } from '../path';
import { type AiCaptionRequest, type AiImageRef, aiCancel } from '../tauri';
import { type CaptionView, capAlt, cleanCaption, withFileNames } from './aiCaption';

/**
 * Workflow plan 35: the Page scope of AI captions, and the per-page request the Book scope repeats. One request per
 * page: the cached system block (`buildSystem`: style sheet, brief, the photo index of the book's placed photos) plus
 * the page's photos as their proxies (plan 14 renders pages with the CLI's Chromium only, so there is no in-app page
 * render to send; the proxies are smaller the more photos a page has, so a page costs about what one 1080 px render
 * would), labelled with their index numbers. The answer is one caption per photo (`photo`) or one for the page
 * (`page`), plus the alt text of every photo either way. Nothing is placed here: the sheet and the book dialog show the
 * captions for review and `applyCaptions` places the accepted ones.
 */

/** One caption per photo, or one caption for the whole page. */
export type CaptionMode = 'photo' | 'page';

/** The target of the page caption (`page` mode); photo captions target their `Photo N` label. */
export const PAGE_TARGET = 'page';

/** Images per request at most (`ai_caption` takes up to 20). */
export const MAX_PAGE_IMAGES = 20;

/** Uncached text of one page request (the instructions and labels), for the estimate. */
export const PAGE_TEXT_TOKENS = 200;

/**
 * Output limit of a page request (thinking included). Page captions run at effort `low`: the style sheet, brief and
 * index do the work, and a page's answer is a few short captions as JSON.
 */
export const PAGE_MAX_TOKENS = 4096;

/**
 * Output tokens assumed per page request, for the estimate: 400 plus 60 per photo (the JSON and `low`-effort thinking).
 * A rough guide only, not measured against the API yet; the real usage of every answer is added up as it comes.
 */
export function pageOutputTokens(photos: number): number {
  return 400 + 60 * photos;
}

/** Size assumed for a photo whose size is not known yet (a 3:2 proxy). */
const DEFAULT_SIZE = { width: 1600, height: 1067 };

/** Long edge the page's photos are sent at: 768 px alone, 640 px for two, 512 px for three or more. */
export function sendEdge(photos: number): number {
  if (photos <= 1) return 768;
  return photos === 2 ? 640 : 512;
}

/**
 * The mode a page suits: one caption per photo when it has two photos or more and as many caption slots as that
 * (a layout with a caption for each photo), else one caption for the page.
 */
export function defaultCaptionMode(page: Pick<Book['pages'][number], 'elements' | 'background'>): CaptionMode {
  const photos = pagePhotoIds(page).length;
  return photos >= 2 && captionSlots(page).length >= photos ? 'photo' : 'page';
}

/** The library of an asset in `view` (its folder's), for the index. */
function libraryOf(view: CaptionView) {
  const book = view.book as Book;
  return (asset: Book['assets'][string]) => {
    const folder = assetFolderPath(book, asset, view.folder);
    return folder ? view.libraries[folder] : undefined;
  };
}

/**
 * The system block of the book's caption requests: byte-identical for every page of a run (the Book scope computes it
 * once, after the index step), so each request after the first reads it from the cache. `include` lists photos on no
 * book page (an output's frame) in the index. Empty string without a brief.
 */
export function captionSystem(view: CaptionView, include: readonly string[] = []): string {
  const book = view.book;
  const brief = book?.captions.brief;
  if (!book || !briefReady(brief)) return '';
  const library = libraryOf(view);
  const entries = indexEntries(book, library, { scope: 'placed', include });
  const index = entries.some((e) => e.ai) ? indexText(book, library, { scope: 'placed', include }) : '';
  return buildSystem(brief, index, { existing: existingCaptions(book) });
}

/** A photo of the page as the request names it. */
export interface PagePhoto {
  assetId: string;
  /** `Photo N`: its number in the photo index (the request's target for it). */
  label: string;
  /** File name. */
  name: string;
}

/** A request for one page, ready to queue. */
export interface PageCaptionPlan {
  pageId: string;
  mode: CaptionMode;
  request: AiCaptionRequest;
  /** The page's photos (those with a content hash), in page order. */
  photos: PagePhoto[];
  /** File names by asset id (an error naming an id names the file instead). */
  names: Record<string, string>;
  /** The open project (closing it cancels the job). */
  project: string | null;
  /** "page 4 of the book", for labels. */
  place: string;
  /** 1-based page number in its document. */
  number: number;
  /** Photos of the page not sent: not read yet (no content hash), or beyond `MAX_PAGE_IMAGES`. The review says so. */
  notSent: number;
}

const quoted = (text: string): string => `"${text.replace(/\s+/g, ' ').trim()}"`;

/** "page 4 of the book", "frame 2 of the social post "Carousel"". */
function placeOf(book: Book, pageId: string): { place: string; number: number } {
  const at = locatePage(book, pageId);
  if (!at) return { place: 'a page of the book', number: 0 };
  const output = book.outputs.find((o) => o.id === at.outputId);
  if (!output) return { place: `page ${at.index + 1} of the book`, number: at.index + 1 };
  return {
    place: `frame ${at.index + 1} of the ${OUTPUT_KIND_LABELS[output.kind].toLowerCase()} ${quoted(output.name)}`,
    number: at.index + 1,
  };
}

const list = (labels: readonly string[]): string => labels.join(', ');

/**
 * The request for page `pageId` (a book page or an output's frame) in `mode`, or an error message when it cannot be
 * made. `system` is the run's block when the Book scope plans many pages (else it is built for this page).
 */
export function planPageCaption(
  view: CaptionView,
  pageId: string,
  options: { mode?: CaptionMode; system?: string } = {},
): PageCaptionPlan | { error: string } {
  const book = view.book;
  if (!book || !briefReady(book.captions.brief)) return { error: 'Write the caption brief first.' };
  const at = locatePage(book, pageId);
  const page = at?.pages[at.index];
  if (!at || !page) return { error: 'This page is gone.' };
  const ids = pagePhotoIds(page);
  if (ids.length === 0) return { error: 'This page has no photos to caption.' };
  const ready = ids.filter((id) => book.assets[id]?.hash);
  const hashed = ready.slice(0, MAX_PAGE_IMAGES);
  if (hashed.length === 0) return { error: 'The photos on this page are not ready yet (still being read).' };

  const mode = options.mode ?? defaultCaptionMode(page);
  const entries = indexEntries(book, libraryOf(view), { scope: 'placed', include: ids });
  const numberOf = new Map(entries.map((e) => [e.assetId, e.n]));
  const photos: PagePhoto[] = hashed.map((assetId, i) => {
    const n = numberOf.get(assetId);
    return {
      assetId,
      label: n === undefined ? `Photo P${i + 1}` : `Photo ${n}`,
      name: basename(book.assets[assetId]?.path ?? assetId),
    };
  });
  const system = options.system ?? captionSystem(view, ids);

  const images: AiImageRef[] = photos.map(({ assetId, label }) => {
    const asset = book.assets[assetId];
    const developed = currentDeveloped(
      fileOfAsset(view.files, assetId),
      assetDevelop(view, assetId),
      book.outputProfile,
    );
    return {
      id: assetId,
      kind: 'photo',
      hash: asset?.hash as string,
      developHash: developed?.developHash ?? null,
      label,
    };
  });

  const { place, number } = placeOf(book, pageId);
  const labels = photos.map((p) => p.label);
  const lines = [
    `Caption ${place}. ${photos.length === 1 ? 'Its photo is' : 'Its photos are'} shown above, in page order: ${list(labels)}.`,
  ];
  if (mode === 'photo') {
    lines.push(
      `Write one caption for each photo, with the photo's label as its target (${list(labels)}), each with the alt ` +
        'text of that photo. The captions sit next to their photos and read as a sequence: do not repeat yourself.',
    );
  } else {
    lines.push(
      `Write one caption for the whole page, with target "${PAGE_TARGET}" and empty alt.`,
      `Then, for each photo, add one entry with the photo's label as its target (${list(labels)}), empty text, and ` +
        'the alt text of that photo.',
    );
  }
  const current = captionSlots(page)
    .map((e) => e.text.trim())
    .filter(Boolean);
  if (current.length > 0) {
    lines.push('The page now reads (write new captions; do not repeat these):');
    for (const text of current) lines.push(`- ${quoted(text)}`);
  }

  return {
    pageId,
    mode,
    request: {
      images,
      system,
      prompt: lines.join('\n'),
      targets: mode === 'photo' ? labels : [PAGE_TARGET, ...labels],
      options: { maxEdge: sendEdge(images.length), effort: 'low', maxTokens: PAGE_MAX_TOKENS },
    },
    photos,
    names: Object.fromEntries(photos.map((p) => [p.assetId, p.name])),
    project: view.projectId,
    place,
    number,
    notSent: ids.length - hashed.length,
  };
}

/**
 * The answer as captions to place: the page caption first (`page` mode), then one entry per photo in page order with
 * its caption (`photo` mode; empty text in `page` mode) and its alt text. Repeats and unknown targets are dropped.
 */
export function toPageCaptions(
  plan: Pick<PageCaptionPlan, 'mode' | 'photos'>,
  captions: readonly { target: string; text: string; alt: string }[],
): PageCaption[] {
  let pageCaption: PageCaption | null = null;
  const byPhoto = new Map<string, PageCaption>();
  const idOf = new Map(plan.photos.map((p) => [p.label, p.assetId]));
  for (const c of captions) {
    const text = cleanCaption(c.text);
    if (c.target === PAGE_TARGET) {
      if (plan.mode === 'page' && !pageCaption && text) pageCaption = { assetId: null, text };
      continue;
    }
    const assetId = idOf.get(c.target);
    if (!assetId || byPhoto.has(assetId)) continue;
    const alt = capAlt(c.alt);
    byPhoto.set(assetId, { assetId, text: plan.mode === 'photo' ? text : '', ...(alt ? { alt } : {}) });
  }
  const photos = plan.photos.flatMap((p) => {
    const caption = byPhoto.get(p.assetId);
    return caption ? [caption] : [];
  });
  return pageCaption ? [pageCaption, ...photos] : photos;
}

export type PageCaptionResult =
  | {
      status: 'ok';
      captions: PageCaption[];
      model: string;
      servedBy: string;
      fellBack: boolean;
      usd: number;
      usage: AiUsage;
    }
  | { status: 'refused'; message: string; usd: number; usage: AiUsage }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface PageCaptionHandle {
  /** The `ai` job. */
  jobId: string;
  /** Stop it (dequeued, or `ai_cancel` on the request in flight); the result resolves `cancelled`. */
  cancel: () => void;
  result: Promise<PageCaptionResult>;
}

/** The `ref` of page caption jobs. */
export const PAGE_CAPTION_JOB_REF = 'caption-page';

/** Queue `plan` as an `ai` job (one at a time with Describe photos and the other caption requests). Never rejects. */
export function requestPageCaption(plan: PageCaptionPlan): PageCaptionHandle {
  const handle = enqueue({
    kind: 'ai',
    label: `Caption ${plan.place.replace(/ of the book$/, '')}`,
    ref: PAGE_CAPTION_JOB_REF,
    project: plan.project,
    run: async (ctx) => {
      if (ctx.cancelled) throw new JobCancelled();
      const job = nextAiJob();
      ctx.onCancel(() => aiCancel(job));
      ctx.progress(0, 1, plan.photos.length === 1 ? '1 photo' : `${plan.photos.length} photos`);
      devLog('ai', 'page caption request', { page: plan.number, photos: plan.photos.length, mode: plan.mode });
      const outcome = await captionPage(plan.request, job);
      if (outcome.status === 'cancelled') throw new JobCancelled();
      ctx.progress(1, 1);
      return outcome;
    },
  });
  const result = handle.result.then((outcome): PageCaptionResult => {
    if (outcome.state === 'cancelled') return { status: 'cancelled' };
    if (outcome.state === 'failed') return { status: 'error', message: withFileNames(outcome.error, plan.names) };
    const answer = outcome.value;
    const usd = attemptsCost(answer.attempts).usd;
    if (answer.status === 'refused') {
      devLog('ai', 'page caption refused', { page: plan.number, reason: answer.reason });
      return { status: 'refused', message: answer.message, usd, usage: answer.usage };
    }
    const captions = toPageCaptions(plan, answer.captions);
    devLog('ai', 'page caption done', {
      page: plan.number,
      captions: captions.filter((c) => c.text).length,
      usd: Number(usd.toFixed(4)),
    });
    if (!captions.some((c) => c.text)) return { status: 'error', message: 'The model wrote no caption. Try again.' };
    return {
      status: 'ok',
      captions,
      model: answer.model,
      servedBy: answer.servedBy,
      fellBack: answer.fellBack,
      usd,
      usage: answer.usage,
    };
  });
  return { jobId: handle.id, cancel: () => useJobsStore.getState().cancel(handle.id), result };
}

/**
 * What captioning `pageIds` costs before it runs: each page's photos at the size they are sent, the instructions per
 * request, the system block (`system`, or its token count) written to the cache once and read by every later request,
 * and the output assumed per page (`pageOutputTokens`, a rough guide). Pages without a photo ready to send are left out.
 */
export function estimatePageCaptions(
  book: Book,
  pageIds: readonly string[],
  model: AiModel,
  system: string | number,
): CostEstimate {
  const images: { width: number; height: number }[] = [];
  let requests = 0;
  let outputTokens = 0;
  for (const pageId of pageIds) {
    const at = locatePage(book, pageId);
    const page = at?.pages[at.index];
    if (!page) continue;
    const photos = pagePhotoIds(page)
      .filter((id) => book.assets[id]?.hash)
      .slice(0, MAX_PAGE_IMAGES);
    if (photos.length === 0) continue;
    requests += 1;
    outputTokens += pageOutputTokens(photos.length);
    const edge = sendEdge(photos.length);
    for (const id of photos) {
      const asset = book.assets[id];
      images.push(fitLongEdge(asset?.width ?? DEFAULT_SIZE.width, asset?.height ?? DEFAULT_SIZE.height, edge));
    }
  }
  return estimate(images, PAGE_TEXT_TOKENS * requests, model, {
    requests: Math.max(1, requests),
    cachedTextTokens: typeof system === 'number' ? system : roughTokens(system),
    outputTokens,
    // Already fitted to each page's edge.
    maxEdge: 768,
  });
}
