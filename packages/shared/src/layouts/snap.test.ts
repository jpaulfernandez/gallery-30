import { describe, expect, it } from 'vitest';
import { BOOK_TEMPLATES } from '../templates.js';
import { THEME_DEFAULTS } from '../theme.js';
import {
  equalSpacingCandidates,
  inchFraction,
  pageGuideLines,
  sizeMatchCandidates,
  snapCandidates,
  snapFrame,
  snapGap,
  snapToTrim,
} from './snap.js';

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

describe('equal spacing (workflow plan 30)', () => {
  const noGrid = { ...theme, grid: 0.5 };
  const left = { x: 0.08, y: 0.3, w: 0.2, h: 0.3 };
  const right = { x: 0.62, y: 0.3, w: 0.3, h: 0.3 };

  it('offers the centred spot between two neighbours, and spots beside a pair at their gap', () => {
    const frame = { x: 0.3, y: 0.32, w: 0.2, h: 0.2 };
    const { x, y } = equalSpacingCandidates(frame, [left, right]);
    const values = x.map((l) => +l.value.toFixed(6)).sort((p, q) => p - q);
    // Between: room 0.34 - 0.2 = 0.14, so the near edge at 0.28 + 0.07. After: 0.92 + 0.34. Before: 0.08 - 0.34 - 0.2.
    expect(values).toEqual([-0.46, 0.35, 1.26]);
    expect(x.every((l) => l.kind === 'equal' && l.side === 'after')).toBe(true);
    // The neighbours share no column with the frame along y.
    expect(y).toEqual([]);
    // Two frames are not enough.
    expect(equalSpacingCandidates(frame, [left]).x).toEqual([]);
  });

  it('snaps the middle of three frames to equal gaps and reports both spans', () => {
    const { frame, guides } = snapFrame({ x: 0.356, y: 0.33, w: 0.2, h: 0.2 }, [left, right], noGrid, page, {
      threshold: 0.01,
    });
    expect(frame.x).toBeCloseTo(0.35, 12);
    const equal = guides.find((g) => g.kind === 'equal');
    expect(equal?.label).toBe('equal');
    expect(equal?.axis).toBe('x');
    const spans = equal?.spans ?? [];
    expect(spans).toHaveLength(2);
    expect((spans[0]?.to ?? 0) - (spans[0]?.from ?? 0)).toBeCloseTo(0.07, 12);
    expect((spans[1]?.to ?? 0) - (spans[1]?.from ?? 0)).toBeCloseTo(0.07, 12);
    // At the middle of the shared band (0.33 to 0.53 with 0.3 to 0.6).
    expect(spans[0]?.at).toBeCloseTo(0.43, 12);
  });

  it('snaps a third frame after a pair at the pair gap', () => {
    const a = { x: 0.08, y: 0.3, w: 0.2, h: 0.3 };
    const b = { x: 0.34, y: 0.3, w: 0.2, h: 0.3 };
    const { frame, guides } = snapFrame({ x: 0.603, y: 0.3, w: 0.2, h: 0.3 }, [a, b], noGrid, page, {
      threshold: 0.01,
    });
    expect(frame.x).toBeCloseTo(0.6, 12);
    expect(guides.some((g) => g.kind === 'equal')).toBe(true);
  });
});

describe('size match (workflow plan 30)', () => {
  const noGrid = { ...theme, grid: 0.5 };
  const other = { x: 0.6, y: 0.1, w: 0.25, h: 0.15 };

  it('offers the dragged edge positions that match a neighbour, on resize only', () => {
    const frame = { x: 0.1, y: 0.4, w: 0.2, h: 0.2 };
    expect(sizeMatchCandidates(frame, [other], 'e').x.map((l) => l.value)).toEqual([0.35]);
    expect(sizeMatchCandidates(frame, [other], 'w').x.map((l) => +l.value.toFixed(9))).toEqual([0.05]);
    expect(sizeMatchCandidates(frame, [other], 's').y.map((l) => +l.value.toFixed(9))).toEqual([0.55]);
    expect(sizeMatchCandidates(frame, [other], 'e').y).toEqual([]);
    expect(sizeMatchCandidates(frame, [other], 'move')).toEqual({ x: [], y: [] });
  });

  it('snaps a resize to the same width and labels it', () => {
    const { frame, guides } = snapFrame({ x: 0.1, y: 0.4, w: 0.246, h: 0.2 }, [other], noGrid, page, {
      threshold: 0.01,
      handle: 'e',
    });
    expect(frame.w).toBeCloseTo(0.25, 12);
    const size = guides.find((g) => g.kind === 'size');
    expect(size?.label).toBe('same width');
    expect(size?.spans).toEqual([
      { from: 0.1, to: expect.closeTo(0.35, 12), at: 0.4 },
      { from: 0.6, to: 0.85, at: 0.1 },
    ]);
    const tall = snapFrame({ x: 0.1, y: 0.4, w: 0.2, h: 0.147 }, [other], noGrid, page, {
      threshold: 0.01,
      handle: 's',
    });
    expect(tall.frame.h).toBeCloseTo(0.15, 12);
    expect(tall.guides.find((g) => g.kind === 'size')?.label).toBe('same height');
  });

  it('a move never takes a size line', () => {
    const { guides } = snapFrame({ x: 0.1, y: 0.4, w: 0.246, h: 0.2 }, [other], noGrid, page, { threshold: 0.01 });
    expect(guides.some((g) => g.kind === 'size')).toBe(false);
  });
});

describe('extra lines', () => {
  it('snaps to lines passed in by the caller', () => {
    const extra = { value: 0.333, kind: 'frame' as const, strength: 5 };
    const { frame } = snapFrame({ x: 0.33, y: 0.4, w: 0.2, h: 0.2 }, [], theme, page, {
      threshold: 0.01,
      extraLines: { x: [extra] },
    });
    expect(frame.x).toBeCloseTo(0.333, 12);
  });
});

describe('smart guide options and merging (workflow plan 30)', () => {
  const noGrid = { ...theme, grid: 0.5 };

  it('sizeMatch: false leaves size lines out of a resize', () => {
    const other = { x: 0.6, y: 0.1, w: 0.25, h: 0.15 };
    const { frame, guides } = snapFrame({ x: 0.1, y: 0.4, w: 0.246, h: 0.2 }, [other], noGrid, page, {
      threshold: 0.01,
      handle: 'e',
      sizeMatch: false,
    });
    expect(frame.w).toBe(0.246);
    expect(guides.some((g) => g.kind === 'size')).toBe(false);
  });

  it('merges the spans of two equal-spacing lines at one position into one guide', () => {
    // A [0, 0.1], B [0.15, 0.25], C [0.55, 0.65]: a 0.2 wide frame at 0.3 is both centred between B and C
    // and after the pair A B at their 0.05 gap.
    const a = { x: 0, y: 0.3, w: 0.1, h: 0.2 };
    const b = { x: 0.15, y: 0.3, w: 0.1, h: 0.2 };
    const c = { x: 0.55, y: 0.3, w: 0.1, h: 0.2 };
    const { frame, guides } = snapFrame({ x: 0.303, y: 0.3, w: 0.2, h: 0.2 }, [a, b, c], noGrid, page, {
      threshold: 0.01,
    });
    expect(frame.x).toBeCloseTo(0.3, 12);
    const equal = guides.filter((g) => g.kind === 'equal');
    expect(equal).toHaveLength(1);
    // A-B, B-frame and frame-C, each once.
    expect(equal[0]?.spans).toHaveLength(3);
  });
});

describe('page guides (workflow plan 31)', () => {
  const noGrid = { ...theme, grid: 0.5 };

  it('turns page guides into strong `guide` lines on their axis', () => {
    const lines = pageGuideLines([
      { axis: 'x', value: 0.3 },
      { axis: 'y', value: 0.45 },
      { axis: 'x', value: Number.NaN },
    ]);
    expect(lines.x).toEqual([{ value: 0.3, kind: 'guide', strength: 4 }]);
    expect(lines.y).toEqual([{ value: 0.45, kind: 'guide', strength: 4 }]);
  });

  it('snaps a moved frame to a page guide, labelled "guide"', () => {
    const extraLines = pageGuideLines([
      { axis: 'x', value: 0.3 },
      { axis: 'y', value: 0.45 },
    ]);
    const { frame, guides } = snapFrame({ x: 0.305, y: 0.2, w: 0.2, h: 0.243 }, [], noGrid, page, {
      threshold: 0.01,
      extraLines,
    });
    expect(frame.x).toBeCloseTo(0.3, 12);
    // The bottom edge (0.443) is within reach of the y guide.
    expect(frame.y + frame.h).toBeCloseTo(0.45, 12);
    expect(guides).toContainEqual({ axis: 'x', value: 0.3, kind: 'guide', label: 'guide' });
    expect(guides).toContainEqual({ axis: 'y', value: 0.45, kind: 'guide', label: 'guide' });
  });

  it('snaps a dragged edge to a page guide on a resize, and beats another frame nearer by', () => {
    const other = { x: 0.6, y: 0.7, w: 0.2, h: 0.1 };
    const { frame } = snapFrame({ x: 0.1, y: 0.1, w: 0.495, h: 0.2 }, [other], noGrid, page, {
      threshold: 0.01,
      handle: 'e',
      extraLines: pageGuideLines([{ axis: 'x', value: 0.592 }]),
    });
    // The guide (strength 4) wins over the frame's left edge at 0.6 (strength 3), though that is as near.
    expect(frame.x + frame.w).toBeCloseTo(0.592, 12);
  });
});
