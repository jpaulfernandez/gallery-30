// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBookStore } from '../../store/book';
import { loadPanes, PANES_KEY, togglePanes, useUiStore } from '../../store/ui';
import { paneKeyAction } from '../cull/keys';
import { useEditorShortcuts } from '../editor/useEditorShortcuts';
import { PaneShell, useCullPaneKeys } from './Panes';

/** Plan 51: `ui.panes`, the Tab / Shift+Tab keys and the stage shell. */

const SHOWN = { left: true, right: true, strip: true };
const showAll = () =>
  useUiStore.setState({ panes: { cull: { ...SHOWN }, develop: { ...SHOWN }, design: { ...SHOWN } } });

beforeEach(() => {
  localStorage.removeItem(PANES_KEY);
  showAll();
});
afterEach(() => {
  cleanup();
  localStorage.removeItem(PANES_KEY);
  showAll();
});

describe('pane state', () => {
  it('Tab hides both side panes or shows both; Shift+Tab all three', () => {
    expect(togglePanes(SHOWN, 'panes')).toEqual({ left: false, right: false, strip: true });
    expect(togglePanes({ left: false, right: true, strip: true }, 'panes')).toEqual({
      left: false,
      right: false,
      strip: true,
    });
    expect(togglePanes({ left: false, right: false, strip: true }, 'panes')).toEqual(SHOWN);
    expect(togglePanes({ left: false, right: false, strip: true }, 'all')).toEqual({
      left: false,
      right: false,
      strip: false,
    });
    expect(togglePanes({ left: false, right: false, strip: false }, 'all')).toEqual(SHOWN);
  });

  it('is per stage and per machine (localStorage), never in the project file', () => {
    useBookStore.setState({ book: null });
    const before = useBookStore.getState();
    act(() => useUiStore.getState().togglePanes('develop', 'all'));
    const { panes } = useUiStore.getState();
    expect(panes.develop).toEqual({ left: false, right: false, strip: false });
    expect(panes.cull).toEqual(SHOWN);
    expect(panes.design).toEqual(SHOWN);
    expect(useBookStore.getState()).toBe(before);
    // A new session (the store loads again) finds them.
    expect(loadPanes().develop).toEqual({ left: false, right: false, strip: false });
    expect(loadPanes().cull).toEqual(SHOWN);
    // Kept across a book reset.
    act(() => useUiStore.getState().reset());
    expect(useUiStore.getState().panes.develop.left).toBe(false);
  });

  it('reads an unreadable or partial value as every pane shown', () => {
    localStorage.setItem(PANES_KEY, '{nope');
    expect(loadPanes().cull).toEqual(SHOWN);
    localStorage.setItem(PANES_KEY, JSON.stringify({ design: { strip: false, left: 'x' } }));
    expect(loadPanes().design).toEqual({ left: true, right: true, strip: false });
  });
});

describe('paneKeyAction', () => {
  const key = (init: Partial<KeyboardEvent> & { target?: EventTarget | null }) =>
    paneKeyAction({
      key: 'Tab',
      code: 'Tab',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      repeat: false,
      target: document.body,
      ...init,
    });

  it('Tab and Shift+Tab, never with a modifier', () => {
    expect(key({})).toBe('panes');
    expect(key({ shiftKey: true })).toBe('all');
    expect(key({ metaKey: true })).toBeNull();
    expect(key({ altKey: true })).toBeNull();
    expect(key({ key: 'a' })).toBeNull();
    // A held Tab toggles once.
    expect(key({ repeat: true })).toBeNull();
  });

  it('never in a text field, on a control, in a menu or in a dialog', () => {
    document.body.innerHTML = `
      <input id="text" /><textarea id="area"></textarea><div id="edit" contenteditable="true"></div>
      <button id="button">B</button><div role="slider" id="slider" tabindex="0"></div>
      <div role="menu"><div id="item" tabindex="-1">x</div></div>
      <div role="dialog"><div id="inside" tabindex="-1">x</div></div>
      <div role="listbox" id="grid" tabindex="0"></div>`;
    const at = (id: string) => document.getElementById(id);
    for (const id of ['text', 'area', 'button', 'slider', 'item', 'inside']) {
      expect(key({ target: at(id) }), id).toBeNull();
    }
    const edit = at('edit') as HTMLElement;
    Object.defineProperty(edit, 'isContentEditable', { value: true });
    expect(key({ target: edit })).toBeNull();
    // The Cull grid (a listbox with the focus) is the picture: Tab hides the panes there.
    expect(key({ target: at('grid') })).toBe('panes');
    document.body.innerHTML = '';
  });
});

function CullShell({ enabled = true }: { enabled?: boolean }) {
  useCullPaneKeys(enabled);
  return (
    <PaneShell
      stage="cull"
      top={<header>Top</header>}
      left={<nav aria-label="Left" />}
      right={<aside aria-label="Right" />}
      strip={<div>Strip</div>}
    >
      <main aria-label="Centre" />
    </PaneShell>
  );
}

describe('PaneShell and the Cull keys', () => {
  it('shows what `ui.panes.cull` has on; Tab and Shift+Tab toggle it', () => {
    render(<CullShell />);
    expect(screen.getByRole('navigation', { name: 'Left' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Right' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.queryByRole('navigation', { name: 'Left' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Right' })).toBeNull();
    expect(screen.getByText('Strip')).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Centre' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(screen.queryByText('Strip')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('Strip')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Left' })).toBeTruthy();
  });

  it('does nothing when not enabled (the library route on Develop)', () => {
    render(<CullShell enabled={false} />);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(useUiStore.getState().panes.cull).toEqual(SHOWN);
  });

  it('leaves Tab to Compare and to Develop open over Cull', () => {
    render(<CullShell />);
    act(() => useUiStore.getState().setCull({ view: 'compare' }));
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(useUiStore.getState().panes.cull.left).toBe(true);
    act(() => {
      useUiStore.getState().setCull({ view: 'grid' });
      useUiStore.getState().openDevelop(['a'], 0);
    });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(useUiStore.getState().panes.cull.left).toBe(true);
    act(() => useUiStore.getState().closeDevelop());
  });
});

function DesignKeys() {
  useEditorShortcuts();
  return <input aria-label="Field" />;
}

describe('Design keys', () => {
  it('Tab toggles the Design panes, not from a text field', () => {
    render(<DesignKeys />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Field' }), { key: 'Tab' });
    expect(useUiStore.getState().panes.design.left).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(useUiStore.getState().panes.design).toEqual({ left: false, right: false, strip: true });
    expect(useUiStore.getState().panes.cull).toEqual(SHOWN);
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(useUiStore.getState().panes.design).toEqual({ left: false, right: false, strip: false });
  });
});
