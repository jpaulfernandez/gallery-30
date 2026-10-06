import { describe, expect, it } from 'vitest';
import type { Frame, Page, PhotoElement, TextElement } from '../schema.js';
import { BOOK_TEMPLATES } from '../templates.js';
import { applyLayout, layoutFrames, layoutWireframe, SLOT_RATIOS, setSlotRatio } from './apply.js';
import { spacing } from './geometry.js';
import { getLayout, LAYOUTS, layoutsByCount } from './layouts.js';

const EPS = 1e-6;
const THEME = { margin: 0.04, gutter: 0.02 };
const TEMPLATES = [BOOK_TEMPLATES['phone-portrait'], BOOK_TEMPLATES.square];

function overlaps(a: Frame, b: Frame): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

function inside(f: Frame): boolean {
  return f.x >= -EPS && f.y >= -EPS && f.w > 0 && f.h > 0 && f.x + f.w <= 1 + EPS && f.y + f.h <= 1 + EPS;
}

describe('layouts', () => {
  it('has unique ids, the library plus the 24 legacy layouts, covering 1 to 6 photos', () => {
    const ids = LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LAYOUTS.filter((l) => l.legacy)).toHaveLength(24);
    for (const l of LAYOUTS.filter((l) => l.legacy)) expect(l.group).toBe('photos');
    for (const group of layoutsByCount()) {
      expect(group.layouts.length).toBeGreaterThanOrEqual(3);
      expect(group.layouts.some((l) => l.legacy)).toBe(false);
    }
    const withLegacy = layoutsByCount({ includeLegacy: true }).flatMap((g) => g.layouts);
    expect(withLegacy).toHaveLength(LAYOUTS.length);
  });

  for (const template of TEMPLATES) {
    for (const theme of [THEME, { margin: 0, gutter: 0 }, { margin: 0.08, gutter: 0.04 }]) {
      describe(`${template.name} margin ${theme.margin} gutter ${theme.gutter}`, () => {
        for (const layout of LAYOUTS) {
          it(`${layout.id} fits the page without overlaps`, () => {
            const { slots, items } = layoutFrames(layout, theme, template);
            expect(slots).toHaveLength(layout.photos);
            for (const f of items) expect(inside(f), JSON.stringify(f)).toBe(true);
            for (let i = 0; i < items.length; i++) {
              for (let j = i + 1; j < items.length; j++) {
                const a = items[i] as (typeof items)[number];
                const b = items[j] as (typeof items)[number];
                // Overlay text sits on its photo by design.
                if (a.kind === 'overlay' || b.kind === 'overlay') continue;
                expect(overlaps(a, b), `${i} vs ${j}`).toBe(false);
              }
            }
          });
        }
      });
    }
  }

  it('converts the width-fraction margin to page fractions on a non-square page', () => {
    const s = spacing(0.04, 0.02, 1080 / 1350);
    expect(s.mx).toBeCloseTo(0.04);
    expect(s.my).toBeCloseTo((0.04 * 1080) / 1350);
    // Equal margins in pixels on all four sides.
    expect(s.mx * 1080).toBeCloseTo(s.my * 1350);
    expect(s.gx * 1080).toBeCloseTo(s.gy * 1350);
  });

  it('treats margin and gutter as fractions of the width on a landscape page too', () => {
    const s = spacing(0.04, 0.02, 1350 / 1080);
    expect(s.mx).toBeCloseTo(0.04, 12);
    expect(s.gx).toBeCloseTo(0.02, 12);
    expect(s.my).toBeCloseTo((0.04 * 1350) / 1080, 12);
    expect(s.mx * 1350).toBeCloseTo(s.my * 1080);
    expect(s.gx * 1350).toBeCloseTo(s.gy * 1080);
  });

  it('keeps a full-bleed layout at the page edges', () => {
    const single = getLayout('single-full');
    if (!single) throw new Error('missing single-full');
    expect(layoutFrames(single, THEME, TEMPLATES[0] as never).slots).toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
  });

  it('exposes wireframes with a text frame for caption layouts', () => {
    const layout = getLayout('single-caption');
    if (!layout) throw new Error('missing single-caption');
    const frames = layoutWireframe(layout, THEME, BOOK_TEMPLATES.square);
    expect(frames.map((f) => f.kind)).toEqual(['photo', 'text']);
  });
});

function photo(id: string, asset: string | null, extra: Partial<PhotoElement> = {}): PhotoElement {
  return {
    type: 'photo',
    id,
    asset,
    frame: { x: 0, y: 0, w: 1, h: 1 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none',
    ...extra,
  };
}

const caption = (id: string, frame: Frame = { x: 0.1, y: 0.1, w: 0.5, h: 0.05 }): TextElement => ({
  type: 'text',
  id,
  text: 'hello',
  style: 'caption',
  frame,
  align: 'left',
});

const portrait = BOOK_TEMPLATES['phone-portrait'];

describe('applyLayout', () => {
  const page: Page = {
    id: 'p',
    layout: 'three-hero-two',
    background: '#fff',
    elements: [
      photo('a', 'A1', { crop: { x: 0.1, y: -0.05, scale: 1.4 }, rotate: 90, filter: 'bw', ratio: '4:5' }),
      photo('b', 'B1'),
      photo('c', null),
    ],
  };

  it('pours photos into the new slots in order and keeps ids, crop, rotate and filter', () => {
    const next = applyLayout(page, 'four-grid', THEME, portrait);
    expect(next.layout).toBe('four-grid');
    const photos = next.elements.filter((e): e is PhotoElement => e.type === 'photo');
    expect(photos.map((p) => p.id).slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(photos.map((p) => p.asset)).toEqual(['A1', 'B1', null, null]);
    expect(photos[0]).toMatchObject({ crop: { x: 0.1, y: -0.05, scale: 1.4 }, rotate: 90, filter: 'bw' });
    expect(photos[0]?.ratio).toBeUndefined();
    expect(photos[3]?.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(photos[3]).toMatchObject({ asset: null, crop: { x: 0, y: 0, scale: 1 }, rotate: 0, filter: 'none' });
    const grid = getLayout('four-grid');
    if (!grid) throw new Error('missing four-grid');
    expect(photos.map((p) => p.frame)).toEqual(layoutFrames(grid, THEME, portrait).slots);
  });

  it('drops extra photos and survives a round trip in order', () => {
    const two = applyLayout(page, 'two-side-by-side', THEME, portrait);
    expect(two.elements.map((e) => e.id)).toEqual(['a', 'b']);
    const back = applyLayout(two, 'three-hero-two', THEME, portrait);
    const ids = back.elements.map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual(['a', 'b']);
    expect(ids).toHaveLength(3);
    expect(back.elements.map((e) => (e.type === 'photo' ? e.asset : 'text'))).toEqual(['A1', 'B1', null]);
  });

  it('keeps real photos over empty slots when shrinking', () => {
    const gappy: Page = { ...page, elements: [photo('e', null), photo('a', 'A1'), photo('b', 'B1')] };
    const two = applyLayout(gappy, 'two-side-by-side', THEME, portrait);
    expect(two.elements.map((e) => [e.id, e.type === 'photo' ? e.asset : 'text'])).toEqual([
      ['a', 'A1'],
      ['b', 'B1'],
    ]);
    // Growing keeps the empty slot, after the photos, before the new ones.
    const four = applyLayout(gappy, 'four-grid', THEME, portrait);
    expect(four.elements.map((e) => e.id).slice(0, 3)).toEqual(['a', 'b', 'e']);
    expect(four.elements).toHaveLength(4);
  });

  it('adds an empty caption when the layout has one and the page has no text', () => {
    const next = applyLayout(page, 'single-caption', THEME, portrait);
    const texts = next.elements.filter((e) => e.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: '', style: 'caption' });
    const layout = getLayout('single-caption');
    if (!layout) throw new Error('missing single-caption');
    expect(texts[0]?.frame).toEqual(layoutFrames(layout, THEME, portrait).caption);
  });

  it('moves the first text to the caption frame and keeps extra text at its own frame', () => {
    const t2Frame = { x: 0.2, y: 0.8, w: 0.3, h: 0.05 };
    const t2 = caption('t2', t2Frame);
    const withText: Page = { ...page, elements: [...page.elements, caption('t1'), t2] };
    const next = applyLayout(withText, 'single-caption', THEME, portrait);
    const texts = next.elements.filter((e) => e.type === 'text');
    expect(texts.map((t) => [t.id, t.text])).toEqual([
      ['t1', 'hello'],
      ['t2', 'hello'],
    ]);
    expect(texts[0]?.frame).not.toEqual(caption('x').frame);
    // Extra text (beyond the layout's text items) is kept untouched, after the layout's text.
    expect(texts[1]).toEqual(t2);
    // Without a text item every text is extra and kept at its frame.
    const grid = applyLayout(withText, 'four-grid', THEME, portrait);
    expect(grid.elements.filter((e) => e.type === 'text')).toEqual([caption('t1'), t2]);
    expect(grid.elements.map((e) => e.type)).toEqual(['photo', 'photo', 'photo', 'photo', 'text', 'text']);
  });

  it('drops empty extra text boxes (unused placeholders)', () => {
    const empty = { ...caption('t2'), text: '  ' };
    const next = applyLayout({ ...page, elements: [...page.elements, empty] }, 'four-grid', THEME, portrait);
    expect(next.elements.filter((e) => e.type === 'text')).toEqual([]);
  });

  it('throws on an unknown layout', () => {
    expect(() => applyLayout(page, 'nope', THEME, portrait)).toThrow(/unknown layout/);
  });
});

describe('setSlotRatio', () => {
  const ratioOf = (f: Frame, t = portrait) => (f.w * t.width) / (f.h * t.height);

  it('offers the six inspector ratios', () => {
    expect(SLOT_RATIOS).toEqual(['3:2', '4:3', '1:1', '4:5', '2:3', '3:4']);
  });

  it('resizes around the centre to the ratio in page pixels', () => {
    const page = applyLayout(
      { id: 'p', layout: 'x', background: '#fff', elements: [photo('a', 'A'), photo('b', 'B')] },
      'two-stacked',
      THEME,
      portrait,
    );
    const before = page.elements[0]?.frame as Frame;
    for (const ratio of SLOT_RATIOS) {
      const next = setSlotRatio(page, 'a', ratio, portrait, THEME);
      const el = next.elements[0] as PhotoElement;
      const [w, h] = ratio.split(':').map(Number) as [number, number];
      expect(ratioOf(el.frame)).toBeCloseTo(w / h, 6);
      expect(el.ratio).toBe(ratio);
      expect(el.frame.x + el.frame.w / 2).toBeCloseTo(before.x + before.w / 2, 9);
      expect(el.frame.y + el.frame.h / 2).toBeCloseTo(before.y + before.h / 2, 9);
      // Stays inside its layout slot, so it never spills into the neighbour.
      expect(el.frame.w).toBeLessThanOrEqual(before.w + EPS);
      expect(el.frame.h).toBeLessThanOrEqual(before.h + EPS);
      expect(next.elements[1]).toBe(page.elements[1]);
    }
  });

  it('does not shrink step by step when toggling ratios with the theme', () => {
    const page = applyLayout(
      { id: 'p', layout: 'x', background: '#fff', elements: [photo('a', 'A')] },
      'single-framed',
      THEME,
      portrait,
    );
    const once = setSlotRatio(page, 'a', '3:2', portrait, THEME);
    const twice = setSlotRatio(setSlotRatio(once, 'a', '2:3', portrait, THEME), 'a', '3:2', portrait, THEME);
    expect(twice.elements[0]?.frame).toEqual(once.elements[0]?.frame);
  });

  it('clamps to the page by shrinking around the centre', () => {
    // A slot centred near the left edge: the ratio change must not push it off the page.
    const page: Page = {
      id: 'p',
      layout: 'custom',
      background: '#fff',
      elements: [photo('a', 'A', { frame: { x: 0, y: 0.1, w: 0.2, h: 0.8 } })],
    };
    const next = setSlotRatio(page, 'a', '3:2', portrait);
    const f = (next.elements[0] as PhotoElement).frame;
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.w).toBeLessThanOrEqual(1 + EPS);
    expect(f.y + f.h).toBeLessThanOrEqual(1 + EPS);
    expect(ratioOf(f)).toBeCloseTo(1.5, 6);
    expect(f.x + f.w / 2).toBeCloseTo(0.1, 9);
  });

  it('shrinks a full-bleed slot so a square still fits a 4:5 page', () => {
    const page: Page = { id: 'p', layout: 'single-full', background: '#fff', elements: [photo('a', 'A')] };
    const f = (setSlotRatio(page, 'a', '1:1', portrait, THEME).elements[0] as PhotoElement).frame;
    expect(f.w).toBeCloseTo(1, 9);
    expect(f.h).toBeCloseTo(1080 / 1350, 9);
    expect(f.y).toBeCloseTo((1 - 1080 / 1350) / 2, 9);
  });

  it('returns the page unchanged for an unknown element', () => {
    const page: Page = { id: 'p', layout: 'single-full', background: '#fff', elements: [photo('a', 'A')] };
    expect(setSlotRatio(page, 'zzz', '1:1', portrait)).toBe(page);
  });
});
