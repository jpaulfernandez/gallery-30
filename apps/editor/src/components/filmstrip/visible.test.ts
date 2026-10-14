import type { Asset, Page } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import type { AssetFile } from '../../store/assets';
import { DEFAULT_FILMSTRIP } from '../../store/ui';
import { filtersActive, gridRows, type Item, itemSections, usedAssetIds, visibleItems } from './visible';

const file = (relPath: string, assetId: string, mtime: number): AssetFile => ({
  relPath,
  assetId,
  mtime,
  size: 1,
  kind: 'jpeg',
  status: 'ready',
});

const files: Record<string, AssetFile> = {
  'b.jpg': file('b.jpg', 'B', 1),
  'a.jpg': file('a.jpg', 'A', 3),
  'c.jpg': file('c.jpg', 'C', 2),
  'd.jpg': file('d.jpg', 'D', 4),
};
const assets: Record<string, Asset> = {
  A: { path: 'a.jpg', folder: 'F', rating: 5, flag: 'pick' },
  B: { path: 'b.jpg', folder: 'F', rating: 2, flag: 'reject' },
  C: { path: 'c.jpg', folder: 'F', rating: 3 },
  M: { path: 'gone.jpg', folder: 'F', rating: 4 },
};
const missing = { M: { assetId: 'M', path: 'gone.jpg' } };
const used = new Set(['C', 'M']);

const ids = (items: Item[]) => items.map((i) => (i.kind === 'file' ? i.file.assetId : `missing:${i.asset.assetId}`));
const show = (view: Partial<typeof DEFAULT_FILMSTRIP>) =>
  ids(visibleItems(files, missing, assets, used, { ...DEFAULT_FILMSTRIP, ...view }));

describe('visibleItems', () => {
  it('lists missing photos first, then files by capture time or name', () => {
    expect(show({})).toEqual(['missing:M', 'B', 'C', 'A', 'D']);
    expect(show({ sort: 'name' })).toEqual(['missing:M', 'A', 'B', 'C', 'D']);
  });

  it('sorts by the Exif capture time when a photo has one, else by its mtime (plan 38)', () => {
    const taken = { ...files, 'd.jpg': { ...file('d.jpg', 'D', 4), taken: 0 } };
    const order = ids(visibleItems(taken, {}, assets, used, DEFAULT_FILMSTRIP));
    expect(order).toEqual(['D', 'B', 'C', 'A']);
  });

  it('hides used photos', () => {
    expect(show({ hideUsed: true })).toEqual(['B', 'A', 'D']);
  });

  it('filters by flag', () => {
    expect(show({ flag: 'no-rejects' })).toEqual(['missing:M', 'C', 'A', 'D']);
    expect(show({ flag: 'picks' })).toEqual(['A']);
    expect(show({ flag: 'rejects' })).toEqual(['B']);
  });

  it('filters by minimum rating (unrated counts as 0)', () => {
    expect(show({ minRating: 3 })).toEqual(['missing:M', 'C', 'A']);
    expect(show({ minRating: 5 })).toEqual(['A']);
  });

  it('combines search with the filters', () => {
    expect(show({ query: ' A.JPG ', minRating: 1 })).toEqual(['A']);
    expect(show({ query: 'jpg', hideUsed: true, flag: 'no-rejects' })).toEqual(['A', 'D']);
  });
});

describe('filtersActive', () => {
  it('ignores search and sort', () => {
    expect(filtersActive({ ...DEFAULT_FILMSTRIP, query: 'x', sort: 'name' })).toBe(false);
    expect(filtersActive({ ...DEFAULT_FILMSTRIP, hideUsed: true })).toBe(true);
    expect(filtersActive({ ...DEFAULT_FILMSTRIP, flag: 'picks' })).toBe(true);
    expect(filtersActive({ ...DEFAULT_FILMSTRIP, minRating: 1 })).toBe(true);
  });
});

describe('usedAssetIds', () => {
  it('collects photo elements and photo backgrounds', () => {
    const pages = [
      {
        background: { asset: 'BG' },
        elements: [
          { type: 'photo', asset: 'P' },
          { type: 'photo', asset: null },
        ],
      },
      { background: '#fff', elements: [{ type: 'text' }] },
    ] as unknown as Page[];
    expect([...usedAssetIds(pages)].sort()).toEqual(['BG', 'P']);
  });
});

describe('storytelling sorts and Group by (plan 56)', () => {
  const coloured: Record<string, AssetFile> = {
    'b.jpg': { ...file('b.jpg', 'B', 1), palette: ['#c02020'], width: 3000, height: 2000 },
    'a.jpg': { ...file('a.jpg', 'A', 3), palette: ['#2040a0'], width: 2000, height: 3000 },
    'c.jpg': { ...file('c.jpg', 'C', 2), palette: ['#102050'], width: 3000, height: 2000 },
    'd.jpg': file('d.jpg', 'D', 4),
  };
  const sorted = (view: Partial<typeof DEFAULT_FILMSTRIP>) =>
    visibleItems(coloured, missing, assets, used, { ...DEFAULT_FILMSTRIP, ...view });

  it('sorts by colour (hue family, then lightness), rating, aspect; photos without the fact last', () => {
    expect(ids(sorted({ sort: 'colour' }))).toEqual(['missing:M', 'B', 'C', 'A', 'D']);
    expect(ids(sorted({ sort: 'rating' }))).toEqual(['missing:M', 'A', 'C', 'B', 'D']);
    expect(ids(sorted({ sort: 'aspect' }))).toEqual(['missing:M', 'A', 'B', 'C', 'D']);
  });

  it('groups into labelled sections, missing photos first, and lays them out as divider and cell rows', () => {
    const sections = itemSections(sorted({}), 'colour');
    expect(sections.map((s) => [s.label, ids(s.items)])).toEqual([
      ['', ['missing:M']],
      ['Red', ['B']],
      ['Blue', ['C', 'A']],
      ['No palette yet', ['D']],
    ]);
    const rows = gridRows(sections, 3);
    expect(rows.map((r) => (r.kind === 'divider' ? `${r.label} ${r.count}` : ids(r.items).join(',')))).toEqual([
      'missing:M',
      'Red 1',
      'B',
      'Blue 2',
      'C,A',
      'No palette yet 1',
      'D',
    ]);
    expect(itemSections(sorted({}), undefined).map((s) => s.label)).toEqual(['', '']);
  });
});
