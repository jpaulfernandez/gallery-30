import { describe, expect, it } from 'vitest';
import { BOOK_TEMPLATES } from '../templates.js';
import { THEME_DEFAULTS } from '../theme.js';
import { inchFraction, snapCandidates, snapFrame, snapGap, snapToTrim } from './snap.js';

// 8 x 10 in reference page: 1 in = 0.125 of the width = 0.1 of the height.
const page = BOOK_TEMPLATES['phone-portrait'];
const square = BOOK_TEMPLATES.square;
const theme = THEME_DEFAULTS;

describe('inch conversion', () => {
  it('uses an 8 in wide page on both axes', () => {
    expect(inchFraction(page, 'x')).toBe(0.125);
    expect(inchFraction(page, 'y')).toBeCloseTo(0.1, 12);
    expect(inchFraction(square, 'y')).toBe(0.125);
  });
});

describe('snapGap (photo to photo)', () => {
  it('follows the guide on the x axis', () => {
    expect(snapGap(0.01, theme, page, 'x')).toBe(0); // 0.08 in: joins
    expect(snapGap(-0.005, theme, page, 'x')).toBe(0); // a hairline overlap joins too
    expect(snapGap(0.02, theme, page, 'x')).toBe(0.025); // 0.16 in -> 0.2 in gutter
    expect(snapGap(0.0125, theme, page, 'x')).toBe(0.025); // exactly 0.1 in
    expect(snapGap(0.045, theme, page, 'x')).toBe(0.05); // 0.36 in -> 0.4 in wide gutter
    expect(snapGap(0.0625, theme, page, 'x')).toBe(0.05); // 0.5 in
    expect(snapGap(0.08, theme, page, 'x')).toBe(0.08); // 0.64 in: intentional white space
    expect(snapGap(-0.05, theme, page, 'x')).toBe(-0.05);
  });

  it('uses the same absolute inches on the y axis', () => {
    expect(snapGap(0.008, theme, page, 'y')).toBe(0); // 0.08 in
    expect(snapGap(0.02, theme, page, 'y')).toBeCloseTo(0.02, 12); // 0.2 in -> gutter (0.025 * 0.8)
    expect(snapGap(0.035, theme, page, 'y')).toBeCloseTo(0.04, 12); // 0.35 in -> wide (0.05 * 0.8)
    expect(snapGap(0.06, theme, page, 'y')).toBe(0.06);
  });
});

describe('snapToTrim (photo to trim)', () => {
  it('bleeds under 0.25 in, sits on the safe margin up to 0.64 in, else stays', () => {
    expect(snapToTrim(0.02, theme, page, 'x')).toBe(0); // 0.16 in
    expect(snapToTrim(-0.01, theme, page, 'x')).toBe(0);
    expect(snapToTrim(0.03125, theme, page, 'x')).toBe(0.08); // exactly 0.25 in
    expect(snapToTrim(0.05, theme, page, 'x')).toBe(0.08); // 0.4 in -> 0.64 in
    expect(snapToTrim(0.1, theme, page, 'x')).toBe(0.1); // 0.8 in
    expect(snapToTrim(0.04, theme, page, 'y')).toBeCloseTo(0.064, 12); // 0.4 in -> 0.64 in of the height
    expect(snapToTrim(0.02, theme, page, 'y')).toBe(0); // 0.2 in
  });
});

describe('snapCandidates', () => {
  it('lists grid, margin, hard, edge, centre, frame and gap lines', () => {
    const frame = { x: 0.1, y: 0.3, w: 0.3, h: 0.2 };
    const other = { x: 0.5, y: 0.25, w: 0.42, h: 0.3 };
    const { x, y } = snapCandidates(frame, [other], theme, page);
    const at = (lines: typeof x, kind: string) =>
      lines
        .filter((l) => l.kind === kind)
        .map((l) => +l.value.toFixed(6))
        .sort((a, b) => a - b);
    expect(at(x, 'margin')).toEqual([0.08, 0.92]);
    expect(at(y, 'margin')).toEqual([0.064, 0.936]);
    expect(at(x, 'hard')).toEqual([0.0625, 0.9375]);
    expect(at(x, 'edge')).toEqual([0, 1]);
    expect(at(x, 'center')).toEqual([0.5]);
    expect(at(x, 'frame')).toEqual([0.5, 0.71, 0.92]);
    expect(at(x, 'gap')).toEqual([0.45, 0.475, 0.945, 0.97]);
    // The neighbour shares no column with the frame, so no vertical gap lines.
    expect(at(y, 'gap')).toEqual([]);
    expect(x.filter((l) => l.kind === 'grid')).toHaveLength(71); // 0.0139 steps inside (0, 1)
    expect(at(y, 'grid')[0]).toBeCloseTo(0.0139 * 0.8, 6);
    const strength = (kind: string) => x.find((l) => l.kind === kind)?.strength ?? 0;
    for (const kind of ['margin', 'edge', 'frame', 'gap']) expect(strength(kind)).toBeGreaterThan(strength('grid'));
  });
});

describe('snapFrame', () => {
  it('prefers the safe margin over a nearer grid line', () => {
    // Left edge 0.085: grid line 0.0834 is nearer, margin 0.08 wins.
    const { frame, guides } = snapFrame({ x: 0.085, y: 0.3, w: 0.4, h: 0.3 }, [], theme, page, { threshold: 0.01 });
    expect(frame.x).toBeCloseTo(0.08, 12);
    expect(frame.w).toBe(0.4);
    expect(guides).toContainEqual({ axis: 'x', value: 0.08, kind: 'margin' });
  });

  it('snaps to the gutter beside a neighbour', () => {
    const other = { x: 0.5, y: 0.3, w: 0.42, h: 0.3 };
    // Right edge 0.472: the gap line at 0.5 - 0.025 = 0.475 beats the grid.
    const { frame, guides } = snapFrame({ x: 0.2, y: 0.33, w: 0.272, h: 0.2 }, [other], theme, page, {
      threshold: 0.01,
    });
    expect(frame.x).toBeCloseTo(0.203, 12);
    expect(guides.find((g) => g.axis === 'x')).toEqual({ axis: 'x', value: 0.475, kind: 'gap' });
  });

  it('never snaps a dragged frame onto a gap line on the wrong side of a neighbour', () => {
    const other = { x: 0.5, y: 0.3, w: 0.42, h: 0.3 };
    const noGrid = { ...theme, grid: 0.5 };
    // Left edge 0.47 is near 0.475 (0.5 - gutter), a line only the right edge may take: no snap.
    const left = snapFrame({ x: 0.47, y: 0.33, w: 0.2, h: 0.2 }, [other], noGrid, page, { threshold: 0.005 });
    expect(left.frame.x).toBe(0.47);
    expect(left.guides.filter((g) => g.axis === 'x')).toEqual([]);
    // Right edge 0.947 is near 0.945 (0.92 + gutter), a line only the left edge may take: no snap.
    const right = snapFrame({ x: 0.75, y: 0.33, w: 0.197, h: 0.2 }, [other], noGrid, page, { threshold: 0.005 });
    expect(right.frame.x).toBe(0.75);
    // On the correct side both still snap.
    const after = snapFrame({ x: 0.947, y: 0.33, w: 0.03, h: 0.2 }, [other], noGrid, page, { threshold: 0.005 });
    expect(after.frame.x).toBeCloseTo(0.945, 12);
    const above = { x: 0.2, y: 0.5, w: 0.3, h: 0.2 };
    const y = snapFrame({ x: 0.25, y: 0.3, w: 0.2, h: 0.178 }, [above], noGrid, page, { threshold: 0.005 });
    // Bottom edge 0.478 snaps to 0.5 - 0.02 (gutter on y); the top edge would never take that line.
    expect(y.frame.y + y.frame.h).toBeCloseTo(0.48, 12);
    expect(y.guides.find((g) => g.axis === 'y')).toEqual({ axis: 'y', value: 0.48, kind: 'gap' });
  });

  it('snaps a right-edge resize to the gutter before a neighbour, and only the dragged edge', () => {
    const other = { x: 0.5, y: 0.3, w: 0.42, h: 0.3 };
    const noGrid = { ...theme, grid: 0.5 };
    const east = snapFrame({ x: 0.2, y: 0.33, w: 0.272, h: 0.2 }, [other], noGrid, page, {
      threshold: 0.01,
      handle: 'e',
    });
    expect(east.frame.x).toBe(0.2);
    expect(east.frame.x + east.frame.w).toBeCloseTo(other.x - theme.gutter, 12);
    expect(east.guides).toContainEqual({ axis: 'x', value: 0.475, kind: 'gap' });
    // A right edge near the gap line after a neighbour (its left-edge side) does not snap.
    const left = { x: 0.1, y: 0.3, w: 0.2, h: 0.3 };
    const wrong = snapFrame({ x: 0.05, y: 0.33, w: 0.27, h: 0.2 }, [left], noGrid, page, {
      threshold: 0.01,
      handle: 'e',
    });
    expect(wrong.frame.w).toBe(0.27);
    // A left-edge resize takes that line.
    const west = snapFrame({ x: 0.328, y: 0.33, w: 0.3, h: 0.2 }, [left], noGrid, page, {
      threshold: 0.01,
      handle: 'w',
    });
    expect(west.frame.x).toBeCloseTo(0.325, 12);
    expect(west.frame.x + west.frame.w).toBeCloseTo(0.628, 12);
  });

  it('falls back to the grid when nothing stronger is near', () => {
    // Centre 0.375 is 0.0003 from grid line 27 * 0.0139 = 0.3753; no stronger line within 0.002.
    const { frame, guides } = snapFrame({ x: 0.3, y: 0.4, w: 0.15, h: 0.1 }, [], theme, page, { threshold: 0.002 });
    expect(frame.x).toBeCloseTo(0.3003, 9);
    expect(guides.find((g) => g.axis === 'x')).toEqual({ axis: 'x', value: 27 * 0.0139, kind: 'grid' });
  });

  it('resizes only the dragged edge', () => {
    const start = { x: 0.2, y: 0.2, w: 0.715, h: 0.3 };
    const { frame } = snapFrame(start, [], theme, page, { threshold: 0.01, handle: 'e' });
    expect(frame.x).toBe(0.2);
    expect(frame.x + frame.w).toBeCloseTo(0.92, 12);
    expect(frame.h).toBe(0.3);
    const west = snapFrame(start, [], theme, page, { threshold: 0.01, handle: 'w' }).frame;
    expect(west.x + west.w).toBeCloseTo(0.915, 12);
  });

  it('keeps the ratio on a locked corner resize, anchored at the opposite corner', () => {
    const start = { x: 0.2, y: 0.2, w: 0.715, h: 0.5 };
    const { frame, guides } = snapFrame(start, [], theme, page, { threshold: 0.01, handle: 'se', lockRatio: true });
    expect(frame.x).toBe(0.2);
    expect(frame.y).toBe(0.2);
    expect(frame.x + frame.w).toBeCloseTo(0.92, 12);
    expect(frame.w / frame.h).toBeCloseTo(start.w / start.h, 12);
    expect(guides[0]).toEqual({ axis: 'x', value: 0.92, kind: 'margin' });
    const nw = snapFrame(start, [], theme, page, { threshold: 0.01, handle: 'nw', lockRatio: true }).frame;
    expect(nw.x + nw.w).toBeCloseTo(0.915, 12);
    expect(nw.y + nw.h).toBeCloseTo(0.7, 12);
    expect(nw.w / nw.h).toBeCloseTo(start.w / start.h, 12);
  });

  it('leaves the frame alone when nothing is within the threshold', () => {
    const f = { x: 0.3007, y: 0.4003, w: 0.1, h: 0.1 };
    expect(snapFrame(f, [], { ...theme, grid: 0.5 }, page, { threshold: 0.0001 })).toEqual({ frame: f, guides: [] });
  });
});
