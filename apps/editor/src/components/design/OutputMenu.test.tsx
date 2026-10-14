// @vitest-environment jsdom
import { createEmptyBook } from '@photobook/shared';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dialog = vi.hoisted(() => ({ ask: vi.fn(async () => true) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: dialog.ask, open: vi.fn(), save: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  getRecent: vi.fn(async () => null),
  listFolders: vi.fn(async () => []),
}));
// The Design stage reduced to its document drop-down and the "What's next" chooser (plan 56).
vi.mock('../../routes/book', async () => {
  const { OutputMenu } = await import('./OutputMenu');
  const { NextChooser } = await import('./NextChooser');
  return {
    BookRoute: () => (
      <>
        <OutputMenu />
        <NextChooser />
      </>
    ),
  };
});

const { routeTree } = await import('../../router');
const { useBookStore } = await import('../../store/book');
const { useUiStore } = await import('../../store/ui');

const F = '01K7F000000000000000000000';

async function visit(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
  return router;
}

afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
  localStorage.clear();
});

describe('OutputMenu', () => {
  it('creates a print on the paper that matches the pages and opens it (plan 15)', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P/design/book');

    fireEvent.click(await screen.findByRole('button', { name: 'Designing: Book' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));

    const print = useBookStore.getState().book?.outputs[0];
    // A 4:5 book prints on 8 x 10 in by default, single pages, 3 mm bleed.
    expect(print).toMatchObject({ kind: 'print', name: 'Print', source: 'book', paper: '8x10', imposition: 'pages' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/project/P/design/${print?.id}`));
  });

  it('creates a slideshow with the default settings and opens it (plan 16)', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P/design/book');

    fireEvent.click(await screen.findByRole('button', { name: 'Designing: Book' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Slideshow' }));

    const slideshow = useBookStore.getState().book?.outputs[0];
    expect(slideshow).toMatchObject({
      kind: 'slideshow',
      name: 'Slideshow',
      source: 'book',
      secondsPerSlide: 4,
      transition: 'crossfade',
      motion: 'ken-burns',
      size: '1080p',
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/project/P/design/${slideshow?.id}`));
  });

  it('creates a post, opens it, renames it, and deletes it back to the book', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P/design/book');

    fireEvent.click(await screen.findByRole('button', { name: 'Designing: Book' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
    // Plan 56: New… is the chooser; Social post is plan 14's network picker with the ratio first.
    fireEvent.click(await screen.findByRole('button', { name: /^Social post/ }));
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    // Plan 14: a post is made for a network, and named after it.
    fireEvent.click(screen.getByRole('button', { name: /Instagram \/ Facebook story/ }));

    const post = useBookStore.getState().book?.outputs[0];
    expect(post).toMatchObject({ kind: 'social', name: 'Instagram / Facebook story', network: 'instagram-story' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/project/P/design/${post?.id}`));
    expect(useUiStore.getState().design.outputId).toBe(post?.id);

    fireEvent.click(await screen.findByRole('button', { name: 'Designing: Instagram / Facebook story' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Carousel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(useBookStore.getState().book?.outputs[0]?.name).toBe('Carousel');

    fireEvent.click(await screen.findByRole('button', { name: 'Designing: Carousel' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await waitFor(() => expect(useBookStore.getState().book?.outputs).toEqual([]));
    expect(dialog.ask).toHaveBeenCalledOnce();
    await waitFor(() => expect(router.state.location.pathname).toBe('/project/P/design/book'));
  });

  it('duplicates the open post under a name no other post has, and opens the copy', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const post = useBookStore.getState().addOutput('social', 'Post') ?? '';
    const router = await visit(`/project/P/design/${post}`);

    for (const expected of ['Post copy', 'Post copy 2']) {
      // Back on the original post, then Duplicate it.
      fireEvent.click(await screen.findByRole('button', { name: /^Designing: / }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Post' }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/project/P/design/${post}`));
      fireEvent.click(await screen.findByRole('button', { name: 'Designing: Post' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
      const copy = useBookStore.getState().book?.outputs.find((o) => o.name === expected);
      expect(copy).toBeTruthy();
      await waitFor(() => expect(router.state.location.pathname).toBe(`/project/P/design/${copy?.id}`));
    }
    const outputs = useBookStore.getState().book?.outputs ?? [];
    expect(outputs.map((o) => o.name)).toEqual(['Post', 'Post copy 2', 'Post copy']);
    const frameIds = outputs.flatMap((o) => (o.kind === 'social' ? o.frames.map((f) => f.id) : []));
    expect(new Set(frameIds).size).toBe(3);
  });
});

describe('NextChooser (plan 56)', () => {
  const chooser = () => screen.queryByRole('dialog', { name: /What's next for/ });

  it('opens on the first open of a project with only the book; Skip closes it for good on this machine', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'P', folder: '/trip' });
    const router = await visit('/project/P/design/book');
    expect(await screen.findByRole('dialog', { name: /What's next for 0 photos/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(chooser()).toBeNull());
    expect(router.state.location.pathname).toBe('/project/P/design/book');
    expect(localStorage.getItem('photobook.design.chooserSeen.P')).toBe('1');
    cleanup();
    await visit('/project/P/design/book');
    await screen.findByRole('button', { name: 'Designing: Book' });
    expect(chooser()).toBeNull();
    // New… still opens it.
    fireEvent.click(screen.getByRole('button', { name: 'Designing: Book' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
    expect(await screen.findByRole('dialog', { name: /What's next for/ })).toBeTruthy();
  });

  it('from New… on a post, Skip and Escape close it and stay on the post', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'S', folder: '/trip' });
    const post = useBookStore.getState().addOutput('social', 'Post') ?? '';
    const router = await visit(`/project/S/design/${post}`);
    for (const close of ['skip', 'escape'] as const) {
      fireEvent.click(await screen.findByRole('button', { name: 'Designing: Post' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
      const sheet = await screen.findByRole('dialog', { name: /What's next for/ });
      if (close === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
      else fireEvent.keyDown(sheet, { key: 'Escape' });
      await waitFor(() => expect(chooser()).toBeNull());
      expect(router.state.location.pathname).toBe(`/project/S/design/${post}`);
    }
  });

  it('never opens by itself when the project has a document beyond the book', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    useBookStore.setState({ book, projectId: 'Q', folder: '/trip' });
    useBookStore.getState().addOutput('social', 'Post');
    await visit('/project/Q/design/book');
    await screen.findByRole('button', { name: /^Designing: / });
    expect(chooser()).toBeNull();
    expect(localStorage.getItem('photobook.design.chooserSeen.Q')).toBeNull();
  });

  it('Carousel makes a 4:5 post with one frame per keeper, in book order, and opens it', async () => {
    const book = createEmptyBook({ title: 'Zine', folders: { [F]: { path: '/trip' } } });
    const a = '01K7F0000000000000000000AA';
    const b = '01K7F0000000000000000000BB';
    const c = '01K7F0000000000000000000CC';
    book.assets = {
      [a]: { path: 'a.jpg', folder: F, width: 3000, height: 2000 },
      [b]: { path: 'b.jpg', folder: F, width: 2000, height: 3000, flag: 'reject' },
      [c]: { path: 'c.jpg', folder: F, width: 3000, height: 3000 },
    };
    useBookStore.setState({ book, projectId: 'R', folder: '/trip' });
    const router = await visit('/project/R/design/book');
    await screen.findByRole('dialog', { name: /What's next for 2 photos/ });
    fireEvent.click(screen.getByRole('button', { name: /^Carousel/ }));
    const post = useBookStore.getState().book?.outputs[0];
    expect(post).toMatchObject({ kind: 'social', name: 'Carousel', network: 'instagram-carousel' });
    const assets =
      post?.kind === 'social' ? post.frames.map((f) => f.elements.map((el) => el.type === 'photo' && el.asset)) : [];
    expect(assets).toEqual([[a], [c]]);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/project/R/design/${post?.id}`));
    expect(chooser()).toBeNull();
  });
});
