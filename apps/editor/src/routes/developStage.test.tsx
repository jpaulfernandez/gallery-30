// @vitest-environment jsdom
import { emptyLibrary, serializeLibrary } from '@photobook/shared';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder, ScannedFile } from '../lib/tauri';

const F = '01K7F000000000000000000000';
const folders: Folder[] = [{ id: F, path: '/trip', name: 'Trip', addedAt: 1, lastSeen: 1, missing: false }];
const h = (c: string) => c.repeat(64);
const scanned = (relPath: string, i: number): ScannedFile => ({
  relPath,
  size: i,
  mtimeMs: i,
  kind: 'jpeg',
  hash: h(relPath[0] ?? 'x'),
});

/** a: pick, b: unflagged, c: reject, d: unflagged. */
const library = vi.hoisted(() => ({ text: '' }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  getRecent: vi.fn(async () => null),
  listFolders: vi.fn(async () => folders),
  listProjects: vi.fn(async () => []),
  readIndex: vi.fn(async () => ({})),
  writeIndex: vi.fn(async () => {}),
  readCollections: vi.fn(async () => []),
  readLibrary: vi.fn(async () => library.text),
  scanFolder: vi.fn(async () => ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(scanned)),
  prepareAsset: vi.fn(async (_folder: string, relPath: string) => ({
    width: 1200,
    height: 800,
    orientation: 1,
    thumbPath: `/cache/${relPath}/thumb.jpg`,
    proxyPath: `/cache/${relPath}/proxy.jpg`,
    isRaw: false,
  })),
  renderDevelopPreview: vi.fn(async () => null),
  fileUrl: (path: string) => `asset://localhost${path}`,
}));
vi.mock('./book', () => ({ BookRoute: () => <p>Design stage</p> }));

const { resetLaunch, routeTree } = await import('../router');
const { useBookStore } = await import('../store/book');
const { useLibraryStore } = await import('../store/library');
const { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } = await import('../store/ui');

async function visit(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

/** File names in the Develop strip, in order. */
const strip = () =>
  screen
    .queryAllByRole('button', { name: /^Develop / })
    .map((b) => b.getAttribute('aria-label')?.replace('Develop ', ''));

beforeEach(() => {
  // The Cull grid measures itself.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  resetLaunch();
  const lib = emptyLibrary();
  lib.photos[h('a')] = { flag: 'pick', versions: {} };
  lib.photos[h('c')] = { flag: 'reject', versions: {} };
  library.text = serializeLibrary(lib);
  useUiStore.setState({ libraryView: DEFAULT_FILMSTRIP, selection: EMPTY_SELECTION });
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
  useLibraryStore.getState().reset();
});

describe('the Develop stage strip', () => {
  it('follows the Cull filter, with rejects hidden at All flags', async () => {
    await visit(`/library/${F}/develop`);
    await waitFor(() => expect(strip()).toEqual(['a.jpg', 'b.jpg', 'd.jpg']));
    const flag = screen.getByRole('combobox', { name: 'Filter by flag' }) as HTMLSelectElement;
    expect(flag.selectedOptions[0]?.textContent).toBe('All but rejects');
    act(() => {
      fireEvent.change(flag, { target: { value: 'picks' } });
    });
    await waitFor(() => expect(strip()).toEqual(['a.jpg']));
    act(() => {
      fireEvent.change(flag, { target: { value: 'rejects' } });
    });
    await waitFor(() => expect(strip()).toEqual(['c.jpg']));
    // The same filter state as Cull: back to All flags, Cull shows the reject too.
    act(() => {
      fireEvent.change(flag, { target: { value: 'all' } });
    });
    await waitFor(() => expect(strip()).toEqual(['a.jpg', 'b.jpg', 'd.jpg']));
    expect(useUiStore.getState().libraryView.flag).toBe('all');
  });

  it('keeps the selection made in Cull within what it shows', async () => {
    const router = await visit(`/library/${F}/cull`);
    await waitFor(() => expect(Object.keys(useLibraryStore.getState().folders[F]?.photos ?? {})).toHaveLength(4));
    await waitFor(() => expect(Object.keys(useBookStore.getState().libraries)).toEqual(['/trip']));
    act(() => useUiStore.getState().setSelection([`${F}/b.jpg`, `${F}/c.jpg`]));
    await act(async () => {
      await router.navigate({ to: '/library/$folderId/develop', params: { folderId: F } });
    });
    await waitFor(() => expect(strip()).toEqual(['a.jpg', 'b.jpg', 'd.jpg']));
    expect(useUiStore.getState().selection.keys).toEqual([`${F}/b.jpg`]);
    expect(screen.getByRole('button', { name: 'Develop b.jpg' }).dataset.selected).toBe('true');
    expect(screen.getByRole('toolbar', { name: 'Batch actions' }).textContent).toMatch(/1 selected/);
  });
});
