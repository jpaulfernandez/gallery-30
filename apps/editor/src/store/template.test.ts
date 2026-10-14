import { type Book, BookSchema, type PhotoElement, templateFor } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampCrop, cropFit } from '../lib/crop';
import { redo, undo, useBookStore } from './book';

const mocks = vi.hoisted(() => {
  const projects = new Map<string, string>();
  const folders = ['/trip', '/trip2'].map((path, i) => ({
    id: `F${i}`,
    path,
    name: path.slice(1),
    addedAt: 1,
    lastSeen: 1,
    missing: false,
  }));
  return {
    projects,
    listFolders: vi.fn(async () => folders),
    importFolder: vi.fn(async (path: string) => folders.find((f) => f.path === path)),
    importLegacyBook: vi.fn(async () => null),
    listProjects: vi.fn(async () => []),
    createProject: vi.fn(async (id: string, json: string) => {
      projects.set(id, json);
      return { id };
    }),
    readProject: vi.fn(async (id: string) => projects.get(id) ?? ''),
    writeProject: vi.fn(async () => {}),
    setRecent: vi.fn(async () => {}),
    readLibrary: vi.fn(async () => null),
    writeLibrary: vi.fn(async () => {}),
  };
});
vi.mock('../lib/tauri', () => mocks);

const history = () => useBookStore.temporal.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const photos = (): PhotoElement[] =>
  book().pages.flatMap((p) => p.elements.filter((e): e is PhotoElement => e.type === 'photo'));

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
});
afterEach(() => useBookStore.getState().close());

describe('setTemplate', () => {
  it('switches the page size as one undo step, and undo / redo restore it', () => {
    useBookStore.getState().setTemplate('story');
    expect(book().template).toEqual(templateFor('story'));
    expect(history().pastStates).toHaveLength(1);
    expect(() => BookSchema.parse(book())).not.toThrow();

    expect(undo()).toBe(true);
    expect(book().template).toEqual(templateFor('phone-portrait'));
    expect(redo()).toBe(true);
    expect(book().template.name).toBe('story');
  });

  it('keeps frames as page fractions and re-clamps crops so every photo still covers its slot', () => {
    const framesBefore = photos().map((p) => p.frame);
    // A pan that was legal at 4:5 and uncovers the slot on a wide page.
    useBookStore.setState((s) => {
      const el = s.book?.pages[0]?.elements.find((e) => e.type === 'photo');
      if (el?.type === 'photo') el.crop = { x: 0.2, y: 0.4, scale: 1 };
    });
    useBookStore.getState().setTemplate('a4-landscape');
    expect(photos().map((p) => p.frame)).toEqual(framesBefore);
    expect(photos()[0]?.crop).not.toEqual({ x: 0.2, y: 0.4, scale: 1 });
    for (const el of photos()) {
      const fit = cropFit(book(), el);
      expect(el.crop).toEqual(clampCrop(el.crop, fit));
    }
    undo();
    expect(book().template.name).toBe('phone-portrait');
    expect(photos()[0]?.crop).toEqual({ x: 0.2, y: 0.4, scale: 1 });
  });

  it('ignores the same template and custom, recording nothing', () => {
    useBookStore.getState().setTemplate('phone-portrait');
    useBookStore.getState().setTemplate('custom');
    expect(book().template.name).toBe('phone-portrait');
    expect(history().pastStates).toHaveLength(0);
  });
});

describe('new project template', () => {
  it('creates a new project with the chosen template, phone portrait by default', async () => {
    await useBookStore.getState().createProject({ title: 'Trip', template: 'a4-landscape', folderId: 'F0' });
    expect(book().template).toEqual(templateFor('a4-landscape'));
    expect(mocks.createProject).toHaveBeenCalledTimes(1);

    await useBookStore.getState().loadFromFolder('/trip2');
    expect(book().template.name).toBe('phone-portrait');
    expect(book().title).toBe('trip2');
    expect(mocks.projects.size).toBe(2);
  });
});

describe('loadFromFolder', () => {
  it('opens the folder even when importing its legacy book fails', async () => {
    mocks.importLegacyBook.mockRejectedValueOnce('renaming book.photobook.json: Permission denied');
    const opened = await useBookStore.getState().loadFromFolder('/trip');
    expect(opened).not.toBeNull();
    expect(mocks.listProjects).toHaveBeenCalled();
    expect(useBookStore.getState().folder).toBe('/trip');
  });
});
