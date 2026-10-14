import {
  AI_DESCRIPTION_MAX,
  type AiUsage,
  type Book,
  createEmptyBook,
  emptyLibrary,
  fitLongEdge,
  imageTokens,
  type Library,
  type LibraryPhotoAi,
  parseLibrary,
  serializeLibrary,
} from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '../../store/ai';
import { startLibraryAutosave } from '../../store/autosave';
import { useBookStore } from '../../store/book';
import { resetJobs, useJobsStore } from '../../store/jobs';
import { type LibraryFolder, type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import type { AiImageRef, AiRequestOptions } from '../tauri';

const mocks = vi.hoisted(() => ({
  aiDescribe: vi.fn(),
  aiCancel: vi.fn(async () => true),
  readAiSettings: vi.fn(),
  readLibrary: vi.fn(async () => null),
  readLibraryBackup: vi.fn(async () => null),
}));
vi.mock('../tauri', () => ({
  aiDescribe: mocks.aiDescribe,
  aiCancel: mocks.aiCancel,
  readAiSettings: mocks.readAiSettings,
  readLibrary: mocks.readLibrary,
  readLibraryBackup: mocks.readLibraryBackup,
}));

const { estimateIndex, indexPhotos, INDEX_BATCH, planIndex, runIndex, upToDate } = await import('./aiIndex');

/** The lisbon fixture's 16 photos (`fixtures/lisbon-demo`), 1600 × 1067 proxies. */
const LISBON = Array.from({ length: 16 }, (_, i) => `IMG_${String(i + 1).padStart(2, '0')}.jpg`);
const PATH = '/photos/lisbon';
const PATH2 = '/photos/porto';
const F = 'F1';
const F2 = 'F2';
const hashOf = (name: string) =>
  [...name]
    .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(64, '0');

const photo = (relPath: string, hash = hashOf(relPath)): PhotoFile => ({
  relPath,
  size: 1,
  mtime: 0,
  kind: 'jpeg',
  hash,
  width: 1600,
  height: 1067,
  status: 'ready',
});

function folder(id: string, path: string, names: string[], hash?: (n: string) => string): LibraryFolder {
  return {
    id,
    path,
    photos: Object.fromEntries(names.map((n) => [n, photo(n, hash?.(n))])),
    progress: { hashed: 0, prepared: 0, total: 0 },
    busy: false,
    error: null,
    scanned: true,
  };
}

const keys = (id: string, names: string[]) => names.map((n) => photoKey({ folder: id, path: n }));

/** What the API would bill for a describe request of `n` photos (768 × 512 each): the mocked `usage`. */
function usageOf(n: number): AiUsage {
  const sent = fitLongEdge(1600, 1067);
  return {
    inputTokens: n * imageTokens(sent.width, sent.height) + 380,
    outputTokens: 1300 + n * 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function answer(refs: AiImageRef[], options: AiRequestOptions | undefined) {
  const usage = usageOf(refs.length);
  const model = options?.model ?? 'claude-haiku-5-5';
  return {
    status: 'ok' as const,
    model,
    servedBy: model,
    fellBack: false,
    usage,
    attempts: [{ model, usage }],
    entries: refs.map((r, i) => ({
      id: r.id,
      description: `A street in Lisbon, photo ${i + 1}.\nPeople walk past.`,
      people: 2,
      setting: 'street',
      timeOfDay: 'evening' as const,
      mood: 'calm',
    })),
    missing: [],
  };
}

const library = (path: string): Library | undefined => useBookStore.getState().libraries[path];

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  globalThis.localStorage?.clear();
  mocks.aiDescribe.mockImplementation(async (refs: AiImageRef[], options?: AiRequestOptions) => answer(refs, options));
  useAiStore.setState({
    settings: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      indexModel: 'claude-haiku-5-5',
      hasKey: true,
      keyHint: '…abcd',
    },
  });
  useLibraryStore.setState({ folders: { [F]: folder(F, PATH, LISBON) } });
  useBookStore.setState({ book: null, folder: null, libraries: { [PATH]: emptyLibrary() }, developVersion: null });
  useBookStore.temporal.getState().clear();
});

describe('photo index', () => {
  it('indexes the lisbon fixture once in batches of 8 on Haiku, and a second run makes zero requests', async () => {
    const ids = keys(F, LISBON);
    const first = await indexPhotos(ids);
    expect(first.plan.todo).toHaveLength(16);
    expect(first.outcome.state).toBe('done');
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(2);
    for (const [refs, options] of mocks.aiDescribe.mock.calls) {
      expect(refs.length).toBeLessThanOrEqual(INDEX_BATCH);
      expect(options).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
      // Refs by hash only: the proxy is read by Rust, no path or name crosses.
      for (const ref of refs) expect(Object.keys(ref).sort()).toEqual(['hash', 'id', 'kind']);
    }
    // Entries under the hash in the folder's library, as written to library.json.
    const saved = parseLibrary(serializeLibrary(library(PATH) ?? emptyLibrary()));
    for (const name of LISBON) {
      const ai = saved.photos[hashOf(name)]?.ai;
      expect(ai?.model).toBe('claude-haiku-5-5');
      expect(ai?.description).toContain('Lisbon');
      expect(ai?.timeOfDay).toBe('evening');
    }
    // Not an undo step.
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);

    const second = await indexPhotos(ids);
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(2);
    expect(second.plan.todo).toHaveLength(0);
    expect(second.plan.described).toBe(16);
    expect(second.outcome.state === 'done' && second.outcome.value.requests).toBe(0);
    // The usage of both requests reached this month's line.
    expect(useAiStore.getState().month.requests).toBe(2);
  });

  it('shows a cost before the run within 20 % of the usage after it', async () => {
    const names = Array.from({ length: 45 }, (_, i) => `DSC_${i}.jpg`);
    useLibraryStore.setState({ folders: { [F]: folder(F, PATH, names) } });
    const plan = await planIndex(keys(F, names));
    const before = estimateIndex(plan);
    const outcome = await runIndex(plan).result;
    if (outcome.state !== 'done') throw new Error(outcome.state);
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(6);
    const after = outcome.value.usd;
    expect(after).toBeGreaterThan(0);
    expect(Math.abs(before.usd - after) / after).toBeLessThan(0.2);
    const billed = outcome.value.usage.inputTokens + outcome.value.usage.outputTokens;
    expect(Math.abs(before.inputTokens + before.outputTokens - billed) / billed).toBeLessThan(0.2);
  });

  it('refreshes entries a cheaper model wrote, never downgrades, and compares the requested model', async () => {
    const ids = keys(F, LISBON);
    await indexPhotos(ids);
    expect((await planIndex(ids)).todo).toHaveLength(0);
    // Haiku entries: up to date for a Haiku Refresh, redone by a Sonnet one (and counted as refreshable).
    expect((await planIndex(ids, { refresh: true })).todo).toHaveLength(0);
    const sonnet = await planIndex(ids, { refresh: true, model: 'claude-sonnet-5-5' });
    expect(sonnet.todo).toHaveLength(16);
    expect((await planIndex(ids, { model: 'claude-sonnet-5-5' })).refreshable).toBe(16);
    await runIndex(sonnet).result;
    // Sonnet entries are not downgraded by a Haiku Refresh.
    expect((await planIndex(ids, { refresh: true })).todo).toHaveLength(0);
    expect((await planIndex(ids, { refresh: true })).refreshable).toBe(0);

    // A fallback answer stores the requested model; a Refresh on that model keeps it.
    mocks.aiDescribe.mockImplementationOnce(async (refs: AiImageRef[], options?: AiRequestOptions) => ({
      ...answer(refs, options),
      servedBy: 'claude-opus-4-8',
      fellBack: true,
    }));
    const one = keys(F, ['IMG_01.jpg']);
    await runIndex(await planIndex(one, { refresh: true, model: 'claude-opus-5-5' })).result;
    const ai = library(PATH)?.photos[hashOf('IMG_01.jpg')]?.ai;
    expect(ai).toMatchObject({ model: 'claude-opus-5-5', servedBy: 'claude-opus-4-8' });
    expect((await planIndex(one, { refresh: true, model: 'claude-opus-5-5' })).todo).toHaveLength(0);
    expect(upToDate(ai, 'claude-opus-5-5', true)).toBe(true);
    expect(upToDate(ai, 'claude-haiku-5-5', true)).toBe(true);
    expect(upToDate({ ...(ai as LibraryPhotoAi), model: 'claude-haiku-5-5' }, 'claude-opus-5-5', true)).toBe(false);
    expect(upToDate({ ...(ai as LibraryPhotoAi), model: 'gpt-9' }, 'claude-haiku-5-5', true)).toBe(false);
    expect(upToDate({ ...(ai as LibraryPhotoAi), model: 'gpt-9' }, 'claude-haiku-5-5', false)).toBe(true);
  });

  it('never bills a photo twice when runs overlap', async () => {
    const ids = keys(F, LISBON);
    let release: (() => void) | null = null;
    mocks.aiDescribe.mockImplementationOnce(
      (refs: AiImageRef[], options?: AiRequestOptions) =>
        new Promise((resolve) => {
          release = () => resolve(answer(refs, options));
        }),
    );
    const a = runIndex(await planIndex(ids));
    // The same run again joins the first job.
    const same = runIndex(await planIndex(ids));
    expect(same.created).toBe(false);
    expect(same.id).toBe(a.id);
    // An overlapping run (8 of the same photos, planned before any answer) waits, then sends only the new ones.
    const extra = ['NEW_1.jpg', 'NEW_2.jpg'];
    useLibraryStore.setState({ folders: { [F]: folder(F, PATH, [...LISBON, ...extra]) } });
    const b = runIndex(await planIndex([...ids.slice(0, 8), ...keys(F, extra)]));
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    await vi.waitFor(() => expect(release).not.toBeNull());
    (release as unknown as () => void)();
    await a.result;
    const outcome = await b.result;
    if (outcome.state !== 'done') throw new Error(outcome.state);
    expect(outcome.value).toMatchObject({ described: 2, skipped: 8, requests: 1 });
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(3);
    const sent = mocks.aiDescribe.mock.calls.flatMap(([refs]) => (refs as AiImageRef[]).map((r) => r.id));
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('counts answers it cannot keep as failed and logs them', async () => {
    mocks.aiDescribe.mockImplementationOnce(async (refs: AiImageRef[], options?: AiRequestOptions) => {
      const ok = answer(refs, options);
      return {
        ...ok,
        entries: [
          { ...ok.entries[0], timeOfDay: 'teatime' },
          { ...ok.entries[1], id: 'not-a-ref' },
          { ...ok.entries[2], description: 'x'.repeat(2000) },
        ],
      };
    });
    const handle = runIndex(await planIndex(keys(F, LISBON.slice(0, 3))));
    const outcome = await handle.result;
    if (outcome.state !== 'done') throw new Error(outcome.state);
    expect(outcome.value).toMatchObject({ described: 1, failed: 2 });
    expect(library(PATH)?.photos[hashOf(LISBON[2] as string)]?.ai?.description).toHaveLength(AI_DESCRIPTION_MAX);
    expect(useJobsStore.getState().jobs[handle.id]?.log?.join('\n')).toMatch(/did not fit|for no photo|Not described/);
  });

  it('reaches library.json through the library autosave', async () => {
    const write = vi.fn(async (_folder: string, _json: string) => {});
    const stop = startLibraryAutosave({ delayMs: 0, write });
    try {
      await indexPhotos(keys(F, LISBON));
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      const [folderPath, json] = write.mock.calls[write.mock.calls.length - 1] ?? [];
      expect(folderPath).toBe(PATH);
      const onDisk = parseLibrary(json as string);
      for (const name of LISBON) expect(onDisk.photos[hashOf(name)]?.ai?.model).toBe('claude-haiku-5-5');
    } finally {
      stop();
    }
  });

  it('sends the same bytes once, writes every folder, and copies a description another folder has', async () => {
    const same = () => hashOf('shared');
    useLibraryStore.setState({
      folders: { [F]: folder(F, PATH, ['a.jpg', 'b.jpg'], same), [F2]: folder(F2, PATH2, ['c.jpg'], same) },
    });
    // PATH2's library is not loaded: it is read first (empty here).
    const ids = [...keys(F, ['a.jpg', 'b.jpg']), ...keys(F2, ['c.jpg'])];
    const plan = await planIndex(ids);
    expect(plan.todo).toHaveLength(1);
    expect(plan.todo[0]?.folders.sort()).toEqual([PATH, PATH2]);
    await runIndex(plan).result;
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(1);
    expect(library(PATH)?.photos[same()]?.ai).toBeDefined();
    expect(library(PATH2)?.photos[same()]?.ai).toEqual(library(PATH)?.photos[same()]?.ai);

    // A third folder with the same bytes copies the description: no request.
    useLibraryStore.setState((s) => ({ folders: { ...s.folders, F3: folder('F3', '/photos/faro', ['d.jpg'], same) } }));
    const copy = await planIndex([...ids, ...keys('F3', ['d.jpg'])]);
    expect(copy.todo).toHaveLength(0);
    expect(copy.copies.map((c) => c.folder)).toEqual(['/photos/faro']);
    await runIndex(copy).result;
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(1);
    expect(library('/photos/faro')?.photos[same()]?.ai?.description).toContain('Lisbon');
  });

  it('writes a project photo in another folder to that folder’s library', async () => {
    const book: Book = createEmptyBook({ title: 'Trip', folders: { [F]: { path: PATH }, [F2]: { path: PATH2 } } });
    book.assets = {
      a1: { id: 'a1', path: 'IMG_01.jpg', hash: hashOf('IMG_01.jpg'), folder: F } as Book['assets'][string],
      a2: { id: 'a2', path: 'x.jpg', hash: hashOf('x.jpg'), folder: F2 } as Book['assets'][string],
    };
    useBookStore.setState({
      book,
      folder: PATH,
      projectId: 'P1',
      libraries: { [PATH]: emptyLibrary(), [PATH2]: emptyLibrary() },
    });
    const plan = await planIndex(['a1', 'a2']);
    expect(plan.project).toBe('P1');
    const handle = runIndex(plan);
    expect(useJobsStore.getState().jobs[handle.id]?.kind).toBe('ai');
    await handle.result;
    expect(library(PATH)?.photos[hashOf('IMG_01.jpg')]?.ai).toBeDefined();
    expect(library(PATH2)?.photos[hashOf('x.jpg')]?.ai).toBeDefined();
    expect(library(PATH)?.photos[hashOf('x.jpg')]).toBeUndefined();
  });

  it('skips a declined batch and goes on; counts photos without a preview', async () => {
    mocks.aiDescribe
      .mockImplementationOnce(async (refs: AiImageRef[]) => ({
        ...answer(refs, undefined),
        status: 'refused',
        message: 'The model declined these photos: policy',
        reason: 'policy',
        category: null,
      }))
      .mockImplementationOnce(async (refs: AiImageRef[], options?: AiRequestOptions) => ({
        ...answer(refs.slice(1), options),
        missing: [refs[0]?.id],
      }));
    const plan = await planIndex(keys(F, LISBON));
    const outcome = await runIndex(plan).result;
    if (outcome.state !== 'done') throw new Error(outcome.state);
    expect(outcome.value).toMatchObject({ refused: 8, described: 7, missing: 1, requests: 2 });
    // Both requests were billed, the refusal too.
    expect(outcome.value.attempts).toHaveLength(2);
    const described = LISBON.filter((n) => library(PATH)?.photos[hashOf(n)]?.ai);
    expect(described).toHaveLength(7);
  });

  it('cancels the request in flight through ai_cancel and keeps the batches already written', async () => {
    let release: (() => void) | null = null;
    mocks.aiDescribe
      .mockImplementationOnce(async (refs: AiImageRef[], options?: AiRequestOptions) => answer(refs, options))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: 'cancelled' });
          }),
      );
    mocks.aiCancel.mockImplementation(async () => {
      release?.();
      return true;
    });
    const plan = await planIndex(keys(F, LISBON));
    const handle = runIndex(plan);
    await vi.waitFor(() => expect(mocks.aiDescribe).toHaveBeenCalledTimes(2));
    useJobsStore.getState().cancel(handle.id);
    expect((await handle.result).state).toBe('cancelled');
    const job = mocks.aiDescribe.mock.calls[1]?.[2];
    expect(mocks.aiCancel).toHaveBeenCalledWith(job);
    expect(LISBON.filter((n) => library(PATH)?.photos[hashOf(n)]?.ai)).toHaveLength(8);
  });

  it('never sends photos that are not hashed or whose library cannot be read', async () => {
    useLibraryStore.setState({
      folders: { [F]: { ...folder(F, PATH, ['a.jpg']), photos: { 'a.jpg': { ...photo('a.jpg'), hash: undefined } } } },
    });
    const plan = await planIndex([...keys(F, ['a.jpg']), 'F9/unknown.jpg']);
    expect(plan).toMatchObject({ todo: [], unavailable: 2, total: 2 });
    const { outcome } = await indexPhotos(keys(F, ['a.jpg']));
    expect(outcome.state).toBe('done');
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
  });
});
