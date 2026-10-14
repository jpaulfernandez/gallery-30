/**
 * Built-in looks (workflow plan 21): the data is valid develop settings within every slider's range, ids and names are
 * unique birds, no film brand appears, and each look's full-strength settings are written to
 * `crates/develop/tests/fixtures/looks/<id>.json` (`{ settings, canonical, hash }`, the parity format) so the Rust
 * mirror reads them and renders them (`crates/develop/tests/effects.rs`). Regenerate with
 * `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test`.
 *
 * The Amount-0 check (applying any look at 0 leaves an untouched photo's develop hash unchanged) needs the editor's
 * `applyLook` and lives in `apps/editor/src/lib/develop/builtInLooks.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_LOOK_DEFS,
  BUILT_IN_LOOK_SECTIONS,
  builtInLookPresetId,
  builtInLookSettings,
  DevelopSchema,
  developHash,
  developHashInput,
  formatLookList,
  hashableDevelop,
} from './index.js';

interface Fs {
  existsSync(path: URL): boolean;
  mkdirSync(path: URL, options: { recursive: true }): void;
  readFileSync(path: URL, encoding: 'utf8'): string;
  writeFileSync(path: URL, data: string): void;
}
const fs = (await import('node:fs' as string)) as Fs;
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

const FIXTURES = new URL('../../../../crates/develop/tests/fixtures/looks/', import.meta.url);

/** Every leaf of `value` as `[path, leaf]` (arrays are leaves: curves are compared whole). */
function leaves(value: unknown, path = ''): [string, unknown][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  }
  return [[path, value]];
}

function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], value);
}

/** Film stock and maker names the looks must never use (names, ids, descriptions). */
const BRANDS =
  /\b(kodak|fuji\w*|portra|ektar|ektachrome|kodachrome|velvia|provia|astia|superia|pro ?400h|cinestill|ilford|tri-?x|hp5|agfa|polaroid|instax|leica|hasselblad|lomo\w*|vision3|eterna|classic chrome|acros|t-?max|ultramax|colorplus)\b/i;

describe('built-in looks', () => {
  it('has ten to twelve looks with unique bird ids and names', () => {
    const looks = BUILT_IN_LOOK_DEFS;
    expect(looks.length).toBeGreaterThanOrEqual(10);
    expect(looks.length).toBeLessThanOrEqual(12);
    expect(new Set(looks.map((l) => l.id)).size).toBe(looks.length);
    expect(new Set(looks.map((l) => l.name.toLowerCase())).size).toBe(looks.length);
    for (const look of looks) {
      expect(look.id).toMatch(/^[a-z]+$/);
      expect(look.name.toLowerCase()).toBe(look.id);
      expect(look.name[0]).toBe(look.name[0]?.toUpperCase());
      expect(look.about.length).toBeGreaterThan(10);
      expect(builtInLookPresetId(look.id)).toBe(`builtin:${look.id}`);
      expect(builtInLookPresetId(look.id).length).toBeLessThanOrEqual(64);
    }
  });

  it('never names a film brand', () => {
    for (const look of BUILT_IN_LOOK_DEFS) {
      expect(`${look.id} ${look.name} ${look.about}`).not.toMatch(BRANDS);
    }
  });

  it('every look parses against the schema and keeps every value it sets', () => {
    for (const look of BUILT_IN_LOOK_DEFS) {
      expect(() => DevelopSchema.partial().parse(look.settings), look.id).not.toThrow();
      const full = builtInLookSettings(look);
      // Nothing is dropped as an unknown key (a typo would parse and silently do nothing).
      for (const [path, value] of leaves(look.settings)) expect(at(full, path), `${look.id} ${path}`).toEqual(value);
      for (const key of Object.keys(look.settings)) {
        expect(BUILT_IN_LOOK_SECTIONS as readonly string[], `${look.id} ${key}`).toContain(key);
      }
    }
  });

  it('every value is within its slider range, curves rise left to right, amounts are percents', () => {
    for (const look of BUILT_IN_LOOK_DEFS) {
      // The schema's sliders have min and max: parsing is the range check (it throws outside).
      expect(DevelopSchema.safeParse({ version: 1, ...look.settings }).success, look.id).toBe(true);
      expect(Number.isInteger(look.amount) && look.amount > 0 && look.amount <= 100, look.id).toBe(true);
      const curve = builtInLookSettings(look).curve;
      for (const channel of ['luma', 'red', 'green', 'blue'] as const) {
        const points = curve[channel];
        expect(points[0]?.[0], `${look.id} ${channel}`).toBe(0);
        expect(points[points.length - 1]?.[0], `${look.id} ${channel}`).toBe(1);
        for (let i = 1; i < points.length; i++) {
          expect((points[i]?.[0] ?? 0) > (points[i - 1]?.[0] ?? 1), `${look.id} ${channel} x`).toBe(true);
          expect((points[i]?.[1] ?? 0) >= (points[i - 1]?.[1] ?? 1), `${look.id} ${channel} y`).toBe(true);
        }
      }
    }
  });

  it('every look changes the render and carries the effects', () => {
    const halation = BUILT_IN_LOOK_DEFS.filter((l) => (l.settings.effects?.halation?.amount ?? 0) > 0);
    expect(halation.map((l) => l.id).sort()).toEqual(['kestrel', 'owl']);
    for (const look of BUILT_IN_LOOK_DEFS) {
      expect(look.settings.effects?.grain?.amount ?? 0, look.id).toBeGreaterThan(0);
      expect(look.settings.curve, look.id).toBeDefined();
      expect(look.settings.color, look.id).toBeDefined();
    }
  });

  it('the CLI list', () => {
    expect(formatLookList()).toMatchSnapshot();
  });
});

describe('built-in look fixtures for the Rust mirror', () => {
  const update = Boolean(env.UPDATE_DEVELOP_FIXTURES);
  if (update) fs.mkdirSync(FIXTURES, { recursive: true });

  for (const look of BUILT_IN_LOOK_DEFS) {
    it(`looks/${look.id}.json matches the look at full strength`, async () => {
      const settings = builtInLookSettings(look);
      const text = `${JSON.stringify(
        {
          settings: hashableDevelop(settings),
          canonical: developHashInput(settings),
          hash: await developHash(settings),
        },
        null,
        2,
      )}\n`;
      const file = new URL(`${look.id}.json`, FIXTURES);
      if (update) fs.writeFileSync(file, text);
      expect(fs.existsSync(file), `looks/${look.id}.json is missing; run with UPDATE_DEVELOP_FIXTURES=1`).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });
  }
});
