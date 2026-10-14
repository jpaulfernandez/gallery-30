import { type MouseEvent, useCallback, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { keepsNativeMenu } from '../../lib/nativeShell';
import { join } from '../../lib/path';
import { revealExport } from '../../lib/tauri';
import { addToProject, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import { type CullGroups, useGroups } from '../../store/cull';
import { hasPhoto, isPhotoKey, photoMeta } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { openExport } from '../export/entryPoints';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { CullGroupItems, CullMenuItems, type CullMenuState } from './CullMenu';
import { openCompare } from './openViews';
import { openRejectPile, useRejectPile } from './rejectPile';

const MENU_WIDTH = 260;
const NO_IDS: readonly string[] = [];

/**
 * Plan 52 (ODDHALLS_LAYOUT_PLAN 3, the mouse grammar): Cull's right-click menu, the same on a grid cell, in One and on
 * either pane of Two. Keep · Reject · Undecided (the store's `reviewAssets`, one library write, never an undo step) ·
 * Develop this photo (D) · Compare with best (C, the photo against its group's suggested best) · Add to project (a
 * project open, library photos only) · Export… · the group overrides (plan 39) · Reveal in Finder · Move to Trash…
 * (only through the reject pile, plan 42), then the settings items of `CullMenuItems` (Copy, Paste, Reset, Describe,
 * Denoise). On `Menu.Context`; `useCullContextMenu` leaves text fields their system menu (the plan 43 guard).
 */
export function CullContextMenu({
  menu,
  onClose,
  onDevelop,
}: {
  menu: CullMenuState;
  onClose: () => void;
  /** Develop this photo: the stage's own (the route switches to Develop). */
  onDevelop?: (id: string) => void;
}) {
  return (
    <Menu.Context at={{ x: menu.x, y: menu.y }} label="Photo actions" onClose={onClose} width={MENU_WIDTH}>
      <CullMenuItems menu={menu} context head={<ContextHead menu={menu} onDevelop={onDevelop} />} />
    </Menu.Context>
  );
}

/** Flag `ids` in one store update (one library write per folder), outside undo. */
function flagPhotos(lookup: PhotoLookup, ids: readonly string[], patch: ReviewPatch): void {
  const targets = ids.flatMap((assetId) => {
    const path = lookup.path(assetId);
    return path ? [{ assetId, path }] : [];
  });
  if (targets.length > 0) useBookStore.getState().reviewAssets(targets, patch);
}

/**
 * The photo `id`'s best to compare against: the suggested best of its group in the list, or the next frame of the
 * group when `id` is the best. Undefined when it is in no group of two or more frames shown.
 */
export function bestOf(id: string, groups: CullGroups, list: readonly string[]): string | undefined {
  const group = groups.byPhoto.get(id);
  if (!group) return undefined;
  const shown = new Set(list);
  const frames = group.frames.filter((f) => shown.has(f));
  if (frames.length < 2 || !frames.includes(id)) return undefined;
  if (group.best !== id && shown.has(group.best)) return group.best;
  return frames[(frames.indexOf(id) + 1) % frames.length];
}

/** Compare `id` (the candidate) with its group's best (`openCompare`), coming back to Decide when it opened there. */
function compareWithBest(id: string, groups: CullGroups, list: readonly string[]): void {
  const group = groups.byPhoto.get(id);
  if (!group) return;
  const shown = new Set(list);
  const frames = group.frames.filter((f) => shown.has(f));
  const back = useUiStore.getState().cull.view === 'decide' ? 'decide' : undefined;
  openCompare({ frames, shown: id, best: group.best }, { groupFirst: true, back });
}

function ContextHead({ menu, onDevelop }: { menu: CullMenuState; onDevelop?: (id: string) => void }) {
  const lookup = usePhotoLookup();
  const list = useUiStore((s) => s.review?.ids) ?? NO_IDS;
  const groups = useGroups(list);
  const projectOpen = useBookStore((s) => s.book !== null);
  const readable = useBookStore((s) => hasPhoto(s, menu.source));
  const located = useBookStore((s) => Boolean(photoMeta(s, menu.source)?.folder));
  const rejects = useRejectPile().length;
  const count = menu.targets.length;
  const best = bestOf(menu.source, groups, list);
  // Add to project: library photos only (a project's own Cull lists its assets).
  const addable = projectOpen && menu.targets.every(isPhotoKey);
  const flag = (patch: ReviewPatch) => flagPhotos(lookup, menu.targets, patch);
  const reveal = () => {
    const meta = photoMeta(useBookStore.getState(), menu.source);
    if (!meta?.folder) return;
    revealExport(join(meta.folder, meta.path)).catch((err) =>
      devLog('cull', 'not revealed', { error: errorMessage(err) }),
    );
  };
  const add = () => {
    addToProject(menu.targets)
      .then((ids) => devLog('assets', 'added to project from the Cull menu', { photos: ids.filter(Boolean).length }))
      .catch((err) => useUiStore.getState().setSaveStatus('error', `Not added: ${errorMessage(err)}`));
  };
  return (
    <>
      <MenuItem shortcut="P" onSelect={() => flag({ flag: 'pick' })}>
        {count > 1 ? `Keep ${count} photos` : 'Keep'}
      </MenuItem>
      <MenuItem shortcut="X" onSelect={() => flag({ flag: 'reject' })}>
        {count > 1 ? `Reject ${count} photos` : 'Reject'}
      </MenuItem>
      <MenuItem shortcut="U" onSelect={() => flag({ flag: null })}>
        {count > 1 ? `Set ${count} photos undecided` : 'Undecided'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        shortcut="D"
        disabled={!onDevelop || !readable}
        onSelect={() => onDevelop?.(menu.source)}
        title="Open this photo in Develop; the Cull selection stays"
      >
        Develop this photo
      </MenuItem>
      <MenuItem
        disabled={best === undefined}
        title={best === undefined ? 'This photo is in no group' : "Side by side with its group's suggested best"}
        onSelect={() => compareWithBest(menu.source, groups, list)}
      >
        Compare with best
      </MenuItem>
      {addable && (
        <MenuItem onSelect={add} title="Add to the open project">
          {count > 1 ? `Add ${count} to project` : 'Add to project'}
        </MenuItem>
      )}
      <MenuItem shortcut="⇧⌘E" onSelect={() => openExport(menu.targets)}>
        {count > 1 ? `Export ${count} photos…` : 'Export…'}
      </MenuItem>
      {groups.groups.length > 0 && (
        <>
          <MenuSeparator />
          <CullGroupItems menu={menu} groups={groups} />
        </>
      )}
      <MenuSeparator />
      <MenuItem disabled={!located} onSelect={reveal}>
        Reveal in Finder
      </MenuItem>
      <MenuItem
        disabled={rejects === 0}
        title={
          rejects === 0
            ? 'No rejects in this folder: reject a photo first'
            : 'Rejects go to the Trash from the reject pile, where you can rescue some first'
        }
        onSelect={openRejectPile}
      >
        Move to Trash…
      </MenuItem>
    </>
  );
}

/**
 * The state of Cull's right-click menu: `onPhotoMenu(e, id)` on a photo opens it at the pointer on the selection when
 * the photo is in it, else selects the photo alone first (as Finder does). With `focus` the photo also becomes the
 * session's current one (the grid). A right-click on a text field keeps the system menu.
 */
export function useCullContextMenu() {
  const [menu, setMenu] = useState<CullMenuState | null>(null);
  const onPhotoMenu = useCallback((e: MouseEvent<Element>, id: string, focus = false) => {
    if (keepsNativeMenu(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const { review, selection, setReviewIndex, setSelection } = useUiStore.getState();
    // The selection as the list shows it: a photo the filter hides is never acted on.
    const shown = review ? selection.keys.filter((k) => review.ids.includes(k)) : [];
    const targets = shown.includes(id) ? shown : [id];
    if (!shown.includes(id)) setSelection([id], id);
    if (focus && review) setReviewIndex(review.ids.indexOf(id));
    let { clientX: x, clientY: y } = e;
    // The context-menu key sends no pointer position.
    if (x === 0 && y === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      x = r.left;
      y = r.bottom;
    }
    setMenu({ x, y, source: id, targets });
  }, []);
  const close = useCallback(() => setMenu(null), []);
  return { menu, onPhotoMenu, close };
}
