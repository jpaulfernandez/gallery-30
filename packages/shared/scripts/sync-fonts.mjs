// Copies the latin WOFF2 files from the fontsource devDependencies into ./fonts.
// The copied files are committed, so apps work offline without this script;
// re-run it (`pnpm --filter @photobook/shared fonts:sync`) only to update fonts.
import { copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts');

const files = [
  ['@fontsource-variable/inter', 'files/inter-latin-wght-normal.woff2', 'inter-variable.woff2'],
  ['@fontsource-variable/inter', 'files/inter-latin-wght-italic.woff2', 'inter-variable-italic.woff2'],
  ['@fontsource-variable/fraunces', 'files/fraunces-latin-wght-normal.woff2', 'fraunces-variable.woff2'],
  ['@fontsource-variable/fraunces', 'files/fraunces-latin-wght-italic.woff2', 'fraunces-variable-italic.woff2'],
  [
    '@fontsource-variable/jetbrains-mono',
    'files/jetbrains-mono-latin-wght-normal.woff2',
    'jetbrains-mono-variable.woff2',
  ],
  ['@fontsource/instrument-serif', 'files/instrument-serif-latin-400-normal.woff2', 'instrument-serif-regular.woff2'],
  ['@fontsource/instrument-serif', 'files/instrument-serif-latin-400-italic.woff2', 'instrument-serif-italic.woff2'],
];

for (const [pkg, rel, out] of files) {
  const src = join(dirname(require.resolve(`${pkg}/package.json`)), rel);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(outDir, out));
  console.log(`fonts/${out}`);
}
