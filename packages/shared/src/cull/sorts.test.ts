import { describe, expect, it } from 'vitest';
import {
  aspectClass,
  COLOUR_FAMILIES,
  colourFamily,
  hexToOklab,
  oklabHue,
  paletteWarmth,
  type SortEntry,
  type StoryEntry,
  storyComparator,
  storyGroups,
} from './sorts.js';

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
const order = (entries: Array<SortEntry & { id: string }>, sort: Parameters<typeof storyComparator>[0]) =>
  [...entries].sort(storyComparator<SortEntry & { id: string }>(sort, (e) => e, byId)).map((e) => e.id);

describe('hexToOklab', () => {
  it('matches the published Oklab values of the primaries', () => {
    const white = hexToOklab('#ffffff');
    expect(white?.L).toBeCloseTo(1, 3);
    expect(Math.abs(white?.a ?? 1)).toBeLessThan(1e-3);
    const red = hexToOklab('#ff0000');
    expect(red?.L).toBeCloseTo(0.628, 3);
    expect(red?.a).toBeCloseTo(0.2249, 3);
    expect(red?.b).toBeCloseTo(0.1258, 3);
    expect(hexToOklab('nope')).toBeUndefined();
  });

  it('puts the primaries and secondaries in their families', () => {
    const family = (hex: string) => colourFamily(hexToOklab(hex) ?? { L: 0, a: 0, b: 0 });
    expect(
      ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff00ff', '#808080'].map(family),
    ).toEqual(COLOUR_FAMILIES);
    expect(oklabHue(hexToOklab('#0000ff') ?? { L: 0, a: 0, b: 0 })).toBeCloseTo(264, 0);
  });
});

describe('storyComparator', () => {
  const blueDark: StoryEntry = { id: 'a', palette: ['#102050'], stats: { medianLum: 0.2 }, width: 4000, height: 6000 };
  const blueLight: StoryEntry = { id: 'b', palette: ['#90b0f0'], stats: { medianLum: 0.8 }, width: 6000, height: 4000 };
  const red: StoryEntry = {
    id: 'c',
    palette: ['#c02020', '#e0a080'],
    stats: { medianLum: 0.5 },
    width: 3000,
    height: 3000,
  };
  const grey: StoryEntry = { id: 'd', palette: ['#777777'], width: 6000, height: 4000 };
  const none: StoryEntry = { id: 'e' };
  const all = [none, grey, blueLight, red, blueDark];

  it('colour: the dominant hue family, then lightness; greys after hues; no palette last', () => {
    expect(order(all, 'colour')).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('luminance: median luma, dark to light; aspect: portrait to landscape', () => {
    expect(order(all, 'luminance')).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(order(all, 'aspect')).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('warmth: the mean Oklab b of the palette, cool to warm', () => {
    expect(order(all, 'warmth')).toEqual(['b', 'a', 'd', 'c', 'e']);
    expect(paletteWarmth(red)).toBeGreaterThan(0);
    expect(paletteWarmth(blueDark)).toBeLessThan(0);
  });

  it('rating and sharpness put the best first; time and name are the tie-break alone', () => {
    const rated = [
      { id: 'x', rating: 2, stats: { sharpnessMax: 10 } },
      { id: 'y', rating: 5, stats: { sharpnessMax: 5 } },
      { id: 'z' },
    ];
    expect(order(rated, 'rating')).toEqual(['y', 'x', 'z']);
    expect(order(rated, 'sharpness')).toEqual(['x', 'y', 'z']);
    expect(order([...rated].reverse(), 'name')).toEqual(['x', 'y', 'z']);
  });

  it('never changes the items (ids stay as they are)', () => {
    const copy = structuredClone(all);
    order(all, 'colour');
    expect(all).toEqual(copy);
  });
});

describe('storyGroups', () => {
  const entries: StoryEntry[] = [
    { id: 'a', palette: ['#102050'], width: 4000, height: 6000, taken: Date.UTC(2026, 8, 14, 18) },
    { id: 'b', palette: ['#c02020'], width: 3000, height: 3000, taken: Date.UTC(2026, 8, 14, 19) },
    { id: 'c', palette: ['#2040a0'], width: 6000, height: 4000, taken: Date.UTC(2026, 8, 15, 9) },
    { id: 'd' },
  ];

  it('colour family and aspect, in first-seen order, unknowns last', () => {
    expect(storyGroups(entries, 'colour').map((s) => [s.label, s.ids])).toEqual([
      ['Blue', ['a', 'c']],
      ['Red', ['b']],
      ['No palette yet', ['d']],
    ]);
    expect(storyGroups(entries, 'aspect').map((s) => [s.label, s.ids])).toEqual([
      ['Portrait', ['a']],
      ['Square', ['b']],
      ['Landscape', ['c']],
      ['Unknown size', ['d']],
    ]);
    expect(aspectClass(1.02)).toBe('square');
  });

  it('day, place and camera come from plan 53’s groupBy; none is one section', () => {
    expect(storyGroups(entries, 'day').map((s) => s.ids)).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(storyGroups(entries, 'none')).toEqual([{ key: 'all', label: '', ids: ['a', 'b', 'c', 'd'] }]);
    expect(storyGroups([], 'none')).toEqual([]);
  });
});
