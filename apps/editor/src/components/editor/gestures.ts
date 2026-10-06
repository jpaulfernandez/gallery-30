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
