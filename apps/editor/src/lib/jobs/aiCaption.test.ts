import { type Book, createEmptyBook, createEmptyPage, emptyLibrary, type Library } from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJobs, useJobsStore } from '../../store/jobs';

const mocks = vi.hoisted(() => ({
  aiCaption: vi.fn(),
  aiCancel: vi.fn(async () => true),
}));
vi.mock('../tauri', () => ({ ...mocks }));

const {
  ALT_MAX,
  capAlt,
  captionSubject,
  cleanCaption,
  photosToSend,
  planElementCaption,
  requestElementCaptions,
  toVariants,
  withFileNames,
  CAPTION_ANGLES,
} = await import('./aiCaption');

type El = Book['pages'][number]['elements'][number];
const FOLDER = '/photos/lisbon';
const hashOf = (n: number) => n.toString(16).padStart(64, '0');
const photo = (id: string, asset: string, frame: { x: number; y: number; w: number; h: number }): El =>
  ({ type: 'photo', id, asset, frame, crop: { x: 0, y: 0, scale: 1 }, rotate: 0, filter: 'none' }) as El;
const text = (id: string, value: string, frame = { x: 0.1, y: 0.62, w: 0.8, h: 0.05 }): El =>
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

function makeBook(): Book {
  const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: FOLDER } } });
  book.assets = Object.fromEntries(
    [1, 2, 3].map((n) => [`a${n}`, { id: `a${n}`, path: `IMG_${n}.jpg`, hash: hashOf(n), folder: 'F1' }]),
  ) as Book['assets'];
  const p1 = createEmptyPage();
  p1.elements = [photo('e1', 'a1', { x: 0.1, y: 0.1, w: 0.8, h: 0.5 }), text('t1', 'Old caption')];
  const p2 = createEmptyPage();
  p2.elements = [
    photo('e2', 'a2', { x: 0.05, y: 0.1, w: 0.4, h: 0.5 }),
    photo('e3', 'a3', { x: 0.55, y: 0.1, w: 0.4, h: 0.5 }),
    text('t2', '', { x: 0.3, y: 0.62, w: 0.4, h: 0.05 }),
  ];
  const p3 = createEmptyPage();
  p3.elements = [text('t3', 'Words only')];
  book.pages = [p1, p2, p3];
  book.captions = { brief: BRIEF };
  return book;
}

function library(described: number[]): Library {
  const lib = emptyLibrary();
  for (const n of described) {
    lib.photos[hashOf(n)] = {
      ai: {
        model: 'claude-haiku-5-5',
        at: '2026-10-13T00:00:00Z',
        description: `Photo number ${n}.`,
        people: 1,
        setting: 'street',
        timeOfDay: 'evening',
        mood: 'warm',
      },
    } as Library['photos'][string];
  }
  return lib;
}

const view = (book: Book, described: number[] = [1]) => ({
  book,
  folder: FOLDER,
  libraries: { [FOLDER]: library(described) },
  projectId: 'P1',
  files: {},
});

const usage = { inputTokens: 1000, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 3000 };
const meta = {
  model: 'claude-opus-5-5',
  servedBy: 'claude-opus-5-5',
  fellBack: false,
  usage,
  attempts: [{ model: 'claude-opus-5-5', usage }],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
});

describe('captionSubject', () => {
  it('is the one photo above a caption, or the nearest of several with the page sent', () => {
    const book = makeBook();
    const [p1, p2, p3] = book.pages as [Book['pages'][number], Book['pages'][number], Book['pages'][number]];
    expect(captionSubject(p1, 't1', book.template)).toEqual({ photos: ['a1'], subject: 'a1', one: true });
    const between = captionSubject(p2, 't2', book.template);
    expect(between.photos).toEqual(['a2', 'a3']);
    expect(between.one).toBe(false);
    expect(captionSubject(p3, 't3', book.template)).toEqual({ photos: [], subject: null, one: false });
    // Right under the left photo, far from the right one: that photo alone.
    const under = { ...p2, elements: [...p2.elements, text('t4', '', { x: 0.05, y: 0.61, w: 0.3, h: 0.04 })] };
    expect(captionSubject(under, 't4', book.template)).toMatchObject({ subject: 'a2', one: true });
  });
});

describe('planElementCaption', () => {
  it('sends the one photo by hash with its index label, and the brief and index in the system block', () => {
    const book = makeBook();
    const plan = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.subject).toBe('a1');
    expect(plan.request.images).toEqual([
      { id: 'a1', kind: 'photo', hash: hashOf(1), developHash: null, label: 'Photo 1' },
    ]);
    expect(plan.request.targets).toEqual([...CAPTION_ANGLES]);
    expect(plan.request.system).toContain('Style sheet (Editorial):');
    expect(plan.request.system).toContain('- About: A week in Lisbon with friends');
    expect(plan.request.system).toContain('Photo 1 (p. 1): Photo number 1.');
    expect(plan.request.prompt).toContain('page 1 of the book');
    expect(plan.request.prompt).toContain('It is about Photo 1, shown above.');
    expect(plan.request.prompt).toContain('The text box now reads: "Old caption"');
  });

  it('keeps the system block byte-identical across the text boxes of a book', () => {
    const book = makeBook();
    const a = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    const b = planElementCaption(view(book), book.pages[1]?.id as string, 't2', {
      fix: 'shorter',
      previous: ['One.', 'Two.'],
    });
    if ('error' in a || 'error' in b) throw new Error('no plan');
    expect(b.request.system).toBe(a.request.system);
    expect(b.request.images.map((i) => i.label)).toEqual(['Photo 2', 'Photo 3']);
    expect(b.request.prompt).toContain('clearly shorter');
    expect(b.request.prompt).toContain('- "One."');
  });

  it('leaves the index out when no photo is described, and asks for no alt on a page without photos', () => {
    const book = makeBook();
    const plan = planElementCaption(view(book, []), book.pages[2]?.id as string, 't3');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.request.images).toEqual([]);
    expect(plan.request.system).not.toContain('Photo index');
    expect(plan.request.prompt).toContain('leave alt empty');
  });

  it('needs a brief that says what the book is about', () => {
    const book = { ...makeBook(), captions: {} };
    expect(planElementCaption(view(book), book.pages[0]?.id as string, 't1')).toEqual({
      error: 'Write the caption brief first.',
    });
    const empty = { ...makeBook(), captions: { brief: {} as never } };
    expect(planElementCaption(view(empty), empty.pages[0]?.id as string, 't1')).toEqual({
      error: 'Write the caption brief first.',
    });
  });

  it('never uses the box being written as an example, so Use leaves its system block as it was', () => {
    const book = makeBook();
    book.captions = { brief: { ...BRIEF, useExisting: true } };
    const t1 = book.pages[0]?.elements[1];
    if (t1?.type === 'text') t1.text = 'The 28 tram climbs past the cathedral.';
    const before = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    if (t1?.type === 'text') t1.text = 'Alfama, the evening light on the hill.';
    const after = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    if ('error' in before || 'error' in after) throw new Error('no plan');
    expect(before.request.system).not.toContain('cathedral');
    expect(after.request.system).toBe(before.request.system);
    // Another box does see it as an example.
    const other = planElementCaption(view(book), book.pages[1]?.id as string, 't2');
    if ('error' in other) throw new Error(other.error);
    expect(other.request.system).toContain('- Alfama, the evening light on the hill.');
  });

  it('names the photo files in a missing-preview error', () => {
    const book = makeBook();
    const plan = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.names).toEqual({ a1: 'IMG_1.jpg' });
    expect(withFileNames('No preview yet for a1; open the photo once and try again', plan.names)).toBe(
      'No preview yet for IMG_1.jpg; open the photo once and try again',
    );
  });
});

describe('photosToSend', () => {
  it('always sends the subject, filling to six in page order', () => {
    const page = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    expect(photosToSend(page, 'p7', false)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p7']);
    expect(photosToSend(page, 'p2', false)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(photosToSend(page, 'p7', true)).toEqual(['p7']);
    expect(photosToSend([], null, false)).toEqual([]);
  });
});

describe('toVariants', () => {
  it('orders by angle, strips quotes and keeps three', () => {
    expect(
      toVariants([
        { target: 'detail', text: '"A blue tile."', alt: 'Tiles.' },
        { target: 'what', text: ' We wait. ', alt: 'People.' },
        { target: 'where', text: '', alt: '' },
        { target: 'what', text: 'Again.', alt: 'x' },
        { target: 'where', text: 'Alfama.', alt: 'y' },
      ]).map((v) => v.text),
    ).toEqual(['We wait.', 'Alfama.', 'A blue tile.']);
    expect(cleanCaption('“Quoted”')).toBe('Quoted');
    // A caption that quotes someone keeps its quotes.
    expect(cleanCaption('"Never again," she said. "Not here."')).toBe('"Never again," she said. "Not here."');
    expect(cleanCaption('“No,” says Ana, “not yet.”')).toBe('“No,” says Ana, “not yet.”');
    expect(cleanCaption("'Ana's tram'")).toBe("'Ana's tram'");
  });

  it('caps alt text at 125 characters, at a word', () => {
    const long = 'A yellow tram climbs a steep cobbled street '.repeat(5);
    const alt = capAlt(long);
    expect(alt.length).toBeLessThanOrEqual(ALT_MAX);
    expect(long.startsWith(alt)).toBe(true);
    expect(alt.endsWith(' ')).toBe(false);
    expect(toVariants([{ target: 'what', text: 'x', alt: long }])[0]?.alt).toBe(alt);
  });
});

describe('requestElementCaptions', () => {
  const plan = () => {
    const book = makeBook();
    const p = planElementCaption(view(book), book.pages[0]?.id as string, 't1');
    if ('error' in p) throw new Error(p.error);
    return p;
  };

  it('runs as one ai job and maps the answer to variants with the cost', async () => {
    mocks.aiCaption.mockResolvedValue({
      status: 'ok',
      ...meta,
      captions: CAPTION_ANGLES.map((a) => ({ target: a, text: `${a} text.`, alt: `${a} alt` })),
    });
    const handle = requestElementCaptions(plan());
    expect(useJobsStore.getState().jobs[handle.jobId]?.kind).toBe('ai');
    const result = await handle.result;
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.variants.map((v) => v.text)).toEqual(['what text.', 'where text.', 'detail text.']);
    expect(result.usd).toBeGreaterThan(0);
    expect(mocks.aiCaption).toHaveBeenCalledTimes(1);
  });

  it('passes a refusal on with its message', async () => {
    mocks.aiCaption.mockResolvedValue({
      status: 'refused',
      ...meta,
      message: 'The model declined this page: unsafe content',
      reason: 'unsafe content',
      category: null,
    });
    const result = await requestElementCaptions(plan()).result;
    expect(result).toMatchObject({ status: 'refused', message: 'The model declined this page: unsafe content' });
  });

  it('cancels the request in flight through ai_cancel', async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.aiCaption.mockImplementation(() => new Promise((r) => (resolve = r)));
    mocks.aiCancel.mockImplementation(async () => {
      resolve({ status: 'cancelled' });
      return true;
    });
    const handle = requestElementCaptions(plan());
    await vi.waitFor(() => expect(mocks.aiCaption).toHaveBeenCalled());
    handle.cancel();
    expect(await handle.result).toEqual({ status: 'cancelled' });
    expect(mocks.aiCancel).toHaveBeenCalledTimes(1);
  });

  it('reports a failed request as an error', async () => {
    mocks.aiCaption.mockRejectedValue('No Anthropic API key yet.');
    expect(await requestElementCaptions(plan()).result).toEqual({
      status: 'error',
      message: 'No Anthropic API key yet.',
    });
  });
});
