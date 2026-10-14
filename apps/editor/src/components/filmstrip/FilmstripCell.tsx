import { useDraggable } from '@dnd-kit/core';
import type { AssetFlag, DevelopSettings } from '@photobook/shared';
import { memo, useState } from 'react';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { type AssetFile, currentDeveloped, fileKey } from '../../store/assets';
import { useBookStore } from '../../store/book';
import type { DragData } from '../editor/dnd';
import { DenoiseBadge } from './DenoiseBadge';
import { LookBadge } from './LookBadge';

let firstThumbLogged = false;

interface FilmstripCellProps {
  file: AssetFile;
  /** Some page element or background references this asset. */
  used: boolean;
  /** Review stars, 1 to 5. */
  rating?: number;
  flag?: AssetFlag;
  /** The photo has develop edits. */
  edited?: boolean;
  /** The asset's develop settings: the developed thumbnail shows once it is rendered for them. */
  develop?: DevelopSettings;
  /** Name of the version (virtual copy) the project uses, shown as a badge (`v2`); absent for the master. */
  version?: string;
  /** Double-click or Enter: open review at this photo. */
  onOpen: (assetId: string) => void;
}

/**
 * One square thumbnail. Gray until the thumb arrives, then the upright 256 px JPEG cover-fit.
 * A dnd-kit draggable (id = asset id) that drops onto canvas photo slots (see editor/EditorDnd).
 * Shows the review flag (top left; rejects are dimmed), stars (bottom left), a dot (top right) on photos with
 * develop edits and the name of the version the project uses (bottom right, workflow plan 08); double-click opens review, D opens the Develop view (see useEditorShortcuts).
 * A photo that needs denoise and has it off carries a small grain badge at the top right (workflow plan 27).
 */
export const FilmstripCell = memo(function FilmstripCell({
  file,
  used,
  rating,
  flag,
  edited,
  develop,
  version,
  onOpen,
}: FilmstripCellProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const name = basename(file.relPath);
  const thumbUrl = currentDeveloped(file, develop, profile)?.thumbUrl ?? file.thumbUrl;
  const failed = file.status === 'error' || (thumbUrl !== undefined && broken === thumbUrl);
  const pending = !failed && !thumbUrl;
  const review = [flag === 'pick' ? 'Pick' : flag === 'reject' ? 'Reject' : '', rating ? `${rating} ★` : '']
    .filter(Boolean)
    .join(', ');
  const tooltip = failed
    ? `${file.relPath}\n${file.error ?? 'Could not load the thumbnail'}`
    : `${file.relPath}${review ? `\n${review}` : ''}\nDouble-click to cull, D to develop`;
  const data: DragData = { kind: 'asset', assetId: file.assetId, relPath: fileKey(file) };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: file.assetId,
    data,
    disabled: file.status === 'error',
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit's attributes make it a focusable role="button"
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-asset-id={file.assetId}
      data-status={file.status}
      title={tooltip}
      onDoubleClick={failed ? undefined : () => onOpen(file.assetId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !failed) {
          e.preventDefault();
          onOpen(file.assetId);
        } else listeners?.onKeyDown?.(e);
      }}
      className={`group relative aspect-square overflow-hidden rounded-sm bg-line outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        pending ? 'animate-pulse' : ''
      } ${isDragging ? 'opacity-40' : ''} ${failed ? '' : 'cursor-grab'}`}
    >
      {thumbUrl && !failed && (
        <img
          src={thumbUrl}
          alt={name}
          draggable={false}
          decoding="async"
          onLoad={() => {
            if (firstThumbLogged) return;
            firstThumbLogged = true;
            devLog('filmstrip', 'first thumb loaded', { url: thumbUrl });
          }}
          onError={() => {
            devLog('filmstrip', 'thumb error', { url: thumbUrl, relPath: file.relPath });
            setBroken(thumbUrl ?? null);
          }}
          className={`h-full w-full object-cover ${flag === 'reject' ? 'opacity-35' : ''}`}
        />
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-danger/10 p-1 text-center text-danger">
          <WarningIcon />
          <span className="w-full truncate text-[10px]">{name}</span>
        </div>
      )}
      {used && (
        <>
          <div className="absolute inset-0 bg-stage/40" />
          <span
            role="img"
            aria-label="Used in the book"
            className="absolute right-1 bottom-1 flex size-4 items-center justify-center rounded-full bg-accent text-accent-ink"
          >
            <CheckIcon />
          </span>
        </>
      )}
      {edited && !failed && (
        <span
          role="img"
          aria-label="Edited"
          title="Edited in Develop"
          className="absolute top-1 right-1 size-2 rounded-full border border-stage/50 bg-accent"
        />
      )}
      {!failed && (
        <DenoiseBadge
          photo={file}
          denoiseOn={!!develop?.detail.denoise}
          className={`top-1 ${edited ? 'right-4' : 'right-1'}`}
        />
      )}
      {!failed && <LookBadge look={develop?.look} />}
      {version !== undefined && !failed && (
        <span
          title={`This project uses version ${version}`}
          className={`absolute ${used ? 'right-6' : 'right-1'} bottom-1 max-w-12 truncate rounded-sm bg-stage/70 px-0.5 text-[9px] text-fg leading-3`}
        >
          {version}
        </span>
      )}
      {flag && !failed && (
        <span
          role="img"
          aria-label={flag === 'pick' ? 'Pick' : 'Reject'}
          className={`absolute top-1 left-1 flex size-4 items-center justify-center rounded-full ${
            flag === 'pick' ? 'bg-pick text-canvas' : 'bg-danger text-canvas'
          }`}
        >
          {flag === 'pick' ? <FlagIcon /> : <RejectIcon />}
        </span>
      )}
      {rating !== undefined && !failed && (
        <span
          role="img"
          aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
          className="absolute bottom-1 left-1 rounded-sm bg-stage/60 px-0.5 text-[9px] text-fg leading-3 tracking-tighter"
        >
          {'★'.repeat(rating)}
        </span>
      )}
    </div>
  );
});

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FlagIcon({ className = 'size-2.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M4 2h1v12H4zM5.5 2.5h7l-1.75 3 1.75 3h-7z" />
    </svg>
  );
}

export function RejectIcon({ className = 'size-2.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M8 2.5l6 11H2l6-11z" strokeLinejoin="round" />
      <path d="M8 7v3M8 12v.01" strokeLinecap="round" />
    </svg>
  );
}
