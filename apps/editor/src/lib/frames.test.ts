import {
  applyLayout,
  type Frame,
  LayoutDataSchema,
  type Page,
  resolveTheme,
  spacing,
  templateFor,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { describe, expect, it } from 'vitest';
import { clampMovedFrame } from '../components/editor/frameMove';
import {
  bleedBounds,
  drawnFrame,
  fitResized,
  frameWithField,
  gridFrames,
  minFrameSize,
  pageToLayoutData,
  photoDropFrame,
  pointToPage,
  rectFromDrag,
  resizeFrame,
  saveLayoutBlocker,
  textKindOf,
} from './frames';

const template = templateFor('phone-portrait');
const theme = resolveTheme(fixtureBook.theme);
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);

describe('frame geometry', () => {
  it('minimum photo size is 1.5 in: 0.1875 of the width, the same inches on the height', () => {
    const min = minFrameSize(template, 'photo');
    close(min.w, 0.1875);
    close(min.h * template.height, min.w * template.width);
  });

  it('a 3 x 2 grid inside the margins has equal gutters and touches the safe box', () => {
    const frames = gridFrames({ cols: 3, rows: 2 }, theme, template);
    const s = spacing(theme.margin, theme.gutter, template.width / template.height);
    expect(frames).toHaveLength(6);
    const [a, b, c, d] = frames as [Frame, Frame, Frame, Frame];
    close(a.x, s.mx);
    close(a.y, s.my);
    close(b.x - (a.x + a.w), s.gx);
    close(c.x - (b.x + b.w), s.gx);
    close(d.y - (a.y + a.h), s.gy);
    close(c.x + c.w, 1 - s.mx);
    close((frames[5] as Frame).y + (frames[5] as Frame).h, 1 - s.my);
    // Equal gutters in page pixels on both axes.
    close(s.gx * template.width, s.gy * template.height);
    // A bleed grid runs edge to edge.
    const bleed = gridFrames({ cols: 2, rows: 2, bleed: true, wide: true }, theme, template);
    close((bleed[0] as Frame).x, 0);
    close((bleed[3] as Frame).x + (bleed[3] as Frame).w, 1);
    close((bleed[1] as Frame).x - ((bleed[0] as Frame).x + (bleed[0] as Frame).w), theme.wideGutter);
  });

  it('draws a rect from pointer coordinates, in any direction, grown to the minimum size', () => {
    const rect = { left: 100, top: 50, width: 400, height: 500 };
    const a = pointToPage(140, 100, rect);
    expect(a).toEqual({ x: 0.1, y: 0.1 });
    // Off the page clamps to the page.
    expect(pointToPage(0, 1000, rect)).toEqual({ x: 0, y: 1 });
    const b = pointToPage(380, 400, rect);
    expect(rectFromDrag(a, b)).toEqual({ frame: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }, handle: 'se' });
    // Up and to the left: the same rectangle, dragged by the north-west corner.
    const back = rectFromDrag(b, a);
    expect(back.handle).toBe('nw');
    close(back.frame.x, 0.1);
    close(back.frame.w, 0.6);
    // A tiny drag becomes the minimum size, anchored at the press point.
    const min = minFrameSize(template, 'photo');
    const small = drawnFrame({ x: 0.5, y: 0.5 }, { x: 0.45, y: 0.52 }, min);
    close(small.x + small.w, 0.5);
    close(small.w, min.w);
    close(small.y, 0.5);
    close(small.h, min.h);
    // Near the edge the page wins over the minimum.
    const edge = drawnFrame({ x: 0.95, y: 0.5 }, { x: 0.97, y: 0.8 }, min);
    close(edge.x + edge.w, 1);
  });

  it('resizes with the ratio locked from a corner and keeps the frame on the page', () => {
    const start: Frame = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 };
    const raw = resizeFrame(start, 'se', 0.1, 0, true);
    close(raw.w / raw.h, 2);
    close(raw.x, 0.2);
    close(raw.w, 0.5);
    const min = minFrameSize(template, 'photo');
    const huge = fitResized(resizeFrame(start, 'se', 2, 2, true), start, 'se', true, min);
    close(huge.x + huge.w, 1);
    close(huge.w / huge.h, 2);
    const tiny = fitResized(resizeFrame(start, 'nw', 0.39, 0.19, false), start, 'nw', false, min);
    close(tiny.w, min.w);
    close(tiny.h, min.h);
    close(tiny.x + tiny.w, 0.6);
    // An edge handle with the lock grows the other side around the centre.
    const east = resizeFrame(start, 'e', 0.1, 0, true);
    close(east.y + east.h / 2, 0.3);
    close(east.w / east.h, 2);
  });

  it('lets photo resizes run into the bleed like a move; text stays on the page', () => {
    const min = minFrameSize(template, 'photo');
    const photo = bleedBounds('photo', theme.bleed, template);
    expect(photo.x).toBe(theme.bleed);
    close(photo.y * template.height, theme.bleed * template.width);
    expect(bleedBounds('text', theme.bleed, template)).toEqual({ x: 0, y: 0 });

    const start: Frame = { x: 0.5, y: 0.5, w: 0.4, h: 0.3 };
    // Free east / south drag far past the trim stops at the bleed line.
    const free = fitResized(resizeFrame(start, 'se', 1, 1, false), start, 'se', false, min, photo);
    close(free.x + free.w, 1 + photo.x);
    close(free.y + free.h, 1 + photo.y);
    // The same bound as a move clamps to.
    const moved = clampMovedFrame({ ...start, x: 2 }, 'photo', theme.bleed, template);
    close(moved.x + moved.w, free.x + free.w);
    // West / north too.
    const nw = fitResized(resizeFrame(start, 'nw', -1, -1, false), start, 'nw', false, min, photo);
    close(nw.x, -photo.x);
    close(nw.y, -photo.y);
    // Locked: the ratio holds and the frame stops at the bleed.
    const locked = fitResized(resizeFrame(start, 'se', 1, 1, true), start, 'se', true, min, photo);
    close(locked.w / locked.h, start.w / start.h);
    expect(locked.x + locked.w).toBeLessThanOrEqual(1 + photo.x + 1e-6);
    expect(locked.y + locked.h).toBeLessThanOrEqual(1 + photo.y + 1e-6);
    // Without bounds (text) the page edge still wins.
    const text = fitResized(resizeFrame(start, 'se', 1, 1, false), start, 'se', false, min);
    close(text.x + text.w, 1);
  });

  it('applies inspector fields in inches, keeping the ratio when locked', () => {
    const start: Frame = { x: 0.1, y: 0.1, w: 0.5, h: 0.4 };
    const opts = { template, lock: true, min: minFrameSize(template, 'photo'), bleed: { x: 0, y: 0 } };
    const w = frameWithField(start, 'w', 2, opts);
    close(w.w, 0.25);
    close(w.w / w.h, start.w / start.h);
    const x = frameWithField(start, 'x', 1, opts);
    close(x.x, 0.125);
    close(x.w, 0.5);
    const free = frameWithField(start, 'h', 2, { ...opts, lock: false });
    close(free.h, 0.2);
    close(free.w, 0.5);
  });
});

describe('photoDropFrame', () => {
  const s = spacing(theme.margin, theme.gutter, template.width / template.height);

  it('fits a landscape photo across the safe width, centred, at its aspect', () => {
    const f = photoDropFrame({ width: 3000, height: 2000 }, theme, template);
    close(f.x, s.mx);
    close(f.x + f.w, 1 - s.mx);
    close((f.w * template.width) / (f.h * template.height), 1.5);
    close(f.y + f.h / 2, 0.5);
  });

  it('fits a tall photo to the safe height, centred', () => {
    const f = photoDropFrame({ width: 1000, height: 3000 }, theme, template);
    close(f.y, s.my);
    close(f.y + f.h, 1 - s.my);
    close((f.w * template.width) / (f.h * template.height), 1 / 3);
    close(f.x + f.w / 2, 0.5);
  });

  it('fills the safe-margin box when the photo size is unknown', () => {
    const f = photoDropFrame(undefined, theme, template);
    expect(f).toEqual({
      x: s.mx,
      y: expect.closeTo(s.my, 6),
      w: expect.closeTo(1 - 2 * s.mx, 6),
      h: expect.closeTo(1 - 2 * s.my, 6),
    });
  });
});

describe('save as layout', () => {
  const page = fixtureBook.pages[0] as Page;

  it('maps text styles to layout text roles', () => {
    const [title, caption] = page.elements.filter((e) => e.type === 'text');
    if (title?.type !== 'text' || caption?.type !== 'text') throw new Error('fixture text');
    expect(textKindOf(title)).toBe('title');
    expect(textKindOf(caption)).toBe('capR');
    expect(textKindOf({ ...caption, align: 'left' })).toBe('cap');
    expect(textKindOf({ ...caption, style: 'body' })).toBe('para');
    expect(textKindOf({ ...caption, style: 'quote' })).toBe('quote');
  });

  it('produces valid layout data whose apply reproduces the frames', () => {
    const data = pageToLayoutData(page, '  Hero trio  ', 'custom-test');
    if (!data) throw new Error('not saved');
    expect(() => LayoutDataSchema.parse(data)).not.toThrow();
    expect(data).toMatchObject({ id: 'custom-test', name: 'Hero trio', photos: 3, group: 'custom', source: 'custom' });
    expect(data.items.map((i) => i.kind)).toEqual(['photo', 'photo', 'photo', 'title', 'capR']);

    const blank: Page = { ...page, layout: 'blank', elements: [] };
    const applied = applyLayout(blank, data.id, theme, template, [data]);
    expect(applied.layout).toBe(data.id);
    const frames = (p: Page) => p.elements.map((e) => [e.type, e.frame.x, e.frame.y, e.frame.w, e.frame.h]);
    const want = frames(page);
    frames(applied).forEach((got, i) => {
      expect(got[0]).toBe(want[i]?.[0]);
      for (let k = 1; k < 5; k++) close(got[k] as number, want[i]?.[k] as number);
    });
  });

  it('refuses pages without photos or with more than six', () => {
    expect(saveLayoutBlocker({ elements: [] })).not.toBeNull();
    const texts = { elements: page.elements.filter((e) => e.type === 'text') };
    expect(saveLayoutBlocker(texts)).not.toBeNull();
    expect(pageToLayoutData(texts, 'x')).toBeNull();
    const photo = page.elements[0];
    if (!photo) throw new Error('fixture photo');
    const seven = { elements: Array.from({ length: 7 }, (_, i) => ({ ...photo, id: `p${i}` })) };
    expect(saveLayoutBlocker(seven)).toMatch(/at most 6/);
    expect(saveLayoutBlocker(page)).toBeNull();
  });
});
