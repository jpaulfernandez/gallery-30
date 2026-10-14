import { describe, expect, it } from 'vitest';
import type { LayoutData, LayoutItem, Page, PhotoElement, TextElement } from '../schema.js';
import { LayoutDataSchema } from '../schema.js';
import { BOOK_TEMPLATES } from '../templates.js';
import { applyLayout, layoutFrames, layoutWireframe, reflowLayout, setSlotRatio } from './apply.js';
import { LAYOUT_BLANK, LAYOUT_CUSTOM } from './blank.js';
import { fromLayoutData, layoutItemsFor, toLayoutData } from './data.js';
import { getLayout, LAYOUTS, layoutsByCountAndGroup } from './layouts.js';
import { heroIndex, LAYOUT_LIBRARY } from './library.js';

const EPS = 1e-6;
const portrait = BOOK_TEMPLATES['phone-portrait'];
const square = BOOK_TEMPLATES.square;
const LIB = { margin: 0.08, gutter: 0.025 };

const lib = (id: string): LayoutData => {
  const l = LAYOUT_LIBRARY.find((x) => x.id === id);
  if (!l) throw new Error(`missing ${id}`);
  return l;
};
const photosOf = (items: readonly LayoutItem[]) => items.filter((i) => i.kind === 'photo');
const overlap = (a: LayoutItem, b: LayoutItem) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

describe('LAYOUT_LIBRARY', () => {
  it('ports every layout of the reference page, per count and group', () => {
    const counts = [1, 2, 3, 4, 5, 6].map((n) => [
      LAYOUT_LIBRARY.filter((l) => l.photos === n && l.group === 'photos').length,
      LAYOUT_LIBRARY.filter((l) => l.photos === n && l.group === 'captioned').length,
    ]);
    expect(counts).toEqual([
      [11, 10],
      [11, 5],
      [10, 5],
      [11, 5],
      [5, 3],
      [5, 3],
    ]);
    expect(LAYOUT_LIBRARY).toHaveLength(84);
  });

  it('uses slug ids with a c prefix for captioned layouts', () => {
    const ids = LAYOUT_LIBRARY.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      '3-hero-over-two',
      'c3-journal-rows',
      '1-tall-2-3-on-white',
      '5-2-1-2-sandwich',
      '6-hero-two-three',
    ])
      expect(ids).toContain(id);
    expect(lib('c2-hero-detail-caption-in-the-gap').name).toBe('Hero + detail, caption in the gap');
    expect(lib('1-full-bleed')).toMatchObject({ best: 'The one shot everyone remembers', bleed: true });
  });

  for (const layout of LAYOUT_LIBRARY) {
    it(`${layout.id}: valid, inside the page, photo count matches, photos never overlap`, () => {
      expect(LayoutDataSchema.safeParse(layout).success).toBe(true);
      expect(layout.source).toBe('library');
      for (const it of layout.items) {
        expect(it.x).toBeGreaterThanOrEqual(-EPS);
        expect(it.y).toBeGreaterThanOrEqual(-EPS);
        expect(it.x + it.w).toBeLessThanOrEqual(1 + EPS);
        expect(it.y + it.h).toBeLessThanOrEqual(1 + EPS);
      }
      const photos = photosOf(layout.items);
      expect(photos).toHaveLength(layout.photos);
      for (let i = 0; i < photos.length; i++)
        for (let j = i + 1; j < photos.length; j++)
          expect(overlap(photos[i] as LayoutItem, photos[j] as LayoutItem), `${i} vs ${j}`).toBe(false);
      expect(layout.group === 'captioned').toBe(layout.items.some((i) => i.kind !== 'photo'));
    });
  }

  it('converts authoring units to fractions (x, w / 100; y, h / 125)', () => {
    const [hero, a, b] = lib('3-hero-over-two').items;
    const rh = (109 - 2 * 2.5) / 3;
    expect(hero).toEqual({ kind: 'photo', x: 0.08, y: 0.064, w: 0.84, h: expect.closeTo((2 * rh + 2.5) / 125, 6) });
    expect(a?.w).toBeCloseTo((84 - 2.5) / 2 / 100, 6);
    expect(b?.x).toBeCloseTo((8 + (84 - 2.5) / 2 + 2.5) / 100, 6);
    expect((b?.y ?? 0) + (b?.h ?? 0)).toBeCloseTo(117 / 125, 6);
    expect(lib('c1-quote-page').items[0]).toEqual({ kind: 'quote', x: 0.16, y: 22 / 125, w: 0.68, h: 34 / 125 });
  });
});

describe('heroIndex', () => {
  it('finds a photo at least 1.6x the next largest', () => {
    expect(heroIndex(lib('3-hero-over-two').items)).toBe(0);
    expect(heroIndex(lib('c3-bleed-hero-overlay-title').items)).toBe(0);
    expect(heroIndex(lib('3-two-over-hero').items)).toBe(2);
    expect(heroIndex(lib('4-classic-quad').items)).toBe(-1);
    expect(heroIndex(lib('1-full-bleed').items)).toBe(-1);
  });

  it('flags the hero on wireframes', () => {
    const def = getLayout('3-two-over-hero');
    if (!def) throw new Error('missing');
    const frames = layoutWireframe(def, LIB, portrait);
    expect(frames.map((f) => !!f.hero)).toEqual([false, false, true]);
    const story = getLayout('c1-story-page');
    if (!story) throw new Error('missing');
    expect(layoutWireframe(story, LIB, portrait).map((f) => f.textKind ?? f.kind)).toEqual(['photo', 'title', 'para']);
  });
});

describe('layoutItemsFor', () => {
  it('is the stored data on a 4:5 page with the library margin', () => {
    const l = lib('c3-journal-rows');
    expect(layoutItemsFor(l, portrait, LIB)).toEqual(l.items);
  });

  it('maps the live area to the theme margin and leaves trim edges alone', () => {
    const theme = { margin: 0.04, gutter: 0.02 };
    const [first] = layoutItemsFor(lib('4-classic-quad'), portrait, theme);
    expect(first?.x).toBeCloseTo(0.04, 9);
    expect(first?.y).toBeCloseTo(0.032, 9);
    const quad = layoutItemsFor(lib('4-classic-quad'), portrait, theme);
    const last = quad[3] as LayoutItem;
    expect(last.x + last.w).toBeCloseTo(0.96, 9);
    expect(last.y + last.h).toBeCloseTo(0.968, 9);
    expect(layoutItemsFor(lib('1-full-bleed'), portrait, theme)).toEqual([{ kind: 'photo', x: 0, y: 0, w: 1, h: 1 }]);
    const [side] = layoutItemsFor(lib('1-bleed-side'), portrait, theme);
    expect(side).toMatchObject({ x: 0, y: 0, h: 1 });
    expect(side?.w).toBeCloseTo(0.04 + ((0.7 - 0.08) * 0.92) / 0.84, 9);
  });

  it('stretches vertically on a square page and keeps equal pixel margins', () => {
    const items = layoutItemsFor(lib('3-hero-over-two'), square, LIB);
    const ys = items.flatMap((i) => [i.y, i.y + i.h]);
    expect(Math.min(...ys)).toBeCloseTo(0.08, 9);
    expect(Math.max(...ys)).toBeCloseTo(0.92, 9);
    expect(items[0]?.x).toBeCloseTo(0.08, 9);
    for (const theme of [LIB, { margin: 0, gutter: 0 }, { margin: 0.12, gutter: 0.04 }]) {
      for (const l of LAYOUT_LIBRARY) {
        for (const it of layoutItemsFor(l, square, theme)) {
          expect(it.x >= -EPS && it.y >= -EPS && it.x + it.w <= 1 + EPS && it.y + it.h <= 1 + EPS).toBe(true);
        }
      }
    }
  });

  it('rescales library gutters to the theme gutter, keeping the live area', () => {
    const quad = layoutItemsFor(lib('4-classic-quad'), portrait, { margin: 0.08, gutter: 0.06 });
    const [a, b, c] = quad as [LayoutItem, LayoutItem, LayoutItem, LayoutItem];
    // Columns: a 0.06 gap (width fraction); rows: the same distance in height units.
    expect(b.x - (a.x + a.w)).toBeCloseTo(0.06, 9);
    expect(c.y - (a.y + a.h)).toBeCloseTo(0.06 * (portrait.width / portrait.height), 9);
    expect(a.x).toBeCloseTo(0.08, 9);
    expect(b.x + b.w).toBeCloseTo(0.92, 9);
    expect(a.w).toBeCloseTo(b.w, 9);
    // The wide gutter follows theme.wideGutter.
    const wide = LAYOUT_LIBRARY.find((l) =>
      l.items.some((p) => l.items.some((q) => p !== q && Math.abs(q.x - (p.x + p.w) - 0.05) < 1e-9)),
    );
    if (!wide) throw new Error('no wide-gutter layout');
    const items = layoutItemsFor(wide, portrait, { margin: 0.08, gutter: 0.025, wideGutter: 0.1 });
    const gaps = items.flatMap((p) => items.map((q) => q.x - (p.x + p.w))).filter((g) => g > 1e-9);
    expect(gaps.some((g) => Math.abs(g - 0.1) < 1e-9)).toBe(true);
  });

  it('leaves bleed layouts alone and keeps every item on the page for any gutter', () => {
    for (const theme of [
      { margin: 0.08, gutter: 0.06 },
      { margin: 0.02, gutter: 0, wideGutter: 0 },
      { margin: 0.12, gutter: 0.2, wideGutter: 0.4 },
    ]) {
      expect(layoutItemsFor(lib('1-full-bleed'), portrait, theme)).toEqual([{ kind: 'photo', x: 0, y: 0, w: 1, h: 1 }]);
      for (const template of [portrait, square, BOOK_TEMPLATES['a4-landscape']]) {
        for (const l of LAYOUT_LIBRARY) {
          for (const it of layoutItemsFor(l, template, theme)) {
            const ok = it.x >= -EPS && it.y >= -EPS && it.x + it.w <= 1 + EPS && it.y + it.h <= 1 + EPS;
            expect(ok && it.w > 0 && it.h > 0, `${l.id} ${JSON.stringify(it)}`).toBe(true);
          }
        }
      }
    }
  });

  it('returns custom layouts unchanged', () => {
    const custom: LayoutData = {
      id: 'custom-a',
      name: 'Mine',
      photos: 1,
      group: 'custom',
      source: 'custom',
      items: [{ kind: 'photo', x: 0.1, y: 0.2, w: 0.5, h: 0.5 }],
    };
    expect(layoutItemsFor(custom, square, { margin: 0.02, gutter: 0 })).toEqual(custom.items);
  });
});

describe('LayoutData <-> LayoutDef', () => {
  it('wraps the library in LAYOUTS with picker metadata', () => {
    const def = getLayout('c2-staggered-with-captions');
    expect(def).toMatchObject({ photos: 2, group: 'captioned', best: 'Editorial pairs; captions fill the white' });
    expect(def?.legacy).toBeUndefined();
    expect(getLayout('4-edge-to-edge-quad')?.bleed).toBe(true);
    expect(getLayout('3-triptych-band')?.variant).toBe('portrait');
    expect(getLayout('3-three-strips')?.variant).toBe('landscape');
    expect(LAYOUTS.filter((l) => !l.legacy)).toHaveLength(LAYOUT_LIBRARY.length);
  });

  it('round-trips through toLayoutData / fromLayoutData', () => {
    for (const data of LAYOUT_LIBRARY) expect(toLayoutData(fromLayoutData(data))).toEqual(data);
    const legacy = getLayout('single-caption');
    if (!legacy) throw new Error('missing');
    const data = toLayoutData(legacy);
    expect(data).toMatchObject({ id: 'single-caption', photos: 1, group: 'captioned', source: 'library' });
    expect(data.items.map((i) => i.kind)).toEqual(['photo', 'cap']);
    expect(LayoutDataSchema.safeParse(data).success).toBe(true);
    const back = layoutFrames(fromLayoutData(data), LIB, portrait);
    const orig = layoutFrames(legacy, LIB, portrait);
    expect(back.slots[0]?.y).toBeCloseTo(orig.slots[0]?.y ?? 0, 9);
    expect(back.caption?.h).toBeCloseTo(orig.caption?.h ?? 0, 9);
  });

  it('groups by count and picker group, with the book layouts last', () => {
    const custom: LayoutData = {
      id: 'custom-b',
      name: 'Two up',
      photos: 2,
      group: 'custom',
      source: 'custom',
      items: [
        { kind: 'photo', x: 0, y: 0, w: 0.5, h: 1 },
        { kind: 'photo', x: 0.5, y: 0, w: 0.5, h: 1 },
      ],
    };
    const groups = layoutsByCountAndGroup([custom]);
    expect(
      groups.map((g) => [g.photos, g.layouts.photos.length, g.layouts.captioned.length, g.layouts.custom.length]),
    ).toEqual([
      [1, 11, 10, 0],
      [2, 11, 5, 1],
      [3, 10, 5, 0],
      [4, 11, 5, 0],
      [5, 5, 3, 0],
      [6, 5, 3, 0],
    ]);
  });
});

function photo(id: string, asset: string | null): PhotoElement {
  return {
    type: 'photo',
    id,
    asset,
    frame: { x: 0, y: 0, w: 1, h: 1 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0,
    filter: 'none',
  };
}
const text = (id: string, value: string, extra: Partial<TextElement> = {}): TextElement => ({
  type: 'text',
  id,
  text: value,
  style: 'caption',
  frame: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 },
  align: 'left',
  ...extra,
});
const photosIn = (p: Page) => p.elements.filter((e): e is PhotoElement => e.type === 'photo');
const textsIn = (p: Page) => p.elements.filter((e): e is TextElement => e.type === 'text');

describe('applyLayout with library layouts', () => {
  const page: Page = {
    id: 'p',
    layout: LAYOUT_BLANK,
    guides: [],
    background: '#fff',
    elements: [
      photo('a', 'A'),
      photo('b', 'B'),
      photo('c', null),
      text('t1', 'one', { family: 'Inter' }),
      text('t2', 'two'),
    ],
  };

  it('creates one text per text item, reuses text in order and keeps photo ids', () => {
    const rows = applyLayout(page, 'c3-journal-rows', LIB, portrait);
    expect(rows.layout).toBe('c3-journal-rows');
    expect(photosIn(rows).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    const { slots, texts } = layoutFrames(getLayout('c3-journal-rows') as never, LIB, portrait);
    expect(photosIn(rows).map((p) => p.frame)).toEqual(slots);
    const t = textsIn(rows);
    expect(t.map((x) => x.text)).toEqual(['one', 'two', '']);
    expect(t.slice(0, 2).map((x) => x.id)).toEqual(['t1', 't2']);
    expect(t[2]?.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(t.map((x) => x.frame)).toEqual(texts.map(({ kind: _k, ...f }) => f));
    expect(t[0]).toMatchObject({ style: 'caption', family: 'Inter' });
    // Photos first, then texts (overlay text paints above its photo).
    expect(rows.elements.map((e) => e.type)).toEqual(['photo', 'photo', 'photo', 'text', 'text', 'text']);

    const story = applyLayout(rows, 'c1-story-page', LIB, portrait);
    expect(story.elements.map((e) => e.id)).toEqual(['a', 't1', 't2']);
    expect(textsIn(story).map((x) => [x.style, x.text])).toEqual([
      ['title', 'one'],
      ['body', 'two'],
    ]);
    // The font override belonged to the caption style.
    expect(textsIn(story)[0]?.family).toBeUndefined();
  });

  it('maps every text kind to a text element', () => {
    const kinds = (id: string) => textsIn(applyLayout({ ...page, elements: [] }, id, LIB, portrait));
    expect(kinds('c1-overlay-on-full-bleed')[0]).toMatchObject({ style: 'caption', color: '#ffffff', overlay: true });
    expect(kinds('c1-bleed-footer-line').map((t) => [t.style, t.align])).toEqual([
      ['caption', 'left'],
      ['caption', 'right'],
    ]);
    const opener = kinds('c1-chapter-opener');
    expect(opener[0]).toMatchObject({ style: 'title', size: 0.12 });
    expect(kinds('c1-quote-page')[0]).toMatchObject({ style: 'quote' });
    expect(kinds('c3-three-text-cell')[0]).toMatchObject({ style: 'body', box: true });
    expect(kinds('c4-quad-numbered-key')[0]).toMatchObject({ style: 'body', size: 0.018 });
    expect(kinds('c1-story-page').map((t) => t.style)).toEqual(['title', 'body']);
  });

  it('empties the page for the blank layout', () => {
    expect(applyLayout(page, LAYOUT_BLANK, LIB, portrait)).toEqual({ ...page, layout: 'blank', elements: [] });
    const refilled = applyLayout(applyLayout(page, LAYOUT_BLANK, LIB, portrait), '2-stacked-pair', LIB, portrait);
    expect(photosIn(refilled).map((p) => p.asset)).toEqual([null, null]);
  });

  it('resolves the book custom layouts', () => {
    const custom: LayoutData = {
      id: 'custom-c',
      name: 'Corner',
      photos: 1,
      group: 'custom',
      source: 'custom',
      items: [
        { kind: 'photo', x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
        { kind: 'cap', x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
      ],
    };
    expect(() => applyLayout(page, 'custom-c', LIB, portrait)).toThrow(/unknown layout/);
    const next = applyLayout(page, 'custom-c', LIB, square, [custom]);
    expect(next.layout).toBe('custom-c');
    // t2 has no text item in the layout: kept at its own frame, after the layout's text.
    expect(next.elements.map((e) => [e.id, e.frame])).toEqual([
      ['a', { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }],
      ['t1', { x: 0.1, y: 0.1, w: 0.3, h: 0.05 }],
      ['t2', { x: 0.1, y: 0.1, w: 0.5, h: 0.05 }],
    ]);
    const ratioed = setSlotRatio(next, 'a', '1:1', square, LIB, [custom]);
    expect(photosIn(ratioed)[0]?.frame).toEqual({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 });
  });
});

describe('reflowLayout', () => {
  const base: Page = {
    id: 'p',
    layout: LAYOUT_BLANK,
    guides: [],
    background: '#fff',
    elements: [photo('a', 'A'), photo('b', null), text('t1', 'one')],
  };
  const wider = { margin: 0.12, gutter: 0.04 };

  it('moves slots and text items to the new geometry and touches nothing else', () => {
    const applied = applyLayout(base, 'c2-staggered-with-captions', LIB, portrait);
    const extraText = text('x', 'keep me', { frame: { x: 0.3, y: 0.3, w: 0.2, h: 0.05 } });
    const page: Page = { ...applied, elements: [...applied.elements, extraText] };
    const next = reflowLayout(page, wider, portrait);
    const def = getLayout('c2-staggered-with-captions');
    if (!def) throw new Error('missing');
    const { slots, texts } = layoutFrames(def, wider, portrait);
    expect(next.layout).toBe(page.layout);
    expect(next.elements.map((e) => e.id)).toEqual(page.elements.map((e) => e.id));
    expect(photosIn(next).map((p) => p.frame)).toEqual(slots);
    const t = textsIn(next);
    expect(t.slice(0, texts.length).map((x) => x.frame)).toEqual(texts.map(({ kind: _k, ...f }) => f));
    // Content is untouched; the extra text keeps its frame.
    expect(t.map((x) => x.text)).toEqual(textsIn(page).map((x) => x.text));
    expect(t[t.length - 1]).toBe(extraText);
    expect(photosIn(next).map((p) => [p.asset, p.crop])).toEqual(photosIn(page).map((p) => [p.asset, p.crop]));
  });

  it('never adds or removes elements, and leaves extra photos alone', () => {
    const applied = applyLayout(base, '1-gallery-mat', LIB, portrait);
    const extra = { ...photo('z', 'Z'), frame: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
    const page: Page = { ...applied, elements: [...applied.elements, extra] };
    const next = reflowLayout(page, wider, portrait);
    expect(next.elements).toHaveLength(page.elements.length);
    expect(next.elements.find((e) => e.id === 'z')).toBe(extra);
    // Missing text items are not created either.
    const bare: Page = { ...applied, layout: 'c1-story-page', elements: [photo('a', 'A')] };
    expect(reflowLayout(bare, wider, portrait).elements.map((e) => e.id)).toEqual(['a']);
  });

  it('keeps an inspector slot ratio inside the new slot', () => {
    const applied = applyLayout(base, '2-stacked-pair', LIB, portrait);
    const ratioed = setSlotRatio(applied, 'a', '1:1', portrait, LIB);
    const next = reflowLayout(ratioed, wider, portrait);
    const a = photosIn(next)[0] as PhotoElement;
    expect(a.ratio).toBe('1:1');
    expect((a.frame.w * portrait.width) / (a.frame.h * portrait.height)).toBeCloseTo(1, 6);
  });

  it('returns the page itself for blank, custom-frame and unknown layouts', () => {
    for (const layout of [LAYOUT_BLANK, LAYOUT_CUSTOM, 'nope']) {
      const page = { ...base, layout };
      expect(reflowLayout(page, wider, portrait)).toBe(page);
    }
  });
});

describe('getLayout and custom layouts', () => {
  it('resolves the book custom layouts before the library', () => {
    const clash: LayoutData = {
      id: '1-full-bleed',
      name: 'Clash',
      photos: 1,
      group: 'custom',
      source: 'custom',
      items: [{ kind: 'photo', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
    };
    expect(getLayout('1-full-bleed', [clash])?.name).toBe('Clash');
    expect(getLayout('1-full-bleed')?.name).not.toBe('Clash');
  });
});
