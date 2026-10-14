/**
 * Renderer fixture: a small book rendered identically by the editor's `/fixture` route and the
 * viewer's dev page (the step 1.3 check). Ids are fixed so renders are stable across reloads.
 */
import { applyLayout } from '../layouts/apply.js';
import type { ResolvedImage, ResolveImage } from '../renderer/types.js';
import {
  type Asset,
  type Book,
  type BookTemplate,
  CURRENT_VERSION,
  type Page,
  type PhotoElement,
  type TextElement,
  type Theme,
} from '../schema.js';
import { templateFor } from '../templates.js';
import { resolveTheme } from '../theme.js';

/** Fixture photos: a mix of landscape and portrait so cover-fit is exercised both ways. */
const ASSETS: Record<string, { width: number; height: number }> = {
  f1: { width: 1200, height: 800 },
  f2: { width: 800, height: 1200 },
  f3: { width: 1200, height: 800 },
  f4: { width: 800, height: 1200 },
  f5: { width: 1200, height: 800 },
  f6: { width: 1200, height: 900 },
  f7: { width: 800, height: 1000 },
  f8: { width: 1200, height: 800 },
  f9: { width: 1200, height: 1200 },
};

/** The renderer fixtures keep the original tighter spacing so their renders stay stable. */
const FIXTURE_THEME: Theme = resolveTheme({ margin: 0.04, gutter: 0.02 });

/** The fixture books' one folder. */
export const FIXTURE_FOLDER_ID = 'fixture-folder';

function assets(): Record<string, Asset> {
  return Object.fromEntries(
    Object.entries(ASSETS).map(([id, size]) => [id, { path: `fixture/${id}.jpg`, folder: FIXTURE_FOLDER_ID, ...size }]),
  );
}

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

function text(id: string, value: string, extra: Partial<TextElement> = {}): TextElement {
  return {
    type: 'text',
    id,
    text: value,
    style: 'body',
    frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 },
    align: 'left',
    ...extra,
  };
}

/** Hero plus two with a pill title over the hero and a white caption along its bottom edge. */
function heroPage(id: string, template: BookTemplate): Page {
  const laid = applyLayout(
    {
      id,
      layout: 'blank',
      guides: [],
      background: '#f6f3ee',
      elements: [
        photo(`${id}-e1`, 'f1', { crop: { x: 0.04, y: 0, scale: 1.1 } }),
        photo(`${id}-e2`, 'f2'),
        photo(`${id}-e3`, 'f3', { filter: 'bw' }),
      ],
    },
    'three-hero-two',
    FIXTURE_THEME,
    template,
  );
  const hero = laid.elements[0]?.frame ?? { x: 0, y: 0, w: 1, h: 1 };
  const titleH = 0.07;
  return {
    ...laid,
    elements: [
      ...laid.elements,
      text(`${id}-t1`, 'Kyoto, April', {
        style: 'title',
        pill: true,
        size: 0.04,
        frame: { x: hero.x + 0.03, y: hero.y + 0.025, w: hero.w * 0.8, h: titleH },
      }),
      text(`${id}-t2`, 'Fushimi Inari before the crowds', {
        style: 'caption',
        color: '#ffffff',
        align: 'right',
        frame: { x: hero.x + 0.03, y: hero.y + hero.h - 0.06, w: hero.w - 0.06, h: 0.045 },
      }),
    ],
  };
}

function laidOut(page: Page, layoutId: string, template: BookTemplate): Page {
  return applyLayout(page, layoutId, FIXTURE_THEME, template);
}

/** Free text added on top of a laid-out page (kept by layouts as extra text when they have no item for it). */
function withText(page: Page, ...texts: TextElement[]): Page {
  return { ...page, elements: [...page.elements, ...texts] };
}

function book(id: string, title: string, template: BookTemplate, pages: Page[]): Book {
  return {
    version: CURRENT_VERSION,
    id,
    title,
    folders: { [FIXTURE_FOLDER_ID]: { path: '/fixture' } },
    template,
    theme: FIXTURE_THEME,
    assets: assets(),
    pages,
    publish: {
      slug: `fixture-${id}`,
      visibility: 'unlisted',
      lastPublishedAt: null,
      r2Prefix: 'fixt0',
      password: null,
    },
    customLayouts: [],
    outputProfile: 'srgb',
    outputs: [],
    captions: {},
  };
}

const portrait = templateFor('phone-portrait');
const square = templateFor('square');

/** Phone portrait 4:5: hero plus two with title and caption, a full-bleed page, a captioned page. */
export const fixtureBook: Book = book('fixture-portrait', 'Renderer fixture', portrait, [
  heroPage('p1', portrait),
  laidOut(
    {
      id: 'p2',
      layout: 'blank',
      guides: [],
      background: '#ffffff',
      elements: [photo('p2-e1', 'f4', { crop: { x: 0.05, y: -0.03, scale: 1.25 } })],
    },
    'single-full',
    portrait,
  ),
  laidOut(
    {
      id: 'p3',
      layout: 'blank',
      guides: [],
      background: '#ffffff',
      elements: [
        photo('p3-e1', 'f5', { rotate: 90, filter: 'fade' }),
        text('p3-t1', 'Rotated 90 degrees, fade filter', { style: 'caption', align: 'center' }),
      ],
    },
    'single-caption',
    portrait,
  ),
]);

/** Square 1:1: the same hero page re-flowed, a grid with an empty slot, a photo background. */
export const fixtureSquareBook: Book = book('fixture-square', 'Renderer fixture (square)', square, [
  heroPage('s1', square),
  withText(
    laidOut(
      {
        id: 's2',
        layout: 'blank',
        guides: [],
        background: '#111111',
        elements: [
          photo('s2-e1', 'f6', { filter: 'bw' }),
          photo('s2-e2', 'f7'),
          photo('s2-e3', 'f8', { rotate: 270, crop: { x: 0, y: 0.05, scale: 1.2 } }),
          photo('s2-e4', null),
        ],
      },
      'four-grid',
      square,
    ),
    text('s2-t1', '2026.04.12', {
      style: 'date',
      pill: true,
      frame: { x: 0.06, y: 0.06, w: 0.4, h: 0.04 },
    }),
  ),
  laidOut(
    {
      id: 's3',
      layout: 'blank',
      guides: [],
      background: { asset: 'f9' },
      elements: [photo('s3-e1', 'f8')],
    },
    'single-framed-landscape',
    square,
  ),
]);

/** Every fixture page with its book, for hosts that render them all. */
export const FIXTURE_PAGES: Array<{ book: Book; page: Page; label: string }> = [
  ...fixtureBook.pages.map((page) => ({ book: fixtureBook, page, label: `4:5 / ${page.layout}` })),
  ...fixtureSquareBook.pages.map((page) => ({ book: fixtureSquareBook, page, label: `1:1 / ${page.layout}` })),
];

/** picsum.photos stand-in for a real resolver: seeded per asset, sized to the request. */
export const fixtureResolve: ResolveImage = (assetId, targetWidthPx): ResolvedImage | null => {
  const size = ASSETS[assetId];
  if (!size) return null;
  const url = (w: number) => `https://picsum.photos/seed/${assetId}/${w}/${Math.round((w * size.height) / size.width)}`;
  // Snap to 100 px steps so neighbouring slot sizes share a cache entry.
  const w1 = Math.max(100, Math.ceil(targetWidthPx / 100) * 100);
  return {
    src: url(w1),
    srcSet: `${url(w1)} 1x, ${url(w1 * 2)} 2x`,
    width: w1,
    height: Math.round((w1 * size.height) / size.width),
  };
};
