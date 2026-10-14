import {
  type Book,
  createEmptyBook,
  DEVELOP_DEFAULTS,
  type DevelopSettings,
  developHash,
  type OutputProfile,
  type PhotoElement,
} from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeResolver } from '../components/preview/resolve';
import type { AssetHashedEvent, DevelopRenderMeta, HashProgressEvent, ScannedFile } from '../lib/tauri';
import { currentDeveloped, developedKey, fileOfAsset, useAssetsStore } from './assets';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from './book';
import { assetDevelop, resolvedAssets, useLibraryStore } from './library';

/** A fake source folder behind the Tauri wrappers: scanned files and their hashes. */
const disk = vi.hoisted(() => ({
  files: [] as ScannedFile[],
  hashes: {} as Record<string, string>,
  /** Other imported folders: their files and hashes, and the registry (`listFolders`). */
  others: {} as Record<string, { files: ScannedFile[]; hashes: Record<string, string> }>,
  registry: [] as Array<{
    id: string;
    path: string;
    name: string;
    addedAt: number;
    lastSeen: number;
    missing: boolean;
  }>,
  /** `[folder, relPath]` of every prepare_asset call. */
  prepared: [] as Array<[string, string]>,
  libraries: {} as Record<string, string>,
  scans: 0,
  /** Folders whose index was written. */
  indexWrites: [] as string[],
  hashed: new Set<(e: AssetHashedEvent) => void>(),
  progress: new Set<(e: HashProgressEvent) => void>(),
  /** Settings passed to each `renderDevelopCached` call, in order. */
  renders: [] as Array<{
    folder: string;
    relPath: string;
    hash: string;
    settings: DevelopSettings;
    keep?: string[];
    profile?: OutputProfile;
  }>,
  /** When set, `renderDevelopCached` waits for it (to hold a render in flight). */
  gate: null as Promise<void> | null,
  failRender: false,
}));

vi.mock('../lib/tauri', () => ({
  scanFolder: async (folder: string) => {
    disk.scans += 1;
    const other = disk.others[folder];
    return other ? other.files : disk.files;
  },
  hashFiles: async (folder: string, relPaths: string[], job: number) => {
    const hashes = disk.others[folder]?.hashes ?? disk.hashes;
    relPaths.forEach((relPath, i) => {
      const hash = hashes[relPath] ?? null;
      for (const fn of disk.hashed) fn({ job, relPath, hash, error: hash ? null : 'unreadable' });
      for (const fn of disk.progress) fn({ job, done: i + 1, total: relPaths.length });
    });
  },
  listFolders: async () => disk.registry,
  readIndex: async () => ({}),
  writeIndex: async (folder: string) => {
    disk.indexWrites.push(folder);
  },
  readLibrary: async (folder: string) => disk.libraries[folder] ?? null,
  prepareAsset: async (folder: string, relPath: string, hash: string) => ({
    ...(disk.prepared.push([folder, relPath]) ? {} : {}),
    width: 1200,
    height: 800,
    orientation: 1,
    thumbPath: `/cache/${hash}/thumb.jpg`,
    proxyPath: `/cache/${hash}/proxy.jpg`,
    isRaw: relPath.endsWith('.CR2'),
    ...(relPath.endsWith('.CR2') ? { asShot: [5450, 7] } : {}),
  }),
  onAssetHashed: async (fn: (e: AssetHashedEvent) => void) => {
    disk.hashed.add(fn);
    return () => disk.hashed.delete(fn);
  },
  onHashProgress: async (fn: (e: HashProgressEvent) => void) => {
    disk.progress.add(fn);
    return () => disk.progress.delete(fn);
  },
  renderDevelopCached: async (
    folder: string,
    relPath: string,
    hash: string,
    settings: DevelopSettings,
    keep?: string[],
    profile?: OutputProfile,
  ): Promise<DevelopRenderMeta> => {
    disk.renders.push({ folder, relPath, hash, settings, keep, profile });
    if (disk.gate) await disk.gate;
    if (disk.failRender) throw 'render failed';
    const dh = `dh${settings.light.exposure}`;
    // Like Rust: Display P3 files carry `-p3` after the develop hash, which itself stays the same.
    const name = `${dh}${profile === 'display-p3' ? '-p3' : ''}`;
    return {
      developHash: dh,
      width: profile === 'display-p3' ? 1601 : 1600,
      height: 1067,
      thumbPath: `/cache/${hash}/thumb-${name}.jpg`,
      proxyPath: `/cache/${hash}/proxy-${name}.jpg`,
    };
  },
  fileUrl: (path: string) => `asset://localhost${path}`,
}));

const FOLDER = '/photos';
const file = (relPath: string, size: number): ScannedFile => ({ relPath, size, mtimeMs: 1, kind: 'jpeg' });

/** Page 1 uses M (whose file is gone); N is a scanned, unused photo; U is unused and gone. */
function setup(): Book {
  const book = createEmptyBook({ title: 'Trip', folders: { F: { path: FOLDER } } });
  book.assets = {
    M: { path: 'old/m.jpg', folder: 'F', hash: 'hm', size: 5 },
    N: { path: 'n.jpg', folder: 'F', hash: 'hn', size: 7, mtime: 1 },
    U: { path: 'gone-unused.jpg', folder: 'F', hash: 'hu', size: 9 },
  };
  // New pages are blank: give page 1 one full-page slot holding M.
  const slot: PhotoElement = {
    type: 'photo',
    id: 'slot-m',
    asset: 'M',
    frame: { x: 0, y: 0, w: 1, h: 1 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none',
  };
  book.pages[0]?.elements.push(slot);
  disk.files = [file('n.jpg', 7)];
  disk.hashes = { 'n.jpg': 'hn' };
  useBookStore.setState({ book, folder: FOLDER });
  useBookStore.temporal.getState().clear();
  return book;
}

const assets = () => useAssetsStore.getState();

/** Put the RAW `r.CR2` into the project as asset R (photos join a project explicitly since plan 05). */
function addRaw() {
  useBookStore.setState((s) => {
    if (s.book) s.book.assets.R = { path: 'r.CR2', folder: 'F' };
  });
}
const bookAssets = () => useBookStore.getState().book?.assets ?? {};

beforeEach(() => {
  disk.scans = 0;
  disk.indexWrites = [];
  disk.others = {};
  disk.registry = [];
  disk.prepared = [];
  disk.libraries = {};
  disk.renders = [];
  disk.gate = null;
  disk.failRender = false;
  setup();
});
afterEach(async () => {
  await useBookStore.getState().close();
  assets().reset();
  useLibraryStore.getState().reset();
});

describe('assets scan', () => {
  it('marks only used vanished assets missing and drops unused ones from the book', async () => {
    await assets().scan(FOLDER);
    expect(Object.keys(assets().missing)).toEqual(['M']);
    expect(bookAssets().U).toBeUndefined();
    expect(bookAssets().N).toBeDefined();
    // Not an undo step.
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('does not scan again for the same folder unless forced', async () => {
    await assets().scan(FOLDER);
    await assets().scan(FOLDER);
    expect(disk.scans).toBe(1);
    await assets().scan(FOLDER, { force: true });
    expect(disk.scans).toBe(2);
  });
});

describe('relink across imported folders', () => {
  const PORTO = '/porto';
  const folderEntry = (id: string, path: string) => ({ id, path, name: path, addedAt: 1, lastSeen: 1, missing: false });

  beforeEach(() => {
    // M (on page 1) moved from /photos/old/m.jpg to /porto/moved/m.jpg; /porto holds another photo of the same size.
    disk.others[PORTO] = {
      files: [file('other.jpg', 5), file('moved/m.jpg', 5)],
      hashes: { 'other.jpg': 'hx', 'moved/m.jpg': 'hm' },
    };
    disk.registry = [folderEntry('F', FOLDER), folderEntry('G', PORTO)];
  });

  it('finds the photo by size then hash in another imported folder and keeps its id', async () => {
    useBookStore.setState((s) => {
      s.libraries[FOLDER] = { version: 1, photos: { hm: { rating: 4, develop: undefined, versions: {} } } };
    });
    await assets().scan(FOLDER);
    expect(assets().missing).toEqual({});
    const book = useBookStore.getState().book;
    expect(book?.assets.M).toMatchObject({ folder: 'G', path: 'moved/m.jpg', hash: 'hm', size: 5 });
    expect(book?.folders.G).toEqual({ path: PORTO });
    // The page still points at M, and the canvas resolves it from the file in /porto.
    expect((book?.pages[0]?.elements[0] as PhotoElement | undefined)?.asset).toBe('M');
    // /porto is scanned like the project's own folders, so the moved file shows.
    await vi.waitFor(() =>
      expect(fileOfAsset(assets().files, 'M')).toMatchObject({
        folder: PORTO,
        relPath: 'moved/m.jpg',
        status: 'ready',
      }),
    );
    expect(disk.prepared).toContainEqual([PORTO, 'moved/m.jpg']);
    expect(makeResolver(book?.assets, assets().files)('M', 800)?.src).toBe('asset://localhost/cache/hm/proxy.jpg');
    // Only the project's photo joins from /porto, never the rest of that folder.
    expect(Object.values(assets().files).some((f) => f.relPath === 'other.jpg')).toBe(false);
    // Its library entry came along into /porto's library (the CLI reads that one now).
    expect(useBookStore.getState().libraries[PORTO]?.photos.hm?.rating).toBe(4);
  });

  it('carries the edit along and keeps the moved photo on a rescan', async () => {
    useBookStore.setState((s) => {
      s.libraries[FOLDER] = { version: 1, photos: {} };
    });
    useBookStore.getState().setAssetDevelop('M', { light: { exposure: 0.5 } });
    useBookStore.temporal.getState().clear();
    await assets().scan(FOLDER);
    expect(assetDevelop(useBookStore.getState(), 'M')?.light.exposure).toBe(0.5);

    await vi.waitFor(() => expect(fileOfAsset(assets().files, 'M')?.status).toBe('ready'));
    const scans = disk.scans;
    await assets().scan(FOLDER, { force: true });
    expect(assets().missing).toEqual({});
    // Both folders of the project are scanned again; the file in /porto keeps its thumbnails (same bytes).
    expect(disk.scans).toBe(scans + 2);
    expect(fileOfAsset(assets().files, 'M')).toMatchObject({ folder: PORTO, status: 'ready' });
    expect(useBookStore.getState().book?.assets.M?.folder).toBe('G');
    // The edit renders from the file in /porto.
    await vi.waitFor(() => expect(fileOfAsset(assets().files, 'M')?.developed).toBeDefined());
    expect(disk.renders.at(-1)).toMatchObject({ folder: PORTO, relPath: 'moved/m.jpg', hash: 'hm' });
  });

  it('stays missing when no imported folder has the bytes', async () => {
    disk.others[PORTO] = { files: [file('other.jpg', 5)], hashes: { 'other.jpg': 'hx' } };
    await assets().scan(FOLDER);
    expect(Object.keys(assets().missing)).toEqual(['M']);
    expect(useBookStore.getState().book?.assets.M).toMatchObject({ folder: 'F', path: 'old/m.jpg' });
    expect(useBookStore.getState().book?.folders.G).toBeUndefined();
  });
});

describe('assets relink (Locate)', () => {
  it('takes over a scanned file held by an unused asset id', async () => {
    await assets().scan(FOLDER);
    expect(assets().files['n.jpg']?.assetId).toBe('N');

    await assets().relink('M', 'n.jpg');
    expect(assets().busy).toBe(false);
    expect(assets().missing).toEqual({});
    expect(assets().files['n.jpg']).toMatchObject({ assetId: 'M', status: 'ready', hash: 'hn' });
    expect(bookAssets().N).toBeUndefined();
    // The new file's hash and size, never the old file's.
    expect(bookAssets().M).toMatchObject({ path: 'n.jpg', hash: 'hn', size: 7, width: 1200, height: 800 });
    const slot = useBookStore.getState().book?.pages[0]?.elements[0] as PhotoElement | undefined;
    expect(slot?.asset).toBe('M');
  });

  it('refuses a file whose asset is used on a page', async () => {
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    const bgPage: Book['pages'][number] = {
      id: 'p2',
      layout: 'single-full',
      background: { asset: 'N' },
      elements: [],
      guides: [],
    };
    useBookStore.setState({ book: { ...book, pages: [...book.pages, bgPage] } });
    await assets().scan(FOLDER);
    await expect(assets().relink('M', 'n.jpg')).rejects.toThrow(/already on a page/);
    expect(assets().missing.M).toBeDefined();
    expect(bookAssets().N).toBeDefined();
  });
});

describe('develop renders', () => {
  const develop = (exposure: number) => ({ version: 1, light: { exposure } }) as DevelopSettings;
  const nFile = () => assets().files['n.jpg'];
  const withDevelop = (exposure: number) => {
    const book = useBookStore.getState().book;
    if (!book?.assets.N) throw new Error('no book');
    const N = { ...book.assets.N, develop: develop(exposure) };
    useBookStore.setState({ book: { ...book, assets: { ...book.assets, N } } });
  };

  it('renders an edited asset after prepare, so a reopened book finds its developed files', async () => {
    withDevelop(1);
    await assets().scan(FOLDER);
    await vi.waitFor(() => expect(nFile()?.developed).toBeDefined());
    expect(disk.renders).toHaveLength(1);
    expect(disk.renders[0]).toMatchObject({ relPath: 'n.jpg', hash: 'hn' });
    expect(nFile()).toMatchObject({ rendering: false });
    expect(Object.values(nFile()?.developed ?? {})).toMatchObject([
      { developHash: 'dh1', thumbUrl: 'asset://localhost/cache/hn/thumb-dh1.jpg', width: 1600 },
    ]);
    const resolve = makeResolver(bookAssets(), assets().files, 'proxy');
    expect(resolve('N', 800)).toEqual({ src: 'asset://localhost/cache/hn/proxy-dh1.jpg', width: 1600, height: 1067 });
    expect(makeResolver(bookAssets(), assets().files, 'thumb')('N', 800)?.src).toBe(
      'asset://localhost/cache/hn/thumb-dh1.jpg',
    );
  });

  it('does not render unedited assets and resolves them to the source', async () => {
    await assets().scan(FOLDER);
    await assets().renderDeveloped('N');
    expect(disk.renders).toHaveLength(0);
    expect(makeResolver(bookAssets(), assets().files)('N', 800)).toEqual({
      src: 'asset://localhost/cache/hn/proxy.jpg',
      width: 1200,
      height: 800,
    });
  });

  it('falls back to the source while settings are newer than the render, and clears on reset', async () => {
    withDevelop(1);
    await assets().scan(FOLDER);
    await vi.waitFor(() => expect(nFile()?.developed).toBeDefined());
    withDevelop(2);
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')).toBeUndefined();
    expect(makeResolver(bookAssets(), assets().files)('N', 800)?.src).toBe('asset://localhost/cache/hn/proxy.jpg');
    await assets().renderDeveloped('N');
    expect(makeResolver(bookAssets(), assets().files)('N', 800)?.src).toBe('asset://localhost/cache/hn/proxy-dh2.jpg');

    // A reset shows the source again; the renders stay for undoing it.
    useBookStore.getState().resetAssetDevelop('N');
    await assets().renderDeveloped('N');
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')).toBeUndefined();
    expect(makeResolver(bookAssets(), assets().files)('N', 800)?.src).toBe('asset://localhost/cache/hn/proxy.jpg');
    useBookStore.temporal.getState().undo();
    expect(makeResolver(bookAssets(), assets().files)('N', 800)?.src).toBe('asset://localhost/cache/hn/proxy-dh2.jpg');
  });

  it('shows the previous render at once after undo and redo, never the source in between', async () => {
    await assets().scan(FOLDER);
    const { setAssetDevelop } = useBookStore.getState();
    const src = () => makeResolver(bookAssets(), assets().files)('N', 800)?.src;
    setAssetDevelop('N', { light: { exposure: 1 } });
    await assets().renderDeveloped('N');
    setAssetDevelop('N', { light: { exposure: 2 } });
    await assets().renderDeveloped('N');
    expect(src()).toBe('asset://localhost/cache/hn/proxy-dh2.jpg');
    const renders = disk.renders.length;

    useBookStore.temporal.getState().undo();
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')?.developHash).toBe('dh1');
    expect(src()).toBe('asset://localhost/cache/hn/proxy-dh1.jpg');
    useBookStore.temporal.getState().redo();
    expect(src()).toBe('asset://localhost/cache/hn/proxy-dh2.jpg');
    // Settling finds both renders in the map: nothing is rendered again.
    await assets().renderDeveloped('N');
    expect(disk.renders).toHaveLength(renders);
  });

  it('remembers the last three renders per file, newest last', async () => {
    await assets().scan(FOLDER);
    for (const exposure of [1, 2, 3, 4]) {
      useBookStore.getState().setAssetDevelop('N', { light: { exposure } });
      await assets().renderDeveloped('N');
    }
    expect(Object.values(nFile()?.developed ?? {}).map((d) => d.developHash)).toEqual(['dh2', 'dh3', 'dh4']);
    useBookStore.temporal.getState().undo();
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')?.developHash).toBe('dh3');
    useBookStore.temporal.getState().undo();
    useBookStore.temporal.getState().undo();
    // Exposure 1 fell out of the map: the source shows until it is rendered again.
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')).toBeUndefined();
  });

  it('never evicts the render of the photo’s own edit while another version is edited (plan 08)', async () => {
    await assets().scan(FOLDER);
    const store = useBookStore.getState;
    store().setAssetDevelop('N', { light: { exposure: 1 } });
    await assets().renderDeveloped('N');
    const version = store().createVersion('N') ?? '';
    store().showVersion('N', version);
    for (const exposure of [2, 3, 4, 5]) {
      store().setAssetDevelop('N', { light: { exposure } });
      await assets().renderDeveloped('N');
    }
    // The project still uses the master: its render stays in the map beside the last three.
    expect(bookAssets().N?.version).toBeUndefined();
    const own = resolvedAssets(store())?.N?.develop;
    expect(own?.light.exposure).toBe(1);
    expect(currentDeveloped(nFile(), own, 'srgb')?.developHash).toBe('dh1');
    expect(Object.values(nFile()?.developed ?? {}).map((d) => d.developHash)).toEqual(['dh1', 'dh3', 'dh4', 'dh5']);
  });

  it('tells the cache which develop hashes other photos with the same bytes use', async () => {
    // D is a duplicate of N (same hash) with its own edits.
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    useBookStore.setState({
      book: {
        ...book,
        assets: {
          ...book.assets,
          D: { path: 'd.jpg', folder: 'F', hash: 'hn', size: 7, mtime: 1, develop: develop(5) },
        },
      },
    });
    disk.files = [file('n.jpg', 7), file('d.jpg', 7)];
    disk.hashes = { 'n.jpg': 'hn', 'd.jpg': 'hn' };
    await assets().scan(FOLDER);
    await assets().renderDeveloped('D');
    disk.renders = [];
    withDevelop(1);
    await assets().renderDeveloped('N');
    expect(disk.renders).toHaveLength(1);
    // D's current hash, the hash of its recorded render (the mock names it dh5) and N's own.
    const keep = [await developHash(develop(1)), await developHash(develop(5)), 'dh5'];
    expect([...(disk.renders[0]?.keep ?? [])].sort()).toEqual(keep.sort());
  });

  it('runs one render per asset at a time and reruns once with the newest settings', async () => {
    await assets().scan(FOLDER);
    let open = () => {};
    disk.gate = new Promise((resolve) => {
      open = resolve;
    });
    withDevelop(1);
    const first = assets().renderDeveloped('N');
    await vi.waitFor(() => expect(nFile()?.rendering).toBe(true));
    withDevelop(2);
    const second = assets().renderDeveloped('N');
    withDevelop(3);
    const third = assets().renderDeveloped('N');
    await vi.waitFor(() => expect(disk.renders).toHaveLength(1));
    open();
    await Promise.all([first, second, third]);
    expect(disk.renders.map((r) => r.settings.light.exposure)).toEqual([1, 3]);
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')?.developHash).toBe('dh3');
  });

  it('never rejects when the render fails', async () => {
    await assets().scan(FOLDER);
    disk.failRender = true;
    withDevelop(1);
    await expect(assets().renderDeveloped('N')).resolves.toBeUndefined();
    expect(nFile()).toMatchObject({ rendering: false });
    expect(nFile()?.developed).toBeUndefined();
  });

  it('does not render on the settle timer during a Develop drag; it runs once after the drag ends', async () => {
    await assets().scan(FOLDER);
    vi.useFakeTimers();
    try {
      beginDevelopDrag();
      useBookStore.getState().setAssetDevelop('N', { light: { exposure: 1 } });
      // Held still for longer than the settle time (and then some): no render may start mid-drag.
      await vi.advanceTimersByTimeAsync(1500);
      useBookStore.getState().setAssetDevelop('N', { light: { exposure: 2 } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(disk.renders).toHaveLength(0);
      expect(nFile()?.rendering).toBeFalsy();

      endDevelopDrag();
      await vi.advanceTimersByTimeAsync(800);
    } finally {
      vi.useRealTimers();
      endDevelopDrag();
    }
    await vi.waitFor(() => expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')?.developHash).toBe('dh2'));
    expect(disk.renders.map((r) => r.settings.light.exposure)).toEqual([2]);
  });

  it('renders after a develop change made outside the Develop view settles', async () => {
    await assets().scan(FOLDER);
    useBookStore.getState().setAssetDevelop('N', { light: { exposure: 1 } });
    await vi.waitFor(
      () => expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')?.developHash).toBe('dh1'),
      {
        timeout: 2000,
      },
    );
    expect(disk.renders).toHaveLength(1);
  });
});

describe('output profile', () => {
  const nFile = () => assets().files['n.jpg'];
  const proxy = (profile: OutputProfile) => makeResolver(bookAssets(), assets().files, 'proxy', profile)('N', 800)?.src;
  const edit = () => useBookStore.getState().setAssetDevelop('N', { light: { exposure: 1 } });

  it('keys the developed map by settings and profile', () => {
    const develop = { version: 1, light: { exposure: 1 } } as DevelopSettings;
    expect(developedKey(develop, 'srgb')).not.toBe(developedKey(develop, 'display-p3'));
    expect(developedKey(develop, 'display-p3')).toBe(`${developedKey(develop, 'srgb')}-p3`);
  });

  it('renders in the default sRGB profile and passes it to the render command', async () => {
    await assets().scan(FOLDER);
    edit();
    await assets().renderDeveloped('N');
    expect(disk.renders.map((r) => r.profile)).toEqual(['srgb']);
  });

  it('renders in the book profile and never serves a render made in the other profile', async () => {
    useBookStore.getState().setOutputProfile('display-p3');
    await assets().scan(FOLDER);
    edit();
    await assets().renderDeveloped('N');
    expect(disk.renders.map((r) => r.profile)).toEqual(['display-p3']);
    expect(Object.keys(nFile()?.developed ?? {})[0]).toMatch(/-p3$/);
    expect(proxy('display-p3')).toBe('asset://localhost/cache/hn/proxy-dh1-p3.jpg');
    // The same files resolved for an sRGB book fall back to the source: a P3 proxy is never shown as sRGB.
    expect(proxy('srgb')).toBe('asset://localhost/cache/hn/proxy.jpg');
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'srgb')).toBeUndefined();
    expect(currentDeveloped(nFile(), bookAssets().N?.develop, 'display-p3')?.developHash).toBe('dh1');
  });

  it('re-renders edited photos when the book profile changes, and finds the earlier profile again', async () => {
    await assets().scan(FOLDER);
    edit();
    await assets().renderDeveloped('N');
    expect(proxy('srgb')).toBe('asset://localhost/cache/hn/proxy-dh1.jpg');

    useBookStore.getState().setOutputProfile('display-p3');
    // Until the P3 render lands the resolver shows the source, not the sRGB render.
    expect(proxy('display-p3')).toBe('asset://localhost/cache/hn/proxy.jpg');
    await vi.waitFor(() => expect(disk.renders.map((r) => r.profile)).toEqual(['srgb', 'display-p3']), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(proxy('display-p3')).toBe('asset://localhost/cache/hn/proxy-dh1-p3.jpg'));
    expect(Object.values(nFile()?.developed ?? {}).map((d) => d.width)).toEqual([1600, 1601]);

    // Back to sRGB: that render is still remembered, so nothing is rendered again.
    useBookStore.getState().setOutputProfile('srgb');
    expect(proxy('srgb')).toBe('asset://localhost/cache/hn/proxy-dh1.jpg');
    await assets().renderDeveloped('N');
    expect(disk.renders).toHaveLength(2);
  });

  it('does not render unedited photos when the profile changes', async () => {
    await assets().scan(FOLDER);
    useBookStore.getState().setOutputProfile('display-p3');
    await new Promise((r) => setTimeout(r, 600));
    expect(disk.renders).toHaveLength(0);
  });

  it('renders a RAW base again in the new profile, then its edit', async () => {
    disk.files = [{ relPath: 'r.CR2', size: 11, mtimeMs: 1, kind: 'raw' }];
    disk.hashes = { 'r.CR2': 'hr' };
    addRaw();
    await assets().scan(FOLDER);
    const raw = () => assets().files['r.CR2'];
    await vi.waitFor(() => expect(raw()?.proxyUrl).toBe('asset://localhost/cache/hr/proxy-dh0.jpg'));
    useBookStore.getState().setOutputProfile('display-p3');
    await vi.waitFor(() => expect(raw()?.proxyUrl).toBe('asset://localhost/cache/hr/proxy-dh0-p3.jpg'));
    expect(disk.renders.map((r) => r.profile)).toEqual(['srgb', 'display-p3']);
    expect(disk.renders[1]?.settings).toEqual(DEVELOP_DEFAULTS);
    useBookStore.getState().setOutputProfile('srgb');
    await vi.waitFor(() => expect(raw()?.proxyUrl).toBe('asset://localhost/cache/hr/proxy-dh0.jpg'));
  });

  it('records a render only for the profile it was made in when the profile changes mid-render', async () => {
    await assets().scan(FOLDER);
    let open = () => {};
    disk.gate = new Promise((resolve) => {
      open = resolve;
    });
    edit();
    const run = assets().renderDeveloped('N');
    await vi.waitFor(() => expect(disk.renders).toHaveLength(1));
    useBookStore.getState().setOutputProfile('display-p3');
    open();
    await run;
    await vi.waitFor(() => expect(disk.renders.map((r) => r.profile)).toEqual(['srgb', 'display-p3']), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(proxy('display-p3')).toBe('asset://localhost/cache/hn/proxy-dh1-p3.jpg'));
    expect(proxy('srgb')).toBe('asset://localhost/cache/hn/proxy-dh1.jpg');
  });
});

describe('camera RAW', () => {
  const rawFile = () => assets().files['r.CR2'];

  beforeEach(() => {
    disk.files = [file('n.jpg', 7), { relPath: 'r.CR2', size: 11, mtimeMs: 1, kind: 'raw' }];
    disk.hashes = { 'n.jpg': 'hn', 'r.CR2': 'hr' };
    addRaw();
  });

  it('swaps the embedded preview for the default develop render, and keeps that render from pruning', async () => {
    await assets().scan(FOLDER);
    await vi.waitFor(() => expect(rawFile()?.proxyUrl).toBe('asset://localhost/cache/hr/proxy-dh0.jpg'));
    expect(rawFile()).toMatchObject({
      isRaw: true,
      asShot: [5450, 7],
      kind: 'raw',
      thumbUrl: 'asset://localhost/cache/hr/thumb-dh0.jpg',
    });
    // Only the RAW is rendered, with the defaults, and its default hash is protected.
    expect(disk.renders).toHaveLength(1);
    expect(disk.renders[0]).toMatchObject({ relPath: 'r.CR2', hash: 'hr', settings: DEVELOP_DEFAULTS });
    expect(disk.renders[0]?.keep).toEqual([await developHash(DEVELOP_DEFAULTS)]);
    expect(assets().files['n.jpg']?.isRaw).toBe(false);
    // An unedited RAW resolves to that render (the canvas shows what publishes).
    const id = assets().files['r.CR2']?.assetId as string;
    expect(makeResolver(bookAssets(), assets().files)(id, 800)?.src).toBe('asset://localhost/cache/hr/proxy-dh0.jpg');
  });

  it('renders an edited RAW after its base render', async () => {
    await assets().scan(FOLDER);
    await vi.waitFor(() => expect(rawFile()?.proxyUrl).toContain('proxy-dh0'));
    const id = rawFile()?.assetId as string;
    useBookStore.getState().setAssetDevelop(id, { light: { exposure: 2 } });
    await assets().renderDeveloped(id);
    expect(disk.renders.map((r) => r.settings.light.exposure)).toEqual([0, 2]);
    expect(disk.renders[1]?.keep).toContain(await developHash(DEVELOP_DEFAULTS));
    expect(makeResolver(bookAssets(), assets().files)(id, 800)?.src).toBe('asset://localhost/cache/hr/proxy-dh2.jpg');
  });
});
