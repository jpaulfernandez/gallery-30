import { describe, expect, it } from 'vitest';
import {
  AI_DESCRIPTION_MAX,
  type Asset,
  type Book,
  createEmptyBook,
  createEmptyPage,
  emptyLibrary,
  type Library,
  type LibraryPhotoAi,
  parseLibrary,
  serializeLibrary,
} from '../index.js';
import { indexEntries, indexLine, indexText } from './photoIndex.js';

const hashOf = (n: number) => n.toString(16).padStart(64, '0');

const ai = (description: string, over: Partial<LibraryPhotoAi> = {}): LibraryPhotoAi => ({
  model: 'claude-haiku-5-5',
  at: '2026-10-13T10:00:00.000Z',
  description,
  people: 2,
  setting: 'street',
  timeOfDay: 'evening',
  mood: 'warm',
  ...over,
});

function asset(id: string, n: number, path: string): Asset {
  return { id, path, hash: hashOf(n), folder: 'F1', width: 1600, height: 1067 } as Asset;
}

function bookWith(): Book {
  const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: '/photos/lisbon' } } });
  book.assets = {
    a1: asset('a1', 1, 'IMG_01.jpg'),
    a2: asset('a2', 2, 'IMG_02.jpg'),
    a3: asset('a3', 3, 'IMG_03.jpg'),
    a4: asset('a4', 4, 'IMG_00.jpg'),
  };
  const page1 = createEmptyPage();
  const page2 = createEmptyPage();
  page1.elements = [
    {
      type: 'photo',
      id: 'e1',
      asset: 'a3',
      frame: { x: 0, y: 0, w: 1, h: 1 },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    } as Book['pages'][number]['elements'][number],
  ];
  page2.background = { asset: 'a1' };
  page2.elements = [
    { ...(page1.elements[0] as object), id: 'e2', asset: 'a3' } as Book['pages'][number]['elements'][number],
  ];
  book.pages = [page1, page2];
  return book;
}

describe('photo index', () => {
  it('stores an optional ai entry on the library photo and round-trips it', () => {
    const library = emptyLibrary();
    library.photos[hashOf(1)] = { versions: {}, ai: ai('A tram climbs a narrow street.\nTwo people watch.') };
    const text = serializeLibrary(library);
    const parsed = parseLibrary(text);
    expect(parsed.photos[hashOf(1)]?.ai?.description).toContain('tram');
    expect(parsed.version).toBe(1);
    // A library without the field still parses (no version bump).
    expect(
      parseLibrary(JSON.stringify({ version: 1, photos: { [hashOf(2)]: { rating: 3 } } })).photos[hashOf(2)]?.ai,
    ).toBe(undefined);
    // A bad index entry drops only `ai`: the rest of the entry and the library parse.
    const bad = parseLibrary(
      JSON.stringify({
        version: 1,
        photos: {
          x: { rating: 4, ai: { ...ai('x'), timeOfDay: 'teatime' } },
          y: { flag: 'pick', ai: ai('y'.repeat(AI_DESCRIPTION_MAX + 1)) },
          z: { ai: { ...ai('z'), servedBy: 'claude-opus-4-8' } },
        },
      }),
    );
    expect(bad.photos.x?.rating).toBe(4);
    expect(bad.photos.x?.ai).toBeUndefined();
    expect(bad.photos.y?.flag).toBe('pick');
    expect(bad.photos.y?.ai).toBeUndefined();
    expect(bad.photos.z?.ai?.servedBy).toBe('claude-opus-4-8');
  });

  it('numbers the placed photos in book order, plus the ids asked for; scope all adds the rest by path', () => {
    expect(indexEntries(bookWith()).map((e) => [e.n, e.assetId, e.pages])).toEqual([
      [1, 'a3', [1, 2]],
      [2, 'a1', [2]],
    ]);
    expect(
      indexEntries(bookWith(), undefined, { include: ['a2', 'a3', 'nope', 'a2'] }).map((e) => [e.n, e.assetId]),
    ).toEqual([
      [1, 'a3'],
      [2, 'a1'],
      [3, 'a2'],
    ]);
    expect(indexEntries(bookWith(), undefined, { scope: 'all' }).map((e) => [e.n, e.assetId, e.pages])).toEqual([
      [1, 'a3', [1, 2]],
      [2, 'a1', [2]],
      [3, 'a4', []],
      [4, 'a2', []],
    ]);
  });

  it('formats one line per photo, about 60 tokens each, and is stable', () => {
    const library: Library = emptyLibrary();
    library.photos[hashOf(3)] = {
      versions: {},
      ai: ai('A yellow tram climbs a narrow cobbled street.\n  Two people wait at the stop under a striped awning.', {
        mood: 'nostalgic',
        setting: 'tram stop',
      }),
    };
    library.photos[hashOf(1)] = { versions: {}, ai: ai('Rooftops at dusk', { people: 0, timeOfDay: 'unknown' }) };
    const book = bookWith();
    const text = indexText(book, library, { scope: 'all' });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Photo index/);
    expect(lines[1]).toBe(
      'Photo 1 (pp. 1, 2): A yellow tram climbs a narrow cobbled street. Two people wait at the stop under a striped awning. People: 2. Setting: tram stop. Time: evening. Mood: nostalgic.',
    );
    expect(lines[2]).toBe('Photo 2 (p. 2): Rooftops at dusk. People: 0. Setting: street. Mood: warm.');
    expect(lines[3]).toBe('Photo 3: not described yet.');
    // About four characters a token: a described line stays near 60 tokens or under.
    expect(Math.ceil((lines[1]?.length ?? 0) / 4)).toBeLessThanOrEqual(70);
    // Byte-identical for the same inputs (the prompt cache depends on it), with a per-asset library too.
    expect(indexText(bookWith(), () => library, { scope: 'all' })).toBe(text);
    expect(indexText(bookWith(), library).split('\n')).toHaveLength(3);
    expect(indexText({ assets: {}, pages: [] })).toBe('');
  });

  it('reads each asset from its own folder library', () => {
    const other = emptyLibrary();
    other.photos[hashOf(2)] = { versions: {}, ai: ai('A market stall') };
    const book = bookWith();
    const entries = indexEntries(book, (a) => (a.path === 'IMG_02.jpg' ? other : undefined), { scope: 'all' });
    expect(entries.find((e) => e.assetId === 'a2')?.ai?.description).toBe('A market stall');
    expect(entries.find((e) => e.assetId === 'a1')?.ai).toBeUndefined();
    expect(indexLine({ n: 9, assetId: 'x', pages: [] })).toBe('Photo 9: not described yet.');
  });
});
