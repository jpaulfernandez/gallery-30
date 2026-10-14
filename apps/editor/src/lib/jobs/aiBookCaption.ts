import { type AiUsage, addUsage, type Book, EMPTY_AI_USAGE, locatePage } from '@photobook/shared';
import { create } from 'zustand';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { type PageCaption, pageHasCaption, pagePhotoIds } from '../ai/placeCaptions';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { planIndex, runIndex } from './aiIndex';
import {
  type CaptionMode,
  captionSystem,
  defaultCaptionMode,
  type PageCaptionHandle,
  type PagePhoto,
  planPageCaption,
  requestPageCaption,
} from './aiPageCaption';

/**
 * Workflow plan 35: the Book scope of AI captions. A run describes the photos of the chosen pages first (the photo
 * index of plan 33, cached in the libraries, so only new photos are sent), builds the system block once (so every
 * page request reads it from the prompt cache), then queues one `ai` job per page. Each page becomes a row to review:
 * Accept places its captions (`applyCaptions`, one undo step per page), Edit changes them first, Skip drops them, and
 * Accept all takes every row that is ready. Nothing reaches the book until it is accepted; a page the model declines
 * (or that fails) is a row with its reason and the other pages are not affected. Cancel stops the index step and every
 * page request not answered yet; answered rows stay to review.
 */

/** Which pages a run captions: the pages without a caption yet, or every page with photos. */
export type BookCaptionScope = 'empty' | 'all';

/** The caption mode of a run: each page's own (`fit`, see `defaultCaptionMode`), or one for every page. */
export type BookCaptionModeChoice = 'fit' | CaptionMode;

/** The book pages a run would caption (ids, in book order): pages with a photo, without a caption for `empty`. */
export function bookCaptionPages(book: Pick<Book, 'pages' | 'assets'>, scope: BookCaptionScope): string[] {
  return book.pages
    .filter((page) => pagePhotoIds(page).some((id) => book.assets[id]?.hash))
    .filter((page) => scope === 'all' || !pageHasCaption(page))
    .map((page) => page.id);
}

/** The photos (asset ids) on `pageIds`, unique, in page order. */
export function photosOfPages(book: Pick<Book, 'pages'>, pageIds: readonly string[]): string[] {
  const wanted = new Set(pageIds);
  return [...new Set(book.pages.filter((p) => wanted.has(p.id)).flatMap((p) => pagePhotoIds(p)))];
}

export type BookRowState =
  /** Waiting for the index step. */
  | 'waiting'
  /** Its request is queued or running (the jobs store says which). */
  | 'queued'
  | 'ready'
  | 'refused'
  | 'error'
  | 'cancelled'
  | 'accepted'
  | 'skipped'
  /** Accepted, but the page already read exactly this: nothing changed. */
  | 'unchanged';

export interface BookCaptionRow {
  pageId: string;
  /** 1-based page number. */
  number: number;
  mode: CaptionMode;
  state: BookRowState;
  jobId?: string;
  photos?: PagePhoto[];
  captions?: PageCaption[];
  /** The refusal or error. */
  message?: string;
  /** Photos of the page not sent (not read yet, or beyond 20). */
  notSent?: number;
}

export type BookRunStatus = 'idle' | 'indexing' | 'captioning' | 'finished';

export interface BookRunState {
  status: BookRunStatus;
  rows: BookCaptionRow[];
  /** The index step: photos sent, and its job (to cancel it). */
  index: { photos: number; jobId?: string; described?: number; message?: string } | null;
  /** A failure that stopped the run (the index step failed). */
  error: string | null;
  cancelled: boolean;
  /** Billed usage and estimated dollars of the run so far (index and captions). */
  usage: AiUsage;
  usd: number;
  /** Start a run on `pageIds` (book pages). Resolves when every request has an answer, or on cancel. */
  start: (pageIds: readonly string[], mode: BookCaptionModeChoice) => Promise<void>;
  /** Stop the index step and every request without an answer. */
  cancel: () => void;
  accept: (pageId: string) => void;
  acceptAll: () => void;
  skip: (pageId: string) => void;
  /** Replace a ready row's captions (Edit). */
  edit: (pageId: string, captions: PageCaption[]) => void;
  /** Back to idle (the dialog closed); requests still running are cancelled. */
  reset: () => void;
}

const INITIAL = {
  status: 'idle' as BookRunStatus,
  rows: [] as BookCaptionRow[],
  index: null,
  error: null,
  cancelled: false,
  usage: { ...EMPTY_AI_USAGE },
  usd: 0,
};

/** Every run's handles (not state: not rendered). */
let handles = new Map<string, PageCaptionHandle>();
/** Bumped by every start and reset, so answers of an older run are ignored. */
let generation = 0;

/** The editor's view the planners read: the book store plus the assets store's files. */
const captionView = () => ({ ...useBookStore.getState(), files: useAssetsStore.getState().files });

export const useBookCaptions = create<BookRunState>()((set, get) => {
  const patchRow = (run: number, pageId: string, patch: Partial<BookCaptionRow>) => {
    if (run !== generation) return;
    set((s) => ({ rows: s.rows.map((r) => (r.pageId === pageId ? { ...r, ...patch } : r)) }));
  };
  const spend = (run: number, usage: AiUsage, usd: number) => {
    if (run !== generation) return;
    set((s) => ({ usage: addUsage(s.usage, usage), usd: s.usd + usd }));
  };

  return {
    ...INITIAL,

    start: async (pageIds, modeChoice) => {
      for (const h of handles.values()) h.cancel();
      handles = new Map();
      const run = ++generation;
      const book = useBookStore.getState().book;
      if (!book) return;
      const rows: BookCaptionRow[] = pageIds.flatMap((pageId) => {
        const index = book.pages.findIndex((p) => p.id === pageId);
        const page = book.pages[index];
        if (!page) return [];
        const mode = modeChoice === 'fit' ? defaultCaptionMode(page) : modeChoice;
        return [{ pageId, number: index + 1, mode, state: 'waiting' as const }];
      });
      set({ ...INITIAL, usage: { ...EMPTY_AI_USAGE }, status: 'indexing', rows });

      // 1. The index: describe the photos of these pages that are not described yet (none on a re-run).
      const photos = photosOfPages(book, pageIds);
      try {
        const plan = await planIndex(photos);
        // Cancelled while counting: `cancel` already finished the run.
        if (run !== generation || get().cancelled) return;
        if (plan.todo.length > 0 || plan.copies.length > 0) {
          const handle = runIndex(plan);
          set({ index: { photos: plan.todo.length, jobId: handle.id } });
          const outcome = await handle.result;
          if (run !== generation) return;
          if (outcome.state === 'cancelled' || get().cancelled) {
            set((s) => ({
              status: 'finished',
              cancelled: true,
              rows: s.rows.map((r) => (r.state === 'waiting' ? { ...r, state: 'cancelled' } : r)),
            }));
            return;
          }
          if (outcome.state === 'failed') {
            devLog('ai', 'book captions: index failed', { error: outcome.error });
            set((s) => ({
              status: 'finished',
              error: `Describing the photos failed: ${outcome.error}`,
              rows: s.rows.map((r) => (r.state === 'waiting' ? { ...r, state: 'cancelled' } : r)),
            }));
            return;
          }
          spend(run, outcome.value.usage, outcome.value.usd);
          set((s) => ({ index: s.index ? { ...s.index, described: outcome.value.described } : null }));
        }
      } catch (err) {
        if (run !== generation) return;
        set({ status: 'finished', error: `Describing the photos failed: ${errorMessage(err)}` });
        return;
      }
      if (run !== generation || get().cancelled) return;

      // 2. One system block for every page (after the index, so it holds the new descriptions), then a job per page.
      const view = captionView();
      const system = captionSystem(view);
      set({ status: 'captioning' });
      const waits: Promise<void>[] = [];
      for (const row of get().rows) {
        const plan = planPageCaption(view, row.pageId, { mode: row.mode, system });
        if ('error' in plan) {
          patchRow(run, row.pageId, { state: 'error', message: plan.error });
          continue;
        }
        const handle = requestPageCaption(plan);
        handles.set(row.pageId, handle);
        patchRow(run, row.pageId, { state: 'queued', jobId: handle.jobId, photos: plan.photos, notSent: plan.notSent });
        waits.push(
          handle.result.then((result) => {
            handles.delete(row.pageId);
            if (run !== generation) return;
            switch (result.status) {
              case 'ok':
                spend(run, result.usage, result.usd);
                patchRow(run, row.pageId, { state: 'ready', captions: result.captions });
                return;
              case 'refused':
                spend(run, result.usage, result.usd);
                patchRow(run, row.pageId, { state: 'refused', message: result.message });
                return;
              case 'cancelled':
                patchRow(run, row.pageId, { state: 'cancelled' });
                return;
              case 'error':
                patchRow(run, row.pageId, { state: 'error', message: result.message });
                return;
            }
          }),
        );
      }
      await Promise.all(waits);
      if (run === generation) {
        set({ status: 'finished' });
        const rows = get().rows;
        devLog('ai', 'book captions done', {
          pages: rows.length,
          ready: rows.filter((r) => r.state === 'ready').length,
          refused: rows.filter((r) => r.state === 'refused').length,
          usd: Number(get().usd.toFixed(4)),
        });
      }
    },

    cancel: () => {
      const { index, status } = get();
      if (status !== 'indexing' && status !== 'captioning') return;
      set({ cancelled: true });
      if (index?.jobId) useJobsStore.getState().cancel(index.jobId);
      for (const h of handles.values()) h.cancel();
      if (status === 'indexing' && !index?.jobId) {
        set((s) => ({
          status: 'finished',
          rows: s.rows.map((r) => (r.state === 'waiting' ? { ...r, state: 'cancelled' } : r)),
        }));
      }
    },

    accept: (pageId) => {
      const row = get().rows.find((r) => r.pageId === pageId);
      if (row?.state !== 'ready' || !row.captions) return;
      const changed = useBookStore.getState().applyCaptions(pageId, row.captions);
      // Accepted only when something landed: a page deleted meanwhile, or one that already reads this, says so.
      const book = useBookStore.getState().book;
      const gone = !book || !locatePage(book, pageId);
      const patch: Partial<BookCaptionRow> = changed
        ? { state: 'accepted' }
        : gone
          ? { state: 'error', message: 'Page changed: it is no longer in the book, so nothing was placed.' }
          : { state: 'unchanged', message: 'No change: the page already reads this.' };
      set((s) => ({ rows: s.rows.map((r) => (r.pageId === pageId ? { ...r, ...patch } : r)) }));
    },

    acceptAll: () => {
      for (const row of get().rows) if (row.state === 'ready') get().accept(row.pageId);
    },

    skip: (pageId) =>
      set((s) => ({
        rows: s.rows.map((r) => (r.pageId === pageId && r.state === 'ready' ? { ...r, state: 'skipped' } : r)),
      })),

    edit: (pageId, captions) =>
      set((s) => ({
        rows: s.rows.map((r) => (r.pageId === pageId && r.state === 'ready' ? { ...r, captions } : r)),
      })),

    reset: () => {
      get().cancel();
      generation += 1;
      handles = new Map();
      set({ ...INITIAL, usage: { ...EMPTY_AI_USAGE } });
    },
  };
});

/** Rows still waiting for an answer. */
export const pendingRows = (rows: readonly BookCaptionRow[]): number =>
  rows.filter((r) => r.state === 'waiting' || r.state === 'queued').length;
