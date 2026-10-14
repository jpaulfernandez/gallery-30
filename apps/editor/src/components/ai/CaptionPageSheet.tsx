import { aiModelLabel, BOOK_OUTPUT_ID, briefReady, locatePage } from '@photobook/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { formatUsd } from '../../lib/ai/cost';
import type { PageCaption } from '../../lib/ai/placeCaptions';
import {
  type CaptionMode,
  defaultCaptionMode,
  type PageCaptionHandle,
  type PageCaptionPlan,
  planPageCaption,
  requestPageCaption,
  sendEdge,
} from '../../lib/jobs/aiPageCaption';
import { devLog } from '../../lib/log';
import { useAiStore } from '../../store/ai';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { openBrief } from './BriefDialog';
import { CaptionReview } from './CaptionReview';

/**
 * Caption this page (workflow plan 35, WORKFLOW_PLAN 12.5): one request for the page (its photos' previews, the brief
 * and the photo index), one caption per photo or one for the page (the author picks; the default suits the layout),
 * with the alt text of every photo. Nothing is sent until Generate, and nothing lands until Apply, which places the
 * captions in the page's caption boxes (or a new caption at the bottom margin) and records alt text the photos lack,
 * in one undo step. A refusal shows the model's reason and changes nothing. Opened from the page strip menu and the
 * page inspector; closing it cancels the request in flight.
 */

interface SheetState {
  pageId: string | null;
  show: (pageId: string) => void;
  hide: () => void;
}

export const useCaptionPageSheet = create<SheetState>()((set) => ({
  pageId: null,
  show: (pageId) => set({ pageId }),
  hide: () => set({ pageId: null }),
}));

/** Open the sheet for `pageId`; the brief comes first when the project has none (the sheet opens on Save). */
export function openCaptionPage(pageId: string): void {
  if (!briefReady(useBookStore.getState().book?.captions.brief)) {
    devLog('ai', 'caption page: brief first', {});
    openBrief(() => useCaptionPageSheet.getState().show(pageId));
    return;
  }
  useCaptionPageSheet.getState().show(pageId);
}

/** The sheet (mounted once in `main.tsx`). */
export function CaptionPageSheetHost() {
  const pageId = useCaptionPageSheet((s) => s.pageId);
  const exists = useBookStore((s) => Boolean(pageId && s.book && locatePage(s.book, pageId)));
  if (!pageId || !exists) return null;
  return <CaptionPageSheet key={pageId} pageId={pageId} />;
}

type Phase =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; captions: PageCaption[]; meta: string }
  | { phase: 'refused'; message: string }
  | { phase: 'error'; message: string };

const MODE_LABELS: Record<CaptionMode, string> = {
  photo: 'One caption per photo',
  page: 'One caption for the page',
};

function CaptionPageSheet({ pageId }: { pageId: string }) {
  const book = useBookStore((s) => s.book);
  const settings = useAiStore((s) => s.settings);
  const at = book ? locatePage(book, pageId) : undefined;
  const page = at?.pages[at.index];
  const [mode, setMode] = useState<CaptionMode>(() => (page ? defaultCaptionMode(page) : 'page'));
  const [state, setState] = useState<Phase>({ phase: 'idle' });
  const [plan, setPlan] = useState<PageCaptionPlan | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const jobState = useJobsStore((s) => (jobId ? s.jobs[jobId]?.state : undefined));
  const handleRef = useRef<PageCaptionHandle | null>(null);
  const request = useRef(0);

  useEffect(() => {
    if (!useAiStore.getState().settings) void useAiStore.getState().load();
    return () => {
      handleRef.current?.cancel();
      handleRef.current = null;
    };
  }, []);

  const close = useCallback(() => useCaptionPageSheet.getState().hide(), []);

  const generate = () => {
    handleRef.current?.cancel();
    const n = ++request.current;
    const view = { ...useBookStore.getState(), files: useAssetsStore.getState().files };
    const next = planPageCaption(view, pageId, { mode });
    if ('error' in next) {
      setState({ phase: 'error', message: next.error });
      return;
    }
    setPlan(next);
    setState({ phase: 'loading' });
    const handle = requestPageCaption(next);
    handleRef.current = handle;
    setJobId(handle.jobId);
    void handle.result.then((result) => {
      if (handleRef.current === handle) handleRef.current = null;
      if (n !== request.current) return;
      switch (result.status) {
        case 'ok': {
          const usd = formatUsd(result.usd);
          const who = result.fellBack ? `answered by ${aiModelLabel(result.servedBy)}` : aiModelLabel(result.model);
          setState({
            phase: 'ready',
            captions: result.captions,
            meta: `${who} · ${usd.startsWith('under') ? usd : `about ${usd}`}`,
          });
          return;
        }
        case 'refused':
          setState({ phase: 'refused', message: result.message });
          return;
        case 'error':
          setState({ phase: 'error', message: result.message });
          return;
        case 'cancelled':
          setState({ phase: 'error', message: 'Stopped before the captions came.' });
          return;
      }
    });
  };

  const apply = () => {
    if (state.phase !== 'ready') return;
    const changed = useBookStore.getState().applyCaptions(pageId, state.captions);
    devLog('ai', 'page captions applied', { changed, captions: state.captions.filter((c) => c.text).length });
    close();
  };

  if (!page || !at) return null;
  const photoCount = new Set([
    ...(typeof page.background === 'object' ? [page.background.asset] : []),
    ...page.elements.flatMap((e) => (e.type === 'photo' && e.asset ? [e.asset] : [])),
  ]).size;
  const hasKey = settings?.hasKey ?? true;
  const loading = state.phase === 'loading';
  const pageName = `${at.outputId === BOOK_OUTPUT_ID ? 'Page' : 'Frame'} ${at.index + 1}`;

  return (
    <DialogShell title={`Caption this page · ${pageName}`} onClose={close} widthClass="w-[34rem]">
      <DialogBody>
        {!hasKey ? (
          <p role="alert" className="text-fg">
            Add an Anthropic API key in Settings → AI first.
          </p>
        ) : (
          <>
            <fieldset className="flex gap-4" disabled={loading}>
              <legend className="sr-only">What to write</legend>
              {(['photo', 'page'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-fg">
                  <input
                    type="radio"
                    name="caption-mode"
                    checked={mode === m}
                    onChange={() => {
                      setMode(m);
                      setState({ phase: 'idle' });
                    }}
                  />
                  {MODE_LABELS[m]}
                </label>
              ))}
            </fieldset>
            {state.phase === 'idle' && (
              <p className="text-fg-muted">
                {photoCount === 0
                  ? 'This page has no photos to caption.'
                  : `Writes ${mode === 'photo' ? 'a caption for each photo' : 'one caption for the page'} and the alt text of ${photoCount === 1 ? 'its photo' : `its ${photoCount} photos`}. You review them before anything is placed.`}
              </p>
            )}
            {loading && (
              <p role="status" className="text-fg-muted">
                {jobState === 'queued' ? 'Waiting for another AI job to finish…' : 'Writing the captions…'}
              </p>
            )}
            {state.phase === 'refused' && (
              <p role="alert" className="text-fg">
                {state.message}
              </p>
            )}
            {state.phase === 'error' && (
              <p role="alert" className="text-danger">
                {state.message}
              </p>
            )}
            {state.phase === 'ready' && plan && (
              <>
                <CaptionReview
                  book={book}
                  pageId={pageId}
                  mode={plan.mode}
                  photos={plan.photos}
                  captions={state.captions}
                  editing
                  onChange={(captions) => setState({ ...state, captions })}
                  notSent={plan.notSent}
                />
                <p className="text-[11px] text-fg-muted">{state.meta}</p>
              </>
            )}
            <p className="text-[11px] text-fg-muted leading-relaxed">
              Sent to Anthropic with your key, and to nobody else, when you press Generate: the brief, the photo index
              and
              {photoCount === 1 ? ' the photo’s preview' : ` the ${photoCount} photos’ previews`} (
              {sendEdge(photoCount)} px).
            </p>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={close}>{loading ? 'Stop' : 'Cancel'}</DialogButton>
        {hasKey && (
          <DialogButton primary={state.phase !== 'ready'} disabled={loading || photoCount === 0} onClick={generate}>
            {state.phase === 'idle' ? 'Generate' : 'Try again'}
          </DialogButton>
        )}
        {state.phase === 'ready' && (
          <DialogButton primary onClick={apply}>
            Apply
          </DialogButton>
        )}
      </DialogFooter>
    </DialogShell>
  );
}
