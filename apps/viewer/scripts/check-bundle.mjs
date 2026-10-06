#!/usr/bin/env node
/**
 * Bundle budget (PRD: JavaScript shipped to the viewer under 100 KB gzipped). Gzips every JS file
 * in dist/assets and fails when the total is over the limit. Lazy chunks count too: a friend on a
 * phone downloads them as soon as they open the grid or a photo.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT = 100 * 1024;
const dir = fileURLToPath(new URL('../dist/assets', import.meta.url));

const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
  console.error('check-bundle: no JS files in dist/assets (run `vite build` first)');
  process.exit(1);
}

let total = 0;
const rows = files
  .map((f) => {
    const gz = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
    total += gz;
    return { f, gz };
  })
  .sort((a, b) => b.gz - a.gz);

for (const { f, gz } of rows) console.log(`${(gz / 1024).toFixed(1).padStart(7)} KB  ${f}`);
console.log(`${(total / 1024).toFixed(1).padStart(7)} KB  total (gzip), budget ${LIMIT / 1024} KB`);

if (total > LIMIT) {
  console.error(`check-bundle: over budget by ${((total - LIMIT) / 1024).toFixed(1)} KB`);
  process.exit(1);
}
