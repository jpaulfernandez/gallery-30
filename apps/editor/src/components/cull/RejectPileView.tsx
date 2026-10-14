import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { basename } from '../../lib/path';
import { usePhotoLookup } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { writeFlags } from '../../store/decide';
import { useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { roleProps, urlsOf } from '../review/ReviewMode';
import { Button } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell, dialogOpen } from '../ui/DialogShell';
import { EmptyState } from '../ui/EmptyState';
import { Checkbox } from '../ui/Field';
import { toast } from '../ui/Toast';
import { isEditableTarget } from './keys';
import { FlagStamp, SelectCheck, tileRings } from './marks';
import {
  closeRejectPile,
  keptByDefault,
  moveToTrash,
  outcomeText,
  type PileEntry,
  type Placement,
  placedInProjects,
  sizeLabel,
  TRASH_INLINE_MAX,
  useRejectPile,
} from './rejectPile';

/** Smallest tile width, px, and the gap between tiles. */
const TILE_MIN = 168;
const TILE_GAP = 8;

/**
 * Plan 42 (CULL_PLAN 4.5): the reject pile, a Survey-like grid of every reject of the Cull list's folders (never the
 * filtered view). U rescues the focused photo, or the marked ones (Shift or Cmd click, Cmd+A for all): they become
 * undecided and leave the pile, outside undo. The bottom bar sums the sizes and offers *Move N to the Trash…*, whose
 * dialog is the only way photos leave a folder. Esc goes back to the view the pile opened over.
 */
export function RejectPileView() {
  const entries = useRejectPile();
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(entries[0]?.key ?? '');
  const [marked, setMarked] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [columns, setColumns] = useState(1);
  const keys = useMemo(() => entries.map((e) => e.key), [entries]);
  const count = entries.length;
  const bytes = useMemo(() => entries.reduce((n, e) => n + e.size, 0), [entries]);
  const state = useRef({ keys, focus, marked, columns });
  state.current = { keys, focus, marked, columns };

  // Photos only the index knows (a collection's folders) get their thumbnails.
  useEffect(() => {
    const library = useLibraryStore.getState();
    const byFolder = new Map<string, string[]>();
    for (const e of entries) {
      if (library.folders[e.folderId]?.photos[e.relPath]?.status !== 'scanned') continue;
      byFolder.set(e.folderId, [...(byFolder.get(e.folderId) ?? []), e.relPath]);
    }
    for (const [id, relPaths] of byFolder) void library.prepare(id, relPaths);
  }, [entries]);

  // A rescued photo leaves the pile: the focus goes to the one now in its place, marks to those still there.
  const previous = useRef(keys);
  useEffect(() => {
    const before = previous.current;
    previous.current = keys;
    if (!keys.includes(focus)) {
      const at = Math.max(0, before.indexOf(focus));
      const next = before.slice(at).find((k) => keys.includes(k)) ?? keys.at(-1) ?? '';
      setFocus(next);
    }
    if (marked.some((k) => !keys.includes(k))) setMarked(marked.filter((k) => keys.includes(k)));
  }, [keys, focus, marked]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the grid mounts once the pile has a photo
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setColumns(Math.max(1, Math.floor((el.clientWidth + TILE_GAP) / (TILE_MIN + TILE_GAP))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [count > 0]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => previousFocus?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || dialogOpen()) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"]')) return;
      const { keys, focus, marked, columns } = state.current;
      const at = keys.indexOf(focus);
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (mod && e.key.toLowerCase() === 'a') setMarked(keys);
      else if (!mod && e.key.toLowerCase() === 'u') {
        const targets = marked.length > 0 ? marked : keys.includes(focus) ? [focus] : [];
        rescue(targets);
      } else if (e.key === 'Escape') {
        if (marked.length > 0) setMarked([]);
        else closeRejectPile();
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && !mod) {
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key] ?? 0;
        const to = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : at + step;
        const key = keys[Math.min(Math.max(to, 0), keys.length - 1)];
        if (key) setFocus(key);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Keep the focused tile in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a new focus
  useEffect(() => {
    gridRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [focus]);

  return (
    <div
      ref={rootRef}
      {...roleProps(true, `Rejects: ${count} photos`)}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col bg-stage outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-hairline border-b px-4 text-xs">
        <span className="text-fg">Rejects</span>
        <span className="text-fg-muted tabular-nums">
          {count} {count === 1 ? 'photo' : 'photos'}
          {count > 0 ? ` · ${sizeLabel(bytes)}` : ''}
          {marked.length > 0 ? ` · ${marked.length} marked` : ''}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={closeRejectPile}>
          Done <span className="text-fg-muted">Esc</span>
        </Button>
      </header>
      <div className="min-h-0 flex-1 scrollbar overflow-y-auto bg-surround p-3">
        {count === 0 ? (
          <EmptyState className="p-8">No rejects here. Rejected photos stay in the pile.</EmptyState>
        ) : (
          <div
            ref={gridRef}
            role="listbox"
            aria-label="Rejected photos"
            aria-multiselectable="true"
            className="grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: TILE_GAP }}
          >
            {entries.map((entry) => {
              const urls = urlsOf(lookup.file(entry.key), lookup.fields(entry.key)?.develop, profile);
              return (
                <PileTile
                  key={entry.key}
                  name={basename(entry.relPath)}
                  src={urls.thumbUrl}
                  focused={entry.key === focus}
                  marked={marked.includes(entry.key)}
                  onClick={(e) => {
                    if (e.shiftKey || e.metaKey || e.ctrlKey) {
                      setMarked((m) => (m.includes(entry.key) ? m.filter((x) => x !== entry.key) : [...m, entry.key]));
                    } else setFocus(entry.key);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-3 border-hairline border-t px-4 py-2 text-[11px] text-fg-muted">
        <span>U rescue (undecided) · ⌘A all · Shift+click mark · ← → ↑ ↓ move · Esc back</span>
        <Button variant="danger" className="ml-auto" disabled={count === 0} onClick={() => setConfirming(true)}>
          Move {count} to the Trash…
        </Button>
      </footer>
      {confirming && <TrashDialog entries={entries} bytes={bytes} onClose={() => setConfirming(false)} />}
    </div>
  );
}

/** U: the photos become undecided (outside undo) and leave the pile. */
function rescue(keys: readonly string[]): void {
  if (keys.length === 0) return;
  writeFlags(Object.fromEntries(keys.map((k) => [k, null])));
}

function PileTile({
  name,
  src,
  focused,
  marked,
  onClick,
}: {
  name: string;
  src: string | undefined;
  focused: boolean;
  marked: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the view's window key handler drives the focus and marks
    <div
      role="option"
      tabIndex={-1}
      aria-selected={marked}
      aria-current={focused}
      aria-label={name}
      onClick={onClick}
      className={`relative aspect-[3/2] min-w-0 cursor-default rounded-xs bg-stage/20 ${tileRings({ selected: marked, focused })}`}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="h-full w-full rounded-xs object-contain" />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-[11px] text-fg-muted">
          Preparing preview…
        </p>
      )}
      <span className="absolute top-1.5 left-1.5 flex items-center gap-1">
        {marked && <SelectCheck />}
        <FlagStamp flag="reject" />
      </span>
      <span className="pointer-events-none absolute right-1.5 bottom-1.5 max-w-[60%] truncate rounded-xs bg-stage/60 px-1 text-[10px] text-fg">
        {name}
      </span>
    </div>
  );
}

/** "Lisbon book", "Lisbon book and Porto", "Lisbon book and 2 other projects". */
function projectsText(titles: readonly string[]): string {
  const [first = '', second] = titles;
  if (titles.length <= 1) return first;
  if (titles.length === 2) return `${first} and ${second}`;
  return `${first} and ${titles.length - 1} other projects`;
}

/**
 * The one confirm (CULL_PLAN 4.5): the real count and size, the photos placed in a project (kept in the folder by
 * default), Cancel and *Move N to the Trash*. The move runs after the dialog closes; a toast says how many moved and
 * names the failures, and the Cull view goes back to the grid with the focus past the photos that went.
 */
export function TrashDialog({
  entries,
  bytes,
  onClose,
}: {
  entries: readonly PileEntry[];
  bytes: number;
  onClose: () => void;
}) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [keepPlaced, setKeepPlaced] = useState(true);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // The pile's ids, not the array: it is rebuilt on every book or library change, and the projects are read once.
  const ids = entries.map((e) => e.key).join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ids` stands for `entries` (read through the ref)
  useEffect(() => {
    let live = true;
    void placedInProjects(entriesRef.current).then((p) => {
      if (live) setPlacement(p);
    });
    return () => {
      live = false;
    };
  }, [ids]);

  const placed = placement?.keys.size ?? 0;
  const kept = placement ? keptByDefault(entries, placement) : new Set<string>();
  const toMove = keepPlaced ? entries.filter((e) => !kept.has(e.key)) : entries;
  const moveBytes = toMove.reduce((sum, e) => sum + e.size, 0);
  const n = entries.length;
  const unchecked = placement?.unchecked ?? [];

  const move = () => {
    const moving = [...toMove];
    onClose();
    closeRejectPile();
    useUiStore.getState().setCull({ view: 'grid' });
    const id =
      moving.length > TRASH_INLINE_MAX
        ? toast.show({ text: `Moving ${moving.length} photos to the Trash…`, progress: 'busy', durationMs: null })
        : null;
    void moveToTrash(moving).then((outcome) => {
      const failed = outcome.failed.length > 0;
      const patch = {
        text: outcomeText(outcome),
        tone: failed ? ('danger' as const) : ('default' as const),
        progress: failed ? undefined : 1,
        done: !failed,
        durationMs: failed ? null : 6000,
      };
      if (id === null) toast.show(patch);
      else toast.update(id, patch);
    });
  };

  return (
    <DialogShell title="Move to the Trash" onClose={onClose}>
      <DialogBody>
        <p>
          {toMove.length === n
            ? `Move ${n} ${n === 1 ? 'photo' : 'photos'} (${sizeLabel(bytes)})`
            : `Move ${toMove.length} of the ${n} photos (${sizeLabel(moveBytes)} of ${sizeLabel(bytes)})`}{' '}
          to the macOS Trash? Photobook cannot undo this. They stay in the Trash until you empty it.
        </p>
        {placement === null ? (
          <p className="text-fg-muted">Checking which projects use them…</p>
        ) : kept.size > 0 ? (
          <div className="space-y-2">
            {placed > 0 && (
              <p>
                {placed} of them {placed === 1 ? 'is' : 'are'} placed in <em>{projectsText(placement.titles)}</em>.
              </p>
            )}
            {unchecked.length > 0 && (
              <p>
                {unchecked.length === 1 ? '1 project' : `${unchecked.length} projects`} could not be checked (
                <em>{projectsText(unchecked)}</em>): the photos of {unchecked.length === 1 ? 'its' : 'their'} folders
                stay too.
              </p>
            )}
            <Checkbox
              checked={keepPlaced}
              onChange={setKeepPlaced}
              label={`Keep ${kept.size === 1 ? 'that one' : `those ${kept.size}`} in the folder`}
              hint={keepPlaced ? undefined : 'A project that uses them keeps them as Missing photos.'}
            />
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="danger" disabled={placement === null || toMove.length === 0} onClick={move}>
          Move {toMove.length} to the Trash
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
