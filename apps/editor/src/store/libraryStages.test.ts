import { type Book, parseLibrary, publishFingerprint, serializeBook } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetHashedEvent, HashProgressEvent, IndexEntry, PhotoFacts, ScannedFile } from '../lib/tauri';
import { addFolderPhotos, addToProject, useAssetsStore } from './assets';
import { flush, startLibraryAutosave } from './autosave';
import { redo, undo, useBookStore } from './book';
import { libraryKeys } from './collections';
import {
  assetDevelop,
  assetFlag,
  assetRating,
  hasPhoto,
  libraryBook,
  photoKey,
  useLibraryStore,
  waitForHash,
} from './library';
import { DEFAULT_FILMSTRIP } from './ui';

/** A fake disk behind the Tauri wrappers: one folder's files, their hashes, its index, its library, projects. */
const disk = vi.hoisted(() => ({
  files: [] as ScannedFile[],
  hashes: {} as Record<string, string>,
  /** What `prepareAsset` reads from each file's Exif and proxy (plan 38). */
  facts: {} as Record<string, PhotoFacts>,
  index: {} as Record<string, IndexEntry>,
  indexWrites: 0,
  hashed: [] as string[],
  /** When set, `hashFiles` waits for it; when `failHash`, it rejects (the command failed). */
  gate: null as Promise<void> | null,
  failHash: false,
  libraries: new Map<string, string>(),
  books: new Map<string, string>(),
  listeners: new Set<(e: AssetHashedEvent) => void>(),
  progress: new Set<(e: HashProgressEvent) => void>(),
}));

const FOLDER = '/trip';
const F = '01K7F000000000000000000000';
const h = (c: string) => c.repeat(64);

vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  // Like Rust: a file whose index entry still matches carries its hash and size, and every optional field.
  scanFolder: vi.fn(async () =>
    disk.files.map((f) => {
      const e = disk.index[f.relPath];
      if (!e || e.size !== f.size || e.mtime !== f.mtimeMs || e.kind !== f.kind) return f;
      const { size: _size, mtime: _mtime, kind: _kind, ...fields } = e;
      return { ...f, ...fields };
    }),
  ),
  readIndex: vi.fn(async () => disk.index),
  writeIndex: vi.fn(async (_folder: string, photos: Record<string, IndexEntry>) => {
    disk.index = photos;
    disk.indexWrites += 1;
  }),
  hashFiles: vi.fn(async (_folder: string, relPaths: string[], job: number) => {
    if (relPaths.length > 0 && disk.gate) await disk.gate;
    if (relPaths.length > 0 && disk.failHash) throw 'hash_files failed';
    relPaths.forEach((relPath, i) => {
      disk.hashed.push(relPath);
      const hash = disk.hashes[relPath] ?? null;
      for (const fn of disk.listeners) fn({ job, relPath, hash, error: hash ? null : 'unreadable' });
      for (const fn of disk.progress) fn({ job, done: i + 1, total: relPaths.length });
    });
  }),
  onAssetHashed: vi.fn(async (fn: (e: AssetHashedEvent) => void) => {
    disk.listeners.add(fn);
    return () => disk.listeners.delete(fn);
  }),
  onHashProgress: vi.fn(async (fn: (e: HashProgressEvent) => void) => {
    disk.progress.add(fn);
    return () => disk.progress.delete(fn);
  }),
  prepareAsset: vi.fn(async (_folder: string, relPath: string, hash: string) => ({
    ...disk.facts[relPath],
    width: 1200,
    height: 800,
    orientation: 1,
    thumbPath: `/cache/${hash}/thumb.jpg`,
    proxyPath: `/cache/${hash}/proxy.jpg`,
    isRaw: false,
  })),
  renderDevelopCached: vi.fn(async (_f: string, _r: string, hash: string) => ({
    developHash: 'dh',
    width: 1600,
    height: 1067,
    thumbPath: `/cache/${hash}/thumb-dh.jpg`,
    proxyPath: `/cache/${hash}/proxy-dh.jpg`,
  })),
  fileUrl: (path: string) => `asset://localhost${path}`,
  listFolders: vi.fn(async () => [{ id: F, path: FOLDER, name: 'Trip', addedAt: 1, lastSeen: 1, missing: false }]),
  readLibrary: vi.fn(async (folder: string) => disk.libraries.get(folder) ?? null),
  readLibraryBackup: vi.fn(async () => null),
  writeLibrary: vi.fn(async (folder: string, json: string) => {
    disk.libraries.set(folder, json);
  }),
  readProject: vi.fn(async (id: string) => {
    const text = disk.books.get(id);
    if (text === undefined) throw `No project with id ${id}`;
    return text;
  }),
  writeProject: vi.fn(async (id: string, json: string) => {
    disk.books.set(id, json);
  }),
  createProject: vi.fn(async (id: string, json: string) => {
    disk.books.set(id, json);
    return { id };
  }),
  setRecent: vi.fn(async () => {}),
}));

const file = (relPath: string, size: number): ScannedFile => ({ relPath, size, mtimeMs: 1, kind: 'jpeg' });
const library = () => useLibraryStore.getState();
const book = () => useBookStore.getState();
const key = (path: string) => photoKey({ folder: F, path });

beforeEach(() => {
  disk.files = [file('a.jpg', 1), file('b.jpg', 2), file('c.jpg', 3)];
  disk.hashes = { 'a.jpg': h('a'), 'b.jpg': h('b'), 'c.jpg': h('c') };
  disk.facts = {};
  disk.index = {};
  disk.indexWrites = 0;
  disk.hashed = [];
  disk.gate = null;
  disk.failHash = false;
  disk.libraries.clear();
  disk.books.clear();
});
afterEach(async () => {
  await book().close();
  useAssetsStore.getState().reset();
  library().reset();
});

/** Open the folder in the library, as the Cull stage does: scan it and load its library. */
async function openFolder() {
  library().addFolder(F, FOLDER);
  await library().scan(F);
  await book().loadLibrary(FOLDER);
}

describe('folder index', () => {
  it('hashes a new folder once, writes the index, and reuses it on the next open', async () => {
    await openFolder();
    expect(disk.hashed.sort()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(disk.indexWrites).toBe(1);
    expect(disk.index['b.jpg']).toMatchObject({ hash: h('b'), size: 2, mtime: 1, kind: 'jpeg', width: 1200 });
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ status: 'ready', hash: h('a') });

    // A new session: nothing is hashed, nothing is written.
    library().reset();
    disk.hashed = [];
    await openFolder();
    expect(disk.hashed).toEqual([]);
    expect(disk.indexWrites).toBe(1);
    expect(library().folders[F]?.photos['c.jpg']).toMatchObject({ status: 'ready', hash: h('c'), width: 1200 });

    // A changed file is hashed again, and the index follows.
    disk.files = [file('a.jpg', 1), file('b.jpg', 22), file('c.jpg', 3)];
    disk.hashes['b.jpg'] = h('d');
    await library().scan(F, { force: true });
    expect(disk.hashed).toEqual(['b.jpg']);
    expect(disk.index['b.jpg']?.hash).toBe(h('d'));
  });

  it('an index from before plan 38 gains capture time and stats on the next prepare, without hashing again', async () => {
    // Written by the previous version: hashes and sizes, no facts.
    disk.index = {
      'a.jpg': { hash: h('a'), size: 1, mtime: 1, kind: 'jpeg', width: 1200, height: 800 },
      'b.jpg': { hash: h('b'), size: 2, mtime: 1, kind: 'jpeg', width: 1200, height: 800 },
      'c.jpg': { hash: h('c'), size: 3, mtime: 1, kind: 'jpeg', width: 1200, height: 800 },
    };
    const stats = {
      sharpness: 120,
      sharpnessMax: 900,
      sharpestTile: 19,
      motion: 0.1,
      clipHigh: 0.01,
      clipLow: 0,
      medianLum: 0.45,
    };
    // prepare_asset backfills the cache entry from the Exif and the cached proxy (Rust), then reports the facts.
    disk.facts = {
      'a.jpg': {
        taken: 1_791_885_602_050,
        make: 'Fujifilm',
        model: 'X-T5',
        lens: 'XF23',
        focal: 23,
        phash: 'ff00',
        stats,
      },
      'b.jpg': { taken: 1_791_885_600_050, phash: '00ff', stats },
    };
    await openFolder();
    expect(disk.hashed).toEqual([]);
    expect(disk.indexWrites).toBe(1);
    expect(disk.index['a.jpg']).toMatchObject({
      hash: h('a'),
      taken: 1_791_885_602_050,
      lens: 'XF23',
      focal: 23,
      stats,
    });
    expect(disk.index['b.jpg']).toMatchObject({ taken: 1_791_885_600_050, phash: '00ff' });
    // A photo without Exif keeps no fact fields at all.
    expect(Object.keys(disk.index['c.jpg'] ?? {}).sort()).toEqual([
      'hash',
      'height',
      'kind',
      'mtime',
      'orientation',
      'size',
      'width',
    ]);
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ status: 'ready', make: 'Fujifilm', stats });

    // Capture time sorts by `taken` (b before a), the photo without one by its mtime (1, first).
    const source = { kind: 'folder', id: F } as const;
    expect(libraryKeys(source, library().folders, book().libraries, DEFAULT_FILMSTRIP)).toEqual([
      key('c.jpg'),
      key('b.jpg'),
      key('a.jpg'),
    ]);

    // The next session reads the facts from the index (the scan carries them) and writes nothing.
    library().reset();
    disk.facts = {};
    await openFolder();
    expect(disk.indexWrites).toBe(1);
    expect(library().folders[F]?.photos['b.jpg']).toMatchObject({ taken: 1_791_885_600_050, phash: '00ff' });
  });

  it('an index from plan 38 gains shutter, aperture and gps on the next prepare (plan 52), without a rescan', async () => {
    disk.files = [file('a.jpg', 1)];
    disk.index = {
      'a.jpg': { hash: h('a'), size: 1, mtime: 1, kind: 'jpeg', width: 1200, height: 800, taken: 5, make: 'Fujifilm' },
    };
    // FACTS_VERSION 2: prepare_asset reads the Exif again once and reports the new fields with the old ones.
    disk.facts = {
      'a.jpg': { taken: 5, make: 'Fujifilm', shutter: 0.004, aperture: 2.8, gps: { lat: 38.71, lon: -9.14 } },
    };
    await openFolder();
    expect(disk.hashed).toEqual([]);
    expect(disk.indexWrites).toBe(1);
    expect(disk.index['a.jpg']).toMatchObject({
      taken: 5,
      shutter: 0.004,
      aperture: 2.8,
      gps: { lat: 38.71, lon: -9.14 },
    });
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ shutter: 0.004, gps: { lat: 38.71, lon: -9.14 } });
    // The next session reads them from the index and writes nothing.
    library().reset();
    disk.facts = {};
    await openFolder();
    expect(disk.indexWrites).toBe(1);
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ aperture: 2.8 });
  });

  it('an index from plan 52 gains the palette on the next prepare (plan 56), without a rescan', async () => {
    disk.files = [file('a.jpg', 1)];
    disk.index = {
      'a.jpg': { hash: h('a'), size: 1, mtime: 1, kind: 'jpeg', width: 1200, height: 800, taken: 5, aperture: 2.8 },
    };
    // FACTS_VERSION 3: prepare_asset backfills the palette from the cached proxy and reports it with the old fields.
    const palette = ['#1f3a5f', '#d8c3a5', '#8e8d8a', '#e98074', '#e85a4f'];
    disk.facts = { 'a.jpg': { taken: 5, aperture: 2.8, palette } };
    await openFolder();
    expect(disk.hashed).toEqual([]);
    expect(disk.indexWrites).toBe(1);
    expect(disk.index['a.jpg']).toMatchObject({ taken: 5, aperture: 2.8, palette });
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ palette });
    library().reset();
    disk.facts = {};
    await openFolder();
    expect(disk.indexWrites).toBe(1);
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ palette });
  });

  it('reads an index without scanning (counts before the folder is opened)', async () => {
    disk.index = { 'a.jpg': { hash: h('a'), size: 1, mtime: 1, kind: 'jpeg' } };
    library().addFolder(F, FOLDER);
    await library().loadIndex(F);
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ hash: h('a'), status: 'scanned' });
    expect(disk.hashed).toEqual([]);
  });

  it('waits for a photo to be hashed while its folder scans, and gives up when it cannot be', async () => {
    library().addFolder(F, FOLDER);
    // No scan running: nothing will hash it.
    await expect(waitForHash(F, 'b.jpg')).resolves.toBeNull();
    let open = () => {};
    disk.gate = new Promise((resolve) => {
      open = resolve;
    });
    const scan = library().scan(F);
    await vi.waitFor(() => expect(library().folders[F]?.photos['b.jpg']?.status).toBe('hashing'));
    const hashed = waitForHash(F, 'b.jpg');
    open();
    await scan;
    await expect(hashed).resolves.toBe(h('b'));
    await expect(waitForHash(F, 'gone.jpg')).resolves.toBeNull();
  });

  it('never leaves a photo hashing when hash_files fails, and resolves its waiters with null', async () => {
    library().addFolder(F, FOLDER);
    disk.failHash = true;
    let open = () => {};
    disk.gate = new Promise((resolve) => {
      open = resolve;
    });
    const scan = library().scan(F);
    await vi.waitFor(() => expect(library().folders[F]?.photos['a.jpg']?.status).toBe('hashing'));
    const hashed = waitForHash(F, 'a.jpg');
    open();
    await scan;
    await expect(hashed).resolves.toBeNull();
    expect(library().folders[F]?.error).toMatch(/hash_files failed/);
    expect(Object.values(library().folders[F]?.photos ?? {}).map((p) => p.status)).toEqual([
      'scanned',
      'scanned',
      'scanned',
    ]);
  });

  it('rewrites the index when a file is deleted, and keeps the hashes when the thumbnails never finish', async () => {
    await openFolder();
    expect(Object.keys(disk.index).sort()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    // c.jpg deleted: nothing new to hash or prepare, but the index drops it.
    disk.files = [file('a.jpg', 1), file('b.jpg', 2)];
    await library().scan(F, { force: true });
    expect(disk.indexWrites).toBe(2);
    expect(Object.keys(disk.index).sort()).toEqual(['a.jpg', 'b.jpg']);

    // A new file: its hash reaches the index right after hashing, before any thumbnail is made.
    disk.files.push(file('n.jpg', 9));
    disk.hashes['n.jpg'] = h('e');
    const { prepareAsset } = await import('../lib/tauri');
    vi.mocked(prepareAsset).mockImplementationOnce(() => new Promise(() => {}));
    void library().scan(F, { force: true });
    await vi.waitFor(() => expect(disk.index['n.jpg']?.hash).toBe(h('e')));
    expect(disk.index['n.jpg']?.width).toBeUndefined();
  });
});

describe('Cull and Develop without a project', () => {
  it('rates and edits a folder photo by its key, in the folder library', async () => {
    await openFolder();
    expect(book().book).toBeNull();
    expect(hasPhoto(book(), key('a.jpg'))).toBe(true);
    book().reviewAssets([{ assetId: key('a.jpg'), path: 'a.jpg' }], { rating: 4, flag: 'pick' });
    book().setAssetDevelop(key('a.jpg'), { light: { exposure: 0.5 } });
    book().reviewAssets([{ assetId: key('b.jpg'), path: 'b.jpg' }], { flag: 'reject' });
    expect(book().libraries[FOLDER]?.photos[h('a')]).toMatchObject({ rating: 4, flag: 'pick' });
    expect(assetDevelop(book(), key('a.jpg'))?.light.exposure).toBe(0.5);
    expect(assetRating(book(), key('a.jpg'))).toBe(4);
    expect(assetFlag(book(), key('b.jpg'))).toBe('reject');

    // The develop edit is an undo step; the rating is not, and survives the undo.
    undo();
    expect(assetDevelop(book(), key('a.jpg'))).toBeUndefined();
    expect(assetRating(book(), key('a.jpg'))).toBe(4);
    redo();
    expect(assetDevelop(book(), key('a.jpg'))?.light.exposure).toBe(0.5);

    // The edit renders for the library (the thumbnail the stages show).
    await useAssetsStore.getState().renderDeveloped(key('a.jpg'));
    expect(library().folders[F]?.photos['a.jpg']?.developed).toBeDefined();
  });

  it('never writes a library it has not loaded', async () => {
    library().addFolder(F, FOLDER);
    await library().scan(F);
    book().reviewAssets([{ assetId: key('a.jpg'), path: 'a.jpg' }], { rating: 2 });
    expect(book().libraries[FOLDER]).toBeUndefined();
  });

  it('filters the stage list by flag and rating, sorted by capture time', async () => {
    await openFolder();
    book().reviewAssets([{ assetId: key('c.jpg'), path: 'c.jpg' }], { flag: 'pick', rating: 5 });
    book().reviewAssets([{ assetId: key('a.jpg'), path: 'a.jpg' }], { flag: 'pick' });
    const { folders } = library();
    const { libraries } = book();
    const source = { kind: 'folder', id: F } as const;
    expect(libraryKeys(source, folders, libraries, DEFAULT_FILMSTRIP)).toEqual([
      key('a.jpg'),
      key('b.jpg'),
      key('c.jpg'),
    ]);
    expect(libraryKeys(source, folders, libraries, { ...DEFAULT_FILMSTRIP, flag: 'picks' })).toEqual([
      key('a.jpg'),
      key('c.jpg'),
    ]);
    expect(libraryKeys(source, folders, libraries, { ...DEFAULT_FILMSTRIP, minRating: 5 })).toEqual([key('c.jpg')]);
    expect(libraryKeys({ kind: 'collection', id: 'picks' }, folders, libraries, DEFAULT_FILMSTRIP)).toHaveLength(2);
    expect(libraryKeys({ kind: 'collection', id: 'edited' }, folders, libraries, DEFAULT_FILMSTRIP)).toEqual([]);
  });

  it('a project made afterwards with the picks has their ratings and edits', async () => {
    await openFolder();
    const save = startLibraryAutosave({ delayMs: 5 });
    book().reviewAssets([{ assetId: key('a.jpg'), path: 'a.jpg' }], { flag: 'pick', rating: 3 });
    book().reviewAssets([{ assetId: key('c.jpg'), path: 'c.jpg' }], { flag: 'pick' });
    book().setAssetDevelop(key('c.jpg'), { light: { exposure: -1 } });
    await flush();
    save();
    expect(parseLibrary(disk.libraries.get(FOLDER) ?? '').photos[h('c')]?.develop?.light.exposure).toBe(-1);

    const id = await book().createProject({ title: 'Picks', folderId: F });
    expect(book().book?.assets).toEqual({});
    expect(await addFolderPhotos(F, 'picks')).toBe(2);
    const assets = Object.entries(book().book?.assets ?? {});
    expect(assets.map(([, a]) => a.path).sort()).toEqual(['a.jpg', 'c.jpg']);
    const [aId] = assets.find(([, a]) => a.path === 'a.jpg') ?? [];
    const [cId] = assets.find(([, a]) => a.path === 'c.jpg') ?? [];
    expect(assetRating(book(), aId ?? '')).toBe(3);
    expect(assetFlag(book(), cId ?? '')).toBe('pick');
    expect(assetDevelop(book(), cId ?? '')?.light.exposure).toBe(-1);
    // Every asset is a ref: folder, path and hash.
    expect(book().book?.assets[cId ?? '']).toMatchObject({ folder: F, path: 'c.jpg', hash: h('c'), size: 3 });
    // Adding a photo the project holds keeps its asset.
    expect(await addToProject([key('c.jpg'), key('b.jpg')])).toEqual([cId, expect.any(String)]);
    expect(Object.keys(book().book?.assets ?? {})).toHaveLength(3);
    expect(book().projectId).toBe(id);
  });

  it('publishes a project built from the library like one built inside the project', async () => {
    await openFolder();
    const save = startLibraryAutosave({ delayMs: 5 });
    // The old way: a project holding every photo, edited inside it by asset id.
    await book().createProject({ title: 'Old', folderId: F });
    await addFolderPhotos(F, 'all');
    const old = book().book as Book;
    const idOf = (b: Book, path: string) => Object.entries(b.assets).find(([, a]) => a.path === path)?.[0] ?? '';
    book().setAssetDevelop(idOf(old, 'b.jpg'), { light: { exposure: 1 } });
    const oldBook = libraryBook(book()) as Book;
    await book().close();

    // The new way: the same edit made in Develop over the library, then a project of all photos.
    useBookStore.setState((s) => {
      s.libraries = {};
    });
    await book().loadLibrary(FOLDER);
    book().resetAssetDevelop(key('b.jpg'));
    book().setAssetDevelop(key('b.jpg'), { light: { exposure: 1 } });
    await book().createProject({ title: 'New', folderId: F });
    await addFolderPhotos(F, 'all');
    const newBook = libraryBook(book()) as Book;
    save();

    // Same photos, same resolved edits: the publish fingerprints agree once asset ids are matched by path.
    const byPath = (b: Book) =>
      Object.fromEntries(
        Object.values(b.assets).map((a) => [a.path, { hash: a.hash, folder: a.folder, develop: a.develop }]),
      );
    expect(byPath(newBook)).toEqual(byPath(oldBook));
    // The rest of the document (page ids, dates) differs between any two projects: compare the photos alone.
    const photosOf = (b: Book): Book => ({
      ...oldBook,
      assets: Object.fromEntries(Object.values(b.assets).map((a) => [a.path, a])),
    });
    expect(await publishFingerprint(photosOf(newBook))).toEqual(await publishFingerprint(photosOf(oldBook)));
    expect(serializeBook(photosOf(newBook))).toEqual(serializeBook(photosOf(oldBook)));
  });
});

describe('review fixes', () => {
  it('New project → All photos works on a fresh session (the folder is looked up in the registry)', async () => {
    expect(library().folders).toEqual({});
    await book().createProject({ title: 'Fresh', folderId: F });
    expect(await addFolderPhotos(F, 'all')).toBe(3);
    expect(
      Object.values(book().book?.assets ?? {})
        .map((a) => a.path)
        .sort(),
    ).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  it('adds nothing when the project changed while the photos were hashing', async () => {
    await book().createProject({ title: 'First', folderId: F });
    library().addFolder(F, FOLDER);
    let open = () => {};
    disk.gate = new Promise((resolve) => {
      open = resolve;
    });
    const scan = library().scan(F);
    await vi.waitFor(() => expect(library().folders[F]?.photos['a.jpg']?.status).toBe('hashing'));
    const adding = addToProject([key('a.jpg')]);
    await book().createProject({ title: 'Second', folderId: F });
    open();
    await scan;
    await expect(adding).resolves.toEqual([null]);
    expect(book().book?.title).toBe('Second');
    expect(book().book?.assets).toEqual({});
  });

  it('prepares only the photos asked for from an index, without hashing', async () => {
    disk.index = {
      'a.jpg': { hash: h('a'), size: 1, mtime: 1, kind: 'jpeg' },
      'b.jpg': { hash: h('b'), size: 2, mtime: 1, kind: 'jpeg' },
    };
    library().addFolder(F, FOLDER);
    await library().loadIndex(F);
    await library().prepare(F, ['a.jpg', 'gone.jpg']);
    expect(library().folders[F]?.photos['a.jpg']).toMatchObject({ status: 'ready', thumbUrl: expect.any(String) });
    expect(library().folders[F]?.photos['b.jpg']?.status).toBe('scanned');
    expect(disk.hashed).toEqual([]);
  });

  it('trusts a known hash only with its size and mtime recorded', async () => {
    library().addFolder(F, FOLDER);
    await library().scan(F, { known: { 'a.jpg': { hash: h('x') }, 'b.jpg': { hash: h('b'), size: 2, mtime: 1 } } });
    expect(disk.hashed.sort()).toEqual(['a.jpg', 'c.jpg']);
    expect(library().folders[F]?.photos['a.jpg']?.hash).toBe(h('a'));
  });

  it('a library read that started before another load of the same folder does not replace it', async () => {
    await openFolder();
    const fresh = book().libraries[FOLDER];
    useBookStore.setState((s) => {
      delete s.libraries[FOLDER];
    });
    // An `ensureLibrary` read starts while the folder has no library...
    const stale = book().loadLibrary(FOLDER);
    // ...and a project open loads it (with an edit) before that read lands.
    useBookStore.setState((s) => {
      if (fresh) s.libraries[FOLDER] = fresh;
    });
    book().reviewAssets([{ assetId: key('a.jpg'), path: 'a.jpg' }], { rating: 5 });
    await stale;
    expect(assetRating(book(), key('a.jpg'))).toBe(5);
  });
});
