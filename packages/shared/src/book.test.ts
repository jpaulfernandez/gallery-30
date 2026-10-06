import { describe, expect, it } from 'vitest';
import {
  BookLoadError,
  BookSchema,
  createEmptyBook,
  LAYOUT_BLANK,
  loadBook,
  parseBook,
  resolveTheme,
  serializeBook,
  THEME_DEFAULTS,
} from './index.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('createEmptyBook', () => {
  it('creates a valid phone-portrait book with one blank page', () => {
    const book = createEmptyBook({ title: 'Kyoto, April 2026', sourceFolder: '/Users/me/Pictures/kyoto' });

    expect(BookSchema.safeParse(book).success).toBe(true);
    expect(book.version).toBe(3);
    expect(book.id).toMatch(ULID);
    expect(book.template).toEqual({ name: 'phone-portrait', width: 1080, height: 1350 });
    expect(book.theme).toEqual(THEME_DEFAULTS);
    expect(book.theme).toMatchObject({ margin: 0.08, gutter: 0.025, wideGutter: 0.05, grid: 0.0139 });
    expect(book.customLayouts).toEqual([]);
    expect(book.publish.slug).toMatch(/^kyoto-april-2026-[a-z0-9]{4}$/);
    expect(book.publish).toMatchObject({ visibility: 'unlisted', lastPublishedAt: null });
    expect(book.pages).toHaveLength(1);

    const [page] = book.pages;
    expect(page?.layout).toBe(LAYOUT_BLANK);
    expect(page?.elements).toEqual([]);
    expect(page?.id).toMatch(ULID);
    expect(page?.background).toBe(book.theme.defaultPageBackground);
  });

  it('accepts another template by name', () => {
    const book = createEmptyBook({ title: 'Sq', sourceFolder: '/tmp/sq', template: 'square' });
    expect(book.template).toEqual({ name: 'square', width: 1080, height: 1080 });
  });
});

describe('loadBook', () => {
  it('round-trips through serialization unchanged', () => {
    const book = createEmptyBook({ title: 'Trip', sourceFolder: '/tmp/trip' });
    book.assets.a1 = { path: 'DSCF1021.jpg', hash: 'abc', width: 6000, height: 4000 };
    const page = book.pages[0];
    page?.elements.push(
      {
        type: 'photo',
        id: 'e1',
        asset: 'a1',
        frame: { x: 0, y: 0, w: 1, h: 0.6 },
        crop: { x: 0, y: 0, scale: 1 },
        rotate: 0,
        filter: 'none',
      },
      {
        type: 'text',
        id: 'e2',
        text: 'Day one',
        style: 'caption',
        frame: { x: 0.04, y: 0.66, w: 0.92, h: 0.05 },
        align: 'left',
      },
    );

    expect(parseBook(serializeBook(book))).toEqual(book);
  });

  it('fills theme defaults when the field is missing', () => {
    const { theme: _theme, ...rest } = createEmptyBook({ title: 'T', sourceFolder: '/tmp/t' });
    expect(loadBook(rest).theme.margin).toBe(0.08);
  });

  it('reads older files: partial themes and no customLayouts', () => {
    const { customLayouts: _c, ...rest } = createEmptyBook({ title: 'T', sourceFolder: '/tmp/t' });
    const loaded = loadBook({ ...rest, theme: { background: '#000000', margin: 0.04, gutter: 0.02 } });
    expect(loaded.customLayouts).toEqual([]);
    expect(loaded.theme).toEqual({ ...THEME_DEFAULTS, background: '#000000', margin: 0.04, gutter: 0.02 });
  });

  it('validates saved custom layouts', () => {
    const book = createEmptyBook({ title: 'T', sourceFolder: '/tmp/t' });
    const custom = {
      id: 'custom-1',
      name: 'Mine',
      photos: 1,
      group: 'custom',
      source: 'custom',
      items: [{ kind: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.5 }],
    };
    expect(loadBook({ ...book, customLayouts: [custom] }).customLayouts).toEqual([custom]);
    expect(() => loadBook({ ...book, customLayouts: [{ ...custom, photos: 2 }] })).toThrow(/photos/);
  });

  it('rejects a malformed file with a readable error', () => {
    const book = createEmptyBook({ title: 'Bad', sourceFolder: '/tmp/bad' });
    const bad = JSON.parse(serializeBook(book));
    bad.pages[0].elements = [
      { type: 'photo', id: 'e1', asset: 'missing', frame: { x: 0, y: 0, w: 1, h: 1 }, crop: { x: 0, y: 0, scale: 1 } },
    ];
    bad.pages[0].elements[0].rotate = 45;
    bad.pages[0].elements[0].filter = 'none';

    expect(() => loadBook(bad)).toThrow(BookLoadError);
    expect(() => loadBook(bad)).toThrow(/pages\[0\]\.elements\[0\]\.rotate/);
    expect(() => loadBook({ ...bad, version: 99 })).toThrow(/Unsupported .* version 99/);
    expect(() => loadBook('nope')).toThrow(/JSON object/);
  });
});

describe('resolveTheme', () => {
  it('fills missing and undefined tokens from THEME_DEFAULTS', () => {
    expect(resolveTheme()).toEqual(THEME_DEFAULTS);
    expect(resolveTheme({ margin: 0.04, gutter: undefined })).toEqual({ ...THEME_DEFAULTS, margin: 0.04 });
    expect(THEME_DEFAULTS).toEqual({
      background: '#ffffff',
      defaultPageBackground: '#ffffff',
      fonts: ['Inter', 'Fraunces'],
      margin: 0.08,
      gutter: 0.025,
      wideGutter: 0.05,
      bleed: 0.0156,
      hardMargin: 0.0625,
      captionOffset: 0.015,
      captionClearance: 0.0375,
      grid: 0.0139,
    });
  });
});
