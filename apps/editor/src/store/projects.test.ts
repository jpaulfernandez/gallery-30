import { createEmptyBook, parseBook, serializeBook } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../lib/tauri';
import { useBookStore } from './book';
import { useProjectsStore } from './projects';

const A = '01K7A00000000000000000000A';
const B = '01K7B00000000000000000000B';

const disk = vi.hoisted(() => ({
  projects: new Map<string, string>(),
  trashed: [] as string[],
}));

const summary = (id: string): ProjectSummary => ({
  id,
  path: `/appdata/projects/${id}/project.photobook.json`,
  external: false,
  title: JSON.parse(disk.projects.get(id) ?? '{}').title ?? '',
  folders: [],
  updatedAt: 1,
  openedAt: null,
  coverHash: null,
  coverThumb: null,
  error: null,
});

vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  listProjects: vi.fn(async () => [...disk.projects.keys()].map(summary)),
  readProject: vi.fn(async (id: string) => disk.projects.get(id) ?? ''),
  writeProject: vi.fn(async (id: string, json: string) => {
    disk.projects.set(id, json);
  }),
  deleteProject: vi.fn(async (id: string) => {
    disk.trashed.push(id);
    disk.projects.delete(id);
  }),
  openProjectFile: vi.fn(async (path: string) => ({ ...summary(B), external: true, path })),
  revealProject: vi.fn(async () => {}),
}));

const store = () => useProjectsStore.getState();

beforeEach(() => {
  disk.projects.clear();
  disk.trashed = [];
  for (const [id, title] of [
    [A, 'Zine'],
    [B, 'Carousel'],
  ] as const) {
    disk.projects.set(id, serializeBook(createEmptyBook({ title, folders: { F: { path: '/trip' } } })));
  }
});
afterEach(() => {
  useBookStore.setState({ book: null, projectId: null, folder: null });
});

describe('projects store', () => {
  it('lists, renames a closed project in its file, and moves a project to the Trash', async () => {
    await store().load();
    expect(store().projects.map((p) => p.title)).toEqual(['Zine', 'Carousel']);

    await store().rename(A, '  Lisbon zine ');
    expect(parseBook(disk.projects.get(A) ?? '').title).toBe('Lisbon zine');
    expect(store().projects[0]?.title).toBe('Lisbon zine');
    await expect(store().rename(A, '   ')).rejects.toThrow(/needs a title/);

    await store().remove(B);
    expect(disk.trashed).toEqual([B]);
    expect(store().projects.map((p) => p.id)).toEqual([A]);
  });

  it('renames the open project through the book store', async () => {
    const book = parseBook(disk.projects.get(A) ?? '');
    useBookStore.setState({ book, projectId: A, folder: '/trip' });
    await store().rename(A, 'Renamed');
    expect(useBookStore.getState().book?.title).toBe('Renamed');
    // Autosave writes it; the store does not write the file behind the open book's back.
    expect(parseBook(disk.projects.get(A) ?? '').title).toBe('Zine');
  });

  it('closes the open project before deleting it', async () => {
    useBookStore.setState({ book: parseBook(disk.projects.get(A) ?? ''), projectId: A, folder: '/trip' });
    await store().remove(A);
    expect(useBookStore.getState().projectId).toBeNull();
    expect(disk.trashed).toEqual([A]);
  });

  it('puts an opened project file first', async () => {
    await store().load();
    const opened = await store().openFile('/Desktop/carousel.photobook.json');
    expect(opened).toMatchObject({ id: B, external: true });
    expect(store().projects.map((p) => p.id)).toEqual([B, A]);
  });
});
