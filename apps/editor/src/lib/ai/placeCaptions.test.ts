import { type Book, createEmptyBook, createEmptyPage, emptyLibrary, LAYOUT_CUSTOM } from '@photobook/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { undo, useBookStore } from '../../store/book';
import { captionFrame } from '../grid';
import { captionSlots, joinCaptions, pageHasCaption, pagePhotoIds, placeCaptions } from './placeCaptions';

type El = Book['pages'][number]['elements'][number];
const TEMPLATE = { width: 1080, height: 1350 };
const photo = (id: string, asset: string, frame: { x: number; y: number; w: number; h: number }): El =>
  ({ type: 'photo', id, asset, frame, crop: { x: 0, y: 0, scale: 1 }, rotate: 0, filter: 'none' }) as El;
const text = (id: string, value: string, frame: { x: number; y: number; w: number; h: number }, style = 'caption') =>
  ({ type: 'text', id, text: value, style, frame, align: 'left' }) as El;

/** Two photos side by side, each with its caption under it ("Staggered with captions"). */
function twoCaptioned() {
  const page = createEmptyPage();
  page.elements = [
    photo('e1', 'a1', { x: 0.05, y: 0.1, w: 0.42, h: 0.5 }),
    photo('e2', 'a2', { x: 0.53, y: 0.1, w: 0.42, h: 0.5 }),
    text('t1', '', { x: 0.05, y: 0.62, w: 0.42, h: 0.05 }),
    text('t2', 'An old one', { x: 0.53, y: 0.62, w: 0.42, h: 0.05 }),
    text('title', 'Lisbon', { x: 0.05, y: 0.02, w: 0.9, h: 0.05 }, 'title'),
  ];
  return page;
}

describe('placeCaptions', () => {
  it('puts each photo caption in the caption slot under its photo, whatever the order given', () => {
    const page = twoCaptioned();
    const placed = placeCaptions(
      page,
      [
        { assetId: 'a2', text: 'The right one.' },
        { assetId: 'a1', text: ' The left one. ' },
      ],
      TEMPLATE,
    );
    expect(placed).toEqual([
      { elementId: 't1', text: 'The left one.', assetIds: ['a1'], replaces: '' },
      { elementId: 't2', text: 'The right one.', assetIds: ['a2'], replaces: 'An old one' },
    ]);
  });

  it('puts a page caption in the first empty caption slot, never in a title', () => {
    const page = twoCaptioned();
    expect(placeCaptions(page, [{ assetId: null, text: 'Both of us.' }], TEMPLATE)).toEqual([
      { elementId: 't1', text: 'Both of us.', assetIds: [null], replaces: '' },
    ]);
    expect(captionSlots(page).map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('joins captions sharing a box as sentences', () => {
    expect(joinCaptions(['We wait', 'The hill.'])).toBe('We wait. The hill.');
    expect(joinCaptions(['Is it far?', '“Not far.”', 'Up the hill'])).toBe('Is it far? “Not far.” Up the hill');
    expect(joinCaptions(['Only one'])).toBe('Only one');
  });

  it('joins the captions of every photo in a shared caption strip', () => {
    const page = createEmptyPage();
    page.elements = [
      photo('e1', 'a1', { x: 0.05, y: 0.1, w: 0.42, h: 0.5 }),
      photo('e2', 'a2', { x: 0.53, y: 0.1, w: 0.42, h: 0.5 }),
      text('t1', '', { x: 0.05, y: 0.62, w: 0.9, h: 0.05 }),
    ];
    const placed = placeCaptions(
      page,
      [
        { assetId: 'a1', text: 'Left.' },
        { assetId: 'a2', text: 'Right.' },
      ],
      TEMPLATE,
    );
    expect(placed).toEqual([{ elementId: 't1', text: 'Left. Right.', assetIds: ['a1', 'a2'], replaces: '' }]);
  });

  it('makes one new caption element when the page has no caption slot, and skips blank captions', () => {
    const page = createEmptyPage();
    page.elements = [
      photo('e1', 'a1', { x: 0, y: 0, w: 1, h: 0.8 }),
      text('q', 'A quote', { x: 0, y: 0.85, w: 1, h: 0.1 }, 'quote'),
    ];
    expect(
      placeCaptions(
        page,
        [
          { assetId: null, text: 'The page.' },
          { assetId: 'a1', text: '', alt: 'A tram.' },
        ],
        TEMPLATE,
      ),
    ).toEqual([{ elementId: null, text: 'The page.', assetIds: [null], replaces: '' }]);
    expect(placeCaptions(page, [{ assetId: 'a1', text: '  ' }], TEMPLATE)).toEqual([]);
  });

  it('lists the page photos background first and tells a captioned page', () => {
    const page = twoCaptioned();
    page.background = { asset: 'bg' };
    expect(pagePhotoIds(page)).toEqual(['bg', 'a1', 'a2']);
    expect(pageHasCaption(page)).toBe(true);
    expect(pageHasCaption({ elements: [text('t', ' ', { x: 0, y: 0, w: 1, h: 0.1 })] })).toBe(false);
  });
});

describe('applyCaptions and setAssetAlt', () => {
  let pageId = '';
  let plainId = '';

  beforeEach(() => {
    const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: '/photos' } } });
    book.assets = {
      a1: { path: 'IMG_1.jpg', hash: '1'.repeat(64), folder: 'F1' },
      a2: { path: 'IMG_2.jpg', hash: '2'.repeat(64), folder: 'F1', alt: 'The author’s own alt.' },
    } as Book['assets'];
    const page = twoCaptioned();
    page.layout = 'c2-staggered-with-captions';
    const plain = createEmptyPage();
    plain.layout = 'single-full';
    plain.elements = [photo('e3', 'a1', { x: 0, y: 0, w: 1, h: 1 })];
    book.pages = [page, plain];
    pageId = page.id;
    plainId = plain.id;
    useBookStore.setState({ book, projectId: 'P1', folder: '/photos', libraries: { '/photos': emptyLibrary() } });
    useBookStore.temporal.getState().clear();
  });

  const book = () => useBookStore.getState().book as Book;
  const textOf = (page: number, id: string) => {
    const el = book().pages[page]?.elements.find((e) => e.id === id);
    return el?.type === 'text' ? el.text : undefined;
  };

  it('places into the caption slots in one undo step and fills only a missing alt', () => {
    const changed = useBookStore.getState().applyCaptions(pageId, [
      { assetId: 'a1', text: 'We wait for the 28.', alt: 'Two people at a tram stop.' },
      { assetId: 'a2', text: 'The hill at dusk.', alt: 'A street on a hill.' },
    ]);
    expect(changed).toBe(true);
    expect(textOf(0, 't1')).toBe('We wait for the 28.');
    expect(textOf(0, 't2')).toBe('The hill at dusk.');
    expect(book().pages[0]?.layout).toBe('c2-staggered-with-captions');
    expect(book().assets.a1?.alt).toBe('Two people at a tram stop.');
    expect(book().assets.a2?.alt).toBe('The author’s own alt.');
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    undo();
    expect(textOf(0, 't1')).toBe('');
    expect(textOf(0, 't2')).toBe('An old one');
  });

  it('adds a caption element at the bottom margin on a page without slots, and the page turns custom', () => {
    useBookStore.getState().applyCaptions(plainId, [{ assetId: null, text: 'Alfama in the evening.' }]);
    const page = book().pages[1];
    const added = page?.elements.find((e) => e.type === 'text');
    expect(added?.type === 'text' && added.text).toBe('Alfama in the evening.');
    expect(added?.type === 'text' && added.style).toBe('caption');
    expect(added?.frame).toEqual(captionFrame(book().template, book().theme));
    expect(page?.layout).toBe(LAYOUT_CUSTOM);
    // A second run lands in the element the first one made.
    useBookStore.getState().applyCaptions(plainId, [{ assetId: null, text: 'Again.' }]);
    expect(book().pages[1]?.elements.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(textOf(1, added?.id ?? '')).toBe('Again.');
  });

  it('does nothing (and records no step) when nothing changes', () => {
    expect(useBookStore.getState().applyCaptions(pageId, [{ assetId: 'a2', text: 'An old one' }])).toBe(false);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('sets and removes alt text without an undo step', () => {
    useBookStore.getState().setAssetAlt('a1', '  A tram   at dusk. ');
    expect(book().assets.a1?.alt).toBe('A tram at dusk.');
    useBookStore.getState().setAssetAlt('a1', ' ');
    expect('alt' in (book().assets.a1 ?? {})).toBe(false);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('caps alt text at 125 characters at a word, in setAssetAlt and applyCaptions alike', () => {
    const long = `Two friends wait at a tram stop ${'in the warm evening light '.repeat(8)}`;
    useBookStore.getState().setAssetAlt('a1', long);
    const saved = book().assets.a1?.alt ?? '';
    expect(saved.length).toBeLessThanOrEqual(125);
    expect(long.startsWith(saved)).toBe(true);
    useBookStore.getState().setAssetAlt('a1', '');
    useBookStore.getState().applyCaptions(pageId, [{ assetId: 'a1', text: 'A caption.', alt: `${long}\n` }]);
    expect(book().assets.a1?.alt).toBe(saved);
  });
});
