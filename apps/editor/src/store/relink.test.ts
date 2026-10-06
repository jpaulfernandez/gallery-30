import type { Asset, Book } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { type HashMany, planRelinks, referencedAssetIds, relativeInside, type ScannedLike } from './relink';

const asset = (path: string, hash: string | undefined, size: number | undefined): Asset => ({
  path,
  ...(hash !== undefined ? { hash } : {}),
  ...(size !== undefined ? { size } : {}),
});

/** hashMany over a fixed table; records what it was asked to hash. */
function hasher(table: Record<string, string>) {
  const asked: string[][] = [];
  const hashMany = async (relPaths: string[]) => {
    asked.push(relPaths);
    return new Map(relPaths.map((p) => [p, table[p] ?? null] as const));
  };
  return { hashMany, asked };
}

/** planRelinks with every asset in use (so nothing is pruned). */
const planUsed = (assets: Record<string, Asset>, scanned: ScannedLike[], hashMany: HashMany) =>
  planRelinks(assets, scanned, hashMany, new Set(Object.keys(assets)));

describe('planRelinks', () => {
  it('leaves assets whose path is still scanned alone and hashes nothing', async () => {
    const { hashMany, asked } = hasher({});
    const plan = await planUsed({ a: asset('a.jpg', 'h1', 10) }, [{ relPath: 'a.jpg', size: 10 }], hashMany);
    expect(plan).toMatchObject({ relinks: [], missing: [], added: [] });
    expect(asked).toEqual([]);
  });

  it('relinks a renamed file by size then hash, keeping the asset id', async () => {
    const { hashMany, asked } = hasher({ 'trip/new.jpg': 'h1', 'other.jpg': 'zz' });
    const plan = await planUsed(
      { a: asset('old.jpg', 'h1', 10), b: asset('b.jpg', 'h2', 20) },
      [
        { relPath: 'b.jpg', size: 20 },
        { relPath: 'other.jpg', size: 11 },
        { relPath: 'trip/new.jpg', size: 10 },
      ],
      hashMany,
    );
    expect(plan.relinks).toEqual([{ assetId: 'a', from: 'old.jpg', to: 'trip/new.jpg' }]);
    expect(plan.missing).toEqual([]);
    // Only the unclaimed file with a matching size was hashed; the relink target is not "added".
    expect(asked).toEqual([['trip/new.jpg']]);
    expect(plan.added).toEqual(['other.jpg']);
    expect(plan.hashes.get('trip/new.jpg')).toBe('h1');
  });

  it('marks an asset missing when no same-size file has the same hash', async () => {
    const { hashMany } = hasher({ 'x.jpg': 'different' });
    const plan = await planUsed({ a: asset('old.jpg', 'h1', 10) }, [{ relPath: 'x.jpg', size: 10 }], hashMany);
    expect(plan.relinks).toEqual([]);
    expect(plan.missing).toEqual([{ assetId: 'a', path: 'old.jpg', hash: 'h1', size: 10 }]);
    expect(plan.added).toEqual(['x.jpg']);
  });

  it('marks assets without a recorded hash or size missing without hashing', async () => {
    const { hashMany, asked } = hasher({});
    const plan = await planUsed(
      { a: asset('a.jpg', undefined, 10), b: asset('b.jpg', 'h', undefined) },
      [{ relPath: 'z.jpg', size: 10 }],
      hashMany,
    );
    expect(plan.missing.map((m) => m.assetId)).toEqual(['a', 'b']);
    expect(asked).toEqual([]);
  });

  it('never relinks onto a path another asset already owns, and uses each file once', async () => {
    const { hashMany } = hasher({ 'copy.jpg': 'h1' });
    const plan = await planUsed(
      { a: asset('gone-1.jpg', 'h1', 10), b: asset('gone-2.jpg', 'h1', 10), c: asset('kept.jpg', 'h1', 10) },
      [
        { relPath: 'kept.jpg', size: 10 },
        { relPath: 'copy.jpg', size: 10 },
      ],
      hashMany,
    );
    expect(plan.relinks).toEqual([{ assetId: 'a', from: 'gone-1.jpg', to: 'copy.jpg' }]);
    expect(plan.missing.map((m) => m.assetId)).toEqual(['b']);
    expect(plan.added).toEqual([]);
  });

  it('prefers the candidate that kept the file name', async () => {
    const { hashMany } = hasher({ 'a/IMG.jpg': 'h', 'b/IMG_1.jpg': 'h', 'c/IMG.jpg': 'h' });
    const plan = await planUsed(
      { a: asset('old/img.jpg', 'h', 5) },
      [
        { relPath: 'a/IMG.jpg', size: 5 },
        { relPath: 'b/IMG_1.jpg', size: 5 },
        { relPath: 'c/IMG.jpg', size: 5 },
      ],
      hashMany,
    );
    expect(plan.relinks).toEqual([{ assetId: 'a', from: 'old/img.jpg', to: 'a/IMG.jpg' }]);
    expect(plan.added).toEqual(['b/IMG_1.jpg', 'c/IMG.jpg']);
  });

  it('prunes unused assets whose file vanished instead of marking them missing', async () => {
    const { hashMany } = hasher({ 'moved.jpg': 'h2' });
    const plan = await planRelinks(
      {
        used: asset('gone-a.jpg', 'h1', 10),
        unused: asset('gone-b.jpg', 'h3', 10),
        movedUnused: asset('m.jpg', 'h2', 10),
      },
      [{ relPath: 'moved.jpg', size: 10 }],
      hashMany,
      new Set(['used']),
    );
    expect(plan.missing.map((m) => m.assetId)).toEqual(['used']);
    expect(plan.pruned).toEqual(['unused']);
    // An unused asset that only moved still relinks (its hash is reused).
    expect(plan.relinks).toEqual([{ assetId: 'movedUnused', from: 'm.jpg', to: 'moved.jpg' }]);
  });

  it('lets used assets claim a duplicate file before unused ones', async () => {
    const { hashMany } = hasher({ 'copy.jpg': 'h' });
    const plan = await planRelinks(
      { unused: asset('a.jpg', 'h', 10), used: asset('b.jpg', 'h', 10) },
      [{ relPath: 'copy.jpg', size: 10 }],
      hashMany,
      new Set(['used']),
    );
    expect(plan.relinks).toEqual([{ assetId: 'used', from: 'b.jpg', to: 'copy.jpg' }]);
    expect(plan.pruned).toEqual(['unused']);
    expect(plan.missing).toEqual([]);
  });

  it('treats an unreadable candidate as no match', async () => {
    const hashMany = async (relPaths: string[]) => new Map(relPaths.map((p) => [p, null] as const));
    const plan = await planUsed({ a: asset('old.jpg', 'h', 5) }, [{ relPath: 'n.jpg', size: 5 }], hashMany);
    expect(plan.missing).toHaveLength(1);
  });
});

describe('referencedAssetIds', () => {
  it('collects photo element and page background assets, not empty slots or text', () => {
    const pages = [
      {
        id: 'p1',
        layout: 'x',
        background: { asset: 'bg' },
        elements: [
          { type: 'photo', id: 'e1', asset: 'a', frame: { x: 0, y: 0, w: 1, h: 1 } },
          { type: 'photo', id: 'e2', asset: null, frame: { x: 0, y: 0, w: 1, h: 1 } },
          { type: 'text', id: 't', text: 'hi' },
        ],
      },
      { id: 'p2', layout: 'x', background: '#fff', elements: [] },
    ] as unknown as Book['pages'];
    expect([...referencedAssetIds({ pages })].sort()).toEqual(['a', 'bg']);
  });
});

describe('relativeInside', () => {
  it('returns the /-separated path inside the folder', () => {
    expect(relativeInside('/Users/me/trip', '/Users/me/trip/day1/a.jpg')).toBe('day1/a.jpg');
    expect(relativeInside('/Users/me/trip/', '/Users/me/trip/a.jpg')).toBe('a.jpg');
    expect(relativeInside('C:\\photos\\trip', 'C:\\photos\\trip\\day1\\a.jpg')).toBe('day1/a.jpg');
  });

  it('rejects files outside the folder, siblings with the same prefix, and traversal', () => {
    expect(relativeInside('/Users/me/trip', '/Users/me/other/a.jpg')).toBeNull();
    expect(relativeInside('/Users/me/trip', '/Users/me/trip-2/a.jpg')).toBeNull();
    expect(relativeInside('/Users/me/trip', '/Users/me/trip/../x/a.jpg')).toBeNull();
    expect(relativeInside('/Users/me/trip', '/Users/me/trip')).toBeNull();
  });
});
