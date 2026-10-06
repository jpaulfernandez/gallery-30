/**
 * The layout library from `docs/design/reference/layouts-4x5.html` (the `SECTIONS` array), ported as data.
 * Geometry is authored exactly like the reference page: a 100 x 125 unit 4:5 page, 8 unit safe
 * margin, 2.5 unit gutter, 5 unit wide gutter. Items are converted to page fractions (x, w / 100;
 * y, h / 125) for `LAYOUT_LIBRARY`.
 */
import { slugify } from '../ids.js';
import type { LayoutData, LayoutItem } from '../schema.js';

/** Reference page size in authoring units (1 unit = 0.08 in on an 8 x 10 in page). */
export const LIBRARY_PAGE = { width: 100, height: 125 } as const;
/** Safe margin and gutter the library is authored with, as fractions of the page width. */
export const LIBRARY_MARGIN = 0.08;
export const LIBRARY_GUTTER = 0.025;

type Kind = LayoutItem['kind'];
type Box = { x: number; y: number; w: number; h: number };
type RawItem = Box & { kind: Kind };
/** [col, row, colSpan?, rowSpan?, kind?] */
type Cell = [number, number, number?, number?, Kind?];

const W = LIBRARY_PAGE.width;
const H = LIBRARY_PAGE.height;
const M = 8;
const G = 2.5;
/** Wide gutter, 0.4 in. */
const GW = 5;

const LIVE: Box = { x: M, y: M, w: W - 2 * M, h: H - 2 * M };
const BLEED: Box = { x: 0, y: 0, w: W, h: H };
const A = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const R = (x: number, y: number, w: number, h: number, kind: Kind = 'photo'): RawItem => ({ x, y, w, h, kind });

function grid(a: Box, cols: number, rows: number, cells: Cell[], gap = G): RawItem[] {
  const cw = (a.w - gap * (cols - 1)) / cols;
  const rh = (a.h - gap * (rows - 1)) / rows;
  return cells.map(([c, r, cs = 1, rs = 1, kind = 'photo']) => ({
    x: a.x + c * (cw + gap),
    y: a.y + r * (rh + gap),
    w: cs * cw + (cs - 1) * gap,
    h: rs * rh + (rs - 1) * gap,
    kind,
  }));
}

function all(cols: number, rows: number, startRow = 0): Cell[] {
  const o: Cell[] = [];
  for (let r = startRow; r < rows; r++) for (let c = 0; c < cols; c++) o.push([c, r]);
  return o;
}

interface RawLayout {
  name: string;
  best: string;
  bleed?: 1;
  items: RawItem[];
}

interface RawSection {
  n: 1 | 2 | 3 | 4 | 5 | 6;
  band: string;
  tip: string;
  layouts: RawLayout[];
  captioned: RawLayout[];
}

/* The reference page's SECTIONS, unchanged apart from TypeScript syntax. */
const SECTIONS: RawSection[] = [
  {
    n: 1,
    band: 'Impact',
    tip: 'Chapter openers, portraits, and quiet pauses between busy pages. Plan 8 to 12 of these per book for your true hero shots.',
    layouts: [
      { name: 'Full bleed', best: 'The one shot everyone remembers', bleed: 1, items: [R(0, 0, 100, 125)] },
      { name: 'Gallery mat', best: 'Portraits, with a deeper bottom margin', items: [R(14, 12, 72, 90)] },
      { name: 'Tall 2:3 on white', best: 'Camera portraits shot at 2:3', items: [R(18, 14.5, 64, 96)] },
      { name: 'Landscape on white', best: 'A horizontal photo on a vertical page', items: [R(12, 34, 76, 57)] },
      { name: 'Square crop', best: 'Square and Instagram-style photos', items: [R(14, 26.5, 72, 72)] },
      { name: 'Offset high', best: 'Editorial asymmetry for quiet, modern books', items: [R(8, 8, 62, 77.5)] },
      { name: 'Bleed top, white foot', best: 'Big impact with room left below', bleed: 1, items: [R(0, 0, 100, 88)] },
      {
        name: 'Bleed bottom, white sky',
        best: 'Horizons, beaches, anything grounded',
        bleed: 1,
        items: [R(0, 37, 100, 88)],
      },
      { name: 'Bleed side', best: 'Tall subjects; leaves a white column', bleed: 1, items: [R(0, 0, 70, 125)] },
      { name: 'Panorama band', best: 'Wide 2:1 to 3:1 crops across the page', bleed: 1, items: [R(0, 42.5, 100, 40)] },
      { name: 'Quiet vignette', best: 'Details and objects; a breather page', items: [R(29, 41.5, 42, 42)] },
    ],
    captioned: [
      {
        name: 'Caption below',
        best: 'Gallery-style single photo',
        items: [R(14, 12, 72, 90), R(14, 105, 50, 7, 'cap')],
      },
      {
        name: 'Side caption',
        best: 'Caption in the outer margin, bottom-aligned',
        items: [R(30, 20, 62, 77.5), R(8, 82, 19, 15, 'cap')],
      },
      {
        name: 'Title above',
        best: 'A heading that names the moment',
        items: [R(8, 8, 60, 5, 'title'), R(8, 16, 40, 4, 'cap1'), R(8, 25, 84, 92)],
      },
      {
        name: 'Overlay on full bleed',
        best: 'Only over calm areas like sky, wall or shadow',
        bleed: 1,
        items: [R(0, 0, 100, 125), R(0, 96, 100, 29, 'overlay')],
      },
      {
        name: 'Bleed + footer line',
        best: 'Place and date in a quiet footer',
        bleed: 1,
        items: [R(0, 0, 100, 104), R(8, 110, 56, 6, 'cap1'), R(70, 110, 22, 6, 'capR')],
      },
      {
        name: 'Bleed side + text column',
        best: 'A portrait with a short story beside it',
        bleed: 1,
        items: [R(0, 0, 62, 125), R(68, 84, 24, 5, 'title'), R(68, 92, 24, 25, 'para')],
      },
      {
        name: 'Story page',
        best: 'One photo and a short paragraph',
        items: [R(8, 8, 84, 63), R(8, 78, 60, 5, 'title'), R(8, 87, 62, 26, 'para')],
      },
      {
        name: 'Panorama + paragraph',
        best: 'A wide view with a travel note',
        bleed: 1,
        items: [R(0, 20, 100, 40), R(8, 68, 50, 5, 'title'), R(8, 77, 56, 24, 'para')],
      },
      {
        name: 'Chapter opener',
        best: 'Title, date range, one small photo',
        items: [R(8, 36, 72, 11, 'titleLg'), R(8, 51, 38, 8, 'cap'), R(56, 72, 36, 45)],
      },
      {
        name: 'Quote page',
        best: 'A line someone said, with one small photo',
        items: [R(16, 22, 68, 34, 'quote'), R(16, 60, 30, 6, 'cap1'), R(34, 77, 32, 40)],
      },
    ],
  },
  {
    n: 2,
    band: 'Impact',
    tip: 'Pairs that talk to each other: wide and close, before and after, two people in conversation.',
    layouts: [
      { name: 'Stacked pair', best: 'Two landscapes from one moment', items: grid(LIVE, 1, 2, all(1, 2)) },
      {
        name: 'Side-by-side portraits',
        best: 'Two verticals; before and after',
        items: grid(A(8, 37, 84, 51), 2, 1, all(2, 1)),
      },
      {
        name: 'Wide-gap pair',
        best: 'Two portraits that need more air',
        items: grid(A(8, 37.8, 84, 49.4), 2, 1, all(2, 1), GW),
      },
      {
        name: 'Hero + detail',
        best: 'A scene and a close-up from it',
        items: grid(LIVE, 3, 3, [
          [0, 0, 3, 2],
          [2, 2],
        ]),
      },
      {
        name: 'Portrait over landscape',
        best: 'One vertical and one horizontal phone photo',
        items: [R(8, 8, 40.75, 51), R(8, 61.5, 84, 55.5)],
      },
      {
        name: 'Staggered pair',
        best: 'Editorial movement with natural white space',
        items: [R(8, 8, 44, 55), R(48, 65.5, 44, 51.5)],
      },
      { name: 'Diagonal squares', best: 'Two square crops with movement', items: [R(8, 8, 48, 48), R(44, 69, 48, 48)] },
      {
        name: 'Small pair, lots of air',
        best: 'Details, objects, food',
        items: grid(A(18, 47.1, 64, 30.8), 2, 1, all(2, 1)),
      },
      {
        name: 'Hero with postcard',
        best: 'A big scene plus one small keepsake shot',
        bleed: 1,
        items: [R(0, 0, 100, 78), R(62, 93, 30, 24)],
      },
      {
        name: 'Two tall columns',
        best: 'Vertical phone shots and stories',
        bleed: 1,
        items: grid(BLEED, 2, 1, all(2, 1)),
      },
      { name: 'Split bleed', best: 'Then and now; two places', bleed: 1, items: grid(BLEED, 1, 2, all(1, 2)) },
    ],
    captioned: [
      {
        name: 'Pair + shared caption',
        best: 'Two related photos, one sentence',
        items: [...grid(A(8, 33, 84, 51), 2, 1, all(2, 1)), R(8, 88, 50, 7, 'cap')],
      },
      {
        name: 'Captions beside each',
        best: 'Two moments that each need context',
        items: [R(8, 8, 60, 53.25), R(72, 47.25, 20, 14, 'cap'), R(8, 63.75, 60, 53.25), R(72, 103, 20, 14, 'cap')],
      },
      {
        name: 'Hero + detail, caption in the gap',
        best: 'The empty corner holds the story',
        items: [
          ...grid(LIVE, 3, 3, [
            [0, 0, 3, 2],
            [2, 2],
          ]),
          R(8, 85, 48, 5, 'title'),
          R(8, 94, 48, 12, 'cap'),
        ],
      },
      {
        name: 'Staggered with captions',
        best: 'Editorial pairs; captions fill the white',
        items: [R(8, 8, 44, 55), R(56, 51, 36, 12, 'cap'), R(48, 65.5, 44, 51.5), R(8, 105, 36, 12, 'capR')],
      },
      {
        name: 'Split bleed + overlay labels',
        best: 'Then and now, labeled on the photos',
        bleed: 1,
        items: [...grid(BLEED, 1, 2, all(1, 2)), R(0, 32.75, 100, 28.5, 'overlay'), R(0, 96, 100, 29, 'overlay')],
      },
    ],
  },
  {
    n: 3,
    band: 'Impact into story',
    tip: 'One hero with two supporting shots is the classic premium page and the most reusable layout in a book.',
    layouts: [
      {
        name: 'Hero over two',
        best: 'Default story page for almost any event',
        items: grid(LIVE, 2, 3, [
          [0, 0, 2, 2],
          [0, 2],
          [1, 2],
        ]),
      },
      {
        name: 'Two over hero',
        best: 'Details first, the payoff below',
        items: grid(LIVE, 2, 3, [
          [0, 0],
          [1, 0],
          [0, 1, 2, 2],
        ]),
      },
      {
        name: 'Tall left + two',
        best: 'A portrait hero with two landscapes',
        items: grid(LIVE, 2, 2, [
          [0, 0, 1, 2],
          [1, 0],
          [1, 1],
        ]),
      },
      {
        name: 'Tall right + two',
        best: 'Mirror version for right-hand pages',
        items: grid(LIVE, 2, 2, [
          [0, 0],
          [0, 1],
          [1, 0, 1, 2],
        ]),
      },
      {
        name: 'Two-thirds hero',
        best: 'A dominant hero with two side shots',
        items: grid(LIVE, 3, 2, [
          [0, 0, 2, 2],
          [2, 0],
          [2, 1],
        ]),
      },
      { name: 'Three strips', best: 'Wide scenery, a sequence top to bottom', items: grid(LIVE, 1, 3, all(1, 3)) },
      {
        name: 'Triptych band',
        best: 'Three portraits; calm, lots of white',
        items: grid(A(8, 46, 84, 33), 3, 1, all(3, 1)),
      },
      {
        name: 'Cascade',
        best: 'Kids, pets, motion; reads corner to corner',
        items: [R(8, 8, 34, 34), R(33, 44.5, 34, 34), R(58, 81, 34, 34)],
      },
      {
        name: 'Bleed column + two',
        best: 'A tall hero running off the edge',
        bleed: 1,
        items: [R(0, 0, 50, 125), ...grid(A(52.5, 8, 39.5, 109), 1, 2, all(1, 2))],
      },
      {
        name: 'Bleed hero + pair',
        best: 'Travel: the view, then two moments',
        bleed: 1,
        items: [R(0, 0, 100, 70), ...grid(A(8, 74.5, 84, 42.5), 2, 1, all(2, 1))],
      },
    ],
    captioned: [
      {
        name: 'Journal rows',
        best: 'Caption beside each photo, read left to right',
        items: [
          R(8, 8, 46, 34.667),
          R(58, 9, 34, 13, 'cap'),
          R(8, 45.167, 46, 34.667),
          R(58, 46.167, 34, 13, 'cap'),
          R(8, 82.333, 46, 34.667),
          R(58, 83.333, 34, 13, 'cap'),
        ],
      },
      {
        name: 'Hero over two + caption',
        best: 'The default story page with one line of context',
        items: [
          ...grid(A(8, 8, 84, 95), 2, 3, [
            [0, 0, 2, 2],
            [0, 2],
            [1, 2],
          ]),
          R(8, 107, 50, 7, 'cap'),
        ],
      },
      {
        name: 'Triptych with heading',
        best: 'Three portraits under a title',
        items: [R(8, 24, 60, 5, 'title'), R(8, 32, 50, 7, 'cap'), ...grid(A(8, 46, 84, 33), 3, 1, all(3, 1))],
      },
      {
        name: 'Three + text cell',
        best: 'One grid cell holds the story',
        items: grid(LIVE, 2, 2, [
          [0, 0],
          [1, 0, 1, 1, 'cell'],
          [0, 1],
          [1, 1],
        ]),
      },
      {
        name: 'Bleed hero, overlay title',
        best: 'Travel chapter: the view, named on the photo',
        bleed: 1,
        items: [R(0, 0, 100, 70), R(0, 41.5, 100, 28.5, 'overlay'), ...grid(A(8, 74.5, 84, 42.5), 2, 1, all(2, 1))],
      },
    ],
  },
  {
    n: 4,
    band: 'Story',
    tip: 'Four is the busiest count that still feels calm. Keep gutters equal and let one photo lead.',
    layouts: [
      { name: 'Classic quad', best: 'Equal moments; gatherings, recipe steps', items: grid(LIVE, 2, 2, all(2, 2)) },
      {
        name: 'Small quad, lots of air',
        best: 'Details and objects; a calm 4-up',
        items: grid(A(18.75, 23.75, 62.5, 77.5), 2, 2, all(2, 2)),
      },
      {
        name: 'Hero + strip of three',
        best: 'The group shot above, candids below',
        items: grid(LIVE, 3, 4, [
          [0, 0, 3, 3],
          [0, 3],
          [1, 3],
          [2, 3],
        ]),
      },
      {
        name: 'Strip of three + hero',
        best: 'Details first, the big moment below',
        items: grid(LIVE, 3, 4, [
          [0, 0],
          [1, 0],
          [2, 0],
          [0, 1, 3, 3],
        ]),
      },
      {
        name: 'Tall hero + column',
        best: 'A portrait hero with three details',
        items: grid(LIVE, 3, 3, [
          [0, 0, 2, 3],
          [2, 0],
          [2, 1],
          [2, 2],
        ]),
      },
      {
        name: 'Column + tall hero',
        best: 'Mirror version for right-hand pages',
        items: grid(LIVE, 3, 3, [
          [0, 0],
          [0, 1],
          [0, 2],
          [1, 0, 2, 3],
        ]),
      },
      {
        name: 'Pinwheel',
        best: 'Four photos turning around a white center',
        items: grid(LIVE, 3, 3, [
          [0, 0, 2, 1],
          [2, 0, 1, 2],
          [1, 2, 2, 1],
          [0, 1, 1, 2],
        ]),
      },
      {
        name: 'Offset pairs',
        best: 'Wide-narrow over narrow-wide, brick rhythm',
        items: grid(LIVE, 4, 2, [
          [0, 0, 3, 1],
          [3, 0],
          [0, 1],
          [1, 1, 3, 1],
        ]),
      },
      { name: 'Four strips', best: 'Cinematic crops of landscapes', items: grid(LIVE, 1, 4, all(1, 4)) },
      {
        name: 'Bleed hero + three',
        best: 'The view, then three moments from the day',
        bleed: 1,
        items: [R(0, 0, 100, 72), ...grid(A(8, 74.5, 84, 42.5), 3, 1, all(3, 1))],
      },
      {
        name: 'Edge-to-edge quad',
        best: 'Bold, poster-like; strong single subjects',
        bleed: 1,
        items: grid(BLEED, 2, 2, all(2, 2)),
      },
    ],
    captioned: [
      {
        name: 'Caption under each',
        best: 'Four photos that each need context',
        items: [
          R(8, 8, 40.75, 40),
          R(8, 50, 30, 7, 'cap'),
          R(51.25, 8, 40.75, 40),
          R(51.25, 50, 30, 7, 'cap'),
          R(8, 62, 40.75, 40),
          R(8, 104, 30, 7, 'cap'),
          R(51.25, 62, 40.75, 40),
          R(51.25, 104, 30, 7, 'cap'),
        ],
      },
      {
        name: 'Quad + caption strip',
        best: 'One line for the whole page',
        items: [...grid(A(8, 8, 84, 95), 2, 2, all(2, 2)), R(8, 107, 60, 7, 'cap')],
      },
      {
        name: 'Four + text cell',
        best: 'One grid cell holds the story',
        items: grid(LIVE, 2, 3, [
          [0, 0],
          [1, 0, 1, 1, 'cell'],
          [0, 1, 2, 1],
          [0, 2],
          [1, 2],
        ]),
      },
      {
        name: 'Titled hero + strip',
        best: 'Event pages with a heading',
        items: [
          R(8, 8, 60, 5, 'title'),
          R(8, 15.5, 46, 4, 'cap1'),
          ...grid(A(8, 25, 84, 92), 3, 4, [
            [0, 0, 3, 3],
            [0, 3],
            [1, 3],
            [2, 3],
          ]),
        ],
      },
      {
        name: 'Quad + numbered key',
        best: 'A caption for every photo without clutter',
        items: [...grid(A(8, 8, 84, 88), 2, 2, all(2, 2)), R(8, 101, 84, 16, 'key')],
      },
    ],
  },
  {
    n: 5,
    band: 'Story',
    tip: 'Five needs a clear hierarchy, otherwise it reads as a pile. A hero plus four, or a 2-1-2 rhythm.',
    layouts: [
      {
        name: 'Hero over four',
        best: 'Event pages: the moment plus reactions',
        items: grid(LIVE, 2, 4, [
          [0, 0, 2, 2],
          [0, 2],
          [1, 2],
          [0, 3],
          [1, 3],
        ]),
      },
      {
        name: '2-1-2 sandwich',
        best: 'A wide centerpiece framed by pairs',
        items: grid(LIVE, 2, 3, [
          [0, 0],
          [1, 0],
          [0, 1, 2, 1],
          [0, 2],
          [1, 2],
        ]),
      },
      {
        name: 'Tall + four',
        best: 'A full-length portrait with four details',
        items: grid(LIVE, 2, 4, [
          [0, 0, 1, 4],
          [1, 0],
          [1, 1],
          [1, 2],
          [1, 3],
        ]),
      },
      {
        name: 'Two over three',
        best: 'Two leads above a row of supporting shots',
        items: grid(LIVE, 6, 2, [
          [0, 0, 3, 1],
          [3, 0, 3, 1],
          [0, 1, 2, 1],
          [2, 1, 2, 1],
          [4, 1, 2, 1],
        ]),
      },
      {
        name: 'Z-flow',
        best: 'Reads like a sentence: lead, details, second lead',
        items: grid(LIVE, 3, 4, [
          [0, 0, 2, 2],
          [2, 0],
          [2, 1],
          [0, 2, 1, 2],
          [1, 2, 2, 2],
        ]),
      },
    ],
    captioned: [
      {
        name: 'Hero over four + caption',
        best: 'Event page with one line of context',
        items: [
          ...grid(A(8, 8, 84, 95), 2, 4, [
            [0, 0, 2, 2],
            [0, 2],
            [1, 2],
            [0, 3],
            [1, 3],
          ]),
          R(8, 107, 50, 7, 'cap'),
        ],
      },
      {
        name: 'Five + text cell',
        best: 'An L-wrap with the story in the corner',
        items: grid(LIVE, 3, 3, [
          [0, 0, 2, 2],
          [2, 0, 1, 1, 'cell'],
          [2, 1],
          [0, 2],
          [1, 2],
          [2, 2],
        ]),
      },
      {
        name: 'Five + numbered key',
        best: 'Names and places for every photo',
        items: [
          ...grid(A(8, 8, 84, 88), 2, 3, [
            [0, 0, 2, 1],
            [0, 1],
            [1, 1],
            [0, 2],
            [1, 2],
          ]),
          R(8, 101, 84, 16, 'key'),
        ],
      },
    ],
  },
  {
    n: 6,
    band: 'Story',
    tip: 'The maximum. Use for cohesive sets like a day, a meal or a month, and follow it with a 1- or 2-photo page.',
    layouts: [
      { name: 'Six grid', best: 'Months, a day in the life', items: grid(LIVE, 2, 3, all(2, 3)) },
      {
        name: 'L-wrap',
        best: 'A hero wrapped by five candids',
        items: grid(LIVE, 3, 3, [
          [0, 0, 2, 2],
          [2, 0],
          [2, 1],
          [0, 2],
          [1, 2],
          [2, 2],
        ]),
      },
      {
        name: 'Brick',
        best: 'Mixed wide and narrow crops with rhythm',
        items: grid(LIVE, 3, 3, [
          [0, 0, 2, 1],
          [2, 0],
          [0, 1],
          [1, 1, 2, 1],
          [0, 2, 2, 1],
          [2, 2],
        ]),
      },
      {
        name: 'Hero, two, three',
        best: 'Pyramid: one lead, then smaller beats',
        items: grid(LIVE, 6, 4, [
          [0, 0, 6, 2],
          [0, 2, 3, 1],
          [3, 2, 3, 1],
          [0, 3, 2, 1],
          [2, 3, 2, 1],
          [4, 3, 2, 1],
        ]),
      },
      {
        name: 'Masonry',
        best: 'Phone photos in mixed orientations',
        items: grid(LIVE, 2, 6, [
          [0, 0, 1, 2],
          [0, 2, 1, 2],
          [0, 4, 1, 2],
          [1, 0, 1, 1],
          [1, 1, 1, 3],
          [1, 4, 1, 2],
        ]),
      },
    ],
    captioned: [
      {
        name: 'Six grid + numbered key',
        best: 'A recap with a caption for each photo',
        items: [...grid(A(8, 8, 84, 88), 2, 3, all(2, 3)), R(8, 101, 84, 16, 'key')],
      },
      {
        name: 'L-wrap + caption',
        best: 'A busy page with one line of context',
        items: [
          ...grid(A(8, 8, 84, 95), 3, 3, [
            [0, 0, 2, 2],
            [2, 0],
            [2, 1],
            [0, 2],
            [1, 2],
            [2, 2],
          ]),
          R(8, 107, 50, 7, 'cap'),
        ],
      },
      {
        name: 'Six with header',
        best: 'A titled recap: month, trip day, menu',
        items: [R(8, 8, 60, 5, 'title'), R(8, 15.5, 46, 4, 'cap1'), ...grid(A(8, 25, 84, 92), 2, 3, all(2, 3))],
      },
    ],
  },
];

/** Drop float noise so ids and saved JSON stay clean (1e-7 of the page). */
const clean = (v: number): number => Math.round(v * 1e7) / 1e7;

function toItem({ kind, x, y, w, h }: RawItem): LayoutItem {
  return { kind, x: clean(x / W), y: clean(y / H), w: clean(w / W), h: clean(h / H) };
}

function toData(raw: RawLayout, n: RawSection['n'], captioned: boolean): LayoutData {
  const data: LayoutData = {
    id: `${captioned ? 'c' : ''}${n}-${slugify(raw.name)}`,
    name: raw.name,
    photos: n,
    group: captioned ? 'captioned' : 'photos',
    best: raw.best,
    source: 'library',
    items: raw.items.map(toItem),
  };
  if (raw.bleed) data.bleed = true;
  return data;
}

/** Every library layout as serializable data, in picker order (count, then photos-only, then captioned). */
export const LAYOUT_LIBRARY: readonly LayoutData[] = SECTIONS.flatMap((sec) => [
  ...sec.layouts.map((l) => toData(l, sec.n, false)),
  ...sec.captioned.map((l) => toData(l, sec.n, true)),
]);

/** Per photo count: the reference page's band label and usage tip, for picker headings. */
export const LAYOUT_SECTIONS: ReadonlyArray<{ photos: RawSection['n']; band: string; tip: string }> = SECTIONS.map(
  ({ n, band, tip }) => ({ photos: n, band, tip }),
);

/**
 * Index (into `items`) of the hero photo: the largest photo when it is at least 1.6 times the area
 * of the next largest, else -1 (also for fewer than two photos). Works on any item list with
 * `kind`, `w` and `h`, e.g. `LayoutItem[]` or `WireframeFrame[]`.
 */
export function heroIndex(items: ReadonlyArray<{ kind: string; w: number; h: number }>): number {
  const ph = items
    .map((it, i) => ({ i, a: it.w * it.h, k: it.kind }))
    .filter((o) => o.k === 'photo')
    .sort((a, b) => b.a - a.a);
  const [first, second] = ph;
  if (!first || !second) return -1;
  return first.a >= second.a * 1.6 ? first.i : -1;
}
