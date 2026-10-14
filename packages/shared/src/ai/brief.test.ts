import { describe, expect, it } from 'vitest';
import { type Book, BookSchema, createEmptyBook, createEmptyPage, parseBook, serializeBook } from '../index.js';
import {
  BRIEF_LIMITS,
  briefReady,
  captureSummary,
  emptyBrief,
  existingCaptions,
  hasExistingCaptions,
  parsePeople,
  validateBrief,
} from './brief.js';

type El = Book['pages'][number]['elements'][number];

const text = (id: string, value: string, style: 'caption' | 'title' | 'body' = 'caption'): El =>
  ({ type: 'text', id, text: value, style, frame: { x: 0, y: 0.9, w: 1, h: 0.05 }, align: 'left' }) as El;

describe('validateBrief', () => {
  it('requires what the book is about and nothing else', () => {
    const empty = validateBrief(emptyBrief());
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(Object.keys(empty.errors)).toEqual(['about']);
    const blank = validateBrief({ ...emptyBrief(), about: '   ' });
    expect(blank.ok).toBe(false);
    const ok = validateBrief({ about: 'A week in Lisbon with friends, June 2026' });
    expect(ok).toEqual({
      ok: true,
      brief: {
        about: 'A week in Lisbon with friends, June 2026',
        photographer: '',
        placeTime: '',
        people: [],
        voice: 'editorial',
        avoid: '',
        examples: [],
        useExisting: false,
      },
    });
  });

  it('trims texts and drops blank and repeated names and examples', () => {
    const result = validateBrief({
      ...emptyBrief(),
      about: '  Lisbon  ',
      photographer: ' Jan Paul; "we" ',
      people: ['Ana', ' ', 'Rui ', 'Ana'],
      examples: ['', 'The tram climbs past the cathedral at dusk.', '  '],
      voice: 'diary',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.about).toBe('Lisbon');
    expect(result.brief.photographer).toBe('Jan Paul; "we"');
    expect(result.brief.people).toEqual(['Ana', 'Rui']);
    expect(result.brief.examples).toEqual(['The tram climbs past the cathedral at dusk.']);
    expect(result.brief.voice).toBe('diary');
  });

  it('rejects a fourth example, an unknown voice and over-long fields', () => {
    const many = validateBrief({ about: 'x', examples: ['a', 'b', 'c', 'd'] });
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.errors.examples).toMatch(/At most 3/);
    const voice = validateBrief({ about: 'x', voice: 'shouty' });
    expect(voice.ok).toBe(false);
    if (!voice.ok) expect(voice.errors.voice).toBeDefined();
    const long = validateBrief({ about: 'x'.repeat(BRIEF_LIMITS.about + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.about).toMatch(/600/);
  });

  it('saves into the v8 project file and reads back without a version bump', () => {
    const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: '/photos' } } });
    const result = validateBrief({ about: 'Lisbon', people: ['Ana'] });
    if (!result.ok) throw new Error('invalid');
    const withBrief = BookSchema.parse({ ...book, captions: { brief: result.brief } });
    const back = parseBook(serializeBook(withBrief));
    expect(back.version).toBe(8);
    expect(back.captions.brief).toEqual(result.brief);
    // A file written before the dialog existed (an empty brief) still opens.
    expect(parseBook(serializeBook({ ...book, captions: { brief: {} as never } })).captions.brief?.about).toBe('');
  });
});

describe('briefReady', () => {
  it('needs a non-blank about', () => {
    expect(briefReady(undefined)).toBe(false);
    expect(briefReady({} as never)).toBe(false);
    expect(briefReady({ about: '  ' })).toBe(false);
    expect(briefReady({ about: 'Lisbon' })).toBe(true);
  });
});

describe('parsePeople', () => {
  it('splits on commas and newlines', () => {
    expect(parsePeople('Ana, Rui\nMarta,, ')).toEqual(['Ana', 'Rui', 'Marta']);
  });
});

describe('existingCaptions', () => {
  it('takes captions of four words or more in book order, without titles or repeats', () => {
    const book = createEmptyBook({ title: 't', folders: {} });
    const p1 = createEmptyPage();
    const p2 = createEmptyPage();
    p1.elements = [
      text('t1', 'Lisbon', 'title'),
      text('t2', 'Too short here'),
      text('t3', 'The tram climbs   past the cathedral.'),
    ];
    p2.elements = [text('t4', 'The tram climbs past the cathedral.'), text('t5', 'Ana reads the menu twice.', 'body')];
    book.pages = [p1, p2];
    expect(existingCaptions(book)).toEqual(['The tram climbs past the cathedral.', 'Ana reads the menu twice.']);
    expect(existingCaptions(book, 1)).toEqual(['The tram climbs past the cathedral.']);
    // The text box being written is not its own example.
    expect(existingCaptions(book, 3, 't3')).toEqual([
      'The tram climbs past the cathedral.',
      'Ana reads the menu twice.',
    ]);
    expect(existingCaptions(book, 3, 't5')).toEqual(['The tram climbs past the cathedral.']);
    expect(hasExistingCaptions(book)).toBe(true);
    expect(hasExistingCaptions({ pages: [p1].map((p) => ({ ...p, elements: p.elements.slice(0, 2) })) })).toBe(false);
  });
});

describe('captureSummary', () => {
  it('gives the date range and the median position', () => {
    expect(
      captureSummary([
        { taken: '2026-06-09T18:00:00', lat: 38.71, lon: -9.14 },
        { taken: '2026-06-03T09:12:00', lat: 38.72, lon: -9.13 },
        { taken: null, lat: 38.7, lon: -9.15 },
        { taken: '2026-06-05T12:00:00' },
      ]),
    ).toBe('June 3–9, 2026; near 38.71° N, 9.14° W');
  });

  it('spans months and years, and skips unknown and null-island positions', () => {
    expect(captureSummary([{ taken: '2026-05-30T10:00:00' }, { taken: '2026-06-02T10:00:00' }])).toBe(
      'May 30 – June 2, 2026',
    );
    expect(captureSummary([{ taken: '2025-12-30T10:00:00' }, { taken: '2026-01-02T10:00:00' }])).toBe(
      'December 30, 2025 – January 2, 2026',
    );
    expect(captureSummary([{ taken: '2026-06-03T10:00:00', lat: 0, lon: 0 }])).toBe('June 3, 2026');
    expect(captureSummary([{ lat: -33.87, lon: 151.21 }])).toBe('near 33.87° S, 151.21° E');
    expect(captureSummary([{ taken: 'garbage' }, {}])).toBe('');
    expect(captureSummary([{ taken: '2026-06-03T10:00:00', lat: 38.7, lon: -9.1 }], { coordinates: false })).toBe(
      'June 3, 2026',
    );
  });
});
