import { describe, expect, it } from 'vitest';
import type { Frame } from '../schema.js';
import { BOOK_TEMPLATES } from '../templates.js';
import { THEME_DEFAULTS } from '../theme.js';
import {
  alignFrames,
  distributeFrames,
  frameLines,
  gapSpread,
  lineGaps,
  lineOverlaps,
  matchFrames,
  tidyFrames,
  tidyLine,
} from './align.js';
import { snapGap } from './snap.js';

const a: Frame = { x: 0.1, y: 0.2, w: 0.2, h: 0.3 };
const b: Frame = { x: 0.4, y: 0.25, w: 0.1, h: 0.2 };
const c: Frame = { x: 0.6, y: 0.1, w: 0.3, h: 0.4 };
const three = { a, b, c };

describe('alignFrames', () => {
  it('aligns to the sides and centre lines of the bounding box (x 0.1 to 0.9, y 0.1 to 0.5)', () => {
    const xs = (r: Record<string, Frame>) => Object.values(r).map((f) => f.x);
    const ys = (r: Record<string, Frame>) => Object.values(r).map((f) => f.y);
    expect(xs(alignFrames(three, 'left'))).toEqual([0.1, 0.1, 0.1]);
    expect(xs(alignFrames(three, 'center'))).toEqual([0.4, 0.45, 0.35]);
    expect(xs(alignFrames(three, 'right'))).toEqual([0.7, 0.8, 0.6]);
    expect(ys(alignFrames(three, 'top'))).toEqual([0.1, 0.1, 0.1]);
    expect(ys(alignFrames(three, 'middle'))).toEqual([0.15, 0.2, 0.1]);
    expect(ys(alignFrames(three, 'bottom'))).toEqual([0.2, 0.3, 0.1]);
    // Sizes and the other axis never change.
    const left = alignFrames(three, 'left');
    expect(left.b).toEqual({ ...b, x: 0.1 });
  });

  it('leaves a single frame alone', () => {
    expect(alignFrames({ a }, 'right')).toEqual({ a });
  });
});

describe('distributeFrames', () => {
  it('keeps the first and last frames and makes every gap equal', () => {
    const out = distributeFrames(three, 'x');
    expect(out.a).toEqual(a);
    expect(out.c).toEqual(c);
    // Free space 0.8 - 0.6 = 0.2, two gaps of 0.1.
    expect(out.b?.x).toBeCloseTo(0.4, 9);
    const moved = distributeFrames({ ...three, b: { ...b, x: 0.32 } }, 'x');
    expect(moved.b?.x).toBeCloseTo(0.4, 9);
    expect(lineGaps(moved, ['a', 'b', 'c'], 'x').map((g) => +g.toFixed(9))).toEqual([0.1, 0.1]);
  });

  it('works vertically and needs three frames', () => {
    const col = {
      p: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
      q: { x: 0.1, y: 0.35, w: 0.3, h: 0.1 },
      r: { x: 0.1, y: 0.7, w: 0.3, h: 0.2 },
    };
    const out = distributeFrames(col, 'y');
    expect(out.q?.y).toBeCloseTo(0.45, 9);
    expect(distributeFrames({ a, b }, 'x')).toEqual({ a, b });
  });
});

describe('matchFrames', () => {
  it('takes the reference width or height, keeping the left or top edge', () => {
    const out = matchFrames(three, 'width', 'b');
    expect(Object.values(out).map((f) => f.w)).toEqual([0.1, 0.1, 0.1]);
    expect(out.c?.x).toBe(c.x);
    const tallest = matchFrames(three, 'height');
    expect(Object.values(tallest).map((f) => f.h)).toEqual([0.4, 0.4, 0.4]);
    expect(tallest.a?.y).toBe(a.y);
  });
});

describe('frameLines', () => {
  it('groups a three-up row, but not a tall frame with two stacked beside it', () => {
    const row = {
      l: { x: 0.08, y: 0.3, w: 0.25, h: 0.3 },
      m: { x: 0.36, y: 0.31, w: 0.25, h: 0.3 },
      r: { x: 0.67, y: 0.29, w: 0.25, h: 0.3 },
    };
    expect(frameLines(row, 'x')).toEqual([['l', 'm', 'r']]);
    const hero = {
      h: { x: 0.08, y: 0.1, w: 0.4, h: 0.8 },
      t: { x: 0.5, y: 0.1, w: 0.4, h: 0.39 },
      u: { x: 0.5, y: 0.51, w: 0.4, h: 0.39 },
    };
    expect(frameLines(hero, 'x')).toEqual([['h'], ['t'], ['u']]);
    expect(frameLines(hero, 'y').map((l) => l.join())).toEqual(['h', 't,u']);
  });
});

describe('tidyFrames', () => {
  const page = BOOK_TEMPLATES['phone-portrait'];

  it('gives a three-up row gaps within 1/1000 of each other', () => {
    const row = {
      l: { x: 0.08, y: 0.3, w: 0.25, h: 0.3 },
      m: { x: 0.3713, y: 0.31, w: 0.25, h: 0.3 },
      r: { x: 0.67, y: 0.29, w: 0.25, h: 0.3 },
    };
    const out = tidyFrames(row);
    const gaps = lineGaps(out, ['l', 'm', 'r'], 'x');
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-3);
    // The mean gap keeps the row's extent; y never changes.
    expect(out.l?.x).toBeCloseTo(0.08, 6);
    expect((out.r?.x ?? 0) + 0.25).toBeCloseTo(0.92, 6);
    expect(out.m?.y).toBe(0.31);
  });

  it('can map the mean gap onto the gutter rhythm, keeping the row centred', () => {
    const row = {
      l: { x: 0.1, y: 0.3, w: 0.25, h: 0.3 },
      m: { x: 0.37, y: 0.3, w: 0.25, h: 0.3 },
      r: { x: 0.65, y: 0.3, w: 0.25, h: 0.3 },
    };
    const out = tidyFrames(row, { gap: (mean, axis) => snapGap(mean, THEME_DEFAULTS, page, axis) });
    const gaps = lineGaps(out, ['l', 'm', 'r'], 'x');
    for (const g of gaps) expect(g).toBeCloseTo(THEME_DEFAULTS.gutter, 6);
    expect(((out.l?.x ?? 0) + (out.r?.x ?? 0) + 0.25) / 2).toBeCloseTo(0.5, 6);
  });

  it('tidies each row on its own and a single column along y', () => {
    const grid = {
      a: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
      b: { x: 0.45, y: 0.1, w: 0.3, h: 0.3 },
      c: { x: 0.1, y: 0.5, w: 0.3, h: 0.3 },
    };
    // Rows: [a, b] and [c]; a two-frame row keeps its single gap.
    expect(tidyFrames(grid)).toEqual(grid);
    const col = {
      p: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
      q: { x: 0.1, y: 0.33, w: 0.3, h: 0.2 },
      r: { x: 0.1, y: 0.6, w: 0.3, h: 0.2 },
    };
    const out = tidyFrames(col);
    const gaps = lineGaps(out, ['p', 'q', 'r'], 'y');
    expect(Math.abs((gaps[0] ?? 0) - (gaps[1] ?? 0))).toBeLessThan(1e-6);
  });

  it('tidyLine returns only the row it was given', () => {
    const out = tidyLine({ ...three, d: { x: 0, y: 0.9, w: 0.1, h: 0.1 } }, ['a', 'b', 'c'], 'x');
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('gapSpread', () => {
  it('is the standard deviation of the gaps', () => {
    expect(gapSpread([0.025])).toBe(0);
    expect(gapSpread([0.02, 0.04])).toBeCloseTo(0.01, 12);
  });
});

describe('overlapping frames (left alone)', () => {
  it('Tidy skips a row whose frames overlap along it (a caption over a photo)', () => {
    const frames = {
      photo: { x: 0.08, y: 0.3, w: 0.5, h: 0.4 },
      text: { x: 0.1, y: 0.45, w: 0.3, h: 0.1 },
      side: { x: 0.65, y: 0.3, w: 0.27, h: 0.4 },
    };
    expect(lineOverlaps(frames, ['photo', 'text', 'side'], 'x')).toBe(true);
    expect(tidyLine(frames, ['photo', 'text', 'side'], 'x')).toEqual({});
    expect(tidyFrames(frames)).toEqual(frames);
  });

  it('Distribute leaves a frame nested in a bigger one alone', () => {
    const frames = {
      big: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 },
      inner: { x: 0.3, y: 0.2, w: 0.1, h: 0.1 },
      out: { x: 0.92, y: 0.2, w: 0.05, h: 0.1 },
    };
    expect(distributeFrames(frames, 'x')).toEqual(frames);
  });

  it('a short top-aligned caption beside a tall photo is not a row with it', () => {
    const frames = { photo: { x: 0.08, y: 0.1, w: 0.4, h: 0.6 }, caption: { x: 0.5, y: 0.1, w: 0.4, h: 0.05 } };
    expect(frameLines(frames, 'x')).toEqual([['photo'], ['caption']]);
  });
});
