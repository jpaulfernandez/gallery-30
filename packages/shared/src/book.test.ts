import { describe, expect, it } from 'vitest';
import {
  BookLoadError,
  BookSchema,
  createEmptyBook,
  DEFAULT_PRINT_SETTINGS,
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
    const book = createEmptyBook({ title: 'Kyoto, April 2026', folders: { f1: { path: '/Users/me/Pictures/kyoto' } } });

    expect(BookSchema.safeParse(book).success).toBe(true);
    expect(book.version).toBe(8);
    expect(book.folders).toEqual({ f1: { path: '/Users/me/Pictures/kyoto' } });
    expect(book.outputs).toEqual([]);
    expect(book.captions).toEqual({});
    expect(book.pages[0]?.guides).toEqual([]);
    expect(book.outputProfile).toBe('srgb');
    expect(book.id).toMatch(ULID);
    expect(book.template).toEqual({ name: 'phone-portrait', width: 1080, height: 1350 });
    expect(book.theme).toEqual(THEME_DEFAULTS);
    expect(book.theme).toMatchObject({ margin: 0.08, gutter: 0.025, wideGutter: 0.05, grid: 0.0139 });
    expect(book.customLayouts).toEqual([]);
    expect(book.publish.slug).toMatch(/^kyoto-april-2026-[a-z0-9]{4}$/);
    expect(book.publish).toMatchObject({ visibility: 'unlisted', lastPublishedAt: null, password: null });
    expect(book.pages).toHaveLength(1);

    const [page] = book.pages;
    expect(page?.layout).toBe(LAYOUT_BLANK);
    expect(page?.elements).toEqual([]);
    expect(page?.id).toMatch(ULID);
    expect(page?.background).toBe(book.theme.defaultPageBackground);
  });

  it('accepts another template by name', () => {
    const book = createEmptyBook({ title: 'Sq', folders: { f1: { path: '/tmp/sq' } }, template: 'square' });
    expect(book.template).toEqual({ name: 'square', width: 1080, height: 1080 });
  });
});

describe('loadBook', () => {
  it('round-trips through serialization unchanged', () => {
    const book = createEmptyBook({ title: 'Trip', folders: { f1: { path: '/tmp/trip' } } });
    book.assets.a1 = { path: 'DSCF1021.jpg', folder: 'f1', hash: 'abc', width: 6000, height: 4000 };
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
    const { theme: _theme, ...rest } = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
    expect(loadBook(rest).theme.margin).toBe(0.08);
  });

  it('reads older files: partial themes and no customLayouts', () => {
    const { customLayouts: _c, ...rest } = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
    const loaded = loadBook({ ...rest, theme: { background: '#000000', margin: 0.04, gutter: 0.02 } });
    expect(loaded.customLayouts).toEqual([]);
    expect(loaded.theme).toEqual({ ...THEME_DEFAULTS, background: '#000000', margin: 0.04, gutter: 0.02 });
  });

  it('validates saved custom layouts', () => {
    const book = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
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
    const book = createEmptyBook({ title: 'Bad', folders: { f1: { path: '/tmp/bad' } } });
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

describe('BookSchema v8 references', () => {
  const photo = (id: string, asset: string) => ({
    type: 'photo' as const,
    id,
    asset,
    frame: { x: 0, y: 0, w: 1, h: 1 },
    crop: { x: 0, y: 0, scale: 1 },
    rotate: 0 as const,
    filter: 'none' as const,
  });

  it('rejects an asset whose folder is not in `folders`', () => {
    const book = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
    book.assets.a1 = { path: 'a.jpg', folder: 'f2' };
    expect(() => loadBook(book)).toThrow(/unknown folder "f2"[\s\S]*assets\.a1\.folder/);
    book.assets.a1 = { path: 'a.jpg', folder: 'f1' };
    expect(loadBook(book).assets.a1?.folder).toBe('f1');
  });

  it('checks the asset ids of output frames like pages', () => {
    const book = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
    book.assets.a1 = { path: 'a.jpg', folder: 'f1' };
    const frame = { id: 'fr1', layout: 'custom', background: '#fff', elements: [photo('e1', 'a1')], guides: [] };
    const output = { id: 'o1', name: 'Carousel', createdAt: 1, kind: 'social' as const, frames: [frame] };
    // Plan 14 defaults the network and the caption.
    expect(loadBook({ ...book, outputs: [output] }).outputs).toEqual([
      { ...output, network: 'instagram-carousel', caption: '' },
    ]);
    const dangling = { ...output, frames: [{ ...frame, elements: [photo('e1', 'nope')] }] };
    expect(() => loadBook({ ...book, outputs: [dangling] })).toThrow(/outputs\[0\]\.frames\[0\]\.elements\[0\]\.asset/);
    const bg = { ...output, frames: [{ ...frame, background: { asset: 'nope' } }] };
    expect(() => loadBook({ ...book, outputs: [bg] })).toThrow(/unknown asset "nope"/);
  });

  it('parses the minimal print output, page guides and the caption brief with their defaults', () => {
    const book = createEmptyBook({ title: 'T', folders: { f1: { path: '/tmp/t' } } });
    const pages = book.pages.map((p) => ({ ...p, guides: [{ axis: 'x' as const, value: 0.5 }] }));
    const loaded = loadBook({
      ...book,
      pages,
      outputs: [{ id: 'o1', name: 'Print', createdAt: 2, kind: 'print' }],
      captions: { brief: { about: 'A trip' } },
    });
    expect(loaded.pages[0]?.guides).toEqual([{ axis: 'x', value: 0.5 }]);
    // Plan 15 gave prints their settings, each with a default.
    expect(loaded.outputs).toEqual([
      { id: 'o1', name: 'Print', createdAt: 2, kind: 'print', ...DEFAULT_PRINT_SETTINGS },
    ]);
    expect(loaded.captions.brief).toMatchObject({ about: 'A trip', people: [], voice: 'editorial', examples: [] });
    expect(() => loadBook({ ...book, outputs: [{ id: 'o1', name: 'X', createdAt: 2, kind: 'displays' }] })).toThrow(
      BookLoadError,
    );
    // A malformed guide is dropped, never a reason to reject the file (workflow plan 31).
    expect(loadBook({ ...book, pages: [{ ...pages[0], guides: [{ axis: 'z', value: 1 }] }] }).pages[0]?.guides).toEqual(
      [],
    );
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

describe('page guides on read (workflow plan 31)', () => {
  it('clamps values onto the page and drops malformed guides instead of rejecting the file', () => {
    const book = createEmptyBook({ title: 'Guides', folders: { f1: { path: '/tmp/g' } } });
    const raw = JSON.parse(serializeBook(book));
    raw.pages = [
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZZ1',
        layout: LAYOUT_BLANK,
        background: '#ffffff',
        elements: [],
        guides: [
          { axis: 'x', value: 0.25 },
          { axis: 'y', value: 1.5 },
          { axis: 'x', value: -0.2 },
          { axis: 'z', value: 0.5 },
          { axis: 'y', value: 'half' },
          null,
        ],
      },
      { id: '01HZZZZZZZZZZZZZZZZZZZZZZ2', layout: LAYOUT_BLANK, background: '#ffffff', elements: [], guides: 'oops' },
    ];
    const parsed = parseBook(JSON.stringify(raw));
    expect(parsed.pages[0]?.guides).toEqual([
      { axis: 'x', value: 0.25 },
      { axis: 'y', value: 1 },
      { axis: 'x', value: 0 },
    ]);
    expect(parsed.pages[1]?.guides).toEqual([]);
  });
});
