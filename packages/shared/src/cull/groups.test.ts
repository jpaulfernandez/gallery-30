import { describe, expect, it } from 'vitest';
import { newId } from '../ids.js';
import { emptyLibrary, parseLibrary, serializeLibrary } from '../library.js';
import {
  DEFAULT_GROUP_SETTINGS,
  type GroupEntry,
  type GroupOverride,
  type GroupStats,
  groupPhotos,
  groupSettingsFor,
  suggestedBest,
} from './groups.js';

const BASE_HASH = 'a5a5a5a5c3c3c3c3';

/** `BASE_HASH` with its lowest `bits` bits flipped: Hamming distance `bits` from it. */
function hashAt(bits: number, base = BASE_HASH): string {
  const lo = Number.parseInt(base.slice(8), 16);
  const hi = Number.parseInt(base.slice(0, 8), 16);
  const loBits = Math.min(bits, 32);
  const hiBits = Math.max(0, bits - 32);
  const mask = (n: number) => (n === 32 ? 0xffffffff : (1 << n) - 1) >>> 0;
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(hi ^ mask(hiBits)) + hex(lo ^ mask(loBits));
}

const STATS: GroupStats = { sharpness: 100, sharpnessMax: 400, motion: 0.2, clipHigh: 0, clipLow: 0 };

const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);

function frame(name: string, taken: number | undefined, extra: Partial<GroupEntry> = {}): GroupEntry {
  return {
    id: `F/${name}`,
    name,
    taken,
    make: 'Fujifilm',
    model: 'X-T5',
    lens: 'XF33mmF1.4 R LM WR',
    focal: 33,
    phash: BASE_HASH,
    stats: STATS,
    ...extra,
  };
}

const ids = (groups: { frames: string[] }[]) => groups.map((g) => g.frames.map((id) => id.slice(2)));

/**
 * The burst fixture's shape (scripts/make-burst-fixture.py): one scene, twelve frames. Nine frames of a burst 150 ms
 * apart, a frame from a second camera in the middle of it, then two frames re-shot 20 s after the burst.
 */
function burstFixture(): GroupEntry[] {
  const out: GroupEntry[] = [];
  for (let i = 0; i < 9; i++) out.push(frame(`DSCF${2001 + i}.jpg`, T0 + i * 150, { phash: hashAt(i % 4) }));
  out.push(frame('IMG_0001.jpg', T0 + 600, { make: 'Canon', model: 'EOS R6', lens: 'RF35mm F1.8', focal: 35 }));
  const last = T0 + 8 * 150;
  out.push(frame('DSCF2010.jpg', last + 20_000, { phash: hashAt(2) }));
  out.push(frame('DSCF2011.jpg', last + 20_150, { phash: hashAt(3) }));
  return out;
}

describe('groupPhotos', () => {
  it('groups the burst fixture: the re-shoot joins, the second camera does not', () => {
    const groups = groupPhotos(burstFixture());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.frames).toHaveLength(11);
    expect(groups[0]?.frames).not.toContain('F/IMG_0001.jpg');
    expect(groups[0]?.id).toBe('F/DSCF2001.jpg');
    // Capture order inside the group.
    expect(groups[0]?.frames.at(-1)).toBe('F/DSCF2011.jpg');
  });

  it('splits on a gap longer than the burst gap unless the re-shoot rule merges it', () => {
    const near = [frame('a', T0), frame('b', T0 + 1500), frame('c', T0 + 4000, { phash: hashAt(10) })];
    // c is 2.5 s after b with a hash 10 bits off: not the burst (gap), not a re-shoot (hash > 4).
    expect(ids(groupPhotos(near))).toEqual([['a', 'b']]);
    // The same c with a close hash is a re-shoot of the same subject.
    const reshot = [frame('a', T0), frame('b', T0 + 1500), frame('c', T0 + 4000, { phash: hashAt(4) })];
    expect(ids(groupPhotos(reshot))).toEqual([['a', 'b', 'c']]);
    // Past the re-shoot gap, never.
    const late = [frame('a', T0), frame('b', T0 + 1500), frame('c', T0 + 32_000)];
    expect(ids(groupPhotos(late))).toEqual([['a', 'b']]);
  });

  it('splits on a rig change: camera, lens or focal length beyond 5 %', () => {
    const rig = [
      frame('a', T0),
      frame('b', T0 + 100),
      frame('c', T0 + 200, { lens: 'XF56mmF1.2' }),
      frame('d', T0 + 300, { lens: 'XF56mmF1.2' }),
      frame('e', T0 + 400, { lens: 'XF56mmF1.2', focal: 34 }),
      frame('f', T0 + 500, { lens: 'XF56mmF1.2', focal: 40 }),
    ];
    expect(ids(groupPhotos(rig))).toEqual([
      ['a', 'b'],
      ['c', 'd', 'e'],
    ]);
  });

  it('splits on a hash jump inside a burst', () => {
    const jump = [
      frame('a', T0),
      frame('b', T0 + 100, { phash: hashAt(16) }),
      frame('c', T0 + 200, { phash: hashAt(40) }),
    ];
    // b is 16 bits from a (joins); c is 24 bits from b (a new scene), and too far from a and b for a re-shoot.
    expect(ids(groupPhotos(jump))).toEqual([['a', 'b']]);
  });

  it('never groups photos without a capture time or a hash', () => {
    const untimed = [frame('a', undefined), frame('b', undefined), frame('c', T0), frame('d', T0 + 100)];
    expect(ids(groupPhotos(untimed))).toEqual([['c', 'd']]);
    const unhashed = [frame('a', T0, { phash: undefined }), frame('b', T0 + 100, { phash: undefined })];
    expect(groupPhotos(unhashed)).toEqual([]);
  });

  it('applies overrides: solo detaches, a shared ULID merges whatever the maths said', () => {
    const entries = [
      frame('a', T0),
      frame('b', T0 + 100),
      frame('c', T0 + 200),
      frame('x', T0 + 600_000, { phash: hashAt(30) }),
      frame('y', T0 + 900_000, { phash: hashAt(50), taken: undefined }),
    ];
    const solo = new Map<string, GroupOverride>([['F/b', 'solo']]);
    expect(ids(groupPhotos(entries, solo))).toEqual([['a', 'c']]);

    const merge = newId();
    const merged = new Map<string, GroupOverride>([
      ['F/c', merge],
      ['F/x', merge],
      ['F/y', merge],
    ]);
    const groups = groupPhotos(entries, merged);
    expect(ids(groups)).toEqual([
      ['a', 'b'],
      ['c', 'x', 'y'],
    ]);
    expect(groups[1]?.id).toBe(merge);

    // A ULID only one photo holds is a group of one: not a group.
    const alone = new Map<string, GroupOverride>([['F/a', newId()]]);
    expect(ids(groupPhotos(entries, alone))).toEqual([['b', 'c']]);
  });

  it('sorts by capture time, then name with the numeric collator', () => {
    const entries = [frame('IMG_10.jpg', T0), frame('IMG_9.jpg', T0), frame('IMG_2.jpg', T0 + 50)];
    expect(ids(groupPhotos(entries))).toEqual([['IMG_9.jpg', 'IMG_10.jpg', 'IMG_2.jpg']]);
  });

  it('scales both gaps for tighter and looser grouping', () => {
    expect(groupSettingsFor('normal')).toEqual(DEFAULT_GROUP_SETTINGS);
    expect(groupSettingsFor('tighter').burstGap).toBe(1000);
    expect(groupSettingsFor('looser').reshootGap).toBe(60_000);
    // 8 bits apart: one burst at the normal gap, too far apart for a re-shoot once the burst gap is halved.
    const entries = [frame('a', T0), frame('b', T0 + 1500, { phash: hashAt(8) })];
    expect(ids(groupPhotos(entries))).toEqual([['a', 'b']]);
    expect(groupPhotos(entries, undefined, groupSettingsFor('tighter'))).toEqual([]);
    expect(ids(groupPhotos(entries, undefined, groupSettingsFor('looser')))).toEqual([['a', 'b']]);
  });

  it('groups 10 000 photos in well under 50 ms', () => {
    const entries: GroupEntry[] = [];
    let t = T0;
    for (let i = 0; i < 10_000; i++) {
      // Bursts of about eight frames, a new scene (and a long pause) between them, a second camera now and then.
      const scene = Math.floor(i / 8);
      t += i % 8 === 0 ? 45_000 : 180;
      entries.push(
        frame(`DSCF${i}.jpg`, t, {
          phash: hashAt((scene * 7) % 64 === 0 ? 1 : (scene * 7) % 64),
          ...(i % 37 === 0 ? { make: 'Canon', model: 'EOS R6' } : {}),
          stats: { ...STATS, sharpnessMax: 300 + (i % 5) * 20 },
        }),
      );
    }
    const overrides = new Map<string, GroupOverride>([['F/DSCF3.jpg', 'solo']]);
    groupPhotos(entries, overrides);
    let best = Number.POSITIVE_INFINITY;
    let groups: ReturnType<typeof groupPhotos> = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      groups = groupPhotos(entries, overrides);
      best = Math.min(best, performance.now() - start);
    }
    expect(groups.length).toBeGreaterThan(1000);
    expect(best).toBeLessThan(50);
  });
});

describe('suggestedBest', () => {
  const s = (patch: Partial<GroupStats>): GroupStats => ({ ...STATS, ...patch });

  it('picks the sharpest frame, ties to the earliest', () => {
    const frames = [
      frame('a', T0, { stats: s({ sharpnessMax: 300 }) }),
      frame('b', T0 + 1, { stats: s({ sharpnessMax: 500 }) }),
      frame('c', T0 + 2, { stats: s({ sharpnessMax: 500 }) }),
    ];
    expect(suggestedBest(frames)).toBe('F/b');
  });

  it('halves a motion-blurred frame and docks clipped ones', () => {
    // b is as sharp at its sharpest tile but blurred overall with one dominant direction: a pan.
    const panned = [
      frame('a', T0, { stats: s({ sharpnessMax: 380 }) }),
      frame('b', T0 + 1, { stats: s({ sharpnessMax: 400, sharpness: 40, motion: 0.8 }) }),
    ];
    expect(suggestedBest(panned)).toBe('F/a');
    const blown = [
      frame('a', T0, { stats: s({ sharpnessMax: 400, clipHigh: 0.1 }) }),
      frame('b', T0 + 1, { stats: s({ sharpnessMax: 360, clipHigh: 0.01 }) }),
    ];
    expect(suggestedBest(blown)).toBe('F/b');
    const crushed = [
      frame('a', T0, { stats: s({ sharpnessMax: 400, clipLow: 0.25 }) }),
      frame('b', T0 + 1, { stats: s({ sharpnessMax: 340 }) }),
    ];
    expect(suggestedBest(crushed)).toBe('F/b');
  });

  it('falls back to the first frame without stats, and to the frame with stats over one without', () => {
    expect(suggestedBest([frame('a', T0, { stats: undefined }), frame('b', T0 + 1, { stats: undefined })])).toBe('F/a');
    expect(suggestedBest([frame('a', T0, { stats: undefined }), frame('b', T0 + 1)])).toBe('F/b');
    expect(suggestedBest([])).toBe('');
  });

  it('is the best of each group groupPhotos returns', () => {
    const entries = burstFixture();
    const sharpest = entries[4] as GroupEntry;
    sharpest.stats = s({ sharpnessMax: 900 });
    expect(groupPhotos(entries)[0]?.best).toBe(sharpest.id);
  });
});

describe('group overrides in the library', () => {
  it('survive a write and a read (a restart), and a malformed group drops only itself', () => {
    const library = emptyLibrary();
    const merge = newId();
    library.photos.h1 = { versions: {}, flag: 'pick', cull: { group: merge } };
    library.photos.h2 = { versions: {}, cull: { group: 'solo' } };
    const back = parseLibrary(serializeLibrary(library));
    expect(back.photos.h1?.cull).toEqual({ group: merge });
    expect(back.photos.h2?.cull).toEqual({ group: 'solo' });

    const bad = JSON.parse(serializeLibrary(library));
    bad.photos.h1.cull = { group: 'not a ulid' };
    const parsed = parseLibrary(JSON.stringify(bad));
    expect(parsed.photos.h1?.cull?.group).toBeUndefined();
    expect(parsed.photos.h1?.flag).toBe('pick');
  });
});
