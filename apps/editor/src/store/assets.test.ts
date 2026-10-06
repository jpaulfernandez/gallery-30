import { type Book, createEmptyBook, type PhotoElement } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetHashedEvent, HashProgressEvent, ScannedFile } from '../lib/tauri';
import { useAssetsStore } from './assets';
import { useBookStore } from './book';

/** A fake source folder behind the Tauri wrappers: scanned files and their hashes. */
const disk = vi.hoisted(() => ({
  files: [] as ScannedFile[],
  hashes: {} as Record<string, string>,
  scans: 0,
  hashed: new Set<(e: AssetHashedEvent) => void>(),
  progress: new Set<(e: HashProgressEvent) => void>(),
}));

vi.mock('../lib/tauri', () => ({
  scanFolder: async () => {
    disk.scans += 1;
    return disk.files;
  },
  hashFiles: async (_folder: string, relPaths: string[], job: number) => {
    relPaths.forEach((relPath, i) => {
      const hash = disk.hashes[relPath] ?? null;
      for (const fn of disk.hashed) fn({ job, relPath, hash, error: hash ? null : 'unreadable' });
      for (const fn of disk.progress) fn({ job, done: i + 1, total: relPaths.length });
    });
  },
  prepareAsset: async (_folder: string, _relPath: string, hash: string) => ({
    width: 1200,
    height: 800,
    orientation: 1,
    thumbPath: `/cache/${hash}/thumb.jpg`,
    proxyPath: `/cache/${hash}/proxy.jpg`,
  }),
  onAssetHashed: async (fn: (e: AssetHashedEvent) => void) => {
    disk.hashed.add(fn);
    return () => disk.hashed.delete(fn);
  },
  onHashProgress: async (fn: (e: HashProgressEvent) => void) => {
    disk.progress.add(fn);
    return () => disk.progress.delete(fn);
  },
  fileUrl: (path: string) => `asset://localhost${path}`,
}));

const FOLDER = '/photos';
const file = (relPath: string, size: number): ScannedFile => ({ relPath, size, mtimeMs: 1, kind: 'jpeg' });

/** Page 1 uses M (whose file is gone); N is a scanned, unused photo; U is unused and gone. */
function setup(): Book {
  const book = createEmptyBook({ title: 'Trip', sourceFolder: FOLDER });
  book.assets = {
    M: { path: 'old/m.jpg', hash: 'hm', size: 5 },
    N: { path: 'n.jpg', hash: 'hn', size: 7, mtime: 1 },
    U: { path: 'gone-unused.jpg', hash: 'hu', size: 9 },
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
const bookAssets = () => useBookStore.getState().book?.assets ?? {};

beforeEach(() => {
  disk.scans = 0;
  setup();
});
afterEach(async () => {
  await useBookStore.getState().close();
  assets().reset();
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
    const bgPage: Book['pages'][number] = { id: 'p2', layout: 'single-full', background: { asset: 'N' }, elements: [] };
    useBookStore.setState({ book: { ...book, pages: [...book.pages, bgPage] } });
    await assets().scan(FOLDER);
    await expect(assets().relink('M', 'n.jpg')).rejects.toThrow(/already on a page/);
    expect(assets().missing.M).toBeDefined();
    expect(bookAssets().N).toBeDefined();
  });
});
