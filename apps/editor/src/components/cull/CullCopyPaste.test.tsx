// @vitest-environment jsdom
import { emptyLibrary, type Library } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undo, useBookStore } from '../../store/book';
import { libraryKeys } from '../../store/collections';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { CopySettingsDialog } from '../develop/CopySettingsDialog';
import { clearDevelopClipboard } from '../develop/copyPaste';
import { CullGrid } from './CullGrid';
import { CULL_KEYS, cullKeyAction } from './keys';

const F = 'F1';
const SOURCE = { kind: 'folder', id: F } as const;
const key = (name: string) => photoKey({ folder: F, path: name });

const photo = (relPath: string, mtime: number): PhotoFile => ({
  relPath,
  size: 1,
  mtime,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  width: 1200,
  height: 800,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
  proxyUrl: `asset://c/${relPath}/proxy.jpg`,
});

/** Capture order differs from name order: by time b, d, a, e, c, f. */
const MTIMES: Record<string, number> = { 'a.jpg': 3, 'b.jpg': 1, 'c.jpg': 5, 'd.jpg': 2, 'e.jpg': 4, 'f.jpg': 6 };

function setFolder(library: Library = emptyLibrary()) {
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: Object.fromEntries(Object.entries(MTIMES).map(([name, mtime]) => [name, photo(name, mtime)])),
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': library } });
}

const keysFor = (sort: 'time' | 'name') =>
  libraryKeys(SOURCE, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    sort,
  });
const option = (name: string) => screen.getByRole('option', { name });
const press = (init: Partial<KeyboardEventInit> & { key: string }, target: Window | Element = window) =>
  fireEvent.keyDown(target, init);
const developOf = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`]?.develop;
const steps = () => useBookStore.temporal.getState().pastStates.length;

/** a.jpg is edited: exposure +1 and saturation −30. */
function seed() {
  const library = emptyLibrary();
  setFolder(library);
  useBookStore.getState().setAssetDevelop(key('a.jpg'), { light: { exposure: 1 }, color: { saturation: -30 } });
  useBookStore.temporal.getState().clear();
}

function open(sort: 'time' | 'name', focus: string) {
  const ids = keysFor(sort);
  render(
    <>
      <CullGrid />
      <CopySettingsDialog />
    </>,
  );
  act(() => useUiStore.getState().openReview(ids, ids.indexOf(key(focus))));
  return ids;
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  useUiStore.setState({
    review: null,
    selection: EMPTY_SELECTION,
    cull: { columns: 5, view: 'grid', scrollTop: 0, grouped: true, showStars: false, expanded: null, zoom: 'fit' },
    copyDialog: null,
    copySections: ['basic', 'curve', 'color', 'detail', 'denoise'],
  });
  clearDevelopClipboard();
  seed();
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION, copyDialog: null });
});

describe('Cull grid copy and paste (workflow plan 10)', () => {
  it('Cmd+Shift+C copies the focused photo, Cmd+Shift+V pastes onto the selection in one undo step', () => {
    open('name', 'a.jpg');
    press({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    act(() => useUiStore.getState().setSelection(['b.jpg', 'c.jpg', 'd.jpg'].map(key)));
    press({ key: 'V', code: 'KeyV', metaKey: true, shiftKey: true });
    for (const name of ['b.jpg', 'c.jpg', 'd.jpg']) {
      expect(developOf(name)?.light.exposure).toBe(1);
      expect(developOf(name)?.color.saturation).toBe(-30);
    }
    expect(developOf('e.jpg')).toBeUndefined();
    expect(steps()).toBe(1);
    undo();
    expect(['b.jpg', 'c.jpg', 'd.jpg'].map(developOf)).toEqual([undefined, undefined, undefined]);
    expect(developOf('a.jpg')?.light.exposure).toBe(1);
  });

  it('pastes onto the focused photo when nothing is selected', () => {
    open('name', 'a.jpg');
    press({ key: 'c', metaKey: true, shiftKey: true });
    press({ key: 'ArrowRight' });
    press({ key: 'v', metaKey: true, shiftKey: true });
    expect(developOf('b.jpg')?.light.exposure).toBe(1);
    expect(developOf('c.jpg')).toBeUndefined();
  });

  it('Cmd+Alt+V pastes from the photo before the focused one in the order shown, under each sort', () => {
    // By name a, b, …: before b is a (edited).
    open('name', 'b.jpg');
    press({ key: '√', code: 'KeyV', metaKey: true, altKey: true });
    expect(developOf('b.jpg')?.light.exposure).toBe(1);
    cleanup();
    seed();

    // By time b, d, a, e, …: before e is a; before a is d (unedited), so a paste onto a would reset its tone.
    open('time', 'e.jpg');
    press({ key: '√', code: 'KeyV', metaKey: true, altKey: true });
    expect(developOf('e.jpg')?.color.saturation).toBe(-30);
    expect(developOf('b.jpg')).toBeUndefined();
    act(() => useUiStore.getState().setReviewIndex(keysFor('time').indexOf(key('a.jpg'))));
    press({ key: '√', code: 'KeyV', metaKey: true, altKey: true });
    expect(developOf('a.jpg')).toBeUndefined();
    // The first photo has no previous one.
    act(() => useUiStore.getState().setReviewIndex(0));
    expect(press({ key: '√', code: 'KeyV', metaKey: true, altKey: true })).toBe(false);
    expect(developOf('b.jpg')).toBeUndefined();
  });

  it('Shift+Cmd+Alt+C opens Copy Settings on the focused photo', () => {
    open('name', 'a.jpg');
    press({ key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Copy settings from a.jpg' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Basic/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Remember/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    // Not remembered: Cmd+Shift+C still copies the default sections.
    expect(useUiStore.getState().copySections).toContain('basic');
    act(() => useUiStore.getState().setSelection([key('f.jpg')]));
    press({ key: 'v', metaKey: true, shiftKey: true });
    expect(developOf('f.jpg')?.light.exposure).toBe(0);
    expect(developOf('f.jpg')?.color.saturation).toBe(-30);
  });

  it('leaves the keys alone while Copy Settings is open, also with the focus dropped to the page', () => {
    open('name', 'a.jpg');
    press({ key: 'c', metaKey: true, shiftKey: true });
    act(() => useUiStore.getState().setSelection([key('b.jpg')]));
    press({ key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true });
    expect(screen.getByRole('dialog', { name: 'Copy settings from a.jpg' })).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press({ key: 'v', metaKey: true, shiftKey: true }, document.body)).toBe(true);
    expect(developOf('b.jpg')).toBeUndefined();
  });

  it('the context menu pastes onto the selection and resets edits, selecting the photo first when it is not in it', () => {
    open('name', 'a.jpg');
    fireEvent.contextMenu(option('a.jpg'));
    let menu = screen.getByRole('menu', { name: 'Photo actions' });
    expect(useUiStore.getState().selection.keys).toEqual([key('a.jpg')]);
    // Nothing copied yet (outside the app the system clipboard is not read).
    // Plan 47: `MenuItem` marks a disabled row with `aria-disabled`.
    expect(
      within(menu)
        .getByRole('menuitem', { name: /^Paste settings/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Copy settings\s*⇧⌘C/ }));
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => useUiStore.getState().setSelection(['b.jpg', 'c.jpg'].map(key)));
    fireEvent.contextMenu(option('c.jpg'));
    menu = screen.getByRole('menu', { name: 'Photo actions' });
    expect(useUiStore.getState().selection.keys).toEqual(['b.jpg', 'c.jpg'].map(key));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Paste settings to 2 photos/ }));
    expect(developOf('b.jpg')?.light.exposure).toBe(1);
    expect(developOf('c.jpg')?.light.exposure).toBe(1);
    expect(steps()).toBe(1);

    fireEvent.contextMenu(option('b.jpg'));
    menu = screen.getByRole('menu', { name: 'Photo actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Reset edits of 2 photos/ }));
    expect(developOf('b.jpg')).toBeUndefined();
    expect(developOf('c.jpg')).toBeUndefined();
    expect(steps()).toBe(2);
  });

  it('Reset edits from the menu asks first above five edited photos', () => {
    open('name', 'a.jpg');
    press({ key: 'c', metaKey: true, shiftKey: true });
    const all = keysFor('name');
    act(() => useUiStore.getState().setSelection(all));
    press({ key: 'v', metaKey: true, shiftKey: true });
    fireEvent.contextMenu(option('d.jpg'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reset edits of 6 photos/ }));
    expect(screen.getByText('Reset edits of 6 photos?')).toBeTruthy();
    expect(developOf('d.jpg')).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset' }));
    expect(all.every((id) => developOf(id.slice(F.length + 1)) === undefined)).toBe(true);
  });

  it('leaves the keys to a text field or an editable element, and lists them for the README', () => {
    open('name', 'a.jpg');
    press({ key: 'c', metaKey: true, shiftKey: true });
    const editor = document.createElement('div');
    editor.contentEditable = 'plaintext-only';
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    document.body.append(editor);
    act(() => useUiStore.getState().setReviewIndex(1));
    expect(press({ key: 'v', metaKey: true, shiftKey: true }, editor)).toBe(true);
    expect(press({ key: '√', code: 'KeyV', metaKey: true, altKey: true }, editor)).toBe(true);
    expect(developOf('b.jpg')).toBeUndefined();
    editor.remove();

    const action = (init: Partial<KeyboardEvent>) =>
      cullKeyAction({ key: '', code: '', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...init });
    expect(action({ key: 'C', shiftKey: true })).toEqual({ type: 'copy', dialog: false });
    expect(action({ key: 'Ç', code: 'KeyC', shiftKey: true, altKey: true })).toEqual({ type: 'copy', dialog: true });
    expect(action({ key: 'V', shiftKey: true })).toEqual({ type: 'paste', previous: false });
    expect(action({ key: '√', code: 'KeyV', altKey: true })).toEqual({ type: 'paste', previous: true });
    // Alt alone (no Cmd) is still nothing.
    expect(action({ key: '√', code: 'KeyV', altKey: true, metaKey: false })).toBeNull();
    expect(CULL_KEYS.map((k) => k.keys)).toEqual(
      expect.arrayContaining(['Cmd+Shift+C, Shift+Cmd+Alt+C', 'Cmd+Shift+V, Cmd+Alt+V', 'Right-click']),
    );
  });
});
