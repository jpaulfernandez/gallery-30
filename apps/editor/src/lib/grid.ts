import { type Frame, newId, type PageSize, spacing, type TextElement, type Theme } from '@photobook/shared';

/**
 * The page grid text frames snap to: 8 pt in template units, as a fraction of the page
 * (8 / 1350 of the height and 8 / 1080 of the width on the phone portrait template).
 */
export const GRID_PT = 8;

/** Height of a new text box, fraction of the page height. */
export const NEW_TEXT_HEIGHT = 0.06;

export function gridStep(template: PageSize): { x: number; y: number } {
  return { x: GRID_PT / template.width, y: GRID_PT / template.height };
}

/** Drop float noise so snapped values compare and serialize cleanly. */
const clean = (n: number): number => Math.round(n * 1e6) / 1e6;

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), Math.max(min, max));

/** Nearest multiple of `step`. */
export function snap(value: number, step: number): number {
  return step > 0 ? clean(Math.round(value / step) * step) : value;
}

/**
 * A frame moved by (dx, dy) page fractions: x and y snap to the grid, then the frame is clamped
 * inside the page. Width and height never change. Fallback only: canvas drags snap through the
 * shared engine (components/editor/snap.ts, frameMove.ts).
 */
export function moveFrame(start: Frame, dx: number, dy: number, template: PageSize): Frame {
  const step = gridStep(template);
  return {
    ...start,
    x: clean(clamp(snap(start.x + dx, step.x), 0, 1 - start.w)),
    y: clean(clamp(snap(start.y + dy, step.y), 0, 1 - start.h)),
  };
}

/**
 * Frame for a new caption: full content width inside the side margins, sitting on the bottom
 * margin. `y` is the grid line at or above `1 - margin - h`, so the box never crosses the margin.
 */
export function captionFrame(template: PageSize, theme: Pick<Theme, 'margin' | 'gutter'>): Frame {
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);
  const step = gridStep(template).y;
  const h = NEW_TEXT_HEIGHT;
  const y = clean(Math.floor(clean((1 - s.my - h) / step)) * step);
  return { x: clean(s.mx), y: Math.max(0, y), w: clean(1 - 2 * s.mx), h };
}

/** An empty caption text element at the bottom margin. */
export function newCaption(template: PageSize, theme: Pick<Theme, 'margin' | 'gutter'>): TextElement {
  return { type: 'text', id: newId(), text: '', style: 'caption', frame: captionFrame(template, theme), align: 'left' };
}
