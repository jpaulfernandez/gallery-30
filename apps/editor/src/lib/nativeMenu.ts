import { devError, devLog } from './log';
import { isTextField } from './nativeShell';
import { installNativeMenu, type NativeMenuSpec, onNativeMenu, setTextFocus } from './tauri';

/**
 * Plan 43: the native menu bar's items (built by `src-tauri/src/menu.rs`), behind the `VITE_PHOTOBOOK_NATIVE_MENU`
 * Vite flag for one session so the two paths can be compared (plan 49 removes the flag).
 *
 * An item that stands for a key (`key`) runs it as a keydown on the focused element, so the handler that owns the key
 * today (Design, Cull, Review, Develop) does the work and nothing is written twice. The menu owns its accelerators: a
 * key it catches never reaches the page. Where the key reaches the page first instead (a plain letter on some
 * systems), the page has already acted and the menu's event is dropped (`recentKey`), so a press acts once either way.
 * Items without a key run an action (`action`). Every press logs one `[photobook:menu]` line.
 *
 * Undo, Redo, Cut, Copy, Paste and Select all become the system items while a text field has focus (`textEdit`,
 * reported through `set_text_focus`), so Cmd+Z in a field undoes typing and outside it undoes the book.
 */

/** A key as a keydown sees it. `mod` is Cmd on a Mac (Ctrl elsewhere). */
export interface KeyCombo {
  key: string;
  code: string;
  mod?: boolean;
  shift?: boolean;
}

/** What an item without a key does (`lib/nativeMenuActions.ts`). */
export type MenuAction =
  | 'newProject'
  | 'openProjectFile'
  | 'importFolder'
  | 'saveAs'
  | 'closeProject'
  | 'toggleGrid'
  | 'toggleRulers'
  | 'toggleMargins'
  | 'actualSize'
  | 'stageCull'
  | 'stageDevelop'
  | 'stageDesign';

type TextEdit = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

export interface MenuEntry {
  id: string;
  label: string;
  key?: KeyCombo;
  action?: MenuAction;
  textEdit?: TextEdit;
}

type Row = MenuEntry | 'separator';

const letter = (key: string, extra: Omit<KeyCombo, 'key' | 'code'> = {}): KeyCombo => ({
  key,
  code: `Key${key.toUpperCase()}`,
  ...extra,
});
const digit = (n: number): KeyCombo => ({ key: String(n), code: `Digit${n}` });

/** The app's submenus, between the app menu and Window. */
export const NATIVE_MENU: { title: string; items: Row[] }[] = [
  {
    title: 'File',
    items: [
      { id: 'file.newProject', label: 'New project…', action: 'newProject' },
      { id: 'file.openProjectFile', label: 'Open project file…', action: 'openProjectFile' },
      { id: 'file.importFolder', label: 'Import folder…', action: 'importFolder' },
      'separator',
      { id: 'file.saveAs', label: 'Save as…', action: 'saveAs' },
      { id: 'file.closeProject', label: 'Close project', action: 'closeProject' },
      'separator',
      { id: 'file.export', label: 'Export…', key: letter('e', { mod: true, shift: true }) },
    ],
  },
  {
    title: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', key: letter('z', { mod: true }), textEdit: 'undo' },
      { id: 'edit.redo', label: 'Redo', key: letter('z', { mod: true, shift: true }), textEdit: 'redo' },
      'separator',
      { id: 'edit.cut', label: 'Cut', key: letter('x', { mod: true }), textEdit: 'cut' },
      { id: 'edit.copy', label: 'Copy', key: letter('c', { mod: true }), textEdit: 'copy' },
      { id: 'edit.paste', label: 'Paste', key: letter('v', { mod: true }), textEdit: 'paste' },
      { id: 'edit.selectAll', label: 'Select all', key: letter('a', { mod: true }), textEdit: 'selectAll' },
      'separator',
      { id: 'edit.copySettings', label: 'Copy settings', key: letter('c', { mod: true, shift: true }) },
      { id: 'edit.pasteSettings', label: 'Paste settings', key: letter('v', { mod: true, shift: true }) },
    ],
  },
  {
    title: 'View',
    items: [
      { id: 'view.grid', label: 'Show grid', action: 'toggleGrid' },
      { id: 'view.rulers', label: 'Show rulers and guides', action: 'toggleRulers' },
      { id: 'view.margins', label: 'Show safe area', action: 'toggleMargins' },
      'separator',
      { id: 'view.zoomFit', label: 'Zoom to fit', key: { key: '0', code: 'Digit0', mod: true } },
      { id: 'view.actualSize', label: 'Actual size (100 %)', action: 'actualSize' },
      { id: 'view.zoomIn', label: 'Zoom in', key: { key: '=', code: 'Equal', mod: true } },
      { id: 'view.zoomOut', label: 'Zoom out', key: { key: '-', code: 'Minus', mod: true } },
      'separator',
      { id: 'view.cull', label: 'Cull', action: 'stageCull' },
      { id: 'view.develop', label: 'Develop', action: 'stageDevelop' },
      { id: 'view.design', label: 'Design', action: 'stageDesign' },
    ],
  },
  {
    title: 'Photo',
    items: [
      { id: 'photo.pick', label: 'Keep', key: letter('p') },
      { id: 'photo.reject', label: 'Reject', key: letter('x') },
      { id: 'photo.unflag', label: 'Undecided', key: letter('u') },
      'separator',
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `photo.rate${n}`, label: `${'★'.repeat(n)}`, key: digit(n) })),
      { id: 'photo.rate0', label: 'No rating', key: digit(0) },
      'separator',
      { id: 'photo.develop', label: 'Develop', key: letter('d') },
    ],
  },
];

const ENTRIES = new Map<string, MenuEntry>(
  NATIVE_MENU.flatMap((s) => s.items).flatMap((row) => (row === 'separator' ? [] : [[row.id, row] as const])),
);

/** Tauri accelerator syntax for a key: `CmdOrCtrl+Shift+Z`, `P`, `CmdOrCtrl+=`. */
export function accelerator(k: KeyCombo): string {
  const parts = [k.mod ? 'CmdOrCtrl' : '', k.shift ? 'Shift' : '', k.key.length === 1 ? k.key.toUpperCase() : k.code];
  return parts.filter(Boolean).join('+');
}

/** The spec `install_native_menu` builds the bar from. */
export function menuSpec(): NativeMenuSpec {
  return {
    submenus: NATIVE_MENU.map(({ title, items }) => ({
      title,
      items: items.map((row) =>
        row === 'separator'
          ? { kind: 'separator' as const }
          : {
              kind: 'item' as const,
              id: row.id,
              label: row.label,
              ...(row.key ? { accelerator: accelerator(row.key) } : {}),
              ...(row.textEdit ? { textEdit: row.textEdit } : {}),
            },
      ),
    })),
  };
}

/** One string per physical combination: the same for a real keydown and the item's key. */
export function comboOf(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): string {
  return `${e.metaKey || e.ctrlKey ? 'mod+' : ''}${e.shiftKey ? 'shift+' : ''}${e.altKey ? 'alt+' : ''}${e.code}`;
}

/** The keydown an item dispatches (Cmd as `metaKey`, which every handler reads as `metaKey || ctrlKey`). */
export function keyEventInit(k: KeyCombo): KeyboardEventInit {
  return { key: k.key, code: k.code, metaKey: !!k.mod, shiftKey: !!k.shift, bubbles: true, cancelable: true };
}

/** How long after a real keydown the menu's event for the same combination counts as that press, ms. */
const SAME_PRESS_MS = 300;

/**
 * Tracks the last real keydown, so a menu event for a key the page already handled is dropped. `seen` runs in the
 * capture phase (before any handler can stop the event); the press counts as pending until its dispatch has finished
 * (`defer` runs after it), and the 300 ms start then, so a slow handler cannot let the menu's event through.
 */
export function recentKey(
  now: () => number = () => performance.now(),
  defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0),
) {
  let last = { combo: '', at: Number.NEGATIVE_INFINITY };
  return {
    seen(e: Pick<KeyboardEvent, 'isTrusted' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>) {
      if (!e.isTrusted) return;
      const press = { combo: comboOf(e), at: Number.POSITIVE_INFINITY };
      last = press;
      defer(() => {
        press.at = now();
      });
    },
    handled(k: KeyCombo): boolean {
      const combo = comboOf({ code: k.code, metaKey: !!k.mod, ctrlKey: false, shiftKey: !!k.shift, altKey: false });
      return last.combo === combo && now() - last.at < SAME_PRESS_MS;
    },
  };
}

let installed = false;

/**
 * Install the bar and route its events (once, at startup, when the flag is on). Resolves false outside Tauri or if
 * the install fails; the keys then stay the page's, as without the flag.
 */
export async function installNativeMenuBar(actions: Record<MenuAction, () => unknown>): Promise<boolean> {
  if (installed) return true;
  try {
    await installNativeMenu(menuSpec());
  } catch (err) {
    devError('menu', 'native menu not installed', err);
    return false;
  }
  installed = true;
  const keys = recentKey();
  window.addEventListener('keydown', (e) => keys.seen(e), true);

  await onNativeMenu((id) => {
    const entry = ENTRIES.get(id);
    if (!entry) return;
    if (entry.key) {
      if (keys.handled(entry.key)) {
        devLog('menu', id, { by: 'key' });
        return;
      }
      devLog('menu', id, { by: 'menu' });
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', keyEventInit(entry.key)));
      return;
    }
    devLog('menu', id, { by: 'menu' });
    if (entry.action) {
      void Promise.resolve()
        .then(actions[entry.action])
        .catch((err) => devError('menu', `${id} failed`, err));
    }
  });

  // The Edit items follow the focus: a text field gets the system's, everything else the app's.
  let textFocus = false;
  const follow = () =>
    setTimeout(() => {
      const next = isTextField(document.activeElement);
      if (next === textFocus) return;
      textFocus = next;
      setTextFocus(next).catch((err) => devError('menu', 'text focus not reported', err));
    });
  document.addEventListener('focusin', follow);
  document.addEventListener('focusout', follow);
  // A field may already have focus.
  follow();
  devLog('menu', 'native menu installed');
  return true;
}
