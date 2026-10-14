// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cullKeyAction } from '../components/cull/keys';
import { accelerator, keyEventInit, type MenuEntry, menuSpec, NATIVE_MENU, recentKey } from './nativeMenu';

const entries = NATIVE_MENU.flatMap((s) => s.items).filter((row): row is MenuEntry => row !== 'separator');
const entry = (id: string): MenuEntry => {
  const found = entries.find((e) => e.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

describe('the native menu', () => {
  it('has unique ids, and every item either stands for a key or runs an action', () => {
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) expect(Boolean(e.key) !== Boolean(e.action)).toBe(true);
  });

  it('gives each system Edit item exactly one stand-in, with an accelerator', () => {
    const edits = entries.filter((e) => e.textEdit);
    expect(edits.map((e) => e.textEdit).sort()).toEqual(['copy', 'cut', 'paste', 'redo', 'selectAll', 'undo']);
    for (const e of edits) expect(e.key?.mod).toBe(true);
  });

  it('owns no combination twice', () => {
    const combos = entries.flatMap((e) => (e.key ? [accelerator(e.key)] : []));
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('writes Tauri accelerators', () => {
    expect(accelerator(entry('edit.redo').key ?? { key: '', code: '' })).toBe('CmdOrCtrl+Shift+Z');
    expect(accelerator(entry('photo.pick').key ?? { key: '', code: '' })).toBe('P');
    expect(accelerator(entry('view.zoomIn').key ?? { key: '', code: '' })).toBe('CmdOrCtrl+=');
    const spec = menuSpec();
    expect(spec.submenus.map((s) => s.title)).toEqual(['File', 'Edit', 'View', 'Photo']);
    expect(spec.submenus[1]?.items[0]).toEqual({
      kind: 'item',
      id: 'edit.undo',
      label: 'Undo',
      accelerator: 'CmdOrCtrl+Z',
      textEdit: 'undo',
    });
  });

  it('dispatches the keydown the grid already handles', () => {
    const run = (id: string) =>
      cullKeyAction(new KeyboardEvent('keydown', keyEventInit(entry(id).key ?? { key: '', code: '' })));
    expect(run('photo.pick')).toEqual({ type: 'flag', flag: 'pick', shift: false });
    expect(run('photo.reject')).toEqual({ type: 'flag', flag: 'reject', shift: false });
    expect(run('photo.unflag')).toEqual({ type: 'flag', flag: null, shift: false });
    expect(run('photo.rate3')).toEqual({ type: 'rate', rating: 3, shift: false });
    expect(run('photo.rate0')).toEqual({ type: 'rate', rating: null, shift: false });
    expect(run('photo.develop')).toEqual({ type: 'develop' });
    expect(run('edit.selectAll')).toEqual({ type: 'selectAll' });
    expect(run('edit.copySettings')).toEqual({ type: 'copy', dialog: false });
    expect(run('edit.pasteSettings')).toEqual({ type: 'paste', previous: false });
    expect(run('view.zoomIn')).toEqual({ type: 'zoom', dir: 1 });
  });
});

describe('recentKey', () => {
  /** A real keydown (jsdom's events are never trusted, so a plain object stands in). */
  const real = (init: { code: string; metaKey?: boolean; shiftKey?: boolean }) => ({
    isTrusted: true,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it('drops the menu event of a press the page already saw, once the press is recent', () => {
    let now = 1000;
    const keys = recentKey(
      () => now,
      (fn) => fn(),
    );
    const pick = entry('photo.pick').key ?? { key: '', code: '' };
    expect(keys.handled(pick)).toBe(false);
    keys.seen(real({ code: 'KeyP' }));
    expect(keys.handled(pick)).toBe(true);
    // Another combination, or the same one long after, is a press of its own.
    expect(keys.handled(entry('photo.reject').key ?? { key: '', code: '' })).toBe(false);
    now += 1000;
    expect(keys.handled(pick)).toBe(false);
  });

  it('counts the 300 ms from the end of the dispatch, so a slow handler still drops the menu event', () => {
    let now = 0;
    let finish = () => {};
    const keys = recentKey(
      () => now,
      (fn) => {
        finish = fn;
      },
    );
    const undo = entry('edit.undo').key ?? { key: '', code: '' };
    keys.seen(real({ code: 'KeyZ', metaKey: true }));
    // The handlers run for a second.
    now = 1000;
    expect(keys.handled(undo)).toBe(true);
    finish();
    now = 1200;
    expect(keys.handled(undo)).toBe(true);
    now = 1400;
    expect(keys.handled(undo)).toBe(false);
  });

  it('ignores the keydowns the menu itself dispatches', () => {
    const keys = recentKey(
      () => 0,
      (fn) => fn(),
    );
    const undo = entry('edit.undo').key ?? { key: '', code: '' };
    keys.seen(new KeyboardEvent('keydown', keyEventInit(undo)));
    expect(keys.handled(undo)).toBe(false);
    keys.seen(real({ code: 'KeyZ', metaKey: true }));
    expect(keys.handled(undo)).toBe(true);
    // Shift makes it Redo.
    expect(keys.handled(entry('edit.redo').key ?? { key: '', code: '' })).toBe(false);
  });
});
