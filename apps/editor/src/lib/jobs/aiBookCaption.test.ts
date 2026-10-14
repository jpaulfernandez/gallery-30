import { type Book, createEmptyBook, createEmptyPage, emptyLibrary } from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '../../store/ai';
import { undo, useBookStore } from '../../store/book';
import { resetJobs } from '../../store/jobs';
import type { AiCaptionRequest, AiImageRef } from '../tauri';

const mocks = vi.hoisted(() => ({
  aiCaption: vi.fn(),
  aiDescribe: vi.fn(),
  aiCancel: vi.fn(async () => true),
  readAiSettings: vi.fn(),
  readLibrary: vi.fn(async () => null),
  readLibraryBackup: vi.fn(async () => null),
}));
vi.mock('../tauri', () => ({ ...mocks }));

const { bookCaptionPages, photosOfPages, useBookCaptions } = await import('./aiBookCaption');
const { defaultCaptionMode, planPageCaption, toPageCaptions, PAGE_TARGET, sendEdge, estimatePageCaptions } =
  await import('./aiPageCaption');

type El = Book['pages'][number]['elements'][number];
const PATH = '/photos/lisbon';
const hashOf = (n: number) => n.toString(16).padStart(64, '0');
const photo = (id: string, asset: string, frame = { x: 0.1, y: 0.1, w: 0.8, h: 0.6 }): El =>
  ({ type: 'photo', id, asset, frame, crop: { x: 0, y: 0, scale: 1 }, rotate: 0, filter: 'none' }) as El;
const caption = (id: string, value: string, frame = { x: 0.1, y: 0.75, w: 0.8, h: 0.05 }): El =>
  ({ type: 'text', id, text: value, style: 'caption', frame, align: 'left' }) as El;

const BRIEF = {
  about: 'A week in Lisbon with friends',
  photographer: '',
  placeTime: 'Lisbon, June 2026',
  people: ['Ana'],
  voice: 'editorial' as const,
  avoid: '',
  examples: [],
  useExisting: false,
};

const usage = { inputTokens: 1200, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 1800 };
const meta = {
  model: 'claude-opus-5-5',
  servedBy: 'claude-opus-5-5',
  fellBack: false,
  usage,
  attempts: [{ model: 'claude-opus-5-5', usage }],
};

/** The model's answer to a page request: a caption per target, naming the photo label. */
function answer(request: AiCaptionRequest) {
  return {
    status: 'ok' as const,
    ...meta,
    captions: request.targets.map((target) => ({
      target,
      text: target === PAGE_TARGET || !request.targets.includes(PAGE_TARGET) ? `Caption for ${target}.` : '',
      alt: target === PAGE_TARGET ? '' : `Alt of ${target}.`,
    })),
  };
}

function describeAnswer(refs: AiImageRef[]) {
  return {
    status: 'ok' as const,
    ...meta,
    model: 'claude-haiku-5-5',
    servedBy: 'claude-haiku-5-5',
    attempts: [{ model: 'claude-haiku-5-5', usage }],
    entries: refs.map((r) => ({
      id: r.id,
      description: 'A street in Lisbon.',
      people: 2,
      setting: 'street',
      timeOfDay: 'evening' as const,
      mood: 'calm',
    })),
    missing: [],
  };
}

/** Six pages: 1–5 with one photo and a caption slot each (page 2's already captioned), page 6 text only. */
function seed() {
  const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: PATH } } });
  book.assets = Object.fromEntries(
    [1, 2, 3, 4, 5].map((n) => [
      `a${n}`,
      { path: `IMG_${n}.jpg`, hash: hashOf(n), folder: 'F1', width: 6000, height: 4000 },
    ]),
  ) as Book['assets'];
  book.pages = [1, 2, 3, 4, 5].map((n) => {
    const page = createEmptyPage();
    page.elements = [photo(`e${n}`, `a${n}`), caption(`t${n}`, n === 2 ? 'Already written here.' : '')];
    return page;
  });
  const words = createEmptyPage();
  words.elements = [caption('t6', 'Words only')];
  book.pages.push(words);
  book.captions = { brief: BRIEF };
  useBookStore.setState({
    book,
    projectId: 'P1',
    folder: PATH,
    libraries: { [PATH]: emptyLibrary() },
    developVersion: null,
  });
  useBookStore.temporal.getState().clear();
  return book;
}

const book = () => useBookStore.getState().book as Book;
const captionOn = (page: number) => {
  const el = book().pages[page - 1]?.elements.find((e) => e.type === 'text');
  return el?.type === 'text' ? el.text : undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  useBookCaptions.getState().reset();
  globalThis.localStorage?.clear();
  mocks.aiCaption.mockImplementation(async (request: AiCaptionRequest) => answer(request));
  mocks.aiDescribe.mockImplementation(async (refs: AiImageRef[]) => describeAnswer(refs));
  useAiStore.setState({
    settings: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      indexModel: 'claude-haiku-5-5',
      hasKey: true,
      keyHint: '…abcd',
    },
  });
  seed();
});

describe('page caption requests', () => {
  const view = () => ({ ...useBookStore.getState(), files: {} });

  it('plans one request with the photos by hash, the brief, and targets per mode', () => {
    const pageId = book().pages[0]?.id as string;
    const plan = planPageCaption(view(), pageId, { mode: 'photo' });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.request.images).toEqual([
      { id: 'a1', kind: 'photo', hash: hashOf(1), developHash: null, label: 'Photo 1' },
    ]);
    expect(plan.request.targets).toEqual(['Photo 1']);
    expect(plan.request.system).toContain('A week in Lisbon with friends');
    expect(plan.request.options).toEqual({ maxEdge: 768, effort: 'low', maxTokens: 4096 });
    expect(plan.notSent).toBe(0);
    expect(plan.request.prompt).toContain('page 1 of the book');
    const page = planPageCaption(view(), pageId, { mode: 'page' });
    if ('error' in page) throw new Error(page.error);
    expect(page.request.targets).toEqual([PAGE_TARGET, 'Photo 1']);
    // Page 2's caption is shown so the model writes a new one.
    const second = planPageCaption(view(), book().pages[1]?.id as string);
    expect('error' in second ? '' : second.request.prompt).toContain('Already written here.');
    expect(planPageCaption(view(), book().pages[5]?.id as string)).toEqual({
      error: 'This page has no photos to caption.',
    });
  });

  it('reads the answer as captions per photo or one for the page, with alt text either way', () => {
    const photos = [
      { assetId: 'a1', label: 'Photo 1', name: 'IMG_1.jpg' },
      { assetId: 'a2', label: 'Photo 2', name: 'IMG_2.jpg' },
    ];
    const answerCaptions = [
      { target: 'Photo 2', text: '“Right.”', alt: 'B.' },
      { target: 'Photo 1', text: 'Left.', alt: 'A.' },
      { target: 'Photo 1', text: 'Repeat.', alt: 'A again.' },
      { target: PAGE_TARGET, text: 'Both.', alt: '' },
    ];
    expect(toPageCaptions({ mode: 'photo', photos }, answerCaptions)).toEqual([
      { assetId: 'a1', text: 'Left.', alt: 'A.' },
      { assetId: 'a2', text: 'Right.', alt: 'B.' },
    ]);
    expect(toPageCaptions({ mode: 'page', photos }, answerCaptions)).toEqual([
      { assetId: null, text: 'Both.' },
      { assetId: 'a1', text: '', alt: 'A.' },
      { assetId: 'a2', text: '', alt: 'B.' },
    ]);
  });

  it('sends smaller previews the more photos a page has, and fits the layout by default', () => {
    expect([1, 2, 3, 6].map(sendEdge)).toEqual([768, 640, 512, 512]);
    const two = createEmptyPage();
    two.elements = [photo('p1', 'a1'), photo('p2', 'a2'), caption('c1', ''), caption('c2', '')];
    expect(defaultCaptionMode(two)).toBe('photo');
    two.elements = two.elements.slice(0, 3);
    expect(defaultCaptionMode(two)).toBe('page');
  });

  it('estimates a run from the photos at their sent size, one cached system block and the output', () => {
    const ids = book()
      .pages.slice(0, 5)
      .map((p) => p.id);
    const e = estimatePageCaptions(book(), ids, 'claude-opus-5-5', 4000);
    // Five 6000 × 4000 photos at 768 px: 768 × 512 / 750 = 525 tokens each.
    expect(e.imageTokens).toBe(5 * 525);
    expect(e.cachedTokens).toBe(4000);
    expect(e.inputTokens).toBe(5 * 525 + 5 * 200 + 5 * 4000);
    // The page-specific output guess: 400 + 60 per photo a page.
    expect(e.outputTokens).toBe(5 * 460);
    expect(e.usd).toBeGreaterThan(0);
  });

  it('20 one-photo pages on Opus 5.5 estimate under $0.30', () => {
    const many = createEmptyBook({ title: 'Twenty', folders: { F1: { path: PATH } } });
    for (let n = 1; n <= 20; n++) {
      many.assets[`p${n}`] = { path: `P_${n}.jpg`, hash: hashOf(100 + n), folder: 'F1', width: 6000, height: 4000 };
      const page = createEmptyPage();
      page.elements = [photo(`pe${n}`, `p${n}`)];
      many.pages.push(page);
    }
    const e = estimatePageCaptions(
      many,
      many.pages.map((p) => p.id),
      'claude-opus-5-5',
      3000,
    );
    expect(e.usd).toBeLessThan(0.3);
  });

  it('says how many photos a page does not send beyond 20', () => {
    const page = book().pages[0];
    if (!page) throw new Error('no page');
    for (let n = 0; n < 21; n++) {
      book().assets[`x${n}`] = { path: `X_${n}.jpg`, hash: hashOf(200 + n), folder: 'F1' };
      page.elements.push(photo(`x${n}`, `x${n}`));
    }
    const plan = planPageCaption(view(), page.id);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.request.images).toHaveLength(20);
    expect(plan.notSent).toBe(2);
  });
});

describe('book captions run', () => {
  it('lists the pages without captions, or every page with photos', () => {
    const ids = book().pages.map((p) => p.id);
    expect(bookCaptionPages(book(), 'empty')).toEqual([ids[0], ids[2], ids[3], ids[4]]);
    expect(bookCaptionPages(book(), 'all')).toEqual(ids.slice(0, 5));
    expect(photosOfPages(book(), ids)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('indexes first, sends one request per page with the same system block, and lands nothing until accepted', async () => {
    const ids = bookCaptionPages(book(), 'all');
    await useBookCaptions.getState().start(ids, 'fit');
    // The index: the five photos in one describe request, before any caption request.
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(1);
    expect(mocks.aiCaption).toHaveBeenCalledTimes(5);
    expect(mocks.aiDescribe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.aiCaption.mock.invocationCallOrder[0] as number,
    );
    const systems = mocks.aiCaption.mock.calls.map(([request]) => (request as AiCaptionRequest).system);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toContain('A street in Lisbon.');
    const run = useBookCaptions.getState();
    expect(run.status).toBe('finished');
    expect(run.rows.map((r) => r.state)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);
    // Usage sums: one describe and five captions.
    expect(run.usage.inputTokens).toBe(6 * 1200);
    expect(run.usage.cacheReadInputTokens).toBe(6 * 1800);
    expect(run.usd).toBeGreaterThan(0);
    // Nothing has landed.
    expect(captionOn(1)).toBe('');
    expect(captionOn(2)).toBe('Already written here.');
    expect(book().assets.a1?.alt).toBeUndefined();
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('accepts, edits and skips rows; each accepted page is one undo step', async () => {
    const ids = bookCaptionPages(book(), 'empty');
    await useBookCaptions.getState().start(ids, 'fit');
    const run = () => useBookCaptions.getState();
    run().accept(ids[0] as string);
    expect(captionOn(1)).toBe('Caption for page.');
    expect(book().assets.a1?.alt).toBe('Alt of Photo 1.');
    const third = run().rows[1];
    run().edit(third?.pageId as string, [{ assetId: null, text: 'My own words.' }]);
    run().skip(ids[2] as string);
    run().acceptAll();
    expect(run().rows.map((r) => r.state)).toEqual(['accepted', 'accepted', 'skipped', 'accepted']);
    expect(captionOn(3)).toBe('My own words.');
    expect(captionOn(4)).toBe('');
    expect(captionOn(5)).toBe('Caption for page.');
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(3);
    undo();
    expect(captionOn(5)).toBe('');
    expect(captionOn(3)).toBe('My own words.');
  });

  it('a refusal on page 3 leaves pages 1–2 and 4+ to accept', async () => {
    mocks.aiCaption.mockImplementation(async (request: AiCaptionRequest) =>
      request.prompt.includes('page 3 of the book')
        ? {
            status: 'refused',
            ...meta,
            message: 'The model declined this page: policy',
            reason: 'policy',
            category: null,
          }
        : answer(request),
    );
    const ids = bookCaptionPages(book(), 'all');
    await useBookCaptions.getState().start(ids, 'fit');
    const rows = useBookCaptions.getState().rows;
    expect(rows.map((r) => r.state)).toEqual(['ready', 'ready', 'refused', 'ready', 'ready']);
    expect(rows[2]?.message).toBe('The model declined this page: policy');
    useBookCaptions.getState().acceptAll();
    expect([1, 2, 3, 4, 5].map(captionOn)).toEqual([
      'Caption for page.',
      'Caption for page.',
      '',
      'Caption for page.',
      'Caption for page.',
    ]);
    expect(book().assets.a3?.alt).toBeUndefined();
    expect(book().assets.a4?.alt).toBe('Alt of Photo 4.');
  });

  it('a re-run with the index cached makes no describe request', async () => {
    const ids = bookCaptionPages(book(), 'all');
    await useBookCaptions.getState().start(ids, 'fit');
    useBookCaptions.getState().reset();
    vi.clearAllMocks();
    await useBookCaptions.getState().start(ids, 'photo');
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
    expect(mocks.aiCaption).toHaveBeenCalledTimes(5);
    expect(useBookCaptions.getState().rows.every((r) => r.mode === 'photo' && r.state === 'ready')).toBe(true);
  });

  it('marks a row accepted only when the page changed: "No change" or "Page changed" otherwise', async () => {
    const ids = bookCaptionPages(book(), 'all');
    await useBookCaptions.getState().start(ids, 'fit');
    const run = () => useBookCaptions.getState();
    // Page 1 already reads exactly the answer.
    useBookStore.getState().applyCaptions(ids[0] as string, run().rows[0]?.captions ?? []);
    run().accept(ids[0] as string);
    expect(run().rows[0]?.state).toBe('unchanged');
    expect(run().rows[0]?.message).toMatch(/^No change/);
    // Page 2 is deleted before it is accepted.
    useBookStore.getState().deletePage(ids[1] as string);
    run().accept(ids[1] as string);
    expect(run().rows[1]?.state).toBe('error');
    expect(run().rows[1]?.message).toMatch(/^Page changed/);
    run().accept(ids[2] as string);
    expect(run().rows[2]?.state).toBe('accepted');
  });

  it('cancel stops the page requests without an answer and keeps the answered rows', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    mocks.aiCaption.mockImplementation(async (request: AiCaptionRequest) => {
      calls += 1;
      if (calls === 2) {
        await gate;
        return { status: 'cancelled' };
      }
      return answer(request);
    });
    const ids = bookCaptionPages(book(), 'all');
    const done = useBookCaptions.getState().start(ids, 'fit');
    await vi.waitFor(() => expect(calls).toBe(2));
    useBookCaptions.getState().cancel();
    expect(mocks.aiCancel).toHaveBeenCalled();
    release();
    await done;
    const run = useBookCaptions.getState();
    expect(run.cancelled).toBe(true);
    expect(run.rows.map((r) => r.state)).toEqual(['ready', 'cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(mocks.aiCaption).toHaveBeenCalledTimes(2);
  });
});
