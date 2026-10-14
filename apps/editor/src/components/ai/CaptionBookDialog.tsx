import { aiModelLabel, briefReady, DEFAULT_AI_MODEL, VOICE_LABELS } from '@photobook/shared';
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { type CostEstimate, describeEstimate, formatUsd, roughTokens } from '../../lib/ai/cost';
import type { PageCaption } from '../../lib/ai/placeCaptions';
import { errorMessage } from '../../lib/errors';
import {
  type BookCaptionModeChoice,
  type BookCaptionRow,
  type BookCaptionScope,
  bookCaptionPages,
  pendingRows,
  photosOfPages,
  useBookCaptions,
} from '../../lib/jobs/aiBookCaption';
import { estimateIndex, planIndex } from '../../lib/jobs/aiIndex';
import { captionSystem, estimatePageCaptions } from '../../lib/jobs/aiPageCaption';
import { devLog } from '../../lib/log';
import { useAiStore } from '../../store/ai';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { buttonClass as buttonLook } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { openBrief } from './BriefDialog';
import { CaptionReview } from './CaptionReview';

/**
 * Caption book… (workflow plan 35, WORKFLOW_PLAN 12.3 and 12.5), from the Design stage's Book menu: the brief, the
 * pages to caption (without captions / all), the cost before anything is sent ("about 60,000 tokens, roughly $0.25 on
 * Claude Opus 5.5", plus describing the photos the index lacks), then the run (`useBookCaptions`): the index step,
 * one request per page in the `ai` lane, and a row per page to Accept, Edit or Skip, with Accept all. Nothing lands
 * until accepted; a page the model declines shows its reason and leaves the others. Stop cancels what has no answer
 * yet; closing the dialog drops the rows not accepted.
 */

interface DialogState {
  open: boolean;
  /** The book it was opened for: another project (or none) closes it. */
  bookId: string | null;
  show: () => void;
  hide: () => void;
}

export const useCaptionBookDialog = create<DialogState>()((set) => ({
  open: false,
  bookId: null,
  show: () => set({ open: true, bookId: useBookStore.getState().book?.id ?? null }),
  hide: () => set({ open: false, bookId: null }),
}));

/** Open the dialog; the brief comes first when the project has none (the dialog opens on Save). */
export function openCaptionBook(): void {
  if (!briefReady(useBookStore.getState().book?.captions.brief)) {
    openBrief(() => useCaptionBookDialog.getState().show());
    return;
  }
  useCaptionBookDialog.getState().show();
}

/** Tokens an index line adds to the system block per photo described in the run (plan 33: about 50 to 60). */
const INDEX_LINE_TOKENS = 60;

/** The dialog (mounted once in `main.tsx`). */
export function CaptionBookDialogHost() {
  const open = useCaptionBookDialog((s) => s.open);
  const openFor = useCaptionBookDialog((s) => s.bookId);
  const bookId = useBookStore((s) => s.book?.id ?? null);
  const stale = open && (bookId === null || bookId !== openFor);
  // The project closed (or another opened): the dialog and its run go with it, so it cannot reappear later.
  useEffect(() => {
    if (!stale) return;
    useBookCaptions.getState().reset();
    useCaptionBookDialog.getState().hide();
  }, [stale]);
  if (!open || stale) return null;
  return <CaptionBookDialog />;
}

const MODE_OPTIONS: Array<{ value: BookCaptionModeChoice; label: string }> = [
  { value: 'fit', label: 'Fit each layout' },
  { value: 'photo', label: 'One caption per photo' },
  { value: 'page', label: 'One caption per page' },
];

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

interface Estimates {
  pages: number;
  describe: number;
  index: CostEstimate | null;
  captions: CostEstimate;
}

function CaptionBookDialog() {
  const book = useBookStore((s) => s.book);
  const settings = useAiStore((s) => s.settings);
  const status = useBookCaptions((s) => s.status);
  const [scope, setScope] = useState<BookCaptionScope>('empty');
  const [mode, setMode] = useState<BookCaptionModeChoice>('fit');
  const [estimates, setEstimates] = useState<Estimates | null>(null);
  const [error, setError] = useState<string | null>(null);

  const emptyPages = useMemo(() => (book ? bookCaptionPages(book, 'empty') : []), [book]);
  const allPages = useMemo(() => (book ? bookCaptionPages(book, 'all') : []), [book]);
  const pageIds = scope === 'empty' ? emptyPages : allPages;
  // All pages: those with a caption already get theirs replaced when their row is accepted.
  const captioned = scope === 'all' ? allPages.length - emptyPages.length : 0;
  const model = settings?.model ?? DEFAULT_AI_MODEL;
  const hasKey = settings?.hasKey ?? false;

  useEffect(() => {
    if (!useAiStore.getState().settings) void useAiStore.getState().load();
  }, []);

  // The estimate, before anything is sent: the photos the index lacks, then the page requests.
  useEffect(() => {
    if (status !== 'idle' || !hasKey) return;
    let live = true;
    setEstimates(null);
    const state = useBookStore.getState();
    const current = state.book;
    if (!current) return;
    planIndex(photosOfPages(current, pageIds))
      .then((plan) => {
        if (!live) return;
        const view = { ...useBookStore.getState(), files: useAssetsStore.getState().files };
        const system = roughTokens(captionSystem(view)) + INDEX_LINE_TOKENS * plan.todo.length;
        setEstimates({
          pages: pageIds.length,
          describe: plan.todo.length,
          index: plan.todo.length > 0 ? estimateIndex(plan) : null,
          captions: estimatePageCaptions(current, pageIds, model, system),
        });
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [pageIds, model, hasKey, status]);

  const close = () => {
    useBookCaptions.getState().reset();
    useCaptionBookDialog.getState().hide();
  };

  const start = () => {
    if (!estimates || pageIds.length === 0) return;
    devLog('ai', 'book captions start', { pages: pageIds.length, scope, mode });
    void useBookCaptions.getState().start(pageIds, mode);
  };

  const brief = book?.captions.brief;
  if (!book) return null;

  if (status !== 'idle') return <RunView onClose={close} />;

  const total = estimates ? estimates.captions.usd + (estimates.index?.usd ?? 0) : 0;
  return (
    <DialogShell title="Caption book" onClose={close} widthClass="w-[34rem]">
      <DialogBody>
        <section className="space-y-1 rounded-md border border-line bg-panel-2 p-2">
          <div className="flex items-center gap-2">
            <span className="section-title">Brief</span>
            <button
              type="button"
              className="ml-auto rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-line hover:text-fg"
              onClick={() => openBrief()}
            >
              Edit brief…
            </button>
          </div>
          {briefReady(brief) ? (
            <p className="text-fg">
              {brief.about}
              <span className="text-fg-muted">
                {' '}
                · {VOICE_LABELS[brief.voice]} voice
                {brief.people.length > 0 ? ` · ${plural(brief.people.length, 'name')}` : ''}
              </span>
            </p>
          ) : (
            <p className="text-fg">Write the brief first: what the book is about.</p>
          )}
        </section>
        <fieldset className="space-y-1">
          <legend className="section-title mb-1">Pages</legend>
          <label className="flex items-center gap-1.5 text-fg">
            <input type="radio" name="caption-scope" checked={scope === 'empty'} onChange={() => setScope('empty')} />
            Pages without captions ({emptyPages.length})
          </label>
          <label className="flex items-center gap-1.5 text-fg">
            <input type="radio" name="caption-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
            All pages with photos ({allPages.length})
          </label>
        </fieldset>
        <label className="flex items-center justify-between gap-2 text-fg-muted">
          Captions
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as BookCaptionModeChoice)}
            className="rounded-md border border-line bg-panel-2 px-2 py-1 text-fg text-xs outline-none focus:border-accent"
          >
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {captioned > 0 && (
          <p className="text-warn">
            {captioned === 1 ? '1 of these pages has' : `${captioned} of these pages have`} captions already: accepting
            a page replaces its captions (you review each page first).
          </p>
        )}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : !hasKey ? (
          <p role="alert" className="text-fg">
            Add an Anthropic API key in Settings → AI first.
          </p>
        ) : pageIds.length === 0 ? (
          <p className="text-fg-muted">
            No page to caption{scope === 'empty' ? ': every page with photos has one' : ''}.
          </p>
        ) : !estimates ? (
          <p className="text-fg-muted">Counting…</p>
        ) : (
          <div role="status" className="space-y-1 text-fg">
            {estimates.index && (
              <p>
                First, describe {plural(estimates.describe, 'photo')} for the photo index:{' '}
                {describeEstimate(estimates.index)}.
              </p>
            )}
            <p>
              {plural(estimates.pages, 'page')}, one request each: {describeEstimate(estimates.captions)}.
            </p>
            {estimates.index && <p className="text-fg-muted">Together roughly {formatUsd(total)}.</p>}
            <p className="text-[11px] text-fg-muted">
              A rough guide: thinking varies from page to page; the real cost is added up as the pages come back.
            </p>
          </div>
        )}
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Sent to Anthropic with your key, and to nobody else, when you press Caption: the brief, the photo index and
          the previews of each page’s photos. Nothing is placed until you accept it.
        </p>
      </DialogBody>
      <DialogFooter note={hasKey ? `Captions on ${aiModelLabel(model)}` : undefined}>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton
          primary
          disabled={!hasKey || !estimates || pageIds.length === 0 || !briefReady(brief)}
          onClick={start}
        >
          {pageIds.length > 0 ? `Caption ${plural(pageIds.length, 'page')}` : 'Caption'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

const STATE_LABELS: Record<BookCaptionRow['state'], string> = {
  waiting: 'Waiting for the index',
  queued: 'Queued',
  ready: 'Ready to review',
  refused: 'Declined',
  error: 'Failed',
  cancelled: 'Stopped',
  accepted: 'Accepted',
  skipped: 'Skipped',
  unchanged: 'No change',
};

function RunView({ onClose }: { onClose: () => void }) {
  const book = useBookStore((s) => s.book);
  const run = useBookCaptions();
  const pending = pendingRows(run.rows);
  const ready = run.rows.filter((r) => r.state === 'ready').length;
  const answered = run.rows.filter((r) => r.state !== 'waiting' && r.state !== 'queued').length;
  const running = run.status === 'indexing' || run.status === 'captioning';
  // Rows ready to review are paid for: Esc, Cancel and Close ask before dropping them.
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => {
    if (ready > 0 && !confirming) setConfirming(true);
    else onClose();
  };
  const tokens =
    run.usage.inputTokens +
    run.usage.outputTokens +
    run.usage.cacheCreationInputTokens +
    run.usage.cacheReadInputTokens;

  let line: string;
  if (run.error) line = run.error;
  else if (run.status === 'indexing') {
    line = run.index?.photos
      ? `Describing ${plural(run.index.photos, 'photo')} for the photo index first…`
      : 'Reading the photo index…';
  } else if (run.status === 'captioning')
    line = `Captioning: ${answered} of ${plural(run.rows.length, 'page')} answered…`;
  else {
    const declined = run.rows.filter((r) => r.state === 'refused').length;
    const failed = run.rows.filter((r) => r.state === 'error').length;
    const parts = [`${plural(run.rows.length - pending, 'page')} answered`];
    if (declined) parts.push(`${declined} declined`);
    if (failed) parts.push(`${failed} failed`);
    if (run.cancelled) parts.push('stopped');
    line = `${parts.join(', ')}.`;
  }

  return (
    <DialogShell title="Caption book" onClose={requestClose} widthClass="w-[40rem]">
      <DialogBody>
        <p role="status" className={run.error ? 'text-danger' : 'text-fg'}>
          {line}
        </p>
        <p className="text-[11px] text-fg-muted">
          Spent {run.usd > 0 ? `about ${formatUsd(run.usd)}` : 'nothing yet'}
          {tokens > 0
            ? ` · ${tokens.toLocaleString('en-US')} tokens (${run.usage.cacheReadInputTokens.toLocaleString('en-US')} read from the cache)`
            : ''}
        </p>
        {confirming && ready > 0 && (
          <div role="alert" className="flex items-center gap-2 rounded-md border border-warn/60 p-2 text-fg">
            <span className="min-w-0 flex-1">
              Drop {plural(ready, 'page')} you have not accepted? Their captions are paid for and will be lost.
            </span>
            <DialogButton onClick={() => setConfirming(false)}>Keep reviewing</DialogButton>
            <DialogButton primary onClick={onClose}>
              Drop them
            </DialogButton>
          </div>
        )}
        <ul aria-label="Pages" className="space-y-2">
          {run.rows.map((row) => (
            <PageRow key={row.pageId} row={row} book={book} />
          ))}
        </ul>
      </DialogBody>
      <DialogFooter
        note={ready > 0 && !running ? `${plural(ready, 'page')} not accepted yet are dropped on Close.` : undefined}
      >
        {running && <DialogButton onClick={() => run.cancel()}>Stop</DialogButton>}
        <DialogButton disabled={ready === 0} onClick={() => run.acceptAll()}>
          {ready > 0 ? `Accept all (${ready})` : 'Accept all'}
        </DialogButton>
        <DialogButton primary={!running} onClick={requestClose}>
          {running ? 'Cancel' : 'Close'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const rowButton = buttonLook({ size: 'sm' });

function PageRow({ row, book }: { row: BookCaptionRow; book: ReturnType<typeof useBookStore.getState>['book'] }) {
  const jobState = useJobsStore((s) => (row.jobId ? s.jobs[row.jobId]?.state : undefined));
  const [draft, setDraft] = useState<PageCaption[] | null>(null);
  const run = useBookCaptions.getState();
  const state = row.state === 'queued' && jobState === 'running' ? 'Writing…' : STATE_LABELS[row.state];

  return (
    <li aria-label={`Page ${row.number}`} className="space-y-1.5 rounded-md border border-line p-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">Page {row.number}</span>
        <span className="text-[11px] text-fg-muted">{state}</span>
        {row.state === 'ready' && (
          <span className="ml-auto flex gap-1">
            {draft ? (
              <>
                <button
                  type="button"
                  className={rowButton}
                  onClick={() => {
                    run.edit(row.pageId, draft);
                    setDraft(null);
                  }}
                >
                  Done
                </button>
                <button type="button" className={rowButton} onClick={() => setDraft(null)}>
                  Discard edits
                </button>
              </>
            ) : (
              <>
                <button type="button" className={rowButton} onClick={() => run.accept(row.pageId)}>
                  Accept
                </button>
                <button type="button" className={rowButton} onClick={() => setDraft(row.captions ?? [])}>
                  Edit
                </button>
                <button type="button" className={rowButton} onClick={() => run.skip(row.pageId)}>
                  Skip
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {(row.state === 'refused' || row.state === 'error' || row.state === 'unchanged') && row.message && (
        <p role="alert" className={row.state === 'error' ? 'text-danger' : 'text-fg'}>
          {row.message}
        </p>
      )}
      {row.state === 'ready' && row.captions && (
        <CaptionReview
          book={book}
          pageId={row.pageId}
          mode={row.mode}
          photos={row.photos ?? []}
          notSent={row.notSent ?? 0}
          captions={draft ?? row.captions}
          editing={draft !== null}
          onChange={setDraft}
        />
      )}
    </li>
  );
}
