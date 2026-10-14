import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BUILT_IN_LOOK_DEFS, formatLookList } from '@photobook/shared';
import { describe, expect, it } from 'vitest';

// Workflow plan 21: `photobook looks` lists the built-in looks without reading any settings.
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args: string[]) =>
  run(
    fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
    ['--conditions=source', 'bin/photobook.ts', 'looks', ...args],
    {
      cwd: root,
      env: { ...process.env, PHOTOBOOK_ENV: '/nonexistent/photobook.env' },
    },
  );

describe('photobook looks', () => {
  it('prints the list', async () => {
    const { stdout } = await cli();
    expect(stdout.trimEnd()).toBe(formatLookList());
  }, 30_000);

  it('--json prints every look with id, name, about, amount and settings', async () => {
    const { stdout } = await cli('--json');
    const looks = JSON.parse(stdout) as Record<string, unknown>[];
    expect(looks.map((l) => l.id)).toEqual(BUILT_IN_LOOK_DEFS.map((l) => l.id));
    for (const look of looks) {
      expect(Object.keys(look).sort()).toEqual(['about', 'amount', 'id', 'name', 'settings']);
      expect(typeof look.name).toBe('string');
      expect(typeof look.about).toBe('string');
      expect(typeof look.amount).toBe('number');
      expect(Object.keys(look.settings as object).every((k) => ['curve', 'color', 'effects'].includes(k))).toBe(true);
    }
    expect(looks).toEqual(JSON.parse(JSON.stringify(BUILT_IN_LOOK_DEFS)));
  }, 30_000);
});
