import {
  type Book,
  createDevelop,
  createEmptyBook,
  type DevelopSettings,
  emptyLibrary,
  type Library,
  type PhotoElement,
  parseBook,
  parseLibrary,
  publishFingerprint,
  resolveAssetDevelop,
  serializeBook,
  serializeLibrary,
} from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProject } from '../lib/tauri';
import { flush, startAutosave, startLibraryAutosave } from './autosave';
import { beginDevelopDrag, endDevelopDrag, redo, undo, useBookStore, withoutHistory } from './book';
import {
  assetDevelop,
  assetFlag,
  assetRating,
  isLibraryWritable,
  libraryBook,
  resolvedAssets,
  syncBookWithLibrary,
} from './library';
import { useUiStore } from './ui';

/** A fake disk: project files by project id, library files by folder, the imported folders. */
const disk = vi.hoisted(() => ({
  books: new Map<string, string>(),
  folders: [] as Array<{ id: string; path: string; name: string; addedAt: number; lastSeen: number; missing: boolean }>,
  libraries: new Map<string, string>(),
  backups: new Map<string, string>(),
  libraryWrites: [] as Array<{ folder: string; json: string }>,
  failBookWrites: false,
  failLibraryWrites: false,
}));

vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  readProject: vi.fn(async (id: string) => {
    const text = disk.books.get(id);
    if (text === undefined) throw `No project with id ${id}`;
    return text;
  }),
  writeProject: vi.fn(async (id: string, json: string) => {
    if (disk.failBookWrites) throw 'disk full';
    disk.books.set(id, json);
  }),
  createProject: vi.fn(async (id: string, json: string) => {
    disk.books.set(id, json);
    return { id };
  }),
  listFolders: vi.fn(async () => disk.folders),
  importFolder: vi.fn(async (path: string) => {
    const folder = disk.folders.find((f) => f.path === path);
    if (!folder) throw `Access denied: ${path} is outside the imported folders`;
    return folder;
  }),
  importLegacyBook: vi.fn(async () => null),
  listProjects: vi.fn(async () =>
    [...disk.books].map(([id, text]) => ({
      id,
      error: null,
      folders: Object.values((JSON.parse(text) as Book).folders ?? {}).map((f) => ({ path: f.path })),
    })),
  ),
  setRecent: vi.fn(async () => {}),
  readLibrary: vi.fn(async (folder: string) => disk.libraries.get(folder) ?? null),
  readLibraryBackup: vi.fn(async (folder: string) => disk.backups.get(folder) ?? null),
  writeLibrary: vi.fn(async (folder: string, json: string) => {
    if (disk.failLibraryWrites) throw 'read-only volume';
    disk.libraries.set(folder, json);
    disk.libraryWrites.push({ folder, json });
  }),
}));

const FOLDER = '/trip';
const PROJECT = '01K7A00000000000000000000A';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

const state = () => useBookStore.getState();
const book = (): Book => {
  const b = state().book;
  if (!b) throw new Error('no book');
  return b;
};
const library = (folder = FOLDER): Library | undefined => state().libraries[folder];
const entry = (hash: string) => library()?.photos[hash];
const diskLibrary = (folder = FOLDER) => {
  const text = disk.libraries.get(folder);
  return text ? parseLibrary(text) : undefined;
};

function edited(exposure: number): DevelopSettings {
  const develop = createDevelop();
  develop.light.exposure = exposure;
  return develop;
}

/** A book in FOLDER with three hashed photos (a, b, c) and one the scan has not hashed yet (u). */
function tripBook(): Book {
  const b = createEmptyBook({ title: 'Trip', folders: { F: { path: FOLDER } } });
  b.assets = {
    a: { path: 'a.jpg', folder: 'F', hash: H1, size: 1, mtime: 1 },
    b: { path: 'b.jpg', folder: 'F', hash: H2, size: 2, mtime: 1 },
    c: { path: 'c.jpg', folder: 'F', hash: H3, size: 3, mtime: 1 },
    u: { path: 'u.jpg', folder: 'F' },
  };
  return b;
}

/** `b` as a version 7 project file: `sourceFolder`, no folder ids, outputs, captions or page guides. */
function v7Text(b: Book): string {
  const { folders, outputs: _o, captions: _c, ...rest } = JSON.parse(serializeBook(b)) as Book;
  return JSON.stringify({
    ...rest,
    version: 7,
    sourceFolder: Object.values(folders)[0]?.path,
    assets: Object.fromEntries(Object.entries(rest.assets).map(([id, { folder: _f, ...asset }]) => [id, asset])),
    pages: rest.pages.map(({ guides: _g, ...page }) => page),
  });
}

/** Save `b` as project PROJECT and open it through `loadProject`, as the app does. */
async function open(b: Book = tripBook()) {
  disk.books.set(PROJECT, serializeBook(b));
  await state().loadProject(PROJECT);
}

/** FOLDER (registry id F, the id tripBook uses) plus `more`, as imported folders. */
function importFolders(...more: Array<{ id: string; path: string }>) {
  disk.folders = [{ id: 'F', path: FOLDER }, ...more].map((f) => ({
    ...f,
    name: f.path.slice(1),
    addedAt: 1,
    lastSeen: 1,
    missing: false,
  }));
}

beforeEach(() => {
  importFolders();
  disk.books.clear();
  disk.libraries.clear();
  disk.backups.clear();
  disk.libraryWrites = [];
  disk.failBookWrites = false;
  disk.failLibraryWrites = false;
});
afterEach(async () => {
  await state().close();
  vi.useRealTimers();
});

describe('write-through', () => {
  beforeEach(() => open());

  it('a develop edit writes the library entry of the hash, and undo removes it', () => {
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    expect(entry(H1)?.develop?.light.exposure).toBe(1);
    // The v7 book keeps mirroring it.
    expect(book().assets.a?.develop?.light.exposure).toBe(1);
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(1);

    undo();
    expect(entry(H1)).toBeUndefined();
    expect(book().assets.a?.develop).toBeUndefined();
    redo();
    expect(entry(H1)?.develop?.light.exposure).toBe(1);
    expect(book().assets.a?.develop?.light.exposure).toBe(1);
  });

  it('a slider drag is one undo step for the book and the library together', () => {
    state().setAssetDevelop('a', { light: { exposure: 0.5 } });
    beginDevelopDrag();
    for (const exposure of [0.6, 0.8, 1.2]) state().setAssetDevelop('a', { light: { exposure } });
    endDevelopDrag();
    expect(entry(H1)?.develop?.light.exposure).toBe(1.2);
    undo();
    expect(entry(H1)?.develop?.light.exposure).toBe(0.5);
    expect(book().assets.a?.develop?.light.exposure).toBe(0.5);
  });

  it('reset, section reset and denoise all write through', () => {
    state().setAssetDevelop('b', { light: { exposure: 1 }, detail: { clarity: 20 } });
    state().resetDevelopSection('b', 'detail');
    expect(entry(H2)?.develop?.detail.clarity).toBe(0);
    state().setDenoise('b', {});
    expect(entry(H2)?.develop?.detail.denoise).not.toBeNull();
    state().rotate90('b', 1);
    expect(entry(H2)?.develop?.geometry.rotate).toBe(90);
    state().resetAssetDevelop('b');
    expect(entry(H2)).toBeUndefined();
    expect(book().assets.b?.develop).toBeUndefined();
  });

  it('ratings and flags write through but are never undone', () => {
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 4, flag: 'pick' });
    expect(entry(H1)).toMatchObject({ rating: 4, flag: 'pick' });
    expect(book().assets.a).toMatchObject({ rating: 4, flag: 'pick' });
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 2 });
    undo();
    // The edit is undone; the newer rating stays, in the library and on the book.
    expect(entry(H1)).toEqual({ rating: 2, flag: 'pick', versions: {} });
    expect(book().assets.a?.rating).toBe(2);
    expect(book().assets.a?.develop).toBeUndefined();
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: null, flag: null });
    expect(entry(H1)).toBeUndefined();
  });

  it('a photo index entry (plan 33) is not history: undo and redo of a Develop edit keep it', () => {
    const ai = {
      model: 'claude-haiku-5-5',
      at: '2026-10-13T00:00:00.000Z',
      description: 'A tram.',
      people: 1,
      setting: 'street',
      timeOfDay: 'evening' as const,
      mood: 'calm',
    };
    const describe = (hash: string) =>
      withoutHistory(() =>
        state().patchPhoto(FOLDER, hash, (photo) => {
          photo.ai = ai;
        }),
      );
    // Described first, then edited: undo leaves the entry holding only `ai` (not removed as empty), redo restores both.
    describe(H1);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    undo();
    expect(entry(H1)).toEqual({ versions: {}, ai });
    redo();
    expect(entry(H1)?.develop?.light.exposure).toBe(1);
    expect(entry(H1)?.ai).toEqual(ai);
    // Edited first, then described: undoing the edit keeps the newer description.
    state().setAssetDevelop('b', { light: { exposure: 0.5 } });
    describe(H2);
    undo();
    expect(entry(H2)?.develop).toBeUndefined();
    expect(entry(H2)?.ai).toEqual(ai);
  });

  it('batch actions (paste, preset, sync) write every target through', () => {
    state().setAssetDevelop('a', { light: { exposure: 1.5 } });
    const clip = state().copyDevelop('a');
    expect(clip).not.toBeNull();
    if (clip) expect(state().pasteDevelop(['b', 'c'], clip)).toBe(2);
    expect(entry(H2)?.develop?.light.exposure).toBe(1.5);
    expect(entry(H3)?.develop?.light.exposure).toBe(1.5);
    undo();
    expect(entry(H2)).toBeUndefined();
    expect(entry(H3)).toBeUndefined();
    expect(state().syncDevelop('a', ['c'], ['basic'])).toBe(1);
    expect(entry(H3)?.develop?.light.exposure).toBe(1.5);
  });

  it('an asset without a hash keeps its fields on the book until the hash lands, then they are lifted', () => {
    state().reviewAssets([{ assetId: 'u', path: 'u.jpg' }], { rating: 5 });
    state().setAssetDevelop('u', { light: { exposure: -1 } });
    expect(Object.keys(library()?.photos ?? {})).toEqual([]);
    expect(book().assets.u).toMatchObject({ rating: 5 });

    const hash = '4'.repeat(64);
    state().fillAssets({ u: { ...(book().assets.u as NonNullable<Book['assets'][string]>), hash } });
    expect(entry(hash)?.rating).toBe(5);
    expect(entry(hash)?.develop?.light.exposure).toBe(-1);
  });

  it('duplicated files (same bytes) share one entry and one edit', () => {
    state().fillAssets({ d: { path: 'copy-of-a.jpg', folder: 'F', hash: H1, size: 1, mtime: 1 } });
    state().setAssetDevelop('a', { light: { exposure: 2 } });
    expect(book().assets.d?.develop?.light.exposure).toBe(2);
    expect(assetDevelop(state(), 'd')?.light.exposure).toBe(2);
    state().reviewAssets([{ assetId: 'd', path: 'copy-of-a.jpg' }], { flag: 'reject' });
    expect(assetFlag(state(), 'a')).toBe('reject');
    expect(book().assets.a?.flag).toBe('reject');
  });
});

describe('read-through', () => {
  beforeEach(() => open());

  it('reads the library entry first, the book field otherwise', () => {
    // A library edited elsewhere (another project on the same folder, later plans): the entry wins.
    state().patchPhoto(FOLDER, H2, (photo) => {
      photo.rating = 3;
      photo.develop = edited(0.7);
    });
    expect(assetRating(state(), 'b')).toBe(3);
    expect(assetDevelop(state(), 'b')?.light.exposure).toBe(0.7);
    // patchPhoto mirrors it onto the book too.
    expect(book().assets.b?.rating).toBe(3);

    // An out-of-sync mirror still reads the library.
    useBookStore.setState((s) => {
      if (s.book?.assets.b) s.book.assets.b.rating = 1;
    });
    expect(assetRating(state(), 'b')).toBe(3);
    expect(resolvedAssets(state())?.b?.rating).toBe(3);
    expect(libraryBook(state())?.assets.b?.rating).toBe(3);
    // No hash: the book's own field.
    useBookStore.setState((s) => {
      if (s.book?.assets.u) s.book.assets.u.rating = 4;
    });
    expect(assetRating(state(), 'u')).toBe(4);
  });

  it('resolvedAssets and libraryBook keep their identity while the mirror is in sync', () => {
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    const assets = resolvedAssets(state());
    expect(assets).toBe(book().assets);
    expect(resolvedAssets(state())).toBe(assets);
    expect(libraryBook(state())).toBe(book());
  });
});

describe('lift on open', () => {
  it('lifts book fields into a new library and saves it', async () => {
    const stop = startLibraryAutosave({ delayMs: 10 });
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5, flag: 'pick' } as Book['assets'][string];
    b.assets.b = { ...b.assets.b, develop: edited(1) } as Book['assets'][string];
    b.assets.u = { path: 'u.jpg', folder: 'F', rating: 2 };
    await open(b);
    // Written during the open, before the book file that now leaves the lifted fields out.
    expect(disk.libraryWrites).toHaveLength(1);
    expect(parseBook(disk.books.get(PROJECT) ?? '').assets.a?.rating).toBeUndefined();
    await flush();
    stop();

    expect(entry(H1)).toEqual({ rating: 5, flag: 'pick', versions: {} });
    expect(entry(H2)?.develop?.light.exposure).toBe(1);
    // Nothing to lift for c; u has no hash yet.
    expect(Object.keys(library()?.photos ?? {}).sort()).toEqual([H1, H2]);
    expect(diskLibrary()).toEqual(library());
    expect(disk.libraryWrites).toHaveLength(1);
    // History starts clean: undo does not take the lift back.
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('logs a conflict naming the hash when the entry and the book hold different edits; the entry wins', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lib = emptyLibrary();
    lib.photos[H1] = { develop: edited(-0.5), versions: {} };
    lib.photos[H2] = { develop: edited(1), versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    const b = tripBook();
    b.assets.a = { ...b.assets.a, develop: edited(2) } as Book['assets'][string];
    b.assets.b = { ...b.assets.b, develop: edited(1) } as Book['assets'][string];
    await open(b);
    const conflicts = log.mock.calls
      .map(([line]) => String(line))
      .filter((l) => l.includes('[photobook:library] conflict'));
    log.mockRestore();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain(H1);
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(-0.5);
  });

  it('a field the library entry has wins over the book; the open rewrites the book file to match', async () => {
    const stop = startLibraryAutosave({ delayMs: 10 });
    const lib = emptyLibrary();
    lib.photos[H1] = { rating: 3, flag: 'pick', develop: edited(-0.5), versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 1, flag: 'reject', develop: edited(2) } as Book['assets'][string];
    await open(b);

    expect(book().assets.a?.rating).toBe(3);
    expect(book().assets.a?.flag).toBe('pick');
    expect(book().assets.a?.develop?.light.exposure).toBe(-0.5);
    // The file the publish CLI reads is rewritten at once without the stale mirror: it resolves the library's values.
    const onDisk = parseBook(disk.books.get(PROJECT) ?? '');
    expect(onDisk.assets.a).toEqual({ path: 'a.jpg', folder: 'F', hash: H1, size: 1, mtime: 1 });
    expect(resolveAssetDevelop(onDisk.assets.a ?? { path: '', folder: '' }, diskLibrary())?.light.exposure).toBe(-0.5);
    // Nothing was lifted, so the library is not written.
    await flush();
    stop();
    expect(disk.libraryWrites).toHaveLength(0);
  });

  it('lifts per field: a book rating survives an entry that only holds develop', async () => {
    const stop = startLibraryAutosave({ delayMs: 10 });
    const lib = emptyLibrary();
    lib.photos[H1] = { develop: edited(0.4), versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 3, develop: edited(3) } as Book['assets'][string];
    await open(b);

    // The rating is lifted into the entry; the entry's develop wins over the book's.
    expect(entry(H1)?.rating).toBe(3);
    expect(entry(H1)?.develop?.light.exposure).toBe(0.4);
    expect(book().assets.a?.rating).toBe(3);
    expect(book().assets.a?.develop?.light.exposure).toBe(0.4);
    await flush();
    stop();
    expect(diskLibrary()?.photos[H1]?.rating).toBe(3);
    const onDisk = parseBook(disk.books.get(PROJECT) ?? '').assets.a;
    expect(onDisk?.rating).toBeUndefined();
    expect(onDisk?.develop).toBeUndefined();
    expect(resolveAssetDevelop(onDisk ?? { path: '', folder: '' }, diskLibrary())?.light.exposure).toBe(0.4);
  });

  it('a book whose rewrite failed on open stays unsaved, and autosave writes it', async () => {
    const stopBook = startAutosave({ delayMs: 10 });
    const lib = emptyLibrary();
    lib.photos[H2] = { rating: 4, versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    const v7 = v7Text(tripBook());
    disk.books.set(PROJECT, v7);
    disk.failBookWrites = true;
    await state().loadProject(PROJECT);
    expect(disk.books.get(PROJECT)).toBe(v7);
    expect(book().assets.b?.rating).toBe(4);
    disk.failBookWrites = false;
    await flush();
    stopBook();
    const saved = JSON.parse(disk.books.get(PROJECT) ?? '{}');
    expect(saved.version).toBe(8);
    expect(saved.assets.b.rating).toBeUndefined();
  });

  it('opens a v7 book: lifts its fields, saves it as v8 without rating, flag or develop, and reopens with the edits', async () => {
    const stopLibrary = startLibraryAutosave({ delayMs: 10 });
    const stopBook = startAutosave({ delayMs: 10 });
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5, flag: 'pick', develop: edited(1.5) } as Book['assets'][string];
    b.assets.b = { ...b.assets.b, flag: 'reject' } as Book['assets'][string];
    // An unhashed photo keeps its fields in the file until the scan hashes it.
    b.assets.u = { path: 'u.jpg', folder: 'F', rating: 2 };
    disk.books.set(PROJECT, v7Text(b));
    const opened = await state().loadProject(PROJECT);
    // Saved during the open: the library first (it holds the lifted fields), then the book in the current format.
    const saved = JSON.parse(disk.books.get(PROJECT) ?? '{}');
    expect(saved.version).toBe(8);
    expect(saved.sourceFolder).toBeUndefined();
    const [folderId] = Object.keys(saved.folders);
    expect(saved.folders).toEqual({ [folderId as string]: { path: FOLDER } });
    for (const id of ['a', 'b', 'c']) {
      expect(saved.assets[id].folder).toBe(folderId);
      for (const key of ['rating', 'flag', 'develop']) expect(saved.assets[id][key]).toBeUndefined();
    }
    expect(saved.assets.u).toEqual({ path: 'u.jpg', folder: folderId, rating: 2 });
    expect(saved.outputs).toEqual([]);
    expect(saved.captions).toEqual({});
    expect(saved.pages.every((p: { guides: unknown }) => Array.isArray(p.guides))).toBe(true);
    expect(diskLibrary()?.photos[H1]).toMatchObject({ rating: 5, flag: 'pick' });
    expect(diskLibrary()?.photos[H1]?.develop?.light.exposure).toBe(1.5);
    expect(diskLibrary()?.photos[H2]?.flag).toBe('reject');
    // Ids are kept through the migration.
    expect(Object.keys(opened?.assets ?? {}).sort()).toEqual(['a', 'b', 'c', 'u']);
    expect(opened?.pages.map((p) => p.id)).toEqual(b.pages.map((p) => p.id));
    await flush();
    stopBook();
    stopLibrary();

    // Reopen from disk: the edits come back from the library.
    await state().close();
    await state().loadProject(PROJECT);
    expect(assetRating(state(), 'a')).toBe(5);
    expect(assetFlag(state(), 'b')).toBe('reject');
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(1.5);
    expect(assetRating(state(), 'u')).toBe(2);
  });

  it('autosave leaves the mirror of hashed photos out of the file, and keeps the fields of an unhashed photo', async () => {
    const stopLibrary = startLibraryAutosave({ delayMs: 10 });
    const stopBook = startAutosave({ delayMs: 10 });
    await open();
    state().setAssetDevelop('a', { light: { exposure: 0.75 } });
    state().reviewAssets([{ assetId: 'b', path: 'b.jpg' }], { rating: 2 });
    state().reviewAssets([{ assetId: 'u', path: 'u.jpg' }], { rating: 3 });
    expect(book().assets.a?.develop?.light.exposure).toBe(0.75);
    await flush();
    stopBook();
    stopLibrary();
    const saved = parseBook(disk.books.get(PROJECT) ?? '');
    expect(saved.assets.a?.develop).toBeUndefined();
    expect(saved.assets.b?.rating).toBeUndefined();
    expect(saved.assets.u?.rating).toBe(3);
    expect(diskLibrary()?.photos[H1]?.develop?.light.exposure).toBe(0.75);
    expect(diskLibrary()?.photos[H2]?.rating).toBe(2);
  });

  it('reopening a saved v8 book restores the mirror in memory without rewriting the file', async () => {
    const lib = emptyLibrary();
    lib.photos[H1] = { rating: 4, develop: edited(0.3), versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    disk.books.set(PROJECT, serializeBook(tripBook()));
    const writes = vi.mocked(writeProject).mock.calls.length;
    await state().loadProject(PROJECT);
    expect(book().assets.a?.rating).toBe(4);
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(0.3);
    expect(vi.mocked(writeProject).mock.calls.length).toBe(writes);
  });

  it('keeps the fields in the saved book while the library cannot be written', async () => {
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5 } as Book['assets'][string];
    disk.books.set(PROJECT, v7Text(b));
    disk.failLibraryWrites = true;
    await state().loadProject(PROJECT);
    const saved = JSON.parse(disk.books.get(PROJECT) ?? '{}');
    expect(saved.version).toBe(8);
    expect(saved.assets.a.rating).toBe(5);
  });

  it('saves the book again without the kept fields once a failed library write succeeds', async () => {
    const stopLibrary = startLibraryAutosave({ delayMs: 10 });
    const stopBook = startAutosave({ delayMs: 10 });
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5 } as Book['assets'][string];
    disk.books.set(PROJECT, v7Text(b));
    disk.failLibraryWrites = true;
    await state().loadProject(PROJECT);
    await flush();
    expect(JSON.parse(disk.books.get(PROJECT) ?? '{}').assets.a.rating).toBe(5);
    expect(disk.libraryWrites).toHaveLength(0);

    disk.failLibraryWrites = false;
    await flush();
    expect(diskLibrary()?.photos[H1]?.rating).toBe(5);
    // The recovered library write marks the book unsaved; its next write leaves the rating out.
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    stopBook();
    stopLibrary();
    expect(JSON.parse(disk.books.get(PROJECT) ?? '{}').assets.a.rating).toBeUndefined();
  });

  it('does not open a project whose folder is not imported, and says which', async () => {
    const b = tripBook();
    b.folders = { F: { path: '/old/place' } };
    disk.books.set(PROJECT, serializeBook(b));
    await expect(state().loadProject(PROJECT)).rejects.toThrow(/\/old\/place.*not imported/);
    expect(state().book).toBeNull();
  });

  it('a new project is written in app data on its folder, with the registry id as its folder id', async () => {
    const id = await state().createProject({ title: 'Zine', folderId: 'F' });
    expect(id).toBe(book().id);
    expect(state().projectId).toBe(id);
    const saved = parseBook(disk.books.get(id) ?? '');
    expect(saved.title).toBe('Zine');
    expect(saved.folders).toEqual({ F: { path: FOLDER } });
    await expect(state().createProject({ title: 'Nope', folderId: 'unknown' })).rejects.toThrow(/no longer imported/);
  });

  it('loadFromFolder opens the most recent project on the folder, else creates one', async () => {
    await state().loadFromFolder(FOLDER);
    const first = state().projectId;
    expect(first).not.toBeNull();
    await state().close();
    await state().loadFromFolder(FOLDER);
    expect(state().projectId).toBe(first);
    expect(disk.books.size).toBe(1);
    await state().close();
    await expect(state().loadFromFolder('/not/imported')).rejects.toMatch(/outside the imported folders/);
  });

  it('a re-created project (book deleted) gets the ratings and edits back from the library', async () => {
    await open();
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 4 });
    state().setAssetDevelop('b', { light: { exposure: 0.25 } });
    state().reviewAssets([{ assetId: 'c', path: 'c.jpg' }], { flag: 'pick' });
    const stop = startLibraryAutosave({ delayMs: 10 });
    state().reviewAssets([{ assetId: 'c', path: 'c.jpg' }], { rating: 1 });
    await flush();
    stop();
    await state().close();
    expect(Object.keys(diskLibrary()?.photos ?? {}).sort()).toEqual([H1, H2, H3]);

    // Delete the project and start another on the folder: a new, empty book.
    disk.books.delete(PROJECT);
    await state().createProject({ title: 'Again', folderId: 'F' });
    expect(book().assets).toEqual({});
    // The scan adds the files under new ids; their hashes bring the library's fields.
    state().fillAssets({
      n1: { path: 'a.jpg', folder: 'F', hash: H1, size: 1, mtime: 1 },
      n2: { path: 'b.jpg', folder: 'F', hash: H2, size: 2, mtime: 1 },
      n3: { path: 'c.jpg', folder: 'F', hash: H3, size: 3, mtime: 1 },
    });
    expect(book().assets.n1?.rating).toBe(4);
    expect(book().assets.n2?.develop?.light.exposure).toBe(0.25);
    expect(book().assets.n3).toMatchObject({ flag: 'pick', rating: 1 });
  });

  it('loadLibrary reads a library into the store without an undo step, and the open book follows it', async () => {
    await open();
    const lib = emptyLibrary();
    lib.photos[H3] = { rating: 2, versions: {} };
    disk.libraries.set(FOLDER, serializeLibrary(lib));
    await state().loadLibrary(FOLDER);
    expect(entry(H3)?.rating).toBe(2);
    expect(book().assets.c?.rating).toBe(2);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('syncBookWithLibrary is pure and counts what it did', () => {
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5 } as Book['assets'][string];
    const lib = emptyLibrary();
    lib.photos[H2] = { flag: 'pick', versions: {} };
    const synced = syncBookWithLibrary(FOLDER, b, lib);
    expect(synced).toMatchObject({ lifted: 1, restored: 1 });
    expect(synced.library.photos[H1]?.rating).toBe(5);
    expect(synced.book.assets.b?.flag).toBe('pick');
    expect(lib.photos[H1]).toBeUndefined();
    expect(b.assets.b?.flag).toBeUndefined();
  });

  it('falls back to library.json.bak when an entry fails the schema', async () => {
    const good = emptyLibrary();
    good.photos[H1] = { rating: 2, versions: {} };
    disk.backups.set(FOLDER, serializeLibrary(good));
    disk.libraries.set(FOLDER, JSON.stringify({ version: 1, photos: { [H1]: { rating: 2 }, [H2]: { rating: 42 } } }));
    await open();
    expect(isLibraryWritable(FOLDER)).toBe(true);
    expect(entry(H1)?.rating).toBe(2);
    expect(entry(H2)).toBeUndefined();
    expect(book().assets.a?.rating).toBe(2);
  });

  it('falls back to library.json.bak for bad JSON or a missing version too (the rule the CLI shares)', async () => {
    const good = emptyLibrary();
    good.photos[H1] = { rating: 3, versions: {} };
    for (const bad of ['{ not json', JSON.stringify({ photos: {} })]) {
      await state().close();
      disk.backups.set(FOLDER, serializeLibrary(good));
      disk.libraries.set(FOLDER, bad);
      await open();
      expect(isLibraryWritable(FOLDER)).toBe(true);
      expect(entry(H1)?.rating).toBe(3);
    }
  });

  it('never falls back from a library written by a newer Photobook, even with a usable backup', async () => {
    const good = emptyLibrary();
    good.photos[H1] = { rating: 3, versions: {} };
    disk.backups.set(FOLDER, serializeLibrary(good));
    disk.libraries.set(FOLDER, JSON.stringify({ version: 2, photos: {} }));
    await open();
    expect(isLibraryWritable(FOLDER)).toBe(false);
    expect(entry(H1)).toBeUndefined();
  });

  it('never writes over a library it could not parse', async () => {
    disk.libraries.set(FOLDER, JSON.stringify({ version: 99, photos: {} }));
    const b = tripBook();
    b.assets.a = { ...b.assets.a, rating: 5 } as Book['assets'][string];
    await open(b);
    expect(isLibraryWritable(FOLDER)).toBe(false);
    const stop = startLibraryAutosave({ delayMs: 10 });
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    await flush();
    stop();
    expect(disk.libraryWrites).toHaveLength(0);
    expect(disk.libraries.get(FOLDER)).toBe(JSON.stringify({ version: 99, photos: {} }));
    // The edit still lives on the book mirror.
    expect(book().assets.a?.develop?.light.exposure).toBe(1);
  });
});

describe('publish', () => {
  it('the fingerprint of a book with an edited photo is unchanged by the library round trip', async () => {
    const b = tripBook();
    b.assets.a = { ...b.assets.a, develop: edited(1.25) } as Book['assets'][string];
    const slot: PhotoElement = {
      type: 'photo',
      id: 'slot-a',
      asset: 'a',
      frame: { x: 0, y: 0, w: 1, h: 1 },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    };
    b.pages[0]?.elements.push(slot);
    const before = await publishFingerprint(b);
    // An edit to another photo changes the fingerprint, so the check below is not vacuous.
    expect(
      await publishFingerprint({ ...b, assets: { ...b.assets, a: { ...b.assets.a, develop: edited(1) } } } as Book),
    ).not.toBe(before);

    await open(b);
    expect(entry(H1)?.develop?.light.exposure).toBe(1.25);
    // What the CLI reads (the saved book with its mirror) and what the editor renders (read through the library).
    expect(await publishFingerprint(parseBook(serializeBook(book())))).toBe(before);
    expect(await publishFingerprint(libraryBook(state()) as Book)).toBe(before);

    // Edit, then undo: back to the same fingerprint.
    state().setAssetDevelop('a', { light: { exposure: 2 } });
    expect(await publishFingerprint(book())).not.toBe(before);
    undo();
    expect(await publishFingerprint(parseBook(serializeBook(book())))).toBe(before);
  });
});

describe('library autosave', () => {
  it('debounces library changes into one write and skips the loaded state', async () => {
    await open();
    vi.useFakeTimers();
    const write = vi.fn(async (_folder: string, _json: string) => {});
    const stop = startLibraryAutosave({ write, delayMs: 500 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).not.toHaveBeenCalled();

    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 1 });
    await vi.advanceTimersByTimeAsync(200);
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 2 });
    await vi.advanceTimersByTimeAsync(499);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(parseLibrary(write.mock.calls[0]?.[1] ?? '').photos[H1]?.rating).toBe(2);

    // Book-only changes do not touch the library.
    state().setTitle('Renamed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);

    // Undo of a develop edit is a library change too.
    state().setAssetDevelop('a', { light: { exposure: 1 } });
    await vi.advanceTimersByTimeAsync(500);
    undo();
    await vi.advanceTimersByTimeAsync(500);
    expect(write).toHaveBeenCalledTimes(3);
    expect(parseLibrary(write.mock.calls[2]?.[1] ?? '').photos[H1]?.develop).toBeUndefined();
    stop();
  });

  it('a failed write keeps the error until a library write succeeds, and the next change retries', async () => {
    await open();
    const stopBook = startAutosave({ delayMs: 10 });
    const stop = startLibraryAutosave({ delayMs: 10 });
    disk.failLibraryWrites = true;
    state().reviewAssets([{ assetId: 'a', path: 'a.jpg' }], { rating: 5 });
    await flush();
    expect(useUiStore.getState().saveStatus).toBe('error');
    expect(useUiStore.getState().saveError).toMatch(/Library not saved/);
    // A book save does not hide it.
    state().setTitle('Renamed');
    await flush();
    expect(useUiStore.getState().saveStatus).toBe('error');

    disk.failLibraryWrites = false;
    state().reviewAssets([{ assetId: 'b', path: 'b.jpg' }], { flag: 'pick' });
    await flush();
    expect(useUiStore.getState().saveStatus).toBe('saved');
    expect(diskLibrary()?.photos[H1]?.rating).toBe(5);
    expect(diskLibrary()?.photos[H2]?.flag).toBe('pick');
    stop();
    stopBook();
  });

  it('loading another folder’s library is not a change to write', async () => {
    await open();
    const stop = startLibraryAutosave({ delayMs: 10 });
    const porto = emptyLibrary();
    porto.photos[H3] = { rating: 1, versions: {} };
    disk.libraries.set('/porto', serializeLibrary(porto));
    await state().loadLibrary('/porto');
    await state().loadLibrary('/empty');
    await flush();
    expect(disk.libraryWrites).toEqual([]);
    // A change to it is.
    state().patchPhoto('/porto', H3, (photo) => {
      photo.rating = 2;
    });
    await flush();
    stop();
    expect(disk.libraryWrites.map((w) => w.folder)).toEqual(['/porto']);
  });

  it('close writes a pending change first', async () => {
    await open();
    const write = vi.fn(async (_folder: string, _json: string) => {});
    const stop = startLibraryAutosave({ write, delayMs: 10_000 });
    state().reviewAssets([{ assetId: 'b', path: 'b.jpg' }], { flag: 'pick' });
    await state().close();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(FOLDER);
    stop();
  });
});

describe('projects', () => {
  const PORTO = '/porto';
  const OTHER = '01K7B00000000000000000000B';

  it('two projects on one folder save independently and share the folder library', async () => {
    const stopLibrary = startLibraryAutosave({ delayMs: 10 });
    const stopBook = startAutosave({ delayMs: 10 });
    const zine = tripBook();
    const carousel = tripBook();
    disk.books.set(OTHER, serializeBook({ ...carousel, title: 'Carousel' }));
    await open({ ...zine, title: 'Zine' });
    state().setAssetDevelop('a', { light: { exposure: 0.8 } });
    state().setTitle('Zine 2');
    await flush();
    await state().close();

    // The other project's file is untouched by the first one's saves.
    expect(parseBook(disk.books.get(OTHER) ?? '').title).toBe('Carousel');
    expect(parseBook(disk.books.get(PROJECT) ?? '').title).toBe('Zine 2');

    // Open the other one: the edit made in the first shows (the library is the folder's).
    await state().loadProject(OTHER);
    expect(state().projectId).toBe(OTHER);
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(0.8);
    state().setTitle('Carousel 2');
    await flush();
    stopBook();
    stopLibrary();
    expect(parseBook(disk.books.get(OTHER) ?? '').title).toBe('Carousel 2');
    expect(parseBook(disk.books.get(PROJECT) ?? '').title).toBe('Zine 2');
  });

  it('an asset in another folder reads and writes that folder’s library, and is saved without its mirror', async () => {
    importFolders({ id: 'G', path: PORTO });
    const porto = emptyLibrary();
    porto.photos[H3] = { rating: 5, versions: {} };
    disk.libraries.set(PORTO, serializeLibrary(porto));
    const b = tripBook();
    b.folders.G = { path: PORTO };
    b.assets.c = { path: 'c.jpg', folder: 'G', hash: H3, size: 3, mtime: 1 };
    const stopLibrary = startLibraryAutosave({ delayMs: 10 });
    const stopBook = startAutosave({ delayMs: 10 });
    await open(b);
    expect(state().folder).toBe(FOLDER);
    expect(assetRating(state(), 'c')).toBe(5);
    state().setAssetDevelop('c', { light: { exposure: 0.3 } });
    expect(library(PORTO)?.photos[H3]?.develop?.light.exposure).toBe(0.3);
    expect(library(FOLDER)?.photos[H3]).toBeUndefined();
    await flush();
    stopBook();
    stopLibrary();
    expect(diskLibrary(PORTO)?.photos[H3]?.develop?.light.exposure).toBe(0.3);
    const saved = parseBook(disk.books.get(PROJECT) ?? '').assets.c;
    expect(saved?.develop).toBeUndefined();
    expect(saved?.rating).toBeUndefined();
  });

  it('relinkAssets moves a photo to another folder, keeps its id and carries its library entry', async () => {
    importFolders({ id: 'G', path: PORTO });
    await open();
    state().setAssetDevelop('a', { light: { exposure: 1.1 } });
    await state().loadLibrary(PORTO);
    state().relinkAssets([{ assetId: 'a', folderId: 'G', folderPath: PORTO, path: 'moved/a.jpg', size: 1, mtime: 2 }]);
    expect(book().assets.a).toMatchObject({ folder: 'G', path: 'moved/a.jpg', hash: H1, mtime: 2 });
    expect(book().folders).toEqual({ F: { path: FOLDER }, G: { path: PORTO } });
    expect(library(PORTO)?.photos[H1]?.develop?.light.exposure).toBe(1.1);
    expect(assetDevelop(state(), 'a')?.light.exposure).toBe(1.1);
    // Undoing the earlier edit keeps the newest place of the photo (and its folder entry).
    undo();
    expect(book().assets.a).toMatchObject({ folder: 'G', path: 'moved/a.jpg' });
    expect(book().folders.G).toEqual({ path: PORTO });

    // Moving it back drops the folder entry nobody uses any more; the primary one always stays.
    state().relinkAssets([{ assetId: 'a', folderId: 'F', folderPath: FOLDER, path: 'a.jpg', size: 1, mtime: 3 }]);
    expect(book().folders).toEqual({ F: { path: FOLDER } });
    expect(book().assets.a?.folder).toBe('F');
  });
});
