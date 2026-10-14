// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { expectContextMenuKeys, expectMenuKeys } from '../ui/testing';

/**
 * Plan 45's check: every menu of the shell opens on Enter, Space and ArrowDown, closes on Escape and returns the
 * focus (the shared helper); the context menus open on a right-click and give the focus back the same way.
 */

vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn(), save: vi.fn() }));

const { useBookStore } = await import('../../store/book');
const { useProjectsStore } = await import('../../store/projects');
const { ProjectMenu } = await import('./ProjectMenu');
const { OutputMenu } = await import('../design/OutputMenu');
const { ViewMenu } = await import('../editor/ViewMenu');
const { EditorDnd } = await import('../editor/EditorDnd');
const { PageStrip } = await import('../editor/PageStrip');
const { ExportSourceMenu } = await import('../export/ExportSourceMenu');

async function inRouter(ui: () => React.ReactNode) {
  const root = createRootRoute({ component: () => <>{ui()}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

beforeEach(() => {
  // jsdom has no scrolling; the page strip scrolls its current tile into view.
  Element.prototype.scrollIntoView = vi.fn();
  useBookStore.setState({ book: structuredClone(fixtureBook), projectId: 'P', folder: '/photos' });
  // A listed project, so Project ▾ does not ask Tauri for the list on mount.
  useProjectsStore.setState({
    projects: [
      {
        id: 'Q',
        path: '/appdata/projects/Q/project.photobook.json',
        external: false,
        title: 'Porto',
        folders: [],
        updatedAt: 1,
        openedAt: 1,
        coverHash: null,
        coverThumb: null,
        error: null,
      },
    ],
  });
});

afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('shell menus open on Enter, Space and ArrowDown and give the focus back on Escape', () => {
  it('Project ▾', async () => {
    await inRouter(() => <ProjectMenu onRename={() => {}} />);
    expectMenuKeys(() => screen.getByRole('button', { name: /Project/ }), 'Project');
  });

  it('the document drop-down', async () => {
    await inRouter(() => <OutputMenu />);
    expectMenuKeys(() => screen.getByRole('button', { name: /^Designing: / }), 'Documents');
  });

  it('View ▾', () => {
    render(
      <EditorDnd>
        <ViewMenu />
      </EditorDnd>,
    );
    expectMenuKeys(() => screen.getByRole('button', { name: /View/ }), 'View');
  });
});

describe('shell context menus give the focus back on Escape', () => {
  it('the page strip', () => {
    render(
      <EditorDnd>
        <PageStrip />
      </EditorDnd>,
    );
    expectContextMenuKeys(() => screen.getByRole('button', { name: 'Page 2' }), 'Page 2');
  });

  it("a sidebar collection's Export menu", () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    render(
      <ExportSourceMenu
        menu={{ x: 10, y: 10, source: { kind: 'collection', id: 'picks' }, name: 'Picks' }}
        onClose={() => {}}
      />,
    );
    // Opened by a right-click elsewhere; the one item has the focus.
    expectFocusOn(screen.getByRole('menuitem', { name: 'Export “Picks”…' }));
    outside.remove();
  });
});

function expectFocusOn(el: HTMLElement) {
  if (document.activeElement !== el) throw new Error(`focus is on ${document.activeElement?.outerHTML}`);
}
