// @vitest-environment jsdom

import { CURRENT_VERSION, type Library, ThemeSchema } from '@photobook/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoverSnapshot } from '../components/home/ProjectCover';
import type { Folder, ProjectSummary } from '../lib/tauri';
import type { LibraryFolder } from '../store/library';

vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  fileUrl: (path: string) => `asset://localhost${path}`,
}));

const { editedAgo, FolderRows, folderCull, NewProjectDialog, ProjectCards, RECENT } = await import('./home');
type FolderCull = import('./home').FolderCull;

const folder = (id: string, name: string, missing = false): Folder => ({
  id,
  path: `/photos/${name}`,
  name,
  addedAt: 1,
  lastSeen: 1,
  missing,
});

const project = (id: string, title: string, patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  path: `/appdata/projects/${id}/project.photobook.json`,
  external: false,
  title,
  folders: [{ id: 'F', path: '/photos/lisbon', name: 'Lisbon', imported: true, missing: false }],
  updatedAt: 1,
  openedAt: Date.UTC(2026, 9, 12, 10),
  coverHash: 'a'.repeat(64),
  coverThumb: `/appdata/cache/${'a'.repeat(64)}/thumb.jpg`,
  error: null,
  ...patch,
});

afterEach(cleanup);

describe('NewProjectDialog', () => {
  it('creates a project from a title, a page size and an imported folder', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectDialog
        folders={[folder('A', 'lisbon'), folder('B', 'gone', true), folder('C', 'porto')]}
        disabled={false}
        onImport={async () => {}}
        onCancel={() => {}}
        onCreate={onCreate}
      />,
    );
    // Missing folders are not offered.
    const select = screen.getByLabelText('Photos from') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['A', 'C']);
    fireEvent.change(select, { target: { value: 'C' } });
    fireEvent.click(screen.getByLabelText(/Square/));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    // An empty title falls back to the folder's name.
    expect(onCreate).toHaveBeenCalledWith({ title: 'porto', template: 'square', folderId: 'C', add: 'all' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Lisbon zine  ' } });
    // What to add from the folder: all photos by default, or the picks, or nothing.
    fireEvent.click(screen.getByLabelText('Picks only'));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onCreate).toHaveBeenLastCalledWith({
      title: 'Lisbon zine',
      template: 'square',
      folderId: 'C',
      add: 'picks',
    });
    fireEvent.click(screen.getByLabelText('Nothing'));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ add: 'none' }));
  });

  it('selects a folder imported from the dialog, and cannot create without one', () => {
    const onCreate = vi.fn();
    const onImport = vi.fn(async () => {});
    const props = { disabled: false, onImport, onCancel: () => {}, onCreate };
    const { rerender } = render(<NewProjectDialog folders={[]} {...props} />);
    const create = screen.getByRole('button', { name: 'Create project' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Import folder…' }));
    expect(onImport).toHaveBeenCalled();
    rerender(<NewProjectDialog folders={[folder('N', 'new')]} {...props} />);
    expect((screen.getByLabelText('Photos from') as HTMLSelectElement).value).toBe('N');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(onCreate).toHaveBeenCalledWith({ title: 'new', template: 'phone-portrait', folderId: 'N', add: 'all' });
  });
});

describe('ProjectCards', () => {
  const handlers = () => ({
    disabled: false,
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onReveal: vi.fn(),
    onDelete: vi.fn(),
  });
  const snapshot = (pageCount: number): CoverSnapshot => ({
    schema: CURRENT_VERSION,
    template: { width: 1000, height: 1250 },
    theme: ThemeSchema.parse({}),
    page: pageCount > 0 ? { id: 'P', layout: 'blank', background: '#ffffff', elements: [], guides: [] } : null,
    thumbs: {},
    pageCount,
  });

  it('shows the cover, title, page count and when it was edited, and wires the ⋯ menu', () => {
    const h = handlers();
    const zine = project('A', 'Zine', { updatedAt: Date.now() - 2 * 86_400_000 });
    const broken = project('B', 'Broken', { error: 'Not a valid project file', coverThumb: null });
    render(<ProjectCards projects={[zine, broken]} covers={{ A: snapshot(24), B: null }} {...h} />);
    expect(screen.getByText('24 pages · edited 2 d ago')).toBeTruthy();
    expect(screen.getByText('Not a valid project file')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open Zine' }));
    expect(h.onOpen).toHaveBeenCalledWith(zine);
    // A project that cannot be read can only be revealed or deleted.
    expect((screen.getByRole('button', { name: 'Open Broken' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Zine' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const input = screen.getByLabelText('Project title');
    fireEvent.change(input, { target: { value: 'Lisbon zine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(h.onRename).toHaveBeenCalledWith(zine, 'Lisbon zine');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Zine' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }));
    expect(h.onReveal).toHaveBeenCalledWith(zine);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Broken' }));
    expect(screen.getByRole('menuitem', { name: 'Rename…' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(h.onDelete).toHaveBeenCalledWith(broken);
  });

  it('shows four, and See all expands in place', () => {
    const projects = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => project(id, `P${id}`));
    render(<ProjectCards projects={projects} covers={{}} {...handlers()} />);
    expect(screen.getAllByRole('button', { name: /^Open P/ })).toHaveLength(RECENT);
    fireEvent.click(screen.getByRole('button', { name: 'See all 6' }));
    expect(screen.getAllByRole('button', { name: /^Open P/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('button', { name: /^Open P/ })).toHaveLength(RECENT);
  });

  it('draws the empty paper for a project with no pages, not an error', () => {
    render(<ProjectCards projects={[project('A', 'Empty')]} covers={{ A: snapshot(0) }} {...handlers()} />);
    expect(document.querySelector('[data-cover="empty"]')).toBeTruthy();
    expect(document.querySelector('.pb-page')).toBeNull();
    expect(screen.getByText(/^0 pages · edited /)).toBeTruthy();
  });
});

describe('FolderRows', () => {
  const cull = (patch: Partial<FolderCull>): FolderCull => ({
    photos: 0,
    kept: 0,
    undecided: 0,
    culled: false,
    ...patch,
  });

  it('shows the count and cull state, opens a folder in Cull or Develop, and a missing folder has no buttons', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const lisbon = { ...folder('L', 'Lisbon 2026'), lastSeen: 3 };
    const studio = { ...folder('S', 'Studio tests'), lastSeen: 2 };
    const gone = folder('G', 'Gone', true);
    render(
      <FolderRows
        folders={[gone, studio, lisbon]}
        culls={{
          L: cull({ photos: 612, kept: 58, culled: true }),
          S: cull({ photos: 84, undecided: 12 }),
          G: null,
        }}
        disabled={false}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    // Recent first; the missing folder last.
    expect([...document.querySelectorAll('[data-folder]')].map((li) => li.getAttribute('data-folder'))).toEqual([
      'L',
      'S',
      'G',
    ]);
    expect(screen.getByText('612 photos · 58 kept', { exact: false })).toBeTruthy();
    expect(screen.getByText('culled ✓')).toBeTruthy();
    expect(screen.getByText('84 photos · 12 undecided')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cull Lisbon 2026' }));
    expect(onOpen).toHaveBeenCalledWith(lisbon, 'cull');
    fireEvent.click(screen.getByRole('button', { name: 'Develop Studio tests' }));
    expect(onOpen).toHaveBeenLastCalledWith(studio, 'develop');

    const missing = document.querySelector('[data-folder="G"]') as HTMLElement;
    expect(missing.textContent).toContain('Missing');
    expect(missing.querySelectorAll('button')).toHaveLength(0);

    // A row takes the focus (no buttons on a missing one), so the context-menu key reaches Remove from the list.
    expect(missing.tabIndex).toBe(0);
    // Right-click removes a folder from the list.
    fireEvent.contextMenu(missing, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from the list' }));
    expect(onRemove).toHaveBeenCalledWith(gone);
  });

  it('counts kept and undecided from the index and the library, and culled ✓ needs culledAt and no undecided', () => {
    const photos = {
      'a.jpg': { hash: 'a' },
      'b.jpg': { hash: 'b' },
      'c.jpg': { hash: 'c' },
    } as unknown as LibraryFolder['photos'];
    const known = { id: 'L', path: '/photos/L', photos } as LibraryFolder;
    const library = (flags: Record<string, 'pick' | 'reject' | undefined>, culledAt?: string): Library =>
      ({
        version: 1,
        photos: Object.fromEntries(Object.entries(flags).map(([h, flag]) => [h, flag ? { flag } : {}])),
        ...(culledAt ? { cull: { culledAt } } : {}),
      }) as unknown as Library;
    expect(folderCull(undefined, {})).toBeNull();
    // An index read before its library: no counts yet, rather than every photo undecided.
    expect(folderCull(known, {})).toBeNull();
    expect(folderCull(known, { '/photos/L': library({ a: 'pick', b: 'reject' }) })).toEqual({
      photos: 3,
      kept: 1,
      undecided: 1,
      culled: false,
    });
    expect(folderCull(known, { '/photos/L': library({ a: 'pick', b: 'reject', c: 'pick' }, '2026-10-13') })).toEqual({
      photos: 3,
      kept: 2,
      undecided: 0,
      culled: true,
    });
    // A new undecided photo takes the check away.
    expect(folderCull(known, { '/photos/L': library({ a: 'pick', b: 'reject' }, '2026-10-13') })?.culled).toBe(false);
  });
});

describe('editedAgo', () => {
  it('reads minutes, hours and days, then the date', () => {
    const now = Date.UTC(2026, 9, 13, 12);
    expect(editedAgo(0, now)).toBe('');
    expect(editedAgo(now - 10_000, now)).toBe('just now');
    expect(editedAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(editedAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(editedAgo(now - 2 * 86_400_000, now)).toBe('2 d ago');
    expect(editedAgo(now - 40 * 86_400_000, now)).not.toMatch(/ago$/);
  });
});
