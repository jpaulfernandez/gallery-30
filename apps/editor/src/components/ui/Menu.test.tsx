// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem, MenuSeparator, useContextMenu } from './Menu';
import { expectContextMenuKeys, expectMenuKeys } from './testing';

afterEach(cleanup);

function FileMenu({ onRename = () => {}, onWindowKey }: { onRename?: () => void; onWindowKey?: () => void }) {
  if (onWindowKey) window.onkeydown = onWindowKey;
  const [grid, setGrid] = useState(false);
  return (
    <Menu label="File ▾" menuLabel="File">
      <MenuItem onSelect={onRename} shortcut="⌘R">
        Rename…
      </MenuItem>
      <MenuItem disabled>Preview</MenuItem>
      <MenuSeparator />
      <MenuItem checked={grid} onSelect={() => setGrid((g) => !g)}>
        Show grid
      </MenuItem>
      <MenuItem danger>Delete</MenuItem>
    </Menu>
  );
}

const trigger = () => screen.getByRole('button', { name: 'File ▾' });

describe('Menu', () => {
  it('opens on Enter, Space and ArrowDown, closes on Escape and returns the focus', () => {
    render(<FileMenu />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expectMenuKeys(trigger, 'File');
  });

  it('moves with the arrows, Home and End, skipping disabled items', () => {
    render(<FileMenu />);
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const name = () => document.activeElement?.textContent;
    expect(name()).toBe('Rename…⌘R');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(name()).toContain('Show grid');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(name()).toBe('Delete');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(name()).toBe('Rename…⌘R');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(name()).toBe('Delete');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(name()).toBe('Rename…⌘R');
  });

  it('closes before running an item; a check item stays open and toggles', () => {
    // The focus is back on the trigger before the item runs (an item that opens a field takes it from there).
    const onRename = vi.fn(() => expect(document.activeElement).toBe(trigger()));
    render(<FileMenu onRename={onRename} />);
    fireEvent.click(trigger());
    const grid = screen.getByRole('menuitemcheckbox', { name: /Show grid/ });
    expect(grid.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(grid);
    expect(screen.getByRole('menuitemcheckbox', { name: /Show grid/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview' }));
    expect(screen.getByRole('menu', { name: 'File' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a press outside, and keeps its keys from the window', () => {
    const onWindowKey = vi.fn();
    render(<FileMenu onWindowKey={onWindowKey} />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(onWindowKey).not.toHaveBeenCalled();
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    window.onkeydown = null;
  });
});

function Rows() {
  const menu = useContextMenu<string>();
  return (
    <>
      <a href="#a" onContextMenu={(e) => menu.onContextMenu(e, 'a')}>
        Row a
      </a>
      <input aria-label="Name" onContextMenu={(e) => menu.onContextMenu(e, 'field')} />
      <span data-native-menu>
        <a href="#b" onContextMenu={(e) => menu.onContextMenu(e, 'b')}>
          Row b
        </a>
      </span>
      <Menu.Context at={menu.at} label={`Row ${menu.menu?.data ?? ''}`} onClose={menu.close}>
        <MenuItem>Rename…</MenuItem>
        <MenuItem>Export…</MenuItem>
      </Menu.Context>
    </>
  );
}

describe('Menu.Context', () => {
  it('opens at the pointer on a right-click, moves, closes on Escape and returns the focus', () => {
    render(<Rows />);
    expectContextMenuKeys(() => screen.getByText('Row a'), 'Row a');
  });

  it('cancels the browser menu where it opens, and leaves the system menu to text fields and data-native-menu', () => {
    render(<Rows />);
    const ours = fireEvent.contextMenu(screen.getByText('Row a'), { clientX: 5, clientY: 5 });
    expect(ours).toBe(false);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Name' }))).toBe(true);
    expect(fireEvent.contextMenu(screen.getByText('Row b'))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a press outside without moving the focus', () => {
    render(<Rows />);
    fireEvent.contextMenu(screen.getByText('Row a'), { clientX: 5, clientY: 5 });
    expect(screen.getByRole('menu', { name: 'Row a' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
