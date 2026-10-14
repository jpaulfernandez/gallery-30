import {
  BUILT_IN_LOOK_DEFS,
  createDevelop,
  DevelopSchema,
  developHash,
  developHashInput,
  hashableDevelop,
} from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { applyLook, BUILT_IN_LOOKS, builtInLookDef, lookDefaultAmount, makeLook } from './looks';

// Workflow plan 21: the shared built-in looks as read-only look presets.
describe('built-in looks in the editor', () => {
  it('are read-only looks with stable builtin:<bird> ids, in the shared order', () => {
    expect(BUILT_IN_LOOKS.map((l) => l.id)).toEqual(BUILT_IN_LOOK_DEFS.map((l) => `builtin:${l.id}`));
    for (const look of BUILT_IN_LOOKS) {
      expect(look.builtIn).toBe(true);
      expect(look.look).toBe(true);
      expect(look.sections).toEqual(['curve', 'color', 'effects', 'look']);
      expect(builtInLookDef(look.id)?.name).toBe(look.name);
    }
    expect(Object.isFrozen(BUILT_IN_LOOKS)).toBe(true);
  });

  it('applied at Amount 0 leave an untouched photo’s develop hash unchanged', async () => {
    const untouched = await developHash(createDevelop());
    for (const look of BUILT_IN_LOOKS) {
      expect(await developHash(applyLook(createDevelop(), look, 0)), look.id).toBe(untouched);
      expect(await developHash(applyLook(createDevelop(), look, lookDefaultAmount(look))), look.id).not.toBe(untouched);
    }
  });

  it('stay within the slider ranges at every Amount', () => {
    for (const look of BUILT_IN_LOOKS) {
      for (const amount of [1, 33, 50, lookDefaultAmount(look), 100]) {
        const settings = applyLook(createDevelop(), look, amount);
        expect(DevelopSchema.safeParse(settings).success, `${look.id} at ${amount}`).toBe(true);
        expect(settings.look.applied).toEqual({ presetId: look.id, amount });
      }
    }
  });

  it('start at their own Amount; a saved look starts at 100', () => {
    for (const def of BUILT_IN_LOOK_DEFS) expect(lookDefaultAmount({ id: `builtin:${def.id}` })).toBe(def.amount);
    expect(lookDefaultAmount(makeLook('Mine', createDevelop()))).toBe(100);
    expect(lookDefaultAmount(null)).toBe(100);
    expect(lookDefaultAmount({ id: 'builtin:bw' })).toBe(100);
  });
});

// Each look at its starting Amount, scaled by the editor's `applyLook`, written in the parity format to
// `crates/develop/tests/fixtures/looks/start/<bird>.json`; `crates/develop/tests/effects.rs` checks Rust reads them and
// reproduces the hash. Regenerate with `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter editor exec vitest run builtInLooks`.
interface Fs {
  existsSync(path: URL): boolean;
  mkdirSync(path: URL, options: { recursive: true }): void;
  readFileSync(path: URL, encoding: 'utf8'): string;
  writeFileSync(path: URL, data: string): void;
}
const fs = (await import('node:fs' as string)) as Fs;
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const START_FIXTURES = new URL('../../../../../crates/develop/tests/fixtures/looks/start/', import.meta.url);

describe('built-in look fixtures at their starting Amount', () => {
  const update = Boolean(env.UPDATE_DEVELOP_FIXTURES);
  if (update) fs.mkdirSync(START_FIXTURES, { recursive: true });
  for (const look of BUILT_IN_LOOKS) {
    const bird = look.id.replace('builtin:', '');
    it(`looks/start/${bird}.json matches the look at ${lookDefaultAmount(look)} %`, async () => {
      const settings = applyLook(createDevelop(), look, lookDefaultAmount(look));
      const text = `${JSON.stringify(
        {
          settings: hashableDevelop(settings),
          canonical: developHashInput(settings),
          hash: await developHash(settings),
        },
        null,
        2,
      )}\n`;
      const file = new URL(`${bird}.json`, START_FIXTURES);
      if (update) fs.writeFileSync(file, text);
      expect(fs.existsSync(file), `looks/start/${bird}.json is missing; run with UPDATE_DEVELOP_FIXTURES=1`).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
  }
});
