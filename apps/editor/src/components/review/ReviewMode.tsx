import type { AssetFlag, DevelopSettings, OutputProfile } from '@photobook/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from '../../lib/path';
import { type AssetFile, currentDeveloped, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { OnePicture } from '../cull/CompareView';
import { isEditableTarget } from '../cull/keys';
import { FlagIcon, RejectIcon } from '../filmstrip/FilmstripCell';
import { usedAssetIds } from '../filmstrip/visible';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Field';
import { Tag } from '../ui/Tag';
import { Tooltip } from '../ui/Tooltip';

/** Thumbnails shown on each side of the current one in the bottom strip. */
const STRIP_RADIUS = 10;

/**
 * The proxy and thumbnail to show for a photo: its developed render when one matches the edits and the book's output
 * profile, else the originals.
 */
export function urlsOf(file: AssetFile | undefined, develop: DevelopSettings | undefined, profile: OutputProfile) {
  const developed = currentDeveloped(file, develop, profile);
  return { proxyUrl: developed?.proxyUrl ?? file?.proxyUrl, thumbUrl: developed?.thumbUrl ?? file?.thumbUrl };
}

export interface ReviewModeProps {
  /**
   * Render in place (the Cull stage fills its main area with it) instead of over the editor: no Done button, Escape
   * does not close, and D calls `onDevelop` with the photo shown.
   */
  inline?: boolean;
  onDevelop?: (id: string) => void;
  /** In place: Escape calls it (the Cull stage goes back to its grid). Without it Escape is left alone. */
  onClose?: () => void;
}

/**
 * Photo review, like a loupe view: one photo large (the 1600 px proxy), a strip of its neighbours, and
 * Lightroom-style keys. It steps through the photo ids of the `review` session (project asset ids over the editor,
 * library keys in the Cull stage; see `ReviewSession`), fixed when it opened, so flagging a photo away under a filter
 * does not reshuffle the session. Ratings and flags go to the photo's folder library either way (`reviewAssets`).
 *
 * Keys: Left / Right (or Up / Down) step, Home / End jump, 1 to 5 rate and 0 clears, P picks, X rejects,
 * U unflags, D opens the Develop view on the same photo. With auto-advance on, rating or flagging steps to the next photo; Shift does the opposite of
 * the setting. Escape closes (over the editor) and the filmstrip scrolls to the photo review ended on; in the Cull
 * stage it goes back to the grid (`onClose`). In place, keys typed in a text field (the filter bar's search) are not
 * review keys.
 *
 * Plan 52: in place this is Cull's *One* view (`ui.cull.view: 'review'`, the label only changed): its picture is
 * `OnePicture`, on the linked viewport, so the filter bar's zoom, a double-click (1× at the point, again fit), a drag
 * (pan) and a right-click (`CullContextMenu`) work as in Two. Over the editor it stays the plain loupe.
 */
export function ReviewMode({ inline = false, onDevelop, onClose }: ReviewModeProps = {}) {
  const review = useUiStore((s) => s.review);
  if (!review) return null;
  return <ReviewDialog ids={review.ids} index={review.index} inline={inline} onDevelop={onDevelop} onClose={onClose} />;
}

function ReviewDialog({
  ids,
  index,
  inline,
  onDevelop,
  onClose,
}: {
  ids: string[];
  index: number;
  inline: boolean;
  onDevelop?: (id: string) => void;
  onClose?: () => void;
}) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const pages = useBookStore((s) => s.book?.pages);
  const autoAdvance = useUiStore((s) => s.reviewAutoAdvance);
  const dialogRef = useRef<HTMLDivElement>(null);
  const developRef = useRef(onDevelop);
  developRef.current = onDevelop;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const used = useMemo(() => usedAssetIds(pages ?? []), [pages]);

  const assetId = ids[index] ?? '';
  const file = lookup.file(assetId);
  const asset = lookup.fields(assetId);
  const rating = asset?.rating;
  const flag = asset?.flag;
  const width = file?.width;
  const height = file?.height;

  // Focus the dialog so keys never reach a focused filmstrip cell or the canvas; give focus back on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // Warm the cache for the neighbours so stepping shows them at once.
  useEffect(() => {
    for (const near of [ids[index + 1], ids[index - 1]]) {
      const url = near ? urlsOf(lookup.file(near), lookup.fields(near)?.develop, profile).proxyUrl : undefined;
      if (url) new Image().src = url;
    }
  }, [ids, index, lookup, profile]);

  useEffect(() => {
    const ui = useUiStore.getState;
    const apply = (patch: ReviewPatch, shift: boolean) => {
      const { review, reviewAutoAdvance } = ui();
      const id = review?.ids[review.index];
      if (!review || !id) return;
      const path = lookup.path(id);
      if (!path) return;
      useBookStore.getState().reviewAssets([{ assetId: id, path }], patch);
      if (reviewAutoAdvance !== shift) ui().setReviewIndex(review.index + 1);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inline && isEditableTarget(e.target)) return;
      const { review, setReviewIndex, closeReview } = ui();
      if (!review) return;
      const key = e.key.toLowerCase();
      const digit = /^Digit([0-5])$/.exec(e.code)?.[1] ?? /^Numpad([0-5])$/.exec(e.code)?.[1];
      let handled = true;
      if (e.key === 'Escape') {
        if (!inline) closeReview();
        else if (closeRef.current) closeRef.current();
        else handled = false;
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setReviewIndex(review.index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setReviewIndex(review.index - 1);
      else if (e.key === 'Home') setReviewIndex(0);
      else if (e.key === 'End') setReviewIndex(review.ids.length - 1);
      else if (digit !== undefined) apply({ rating: digit === '0' ? null : Number(digit) }, e.shiftKey);
      else if (key === 'p') apply({ flag: 'pick' }, e.shiftKey);
      else if (key === 'x') apply({ flag: 'reject' }, e.shiftKey);
      else if (key === 'u') apply({ flag: null }, e.shiftKey);
      else if (key === 'd') {
        const id = review.ids[review.index];
        if (inline) {
          if (id) developRef.current?.(id);
        } else ui().openDevelop(review.ids, review.index);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [lookup, inline]);

  const set = (patch: ReviewPatch) => {
    const path = lookup.path(assetId);
    if (path) useBookStore.getState().reviewAssets([{ assetId, path }], patch);
  };
  const setFlag = (next: AssetFlag) => set({ flag: flag === next ? null : next });
  const go = (i: number) => useUiStore.getState().setReviewIndex(i);
  const name = basename(lookup.path(assetId));

  return (
    <div
      ref={dialogRef}
      {...roleProps(inline, `${inline ? 'One' : 'Cull'}: ${name}`)}
      tabIndex={-1}
      className={`${inline ? 'absolute' : 'fixed z-50'} inset-0 flex flex-col bg-stage outline-none`}
    >
      {/* Plan 43: over the whole window (not inline), this is the top bar: the window drags from it and the traffic
          lights sit in the 78 px inset. */}
      <header
        data-tauri-drag-region={inline ? undefined : 'deep'}
        className={`flex h-11 shrink-0 items-center gap-3 border-hairline border-b ${inline ? 'px-4' : 'pr-4 pl-[78px]'} text-xs`}
      >
        <span className="truncate text-fg">{name}</span>
        <span className="font-mono text-fg-muted tabular-nums">
          {index + 1} / {ids.length}
        </span>
        {width && height && (
          <span className="font-mono text-fg-muted tabular-nums">
            {width} × {height}
          </span>
        )}
        {used.has(assetId) && <Tag>In the book</Tag>}
        <div className="ml-auto flex items-center gap-3">
          <Checkbox
            checked={autoAdvance}
            onChange={(checked) => useUiStore.getState().setPref('reviewAutoAdvance', checked)}
            label="Auto-advance"
            title="Go to the next photo after rating or flagging (hold Shift for the opposite)"
          />
          {!inline && (
            <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().closeReview()}>
              Done <span className="text-fg-muted">Esc</span>
            </Button>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-surround p-6">
        {inline ? (
          <div className="relative h-full w-full">
            <OnePicture id={assetId} profile={profile} onDevelop={onDevelop} />
          </div>
        ) : (
          <ReviewImage
            {...urlsOf(file, asset?.develop, profile)}
            status={file?.status}
            error={file?.error}
            name={name}
            dimmed={flag === 'reject'}
          />
        )}
        <StepButton side="left" disabled={index === 0} onClick={() => go(index - 1)} />
        <StepButton side="right" disabled={index === ids.length - 1} onClick={() => go(index + 1)} />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 pb-3 text-xs">
        <fieldset className="flex gap-1">
          <legend className="sr-only">Flag</legend>
          <FlagButton active={flag === 'pick'} onClick={() => setFlag('pick')} label="Keep" shortcut="P">
            <FlagIcon className="size-3" />
          </FlagButton>
          <FlagButton active={flag === 'reject'} onClick={() => setFlag('reject')} label="Reject" shortcut="X" danger>
            <RejectIcon className="size-3" />
          </FlagButton>
        </fieldset>
        <fieldset className="flex items-center">
          <legend className="sr-only">Rating</legend>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
              aria-pressed={rating === n}
              title={rating === n ? 'Clear the rating (0)' : `Rate ${n} (${n})`}
              onClick={() => set({ rating: rating === n ? null : n })}
              className={`rounded-xs px-0.5 text-xl leading-none transition-colors duration-fast ease-out outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                rating !== undefined && n <= rating ? 'text-fg' : 'text-fg-muted/50 hover:text-fg-muted'
              }`}
            >
              ★
            </button>
          ))}
        </fieldset>
        <p className="text-[11px] text-fg-muted">
          ← → step · 1–5 rate, 0 clears · P keep · X reject · U undecided · D develop
          {autoAdvance ? ' · Shift stays' : ' · Shift advances'}
          {inline && onClose ? ' · Esc grid' : ''}
        </p>
      </div>

      <Strip ids={ids} index={index} lookup={lookup} />
    </div>
  );
}

/** In place a labelled region, over the editor a modal dialog. */
export function roleProps(inline: boolean, label: string) {
  return inline
    ? { role: 'region', 'aria-label': label }
    : { role: 'dialog', 'aria-modal': true as const, 'aria-label': label };
}

interface ReviewImageProps {
  proxyUrl: string | undefined;
  thumbUrl: string | undefined;
  status: AssetFile['status'] | undefined;
  error: string | undefined;
  name: string;
  dimmed: boolean;
}

function ReviewImage({ proxyUrl, thumbUrl, status, error, name, dimmed }: ReviewImageProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = proxyUrl && failed !== proxyUrl ? proxyUrl : thumbUrl;
  if (!src) {
    return <p className="text-fg-muted text-xs">{status === 'error' ? error : 'Preparing preview…'}</p>;
  }
  return (
    <img
      key={src}
      src={src}
      alt={name}
      draggable={false}
      onError={() => setFailed(src)}
      className={`h-full w-full object-contain transition-opacity duration-base ease-out ${dimmed ? 'opacity-40' : ''}`}
    />
  );
}

function StepButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  const label = side === 'left' ? 'Previous photo' : 'Next photo';
  return (
    <Tooltip
      label={label}
      shortcut={side === 'left' ? '←' : '→'}
      className={`absolute top-1/2 ${side === 'left' ? 'left-3' : 'right-3'} flex -translate-y-1/2`}
    >
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`rounded-full bg-stage/40 p-2 text-fg outline-none hover:bg-stage/70 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-0`}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d={side === 'left' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
  );
}

interface FlagButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  shortcut: string;
  danger?: boolean;
  children: ReactNode;
}

function FlagButton({ active, onClick, label, shortcut, danger, children }: FlagButtonProps) {
  return (
    <Button
      variant="toggle"
      size="md"
      pressed={active}
      onClick={onClick}
      title={`${label} (${shortcut}); click again for undecided`}
      className={danger && active ? 'bg-danger/12 text-danger hover:bg-danger/12' : ''}
    >
      {children}
      {label}
      <span className="font-mono text-fg-muted">{shortcut}</span>
    </Button>
  );
}

/** Neighbouring thumbnails; click one to jump to it. */
function Strip({ ids, index, lookup }: { ids: string[]; index: number; lookup: PhotoLookup }) {
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const start = Math.max(0, index - STRIP_RADIUS);
  const nearby = ids.slice(start, index + STRIP_RADIUS + 1);
  return (
    <div className="flex h-20 shrink-0 items-center justify-center gap-1 overflow-hidden border-hairline border-t px-4">
      {nearby.map((id, i) => {
        const at = start + i;
        const file = lookup.file(id);
        const meta = lookup.fields(id);
        const { thumbUrl } = urlsOf(file, meta?.develop, profile);
        return (
          <button
            key={id}
            type="button"
            aria-label={`Show ${basename(lookup.path(id) || id)}`}
            aria-current={at === index}
            onClick={() => useUiStore.getState().setReviewIndex(at)}
            className={`relative size-14 shrink-0 overflow-hidden rounded-xs bg-panel outline-none transition-opacity duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent ${
              at === index ? 'ring-2 ring-fg' : 'opacity-70 hover:opacity-100'
            }`}
          >
            {thumbUrl && (
              <img
                src={thumbUrl}
                alt=""
                draggable={false}
                className={`h-full w-full object-cover ${meta?.flag === 'reject' ? 'opacity-35' : ''}`}
              />
            )}
            {meta?.flag === 'pick' && <span className="absolute top-0.5 left-0.5 size-1.5 rounded-full bg-pick" />}
            {meta?.rating !== undefined && (
              <span className="absolute right-0.5 bottom-0.5 rounded-xs bg-stage/60 px-0.5 text-[8px] text-fg leading-3">
                {meta.rating}★
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
