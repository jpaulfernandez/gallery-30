// @vitest-environment jsdom
import { type Book, createEmptyBook, emptyLibrary, type Library } from '@photobook/shared';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary, TrashResult } from '../../lib/tauri';
import type { PhotoFile } from '../../store/library';

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  trashPhotos: vi.fn(
    async (_folder: string, relPaths: string[]): Promise<TrashResult[]> =>
      relPaths.map((path) => ({ path, ok: true, sidecars: [] })),
  ),
  writeIndex: vi.fn(async () => {}),
  listProjects: vi.fn(async (): Promise<ProjectSummary[]> => []),
  readProject: vi.fn(async () => '{}'),
}));

const { listProjects, readProject, trashPhotos, writeIndex } = await import('../../lib/tauri');
const { useAssetsStore } = await import('../../store/assets');
const { useBookStore } = await import('../../store/book');
const { libraryKeys } = await import('../../store/collections');
const { useCullStore } = await import('../../store/cull');
const { useJobsStore } = await import('../../store/jobs');
const { photoKey, useLibraryStore } = await import('../../store/library');
const { useProjectsStore } = await import('../../store/projects');
const { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } = await import('../../store/ui');
const { useToasts } = await import('../ui/Toast');
const { ProjectMenu } = await import('../shell/ProjectMenu');
const { CullMenu } = await import('./CullMenu');
const { CullView } = await import('./CullView');
const { openRejectPile, TRASH_INLINE_MAX, useRejectPileStore } = await import('./rejectPile');

const F = 'F1';
const DIR = '/trip';
const key = (name: string) => photoKey({ folder: F, path: name });

const photo = (relPath: string, mtime: number): PhotoFile => ({
  relPath,
  size: 2_000_000,
  mtime,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
});

/** By time: s1 kept, s2 rejected, b1 and b2 rejected, s3 undecided. */
const NAMES = ['s1.jpg', 's2.jpg', 'b1.jpg', 'b2.jpg', 's3.jpg'];
const FLAGS = { 's1.jpg': 'pick', 's2.jpg': 'reject', 'b1.jpg': 'reject', 'b2.jpg': 'reject' } as const;

function flagged(flags: Record<string, 'pick' | 'reject'>): Library {
  const library = emptyLibrary();
  for (const [name, flag] of Object.entries(flags)) library.photos[`h-${name}`] = { flag, versions: {} };
  return library;
}

function setFolder(names = NAMES, flags: Record<string, 'pick' | 'reject'> = FLAGS) {
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: DIR,
        photos: Object.fromEntries(names.map((n, i) => [n, photo(n, 1000 + i)])),
        progress: { hashed: names.length, prepared: names.length, total: names.length },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, projectId: null, libraries: { [DIR]: flagged(flags) } });
}

/** An open project "Lisbon" whose asset `a1` is b1.jpg. */
function openProject() {
  const book: Book = createEmptyBook({ title: 'Lisbon', folders: { [F]: { path: DIR } } });
  book.assets = { a1: { id: 'a1', path: 'b1.jpg', hash: 'h-b1.jpg', folder: F, size: 2_000_000 } } as Book['assets'];
  useBookStore.setState({ book, folder: DIR, projectId: 'P1' });
}

const keysFor = (view: Partial<typeof DEFAULT_FILMSTRIP> = {}) =>
  libraryKeys({ kind: 'folder', id: F }, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    ...view,
  });

const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);
const flagOf = (name: string) => useBookStore.getState().libraries[DIR]?.photos[`h-${name}`]?.flag;
const shown = () => {
  const review = useUiStore.getState().review;
  return review?.ids[review.index];
};

/** The Cull view over `ids` with the focus on `at`, then *Review rejects…*. */
function openPile(ids = keysFor(), at = 0) {
  render(<CullView />);
  act(() => useUiStore.getState().openReview(ids, at));
  act(() => openRejectPile());
}

async function confirmDialog() {
  fireEvent.click(screen.getByRole('button', { name: /^Move \d+ to the Trash…$/ }));
  // The placement check settles before the move is offered.
  await waitFor(() => expect(screen.queryByText(/Checking which projects/)).toBeNull());
  return screen.getByRole('dialog', { name: 'Move to the Trash' });
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  useUiStore.setState({
    review: null,
    selection: EMPTY_SELECTION,
    cull: { columns: 5, view: 'grid', scrollTop: 0, grouped: false, showStars: false, expanded: null, zoom: 'fit' },
    libraryView: DEFAULT_FILMSTRIP,
  });
  useProjectsStore.setState({ projects: [] });
  useAssetsStore.setState({ missing: {} });
  useToasts.setState({ toasts: [] });
  vi.mocked(trashPhotos).mockClear();
  vi.mocked(writeIndex).mockClear();
  setFolder();
});

afterEach(() => {
  cleanup();
  act(() => useRejectPileStore.setState({ open: false }));
  useLibraryStore.getState().reset();
  useBookStore.setState({ book: null, folder: null, projectId: null, libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('the reject pile', () => {
  it('is every reject of the folder whatever the filter, and the dialog counts the full pile', async () => {
    // Filtered to the kept photos: the list holds s1 only.
    const ids = keysFor({ flag: 'picks' });
    expect(ids).toEqual([key('s1.jpg')]);
    openPile(ids);
    expect(screen.getByRole('region', { name: 'Rejects: 3 photos' })).toBeTruthy();
    expect(screen.getByRole('banner').textContent).toContain('3 photos · 6 MB');
    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('Move 3 photos (6 MB) to the macOS Trash? Photobook cannot undo this.');
    expect(screen.getByRole('button', { name: 'Move 3 to the Trash' })).toBeTruthy();
  });

  it('U rescues the focused photo, then Cmd+A and U the rest, outside undo', () => {
    openPile();
    const past = useBookStore.temporal.getState().pastStates.length;
    // By path: b1, b2, s2; the focus starts on b1.
    press({ key: 'u' });
    expect(flagOf('b1.jpg')).toBeUndefined();
    expect(screen.getByRole('region', { name: 'Rejects: 2 photos' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'b2.jpg' }).getAttribute('aria-current')).toBe('true');
    press({ key: 'a', metaKey: true });
    press({ key: 'u' });
    expect(flagOf('b2.jpg')).toBeUndefined();
    expect(flagOf('s2.jpg')).toBeUndefined();
    expect(flagOf('s1.jpg')).toBe('pick');
    expect(screen.getByText(/No rejects here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move 0 to the Trash…' })).toHaveProperty('disabled', true);
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);
  });

  it('Esc goes back to the view it opened over', () => {
    openPile();
    press({ key: 'Escape' });
    expect(useRejectPileStore.getState().open).toBe(false);
    expect(screen.queryByRole('region', { name: /^Rejects/ })).toBeNull();
  });

  it('lists the photos placed in projects and keeps them in the folder by default', async () => {
    openProject();
    vi.mocked(listProjects).mockResolvedValueOnce([
      { id: 'P1', title: 'Lisbon', error: null, folders: [{ id: F, path: DIR }] } as ProjectSummary,
      { id: 'P2', title: 'Porto', error: null, folders: [{ id: 'X', path: DIR }] } as ProjectSummary,
      { id: 'P3', title: 'Elsewhere', error: null, folders: [{ id: 'Y', path: '/other' }] } as ProjectSummary,
    ]);
    vi.mocked(readProject).mockClear();
    vi.mocked(readProject).mockResolvedValueOnce(JSON.stringify({ assets: { z: { path: 'b2.jpg', folder: 'X' } } }));
    openPile();
    const dialog = await confirmDialog();
    // Only the project drawing from the folder is read; the open one comes from memory.
    expect(vi.mocked(readProject).mock.calls).toEqual([['P2']]);
    expect(dialog.textContent).toContain('2 of them are placed in Lisbon and Porto.');
    const keep = screen.getByRole('checkbox', { name: 'Keep those 2 in the folder' });
    expect(keep).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Move 1 to the Trash' })).toBeTruthy();
    fireEvent.click(keep);
    expect(screen.getByRole('button', { name: 'Move 3 to the Trash' })).toBeTruthy();
  });

  it('keeps the photos of a project it could not check, and says so', async () => {
    vi.mocked(listProjects).mockResolvedValueOnce([
      { id: 'P2', title: 'Porto', error: 'not JSON', folders: [{ id: 'X', path: `${DIR}/` }] } as ProjectSummary,
      { id: 'P3', title: 'Faro', error: null, folders: [{ id: 'Y', path: DIR }] } as ProjectSummary,
      { id: 'P4', title: 'Elsewhere', error: 'gone', folders: [{ id: 'Z', path: '/other' }] } as ProjectSummary,
    ]);
    vi.mocked(readProject).mockClear();
    vi.mocked(readProject).mockRejectedValueOnce('No such file');
    openPile();
    const dialog = await confirmDialog();
    expect(vi.mocked(readProject).mock.calls).toEqual([['P3']]);
    // Porto (listed with an error) and Faro (unreadable) draw from this folder; Elsewhere does not.
    expect(dialog.textContent).toContain('2 projects could not be checked (Porto and Faro)');
    expect(screen.getByRole('button', { name: 'Move 0 to the Trash' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep those 3 in the folder' }));
    expect(screen.getByRole('button', { name: 'Move 3 to the Trash' })).toHaveProperty('disabled', false);
  });

  it('keeps everything when the project list cannot be read', async () => {
    vi.mocked(listProjects).mockRejectedValueOnce('denied');
    openPile();
    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('1 project could not be checked (the project list)');
    expect(screen.getByRole('button', { name: 'Move 0 to the Trash' })).toBeTruthy();
  });

  it('shows the count and size it moves beside the whole pile', async () => {
    openProject();
    openPile();
    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('Move 2 of the 3 photos (4 MB of 6 MB) to the macOS Trash?');
  });

  it('reports the files that moved even when the run fails after them', async () => {
    const drop = useBookStore.getState().dropPhotos;
    useBookStore.setState({
      dropPhotos: vi.fn(async () => {
        throw new Error('index locked');
      }),
    });
    try {
      openPile();
      await confirmDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Move 3 to the Trash' }));
      await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
      expect(useToasts.getState().toasts[0]?.text).toBe('Moved 3 photos to the Trash. Not moved: index locked');
    } finally {
      useBookStore.setState({ dropPhotos: drop });
    }
  });

  it('asks for thumbnails of pile photos only the index knows', () => {
    useLibraryStore.setState((s) => {
      const folder = s.folders[F];
      const b2 = folder?.photos['b2.jpg'];
      if (!folder || !b2) return {};
      return { folders: { [F]: { ...folder, photos: { ...folder.photos, 'b2.jpg': { ...b2, status: 'scanned' } } } } };
    });
    const prepare = vi.fn(async () => {});
    const real = useLibraryStore.getState().prepare;
    useLibraryStore.setState({ prepare });
    try {
      openPile();
      expect(prepare.mock.calls).toEqual([[F, ['b2.jpg']]]);
    } finally {
      useLibraryStore.setState({ prepare: real });
    }
  });

  it('after a move the index, the library and the store lose the photos, the focus moves on and a toast names failures', async () => {
    vi.mocked(trashPhotos).mockImplementationOnce(async (_f, relPaths) =>
      relPaths.map((path) =>
        path === 'b2.jpg' ? { path, ok: false, error: 'busy', sidecars: [] } : { path, ok: true, sidecars: [] },
      ),
    );
    const ids = keysFor();
    // The grid's focus is on s2, a reject.
    openPile(ids, ids.indexOf(key('s2.jpg')));
    await confirmDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Move 3 to the Trash' }));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(vi.mocked(trashPhotos).mock.calls).toEqual([[DIR, ['b1.jpg', 'b2.jpg', 's2.jpg']]]);
    expect(useToasts.getState().toasts[0]).toMatchObject({
      text: 'Moved 2 photos to the Trash. Not moved: b2.jpg (busy)',
      tone: 'danger',
      durationMs: null,
    });
    const photos = useLibraryStore.getState().folders[F]?.photos ?? {};
    expect(Object.keys(photos).sort()).toEqual(['b2.jpg', 's1.jpg', 's3.jpg']);
    const library = useBookStore.getState().libraries[DIR];
    expect(Object.keys(library?.photos ?? {}).sort()).toEqual(['h-b2.jpg', 'h-s1.jpg']);
    expect(vi.mocked(writeIndex)).toHaveBeenCalledTimes(1);
    expect(Object.keys(vi.mocked(writeIndex).mock.calls[0]?.[1] ?? {}).sort()).toEqual(['b2.jpg', 's1.jpg', 's3.jpg']);
    // The pile is closed and the grid's focus is on the next photo that stayed.
    expect(useRejectPileStore.getState().open).toBe(false);
    expect(useUiStore.getState().cull.view).toBe('grid');
    expect(shown()).toBe(key('b2.jpg'));
  });

  it('a library entry stays while another file of the folder has the same bytes', async () => {
    setFolder();
    useLibraryStore.setState((s) => {
      const folder = s.folders[F];
      if (!folder) return {};
      const copy = { ...photo('copy.jpg', 9999), hash: 'h-b1.jpg' };
      return { folders: { [F]: { ...folder, photos: { ...folder.photos, 'copy.jpg': copy } } } };
    });
    await act(() => useBookStore.getState().dropPhotos(F, ['b1.jpg']));
    expect(useBookStore.getState().libraries[DIR]?.photos['h-b1.jpg']).toBeDefined();
    await act(() => useBookStore.getState().dropPhotos(F, ['copy.jpg']));
    expect(useBookStore.getState().libraries[DIR]?.photos['h-b1.jpg']).toBeUndefined();
  });

  it('a project placing a moved photo keeps its asset id and shows it Missing', async () => {
    openProject();
    openPile();
    await confirmDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep that one in the folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move 3 to the Trash' }));
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(useToasts.getState().toasts[0]?.text).toBe('Moved 3 photos to the Trash');
    expect(useBookStore.getState().book?.assets.a1).toBeDefined();
    expect(useAssetsStore.getState().missing.a1).toMatchObject({ assetId: 'a1', path: 'b1.jpg', hash: 'h-b1.jpg' });
  });

  it('a big pile moves as a job, in chunks', async () => {
    const names = Array.from({ length: TRASH_INLINE_MAX + 15 }, (_, i) => `r${String(i).padStart(2, '0')}.jpg`);
    setFolder(names, Object.fromEntries(names.map((n) => [n, 'reject' as const])));
    openPile();
    await confirmDialog();
    fireEvent.click(screen.getByRole('button', { name: `Move ${names.length} to the Trash` }));
    await waitFor(() => expect(useToasts.getState().toasts[0]?.done).toBe(true));
    expect(vi.mocked(trashPhotos).mock.calls.map((c) => c[1].length)).toEqual([20, names.length - 20]);
    const jobs = Object.values(useJobsStore.getState().jobs).filter((j) => j.kind === 'trash');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'done', label: `Move ${names.length} to the Trash` });
    expect(useToasts.getState().toasts[0]?.text).toBe(`Moved ${names.length} photos to the Trash`);
    expect(Object.keys(useLibraryStore.getState().folders[F]?.photos ?? {})).toEqual([]);
  });
});

describe('entry points', () => {
  async function projectMenu() {
    const root = createRootRoute({ component: () => <ProjectMenu /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    await act(async () => {
      render(<RouterProvider router={router} />);
      await router.load();
    });
    fireEvent.click(screen.getByRole('button', { name: /No project/ }));
    return screen.queryByRole('menuitem', { name: 'Review rejects…' });
  }

  afterEach(() => useCullStore.setState({ stages: 0 }));

  it('Project ▾ has Review rejects… on the Cull stage only, and it opens the pile', async () => {
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    expect(await projectMenu()).toBeNull();
    cleanup();
    act(() => useCullStore.setState({ stages: 1 }));
    const item = await projectMenu();
    expect(item?.getAttribute('aria-disabled')).toBeNull();
    if (item) fireEvent.click(item);
    expect(useRejectPileStore.getState().open).toBe(true);
  });

  it('the Cull grid menu opens the pile', () => {
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    const onClose = vi.fn();
    render(<CullMenu menu={{ x: 0, y: 0, source: key('s1.jpg'), targets: [key('s1.jpg')] }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review rejects…' }));
    expect(onClose).toHaveBeenCalled();
    expect(useRejectPileStore.getState().open).toBe(true);
  });

  it('Project ▾ disables Review rejects… with no reject in the folder', async () => {
    setFolder(NAMES, { 's1.jpg': 'pick' });
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    act(() => useCullStore.setState({ stages: 1 }));
    expect((await projectMenu())?.getAttribute('aria-disabled')).toBe('true');
  });
});
