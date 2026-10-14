import { type Book, createEmptyBook, createEmptyPage, parseManifest } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import type { FrozenAsset } from './freeze.js';
import type { ImageMeta } from './images.js';
import { buildManifest, type ProcessedAsset } from './manifest.js';

/** Plan 35: the manifest publishes each photo's alt text; pages and their renders do not change. */

const BASE = 'https://cdn.example.test';

function processedAsset(id: string): ProcessedAsset {
  const asset: FrozenAsset = {
    id,
    relPath: `${id}.jpg`,
    folder: 'F1',
    root: '/photos',
    absPath: `/photos/${id}.jpg`,
    filename: `${id}.jpg`,
    hash: `${id}`.padEnd(64, '0'),
    size: 100,
    mtime: 0,
    kind: 'jpeg',
  };
  const meta: ImageMeta = {
    version: 1,
    width: 3000,
    height: 2000,
    download: { file: 'download.jpg', bytes: 100, maxEdge: 4096, quality: 88 },
    share: { file: 'share.jpg', bytes: 50, width: 2048, height: 1365 },
    ladder: [{ w: 480, width: 480, height: 320, avif: 10, webp: 12 }],
    placeholder: 'data:image/webp;base64,AAAA',
  };
  return { asset, meta };
}

function book(): Book {
  const b = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: '/photos' } } });
  b.publish.slug = 'lisbon';
  b.assets = {
    a1: { path: 'a1.jpg', folder: 'F1', hash: 'a1'.padEnd(64, '0'), alt: '  Two friends on\n the  28 tram.  ' },
    a2: { path: 'a2.jpg', folder: 'F1', hash: 'a2'.padEnd(64, '0') },
    a3: { path: 'a3.jpg', folder: 'F1', hash: 'a3'.padEnd(64, '0'), alt: '   ' },
  } as Book['assets'];
  const page = createEmptyPage();
  page.elements = ['a1', 'a2', 'a3'].map((asset, i) => ({
    type: 'photo' as const,
    id: `e${i}`,
    asset,
    frame: { x: 0, y: i / 3, w: 1, h: 1 / 3 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none' as const,
  }));
  b.pages = [page];
  return b;
}

describe('buildManifest alt text', () => {
  it('adds the trimmed alt of each photo that has one and leaves the others without', () => {
    const b = book();
    const processed = new Map(['a1', 'a2', 'a3'].map((id) => [id, processedAsset(id)]));
    const manifest = buildManifest(b, BASE, processed, '2026-10-13T10:00:00.000Z');
    expect(manifest.images.a1?.alt).toBe('Two friends on the 28 tram.');
    expect(manifest.images.a2 && 'alt' in manifest.images.a2).toBe(false);
    expect(manifest.images.a3 && 'alt' in manifest.images.a3).toBe(false);
    // It survives the JSON the viewer fetches, and pages carry no alt of their own.
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.images.a1?.alt).toBe('Two friends on the 28 tram.');
    expect(JSON.stringify(parsed.pages)).not.toContain('tram');
  });
});
