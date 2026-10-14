import { useDraggable } from '@dnd-kit/core';
import {
  type LibraryPhoto,
  STORY_GROUP_BY_LABELS,
  STORY_GROUP_BYS,
  type StoryGroupBy,
  storyGroups,
} from '@photobook/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { addToProject, currentDeveloped } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { libraryKeys, projectPaths, usableSignature } from '../../store/collections';
import { libraryFolderAt, type PhotoFile, parsePhotoKey, useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import type { DragData } from '../editor/dnd';
import { LibraryFilterBar } from '../shell/LibraryFilterBar';
import { ensureLibrary, useLibraryFolders } from '../shell/useLibraryFolders';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Field';
import { DIVIDER, GroupDivider, rowSize } from './Filmstrip';
import { FlagIcon, RejectIcon } from './FilmstripCell';
import { gridRows, type Section } from './visible';

const COLUMNS = 3;
const GAP = 4;
const PAD = 8;

/**
 * The Design stage's Library tab (workflow plan 05): any imported folder's photos (the project's primary folder
 * first), with the library filters, to pull into the project. **Add** on a photo, **Add N shown**, or a drag onto the
 * page adds it (`addToProject`: an asset `{ id: newId(), ...ref }`, once hashed; a photo already in the project keeps
 * its asset). Photos in the project carry a check. The plain grid until plan 06's folder grid replaces it.
 */
export function LibraryPanel() {
  const folders = useLibraryFolders();
  const primary = useBookStore((s) => s.folder);
  const book = useBookStore((s) => s.book);
  const libraries = useBookStore((s) => s.libraries);
  const chosen = useUiStore((s) => s.libraryTabFolder);
  const view = useUiStore((s) => s.libraryView);
  const primaryId = useLibraryStore((s) => libraryFolderAt(s, primary)?.id);
  const available = folders.filter((f) => !f.missing);
  const folderId = (chosen && available.some((f) => f.id === chosen) ? chosen : primaryId) ?? available[0]?.id;
  const folder = useLibraryStore((s) => (folderId ? s.folders[folderId] : undefined));
  const [adding, setAdding] = useState(false);
  const path = folder?.path;
  const failed = folder?.error !== null && folder?.error !== undefined;
  // What the list depends on, as strings: not every thumbnail or edit that lands.
  const signature = useLibraryStore((s) =>
    usableSignature(folderId && s.folders[folderId] ? [s.folders[folderId]] : []),
  );
  const inProjectKey = useBookStore((s) =>
    view.hideUsed && s.book ? [...projectPaths(s.book, s.folder)].sort().join('\n') : '',
  );

  // Scan the folder shown (once per folder; one that failed is left alone until another is picked).
  useEffect(() => {
    if (!folderId || !path || failed) return;
    void useLibraryStore
      .getState()
      .scan(folderId)
      .catch(() => {});
    ensureLibrary(path);
  }, [folderId, path, failed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` and `inProjectKey` stand for the store reads
  const keys = useMemo(() => {
    const now = folderId ? useLibraryStore.getState().folders[folderId] : undefined;
    const state = useBookStore.getState();
    return folderId && now
      ? libraryKeys({ kind: 'folder', id: folderId }, { [folderId]: now }, libraries, view, {
          book: state.book,
          primary: state.folder,
        })
      : [];
  }, [folderId, signature, libraries, view, inProjectKey]);
  const inProject = useMemo(() => (book ? projectPaths(book, primary) : new Set<string>()), [book, primary]);
  // Plan 56: *Group by* dividers over the sorted keys (view state).
  const groupBy = view.groupBy ?? 'none';
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the photos' facts
  const sections = useMemo<Section<string>[]>(() => {
    const photos = (folderId ? useLibraryStore.getState().folders[folderId]?.photos : undefined) ?? {};
    const entries = keys.map((key) => ({ ...photos[parsePhotoKey(key)?.path ?? ''], id: key }));
    return storyGroups(entries, groupBy).map((g) => ({ key: g.key, label: g.label, items: g.ids }));
  }, [keys, groupBy, folderId, signature]);
  const toAdd = keys.filter((key) => !inProject.has(`${folder?.path}\n${parsePhotoKey(key)?.path}`));

  const add = async (list: string[]) => {
    setAdding(true);
    try {
      const ids = await addToProject(list);
      devLog('assets', 'library tab added', { photos: ids.filter(Boolean).length });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 border-line border-b p-2">
        <select
          value={folderId ?? ''}
          onChange={(e) => useUiStore.getState().setLibraryTabFolder(e.target.value || null)}
          aria-label="Library folder"
          className="min-w-0 rounded-md border border-line bg-panel-2 px-1 py-1 text-fg text-xs outline-none focus:border-accent"
        >
          {available.length === 0 && <option value="">No imported folder</option>}
          {available.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <Select
          value={groupBy}
          onChange={(e) => useUiStore.getState().setLibraryView({ groupBy: e.target.value as StoryGroupBy })}
          aria-label="Group by"
          title="Group by"
        >
          {STORY_GROUP_BYS.map((g) => (
            <option key={g} value={g}>
              {STORY_GROUP_BY_LABELS[g]}
            </option>
          ))}
        </Select>
      </div>
      <LibraryFilterBar
        count={keys.length}
        progress={folder?.busy ? `${folder.progress.prepared}/${folder.progress.total}` : null}
        projectOpen={book !== null}
      >
        <button
          type="button"
          disabled={toAdd.length === 0 || adding}
          onClick={() => void add(toAdd)}
          title="Add every photo shown here that is not in the project yet"
          className="rounded-md bg-accent px-2 py-1 font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
        >
          Add {toAdd.length} to project
        </button>
      </LibraryFilterBar>
      {keys.length === 0 ? (
        folder?.busy ? (
          <p className="p-4 text-center text-fg-muted text-xs">Scanning…</p>
        ) : (
          <EmptyState size="md" className="p-4">
            {folder && Object.keys(folder.photos).length === 0
              ? 'No photos in this folder'
              : 'No photos match these filters'}
          </EmptyState>
        )
      ) : (
        <LibraryGrid
          sections={sections}
          folderPath={folder?.path ?? ''}
          inProject={inProject}
          photos={folder?.photos ?? {}}
          entries={folder ? libraries[folder.path]?.photos : undefined}
          onAdd={(key) => void add([key])}
        />
      )}
    </div>
  );
}

interface LibraryGridProps {
  sections: Section<string>[];
  folderPath: string;
  inProject: Set<string>;
  photos: Record<string, PhotoFile>;
  entries: Record<string, LibraryPhoto> | undefined;
  onAdd: (key: string) => void;
}

function LibraryGrid({ sections, folderPath, inProject, photos, entries, onAdd }: LibraryGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const cell = Math.max(0, Math.floor((width - 2 * PAD - GAP * (COLUMNS - 1)) / COLUMNS));
  const rows = useMemo(() => gridRows(sections, COLUMNS), [sections]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowSize(rows[i], cell),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 4,
    paddingStart: PAD,
    paddingEnd: PAD - GAP,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows (plan 56's dividers) need measuring again
  useLayoutEffect(() => {
    if (cell > 0) virtualizer.measure();
  }, [cell, virtualizer, rows]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {cell > 0 &&
          virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            if (row.kind === 'divider') {
              return (
                <div
                  key={v.key}
                  className="absolute"
                  style={{
                    top: 0,
                    left: PAD,
                    right: PAD,
                    height: DIVIDER - GAP,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <GroupDivider label={row.label} count={row.count} />
                </div>
              );
            }
            return (
              <div
                key={v.key}
                className="absolute grid"
                style={{
                  top: 0,
                  left: PAD,
                  right: PAD,
                  height: cell,
                  transform: `translateY(${v.start}px)`,
                  gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
                  gap: GAP,
                }}
              >
                {row.items.map((key) => {
                  const path = parsePhotoKey(key)?.path ?? '';
                  const photo = photos[path];
                  if (!photo) return <div key={key} />;
                  const entry =
                    photo.hash && entries && Object.hasOwn(entries, photo.hash) ? entries[photo.hash] : undefined;
                  return (
                    <LibraryCell
                      key={key}
                      photoKey={key}
                      photo={photo}
                      entry={entry}
                      added={inProject.has(`${folderPath}\n${path}`)}
                      onAdd={onAdd}
                    />
                  );
                })}
              </div>
            );
          })}
      </div>
    </div>
  );
}

interface LibraryCellProps {
  photoKey: string;
  photo: PhotoFile;
  entry: LibraryPhoto | undefined;
  added: boolean;
  onAdd: (key: string) => void;
}

/** One library photo: thumbnail, flag and stars, a check when it is in the project, Add, and a drag onto the page. */
const LibraryCell = memo(function LibraryCell({ photoKey, photo, entry, added, onAdd }: LibraryCellProps) {
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const name = basename(photo.relPath);
  const thumbUrl = currentDeveloped(photo, entry?.develop, profile)?.thumbUrl ?? photo.thumbUrl;
  const data: DragData = { kind: 'library', key: photoKey };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `library:${photoKey}`,
    data,
    disabled: !photo.hash || photo.status === 'error',
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-photo-key={photoKey}
      title={`${photo.relPath}${added ? '\nIn the project' : '\nDrag onto a page, or Add'}`}
      className={`group relative aspect-square overflow-hidden rounded-sm bg-line outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        isDragging ? 'opacity-40' : ''
      } ${photo.hash ? 'cursor-grab' : 'animate-pulse'}`}
    >
      {thumbUrl && (
        <img
          src={thumbUrl}
          alt={name}
          draggable={false}
          decoding="async"
          className={`h-full w-full object-cover ${entry?.flag === 'reject' ? 'opacity-35' : ''}`}
        />
      )}
      {entry?.flag && (
        <span
          role="img"
          aria-label={entry.flag === 'pick' ? 'Pick' : 'Reject'}
          className={`absolute top-1 left-1 flex size-4 items-center justify-center rounded-full ${
            entry.flag === 'pick' ? 'bg-pick text-canvas' : 'bg-danger text-canvas'
          }`}
        >
          {entry.flag === 'pick' ? <FlagIcon /> : <RejectIcon />}
        </span>
      )}
      {entry?.rating !== undefined && (
        <span
          role="img"
          aria-label={`${entry.rating} star${entry.rating === 1 ? '' : 's'}`}
          className="absolute bottom-1 left-1 rounded-sm bg-stage/60 px-0.5 text-[9px] text-fg leading-3 tracking-tighter"
        >
          {'★'.repeat(entry.rating)}
        </span>
      )}
      {added ? (
        <span
          role="img"
          aria-label="In the project"
          className="absolute right-1 bottom-1 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-accent-ink"
        >
          ✓
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Add ${name} to the project`}
          disabled={photo.status === 'error'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onAdd(photoKey)}
          className="absolute right-1 bottom-1 rounded-sm bg-stage/70 px-1 text-[10px] text-fg opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent"
        >
          Add
        </button>
      )}
    </div>
  );
});
