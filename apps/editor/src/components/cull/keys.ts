import type { AssetFlag } from '@photobook/shared';

/**
 * The Cull grid's keys (workflow plan 06), as data: `cullKeyAction` maps a keydown to what the grid does, and
 * `CULL_KEYS` is the table the README and the help text follow. Every key `ReviewMode` handles works on the grid too
 * (a test checks it). C opens Compare and N Survey (plan 07, `CompareView` and `SurveyView`, which read the same keys
 * through `cullKeyAction` and `compareKeyAction`). Copy and paste of develop settings (plan 10) are grid keys only.
 */
export type CullAction =
  /** Move the focus; `extend` (Shift) grows the selection from its anchor instead of collapsing it. */
  | { type: 'move'; to: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'; extend: boolean }
  /** Rate (null clears) the selection, or the focused photo when nothing is selected. Shift inverts auto-advance. */
  | { type: 'rate'; rating: number | null; shift: boolean }
  | { type: 'flag'; flag: AssetFlag | null; shift: boolean }
  /** Open the focused photo in Develop. */
  | { type: 'develop' }
  /** Open the focused photo in Review (one photo large). */
  | { type: 'review' }
  /** Enter: open the Decide pass on the focused unit (plan 40). */
  | { type: 'decide' }
  | { type: 'selectAll' }
  /** Escape: clear the selection. */
  | { type: 'clear' }
  /** Bigger (1: fewer columns) or smaller (-1: more columns) thumbnails; in Compare, the next zoom stop in or out. */
  | { type: 'zoom'; dir: 1 | -1 }
  /** Compare two photos: the focused one and the next (or the first two selected). */
  | { type: 'compare' }
  /** Survey the selection (the picks when nothing is selected). */
  | { type: 'survey' }
  /** Cmd+Shift+C: copy the focused photo's settings; `dialog` (Shift+Cmd+Alt+C) opens Copy Settings to choose. */
  | { type: 'copy'; dialog: boolean }
  /** Cmd+Shift+V: paste onto the selection (or the focused photo); `previous` (Cmd+Alt+V) from the photo before. */
  | { type: 'paste'; previous: boolean }
  /** G: open the focused group in place, or close it (plan 39). */
  | { type: 'expand' }
  /** `,` / `.`: the previous / next frame of the focused collapsed group, wrapping (plan 39). */
  | { type: 'frame'; dir: 1 | -1 }
  /** Cmd+G: select every photo of the focused group (plan 39). */
  | { type: 'selectGroup' };

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>;

const MOVES: Record<string, Extract<CullAction, { type: 'move' }>['to']> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
};

/** What a keydown does in the grid, or null when the grid leaves it alone. */
export function cullKeyAction(e: KeyLike): CullAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.altKey) {
    // Alt changes `key` on a Mac (Alt+V is √), so these go by the physical key.
    if (mod && e.shiftKey && e.code === 'KeyC') return { type: 'copy', dialog: true };
    if (mod && !e.shiftKey && e.code === 'KeyV') return { type: 'paste', previous: true };
    return null;
  }
  if (mod) {
    // Cmd+"+" is Cmd+Shift+= on a US keyboard, so Shift is allowed for zoom.
    if (e.key === '=' || e.key === '+') return { type: 'zoom', dir: 1 };
    if (e.key === '-' || e.key === '_') return { type: 'zoom', dir: -1 };
    if (e.shiftKey) {
      if (e.key.toLowerCase() === 'c') return { type: 'copy', dialog: false };
      if (e.key.toLowerCase() === 'v') return { type: 'paste', previous: false };
      return null;
    }
    if (e.key.toLowerCase() === 'a') return { type: 'selectAll' };
    if (e.key.toLowerCase() === 'g') return { type: 'selectGroup' };
    return null;
  }
  const move = MOVES[e.key];
  if (move) return { type: 'move', to: move, extend: e.shiftKey };
  const digit = /^Digit([0-5])$/.exec(e.code)?.[1] ?? /^Numpad([0-5])$/.exec(e.code)?.[1];
  if (digit !== undefined) return { type: 'rate', rating: digit === '0' ? null : Number(digit), shift: e.shiftKey };
  const key = e.key.toLowerCase();
  if (key === 'p') return { type: 'flag', flag: 'pick', shift: e.shiftKey };
  if (key === 'x') return { type: 'flag', flag: 'reject', shift: e.shiftKey };
  if (key === 'u') return { type: 'flag', flag: null, shift: e.shiftKey };
  if (e.shiftKey) return null;
  if (key === 'd') return { type: 'develop' };
  if (key === 'c') return { type: 'compare' };
  if (key === 'n') return { type: 'survey' };
  if (key === 'g') return { type: 'expand' };
  if (e.key === ',') return { type: 'frame', dir: -1 };
  if (e.key === '.') return { type: 'frame', dir: 1 };
  if (e.key === ' ') return { type: 'review' };
  if (e.key === 'Enter') return { type: 'decide' };
  if (e.key === 'Escape') return { type: 'clear' };
  if (key === 'k') return { type: 'zoom', dir: 1 };
  if (key === 'j') return { type: 'zoom', dir: -1 };
  return null;
}

/** What a keydown does in the Compare view: the Cull keys plus these. */
export type CompareAction =
  | CullAction
  /** Cmd+Enter: the candidate becomes the select. */
  | { type: 'promote' }
  /** Tab: the other pane takes the rating and flag keys. */
  | { type: 'pane' }
  /** Shift+F: back to fit (plan 53 gave F to focus peak). */
  | { type: 'fit' };

/** What a keydown does in Compare, or null when it leaves the key alone. */
export function compareKeyAction(e: KeyLike): CompareAction | null {
  if (e.altKey) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (mod) return e.key === 'Enter' && !e.shiftKey ? { type: 'promote' } : cullKeyAction(e);
  if (e.key === 'Tab') return { type: 'pane' };
  if (e.shiftKey && e.key.toLowerCase() === 'f') return { type: 'fit' };
  return cullKeyAction(e);
}

/** Plan 53: the *Assist* keys of One, Two and Decide (`AssistOverlays`). */
export type AssistAction = { type: 'focusPeak' } | { type: 'zebra' } | { type: 'composition'; dir: 1 | -1 };

/**
 * F toggles focus peak, Z zebra, O cycles the composition guides (Shift+O backwards); null for anything else, with
 * Cmd, Ctrl or Alt, and in a text field (the caller also skips menus and dialogs).
 */
export function assistKeyAction(e: KeyLike & Pick<KeyboardEvent, 'target'>): AssistAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return null;
  const key = e.key.toLowerCase();
  if (key === 'o') return { type: 'composition', dir: e.shiftKey ? -1 : 1 };
  if (e.shiftKey) return null;
  if (key === 'f') return { type: 'focusPeak' };
  if (key === 'z') return { type: 'zebra' };
  return null;
}

/**
 * The keys of the Cull stage, for the README and the grid's hint line. Plan 40's words: P keeps, X rejects, U makes a
 * photo undecided (no flag).
 */
export const CULL_KEYS: readonly { keys: string; grid: string; review: string }[] = [
  { keys: '← → ↑ ↓', grid: 'Move the focus (Shift extends the selection)', review: 'Previous / next photo' },
  { keys: 'Home / End', grid: 'First / last photo', review: 'First / last photo' },
  { keys: '1 to 5, 0', grid: 'Rate the selection (or the focused photo), 0 clears', review: 'Rate, 0 clears' },
  { keys: 'P / X / U', grid: 'Keep / reject the selection, U makes it undecided', review: 'Keep / reject / undecided' },
  { keys: 'Shift + rate or flag', grid: 'Inverts auto-advance', review: 'Inverts auto-advance' },
  { keys: 'D', grid: 'Develop the focused photo', review: 'Develop this photo' },
  { keys: 'Space', grid: 'Review the focused photo', review: '—' },
  {
    keys: 'Enter',
    grid: 'Decide: keep or reject the undecided photos one unit at a time, from the focused one',
    review: '—',
  },
  {
    keys: 'C',
    grid: 'Compare the focused photo with the next (or the first two selected); on a group, its frame with the best',
    review: '—',
  },
  {
    keys: 'N',
    grid: 'Survey the selection (the picks when nothing is selected); on a group, its frames',
    review: '—',
  },
  { keys: 'G', grid: 'Open the focused group in place, or close it', review: '—' },
  { keys: ', / .', grid: 'Previous / next frame of the focused group (wraps)', review: '—' },
  { keys: 'Cmd+G', grid: 'Select every photo of the focused group', review: '—' },
  { keys: 'Esc', grid: 'Clear the selection', review: 'Back to the grid' },
  { keys: 'Click, Shift+click, Cmd+click', grid: 'Select, select a range, add or remove', review: '—' },
  { keys: 'Cmd+A', grid: 'Select every photo shown', review: '—' },
  { keys: 'J / K, Cmd+− / Cmd+=', grid: 'Smaller / bigger thumbnails (3 to 8 columns)', review: '—' },
  {
    keys: 'Cmd+Shift+C, Shift+Cmd+Alt+C',
    grid: 'Copy the focused photo’s develop settings (with Alt: choose the sections)',
    review: '—',
  },
  {
    keys: 'Cmd+Shift+V, Cmd+Alt+V',
    grid: 'Paste settings onto the selection (or the focused photo); with Alt, from the photo before',
    review: '—',
  },
  {
    keys: 'Cmd+Shift+E',
    grid: 'Export the selection (or the focused photo) as new files',
    review: 'Export the selection (or this photo)',
  },
  { keys: 'Right-click', grid: 'Copy, paste settings, reset edits, export; merge, split, detach groups', review: '—' },
];

/** The keys of the Compare view (README). */
export const COMPARE_KEYS: readonly { keys: string; action: string }[] = [
  { keys: '← → ↑ ↓, Home / End', action: 'Step the candidate (left) through the list shown; the select (right) stays' },
  { keys: 'Cmd+Enter', action: 'The candidate becomes the select, and the next photo is the candidate' },
  { keys: 'Tab, click a pane', action: 'Which pane the rating and flag keys act on' },
  { keys: '1 to 5, 0, P / X / U', action: 'Rate or flag the focused pane' },
  { keys: 'K / J, Cmd+= / Cmd+−', action: 'Zoom both panes in / out through Fit, 1×, 2×, 4×' },
  { keys: 'Shift+F', action: 'Fit both panes' },
  { keys: 'F / Z / O', action: 'Assist: focus peak, zebra, the composition guides (O cycles); never a flag' },
  { keys: 'Click, drag, double-click', action: 'Click zooms to 1× at that point; drag pans both; a second click fits' },
  { keys: 'D', action: 'Develop the focused pane photo' },
  { keys: 'Esc', action: 'Back to the grid' },
];

/** The keys of the Survey view (README). */
export const SURVEY_KEYS: readonly { keys: string; action: string }[] = [
  { keys: '← → ↑ ↓, Home / End', action: 'Move the focus between tiles' },
  { keys: 'X', action: 'Reject the focused (or marked) photos and remove them from the view; the last one stays' },
  { keys: '1 to 5, 0, P / U', action: 'Rate, keep or make undecided the focused (or marked) photos' },
  { keys: 'Click, Shift+click', action: 'Focus a tile; mark or unmark a tile' },
  { keys: 'D', action: 'Develop the focused photo' },
  { keys: 'Esc', action: 'Back to the grid with the survivors selected' },
];

/** What a keydown does in the Decide pass (plan 40). */
export type DecideAction =
  /** P keeps the shown frame (on a group, rejects its other undecided frames) and advances; Shift+P keeps and stays. */
  | { type: 'keep'; stay: boolean }
  /** X rejects the shown frame; Shift+X rejects every undecided frame of the group. */
  | { type: 'reject'; all: boolean }
  /** U: undo the last decision of the pass. */
  | { type: 'undo' }
  /** `,` / `.`: the previous / next frame of the group. */
  | { type: 'frame'; dir: 1 | -1 }
  /** ← / →: the previous / next unit, deciding nothing. */
  | { type: 'step'; dir: 1 | -1 }
  /** Space: 100 % at the sharpest region, again to fit. */
  | { type: 'zoom' }
  /** C: Compare the shown frame with the group's suggested best. */
  | { type: 'compare' }
  | { type: 'develop' }
  /** Esc: back to the grid. */
  | { type: 'exit' };

/** What a keydown does in Decide, or null when it leaves the key alone. */
export function decideKeyAction(e: KeyLike): DecideAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'p') return { type: 'keep', stay: e.shiftKey };
  if (key === 'x') return { type: 'reject', all: e.shiftKey };
  if (e.shiftKey) return null;
  if (key === 'u') return { type: 'undo' };
  if (e.key === ',') return { type: 'frame', dir: -1 };
  if (e.key === '.') return { type: 'frame', dir: 1 };
  if (e.key === 'ArrowLeft') return { type: 'step', dir: -1 };
  if (e.key === 'ArrowRight') return { type: 'step', dir: 1 };
  if (e.key === ' ') return { type: 'zoom' };
  if (key === 'c') return { type: 'compare' };
  if (key === 'd') return { type: 'develop' };
  if (e.key === 'Escape') return { type: 'exit' };
  return null;
}

/** The keys of the Decide pass (README; CULL_PLAN 4.3): what each does on a single photo and on a group. */
export const DECIDE_KEYS: readonly { keys: string; single: string; group: string }[] = [
  {
    keys: 'P',
    single: 'Keep, advance',
    group: 'Keep the shown frame, reject the group’s other undecided frames, advance to the next unit',
  },
  {
    keys: 'Shift+P',
    single: 'Keep, stay',
    group: 'Keep the shown frame only and step to the group’s next undecided frame (two keepers from one burst)',
  },
  {
    keys: 'X',
    single: 'Reject, advance',
    group: 'Reject the shown frame and step inside the group; the last undecided frame rejected advances',
  },
  { keys: 'Shift+X', single: 'Reject, advance', group: 'Reject every undecided frame of the group, advance' },
  { keys: 'U', single: 'Undo the last decision of this pass (not app undo)', group: 'Same' },
  { keys: ', / .', single: '—', group: 'Previous / next frame of the group (the strip under the picture)' },
  { keys: '← →', single: 'Previous / next unit without deciding (the counter does not move)', group: 'Same' },
  { keys: 'Space', single: '100 % at the sharpest region; again to fit', group: 'Same' },
  {
    keys: 'C',
    single: '—',
    group: 'Compare the shown frame with the group’s suggested best (Cmd+Enter promotes, Esc back to Decide)',
  },
  { keys: 'D', single: 'Develop this photo', group: 'Same' },
  { keys: 'Esc', single: 'Back to the grid, focused on the unit left', group: 'Same' },
];

/** True for a text field, select or editable element: keys typed there are not Cull keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return type !== 'checkbox' && type !== 'radio' && type !== 'button';
}

/** Focused elements where Tab keeps its own meaning (moving the focus, a menu's or dialog's keys). */
const OWN_TAB =
  'a, button, input, select, textarea, summary, [role="slider"], [role="menu"], [role="menuitem"], [role="dialog"]';

/**
 * Plan 51 (ODDHALLS_LAYOUT_PLAN 2): Tab hides or shows both side panes (`'panes'`), Shift+Tab the panes and the strip
 * (`'all'`), in every stage (`ui.togglePanes`). Null when the key is not Tab, repeats, has Cmd, Ctrl or Alt, or the focus is in
 * a text field, on a control (Tab moves the focus there), in a menu or in a dialog. The Cull route, the Develop view and
 * the Design shortcuts each read it; Compare keeps Tab for its panes.
 */
export function paneKeyAction(e: KeyLike & Pick<KeyboardEvent, 'target' | 'repeat'>): 'panes' | 'all' | null {
  // A held Tab repeats: one toggle per press, so the panes never flicker.
  if (e.key !== 'Tab' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isEditableTarget(e.target)) return null;
  if (e.target instanceof Element && e.target.closest(OWN_TAB)) return null;
  return e.shiftKey ? 'all' : 'panes';
}
