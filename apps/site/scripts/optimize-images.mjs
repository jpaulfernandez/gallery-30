#!/usr/bin/env node
/**
 * Turns the raw screenshots in `apps/site/shots/` (git-ignored PNGs) into the AVIF and WebP sizes the
 * page loads from `public/img/`. Uses the `sharp` that packages/publish already depends on.
 *
 *   node apps/site/scripts/optimize-images.mjs
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../packages/publish/package.json'));
const sharp = require('sharp');

const SHOTS = join(here, '..', 'shots');
const OUT = join(here, '..', 'public', 'img');
mkdirSync(OUT, { recursive: true });

const JOBS = [
  { src: 'editor-selected.png', name: 'editor', widths: [1440, 2880] },
  { src: 'editor-layouts3.png', name: 'editor-layouts', widths: [1440, 2880] },
  { src: 'viewer-p2.png', name: 'viewer-page', widths: [600, 900] },
  { src: 'viewer-p4.png', name: 'viewer-spread', widths: [600, 900] },
  { src: 'viewer-drawer.png', name: 'viewer-drawer', widths: [600, 900] },
  { src: 'viewer-grid.png', name: 'viewer-grid', widths: [600, 900] },
];

for (const job of JOBS) {
  for (const width of job.widths) {
    const base = sharp(join(SHOTS, job.src)).resize({ width });
    await base
      .clone()
      .avif({ quality: 55, effort: 6 })
      .toFile(join(OUT, `${job.name}-${width}.avif`));
    await base
      .clone()
      .webp({ quality: 78 })
      .toFile(join(OUT, `${job.name}-${width}.webp`));
  }
  console.log(job.name);
}
