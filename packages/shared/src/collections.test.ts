import { describe, expect, it } from 'vitest';
import { CollectionFilterSchema, newId, parseSavedCollections } from './index.js';

describe('saved collections', () => {
  it('fills the filter defaults and keeps the optional fields', () => {
    const id = newId();
    const [saved] = parseSavedCollections([
      { id, name: ' Keepers ', filter: { folders: ['F1'], edited: true, iso: 3200, dateRange: [1, 2] } },
    ]);
    expect(saved).toEqual({
      id,
      name: 'Keepers',
      filter: { folders: ['F1'], flag: 'all', minRating: 0, edited: true, iso: 3200, query: '', dateRange: [1, 2] },
    });
  });

  it('drops invalid and repeated entries one by one, and reads anything but an array as empty', () => {
    const id = newId();
    const good = { id, name: 'Picks of Rome', filter: { flag: 'picks', minRating: 3, query: 'rome' } };
    const list = parseSavedCollections([
      good,
      { ...good, name: 'Again' },
      { id: 'not-a-ulid', name: 'Bad id', filter: {} },
      { id: newId(), name: '', filter: {} },
      { id: newId(), name: 'Bad flag', filter: { flag: 'maybe' } },
      { id: newId(), name: 'Backwards', filter: { dateRange: [2, 1] } },
    ]);
    expect(list.map((c) => c.name)).toEqual(['Picks of Rome']);
    expect(parseSavedCollections({ collections: [good] })).toEqual([]);
    expect(parseSavedCollections(null)).toEqual([]);
  });
});

describe('flag filter (plan 40)', () => {
  it('accepts Undecided in a saved collection', () => {
    const id = newId();
    const [saved] = parseSavedCollections([{ id, name: 'To decide', filter: { flag: 'undecided' } }]);
    expect(saved?.filter.flag).toBe('undecided');
  });
});

describe('lens (plan 41)', () => {
  it('a filter without a lens keeps its other fields', () => {
    const filter = CollectionFilterSchema.parse({ folders: ['F1'], flag: 'picks', minRating: 2, iso: 800, query: 'x' });
    expect(filter).toEqual({ folders: ['F1'], flag: 'picks', minRating: 2, iso: 800, query: 'x' });
    expect('lens' in filter && filter.lens !== undefined).toBe(false);
  });

  it('an unknown lens is dropped and the rest kept', () => {
    const filter = CollectionFilterSchema.parse({ folders: ['F1'], flag: 'rejects', lens: 'faces', edited: true });
    expect(filter.lens).toBeUndefined();
    expect(filter).toMatchObject({ folders: ['F1'], flag: 'rejects', edited: true, minRating: 0, query: '' });
  });
});
