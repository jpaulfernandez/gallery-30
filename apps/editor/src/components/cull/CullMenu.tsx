import { groupSharpness, isDefaultDevelop } from '@photobook/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { devLog } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { type CullGroups, canMerge, canSplit, detach, mergeSelected, splitGroup, useGroups } from '../../store/cull';
import { assetDevelop, hasPhoto } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { describePhotosAction, useIndexing } from '../ai/DescribePhotos';
import { RESET_CONFIRM_ABOVE } from '../develop/BatchBar';
import { copySettings, pasteSettings, useCanPaste } from '../develop/copyPaste';
import { openDenoiseBatch } from '../develop/DenoiseBatch';
import { openExport } from '../export/entryPoints';
import { Menu, MenuItem, MenuSeparator, useMenu } from '../ui/Menu';
import { openRejectPile, useRejectPile } from './rejectPile';

const MENU_WIDTH = 240;
const NO_IDS: readonly string[] = [];

/**
 * Plan 41: *Select the group's softer frames*: the frames of `id`'s group that the list holds, all but the group's
 * suggested best (`PhotoGroup.best`: sharpness, motion and clipping). Empty when `id` is in no group, or when no
 * frame has stats (nothing ranks them; `groupSharpness`). It only selects; rejecting them is the user's X.
 */
export function softerFrames(id: string, groups: CullGroups, list: readonly string[]): string[] {
  const group = groups.byPhoto.get(id);
  if (!group) return [];
  const ranked = groupSharpness(group.frames.map((f) => ({ id: f, stats: groups.entries.get(f)?.stats })));
  if (ranked.best === null) return [];
  const inList = new Set(list);
  return group.frames.filter((f) => f !== group.best && inList.has(f));
}

export interface CullMenuState {
  x: number;
  y: number;
  /** The photo right-clicked: the source of Copy. */
  source: string;
  /** The photos Paste and Reset act on (the selection, which includes `source`). */
  targets: string[];
}

/**
 * The Cull grid's context menu (workflow plan 10): Copy settings (the remembered sections), Copy settings… (choose),
 * Paste settings onto the selection, and Reset edits of the selection, asking first above `RESET_CONFIRM_ABOVE` photos
 * as the batch bar does. Each paste or reset is one undo step. Export… (plan 11) opens the Export dialog on the selection;
 * Describe (plan 33) adds the selection to the photo index; Denoise… (plan 27) queues its denoise after a confirm.
 * Groups (plan 39): Merge into one group (the selection and the frames of their groups), Split the group before the
 * photo right-clicked, Detach the selection from its groups; overrides in the library, not undo steps. Plan 41: Select
 * the group's softer frames (`softerFrames`).
 */
export function CullMenu({ menu, onClose }: { menu: CullMenuState; onClose: () => void }) {
  return (
    <Menu.Context at={{ x: menu.x, y: menu.y }} label="Photo actions" onClose={onClose} width={MENU_WIDTH}>
      <CullMenuItems menu={menu} />
    </Menu.Context>
  );
}

/**
 * The menu's items for `menu` (also the batch pill's ⋯ menu, plan 47). With `context` (plan 52's right-click menu,
 * `CullContextMenu`, which lists Export…, the group items and Move to Trash… itself) Export…, Review rejects… and
 * Merge / Split / Detach are left out, and `head` comes first (it goes with the rest while Reset asks).
 */
export function CullMenuItems({
  menu,
  context = false,
  head,
}: {
  menu: CullMenuState;
  context?: boolean;
  head?: ReactNode;
}) {
  const { focusFirst } = useMenu();
  const [confirming, setConfirming] = useState(false);
  const canPaste = useCanPaste();
  const indexing = useIndexing();
  const readable = useBookStore((s) => hasPhoto(s, menu.source));
  const list = useUiStore((s) => s.review?.ids) ?? NO_IDS;
  const groups = useGroups(list);
  const softer = softerFrames(menu.source, groups, list);
  // Plan 42: the reject pile's entry point.
  const rejects = useRejectPile().length;
  const edited = useBookStore((s) =>
    menu.targets.reduce((n, id) => {
      const develop = assetDevelop(s, id);
      return develop && !isDefaultDevelop(develop) ? n + 1 : n;
    }, 0),
  );
  // Shift held at the press: Denoise… runs again on photos already denoised.
  const shift = useRef(false);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      shift.current = e.shiftKey;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the first item again when the confirm row shows
  useEffect(() => {
    if (confirming) focusFirst();
  }, [confirming]);

  const reset = () => {
    const changed = useBookStore.getState().resetDevelopMany(menu.targets);
    devLog('develop', 'reset edits from the Cull menu', { photos: menu.targets.length, changed });
  };
  const count = menu.targets.length;

  if (confirming) {
    return (
      <>
        <p className="px-2 py-1.5 text-fg">
          Reset edits of {edited} photo{edited === 1 ? '' : 's'}?
        </p>
        <MenuItem danger onSelect={reset}>
          Reset
        </MenuItem>
        <MenuItem>Cancel</MenuItem>
      </>
    );
  }
  return (
    <>
      {head}
      <MenuItem disabled={!readable} shortcut="⇧⌘C" onSelect={() => copySettings(menu.source)}>
        Copy settings
      </MenuItem>
      <MenuItem disabled={!readable} shortcut="⌥⇧⌘C" onSelect={() => useUiStore.getState().openCopyDialog(menu.source)}>
        Copy settings…
      </MenuItem>
      <MenuItem disabled={!canPaste} shortcut="⇧⌘V" onSelect={() => void pasteSettings(menu.targets)}>
        {count > 1 ? `Paste settings to ${count} photos` : 'Paste settings'}
      </MenuItem>
      <MenuItem
        disabled={edited === 0}
        keepOpen={edited > RESET_CONFIRM_ABOVE}
        onSelect={edited > RESET_CONFIRM_ABOVE ? () => setConfirming(true) : reset}
      >
        {count > 1 ? `Reset edits of ${count} photos` : 'Reset edits'}
      </MenuItem>
      <MenuSeparator />
      {!context && (
        <MenuItem shortcut="⇧⌘E" onSelect={() => openExport(menu.targets)}>
          {count > 1 ? `Export ${count} photos…` : 'Export…'}
        </MenuItem>
      )}
      <MenuItem
        disabled={indexing}
        title={indexing ? 'Describing photos…' : undefined}
        onSelect={() => void describePhotosAction(menu.targets)}
      >
        {count > 1 ? `Describe ${count} photos` : 'Describe photo'}
      </MenuItem>
      <MenuItem
        title="Denoise in the background (Shift: also run again on photos already denoised)"
        onSelect={() => openDenoiseBatch(menu.targets, { force: shift.current })}
      >
        {count > 1 ? `Denoise ${count} photos…` : 'Denoise…'}
      </MenuItem>
      {!context && (
        <MenuItem
          disabled={rejects === 0}
          title="Every reject of this folder: rescue them or move them to the Trash"
          onSelect={openRejectPile}
        >
          Review rejects…
        </MenuItem>
      )}
      {groups.groups.length > 0 && (
        <>
          <MenuSeparator />
          {!context && <CullGroupItems menu={menu} groups={groups} />}
          <MenuItem
            disabled={softer.length === 0}
            title="Select every frame of this group but its suggested best (X then rejects them)"
            onSelect={() => useUiStore.getState().setSelection(softer)}
          >
            Select the group's softer frames
          </MenuItem>
        </>
      )}
    </>
  );
}

/**
 * Plan 39's group overrides for `menu` (Merge into one group, Split group here, Detach), on the Cull list's `groups`;
 * nothing when the list has no group. Shared by `CullMenuItems` and plan 52's `CullContextMenu`.
 */
export function CullGroupItems({ menu, groups }: { menu: CullMenuState; groups: CullGroups }) {
  if (groups.groups.length === 0) return null;
  const grouped = menu.targets.filter((id) => groups.byPhoto.has(id)).length;
  return (
    <>
      <MenuItem disabled={!canMerge(menu.targets, groups)} onSelect={() => void mergeSelected(menu.targets, groups)}>
        Merge into one group
      </MenuItem>
      <MenuItem
        disabled={!canSplit(menu.source, groups)}
        title="Split the group before this photo"
        onSelect={() => void splitGroup(menu.source, groups)}
      >
        Split group here
      </MenuItem>
      <MenuItem disabled={grouped === 0} onSelect={() => void detach(menu.targets, groups)}>
        {grouped > 1 ? `Detach ${grouped} from their groups` : 'Detach from group'}
      </MenuItem>
    </>
  );
}
