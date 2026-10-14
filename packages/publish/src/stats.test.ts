import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFolderStats, readFolderStats } from './stats';

// Plan 38: `photobook stats <folder>` lists the index fields in capture order.
describe('photobook stats', () => {
  it('reads the index in capture order and prints one line a photo', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'photobook-stats-'));
    await mkdir(join(folder, '.photobook'));
    const hash = 'a'.repeat(64);
    const stats = {
      sharpness: 12.5,
      sharpnessMax: 80.25,
      sharpestTile: 19,
      motion: 0.75,
      clipHigh: 0.021,
      clipLow: 0,
      medianLum: 0.5,
    };
    const photos = {
      'late.jpg': { hash, size: 1, mtime: 5, kind: 'jpeg', taken: 1_791_885_601_050 },
      'early.jpg': {
        hash,
        size: 1,
        mtime: 9,
        kind: 'jpeg',
        taken: 1_791_885_600_050,
        make: 'Fujifilm',
        model: 'X-T5',
        lens: 'XF23mmF1.4',
        focal: 23,
        phash: '0d3d5cd915da4734',
        stats,
      },
      'no-exif.png': { hash, size: 1, mtime: 1, kind: 'png' },
    };
    await writeFile(join(folder, '.photobook', 'index.json'), JSON.stringify({ version: 1, photos }));
    const read = await readFolderStats(folder);
    expect(read.map((p) => p.path)).toEqual(['no-exif.png', 'early.jpg', 'late.jpg']);
    const lines = formatFolderStats(read).split('\n');
    expect(lines[1]).toBe(
      'early.jpg  2026-10-13 10:00:00.050  Fujifilm X-T5  XF23mmF1.4 23mm  0d3d5cd915da4734  ' +
        'sharp 12.5/80.3 tile 19 motion 0.75 clip 2.1%/0.0% median 0.50',
    );
    expect(lines[0]).toBe('no-exif.png  -  -  -  -  no stats');
  });

  it('says so when the folder has no index', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'photobook-stats-'));
    await expect(readFolderStats(folder)).rejects.toThrow(/open the folder in the editor first/);
  });
});
