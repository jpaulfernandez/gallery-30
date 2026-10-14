import {
  type Book,
  BRIEF_LIMITS,
  type Brief,
  type BriefErrors,
  briefReady,
  CAPTION_VOICES,
  type CaptionVoice,
  captureSummary,
  emptyBrief,
  hasExistingCaptions,
  parsePeople,
  VOICE_HINTS,
  VOICE_LABELS,
  validateBrief,
} from '@photobook/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { photoCaptureInfo } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { assetFolderPath } from '../../store/library';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';

/**
 * The caption brief (workflow plan 34, WORKFLOW_PLAN 12.2): one dialog, five questions, of which only the first must be
 * answered, plus example captions. Opened by the first ✦ Write of a project (then the request starts on Save), and any
 * time from the Write popover's Brief… and the Project menu's Caption brief…. Saved with `setBrief` into the project
 * file (`book.captions.brief`), one undo step. "Where and when?" of a new brief is pre-filled from the Exif dates and
 * GPS positions of the book's photos (`photo_capture_info`, `captureSummary`).
 */

interface BriefDialogState {
  open: { onSaved?: () => void } | null;
  show: (onSaved?: () => void) => void;
  hide: () => void;
}

export const useBriefDialog = create<BriefDialogState>()((set) => ({
  open: null,
  show: (onSaved) => set({ open: onSaved ? { onSaved } : {} }),
  hide: () => set({ open: null }),
}));

/** Open the brief dialog; `onSaved` runs after Save (not after Cancel). */
export function openBrief(onSaved?: () => void): void {
  useBriefDialog.getState().show(onSaved);
}

/** The privacy line, shown in the dialog and the Write popover. */
export const PRIVACY_LINE =
  'Captions send the brief, the photo index and the previews of the photos you write about to Anthropic with your ' +
  'key, and to nobody else. Nothing is sent until you ask for captions.';

/** Photos the pre-fill reads at most per folder. */
const CAPTURE_LIMIT = 1000;

/** The book's photos to read the capture time of: the placed ones, or every asset when none is placed yet. */
function capturePhotos(book: Book): string[] {
  const placed = new Set<string>();
  for (const page of book.pages) {
    if (typeof page.background === 'object') placed.add(page.background.asset);
    for (const el of page.elements) if (el.type === 'photo' && el.asset) placed.add(el.asset);
  }
  const ids = placed.size > 0 ? [...placed] : Object.keys(book.assets);
  return ids.filter((id) => Object.hasOwn(book.assets, id));
}

/** The pre-fill: the full line, and the dates alone (saved instead when the author leaves the line untouched). */
export interface CapturePrefill {
  /** "June 3–9, 2026; near 38.71° N, 9.14° W", or '' when the photos say nothing. */
  line: string;
  /** "June 3–9, 2026". */
  dates: string;
}

/** The "Where and when?" pre-fill from the Exif of the book's photos. */
export async function capturePrefill(book: Book, primary: string | null): Promise<CapturePrefill> {
  const byFolder = new Map<string, string[]>();
  for (const id of capturePhotos(book)) {
    const asset = book.assets[id];
    const folder = assetFolderPath(book, asset, primary);
    if (!asset || !folder) continue;
    const list = byFolder.get(folder) ?? [];
    if (list.length < CAPTURE_LIMIT) list.push(asset.path);
    byFolder.set(folder, list);
  }
  const infos = [];
  for (const [folder, paths] of byFolder) {
    try {
      infos.push(...(await photoCaptureInfo(folder, paths)));
    } catch (err) {
      devLog('ai', 'capture info not read', { error: errorMessage(err) });
    }
  }
  return { line: captureSummary(infos), dates: captureSummary(infos, { coordinates: false }) };
}

/** The dialog (mounted once in `main.tsx`). */
export function BriefDialogHost() {
  const open = useBriefDialog((s) => s.open);
  const book = useBookStore((s) => s.book);
  if (!open || !book) return null;
  return <BriefDialogBody key={book.id} book={book} onSaved={open.onSaved} />;
}

interface Draft {
  about: string;
  photographer: string;
  placeTime: string;
  people: string;
  voice: CaptionVoice;
  avoid: string;
  examples: string[];
  useExisting: boolean;
}

const toDraft = (brief: Brief): Draft => ({
  about: brief.about,
  photographer: brief.photographer,
  placeTime: brief.placeTime,
  people: brief.people.join(', '),
  voice: brief.voice,
  avoid: brief.avoid,
  examples: brief.examples.length > 0 ? [...brief.examples] : [''],
  useExisting: brief.useExisting,
});

const fieldClass =
  'w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg outline-none select-text focus-visible:border-accent';

function Question({
  n,
  label,
  hint,
  error,
  children,
}: {
  n?: number;
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-fg">
        {n !== undefined && <span className="mr-1 text-fg-muted tabular-nums">{n}.</span>}
        {label}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] text-fg-muted leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

function BriefDialogBody({ book, onSaved }: { book: Book; onSaved?: () => void }) {
  // A brief without `about` (a hand-edited file) is no brief: the dialog starts as for a new one.
  const stored = book.captions.brief;
  const saved = briefReady(stored) ? stored : undefined;
  const offerExisting = hasExistingCaptions(book);
  const [draft, setDraft] = useState<Draft>(() => toDraft({ ...emptyBrief(offerExisting), ...(saved ?? {}) }));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const bookRef = useRef(book);
  bookRef.current = book;
  const prefill = useRef<CapturePrefill | null>(null);
  const [errors, setErrors] = useState<BriefErrors>({});
  const [prefilled, setPrefilled] = useState(false);
  const touchedPlace = useRef(false);
  const close = () => useBriefDialog.getState().hide();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  // A new brief: "Where and when?" from the photos' Exif, unless the author typed there first.
  // Once per book: edits to the book while the dialog is open do not read the Exif again.
  const hasSaved = saved !== undefined;
  const bookId = book.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the book's id, the book itself is read from a ref
  useEffect(() => {
    if (hasSaved) return;
    let live = true;
    void capturePrefill(bookRef.current, useBookStore.getState().folder).then((found) => {
      if (!live || !found.line || touchedPlace.current || draftRef.current.placeTime) return;
      prefill.current = found;
      setDraft((d) => ({ ...d, placeTime: found.line }));
      setPrefilled(true);
    });
    return () => {
      live = false;
    };
  }, [bookId, hasSaved]);

  const save = () => {
    // The pre-fill saved untouched keeps its dates and drops the raw coordinates (not a place name).
    const filled = prefill.current;
    const placeTime = filled && draft.placeTime === filled.line ? filled.dates : draft.placeTime;
    const result = validateBrief({
      ...draft,
      placeTime,
      people: parsePeople(draft.people),
      useExisting: offerExisting && draft.useExisting,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    useBookStore.getState().setBrief(result.brief);
    devLog('ai', 'brief saved', { voice: result.brief.voice, examples: result.brief.examples.length });
    close();
    onSaved?.();
  };

  const examples = draft.examples;
  return (
    <DialogShell title="Caption brief" onClose={close} widthClass="w-[34rem]">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <DialogBody>
          <p className="text-fg-muted">
            A few words about this book make the captions specific instead of generic. Only the first question needs an
            answer; the brief is saved in this project and can be changed any time.
          </p>
          <Question n={1} label="What is this book about?" error={errors.about}>
            <textarea
              data-autofocus
              aria-label="What is this book about?"
              value={draft.about}
              maxLength={BRIEF_LIMITS.about}
              rows={2}
              placeholder="A week in Lisbon with friends, June 2026"
              onChange={(e) => set('about', e.target.value)}
              className={`${fieldClass} resize-y`}
            />
          </Question>
          <Question
            n={2}
            label="Who is the photographer, and how should they be referred to?"
            error={errors.photographer}
          >
            <input
              type="text"
              aria-label="Photographer"
              value={draft.photographer}
              maxLength={BRIEF_LIMITS.photographer}
              placeholder={'Jan Paul; first person plural, "we"'}
              onChange={(e) => set('photographer', e.target.value)}
              className={fieldClass}
            />
          </Question>
          <Question
            n={3}
            label="Where and when?"
            error={errors.placeTime}
            hint={
              prefilled
                ? 'Filled in from the photos’ dates and GPS positions. Replace the coordinates with a place name; ' +
                  'left as they are, only the dates are saved.'
                : undefined
            }
          >
            <input
              type="text"
              aria-label="Where and when?"
              value={draft.placeTime}
              maxLength={BRIEF_LIMITS.placeTime}
              placeholder="Lisbon, June 3–9, 2026"
              onChange={(e) => {
                touchedPlace.current = true;
                set('placeTime', e.target.value);
              }}
              className={fieldClass}
            />
          </Question>
          <Question
            n={4}
            label="Who is in the photos?"
            error={errors.people}
            hint="Names the captions may use, separated by commas. Anyone not listed stays unnamed."
          >
            <input
              type="text"
              aria-label="Who is in the photos?"
              value={draft.people}
              placeholder="Ana, Rui"
              onChange={(e) => set('people', e.target.value)}
              className={fieldClass}
            />
          </Question>
          <Question n={5} label="Voice" error={errors.voice} hint={VOICE_HINTS[draft.voice]}>
            <div role="radiogroup" aria-label="Voice" className="grid grid-cols-4 rounded-md border border-line p-0.5">
              {CAPTION_VOICES.map((voice) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
                <button
                  key={voice}
                  type="button"
                  role="radio"
                  aria-checked={draft.voice === voice}
                  onClick={() => set('voice', voice)}
                  className={`rounded px-0 py-1 text-[11px] ${draft.voice === voice ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'}`}
                >
                  {VOICE_LABELS[voice]}
                </button>
              ))}
            </div>
          </Question>
          <Question label="Avoid" error={errors.avoid}>
            <input
              type="text"
              aria-label="Avoid"
              value={draft.avoid}
              maxLength={BRIEF_LIMITS.avoid}
              placeholder={'the word "vibrant", food descriptions'}
              onChange={(e) => set('avoid', e.target.value)}
              className={fieldClass}
            />
          </Question>
          <Question
            label="Example captions in your own words"
            error={errors.examples}
            hint={`Up to ${BRIEF_LIMITS.examples}. The captions follow their voice and length, not their content.`}
          >
            <div className="space-y-1.5">
              {examples.map((example, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is edited in place and never reordered
                <div key={i} className="flex items-start gap-1.5">
                  <textarea
                    aria-label={`Example ${i + 1}`}
                    value={example}
                    rows={1}
                    maxLength={BRIEF_LIMITS.example}
                    onChange={(e) =>
                      set(
                        'examples',
                        examples.map((x, j) => (j === i ? e.target.value : x)),
                      )
                    }
                    className={`${fieldClass} resize-y`}
                  />
                  {examples.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove example ${i + 1}`}
                      onClick={() =>
                        set(
                          'examples',
                          examples.filter((_, j) => j !== i),
                        )
                      }
                      className="rounded-sm px-1.5 py-1 text-fg-muted hover:bg-line hover:text-fg"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {examples.length < BRIEF_LIMITS.examples && (
                <button
                  type="button"
                  onClick={() => set('examples', [...examples, ''])}
                  className="rounded-md px-1.5 py-0.5 text-fg-muted hover:bg-line hover:text-fg"
                >
                  + Add an example
                </button>
              )}
            </div>
          </Question>
          {offerExisting && (
            <label className="flex items-center gap-2 text-fg-muted">
              <input
                type="checkbox"
                checked={draft.useExisting}
                onChange={(e) => set('useExisting', e.target.checked)}
              />
              Use my existing captions as examples
            </label>
          )}
          <p className="text-fg-muted">{PRIVACY_LINE}</p>
        </DialogBody>
        <DialogFooter>
          <DialogButton onClick={close}>Cancel</DialogButton>
          <DialogButton primary type="submit">
            {onSaved ? 'Save and write' : 'Save'}
          </DialogButton>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}
