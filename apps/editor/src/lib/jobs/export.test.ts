import {
  BUILT_IN_EXPORT_PRESETS,
  createDevelop,
  DevelopSchema,
  type ExportPreset,
  ExportPresetSchema,
  emptyLibrary,
  presetHash,
} from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { resetJobs, useJobsStore } from '../../store/jobs';
import { type LibraryFolder, type PhotoFile, photoKey, useLibraryStore } from '../../store/library';

const mocks = vi.hoisted(() => ({
  exportPhoto: vi.fn(),
  exportStatus: vi.fn(),
  cancelDevelop: vi.fn(async () => {}),
  runDenoise: vi.fn(),
  cancelDenoise: vi.fn(async () => true),
  progress: null as null | ((e: { job: number; stage: string }) => void),
  unlisten: vi.fn(),
}));
vi.mock('../tauri', () => ({
  exportPhoto: mocks.exportPhoto,
  exportStatus: mocks.exportStatus,
  cancelDevelop: mocks.cancelDevelop,
  runDenoise: mocks.runDenoise,
  cancelDenoise: mocks.cancelDenoise,
  onExportProgress: async (handler: (e: { job: number; stage: string }) => void) => {
    mocks.progress = handler;
    return mocks.unlisten;
  },
  onDenoiseProgress: async () => () => {},
}));

const { enqueueExport, exportCounts, planExport, resolveExportPhotos } = await import('./export');
const { startExport, useExportsStore } = await import('../../store/exports');

const PATH = '/photos/lisbon';
const F = 'F1';
const hashOf = (name: string) => name.charCodeAt(0).toString(16).padStart(64, '0');

function photo(relPath: string, mtime: number): PhotoFile {
  return { relPath, size: 1, mtime, kind: 'jpeg', hash: hashOf(relPath), status: 'ready' };
}

function seed(names: string[]): string[] {
  const folder: LibraryFolder = {
    id: F,
    path: PATH,
    photos: Object.fromEntries(names.map((n, i) => [n, photo(n, new Date(2026, 9, 3 + i).getTime())])),
    progress: { hashed: 0, prepared: 0, total: 0 },
    busy: false,
    error: null,
    scanned: true,
  };
  useLibraryStore.setState({ folders: { [F]: folder } });
  return names.map((n) => photoKey({ folder: F, path: n }));
}

const preset = (over: Partial<ExportPreset> = {}): ExportPreset =>
  ExportPresetSchema.parse({ ...BUILT_IN_EXPORT_PRESETS[0], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.progress = null;
  const library = emptyLibrary();
  library.photos[hashOf('b.jpg')] = {
    rating: 4,
    develop: DevelopSchema.parse({ version: 1, light: { exposure: 0.5 } }),
    versions: {},
  };
  useBookStore.setState({ book: null, folder: null, libraries: { [PATH]: library }, developVersion: null });
  useExportsStore.setState({ runs: [], dialog: null });
});

describe('planning an export', () => {
  it('resolves library photos with their edit, rating and date, and names them with the tokens', async () => {
    const ids = seed(['a.jpg', 'b.jpg', 'sub/a.jpg']);
    const { photos, missing } = await resolveExportPhotos([...ids, `${F}/unknown.jpg`]);
    expect(missing).toBe(1);
    expect(photos.map((p) => [p.relPath, p.rating, p.settings.light.exposure])).toEqual([
      ['a.jpg', 0, 0],
      ['b.jpg', 4, 0.5],
      ['sub/a.jpg', 0, 0],
    ]);
    const planned = await planExport(photos, preset({ naming: '{name}' }));
    expect(planned.map((p) => [p.item.destDir, p.item.name])).toEqual([
      [`${PATH}/Exports/Social`, 'a.jpg'],
      [`${PATH}/Exports/Social`, 'b.jpg'],
      // Two sources named a.jpg land in one folder: the second is numbered.
      [`${PATH}/Exports/Social`, 'a 2.jpg'],
    ]);
    const dated = await planExport(photos, preset({ naming: '{date}-{seq}-{rating}', destination: '/out' }));
    expect(dated.map((p) => p.item.name)).toEqual([
      '2026-10-03-001-0.jpg',
      '2026-10-04-002-4.jpg',
      '2026-10-05-003-0.jpg',
    ]);
    expect(dated.every((p) => p.item.destDir === '/out')).toBe(true);
    expect(planned[1]?.developHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned[0]?.developHash).not.toBe(planned[1]?.developHash);
  });

  it('counts what is cached and already exported', async () => {
    const ids = seed(['a.jpg', 'b.jpg', 'c.jpg']);
    const { photos } = await resolveExportPhotos(ids);
    const p = preset();
    const planned = await planExport(photos, p);
    mocks.exportStatus.mockResolvedValue([
      { cached: true, exported: true, replaces: false },
      { cached: true, exported: false, replaces: false },
      { cached: false, exported: false, replaces: true },
    ]);
    expect(await exportCounts(planned, p)).toEqual({ total: 3, cached: 2, exported: 1, replaces: 1 });
    const [items, hash, format] = mocks.exportStatus.mock.calls[0] ?? [];
    expect(hash).toBe(await presetHash(p.options));
    expect(format).toBe('jpeg');
    expect(items[0]).toEqual({
      folder: PATH,
      relPath: 'a.jpg',
      hash: hashOf('a.jpg'),
      developHash: planned[0]?.developHash,
      destDir: `${PATH}/Exports/Social`,
      name: 'a.jpg',
    });
  });
});

describe('export jobs', () => {
  it('runs one export job per photo, two at a time, and counts the run for the toast', async () => {
    const ids = seed(['a.jpg', 'b.jpg', 'c.jpg']);
    const pending: Array<(r: unknown) => void> = [];
    mocks.exportPhoto.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const done = startExport(ids, preset());
    await vi.waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(2));
    const jobs = Object.values(useJobsStore.getState().jobs);
    expect(jobs.map((j) => [j.kind, j.label, j.state])).toEqual([
      ['export', 'a.jpg', 'running'],
      ['export', 'b.jpg', 'running'],
      ['export', 'c.jpg', 'queued'],
    ]);
    const [item, options, hash, skip] = mocks.exportPhoto.mock.calls[0] ?? [];
    expect(item).toMatchObject({ folder: PATH, relPath: 'a.jpg', name: 'a.jpg', destDir: `${PATH}/Exports/Social` });
    expect(options).toEqual(preset().options);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(skip).toBe(true);
    pending[0]?.({ path: `${PATH}/Exports/Social/a.jpg`, bytes: 10, encoded: true, skipped: false });
    pending[1]?.({ path: `${PATH}/Exports/Social/b.jpg`, bytes: 10, encoded: false, skipped: true });
    await vi.waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(3));
    pending[2]?.({ path: `${PATH}/Exports/Social/c.jpg`, bytes: 10, encoded: false, skipped: false });
    const run = await done;
    expect(run).toMatchObject({ total: 3, encoded: 1, skipped: 1, copied: 1, failed: 0, over: true });
    expect(useExportsStore.getState().runs.at(-1)?.paths).toHaveLength(3);
  });

  it('joins an equal export already queued and keeps each run for its toast', async () => {
    const ids = seed(['a.jpg', 'b.jpg']);
    const pending: Array<(r: unknown) => void> = [];
    mocks.exportPhoto.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const first = startExport(ids, preset());
    await vi.waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(2));
    // A second click on Export: the same files to the same place.
    const second = startExport(ids, preset(), { replace: true });
    await vi.waitFor(() => expect(useExportsStore.getState().runs).toHaveLength(2));
    expect(Object.keys(useJobsStore.getState().jobs)).toHaveLength(2);
    for (const resolve of pending) resolve({ path: '/x.jpg', bytes: 1, encoded: true, skipped: false });
    const [a, b] = await Promise.all([first, second]);
    expect(mocks.exportPhoto).toHaveBeenCalledTimes(2);
    expect([a.encoded, b.encoded]).toEqual([2, 2]);
    expect(useExportsStore.getState().runs.map((r) => r.over)).toEqual([true, true]);
    useExportsStore.getState().dismissRun(a.id);
    expect(useExportsStore.getState().runs.map((r) => r.id)).toEqual([b.id]);
  });

  it('reports the stages and cancels through cancelDevelop', async () => {
    const ids = seed(['a.jpg']);
    const { photos } = await resolveExportPhotos(ids);
    const [planned] = await planExport(photos, preset());
    if (!planned) throw new Error('planned');
    let reject: (err: unknown) => void = () => {};
    mocks.exportPhoto.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const handle = enqueueExport({ planned, exportOptions: preset().options, presetHash: 'x', skipExported: true });
    await vi.waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalled());
    const job = mocks.exportPhoto.mock.calls[0]?.[5] as number;
    mocks.progress?.({ job, stage: 'render' });
    expect(useJobsStore.getState().jobs[handle.id]).toMatchObject({ done: 1, total: 3, detail: 'developing' });
    useJobsStore.getState().cancel(handle.id);
    expect(mocks.cancelDevelop).toHaveBeenCalledWith(job);
    reject('Cancelled');
    expect((await handle.result).state).toBe('cancelled');
    expect(mocks.unlisten).toHaveBeenCalled();
  });

  it('waits for the denoise of a photo with denoise on, and fails with it', async () => {
    const ids = seed(['a.jpg']);
    const { photos } = await resolveExportPhotos(ids);
    const first = photos[0];
    if (!first) throw new Error('photo');
    const settings = createDevelop();
    settings.detail.denoise = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' };
    const [planned] = await planExport([{ ...first, settings }], preset());
    if (!planned) throw new Error('planned');
    mocks.runDenoise.mockResolvedValue({
      status: 'missingModel',
      model: { name: 'nafnet-w32', bytes: 1, installed: false },
    });
    const handle = enqueueExport({ planned, exportOptions: preset().options, presetHash: 'x', skipExported: false });
    const outcome = await handle.result;
    expect(outcome.state).toBe('failed');
    expect(mocks.runDenoise).toHaveBeenCalled();
    expect(mocks.exportPhoto).not.toHaveBeenCalled();

    mocks.runDenoise.mockResolvedValue({ status: 'done', key: 'k', path: '/p', width: 1, height: 1 });
    mocks.exportPhoto.mockResolvedValue({ path: '/x.jpg', bytes: 1, encoded: true, skipped: false });
    const again = enqueueExport({ planned, exportOptions: preset().options, presetHash: 'x', skipExported: false });
    expect((await again.result).state).toBe('done');
    expect(mocks.exportPhoto).toHaveBeenCalledTimes(1);
  });
});
