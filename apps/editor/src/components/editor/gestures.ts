import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef } from 'react';
import { beginGesture, createIdleGesture, endGesture } from '../../store/book';

/**
 * `onPointerDown` for a control dragged with the pointer (a range input): everything until the
 * pointer is released anywhere is one undo step. Keyboard changes stay one step each.
 */
export function usePointerGesture(): (event: ReactPointerEvent) => void {
  const active = useRef(false);
  useEffect(
    () => () => {
      if (active.current) endGesture();
    },
    [],
  );
  return useCallback(() => {
    if (active.current) return;
    active.current = true;
    beginGesture();
    const end = () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      active.current = false;
      endGesture();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }, []);
}

/**
 * For changes with no clear end (pinch wheel events, the native color picker): `touch()` before
 * each change; the gesture ends after `idleMs` without one, or as soon as undo, redo or a discrete
 * action runs (see `createIdleGesture`). Returns a stable function.
 */
export function useIdleGesture(idleMs = 400): () => void {
  const gesture = useMemo(() => createIdleGesture(idleMs), [idleMs]);
  useEffect(() => () => gesture.end(), [gesture]);
  return gesture.touch;
}

/** True when keyboard input belongs to a text field rather than the editor shortcuts. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(target.type);
  }
  return false;
}

/**
 * Canvas gesture modes (workflow plan 29). A press on a frame moves it; panning the picture inside a
 * photo frame is a mode, *Adjust photo* (`ui.canvas.adjusting`), entered by a double-click or the
 * floating toolbar's Adjust button and left with Escape, a press anywhere else, or another selection.
 * Space held over the selected photo frame pans it for that one drag without entering the mode.
 * These functions are pure so the table can be tested (gestures.test.ts) and extended (guides,
 * rulers).
 */

/** What the pointer went down on: a page element, or nothing (the page background or the canvas). */
export interface PressTarget {
  id: string;
  type: 'photo' | 'text';
  /** A photo frame holding a photo (only those pan, adjust or swap). */
  filled: boolean;
}

export interface PressInput {
  target: PressTarget | null;
  /** The element in Adjust photo mode before the press. */
  adjusting: string | null;
  /** The primary selection before the press. */
  selectedId: string | null;
  /** The whole selection before the press (a press on a member of a multi-selection drags them all). */
  selectedIds?: readonly string[];
  shiftKey: boolean;
  altKey: boolean;
  /** Space is held (Space+drag pans the selected photo). */
  space: boolean;
}

export type PressAction =
  /** Shift+press: add the element to or remove it from the selection; no drag. */
  | 'toggle-selection'
  /** Select the element and drag its frame (snapped; see `startFrameMove`). */
  | 'move'
  /**
   * A press on a member of a multi-selection: drag the whole selection (`startSelectionMove`); a
   * click without a drag selects the member alone.
   */
  | 'move-selection'
  /** Select the element and pan the photo inside its frame. */
  | 'pan'
  /** Alt+drag: hand the press to the slot's dnd-kit draggable (move the photo to another slot). */
  | 'swap'
  /** Press on no element: clear the selection. */
  | 'deselect';

export interface PressResult {
  action: PressAction;
  /** Adjust photo mode after the press. */
  adjusting: string | null;
}

/** The gesture a press starts, and the Adjust photo mode after it. */
export function pressAction({
  target,
  adjusting,
  selectedId,
  selectedIds,
  shiftKey,
  altKey,
  space,
}: PressInput): PressResult {
  if (!target) return { action: 'deselect', adjusting: null };
  // Inside the frame being adjusted every drag pans; a press anywhere else leaves the mode.
  if (adjusting !== null && target.id === adjusting && !shiftKey) return { action: 'pan', adjusting };
  if (shiftKey) return { action: 'toggle-selection', adjusting: null };
  if (target.type === 'photo' && target.filled) {
    if (altKey) return { action: 'swap', adjusting: null };
    if (space && target.id === selectedId) return { action: 'pan', adjusting: null };
  }
  if (selectedIds && selectedIds.length > 1 && selectedIds.includes(target.id)) {
    return { action: 'move-selection', adjusting: null };
  }
  return { action: 'move', adjusting: null };
}

export type DoubleClickAction =
  /** Edit the text box inline. */
  | 'edit-text'
  /** Enter Adjust photo mode on the frame. */
  | 'adjust'
  | 'none';

/** What a double-click on an element does: text edits, a filled photo frame enters Adjust photo. */
export function doubleClickAction(target: PressTarget | null): DoubleClickAction {
  if (!target) return 'none';
  if (target.type === 'text') return 'edit-text';
  return target.filled ? 'adjust' : 'none';
}

/**
 * Why a tracked drag ended: a real release (`up`), `pointercancel` or the returned function
 * (`cancel`), the window losing focus (`blur`), or a move with no button down (`lost`).
 */
export type DragEndReason = 'up' | 'cancel' | 'blur' | 'lost';

/**
 * Follow a pointer drag on the window until it ends: `onMove` for each move, then `onEnd` exactly once on release,
 * cancel, the window losing focus (Cmd+Tab, an OS dialog), or a move with no button down (the release happened
 * outside the window and never arrived). Without the last two a lost release would leave the drag's undo gesture
 * open, and undo would do nothing until the next click. `onEnd` gets the reason (only `up` is a click when nothing
 * moved). Returns a function that ends the drag now.
 */
export function trackPointerDrag(
  onMove: (e: PointerEvent) => void,
  onEnd: (reason: DragEndReason) => void,
): () => void {
  let done = false;
  const finish = (reason: DragEndReason) => {
    if (done) return;
    done = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', blur);
    onEnd(reason);
  };
  const up = () => finish('up');
  const cancel = () => finish('cancel');
  const blur = () => finish('blur');
  const move = (e: PointerEvent) => {
    if (e.buttons === 0) {
      finish('lost');
      return;
    }
    onMove(e);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', blur);
  return cancel;
}
