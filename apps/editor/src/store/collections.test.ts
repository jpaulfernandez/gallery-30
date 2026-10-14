import { emptyLibrary } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availableCollections,
  collectionFilterFor,
  type LibrarySource,
  libraryKeys,
  needsDenoise,
  savedCollection,
  sourceItems,
  useCollectionsStore,
} from './collections';
import { type LibraryFolder, type PhotoFile, photoKey } from './library';
import { DEFAULT_FILMSTRIP } from './ui';

/** `<appdata>/collections.json` behind the wrappers, as Rust stores it (JSON text). */
const disk = vi.hoisted(() => ({ text: null as string | null, fail: false, readFails: false }));

vi.mock('../lib/tauri', async (original) => ({
  ...(await original<typeof import('../lib/tauri')>()),
  readCollections: vi.fn(async () => {
    if (disk.readFails) throw 'permission denied';
    return disk.text ? JSON.parse(disk.text) : [];
  }),
  writeCollections: vi.fn(async (list: unknown[]) => {
    if (disk.fail) throw 'disk full';
    disk.text = JSON.stringify(list);
  }),
}));

const F = 'F1';
const G = 'G1';
const photo = (relPath: string, mtime: number, iso?: number): PhotoFile => ({
  relPath,
  size: 1,
  mtime,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  status: 'ready',
  ...(iso ? { iso } : {}),
});
const folder = (id: string, path: string, photos: PhotoFile[]): LibraryFolder => ({
  id,
  path,
  photos: Object.fromEntries(photos.map((p) => [p.relPath, p])),
  progress: { hashed: 0, prepared: 0, total: 0 },
  busy: false,
  error: null,
  scanned: true,
});

const folders = {
  [F]: folder(F, '/trip', [photo('a.jpg', 1, 6400), photo('b.jpg', 2), photo('rome.jpg', 3, 200)]),
  [G]: folder(G, '/home', [photo('c.jpg', 4), photo('rome2.jpg', 5)]),
};
const trip = emptyLibrary();
trip.photos['h-a.jpg'] = { flag: 'pick', rating: 4, versions: {} };
trip.photos['h-rome.jpg'] = { flag: 'pick', rating: 2, versions: {} };
trip.photos['h-b.jpg'] = { flag: 'reject', versions: {} };
const home = emptyLibrary();
home.photos['h-rome2.jpg'] = { flag: 'pick', rating: 5, versions: {}, develop: undefined };
const libraries = { '/trip': trip, '/home': home };
const keys = (source: LibrarySource, view = DEFAULT_FILMSTRIP) => libraryKeys(source, folders, libraries, view);
const k = (folderId: string, name: string) => photoKey({ folder: folderId, path: name });

beforeEach(() => {
  disk.text = null;
  disk.fail = false;
  disk.readFails = false;
  useCollectionsStore.getState().reset();
});
afterEach(() => useCollectionsStore.getState().reset());

describe('collectionFilterFor', () => {
  it('keeps a folder and narrows by the view filters', () => {
    const view = { ...DEFAULT_FILMSTRIP, flag: 'picks' as const, minRating: 3, query: ' a ', hideUsed: true };
    expect(collectionFilterFor({ kind: 'folder', id: F }, view)).toEqual({
      folders: [F],
      flag: 'picks',
      minRating: 3,
      query: 'a',
    });
  });

  it("turns a built-in collection into its criterion, and keeps a saved one's filter under the view", () => {
    expect(collectionFilterFor({ kind: 'collection', id: 'picks' }, { ...DEFAULT_FILMSTRIP, minRating: 2 })).toEqual({
      flag: 'picks',
      minRating: 2,
      query: '',
    });
    expect(collectionFilterFor({ kind: 'collection', id: 'edited' }, DEFAULT_FILMSTRIP)).toMatchObject({
      edited: true,
    });
    expect(collectionFilterFor({ kind: 'collection', id: 'needs-denoise' }, DEFAULT_FILMSTRIP)).toMatchObject({
      iso: 3200,
    });
    const saved = { folders: [G], flag: 'picks' as const, minRating: 4, query: 'rome' };
    expect(
      collectionFilterFor(
        { kind: 'saved', id: 'S', filter: saved },
        { ...DEFAULT_FILMSTRIP, minRating: 2, minIso: 800 },
      ),
    ).toEqual({ folders: [G], flag: 'picks', minRating: 4, query: 'rome', iso: 800 });
  });

  it('saves both conditions at once: the stricter flag, every search word, nothing when they cannot both hold', () => {
    const saved: LibrarySource = { kind: 'saved', id: 'S', filter: { flag: 'picks', minRating: 0, query: 'rome' } };
    expect(collectionFilterFor(saved, { ...DEFAULT_FILMSTRIP, flag: 'no-rejects', query: '2' })).toEqual({
      flag: 'picks',
      minRating: 0,
      query: 'rome 2',
    });
    expect(collectionFilterFor(saved, { ...DEFAULT_FILMSTRIP, flag: 'rejects' })).toBeNull();
    expect(
      collectionFilterFor({ kind: 'collection', id: 'picks' }, { ...DEFAULT_FILMSTRIP, flag: 'rejects' }),
    ).toBeNull();
    const rejectsOnly: LibrarySource = {
      kind: 'saved',
      id: 'S',
      filter: { flag: 'no-rejects', minRating: 0, query: '' },
    };
    expect(collectionFilterFor(rejectsOnly, { ...DEFAULT_FILMSTRIP, flag: 'rejects' })).toBeNull();
    expect(collectionFilterFor(rejectsOnly, { ...DEFAULT_FILMSTRIP, flag: 'picks' })?.flag).toBe('picks');
    expect(collectionFilterFor(saved, { ...DEFAULT_FILMSTRIP, query: 'ROME' })?.query).toBe('rome');
  });

  it('the saved filter shows exactly what the view showed', () => {
    const saved: LibrarySource = { kind: 'saved', id: 'S', filter: { flag: 'picks', minRating: 0, query: 'rome' } };
    const view = { ...DEFAULT_FILMSTRIP, query: '2' };
    const shown = keys(saved, view);
    expect(shown).toEqual([k(G, 'rome2.jpg')]);
    const filter = collectionFilterFor(saved, view);
    if (!filter) throw new Error('no filter');
    expect(keys({ kind: 'saved', id: 'T', filter })).toEqual(shown);
  });
});

describe('saved collection sources', () => {
  it('match their filter over their folders, or every folder', () => {
    const everywhere = { flag: 'picks' as const, minRating: 0, query: 'rome' };
    expect(keys({ kind: 'saved', id: 'S', filter: everywhere })).toEqual([k(F, 'rome.jpg'), k(G, 'rome2.jpg')]);
    expect(keys({ kind: 'saved', id: 'S', filter: { ...everywhere, folders: [G] } })).toEqual([k(G, 'rome2.jpg')]);
    expect(keys({ kind: 'saved', id: 'S', filter: { flag: 'all', minRating: 0, query: '', iso: 3200 } })).toEqual([
      k(F, 'a.jpg'),
    ]);
    expect(
      keys({ kind: 'saved', id: 'S', filter: { flag: 'all', minRating: 0, query: '', dateRange: [2, 4] } }),
    ).toEqual([k(F, 'b.jpg'), k(F, 'rome.jpg'), k(G, 'c.jpg')]);
    // A folder that is gone contributes nothing.
    expect(
      sourceItems({ kind: 'saved', id: 'S', filter: { ...everywhere, folders: ['X'] } }, folders, libraries),
    ).toEqual([]);
  });

  it('the view filters narrow a folder: Edited and ISO', () => {
    expect(keys({ kind: 'folder', id: F }, { ...DEFAULT_FILMSTRIP, minIso: 3200 })).toEqual([k(F, 'a.jpg')]);
    expect(keys({ kind: 'folder', id: F }, { ...DEFAULT_FILMSTRIP, edited: true })).toEqual([]);
  });
});

describe('useCollectionsStore', () => {
  it('a saved collection reopens with the same filter after a restart', async () => {
    const view = { ...DEFAULT_FILMSTRIP, flag: 'picks' as const, minRating: 2 };
    const before = keys({ kind: 'folder', id: F }, view);
    const filter = collectionFilterFor({ kind: 'folder', id: F }, view);
    if (!filter) throw new Error('no filter');
    const created = await useCollectionsStore.getState().create('  Trip picks ', filter);
    expect(created.name).toBe('Trip picks');

    // Restart: nothing in memory, the file read again.
    useCollectionsStore.getState().reset();
    expect(savedCollection(created.id)).toBeUndefined();
    await useCollectionsStore.getState().load();
    const again = savedCollection(created.id);
    expect(again).toEqual(created);
    if (!again) throw new Error('not reloaded');
    expect(keys({ kind: 'saved', id: again.id, filter: again.filter })).toEqual(before);
  });

  it('renames and deletes, and puts the list back when a write fails', async () => {
    const store = () => useCollectionsStore.getState();
    const one = await store().create('One', { flag: 'all', minRating: 0, query: '' });
    const two = await store().create('Two', { flag: 'picks', minRating: 0, query: '' });
    await store().rename(one.id, 'First');
    await store().remove(two.id);
    expect(JSON.parse(disk.text ?? '[]')).toEqual([{ ...one, name: 'First' }]);

    disk.fail = true;
    await expect(store().remove(one.id)).rejects.toBe('disk full');
    expect(store().saved.map((c) => c.name)).toEqual(['First']);
  });

  it('lists only entries it understands, and writes every entry back as it was read', async () => {
    const store = () => useCollectionsStore.getState();
    const A = '01K7A000000000000000000000';
    const B = '01K7B000000000000000000000';
    const newer = {
      id: A,
      name: 'Newer',
      filter: { flag: 'picks', minRating: 0, query: '', future: 1 },
      colour: 'red',
    };
    const unknownFlag = { id: B, name: 'Maybe', filter: { flag: 'maybe' } };
    disk.text = JSON.stringify([newer, unknownFlag]);
    await store().load();
    expect(store().saved.map((c) => c.name)).toEqual(['Newer']);

    await store().rename(A, 'Renamed');
    const one = await store().create('One', { flag: 'all', minRating: 0, query: '' });
    expect(JSON.parse(disk.text ?? '[]')).toEqual([{ ...newer, name: 'Renamed' }, unknownFlag, one]);
    await store().remove(one.id);
    expect(JSON.parse(disk.text ?? '[]')).toEqual([{ ...newer, name: 'Renamed' }, unknownFlag]);
  });

  it('refuses to write over a file it could not read', async () => {
    disk.readFails = true;
    await useCollectionsStore.getState().load();
    expect(useCollectionsStore.getState()).toMatchObject({ saved: [], loaded: true });
    await expect(
      useCollectionsStore.getState().create('One', { flag: 'all', minRating: 0, query: '' }),
    ).rejects.toThrow(/could not be read/);
    expect(disk.text).toBeNull();
  });
});

describe('Needs denoise (plan 23)', () => {
  it('uses the measured noise when there is one, the ISO otherwise', () => {
    // σ / 0.18 of 0.35 % suggests 0, 2.3 % about 60 (lib/denoise.ts).
    expect(needsDenoise({ iso: 6400 })).toBe(true);
    expect(needsDenoise({ iso: 1600 })).toBe(false);
    expect(needsDenoise({ iso: 6400, noise: 0.0035 * 0.18 })).toBe(false);
    expect(needsDenoise({ iso: 200, noise: 0.023 * 0.18 })).toBe(true);
    expect(needsDenoise({ noise: 0.023 * 0.18 })).toBe(true);
    expect(needsDenoise({})).toBe(false);
    // A RAW reads on its own scale: 2.3 % is ordinary for a RAW decode.
    expect(needsDenoise({ kind: 'raw', noise: 0.023 * 0.18 })).toBe(false);
    expect(needsDenoise({ kind: 'raw', noise: 0.05 * 0.18 })).toBe(true);
  });

  it('lists the photos that need it, and is offered once an ISO or a noise is known', () => {
    expect(keys({ kind: 'collection', id: 'needs-denoise' })).toEqual([k(F, 'a.jpg')]);
    const measured = {
      ...folders,
      [G]: folder(G, '/home', [{ ...photo('c.jpg', 4), noise: 0.03 * 0.18 }, photo('rome2.jpg', 5)]),
    };
    expect(libraryKeys({ kind: 'collection', id: 'needs-denoise' }, measured, libraries, DEFAULT_FILMSTRIP)).toEqual([
      k(F, 'a.jpg'),
      k(G, 'c.jpg'),
    ]);
    const unknown = { [G]: folder(G, '/home', [photo('c.jpg', 4)]) };
    expect(availableCollections(unknown).map((c) => c.id)).toEqual(['picks', 'edited']);
    const noiseOnly = { [G]: folder(G, '/home', [{ ...photo('c.jpg', 4), noise: 0.001 }]) };
    expect(availableCollections(noiseOnly).map((c) => c.id)).toContain('needs-denoise');
  });
});
