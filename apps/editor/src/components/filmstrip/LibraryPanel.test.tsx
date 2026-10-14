// @vitest-environment jsdom
import { DndContext } from '@dnd-kit/core';
import { createEmptyBook, emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoFile } from '../../store/library';

const F = '01K7F000000000000000000000';

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  listFolders: vi.fn(async () => [{ id: F, path: '/trip', name: 'Trip', addedAt: 1, lastSeen: 1, missing: false }]),
  readIndex: vi.fn(async () => ({})),
  readLibrary: vi.fn(async () => null),
  scanFolder: vi.fn(async () => {
    throw 'The folder cannot be read';
  }),
}));

const { useBookStore } = await import('../../store/book');
const { useLibraryStore } = await import('../../store/library');
const { useUiStore } = await import('../../store/ui');
const { LibraryPanel } = await import('./LibraryPanel');

const photo = (relPath: string, hash: string, mtime: number): PhotoFile => ({
  relPath,
  size: 1,
  mtime,
  kind: 'jpeg',
  hash,
  width: 1200,
  height: 800,
  status: 'ready',
  thumbUrl: `asset://c/${hash}/thumb.jpg`,
});

beforeEach(() => {
  // ResizeObserver and a width for the virtual grid.
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
  book.assets = { A: { path: 'a.jpg', folder: F, hash: 'ha', size: 1 } };
  useBookStore.setState({ book, projectId: 'P', folder: '/trip', libraries: { '/trip': emptyLibrary() } });
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: { 'a.jpg': photo('a.jpg', 'ha', 1), 'b.jpg': photo('b.jpg', 'hb', 2) },
        progress: { hashed: 2, prepared: 2, total: 2 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
  useLibraryStore.getState().reset();
  useUiStore.getState().setLibraryView({ hideUsed: false });
});

describe('Design stage Library tab', () => {
  it('lists the folder, marks what the project holds, and adds the rest as refs', async () => {
    render(
      <DndContext>
        <LibraryPanel />
      </DndContext>,
    );
    await waitFor(() => expect((screen.getByLabelText('Library folder') as HTMLSelectElement).value).toBe(F));
    await waitFor(() => expect(screen.getByRole('img', { name: 'In the project' })).toBeTruthy());
    const add = screen.getByRole('button', { name: 'Add 1 to project' });
    await act(async () => {
      fireEvent.click(add);
    });
    await waitFor(() => expect(Object.keys(useBookStore.getState().book?.assets ?? {})).toHaveLength(2));
    const added = Object.entries(useBookStore.getState().book?.assets ?? {}).find(([id]) => id !== 'A')?.[1];
    expect(added).toMatchObject({ path: 'b.jpg', folder: F, hash: 'hb', width: 1200 });
    expect(screen.getByRole('button', { name: 'Add 0 to project' })).toBeTruthy();

    // Hide in project leaves only the photos it does not hold yet.
    fireEvent.click(screen.getByRole('button', { name: 'Hide in project' }));
    expect(screen.getByText('No photos match these filters')).toBeTruthy();
  });
});

describe('Library tab scanning', () => {
  it('scans a folder that cannot be read once, not in a loop', async () => {
    const { scanFolder } = await import('../../lib/tauri');
    vi.mocked(scanFolder).mockClear();
    useLibraryStore.setState((s) => {
      const folder = s.folders[F];
      return folder ? { folders: { [F]: { ...folder, photos: {}, scanned: false } } } : {};
    });
    render(
      <DndContext>
        <LibraryPanel />
      </DndContext>,
    );
    await waitFor(() => expect(useLibraryStore.getState().folders[F]?.error).toMatch(/cannot be read/));
    await new Promise((r) => setTimeout(r, 200));
    expect(vi.mocked(scanFolder)).toHaveBeenCalledTimes(1);
  });
});
