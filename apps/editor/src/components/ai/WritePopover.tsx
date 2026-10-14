import { aiModelLabel, briefReady, type TextElement } from '@photobook/shared';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatUsd } from '../../lib/ai/cost';
import {
  ANGLE_LABELS,
  CAPTION_FIXES,
  type CaptionAngle,
  type CaptionFix,
  type CaptionVariant,
  type ElementCaptionHandle,
  FIX_LABELS,
  planElementCaption,
  requestElementCaptions,
} from '../../lib/jobs/aiCaption';
import { devLog } from '../../lib/log';
import { useAiStore } from '../../store/ai';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { buttonClass } from '../ui/Button';
import { DIALOG_ATTR } from '../ui/DialogShell';
import { openBrief } from './BriefDialog';
import { INITIAL_WRITE, previousTexts, type WriteMeta, writeReducer } from './writeState';

/**
 * ✦ Write on the text element inspector (workflow plan 34, WORKFLOW_PLAN 12.5): three captions for the selected text
 * box, each from a different angle, with the photo's alt text; chips ask again Shorter, More specific or from a
 * Different angle; Use replaces the text (and records the alt text) in one undo step; Keep mine closes. The first Write
 * of a project opens the brief and starts on Save. Closing the popover (Keep mine, ✕, Escape, a click outside, another
 * selection) cancels the request in flight.
 */

/** Panel width, px. */
const WIDTH = 340;
const OFFSET = 4;
const EDGE = 8;

const chipClass =
  'rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted outline-none hover:border-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg-muted';
const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const linkClass =
  'rounded-sm px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent';

const angleLabel = (angle: string): string =>
  Object.hasOwn(ANGLE_LABELS, angle) ? ANGLE_LABELS[angle as CaptionAngle] : 'Another angle';

/** "Claude Opus 5.5 · about $0.02", with the fallback model when another one answered. */
function metaLine(meta: WriteMeta): string {
  const usd = formatUsd(meta.usd);
  const cost = usd.startsWith('under') ? usd : `about ${usd}`;
  const who = meta.fellBack ? `answered by ${aiModelLabel(meta.servedBy)}` : aiModelLabel(meta.model);
  return `${who} · ${cost}`;
}

export function WriteButton({ pageId, element }: { pageId: string; element: TextElement }) {
  const [state, dispatch] = useReducer(writeReducer, INITIAL_WRITE);
  const [sent, setSent] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef(0);
  const handleRef = useRef<ElementCaptionHandle | null>(null);
  const subjectRef = useRef<string | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  // An alt the photo already has is kept on Use (`writeCaption`); the cards say so.
  const subjectHasAlt = useBookStore((s) => Boolean(subject && s.book?.assets[subject]?.alt?.trim()));
  const mounted = useRef(true);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const elementId = element.id;
  const open = state.phase !== 'closed';
  const jobState = useJobsStore((s) => (jobId ? s.jobs[jobId]?.state : undefined));

  const stop = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
  }, []);

  const close = useCallback(() => {
    stop();
    dispatch({ type: 'close' });
  }, [stop]);

  /** Close and give the focus back to the Write button (Use, Keep mine, ✕, Escape). */
  const closeToButton = useCallback(() => {
    close();
    buttonRef.current?.focus();
  }, [close]);

  // A new selection unmounts the inspector: the request goes with it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      handleRef.current?.cancel();
      handleRef.current = null;
    };
  }, []);

  const send = useCallback(
    (fix?: CaptionFix) => {
      if (!mounted.current) return;
      const previous = fix ? previousTexts(stateRef.current) : [];
      stop();
      const request = ++requestRef.current;
      dispatch({ type: 'request', request, ...(fix ? { fix } : {}) });
      const view = { ...useBookStore.getState(), files: useAssetsStore.getState().files };
      const plan = planElementCaption(view, pageId, elementId, { ...(fix ? { fix } : {}), previous });
      if ('error' in plan) {
        dispatch({ type: 'result', request, result: { status: 'error', message: plan.error } });
        return;
      }
      subjectRef.current = plan.subject;
      setSubject(plan.subject);
      setSent(plan.sent.length);
      const handle = requestElementCaptions(plan);
      handleRef.current = handle;
      setJobId(handle.jobId);
      void handle.result.then((result) => {
        if (handleRef.current === handle) handleRef.current = null;
        if (mounted.current) dispatch({ type: 'result', request, result });
      });
    },
    [pageId, elementId, stop],
  );

  const write = async () => {
    if (open) {
      close();
      return;
    }
    const ai = useAiStore.getState();
    if (!ai.settings) await ai.load();
    const settings = useAiStore.getState().settings;
    if (settings && !settings.hasKey) {
      dispatch({ type: 'nokey' });
      return;
    }
    if (!briefReady(useBookStore.getState().book?.captions.brief)) {
      devLog('ai', 'write: brief first', {});
      openBrief(() => send());
      return;
    }
    send();
  };

  const use = (variant: CaptionVariant) => {
    const subject = subjectRef.current;
    useBookStore
      .getState()
      .writeCaption(pageId, elementId, variant.text, subject ? { assetId: subject, alt: variant.alt } : undefined);
    devLog('ai', 'caption used', { angle: variant.angle });
    closeToButton();
  };

  // Place the panel under the button, right edges aligned (the inspector is on the right), above when it does not fit.
  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = panelRef.current?.offsetHeight ?? 0;
    const left = Math.min(Math.max(r.right - WIDTH, EDGE), window.innerWidth - WIDTH - EDGE);
    let top = r.bottom + OFFSET;
    if (height && top + height > window.innerHeight - EDGE) top = Math.max(EDGE, r.top - OFFSET - height);
    setPos({ left, top });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-place when the content (and so the height) changes
  useLayoutEffect(() => {
    if (open) place();
  }, [open, state, place]);

  // Focus moves into the popover when it opens, and to the first Use button when captions arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each phase and request change
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    if (state.phase === 'ready') {
      panel.querySelector<HTMLElement>('[data-use]')?.focus();
      return;
    }
    if (!panel.contains(document.activeElement)) panel.focus();
  }, [open, state.phase, state.request]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      // The brief dialog opened from the popover is not "outside".
      if (t instanceof Element && t.closest(`[${DIALOG_ATTR}]`)) return;
      close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
    };
  }, [open, close, place]);

  const loading = state.phase === 'loading';
  const variants = 'variants' in state ? state.variants : [];
  const current = element.text.trim();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => void write()}
        title="Write this caption with AI: three variants from the photo and the project's brief"
        className={`${buttonClass({ size: 'sm' })} w-full gap-2`}
      >
        <span aria-hidden="true">✦</span>
        <span>Write</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Write a caption"
            data-canvas-ui
            tabIndex={-1}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                closeToButton();
                return;
              }
              if (e.key !== 'Tab') return;
              // Tab stays inside the popover.
              const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (!first || !last) {
                e.preventDefault();
                return;
              }
              const active = document.activeElement;
              if (e.shiftKey && (active === first || active === panelRef.current)) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
              }
            }}
            className="fixed z-50 flex max-h-[80vh] flex-col scrollbar overflow-x-hidden overflow-y-auto rounded-lg border border-line bg-panel-2 text-xs shadow-float"
            style={{ width: WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          >
            <div className="flex items-center gap-1 border-line border-b px-3 py-2">
              <span className="font-medium text-fg">✦ Write</span>
              <button
                type="button"
                className={`${linkClass} ml-auto`}
                onClick={() => openBrief()}
                title="Edit the caption brief"
              >
                Brief…
              </button>
              <button type="button" aria-label="Close" className={linkClass} onClick={closeToButton}>
                ✕
              </button>
            </div>
            <div className="space-y-2 px-3 py-2">
              {state.phase === 'nokey' && (
                <p role="alert" className="text-fg">
                  Add an Anthropic API key in Settings → AI first.
                </p>
              )}
              {loading && (
                <p role="status" className="text-fg-muted">
                  {jobState === 'queued'
                    ? 'Waiting for another AI job to finish…'
                    : `Writing three captions${state.fix ? ` (${FIX_LABELS[state.fix].toLowerCase()})` : ''}…`}
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
              {variants.length > 0 && (
                <ul className={`space-y-1.5 ${loading ? 'opacity-50' : ''}`} aria-label="Captions">
                  {variants.map((v, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole on every answer
                      key={i}
                      className="space-y-1 rounded-md border border-line bg-panel p-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="section-title">{angleLabel(v.angle)}</span>
                        <button
                          type="button"
                          data-use
                          disabled={loading}
                          onClick={() => use(v)}
                          className="ml-auto rounded-md border border-accent bg-accent/20 px-2 py-0.5 text-[11px] text-fg hover:bg-accent/30 disabled:opacity-40"
                        >
                          Use
                        </button>
                      </div>
                      <p className="select-text text-fg leading-relaxed">{v.text}</p>
                      {v.alt && (
                        <p className="select-text text-[11px] text-fg-muted">
                          {subjectHasAlt ? 'Alt text (the photo keeps its own): ' : 'Alt text: '}
                          {v.alt}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {state.phase !== 'nokey' && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {state.phase === 'ready' || variants.length > 0 ? (
                    CAPTION_FIXES.map((fix) => (
                      <button
                        key={fix}
                        type="button"
                        disabled={loading || variants.length === 0}
                        onClick={() => send(fix)}
                        className={chipClass}
                      >
                        {FIX_LABELS[fix]}
                      </button>
                    ))
                  ) : state.phase === 'refused' || state.phase === 'error' ? (
                    <button type="button" onClick={() => send()} className={chipClass}>
                      Try again
                    </button>
                  ) : null}
                  {loading && (
                    <button type="button" onClick={closeToButton} className={`${linkClass} ml-auto`}>
                      Stop
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={closeToButton}
                className="w-full space-y-0.5 rounded-sm border border-hairline border-dashed p-2 text-left outline-none transition-colors duration-fast hover:bg-fg/6 focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="section-title block">Keep mine</span>
                <span className="block truncate text-fg-muted">{current || 'The text box is empty.'}</span>
              </button>
            </div>
            <div className="space-y-1 border-line border-t px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
              {state.phase === 'ready' && <p>{metaLine(state.meta)}</p>}
              <p>
                Sent to Anthropic with your key, and to nobody else: the brief, the photo index
                {sent > 0 ? ` and ${sent === 1 ? 'one photo preview' : `${sent} photo previews`}` : ''}.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
