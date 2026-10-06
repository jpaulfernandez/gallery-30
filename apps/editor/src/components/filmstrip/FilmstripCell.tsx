import { useDraggable } from '@dnd-kit/core';
import { memo, useState } from 'react';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import type { AssetFile } from '../../store/assets';
import type { DragData } from '../editor/dnd';

let firstThumbLogged = false;

interface FilmstripCellProps {
  file: AssetFile;
  /** Some page element or background references this asset. */
  used: boolean;
}

/**
 * One square thumbnail. Gray until the thumb arrives, then the upright 256 px JPEG cover-fit.
 * A dnd-kit draggable (id = asset id) that drops onto canvas photo slots (see editor/EditorDnd).
 */
export const FilmstripCell = memo(function FilmstripCell({ file, used }: FilmstripCellProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const name = basename(file.relPath);
  const failed = file.status === 'error' || (file.thumbUrl !== undefined && broken === file.thumbUrl);
  const pending = !failed && !file.thumbUrl;
  const tooltip = failed ? `${file.relPath}\n${file.error ?? 'Could not load the thumbnail'}` : file.relPath;
  const data: DragData = { kind: 'asset', assetId: file.assetId, relPath: file.relPath };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: file.assetId,
    data,
    disabled: file.status === 'error',
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-asset-id={file.assetId}
      data-status={file.status}
      title={tooltip}
      className={`relative aspect-square overflow-hidden rounded-sm bg-line outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        pending ? 'animate-pulse' : ''
      } ${isDragging ? 'opacity-40' : ''} ${failed ? '' : 'cursor-grab'}`}
    >
      {file.thumbUrl && !failed && (
        <img
          src={file.thumbUrl}
          alt={name}
          draggable={false}
          decoding="async"
          onLoad={() => {
            if (firstThumbLogged) return;
            firstThumbLogged = true;
            devLog('filmstrip', 'first thumb loaded', { url: file.thumbUrl });
          }}
          onError={() => {
            devLog('filmstrip', 'thumb error', { url: file.thumbUrl, relPath: file.relPath });
            setBroken(file.thumbUrl ?? null);
          }}
          className="h-full w-full object-cover"
        />
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/40 p-1 text-center text-red-300">
          <WarningIcon />
          <span className="w-full truncate text-[10px]">{name}</span>
        </div>
      )}
      {used && (
        <>
          <div className="absolute inset-0 bg-black/40" />
          <span
            role="img"
            aria-label="Used in the book"
            className="absolute right-1 bottom-1 flex size-4 items-center justify-center rounded-full bg-accent text-white"
          >
            <CheckIcon />
          </span>
        </>
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

function WarningIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <path d="M8 2.5l6 11H2l6-11z" strokeLinejoin="round" />
      <path d="M8 7v3M8 12v.01" strokeLinecap="round" />
    </svg>
  );
}
