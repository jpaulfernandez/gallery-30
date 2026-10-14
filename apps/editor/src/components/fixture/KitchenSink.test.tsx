// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));

import { useBookStore } from '../../store/book';
import { DEFAULT_UI_PREFS, useUiStore } from '../../store/ui';
import { COLOR_TOKENS, KitchenSink } from './KitchenSink';

afterEach(() => {
  cleanup();
  localStorage.clear();
  useUiStore.setState({ surround: DEFAULT_UI_PREFS.surround });
});

/** A block's custom properties in `styles.css` (the first block that starts with `start`). */
function tokens(start: string): Record<string, string> {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles.css'), 'utf8');
  const from = css.indexOf(start);
  const body = css.slice(css.indexOf('{', from) + 1, css.indexOf('}', from));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

describe('KitchenSink', () => {
  it('with reduced motion every duration token computes to 0 (plan 49)', () => {
    const theme = tokens('@theme');
    const reduced = tokens('@media (prefers-reduced-motion: reduce)');
    const motion = Object.keys(theme).filter((name) => name.startsWith('dur-') || name === 'stagger');
    expect(motion).toEqual(['dur-fast', 'dur-base', 'dur-slow', 'stagger', 'dur-check', 'dur-hold']);
    const declare = (vars: Record<string, string>, names: string[]) =>
      names.map((name) => `--${name}: ${vars[name]};`).join(' ');
    // jsdom evaluates no media query: the tokens, then the reduced-motion block as if it matched.
    const style = document.createElement('style');
    style.textContent = `:root { ${declare(theme, motion)} }`;
    document.head.append(style);
    const { unmount } = render(<KitchenSink />);
    expect(screen.getByTestId('motion-dur-hold').textContent).toBe('400ms');
    unmount();
    style.textContent += ` :root { ${declare(reduced, Object.keys(reduced))} }`;
    render(<KitchenSink />);
    for (const name of motion) expect(screen.getByTestId(`motion-${name}`).textContent, name).toBe('0ms');
    style.remove();
  });

  it('renders every colour token without calling Tauri', () => {
    render(<KitchenSink />);
    for (const t of COLOR_TOKENS) expect(screen.getByTestId(`swatch-${t}`)).toBeTruthy();
    for (const r of ['xs', 'sm', 'md', 'lg', 'pill']) expect(screen.getByText(`radius-${r}`)).toBeTruthy();
    for (const d of ['fast', 'base', 'slow']) expect(screen.getByText(`--dur-${d}`)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('has a Primitives page and a Shell page, neither calling Tauri (plan 45)', () => {
    render(<KitchenSink />);
    fireEvent.click(screen.getByRole('button', { name: 'Primitives' }));
    for (const block of [
      'Button',
      'Segmented',
      'Fields',
      'Menu',
      'Popover and tooltip',
      'Toast',
      'Delight',
      'Tag, ring, count',
    ]) {
      expect(screen.getByTestId(`primitive-${block}`)).toBeTruthy();
    }
    // Plan 54: the Develop cards, Basic and Advanced, on synthetic settings.
    const develop = screen.getByTestId('develop-sink');
    expect(within(develop).getAllByTestId('develop-panel')).toHaveLength(2);
    expect(within(develop).getAllByText('·edited').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect(screen.getByTestId('shell-sink')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Stages (shell)' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Library (shell)' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('has a Design page drawn by the real canvas, inspector and page strip, without calling Tauri (plan 48)', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // jsdom has no scrollIntoView (the page strip keeps the current tile in view).
    Element.prototype.scrollIntoView ??= () => {};
    const { unmount } = render(<KitchenSink />);
    fireEvent.click(screen.getByRole('button', { name: 'Design' }));
    expect(screen.getByTestId('design-sink')).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Canvas tools' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select two frames' }));
    expect(screen.getByRole('toolbar', { name: 'Align' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    // Leaving the page puts the stores back.
    unmount();
    expect(useBookStore.getState().book).toBeNull();
  });

  it('has a Home page with cover cards and folder rows, without calling Tauri (plan 50)', () => {
    render(<KitchenSink />);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByTestId('home-sink')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Lisbon zine' })).toBeTruthy();
    expect(document.querySelector('[data-cover="empty"]')).toBeTruthy();
    expect(screen.getByText('culled ✓')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('has a Cull page with every cell state, the pill and a live grid, without calling Tauri (plan 47)', () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const { unmount } = render(<KitchenSink />);
    fireEvent.click(screen.getByRole('button', { name: 'Cull' }));
    expect(screen.getByTestId('cull-sink')).toBeTruthy();
    expect(screen.getByText('Selected and focused')).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: 'Batch actions (sink)' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: 'Photos' })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    // Leaving the page puts the stores back.
    unmount();
    expect(useUiStore.getState().review).toBeNull();
  });

  it('switches the surround', () => {
    render(<KitchenSink />);
    fireEvent.click(screen.getByRole('radio', { name: 'Mid grey' }));
    expect(useUiStore.getState().surround).toBe('mid');
    expect(screen.getByRole('radio', { name: 'Mid grey' }).getAttribute('aria-checked')).toBe('true');
  });
});
