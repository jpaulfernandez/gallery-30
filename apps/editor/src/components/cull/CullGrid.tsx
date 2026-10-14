import {
  type AssetFlag,
  GROUP_BY_KEYS,
  GROUP_BY_LABELS,
  type GroupByEntry,
  type GroupByKey,
  type GroupBySection,
  groupBy,
  LENS_LABELS,
  type LensKind,
  lensDetail,
  lensesIn,
} from '@photobook/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { basename } from '../../lib/path';
import { type AssetFile, currentDeveloped, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import {
  type CullGroups,
  type CullUnit,
  cullUnits,
  expandGroup,
  groupCounts,
  setGrouped,
  shownFrame,
  useCullStore,
  useGroups,
} from '../../store/cull';
import { openDecide } from '../../store/decide';
import { useLensReading } from '../../store/lenses';
import { type CullGroupBy, rangeOf, useUiStore } from '../../store/ui';
import { useBatchProgress } from '../develop/BatchBar';
import { copySettings, PasteNotice, pastePrevious, pasteSettings } from '../develop/copyPaste';
import { openDenoiseBatch } from '../develop/DenoiseBatch';
import { openExport } from '../export/entryPoints';
import { DenoiseBadge } from '../filmstrip/DenoiseBadge';
import { Button } from '../ui/Button';
import { dialogOpen } from '../ui/DialogShell';
import { Select } from '../ui/Field';
import { Menu } from '../ui/Menu';
import { PILL_CLEARANCE, Pill, PillCount, PillDivider } from '../ui/Pill';
import { Tooltip } from '../ui/Tooltip';
import { CullContextMenu, useCullContextMenu } from './CullContextMenu';
import { CullMenuItems } from './CullMenu';
import { type CullAction, cullKeyAction, isEditableTarget } from './keys';
import { FlagStamp, SelectCheck, useChanged, WorkLine } from './marks';
import { openCompare, openSurvey } from './openViews';

/** Gap between cells and the grid's padding, px (DESIGN_NOTES: 4 px gap). */
const GAP = 4;
const PAD = 12;
/** Height of a *Group by* divider row, px (plan 53). */
export const DIVIDER_HEIGHT = 28;
/** Plan 47: cells past this many appear with the last one's delay when a grid opens (`--stagger` apart). */
export const STAGGER_CAP = 24;
/** How long a grid that opens carries `data-opening` (the staggered cells have all appeared by then). */
const OPENING_MS = 2000;

/** The list the grid last opened on: coming back to it (from One, Compare, Survey) does not stagger again. */
let openedIds: readonly string[] | null = null;

export interface CullGridProps {
  /** D: develop this photo (the Cull stage switches to Develop). */
  onDevelop?: (id: string) => void;
  /** False: no key handler (the kitchen sink's live grid, whose keys must not write a library). Default true. */
  keys?: boolean;
}

/**
 * The Cull grid (workflow plan 06): the photos of the `review` session (the list the stage shows, fixed while its
 * filters stay the same) as a virtualized full-window grid of 3 to 8 columns (`ui.cull.columns`). The focused photo is
 * the session's current one, so Space or Enter opens `ReviewMode` on it and Escape there comes back here, at the
 * scroll offset kept in `ui.cull.scrollTop`; C opens Compare and N Survey (plan 07), Enter the Decide pass (plan 40). Click, Shift+click and Cmd+click select (`ui.selection`); the rating and
 * flag keys act on the selection, or the focused photo when nothing is selected, in one `reviewAssets` call. Keys:
 * `cullKeyAction`. Develop settings (plan 10): Cmd+Shift+C copies the focused photo's, Cmd+Shift+V pastes onto the
 * selection (else the focused photo), Cmd+Alt+V pastes from the photo before the focused one; a right-click opens
 * `CullContextMenu` (plan 52) on the selection, selecting the photo first when it is not in it.
 *
 * Mouse (plan 52, ODDHALLS_LAYOUT_PLAN 3): a double-click opens One (`ReviewMode`) on the photo; a drag from anywhere
 * in the grid draws a marquee that selects the cells it touches (Shift or Cmd adds to the selection), and the click
 * that ends a marquee selects nothing more.
 *
 * Groups (plan 39): with `ui.cull.grouped` on, the list is laid out as units (`cullUnits`): a burst or re-shot subject
 * is one cell showing one frame (`shownFrame`), with a stacked edge and a `+N` badge holding the group's kept and
 * rejected counts. G (or the badge) opens the focused group in place (`ui.cull.expanded`: its frames take whole rows
 * with an accent bar on the left) and closes it again; `,` `.` step the shown frame of a collapsed group; Cmd+G selects
 * the group. Focus and selection stay photo ids: a collapsed group is focused through its shown frame, so the rating,
 * flag, Review and Develop keys act on that frame, and Cmd+A, filters and the counts stay photo-keyed.
 *
 * Group by (plan 53, ODDHALLS_LAYOUT_PLAN 3 *Groupings*): with `ui.cull.groupBy` set (Hour, Day, Camera, Lens, Place), the
 * units are laid out under labelled divider rows (`groupBy` in shared, each unit by its first frame); a click on a
 * divider collapses its section. Dividers only lay out: the list, the selection, the units and the keys stay as they
 * are (the arrows move over the cells shown; up and down skip the divider rows).
 *
 * Skin (plan 47, ODDHALLS_UI_PLAN 3): 4 px cells on the surround that lift on hover; selected is a white ring and a
 * check; the focused cell gets the one `accent` ring, a single element that slides between cells, so arrowing
 * re-renders no cell. While photos are selected the floating batch pill (`ui/Pill`) shows at the foot and the grid's
 * end padding grows by `PILL_CLEARANCE`, so the last row is never under it. A grid that opens on a new list shows its
 * cells in order, `--stagger` apart (`data-opening`).
 */
export function CullGrid({ onDevelop, keys = true }: CullGridProps) {
  const review = useUiStore((s) => s.review);
  if (!review) return null;
  return <Grid ids={review.ids} focus={review.index} onDevelop={onDevelop} keys={keys} />;
}

/** One cell of the grid: a photo (a frame of the group open in place when `group` is set) or a collapsed group. */
type CellModel =
  | { kind: 'photo'; id: string; group?: string }
  | {
      kind: 'group';
      unit: Extract<CullUnit, { kind: 'group' }>;
      /** The frame the cell shows and is focused through. */
      shown: string;
      kept: number;
      rejected: number;
    };

/** A *Group by* divider row (plan 53): its section's key and label, and how many photos it holds. */
export interface GridDivider {
  key: string;
  label: string;
  count: number;
  collapsed: boolean;
}

/** The grid's cells in rows: flat cell indexes per row, and the rows of the group open in place. */
interface GridLayout {
  cells: CellModel[];
  /** A divider row has no cells (plan 53). */
  rows: { cells: number[]; group: boolean; divider?: GridDivider }[];
  /** Flat cell index to row. */
  rowOf: number[];
  /** Photo id to the cell that holds it (a collapsed group's cell for each of its frames). */
  cellOf: Map<string, number>;
}

/** The photo a cell stands for: its own, or a collapsed group's shown frame. */
const cellPhoto = (cell: CellModel): string => (cell.kind === 'photo' ? cell.id : cell.shown);

/** The facts *Group by* reads of a photo (plan 53). */
export type GroupByOf = (id: string) => Omit<GroupByEntry, 'id'>;

/** Grid options of plan 53: the *Group by* key, each photo's facts, and the sections collapsed (by key). */
interface GridSections {
  by: GroupByKey;
  entryOf: GroupByOf;
  collapsed: ReadonlySet<string>;
}

/**
 * Lay the units of `ids` out in rows of `columns` cells. The group `expanded` starts a new row, its frames fill whole
 * rows, and the next unit starts a new row after them. With `sections` (plan 53) the units are placed under a divider
 * row per *Group by* section, each unit by its first frame; a collapsed section has its divider and no cells.
 */
function gridLayout(
  ids: readonly string[],
  groups: CullGroups | null,
  columns: number,
  expanded: string | null,
  flagOf: (id: string) => AssetFlag | undefined,
  focused: string | undefined,
  shownBy: Record<string, string>,
  sections: GridSections | null = null,
): GridLayout {
  const cells: CellModel[] = [];
  const rows: GridLayout['rows'] = [];
  const rowOf: number[] = [];
  const cellOf = new Map<string, number>();
  let row: number[] = [];
  const close = (group: boolean) => {
    if (row.length === 0) return;
    rows.push({ cells: row, group });
    row = [];
  };
  const add = (cell: CellModel, group: boolean) => {
    if (row.length === columns) close(group);
    const at = cells.length;
    cells.push(cell);
    row.push(at);
    rowOf[at] = rows.length;
    if (cell.kind === 'photo') cellOf.set(cell.id, at);
    else for (const id of cell.unit.frames) cellOf.set(id, at);
  };
  const place = (unit: CullUnit) => {
    if (unit.kind === 'photo') add({ kind: 'photo', id: unit.id }, false);
    else if (unit.group.id === expanded) {
      close(false);
      for (const id of unit.frames) add({ kind: 'photo', id, group: unit.group.id }, true);
      close(true);
    } else if (groups) {
      const shown = shownFrame(unit, groups, flagOf, focused, shownBy[unit.group.id]);
      add({ kind: 'group', unit, shown, ...groupCounts(unit.frames, flagOf) }, false);
    }
  };
  const units = cullUnits(ids, groups);
  if (!sections) units.forEach(place);
  else {
    // Dividers only insert rows: the units keep the list's order, and a divider starts each run of units of one
    // section, so the cells read in `ids` order (Shift ranges, One's and Two's steps agree with the grid).
    const first = (u: CullUnit) => (u.kind === 'photo' ? u.id : (u.frames[0] ?? ''));
    const entries = units.map((u, i) => ({ ...sections.entryOf(first(u)), id: String(i) }));
    const sectionOf: GroupBySection[] = [];
    for (const section of groupBy(entries, sections.by)) for (const i of section.ids) sectionOf[Number(i)] = section;
    const runs: { section: GroupBySection; members: CullUnit[] }[] = [];
    units.forEach((unit, i) => {
      const section = sectionOf[i] as GroupBySection;
      const last = runs[runs.length - 1];
      if (last && last.section === section) last.members.push(unit);
      else runs.push({ section, members: [unit] });
    });
    for (const { section, members } of runs) {
      close(false);
      const count = members.reduce((n, u) => n + (u.kind === 'photo' ? 1 : u.frames.length), 0);
      const collapsed = sections.collapsed.has(section.key);
      rows.push({ cells: [], group: false, divider: { key: section.key, label: section.label, count, collapsed } });
      if (!collapsed) members.forEach(place);
    }
  }
  close(false);
  return { cells, rows, rowOf, cellOf };
}

/** Each row's top in the grid's content, px, and the content's end (`tops[rows.length]`) before the end padding. */
export function rowTops(rows: readonly { divider?: unknown }[], cell: number): number[] {
  const tops = [PAD];
  for (const row of rows) tops.push((tops[tops.length - 1] ?? PAD) + (row.divider ? DIVIDER_HEIGHT : cell + GAP));
  return tops;
}

/** Rate or flag photos in one store update (one library write per folder). Returns how many were changed. */
export function reviewPhotos(lookup: PhotoLookup, ids: readonly string[], patch: ReviewPatch): number {
  const targets = ids.flatMap((assetId) => {
    const path = lookup.path(assetId);
    return path ? [{ assetId, path }] : [];
  });
  if (targets.length > 0) useBookStore.getState().reviewAssets(targets, patch);
  return targets.length;
}

function Grid({
  ids,
  focus,
  onDevelop,
  keys,
}: {
  ids: string[];
  focus: number;
  onDevelop?: (id: string) => void;
  keys: boolean;
}) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const badgesOf = useLensBadges();
  const columns = useUiStore((s) => s.cull.columns);
  const grouped = useUiStore((s) => s.cull.grouped);
  const expanded = useUiStore((s) => s.cull.expanded);
  const selection = useUiStore((s) => s.selection);
  const autoAdvance = useUiStore((s) => s.reviewAutoAdvance);
  const showStars = useUiStore((s) => s.cull.showStars);
  const shownBy = useCullStore((s) => s.shown);
  const allGroups = useGroups(ids);
  const groups = grouped && allGroups.groups.length > 0 ? allGroups : null;
  const focusedId = ids[focus];
  // Plan 53: *Group by* dividers; the collapsed sections are remembered per machine, per key (`ui.cull.collapsed`).
  const by = useUiStore((s) => s.cull.groupBy) ?? 'none';
  const collapsedList = useUiStore((s) => (by === 'none' ? undefined : s.cull.collapsed?.[by]));
  const collapsedKeys = useMemo<ReadonlySet<string>>(
    () => (collapsedList ? new Set(collapsedList) : NO_KEYS),
    [collapsedList],
  );
  const sections = useMemo<GridSections | null>(
    () =>
      by === 'none'
        ? null
        : {
            by,
            collapsed: collapsedKeys,
            entryOf: (id) => {
              const f = lookup.file(id);
              return f ? { taken: f.taken, make: f.make, model: f.model, lens: f.lens, gps: f.gps } : {};
            },
          },
    [by, collapsedKeys, lookup],
  );
  const layout = useMemo(
    () =>
      gridLayout(
        ids,
        groups,
        columns,
        expanded,
        (id) => lookup.fields(id)?.flag ?? undefined,
        focusedId,
        shownBy,
        sections,
      ),
    [ids, groups, columns, expanded, lookup, focusedId, shownBy, sections],
  );
  // A click on a divider collapses (or opens) every run of that section. The focus never stays on a hidden photo: it
  // moves to the next shown cell after it, else the one before (a selection of just that photo moves with it).
  const onDivider = useCallback(
    (key: string) => {
      if (by === 'none') return;
      const ui = useUiStore.getState();
      const all = ui.cull.collapsed ?? {};
      const keys = new Set(all[by] ?? []);
      const collapsing = !keys.has(key);
      if (collapsing) keys.add(key);
      else keys.delete(key);
      const { review, selection } = ui;
      const focused = review?.ids[review.index];
      const { rows, cells, cellOf } = layoutRef.current;
      const at = focused === undefined ? undefined : cellOf.get(focused);
      if (collapsing && review && focused !== undefined && at !== undefined) {
        const hidden = new Set<number>();
        let inSection = false;
        for (const row of rows) {
          if (row.divider) inSection = row.divider.key === key;
          else if (inSection) for (const c of row.cells) hidden.add(c);
        }
        if (hidden.has(at)) {
          let target: number | undefined;
          for (let i = at + 1; i < cells.length && target === undefined; i++) if (!hidden.has(i)) target = i;
          for (let i = at - 1; i >= 0 && target === undefined; i--) if (!hidden.has(i)) target = i;
          const cell = target === undefined ? undefined : cells[target];
          if (cell) {
            const to = cellPhoto(cell);
            ui.setReviewIndex(review.ids.indexOf(to));
            if (selection.keys.length === 1 && selection.keys[0] === focused) ui.setSelection([to], to);
          }
        }
      }
      ui.setCull({ collapsed: { ...all, [by]: [...keys] } });
    },
    [by],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** The saved scroll offset has been applied; until then scroll events are not saved. */
  const restored = useRef(false);
  const developRef = useRef(onDevelop);
  developRef.current = onDevelop;
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const { menu, onPhotoMenu, close: closeMenu } = useCullContextMenu();
  const [marquee, setMarquee] = useState<Rect | null>(null);
  /** The click that ends a marquee drag is not a cell click. */
  const marqueed = useRef(false);
  // Only a list that opens at the top staggers: one opened scrolled down (back from One) shows its cells at once.
  const [opening, setOpening] = useState(() => ids !== openedIds && useUiStore.getState().cull.scrollTop === 0);
  const count = selection.keys.length;
  const pill = count > 0;
  const padEnd = PAD - GAP + (pill ? PILL_CLEARANCE : 0);

  // A new list opens with the stagger, once; `data-opening` goes after it so a scroll never staggers again.
  useEffect(() => {
    openedIds = ids;
    if (!opening) return;
    const timer = setTimeout(() => setOpening(false), OPENING_MS);
    return () => clearTimeout(timer);
  }, [ids, opening]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cell = Math.max(0, Math.floor((width - 2 * PAD - GAP * (columns - 1)) / columns));
  const rows = layout.rows.length;
  const tops = useMemo(() => rowTops(layout.rows, cell), [layout, cell]);
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (layout.rows[i]?.divider ? DIVIDER_HEIGHT : cell + GAP),
    overscan: 3,
    paddingStart: PAD,
    paddingEnd: padEnd,
  });
  const totalSize = virtualizer.getTotalSize();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout (dividers, collapsed sections) re-measures
  useLayoutEffect(() => {
    if (cell > 0) virtualizer.measure();
  }, [cell, virtualizer, layout]);

  // Coming back from Review: scroll to where the grid was, once rows have their real height. The first pass with a
  // width can still size rows by the zero-width estimate (which would clamp the offset), so the restore is done once
  // the offset is reached or the rows are measured; an offset the list is now too short for stays clamped (and the
  // grid saves its scroll again from then on).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (restored.current || !el || cell === 0) return;
    const target = useUiStore.getState().cull.scrollTop;
    el.scrollTop = target;
    const measured = totalSize === (tops[rows] ?? PAD) + padEnd;
    if (Math.abs(el.scrollTop - target) <= 1 || measured) restored.current = true;
  }, [cell, rows, totalSize, padEnd, tops]);

  // Keep the focused photo's row in view (after the restore, so Review and back does not move the grid needlessly).
  const focusedCell = focusedId === undefined ? undefined : layout.cellOf.get(focusedId);
  const focusRow = focusedCell === undefined ? 0 : (layout.rowOf[focusedCell] ?? 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize changes when the restore above completes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    // A focused photo in a collapsed section has no cell: nothing to keep in view.
    if (!el || cell === 0 || !restored.current || focusedCell === undefined) return;
    const top = tops[focusRow] ?? PAD;
    // The pill covers the foot of the grid while it shows: the focused row stays above it.
    const foot = el.clientHeight - (pill ? PILL_CLEARANCE : 0);
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - PAD);
    else if (top + cell > el.scrollTop + foot) el.scrollTop = top + cell + PAD - foot;
  }, [focusRow, columns, cell, totalSize]);

  // Focus the grid so arrow keys never scroll the page or reach a sidebar link (not while typing in the search).
  useEffect(() => {
    if (!isEditableTarget(document.activeElement)) scrollRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!keys) return;
    const ui = useUiStore.getState;
    const moveTo = (next: number, extend: boolean) => {
      const { review, selection, setReviewIndex, setSelection, selectRange } = ui();
      if (!review) return;
      const list = review.ids;
      const at = Math.min(Math.max(next, 0), list.length - 1);
      const from = list[review.index];
      const to = list[at];
      if (!to) return;
      setReviewIndex(at);
      if (extend) {
        if (selection.anchor !== null && list.includes(selection.anchor)) selectRange(list, to);
        else if (from) setSelection(rangeOf(list, from, to), from);
      } else if (selection.keys.length > 0) setSelection([to], to);
    };
    /** Focus cell `at` (clamped): its photo, or a collapsed group's shown frame. */
    const moveToCell = (at: number, extend: boolean) => {
      const { cells } = layoutRef.current;
      const target = cells[Math.min(Math.max(at, 0), cells.length - 1)];
      const list = ui().review?.ids;
      if (target && list) moveTo(list.indexOf(cellPhoto(target)), extend);
    };
    /** The focused cell's flat index, and the cell. */
    const focusedCellOf = () => {
      const review = ui().review;
      const id = review?.ids[review.index];
      const at = id === undefined ? undefined : layoutRef.current.cellOf.get(id);
      return at === undefined ? null : { at, cell: layoutRef.current.cells[at] as CellModel, id: id as string };
    };
    /** The focused photo's group frames in the list (a collapsed cell or the group open in place), else null. */
    const focusedGroup = () => {
      const focused = focusedCellOf();
      if (!focused) return null;
      if (focused.cell.kind === 'group') return { ...focused.cell.unit, cell: focused.cell };
      const groupId = focused.cell.group;
      if (groupId === undefined) return null;
      const group = groupsRef.current?.byPhoto.get(focused.id);
      const list = new Set(ui().review?.ids ?? []);
      return group ? { group, frames: group.frames.filter((id) => list.has(id)), cell: focused.cell } : null;
    };
    const run = (action: CullAction) => {
      const { review, selection, cull, reviewAutoAdvance, setSelection, clearSelection, setCull } = ui();
      if (!review) return;
      const focused = review.ids[review.index];
      const current = focusedCellOf()?.at ?? 0;
      switch (action.type) {
        case 'move': {
          const { cells, rows, rowOf } = layoutRef.current;
          if (action.to === 'home' || action.to === 'end') {
            moveToCell(action.to === 'home' ? 0 : cells.length - 1, action.extend);
            return;
          }
          if (action.to === 'left' || action.to === 'right') {
            moveToCell(current + (action.to === 'left' ? -1 : 1), action.extend);
            return;
          }
          const row = rowOf[current] ?? 0;
          // Divider rows (plan 53) hold no cells: up and down go to the next row of cells.
          const dir = action.to === 'up' ? -1 : 1;
          let next = row + dir;
          while (rows[next]?.cells.length === 0) next += dir;
          const target = rows[next];
          if (!target) {
            moveToCell(action.to === 'up' ? 0 : cells.length - 1, action.extend);
            return;
          }
          const column = current - (rows[row]?.cells[0] ?? 0);
          moveToCell(target.cells[Math.min(column, target.cells.length - 1)] ?? current, action.extend);
          return;
        }
        case 'rate':
        case 'flag': {
          const targets = selection.keys.length > 0 ? selection.keys : focused ? [focused] : [];
          const patch: ReviewPatch = action.type === 'rate' ? { rating: action.rating } : { flag: action.flag };
          reviewPhotos(lookupRef.current, targets, patch);
          // One photo: auto-advance like Review (to the next cell); a batch stays put.
          if (targets.length === 1 && reviewAutoAdvance !== action.shift) moveToCell(current + 1, false);
          return;
        }
        case 'develop':
          if (focused) developRef.current?.(focused);
          return;
        case 'review':
          setCull({ view: 'review' });
          return;
        case 'decide':
          openDecide();
          return;
        case 'selectAll':
          setSelection(review.ids, selection.anchor ?? focused ?? null);
          return;
        case 'clear':
          clearSelection();
          return;
        case 'zoom':
          setCull({ columns: cull.columns - action.dir });
          return;
        case 'compare': {
          const cell = focusedCellOf()?.cell;
          if (cell?.kind === 'group') {
            openCompare({ frames: cell.unit.frames, shown: cell.shown, best: cell.unit.group.best });
          } else openCompare();
          return;
        }
        case 'survey':
          openSurvey(lookupRef.current, focusedGroup()?.frames);
          return;
        case 'copy':
          if (!focused) return;
          if (action.dialog) ui().openCopyDialog(focused);
          else copySettings(focused);
          return;
        case 'paste': {
          if (!focused) return;
          const targets = selection.keys.length > 0 ? selection.keys : [focused];
          if (action.previous) pastePrevious(review.ids, focused, targets);
          else void pasteSettings(targets);
          return;
        }
        case 'expand': {
          const group = focusedGroup();
          if (group) expandGroup(group.cell.kind === 'group' ? group.group.id : null);
          return;
        }
        case 'frame': {
          const cell = focusedCellOf()?.cell;
          if (cell?.kind !== 'group') return;
          const { frames, group } = cell.unit;
          const next = frames[(frames.indexOf(cell.shown) + action.dir + frames.length) % frames.length];
          if (!next) return;
          useCullStore.getState().setShown(group.id, next);
          moveTo(review.ids.indexOf(next), false);
          return;
        }
        case 'selectGroup': {
          const frames = focusedGroup()?.frames;
          if (frames && frames.length > 0) setSelection(frames, focused ?? frames[0] ?? null);
          return;
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return;
      // A dialog (Copy Settings) owns every key while it is open, also with the focus dropped to the page.
      if (dialogOpen()) return;
      const action = cullKeyAction(e);
      if (!action) return;
      // Escape with nothing selected is not the grid's: it reaches whatever else listens.
      if (action.type === 'clear' && ui().selection.keys.length === 0) return;
      // Space and Enter on a focused button or link (the filter bar, the sidebar) press it.
      if (
        (action.type === 'review' || action.type === 'decide') &&
        e.target instanceof Element &&
        e.target.closest('a, button, select, summary')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      run(action);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [keys]);

  // Stable handlers (they read the store when called), so a cell re-renders only when its own props change. `index`
  // is the cell's flat index; a collapsed group acts through its shown frame.
  const photoAt = useCallback((index: number): string | undefined => {
    const cell = layoutRef.current.cells[index];
    return cell ? cellPhoto(cell) : undefined;
  }, []);
  const onCellClick = useCallback(
    (index: number, e: MouseEvent) => {
      const { review, setReviewIndex, setSelection, toggleSelected, selectRange } = useUiStore.getState();
      const list = review?.ids ?? [];
      const id = photoAt(index);
      if (!id) return;
      if (e.shiftKey) selectRange(list, id);
      else if (e.metaKey || e.ctrlKey) toggleSelected(id);
      else setSelection([id], id);
      setReviewIndex(list.indexOf(id));
    },
    [photoAt],
  );
  const openReview = useCallback(
    (index: number) => {
      const { review, setReviewIndex, setCull } = useUiStore.getState();
      const id = photoAt(index);
      if (!id || !review) return;
      setReviewIndex(review.ids.indexOf(id));
      setCull({ view: 'review' });
    },
    [photoAt],
  );
  // Right-click: act on the selection, or select this photo alone when it is not in it (as Finder does).
  const onCellMenu = useCallback(
    (index: number, e: MouseEvent) => {
      const id = photoAt(index);
      if (!id || !useUiStore.getState().review) return;
      onPhotoMenu(e, id, true);
    },
    [photoAt, onPhotoMenu],
  );
  const onExpand = useCallback((groupId: string) => {
    const { cull } = useUiStore.getState();
    expandGroup(cull.expanded === groupId ? null : groupId);
  }, []);

  const selected = new Set(selection.keys);
  // The focus ring: one element over the focused cell (its row and column), moved by a transition.
  const cellWidth = Math.max(0, (width - 2 * PAD - GAP * (columns - 1)) / columns);
  const sizeRef = useRef({ cell, cellWidth, tops });
  sizeRef.current = { cell, cellWidth, tops };

  // The marquee (plan 52): press, move past the slop, and every cell the box touches is selected. Content coordinates
  // (the scroll offset included), so scrolling with the wheel while dragging grows the box.
  const onMarqueeDown = (e: MouseEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (e.button !== 0 || !el) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    const box = el.getBoundingClientRect();
    // Not on the scrollbar.
    if (e.clientX - box.left >= el.clientWidth) return;
    const at = (x: number, y: number) => ({ x: x - box.left, y: y - box.top + el.scrollTop });
    const start = at(e.clientX, e.clientY);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const before = useUiStore.getState().selection.keys;
    let last = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const update = () => {
      const end = at(last.x, last.y);
      const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: 0, h: 0 };
      rect.w = Math.abs(end.x - start.x);
      rect.h = Math.abs(end.y - start.y);
      setMarquee(rect);
      const { cells } = layoutRef.current;
      const ids = cellsInRect(layoutRef.current.rows, rect, sizeRef.current).flatMap((i) => {
        const model = cells[i];
        return !model ? [] : model.kind === 'group' ? model.unit.frames : [model.id];
      });
      const { review, setSelection } = useUiStore.getState();
      const list = review?.ids ?? [];
      const chosen = new Set(additive ? [...before, ...ids] : ids);
      const picked = list.filter((id) => chosen.has(id));
      setSelection(picked, picked[0] ?? null);
    };
    const onMove = (m: globalThis.MouseEvent) => {
      last = { x: m.clientX, y: m.clientY };
      if (!dragging && Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < MARQUEE_SLOP) return;
      dragging = true;
      update();
    };
    const onScroll = () => dragging && update();
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('scroll', onScroll);
      if (!dragging) return;
      marqueed.current = true;
      setMarquee(null);
      // The click that follows this mouseup (on a cell) is the marquee's end, not a selection.
      setTimeout(() => {
        marqueed.current = false;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('scroll', onScroll);
  };
  const focusRowCells = layout.rows[focusRow]?.cells;
  const focusColumn = focusedCell === undefined ? -1 : focusedCell - (focusRowCells?.[0] ?? 0);
  // The stagger counts from the first cell drawn (`--first`), so the first cell on screen never waits.
  const virtualRows = cell > 0 ? virtualizer.getVirtualItems() : [];
  const firstCell = layout.rows[virtualRows[0]?.index ?? 0]?.cells[0] ?? 0;
  // The ring jumps (no transition) when the columns or the width changed, so it never lags the cells on J / K or a
  // resize; it slides when only the focus moved.
  const ringLayout = `${columns}:${width}`;
  const lastRingLayout = useRef(ringLayout);
  const ringJumps = lastRingLayout.current !== ringLayout;
  useEffect(() => {
    lastRingLayout.current = ringLayout;
  });

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          role="listbox"
          aria-label="Photos"
          aria-multiselectable="true"
          aria-activedescendant={focusedCell !== undefined ? cellId(focusedCell) : undefined}
          tabIndex={0}
          data-opening={opening || undefined}
          style={{ '--first': firstCell, '--cap': STAGGER_CAP } as CSSProperties}
          className="min-h-0 flex-1 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] bg-surround outline-none"
          onScroll={(e) => {
            if (restored.current) useUiStore.getState().setCull({ scrollTop: e.currentTarget.scrollTop });
          }}
          onMouseDown={onMarqueeDown}
          onClickCapture={(e) => {
            if (!marqueed.current) return;
            marqueed.current = false;
            e.stopPropagation();
          }}
        >
          <div className="relative" style={{ height: totalSize }}>
            {cell > 0 &&
              virtualRows.map((row) => {
                const { cells, group, divider } = layout.rows[row.index] ?? { cells: [], group: false };
                if (divider) {
                  return <DividerRow key={row.key} divider={divider} start={row.start} onToggle={onDivider} />;
                }
                return (
                  <div key={row.key} role="presentation">
                    {group && (
                      <span
                        aria-hidden
                        className="absolute w-0.5 rounded-full bg-fg-2"
                        style={{ top: 0, left: PAD - 6, height: cell, transform: `translateY(${row.start}px)` }}
                      />
                    )}
                    <div
                      role="presentation"
                      className="absolute grid"
                      style={{
                        top: 0,
                        left: PAD,
                        right: PAD,
                        height: cell,
                        transform: `translateY(${row.start}px)`,
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gap: GAP,
                      }}
                    >
                      {cells.map((index) => {
                        const model = layout.cells[index] as CellModel;
                        const id = cellPhoto(model);
                        const fields = lookup.fields(id);
                        const file = lookup.file(id);
                        const frames = model.kind === 'group' ? model.unit.frames : null;
                        return (
                          <CullCell
                            key={model.kind === 'group' ? `g:${model.unit.group.id}` : id}
                            id={cellId(index)}
                            index={index}
                            photo={id}
                            file={file}
                            name={basename(file?.relPath ?? (lookup.path(id) || id))}
                            rating={showStars ? fields?.rating : undefined}
                            showStars={showStars}
                            flag={fields?.flag ?? undefined}
                            edited={fields?.develop !== undefined}
                            denoiseOn={!!fields?.develop?.detail.denoise}
                            lensBadges={badgesOf(id)}
                            thumbUrl={currentDeveloped(file, fields?.develop, profile)?.thumbUrl}
                            selected={frames ? frames.some((f) => selected.has(f)) : selected.has(id)}
                            groupId={model.kind === 'group' ? model.unit.group.id : undefined}
                            groupSize={frames?.length}
                            kept={model.kind === 'group' ? model.kept : undefined}
                            rejected={model.kind === 'group' ? model.rejected : undefined}
                            onClick={onCellClick}
                            onOpen={openReview}
                            onMenu={onCellMenu}
                            onExpand={onExpand}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            {marquee && (
              <span
                aria-hidden="true"
                data-marquee
                className="pointer-events-none absolute z-20 rounded-xs border border-fg/70 bg-fg/10"
                style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
              />
            )}
            {cell > 0 && focusColumn >= 0 && (
              <FocusRing
                x={PAD + focusColumn * (cellWidth + GAP)}
                y={tops[focusRow] ?? PAD}
                width={cellWidth}
                height={cell}
                jump={ringJumps}
              />
            )}
          </div>
        </div>
        <CullPill ids={selection.keys} />
      </div>
      <p className="shrink-0 border-hairline border-t px-3 py-1.5 text-center text-[11px] text-fg-muted">
        {count > 0 ? `${count} selected · ` : ''}Enter decide · Space or double-click one · C compare · N survey · P
        keep · X reject · U undecided · 1–5 rate, 0 clears · D develop · Shift+click range · Cmd+click add · drag to
        select · Cmd+A all · J / K size
        {groups ? ' · G open group · , . frame · ⌘G select group' : ''}
        {autoAdvance ? ' · Shift stays' : ' · Shift advances'} · ⇧⌘C / ⇧⌘V copy / paste settings · right-click for more
        <PasteNotice className="block" />
      </p>
      {menu && <CullContextMenu menu={menu} onClose={closeMenu} onDevelop={onDevelop} />}
    </div>
  );
}

const cellId = (index: number) => `cull-cell-${index}`;

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Plan 53: a *Group by* divider across the grid: the section's label and photo count; a click collapses or opens the
 * section (layout only, never the selection).
 */
function DividerRow({
  divider,
  start,
  onToggle,
}: {
  divider: GridDivider;
  start: number;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      role="presentation"
      data-divider={divider.key}
      className="absolute flex items-end"
      style={{ top: 0, left: PAD, right: PAD, height: DIVIDER_HEIGHT, transform: `translateY(${start}px)` }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={!divider.collapsed}
        title={divider.collapsed ? 'Show this section' : 'Collapse this section'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onToggle(divider.key)}
        className="flex w-full items-center gap-2 border-hairline border-b pb-1 text-left text-[11px] text-fg-2 outline-none transition-colors duration-fast ease-out hover:text-fg"
      >
        <span aria-hidden="true" className={`inline-block w-2 text-fg-muted ${divider.collapsed ? '' : 'rotate-90'}`}>
          ▸
        </span>
        <span className="truncate">{divider.label}</span>
        <span className="text-fg-muted tabular-nums">{divider.count}</span>
      </button>
    </div>
  );
}

/**
 * Cull's one *Group by* control (ODDHALLS_LAYOUT_PLAN 3; plan 53's select, with plan 39's Group toggle folded in by
 * plan 49): *Bursts* (plan 39's stacked groups, `ui.cull.grouped`, the default), *No grouping* (every photo its own
 * cell), or dividers by hour, day, camera, lens or place (`ui.cull.groupBy`) with the bursts still stacked inside
 * them. Only Bursts changes cells; the store fields, the group model and the dividers are as plans 39 and 53 left them.
 */
export function GroupBySelect() {
  const by = useUiStore((s) => s.cull.groupBy) ?? 'none';
  const grouped = useUiStore((s) => s.cull.grouped);
  const value = by !== 'none' ? by : grouped ? 'bursts' : 'off';
  const choose = (next: string) => {
    setGrouped(next !== 'off');
    useUiStore.getState().setCull({ groupBy: next === 'off' || next === 'bursts' ? 'none' : (next as CullGroupBy) });
  };
  return (
    <Select
      value={value}
      onChange={(e) => choose(e.target.value)}
      aria-label="Group by"
      title="Bursts and re-shots as one cell each (G opens one in place), or dividers by capture hour, day, camera, lens or place with the bursts stacked inside them"
    >
      <option value="bursts">Bursts</option>
      <option value="off">No grouping</option>
      {GROUP_BY_KEYS.map((key) => (
        <option key={key} value={key}>
          By {GROUP_BY_LABELS[key].toLowerCase()}
        </option>
      ))}
    </Select>
  );
}

/** Pixels the pointer moves before a press in the grid is a marquee, not a click. */
const MARQUEE_SLOP = 4;

/** A box in the grid's content coordinates, px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The flat indexes of the cells `rect` touches, over rows of cells `cell` px tall and `cellWidth` wide laid out from
 * the grid's padding with its gap (the grid's geometry); `tops` are the rows' tops when divider rows (plan 53) make
 * them uneven.
 */
export function cellsInRect(
  rows: readonly { cells: readonly number[] }[],
  rect: Rect,
  { cell, cellWidth, tops }: { cell: number; cellWidth: number; tops?: readonly number[] },
): number[] {
  if (cell <= 0 || cellWidth <= 0) return [];
  const out: number[] = [];
  rows.forEach((row, r) => {
    const top = tops?.[r] ?? PAD + r * (cell + GAP);
    if (top > rect.y + rect.h || top + cell < rect.y) return;
    row.cells.forEach((index, k) => {
      const left = PAD + k * (cellWidth + GAP);
      if (left <= rect.x + rect.w && left + cellWidth >= rect.x) out.push(index);
    });
  });
  return out;
}

/** The ⋯ glyph of the pill's menu. */
function MoreGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/**
 * Plan 47: the focused cell's `accent` ring, 2 px wide and 2 px out, drawn once per grid over the cell at `x`, `y` and
 * moved by a `base` transition, so the focus slides between cells and never re-renders one (`jump`: no transition).
 */
export function FocusRing({
  x,
  y,
  width,
  height,
  jump = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Move without the transition (the grid's columns or width changed). */
  jump?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-focus-ring
      data-jump={jump || undefined}
      className={`pointer-events-none absolute top-0 left-0 z-10 rounded-xs outline-2 outline-accent outline-offset-2 ${
        jump ? 'transition-none' : 'transition-[transform,width,height] duration-base ease-out'
      }`}
      style={{ width, height, transform: `translate(${x}px, ${y}px)` }}
    />
  );
}

/**
 * Plan 47: Cull's floating batch pill (`ui/Pill`, shared with Develop's `BatchBar`; ODDHALLS_UI_PLAN 3): "12 selected"
 * with the progress of their jobs ("23 of 58"), Export…, Denoise…, ⋯ (the grid's context menu on the selection), and
 * Clear.
 */
export function CullPill({ ids }: { ids: readonly string[] }) {
  const focused = useUiStore((s) => s.review?.ids[s.review.index]);
  const progress = useBatchProgress(ids);
  const shown = ids.length > 0;
  const many = ids.length > 1;
  return (
    <Pill shown={shown} label="Batch actions">
      <PillCount count={ids.length} progress={progress} />
      <PillDivider />
      <Button size="sm" title="Export the selected photos as new files (Cmd+Shift+E)" onClick={() => openExport(ids)}>
        {many ? `Export ${ids.length}…` : 'Export…'}
      </Button>
      <Button size="sm" title="Denoise in the background" onClick={() => openDenoiseBatch(ids, { force: false })}>
        Denoise…
      </Button>
      <Menu
        label={<MoreGlyph />}
        ariaLabel="More actions"
        title="More actions on the selection"
        menuLabel="Photo actions"
        width={240}
        alignEnd
      >
        {/* The grid's context menu items, on the selection (Copy from the focused photo when it is selected). */}
        <CullMenuItems
          menu={{ x: 0, y: 0, source: focused && ids.includes(focused) ? focused : (ids[0] ?? ''), targets: [...ids] }}
        />
      </Menu>
      <PillDivider />
      <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().clearSelection()}>
        Clear
      </Button>
    </Pill>
  );
}

export interface CullCellProps {
  id: string;
  index: number;
  /** The photo the cell shows (a collapsed group's shown frame): its batch underline. */
  photo: string;
  file: AssetFile | undefined;
  name: string;
  rating: number | undefined;
  /** The grid's *Stars* (`ui.cull.showStars`): turning it on does not pop every star. */
  showStars: boolean;
  flag: 'pick' | 'reject' | undefined;
  edited: boolean;
  /** Denoise is on for the photo (no "needs denoise" badge then; plan 27). */
  denoiseOn: boolean;
  /** The photo's technical lenses (plan 41), stable while its stats and folder stay. */
  lensBadges: readonly LensBadge[] | undefined;
  /** The developed thumbnail when one matches the edit, else the file's own. */
  thumbUrl: string | undefined;
  selected: boolean;
  /** A collapsed group (plan 39): its id, how many of its frames the list holds, and how many are kept or rejected. */
  groupId?: string;
  groupSize?: number;
  kept?: number;
  rejected?: number;
  onClick: (index: number, e: MouseEvent) => void;
  onOpen: (index: number) => void;
  onMenu: (index: number, e: MouseEvent) => void;
  /** The group badge: open the group in place (or close it). */
  onExpand: (groupId: string) => void;
}

/** One lens badge of a cell: the lens and its tooltip (the lens and the number; the caveat is the filter bar's). */
export interface LensBadge {
  kind: LensKind;
  detail: string;
  /** Blown above 5 %: the glyph a step brighter. */
  strong: boolean;
}

/**
 * Plan 41: each photo's lens badges, cached per id while the folders and the project's files stay the same, so a
 * memoised cell keeps its props.
 */
function useLensBadges(): (id: string) => readonly LensBadge[] | undefined {
  const reading = useLensReading();
  return useMemo(() => {
    const cache = new Map<string, readonly LensBadge[] | undefined>();
    return (id: string) => {
      if (cache.has(id)) return cache.get(id);
      const r = reading(id);
      const kinds = lensesIn(r?.verdict ?? null);
      const badges =
        r && kinds.length > 0
          ? kinds.map((kind) => ({
              kind,
              detail: lensDetail(kind, r.entry, r.verdict),
              strong: kind === 'blown' && r.verdict.blown === 'likely',
            }))
          : undefined;
      cache.set(id, badges);
      return badges;
    };
  }, [reading]);
}

/** The lens glyphs: Soft a dashed ring, Blown a sun, Dark a crescent. */
function LensGlyph({ kind }: { kind: LensKind }) {
  return (
    <svg viewBox="0 0 16 16" className="size-2.5" aria-hidden="true">
      {kind === 'soft' && (
        <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.8" />
      )}
      {kind === 'blown' && (
        <g fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="3" stroke="none" />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
        </g>
      )}
      {kind === 'dark' && <path d="M10.5 2.2a6 6 0 1 0 3.3 10.6A5 5 0 0 1 10.5 2.2z" fill="currentColor" />}
    </svg>
  );
}

/** The group badge's colour: every frame decided, some kept, or nothing decided yet (no accent on a photo). */
function groupBadgeClass(size: number, kept: number, rejected: number): string {
  if (kept + rejected === size) return 'bg-fg text-stage';
  if (kept > 0) return 'bg-stage/70 text-fg ring-1 ring-fg/60';
  return 'bg-stage/60 text-fg';
}

/**
 * One grid cell: thumbnail, the check and flag (top left), the top-right badge row (edited dot, the needs-denoise badge
 * of plan 27, then plan 41's dim lens glyphs, each named by its lens with its number in a tooltip), stars (bottom
 * left, only with `ui.cull.showStars`: the filter bar's *Stars*, plan 40), file name on hover. A collapsed group (plan
 * 39) shows its frame on a stacked edge with the `+N` badge (bottom right; a click opens the group in place) holding
 * its kept and rejected counts. Plan 47: 4 px radius, a 1 px lift and a faint ring on hover, the white ring with the
 * check when selected, the thumbnail's blur-up, stars that pop and a flag that stamps when they change, the reject
 * dim, an empty `panel` cell while the thumbnail prepares, and the batch underline (`WorkLine`) in the gap below.
 * The focus ring is not the cell's (the grid draws one that slides), so arrowing never re-renders a cell.
 */
export const CullCell = memo(function CullCell({
  id,
  index,
  photo,
  file,
  name,
  rating,
  showStars,
  flag,
  edited,
  denoiseOn,
  lensBadges,
  thumbUrl,
  selected,
  groupId,
  groupSize,
  kept = 0,
  rejected = 0,
  onClick,
  onOpen,
  onMenu,
  onExpand,
}: CullCellProps) {
  const [broken, setBroken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = thumbUrl ?? file?.thumbUrl;
  const failed = file?.status === 'error' || (src !== undefined && broken === src);
  const stacked = groupId !== undefined && groupSize !== undefined;
  // A new photo in the cell (`,` `.` on a group) or the Stars toggle is not a change the user made to this photo.
  const pop = useChanged(rating, `${photo}:${showStars}`);
  const stamp = useChanged(flag, photo);
  const img = useRef<HTMLImageElement>(null);
  // A thumbnail the browser already has (a scroll back) shows sharp at once, without the blur-up.
  useLayoutEffect(() => {
    if (src && img.current?.complete && img.current.naturalWidth > 0) setLoaded(src);
  }, [src]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the grid's window key handler drives the focus and selection
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={stacked ? `${name}, group of ${groupSize}` : name}
      title={`${file?.relPath ?? name}${file?.error ? `\n${file.error}` : ''}`}
      onClick={(e) => onClick(index, e)}
      onDoubleClick={() => onOpen(index)}
      onContextMenu={(e) => onMenu(index, e)}
      style={{ '--i': index } as CSSProperties}
      className={`cell-in group relative cursor-default rounded-xs outline-none transition-[translate,box-shadow] duration-fast ease-out hover:-translate-y-px ${
        selected ? 'ring-2 ring-fg' : 'ring-1 ring-transparent hover:ring-fg/6'
      }`}
    >
      <div className={`absolute inset-0 overflow-hidden rounded-xs ${stacked ? '' : 'bg-panel'}`}>
        {stacked && (
          <>
            {/* The stacked edge: a card behind, peeking out at the top and right, and the frame's face in front. */}
            <span className="pointer-events-none absolute top-0 right-0 bottom-1 left-1 rounded-xs border border-line bg-panel-2" />
            <span className="pointer-events-none absolute top-1 right-1 bottom-0 left-0 rounded-xs bg-panel" />
          </>
        )}
        {src && !failed && (
          <img
            ref={img}
            src={src}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={() => setLoaded(src)}
            onError={() => setBroken(src)}
            className={`${stacked ? 'absolute top-1 right-1 bottom-0 left-0 h-[calc(100%-0.25rem)] w-[calc(100%-0.25rem)]' : 'h-full w-full'} object-contain transition-[filter,opacity] duration-base ease-out ${
              loaded === src ? '' : 'blur-sm'
            } ${flag === 'reject' ? 'opacity-35' : ''}`}
          />
        )}
        {failed && (
          <span className="absolute inset-0 flex items-center justify-center p-1 text-center text-[10px] text-danger">
            {file?.error ?? 'Unreadable'}
          </span>
        )}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-stage/80 to-transparent px-1.5 pt-3 pb-1 text-right text-[10px] text-fg opacity-0 transition-opacity duration-fast ease-out group-hover:opacity-100">
          {name}
        </span>
      </div>
      {(selected || flag) && (
        <span className="absolute top-1 left-1 flex items-center gap-1">
          {selected && <SelectCheck />}
          {flag && <FlagStamp flag={flag} stamp={stamp} />}
        </span>
      )}
      <span className="absolute top-1 right-1 flex flex-row-reverse items-start gap-1">
        {edited && (
          <span
            role="img"
            aria-label="Edited"
            title="Edited in Develop"
            className="size-2 rounded-full border border-stage/50 bg-fg"
          />
        )}
        {!failed && (
          // The badge places itself; the box keeps its place in the row and collapses when it renders nothing.
          <span className="relative size-4 empty:hidden">
            <DenoiseBadge photo={file} denoiseOn={denoiseOn} className="inset-0" />
          </span>
        )}
        {!failed &&
          lensBadges?.map((badge) => (
            <Tooltip key={badge.kind} label={badge.detail}>
              <span
                role="img"
                aria-label={LENS_LABELS[badge.kind]}
                data-lens={badge.kind}
                className={`flex size-4 items-center justify-center rounded-full bg-stage/60 ${
                  badge.strong ? 'text-fg-2' : 'text-fg-muted'
                }`}
              >
                <LensGlyph kind={badge.kind} />
              </span>
            </Tooltip>
          ))}
      </span>
      {rating !== undefined && (
        <span
          key={pop ? rating : undefined}
          role="img"
          aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
          className={`absolute bottom-1 left-1 rounded-xs bg-stage/60 px-0.5 text-[10px] text-fg leading-3 tracking-tighter ${
            pop ? 'star-pop' : ''
          }`}
        >
          {'★'.repeat(rating)}
        </span>
      )}
      {stacked && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Open the group of ${groupSize}: ${kept} kept, ${rejected} rejected`}
          title={`Group of ${groupSize} (G opens it in place): ${kept} kept, ${rejected} rejected`}
          onClick={(e) => {
            e.stopPropagation();
            onExpand(groupId);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={`absolute right-2 bottom-1 rounded-xs px-1 text-[10px] leading-4 tabular-nums ${groupBadgeClass(
            groupSize,
            kept,
            rejected,
          )}`}
        >
          +{groupSize - 1}
          {kept + rejected > 0 && ` · ${kept}✓ ${rejected}✕`}
        </button>
      )}
      <WorkLine id={photo} />
    </div>
  );
});
