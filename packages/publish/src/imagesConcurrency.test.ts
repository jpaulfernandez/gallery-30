import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrozenAsset } from './freeze.js';
import { outDir, processAsset, readMeta } from './images.js';
import { workDir } from './paths.js';

/** Workflow plan 14: a publish and a post export may process the same photo at the same time. */

const OPTIONS = { downloadMaxEdge: 1600, downloadQuality: 90 };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'photobook-images-race-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function asset(path: string, hash: string): FrozenAsset {
  return {
    id: hash,
    relPath: 'p.jpg',
    folder: 'f',
    root: '/',
    absPath: path,
    filename: 'p.jpg',
    hash,
    size: 1,
    mtime: 0,
    kind: 'jpeg',
  };
}

describe('processAsset side by side', () => {
  it('two calls on the same photo both finish with one complete output and no temp folders', async () => {
    const src = join(dir, 'p.jpg');
    await writeFile(
      src,
      await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#4080c0' } })
        .jpeg()
        .toBuffer(),
    );
    const project = join(dir, 'book.photobook.json');
    const hash = 'e'.repeat(64);
    const [a, b] = await Promise.all([
      processAsset(asset(src, hash), project, OPTIONS),
      processAsset(asset(src, hash), project, OPTIONS),
    ]);
    expect(a.meta).toEqual(b.meta);
    const out = outDir(project, hash);
    expect(await readMeta(out, OPTIONS)).toEqual(a.meta);
    const left = await readdir(join(workDir(project), 'out'));
    expect(left).toEqual([hash]);
    // A third call reads the cache.
    expect((await processAsset(asset(src, hash), project, OPTIONS)).cached).toBe(true);
  });

  it('replaces a partial output folder left by a crash', async () => {
    const src = join(dir, 'p.jpg');
    await writeFile(
      src,
      await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } })
        .jpeg()
        .toBuffer(),
    );
    const project = join(dir, 'book.photobook.json');
    const hash = 'f'.repeat(64);
    const out = outDir(project, hash);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'share.jpg'), 'half');
    const { meta, cached } = await processAsset(asset(src, hash), project, OPTIONS);
    expect(cached).toBe(false);
    expect(await readMeta(out, OPTIONS)).toEqual(meta);
  });
});
