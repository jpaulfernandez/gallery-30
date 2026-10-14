import { describe, expect, it } from 'vitest';
import { CollectionFilterSchema, parseSavedCollections } from '../collections.js';
import { newId } from '../ids.js';
import {
  folderStats,
  groupSharpness,
  inLens,
  LENS_CAVEATS,
  type LensEntry,
  type LensStats,
  lensDetail,
  lensesIn,
  lensOf,
} from './lenses.js';

interface Fs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}
const fs = (await import('node:fs' as string)) as Fs;

/**
 * Plan 38's stats fixtures: the clip shares and the median from `crates/develop/tests/fixtures/stats/reference.json`
 * (the Python reference), and `sharpnessMax` as `photo_stats` measures it (printed by
 * `cargo test -p photobook-develop --test stats -- --nocapture`; the reference has no sharpness).
 */
const REFERENCE = JSON.parse(
  fs.readFileSync(new URL('../../../../crates/develop/tests/fixtures/stats/reference.json', import.meta.url), 'utf8'),
) as Record<string, { clipHigh: number; clipLow: number; medianLum: number }>;

const SHARPNESS_MAX: Record<string, number> = {
  'sharp.jpg': 1673.62,
  'defocused.jpg': 4.1,
  'panned.jpg': 39.35,
  'bokeh-portrait.jpg': 1361.88,
  'blown.jpg': 552.99,
  'dark.jpg': 11.21,
  'silhouette.jpg': 2541.37,
  'high-key.jpg': 64.69,
};

const fixture = (name: string, raw = false): LensEntry => {
  const ref = REFERENCE[name];
  const sharpnessMax = SHARPNESS_MAX[name];
  if (!ref || sharpnessMax === undefined) throw new Error(`no fixture ${name}`);
  return { key: name, stats: { sharpnessMax, clipHigh: ref.clipHigh, medianLum: ref.medianLum }, raw };
};

const NAMES = Object.keys(SHARPNESS_MAX);
const FOLDER = folderStats(NAMES.map((n) => fixture(n)));
const verdict = (name: string) => lensOf(fixture(name), FOLDER);

describe('technical lenses on the plan 38 fixtures', () => {
  it('reads every fixture of the reference', () => {
    expect(Object.keys(REFERENCE).sort()).toEqual([...NAMES].sort());
  });

  it('puts the folder’s softest decile in Soft, and never the bokeh portrait', () => {
    // Eight photos: the softest 10 % rounds to one, the defocused frame.
    expect(FOLDER).toEqual({ photos: 8, softCut: 4.1, soft: new Set(['defocused.jpg']) });
    expect(verdict('defocused.jpg')?.soft).toBe(true);
    expect(verdict('bokeh-portrait.jpg')?.soft).toBe(false);
    expect(NAMES.filter((n) => inLens('soft', verdict(n)))).toEqual(['defocused.jpg']);
  });

  it('keeps the silhouette out of both Dark and Blown', () => {
    const v = verdict('silhouette.jpg');
    expect(v?.silhouette).toBe(true);
    expect(inLens('dark', v)).toBe(false);
    expect(inLens('blown', v)).toBe(false);
  });

  it('keeps the high-key frame out of Blown, and finds the blown and the dark frames', () => {
    expect(verdict('high-key.jpg')?.highKey).toBe(true);
    expect(inLens('blown', verdict('high-key.jpg'))).toBe(false);
    expect(verdict('blown.jpg')?.blown).toBe('likely');
    expect(NAMES.filter((n) => inLens('blown', verdict(n)))).toEqual(['blown.jpg']);
    expect(NAMES.filter((n) => inLens('dark', verdict(n)))).toEqual(['dark.jpg']);
    expect(NAMES.filter((n) => inLens('any', verdict(n))).sort()).toEqual(['blown.jpg', 'dark.jpg', 'defocused.jpg']);
  });

  it('marks RAW headroom on a blown RAW only', () => {
    expect(lensOf(fixture('blown.jpg', true), FOLDER)?.rawHeadroom).toBe(true);
    expect(verdict('blown.jpg')?.rawHeadroom).toBe(false);
    expect(lensOf(fixture('sharp.jpg', true), FOLDER)?.rawHeadroom).toBe(false);
  });
});

describe('lens thresholds', () => {
  const stats = (s: Partial<LensStats>): LensEntry => ({
    stats: { sharpnessMax: 500, clipHigh: 0, medianLum: 0.5, ...s },
  });
  const none = { photos: 0, softCut: null, soft: new Set<string>() };

  it('grades Blown at 2 % and 5 %, and a high-key frame clipped over a quarter is still blown', () => {
    expect(lensOf(stats({ clipHigh: 0.02 }), none)?.blown).toBeNull();
    expect(lensOf(stats({ clipHigh: 0.03 }), none)?.blown).toBe('look');
    expect(lensOf(stats({ clipHigh: 0.06 }), none)?.blown).toBe('likely');
    expect(lensOf(stats({ clipHigh: 0.2, medianLum: 0.8 }), none)?.blown).toBeNull();
    expect(lensOf(stats({ clipHigh: 0.3, medianLum: 0.8 }), none)?.blown).toBe('likely');
  });

  it('calls a dark frame without clipped highlights Dark', () => {
    expect(lensOf(stats({ medianLum: 0.09 }), none)?.dark).toBe(true);
    expect(lensOf(stats({ medianLum: 0.1 }), none)?.dark).toBe(false);
    expect(lensOf(stats({ medianLum: 0.05, clipHigh: 0.03 }), none)).toMatchObject({ dark: false, blown: null });
  });

  it('puts no photo without stats in a lens, and a small folder has no Soft', () => {
    expect(lensOf({}, none)).toBeNull();
    expect(inLens('none', null)).toBe(true);
    expect(inLens(undefined, null)).toBe(true);
    expect(inLens('soft', null)).toBe(false);
    expect(inLens('any', null)).toBe(false);
    expect(folderStats([{ stats: { sharpnessMax: 1 } }, { stats: { sharpnessMax: 2 } }, {}])).toEqual({
      photos: 2,
      softCut: null,
      soft: new Set(),
    });
  });

  it('takes the decile of a larger folder', () => {
    const folder = folderStats(
      Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, stats: { sharpnessMax: 100 - i } })),
    );
    expect(folder).toMatchObject({ photos: 30, softCut: 73 });
    expect([...folder.soft]).toEqual(['p29', 'p28', 'p27']);
  });

  it('caps Soft at the decile’s count when scores tie at the cut, in the folder’s order', () => {
    const same = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, stats: stats({ sharpnessMax: 50 }).stats }));
    const folder = folderStats(same);
    expect([...folder.soft]).toEqual(['p0', 'p1']);
    expect(same.filter((e) => lensOf(e, folder)?.soft).map((e) => e.key)).toEqual(['p0', 'p1']);
  });

  it('lists the lenses in the filter bar’s order and explains each with its number and caveat', () => {
    const entry = stats({ sharpnessMax: 3, medianLum: 0.05 });
    const v = lensOf(entry, { photos: 20, softCut: 10, soft: new Set() });
    expect(lensesIn(v)).toEqual(['soft', 'dark']);
    if (!v) throw new Error('no verdict');
    expect(lensDetail('soft', entry, v)).toBe('Soft: sharpest tile 3');
    expect(lensDetail('dark', entry, v)).toBe('Dark: median brightness 5 %');
    const blown = lensOf(fixture('blown.jpg', true), FOLDER);
    if (!blown) throw new Error('no verdict');
    expect(lensDetail('blown', fixture('blown.jpg', true), blown)).toBe('Likely blown: 71 % clipped (RAW headroom)');
    expect(LENS_CAVEATS.soft).toBe(
      'Softest 10 % of the folder by local sharpness; intentional blur looks the same to this test',
    );
  });
});

describe('sharpness within a group', () => {
  it('ranks each frame against the group’s sharpest', () => {
    const { best, relative } = groupSharpness([
      { id: 'a', stats: { sharpnessMax: 50 } },
      { id: 'b', stats: { sharpnessMax: 200 } },
      { id: 'c' },
    ]);
    expect(best).toBe('b');
    expect(Object.fromEntries(relative)).toEqual({ a: 0.25, b: 1 });
    expect(groupSharpness([{ id: 'x' }]).best).toBeNull();
  });
});

describe('the lens in a saved collection', () => {
  it('parses with and without a lens, and drops an unknown lens instead of the collection', () => {
    expect(CollectionFilterSchema.parse({}).lens).toBeUndefined();
    expect(CollectionFilterSchema.parse({ lens: 'soft' }).lens).toBe('soft');
    const id = newId();
    const [saved] = parseSavedCollections([{ id, name: 'Later', filter: { lens: 'faces' } }]);
    expect(saved?.filter.lens).toBeUndefined();
  });
});
