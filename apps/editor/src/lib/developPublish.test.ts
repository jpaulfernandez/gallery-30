import { type Book, createDevelop, DEVELOP_DEFAULTS, developHash } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usedAssetIds } from '../components/filmstrip/visible';
import { resetJobs, useJobsStore } from '../store/jobs';

const mocks = vi.hoisted(() => ({
  renderDevelopFull: vi.fn(),
  developRendersPresent: vi.fn(),
  pruneDevelopRenders: vi.fn(),
  cancelDevelop: vi.fn(async () => {}),
  progress: null as null | ((e: Record<string, unknown>) => void),
  unlisten: vi.fn(),
}));
vi.mock('./tauri', () => ({
  renderDevelopFull: mocks.renderDevelopFull,
  developRendersPresent: mocks.developRendersPresent,
  pruneDevelopRenders: mocks.pruneDevelopRenders,
  cancelDevelop: mocks.cancelDevelop,
  onDevelopProgress: async (handler: (e: Record<string, unknown>) => void) => {
    mocks.progress = handler;
    return mocks.unlisten;
  },
}));

const { developedTargets, pruneAfterPublish, renderBeforePublish } = await import('./developPublish');

/** The fixture book with two used photos edited (hashes `h-<id>`) and one unused photo edited too. */
function editedBook(): { book: Book; edited: string[]; unused: string } {
  const book = structuredClone(fixtureBook);
  const used = [...usedAssetIds(book.pages)];
  const edited = used.slice(0, 2);
  const unused = Object.keys(book.assets).find((id) => !used.includes(id)) as string;
  for (const id of [...edited, unused]) {
    const asset = book.assets[id] as Book['assets'][string];
    asset.hash = `${[...id].map((c) => c.charCodeAt(0).toString(16)).join('')}a`;
    const develop = createDevelop();
    develop.light.exposure = 0.5;
    asset.develop = develop;
  }
  // A used photo with default settings is not developed.
  const plain = book.assets[used[2] as string] as Book['assets'][string];
  plain.hash = 'abc';
  plain.develop = createDevelop();
  return { book, edited, unused };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.progress = null;
});

describe('developedTargets', () => {
  it('lists used photos with non-default develop settings, named <hash>-<developHash>.jpg', async () => {
    const { book, edited } = editedBook();
    const targets = await developedTargets(book);
    expect(targets.map((t) => t.assetId)).toEqual(edited);
    const dh = await developHash(book.assets[edited[0] as string]?.develop ?? createDevelop());
    expect(targets[0]?.name).toBe(`${book.assets[edited[0] as string]?.hash}-${dh}.jpg`);
    expect(targets[0]?.relPath).toBe(book.assets[edited[0] as string]?.path);
  });

  it('names the renders with -p3 for a Display P3 book', async () => {
    const { book, edited } = editedBook();
    book.outputProfile = 'display-p3';
    const targets = await developedTargets(book);
    const dh = await developHash(book.assets[edited[0] as string]?.develop ?? createDevelop());
    expect(targets[0]?.name).toBe(`${book.assets[edited[0] as string]?.hash}-${dh}-p3.jpg`);
    expect(targets.every((t) => t.name.endsWith('-p3.jpg'))).toBe(true);
  });

  it('always lists used RAW photos, with the default settings when unedited', async () => {
    const { book, edited } = editedBook();
    const used = [...usedAssetIds(book.pages)];
    const raw = used[2] as string; // has default settings: not developed as a JPEG
    const rawAsset = book.assets[raw] as Book['assets'][string];
    rawAsset.path = 'raw/IMG_0001.CR2';
    delete rawAsset.develop;
    const targets = await developedTargets(book);
    expect(targets.map((t) => t.assetId)).toEqual([...edited, raw]);
    const target = targets[2];
    expect(target?.settings).toEqual(DEVELOP_DEFAULTS);
    expect(target?.name).toBe(`abc-${await developHash(DEVELOP_DEFAULTS)}.jpg`);
    // Pruning after a publish keeps the RAW's default render.
    mocks.pruneDevelopRenders.mockResolvedValue(0);
    await pruneAfterPublish('/photos', book);
    expect(mocks.pruneDevelopRenders.mock.calls[0]?.[1]).toContain(target?.name);
  });

  it('refuses a photo that has no hash yet', async () => {
    const { book, edited } = editedBook();
    (book.assets[edited[0] as string] as Book['assets'][string]).hash = undefined;
    await expect(developedTargets(book)).rejects.toThrow(/not been hashed/);
  });
});

describe('renderBeforePublish', () => {
  const run = (book: Book, over: { signal?: AbortSignal; project?: string } = {}) => {
    const events: unknown[] = [];
    const promise = renderBeforePublish({ folder: '/photos', book, onEvent: (e) => events.push(e), ...over });
    return { events, promise };
  };
  /** Each call renders its one photo, reporting it on `develop:progress`. */
  const renderEach = () =>
    mocks.renderDevelopFull.mockImplementation(async (_folder, items: { assetId: string }[], job: number) => {
      items.forEach((item, i) => {
        mocks.progress?.({ job, assetId: item.assetId, done: i + 1, total: items.length, path: '/x.jpg' });
      });
      mocks.progress?.({ job: job + 999, assetId: 'other', done: 1, total: 1 }); // another job: ignored
      return items.map((item) => ({ assetId: item.assetId, path: '/x.jpg' }));
    });

  it('does nothing for a book without edited photos', async () => {
    const book = structuredClone(fixtureBook);
    const { events, promise } = run(book);
    await expect(promise).resolves.toBe('done');
    expect(events).toEqual([]);
    expect(mocks.developRendersPresent).not.toHaveBeenCalled();
  });

  it('renders only the missing files, one render job per photo, and reports progress', async () => {
    const { book, edited } = editedBook();
    const targets = await developedTargets(book);
    mocks.developRendersPresent.mockResolvedValue([targets[1]?.name]);
    renderEach();
    const { events, promise } = run(book, { project: 'P' });
    await expect(promise).resolves.toBe('done');
    expect(mocks.renderDevelopFull).toHaveBeenCalledTimes(1);
    const items = mocks.renderDevelopFull.mock.calls[0]?.[1] as { assetId: string }[];
    expect(items.map((i) => i.assetId)).toEqual([edited[0]]);
    expect(events).toMatchObject([
      { type: 'step', step: 'develop', status: 'start' },
      { type: 'progress', step: 'develop', done: 1, total: 1, detail: expect.stringMatching(/\.jpg$/) },
      { type: 'step', step: 'develop', status: 'done', detail: '1 rendered' },
    ]);
    expect(mocks.unlisten).toHaveBeenCalled();
    const jobs = Object.values(useJobsStore.getState().jobs);
    expect(jobs).toMatchObject([{ kind: 'render', ref: edited[0], project: 'P', state: 'done', done: 1, total: 1 }]);
  });

  it('checks for and renders -p3 files in the book profile for a Display P3 book', async () => {
    const { book } = editedBook();
    book.outputProfile = 'display-p3';
    const srgbNames = (await developedTargets({ ...book, outputProfile: 'srgb' })).map((t) => t.name);
    const p3Names = (await developedTargets(book)).map((t) => t.name);
    // Only the sRGB renders exist: they do not count for a P3 book.
    mocks.developRendersPresent.mockImplementation(async (_f: string, names: string[]) =>
      names.filter((n) => srgbNames.includes(n)),
    );
    renderEach();
    const { promise } = run(book);
    await expect(promise).resolves.toBe('done');
    expect(mocks.developRendersPresent.mock.calls[0]?.[1]).toEqual(p3Names);
    expect(mocks.renderDevelopFull).toHaveBeenCalledTimes(2);
    expect(mocks.renderDevelopFull.mock.calls.map((c) => c[3])).toEqual(['display-p3', 'display-p3']);
  });

  it('passes sRGB for a default book and skips when the -p3 files are present', async () => {
    const { book } = editedBook();
    mocks.developRendersPresent.mockResolvedValue([]);
    renderEach();
    await run(book).promise;
    expect(mocks.renderDevelopFull.mock.calls[0]?.[3]).toBe('srgb');

    mocks.renderDevelopFull.mockClear();
    book.outputProfile = 'display-p3';
    mocks.developRendersPresent.mockResolvedValue((await developedTargets(book)).map((t) => t.name));
    await expect(run(book).promise).resolves.toBe('done');
    expect(mocks.renderDevelopFull).not.toHaveBeenCalled();
  });

  it('skips the render call when every file is current', async () => {
    const { book } = editedBook();
    const targets = await developedTargets(book);
    mocks.developRendersPresent.mockResolvedValue(targets.map((t) => t.name));
    const { events, promise } = run(book);
    await expect(promise).resolves.toBe('done');
    expect(mocks.renderDevelopFull).not.toHaveBeenCalled();
    expect(events).toMatchObject([{ type: 'step', step: 'develop', status: 'done', detail: '2 up to date' }]);
  });

  it('aborts with the first error and never starts the rest', async () => {
    const { book } = editedBook();
    mocks.developRendersPresent.mockResolvedValue([]);
    mocks.renderDevelopFull.mockImplementation(async (_f, items: { assetId: string }[], job: number) => {
      mocks.progress?.({ job, assetId: items[0]?.assetId, done: 1, total: 1, error: 'cannot decode' });
      return [{ assetId: items[0]?.assetId, error: 'cannot decode' }];
    });
    const { promise } = run(book);
    await expect(promise).rejects.toThrow(/\.jpg: cannot decode/);
    expect(mocks.renderDevelopFull).toHaveBeenCalledTimes(1);
    expect(Object.values(useJobsStore.getState().jobs).map((j) => j.state)).toEqual(['failed', 'cancelled']);
  });

  it('a cancelled publish cancels the photo in flight and the queued ones never start', async () => {
    const { book } = editedBook();
    mocks.developRendersPresent.mockResolvedValue([]);
    let finish: (results: unknown) => void = () => {};
    mocks.renderDevelopFull.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const controller = new AbortController();
    const { events, promise } = run(book, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.renderDevelopFull).toHaveBeenCalledTimes(1));
    const [, items, job] = mocks.renderDevelopFull.mock.calls[0] as [string, { assetId: string }[], number];
    controller.abort();
    expect(mocks.cancelDevelop).toHaveBeenCalledWith(job);
    finish(items.map((i) => ({ assetId: i.assetId, error: 'Cancelled' })));
    await expect(promise).resolves.toBe('cancelled');
    expect(mocks.renderDevelopFull).toHaveBeenCalledTimes(1);
    expect(events).toMatchObject([{ type: 'step', step: 'develop', status: 'start' }]);
  });
});

describe('pruneAfterPublish', () => {
  it('keeps the current render of every edited photo in both profiles, used or not, and touches only its photos', async () => {
    const { book, edited, unused } = editedBook();
    mocks.pruneDevelopRenders.mockResolvedValue(3);
    await pruneAfterPublish('/photos', book);
    const [folder, keep, hashes] = mocks.pruneDevelopRenders.mock.calls[0] as [string, string[], string[]];
    expect(folder).toBe('/photos');
    expect(keep).toHaveLength(6);
    for (const id of [...edited, unused]) {
      const mine = keep.filter((n) => n.startsWith(`${book.assets[id]?.hash}-`));
      expect(mine).toHaveLength(2);
      expect(mine.filter((n) => n.endsWith('-p3.jpg'))).toHaveLength(1);
    }
    // Only the book's own photos (every hashed asset, edited or not) are pruned; other projects' photos are not.
    const own = Object.values(book.assets).flatMap((a) => (a.hash ? [a.hash] : []));
    expect([...hashes].sort()).toEqual([...new Set(own)].sort());
  });

  it('a Display P3 book keeps the sRGB renders too (another project on the folder may publish in sRGB)', async () => {
    const { book } = editedBook();
    book.outputProfile = 'display-p3';
    mocks.pruneDevelopRenders.mockResolvedValue(0);
    await pruneAfterPublish('/photos', book);
    const keep = mocks.pruneDevelopRenders.mock.calls[0]?.[1] as string[];
    expect(keep.filter((n) => n.endsWith('-p3.jpg'))).toHaveLength(3);
    expect(keep.filter((n) => !n.endsWith('-p3.jpg'))).toHaveLength(3);
  });

  it('keeps every edit the folder library holds for its photos: the master and each version (another project may use them)', async () => {
    const { book, edited } = editedBook();
    const id = edited[0] as string;
    const asset = book.assets[id] as Book['assets'][string];
    const hash = asset.hash as string;
    const master = createDevelop();
    master.light.exposure = -1;
    const v2 = createDevelop();
    v2.color.saturation = -100;
    // This book publishes its own settings; the library also holds a master and a v2 that a second project uses.
    const library = {
      version: 1 as const,
      photos: { [hash]: { develop: master, versions: { V2: { name: 'v2', develop: v2 } } } },
    };
    mocks.pruneDevelopRenders.mockResolvedValue(0);
    await pruneAfterPublish('/photos', book, { '/photos': library });
    const keep = mocks.pruneDevelopRenders.mock.calls[0]?.[1] as string[];
    for (const settings of [asset.develop ?? master, master, v2]) {
      const dh = await developHash(settings);
      expect(keep).toContain(`${hash}-${dh}.jpg`);
      expect(keep).toContain(`${hash}-${dh}-p3.jpg`);
    }
    expect(keep.filter((n) => n.startsWith(`${hash}-`))).toHaveLength(6);
  });

  it('prunes nothing in a folder where the book has no hashed photo, and swallows errors', async () => {
    const empty = structuredClone(fixtureBook);
    for (const asset of Object.values(empty.assets)) delete asset.hash;
    await pruneAfterPublish('/photos', empty);
    expect(mocks.pruneDevelopRenders).not.toHaveBeenCalled();
    mocks.pruneDevelopRenders.mockRejectedValue('nope');
    await expect(pruneAfterPublish('/photos', editedBook().book)).resolves.toBeUndefined();
  });
});

describe('photos in more than one folder', () => {
  /** `editedBook` with its second edited photo relinked into another folder, /porto. */
  function twoFolders() {
    const { book, edited, unused } = editedBook();
    book.folders.G = { path: '/porto' };
    (book.assets[edited[1] as string] as Book['assets'][string]).folder = 'G';
    return { book, edited, unused };
  }

  it('renders each photo into its own folder and prunes each folder for its own photos', async () => {
    const { book, edited } = twoFolders();
    mocks.developRendersPresent.mockResolvedValue([]);
    mocks.renderDevelopFull.mockImplementation(async (_folder, items: { assetId: string }[]) =>
      items.map((item) => ({ assetId: item.assetId, path: '/x.jpg' })),
    );
    const targets = await developedTargets(book, '/photos');
    expect(targets.map((t) => [t.assetId, t.folder])).toEqual([
      [edited[0], '/photos'],
      [edited[1], '/porto'],
    ]);
    await expect(renderBeforePublish({ folder: '/photos', book, onEvent: () => {} })).resolves.toBe('done');
    expect(mocks.developRendersPresent.mock.calls.map((c) => c[0])).toEqual(['/photos', '/porto']);
    const calls = mocks.renderDevelopFull.mock.calls.map((c) => [
      c[0],
      (c[1] as { assetId: string }[]).map((i) => i.assetId),
    ]);
    expect(calls).toEqual([
      ['/photos', [edited[0]]],
      ['/porto', [edited[1]]],
    ]);

    mocks.pruneDevelopRenders.mockResolvedValue(0);
    await pruneAfterPublish('/photos', book);
    const pruned = new Map(mocks.pruneDevelopRenders.mock.calls.map((c) => [c[0], c[1] as string[]]));
    expect([...pruned.keys()]).toEqual(['/photos', '/porto']);
    expect(pruned.get('/porto')).toHaveLength(2);
    expect(pruned.get('/porto')).toContain(targets[1]?.name);
    expect(pruned.get('/photos')).toHaveLength(4);
  });
});
