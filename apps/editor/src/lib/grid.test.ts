import { templateFor } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { captionFrame, GRID_PT, gridStep, moveFrame, NEW_TEXT_HEIGHT, snap } from './grid';

const portrait = templateFor('phone-portrait');
const theme = { margin: 0.04, gutter: 0.02 };
// Snapped values are rounded to 1e-6 of the page, i.e. well under 1e-3 of a grid step.
const onGrid = (value: number, step: number) => Math.abs(value / step - Math.round(value / step)) < 1e-3;

describe('page grid', () => {
  it('is 8 pt of the template, as page fractions', () => {
    expect(gridStep(portrait)).toEqual({ x: GRID_PT / portrait.width, y: GRID_PT / portrait.height });
    expect(gridStep(portrait).y).toBeCloseTo(8 / 1350, 12);
  });

  it('snaps to the nearest grid line', () => {
    const step = 8 / 1350;
    expect(snap(0.5, step)).toBeCloseTo(84 * step, 6);
    expect(onGrid(snap(0.123456, step), step)).toBe(true);
    expect(snap(0.3, 0)).toBe(0.3);
  });

  it('moveFrame snaps y and x to the grid and keeps the frame on the page', () => {
    const start = { x: 0.1, y: 0.2, w: 0.5, h: 0.06 };
    const moved = moveFrame(start, 0.0123, 0.0345, portrait);
    const step = gridStep(portrait);
    expect(onGrid(moved.y, step.y)).toBe(true);
    expect(onGrid(moved.x, step.x)).toBe(true);
    expect(Math.abs(moved.y - (start.y + 0.0345))).toBeLessThanOrEqual(step.y / 2 + 1e-9);
    expect(moved.w).toBe(start.w);
    expect(moved.h).toBe(start.h);
    // Clamped inside the page.
    expect(moveFrame(start, 2, 2, portrait)).toMatchObject({ x: 0.5, y: 0.94 });
    expect(moveFrame(start, -2, -2, portrait)).toMatchObject({ x: 0, y: 0 });
  });

  it('captionFrame sits on the bottom margin, full content width, y on the grid', () => {
    const f = captionFrame(portrait, theme);
    const my = 0.04 * (portrait.width / portrait.height); // margin is a fraction of the width
    const mx = 0.04;
    expect(f.x).toBeCloseTo(mx, 6);
    expect(f.w).toBeCloseTo(1 - 2 * mx, 6);
    expect(f.h).toBe(NEW_TEXT_HEIGHT);
    expect(onGrid(f.y, gridStep(portrait).y)).toBe(true);
    expect(f.y + f.h).toBeLessThanOrEqual(1 - my + 1e-9);
    expect(1 - my - (f.y + f.h)).toBeLessThan(gridStep(portrait).y);
  });
});
