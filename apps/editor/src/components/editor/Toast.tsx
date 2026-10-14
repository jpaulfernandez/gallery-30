import { create } from 'zustand';
import { toast } from '../ui/Toast';
import { focusCanvas } from './textActions';

/**
 * The canvas notices (workflow plan 29: "This page is now custom" with Undo; a post's frame limit; "Sent to …"), shown
 * in the one toast host (`ui/Toast`, plan 48) instead of a stack of their own. One canvas notice at a time: a new one
 * replaces the one showing. It closes after `durationMs` (paused while the pointer or the focus is on it), on its
 * action, on ✕, or through `dismissToast`. `useToastStore` holds the notice showing, so callers and tests can read it.
 */

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastMessage {
  id: number;
  text: string;
  action?: ToastAction;
}

export interface ToastOptions {
  action?: ToastAction;
  /** How long it stays, ms (default 6 s). */
  durationMs?: number;
  /** Called once when this toast closes, whatever closed it. */
  onClose?: () => void;
}

interface ToastState {
  toast: ToastMessage | null;
}

export const useToastStore = create<ToastState>()(() => ({ toast: null }));

let nextId = 1;
/** The host's id of the notice showing. */
let hostId: number | null = null;

/** Show a canvas notice (replacing the one showing); returns its id for `dismissToast`. */
export function showToast(text: string, { action, durationMs = 6000, onClose }: ToastOptions = {}): number {
  dismissToast();
  const id = nextId++;
  useToastStore.setState({ toast: action ? { id, text, action } : { id, text } });
  hostId = toast.show({
    text,
    actions: action ? [action] : undefined,
    durationMs,
    onClose: () => {
      if (useToastStore.getState().toast?.id !== id) return;
      hostId = null;
      // Its action or ✕ had the focus: give it back to the canvas, as before the move to the host.
      if (typeof document !== 'undefined' && document.activeElement?.closest('[data-toast-host]')) focusCanvas();
      useToastStore.setState({ toast: null });
      onClose?.();
    },
  });
  return id;
}

/** Close the notice showing (only if it is `id`, when given). */
export function dismissToast(id?: number): void {
  const current = useToastStore.getState().toast;
  if (!current || (id !== undefined && current.id !== id)) return;
  if (hostId !== null) toast.dismiss(hostId);
}
