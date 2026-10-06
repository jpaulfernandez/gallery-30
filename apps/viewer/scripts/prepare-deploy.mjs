// Turn `dist/` into a Vercel Build Output (`.vercel/output`) so `vercel deploy --prebuilt` uploads the
// static shell without a remote build: every path serves index.html unless a file exists.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('.vercel/output', { recursive: true, force: true });
mkdirSync('.vercel/output', { recursive: true });
cpSync('dist', '.vercel/output/static', { recursive: true });
writeFileSync(
  '.vercel/output/config.json',
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/assets/(.*)', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  )}\n`,
);
console.log('prepared .vercel/output');
