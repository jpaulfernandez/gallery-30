import { describe, expect, it } from 'vitest';
import {
  cameraName,
  coordinatesLabel,
  distanceM,
  GROUP_BY_KEYS,
  type GroupByEntry,
  groupBy,
  MISSING_KEY,
  PLACE_RADIUS_M,
} from './groupBy.js';

/** The camera's wall clock as UTC epoch ms (how the index stores `taken`). */
const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe('groupBy', () => {
  it('lists every key', () => {
    expect(GROUP_BY_KEYS).toEqual(['hour', 'day', 'camera', 'lens', 'place']);
  });

  it('groups by hour and day on the camera clock, missing times last', () => {
    const entries: GroupByEntry[] = [
      { id: 'a', taken: at(2026, 9, 14, 18, 5) },
      { id: 'b', taken: at(2026, 9, 14, 18, 59) },
      { id: 'none' },
      { id: 'c', taken: at(2026, 9, 14, 19, 0) },
      { id: 'd', taken: at(2026, 9, 15, 7, 30) },
    ];
    expect(groupBy(entries, 'hour')).toEqual([
      { key: '2026-09-14T18', label: '14 Sep 2026 · 18:00', ids: ['a', 'b'] },
      { key: '2026-09-14T19', label: '14 Sep 2026 · 19:00', ids: ['c'] },
      { key: '2026-09-15T07', label: '15 Sep 2026 · 07:00', ids: ['d'] },
      { key: MISSING_KEY, label: 'No capture time', ids: ['none'] },
    ]);
    expect(groupBy(entries, 'day')).toEqual([
      { key: '2026-09-14', label: 'Mon 14 Sep 2026', ids: ['a', 'b', 'c'] },
      { key: '2026-09-15', label: 'Tue 15 Sep 2026', ids: ['d'] },
      { key: MISSING_KEY, label: 'No capture time', ids: ['none'] },
    ]);
  });

  it('keeps sections in first-appearance order and ids in input order', () => {
    const entries: GroupByEntry[] = [
      { id: '1', make: 'Fujifilm', model: 'X-T5' },
      { id: '2', make: 'Canon', model: 'Canon EOS R6' },
      { id: '3', make: 'FUJIFILM', model: 'X-T5' },
      { id: '4', make: 'Canon', model: 'Canon EOS R6' },
    ];
    expect(groupBy(entries, 'camera')).toEqual([
      { key: 'fujifilm x-t5', label: 'Fujifilm X-T5', ids: ['1', '3'] },
      { key: 'canon eos r6', label: 'Canon EOS R6', ids: ['2', '4'] },
    ]);
  });

  it('groups by lens, trimming and ignoring case', () => {
    const entries: GroupByEntry[] = [
      { id: 'a', lens: 'RF 50mm F1.2' },
      { id: 'b', lens: ' rf 50mm f1.2 ' },
      { id: 'c' },
    ];
    expect(groupBy(entries, 'lens')).toEqual([
      { key: 'rf 50mm f1.2', label: 'RF 50mm F1.2', ids: ['a', 'b'] },
      { key: MISSING_KEY, label: 'Unknown lens', ids: ['c'] },
    ]);
  });

  it('clusters places within 500 m of a place’s first photo', () => {
    const lisbon = { lat: 38.7139, lon: -9.1394 };
    // About 300 m north, then about 2 km north.
    const near = { lat: 38.7166, lon: -9.1394 };
    const far = { lat: 38.732, lon: -9.1394 };
    expect(distanceM(lisbon, near)).toBeLessThan(PLACE_RADIUS_M);
    expect(distanceM(lisbon, far)).toBeGreaterThan(PLACE_RADIUS_M);
    const sections = groupBy(
      [
        { id: 'a', gps: lisbon },
        { id: 'b', gps: far },
        { id: 'c', gps: near },
        { id: 'd', gps: { lat: Number.NaN, lon: 0 } },
      ],
      'place',
    );
    expect(sections.map((s) => s.ids)).toEqual([['a', 'c'], ['b'], ['d']]);
    expect(sections[0]?.label).toBe('38.714° N, 9.139° W');
    expect(sections[2]?.key).toBe(MISSING_KEY);
  });

  it('is pure: the input is not changed and an empty list has no sections', () => {
    const entries: GroupByEntry[] = [{ id: 'a', taken: at(2026, 1, 1, 0) }];
    const copy = structuredClone(entries);
    groupBy(entries, 'day');
    expect(entries).toEqual(copy);
    expect(groupBy([], 'place')).toEqual([]);
  });

  it('names cameras and coordinates', () => {
    expect(cameraName('Sony', 'ILCE-7M4')).toBe('Sony ILCE-7M4');
    expect(cameraName('Canon', 'Canon EOS R6')).toBe('Canon EOS R6');
    expect(cameraName('Apple', undefined)).toBe('Apple');
    expect(cameraName(undefined, undefined)).toBeUndefined();
    expect(coordinatesLabel(-33.8688, 151.2093)).toBe('33.869° S, 151.209° E');
  });
});
