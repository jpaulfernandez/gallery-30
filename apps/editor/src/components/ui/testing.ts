import { fireEvent, screen } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Plan 45's menu check, shared by every menu test: the trigger opens its menu on Enter, Space and ArrowDown with the
 * focus on the first item; Escape closes it and gives the focus back to the trigger.
 */
export function expectMenuKeys(trigger: () => HTMLElement, menu: string | RegExp): void {
  for (const key of ['Enter', ' ', 'ArrowDown']) {
    const button = trigger();
    button.focus();
    fireEvent.keyDown(button, { key });
    const panel = screen.getByRole('menu', { name: menu });
    expect(document.activeElement, `${JSON.stringify(key)} focuses the first item`).toBe(firstItem(panel));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: menu }), `Escape closes after ${JSON.stringify(key)}`).toBeNull();
    expect(document.activeElement, 'the focus is back on the trigger').toBe(trigger());
  }
}

/**
 * The same check for a context menu: a right-click on `target` opens it with the focus on the first item, ArrowDown
 * moves, and Escape closes it and gives the focus back to `target`.
 */
export function expectContextMenuKeys(target: () => HTMLElement, menu: string | RegExp): void {
  const el = target();
  el.focus();
  fireEvent.contextMenu(el, { clientX: 20, clientY: 20 });
  const panel = screen.getByRole('menu', { name: menu });
  const items = [...panel.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')];
  expect(document.activeElement, 'the first item has the focus').toBe(items[0]);
  if (items.length > 1) {
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement, 'ArrowDown moves').toBe(items[1]);
  }
  fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
  expect(screen.queryByRole('menu', { name: menu })).toBeNull();
  expect(document.activeElement, 'the focus is back where it was').toBe(target());
}

function firstItem(panel: HTMLElement): Element | null {
  return panel.querySelector('[role^="menuitem"]:not([aria-disabled="true"])');
}
