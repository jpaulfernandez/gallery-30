// @vitest-environment jsdom
import { createEmptyBook } from '@photobook/shared';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder } from './lib/tauri';

const F = '01K7F000000000000000000000';
const GONE = '01K7G000000000000000000000';
const folders: Folder[] = [
  { id: F, path: '/trip', name: 'Trip', addedAt: 1, lastSeen: 1, missing: false },
  { id: GONE, path: '/unplugged', name: 'Unplugged', addedAt: 1, lastSeen: 1, missing: true },
];
const SAVED = '01K7S000000000000000000000';
const collections = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock('./lib/tauri', async (original) => ({
  ...(await original<typeof import('./lib/tauri')>()),
  getRecent: vi.fn(async () => null),
  listFolders: vi.fn(async () => folders),
  listProjects: vi.fn(async () => []),
  readIndex: vi.fn(async () => ({})),
  readCollections: vi.fn(async () => collections.list),
  writeCollections: vi.fn(async (list: unknown[]) => {
    collections.list = list;
  }),
  readLibrary: vi.fn(async () => null),
  scanFolder: vi.fn(async () => []),
  writeIndex: vi.fn(async () => {}),
}));
// The Design stage itself (canvas, inspector) is not what these tests are about.
vi.mock('./routes/book', () => ({ BookRoute: () => <p>Design stage</p> }));

const { installStageTransitions, resetLaunch, routeTree } = await import('./router');
const { useBookStore } = await import('./store/book');
const { useLibraryStore } = await import('./store/library');
const { useCollectionsStore } = await import('./store/collections');
const { useUiStore } = await import('./store/ui');

async function visit(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

beforeEach(() => {
  resetLaunch();
  collections.list = [{ id: SAVED, name: 'Keepers', filter: { folders: [F], flag: 'picks', minRating: 3, query: '' } }];
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
  useLibraryStore.getState().reset();
  useCollectionsStore.getState().reset();
});

describe('library routes', () => {
  it('opens Cull on an imported folder with no project, Design disabled', async () => {
    const router = await visit(`/library/${F}/cull`);
    expect(router.state.location.pathname).toBe(`/library/${F}/cull`);
    expect(await screen.findByRole('main', { name: 'Cull: Trip' })).toBeTruthy();
    const stages = screen.getByRole('navigation', { name: 'Stages' });
    expect(within(stages).getByText('Design').getAttribute('aria-disabled')).toBe('true');
    expect(within(stages).getByRole('link', { name: 'Cull' }).getAttribute('aria-current')).toBe('page');
    expect(within(stages).getByRole('link', { name: 'Develop' }).getAttribute('href')).toBe(`/library/${F}/develop`);
    // The sidebar lists the folders (a missing one greyed out), the collections and the projects.
    const sidebar = screen.getByRole('navigation', { name: 'Library' });
    expect(within(sidebar).getByRole('link', { name: /Trip/ }).getAttribute('aria-current')).toBe('page');
    expect(within(sidebar).getByText('Unplugged')).toBeTruthy();
    expect(within(sidebar).getByRole('link', { name: /Kept/ })).toBeTruthy();
    expect(within(sidebar).queryByRole('link', { name: /Needs denoise/ })).toBeNull();
    expect(useLibraryStore.getState().folders[F]?.path).toBe('/trip');
  });

  it('puts the filters in the sidebar; Tab hides the sidebar, not from a text field (plan 51)', async () => {
    localStorage.removeItem('photobook.ui.panes');
    useUiStore.setState({ panes: { ...useUiStore.getState().panes, cull: { left: true, right: true, strip: true } } });
    await visit(`/library/${F}/cull`);
    const main = await screen.findByRole('main', { name: 'Cull: Trip' });
    const sidebar = screen.getByRole('navigation', { name: 'Library' });
    const filters = within(sidebar).getByRole('region', { name: 'Filters' });
    for (const name of ['Filter by flag', 'Filter by minimum star rating', 'Sort photos']) {
      expect(within(filters).getByRole('combobox', { name })).toBeTruthy();
      expect(within(main).queryByRole('combobox', { name })).toBeNull();
    }
    expect(within(filters).getByRole('button', { name: 'Edited' })).toBeTruthy();
    const search = within(main).getByRole('searchbox', { name: 'Search photos by file name' });
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.queryByRole('navigation', { name: 'Library' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.queryByRole('navigation', { name: 'Library' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('photobook.ui.panes') ?? '{}').cull.left).toBe(false);
    // Per stage: Develop and Design keep theirs.
    expect(useUiStore.getState().panes.develop.left).toBe(true);
    expect(useUiStore.getState().panes.design.left).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.getByRole('navigation', { name: 'Library' })).toBeTruthy();
  });

  it('opens Develop over a built-in collection', async () => {
    const router = await visit('/library/collection/picks/develop');
    expect(router.state.location.pathname).toBe('/library/collection/picks/develop');
    expect(await screen.findByRole('main', { name: 'Develop: Kept' })).toBeTruthy();
  });

  it('opens a saved collection, lists it in the sidebar, and deletes it from its menu', async () => {
    useUiStore.setState({ libraryFolder: F });
    const router = await visit(`/library/collection/${SAVED}/cull`);
    expect(router.state.location.pathname).toBe(`/library/collection/${SAVED}/cull`);
    expect(await screen.findByRole('main', { name: 'Cull: Keepers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as collection…' })).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Library' });
    const item = within(sidebar).getByRole('link', { name: /Keepers/ });
    expect(item.getAttribute('aria-current')).toBe('page');
    fireEvent.contextMenu(item);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(collections.list).toEqual([]));
    // Deleting the collection on screen goes back to the folder the stage showed last.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/library/${F}/cull`));
  });

  it('sends an unknown folder, a missing folder or an unknown collection Home with the reason', async () => {
    let router = await visit('/library/01K7X000000000000000000000/cull');
    expect(router.state.location.pathname).toBe('/');
    expect((await screen.findByRole('alert')).textContent).toMatch(/not imported/);
    cleanup();

    router = await visit(`/library/${GONE}/develop`);
    expect(router.state.location.pathname).toBe('/');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Unplugged is not on disk/);
    cleanup();

    router = await visit('/library/collection/nope/cull');
    expect(router.state.location.pathname).toBe('/');
    expect((await screen.findByRole('alert')).textContent).toMatch(/no collection called “nope”/);
  });
});

describe('project routes', () => {
  it("opens the project's Cull with its own filters and the Cull tab on the project", async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P/cull');
    expect(router.state.location.pathname).toBe('/project/P/cull');
    expect(await screen.findByRole('main', { name: 'Cull: Zine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide used' })).toBeTruthy();
    const stages = screen.getByRole('navigation', { name: 'Stages' });
    expect(within(stages).getByRole('link', { name: 'Cull' }).getAttribute('href')).toBe('/project/P/cull');
    expect(within(stages).getByRole('link', { name: 'Design' }).getAttribute('href')).toBe('/project/P/design');
  });

  it('sends /project/$id to its Design stage', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P');
    expect(router.state.location.pathname).toBe('/project/P/design/book');
    expect(await screen.findByText('Design stage')).toBeTruthy();
  });

  it('opens the Design stage on the book or on an output, and sends an unknown output to the book', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    const post = {
      id: 'POST',
      name: 'Post',
      createdAt: 1,
      kind: 'social' as const,
      network: 'instagram-carousel' as const,
      frames: [],
      caption: '',
    };
    useBookStore.setState({ book: { ...book, outputs: [post] }, projectId: 'P', folder: '/trip' });
    let router = await visit('/project/P/design/book');
    expect(router.state.location.pathname).toBe('/project/P/design/book');
    expect(await screen.findByText('Design stage')).toBeTruthy();
    expect(useUiStore.getState().design.outputId).toBe('book');
    cleanup();

    router = await visit('/project/P/design/POST');
    expect(router.state.location.pathname).toBe('/project/P/design/POST');
    expect(await screen.findByText('Design stage')).toBeTruthy();
    expect(useUiStore.getState().design.outputId).toBe('POST');
    cleanup();

    // Plain /design goes back to the document shown last.
    router = await visit('/project/P/design');
    expect(router.state.location.pathname).toBe('/project/P/design/POST');
    cleanup();

    router = await visit('/project/P/design/NOPE');
    expect(router.state.location.pathname).toBe('/project/P/design/book');
    expect(useUiStore.getState().design.outputId).toBe('book');
  });
});

describe('the stage crossfade (plan 49)', () => {
  it('asks for a view transition on a stage change only', async () => {
    const router = await visit(`/library/${F}/cull`);
    installStageTransitions(router);
    const asked: unknown[] = [];
    // Registered after the stage subscription, so it reads what that one decided for this navigation.
    router.subscribe('onBeforeNavigate', () => asked.push(router.shouldViewTransition));
    await act(async () => {
      await router.navigate({ to: '/library/$folderId/develop', params: { folderId: F } });
    });
    expect(router.state.location.pathname).toBe(`/library/${F}/develop`);
    await act(async () => {
      await router.navigate({ to: '/settings' });
    });
    expect(asked).toEqual([true, false]);
    expect(router.shouldViewTransition).not.toBe(true);
  });
});
