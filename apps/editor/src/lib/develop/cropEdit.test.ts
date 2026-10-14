import { describe, expect, it } from 'vitest';
import { MIN_CROP, moveRect, orientRatio, resizeRect } from './cropEdit';
import { cropFits } from './geometry';

const IA = 1.5;
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('moveRect', () => {
  it('follows the pointer and stops at the frame edge at 0°', () => {
    const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const moved = moveRect(r, 0.1, -0.05, { ia: IA, angle: 0, constrain: true });
    near(moved.x, 0.3);
    near(moved.y, 0.15);
    const stopped = moveRect(r, 5, 5, { ia: IA, angle: 0, constrain: true });
    near(stopped.x + stopped.w, 1);
    near(stopped.y + stopped.h, 1);
    expect(stopped.w).toBe(0.4);
  });

  it('stays inside the rotated image when constrained', () => {
    const r = { x: 0.3, y: 0.3, w: 0.3, h: 0.3 };
    const moved = moveRect(r, -1, -1, { ia: IA, angle: 20, constrain: true });
    expect(cropFits(moved, 20, IA)).toBe(true);
    expect(moved.w).toBe(0.3);
  });
});

describe('resizeRect', () => {
  const start = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const free = { ia: IA, angle: 0, constrain: true, aspect: null, fromCenter: false };

  it('drags one corner and anchors the opposite one', () => {
    const r = resizeRect(start, 'se', 0.1, 0.1, free);
    near(r.x, 0.25);
    near(r.y, 0.25);
    near(r.w, 0.6);
    near(r.h, 0.6);
  });

  it('resizes about the centre with Alt', () => {
    const r = resizeRect(start, 'e', 0.1, 0, { ...free, fromCenter: true });
    near(r.x, 0.15);
    near(r.w, 0.7);
    near(r.h, 0.5);
  });

  it('keeps an aspect on corners and edges', () => {
    const r = resizeRect(start, 'se', 0.1, 0, { ...free, aspect: 1.5 });
    near((r.w * IA) / r.h, 1.5);
    near(r.x, 0.25);
    near(r.y, 0.25);
    const e = resizeRect(start, 'n', 0, -0.1, { ...free, aspect: 1.5 });
    near((e.w * IA) / e.h, 1.5);
    near(e.y + e.h, 0.75);
    // The other axis grows about the centre.
    near(e.x + e.w / 2, 0.5);
  });

  it('never inverts the rect', () => {
    const r = resizeRect(start, 'w', 2, 0, free);
    near(r.w * IA, MIN_CROP);
    near(r.x + r.w, 0.75);
  });

  it('stops at the rotated image; a free crop keeps sliding along the other axis', () => {
    const r = resizeRect(start, 'se', 1, 0.05, { ...free, angle: 10 });
    expect(cropFits(r, 10, IA)).toBe(true);
    expect(r.w).toBeGreaterThan(0.5);
    // Level: y follows the pointer even though x hit the edge.
    const level = resizeRect(start, 'se', 1, 0.05, free);
    near(level.x + level.w, 1);
    near(level.h, 0.55);
    const locked = resizeRect(start, 'se', 1, 1, { ...free, angle: 10, aspect: 1.5 });
    expect(cropFits(locked, 10, IA)).toBe(true);
    near((locked.w * IA) / locked.h, 1.5);
    near(locked.x, 0.25);
  });

  it('only keeps the rect inside the frame when constrain is off', () => {
    const r = resizeRect(start, 'se', 1, 1, { ...free, angle: 30, constrain: false });
    near(r.x + r.w, 1);
    near(r.y + r.h, 1);
  });
});

describe('orientRatio', () => {
  it('follows the orientation of the crop', () => {
    expect(orientRatio([5, 4], { x: 0, y: 0, w: 0.3, h: 0.9 }, IA)).toEqual([4, 5]);
    expect(orientRatio([4, 5], { x: 0, y: 0, w: 1, h: 1 }, IA)).toEqual([5, 4]);
  });
});
