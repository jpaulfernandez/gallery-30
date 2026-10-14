// Plan 38: `photobook stats <folder>`, a debug listing of the capture facts and photo stats the editor keeps in
// `<folder>/.photobook/index.json` (written by the editor's prepare pass; this command reads, never writes).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IndexStats {
  sharpness: number;
  sharpnessMax: number;
  sharpestTile: number;
  motion: number;
  clipHigh: number;
  clipLow: number;
  medianLum: number;
}

/** The fields of one index entry this command shows (the index holds more). */
export interface IndexedPhoto {
  path: string;
  mtime: number;
  taken?: number;
  make?: string;
  model?: string;
  lens?: string;
  focal?: number;
  phash?: string;
  stats?: IndexStats;
}

/** The folder's indexed photos in capture order (`taken`, else mtime, then path). */
export async function readFolderStats(folder: string): Promise<IndexedPhoto[]> {
  const file = join(folder, '.photobook', 'index.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`${file} not found: open the folder in the editor first`);
  }
  const index = JSON.parse(text) as { version?: number; photos?: Record<string, Omit<IndexedPhoto, 'path'>> };
  if (index.version !== 1 || typeof index.photos !== 'object' || index.photos === null) {
    throw new Error(`${file} is not a version 1 photo index`);
  }
  const photos = Object.entries(index.photos).map(([path, e]) => ({ ...e, path }));
  const time = (p: IndexedPhoto) => p.taken ?? p.mtime;
  return photos.sort((a, b) => time(a) - time(b) || a.path.localeCompare(b.path));
}

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

/** One line a photo: time, camera and lens, hash, then the stats (`-` for what the index does not hold yet). */
export function formatFolderStats(photos: IndexedPhoto[]): string {
  return photos
    .map((p) => {
      const time = p.taken !== undefined ? new Date(p.taken).toISOString().replace('T', ' ').slice(0, 23) : '-';
      const camera = [p.make, p.model].filter(Boolean).join(' ') || '-';
      const lens = [p.lens, p.focal !== undefined ? `${p.focal}mm` : undefined].filter(Boolean).join(' ') || '-';
      const s = p.stats;
      const stats = s
        ? `sharp ${s.sharpness.toFixed(1)}/${s.sharpnessMax.toFixed(1)} tile ${s.sharpestTile} motion ${s.motion.toFixed(2)} ` +
          `clip ${pct(s.clipHigh)}/${pct(s.clipLow)} median ${s.medianLum.toFixed(2)}`
        : 'no stats';
      return [p.path, time, camera, lens, p.phash ?? '-', stats].join('  ');
    })
    .join('\n');
}
