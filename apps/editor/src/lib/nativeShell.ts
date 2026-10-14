/**
 * Plan 43: the document-level guards that make the webview behave like an app window rather than a web page.
 *
 * - `contextmenu`: the browser's menu (Reload, Inspect Element) never shows. A text field keeps the system's menu
 *   (Cut, Copy, Paste, spelling); an element marked `data-native-menu` (or inside one) does too. Components with their
 *   own right-click menu already cancel the event themselves.
 * - `dragstart`: no native drag (the ghost image of an `<img>`, a dragged link or text). dnd-kit runs on pointer
 *   events, so cancelling every native `dragstart` leaves it alone; `dragDropEnabled: false` stays on the window.
 * - In release builds, Cmd+R, Cmd+Shift+R and F5 do not reload the page (WKWebView would).
 */

/** An element where typing goes: a text input, a textarea or an editable element. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.disabled;
  if (target instanceof HTMLInputElement) {
    return !target.disabled && !NON_TEXT_INPUTS.has(target.type);
  }
  return false;
}

/** Input types that take no typing (their keys and menu stay the app's). */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether a right-click on `target` keeps the system's context menu. */
export function keepsNativeMenu(target: EventTarget | null): boolean {
  if (isTextField(target)) return true;
  return target instanceof Element && target.closest('[data-native-menu]') !== null;
}

/** A keydown that reloads the page in WKWebView. */
export function isReloadKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  if (e.key === 'F5') return true;
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'r';
}

let installed = false;

/** Install the guards once, at startup. `release` turns on the reload guard (dev keeps Cmd+R for HMR mishaps). */
export function installNativeGuards({ release }: { release: boolean }): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('contextmenu', (e) => {
    if (!keepsNativeMenu(e.target)) e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  if (release) {
    window.addEventListener(
      'keydown',
      (e) => {
        if (isReloadKey(e)) e.preventDefault();
      },
      true,
    );
  }
}
