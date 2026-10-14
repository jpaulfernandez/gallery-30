import { describe, expect, it } from 'vitest';
import { createEmptyBook, createEmptyPage } from '../book.js';
import { BookSchema, type Page, SlideshowOutputSchema } from '../schema.js';
import { clampSecondsPerSlide, DEFAULT_SLIDESHOW_SETTINGS, formatDuration, videoFileName } from './settings.js';
import { orderSlides, pickSlide, slideshowSlides, videoTemplate } from './slides.js';

function book() {
  const b = createEmptyBook({ title: 'Trip', folders: { f: { path: '/photos' } } });
  b.pages = [createEmptyPage(), createEmptyPage(), createEmptyPage()];
  b.assets = {
    a: { path: 'a.jpg', folder: 'f', width: 3000, height: 2000 },
    b: { path: 'b.jpg', folder: 'f', width: 2000, height: 3000 },
    c: { path: 'c.jpg', folder: 'f' },
  };
  return b;
}

const slideshow = (over: Partial<Parameters<typeof SlideshowOutputSchema.parse>[0]> = {}) =>
  SlideshowOutputSchema.parse({ id: 'S1', name: 'Slideshow', createdAt: 0, kind: 'slideshow', ...over });

describe('slideshow output', () => {
  it('fills every setting with its default (no version bump)', () => {
    const s = slideshow();
    expect(s).toMatchObject(DEFAULT_SLIDESHOW_SETTINGS);
    expect(s.audioPath).toBeUndefined();
    const b = book();
    expect(BookSchema.parse({ ...b, outputs: [s] }).outputs[0]).toEqual(s);
  });

  it('rejects settings out of range', () => {
    expect(() => slideshow({ secondsPerSlide: 0.5 })).toThrow();
    expect(() => slideshow({ size: '8k' as never })).toThrow();
    expect(() => slideshow({ transition: 'wipe' as never })).toThrow();
  });

  it('clamps and steps the seconds per slide', () => {
    expect(clampSecondsPerSlide(3.3)).toBe(3.5);
    expect(clampSecondsPerSlide(0)).toBe(1);
    expect(clampSecondsPerSlide(99)).toBe(30);
    expect(clampSecondsPerSlide(Number.NaN)).toBe(4);
  });

  it('names the video file and formats a duration', () => {
    expect(videoFileName('Summer in Lisbon')).toBe('summer-in-lisbon.mp4');
    expect(videoFileName('!!!')).toBe('slideshow.mp4');
    expect(formatDuration(80)).toBe('1:20');
    expect(formatDuration(4.2)).toBe('0:05');
  });
});

describe('slideshow slides', () => {
  const noPicks = { isPick: () => false };

  it("shows the book's pages, a post's frames, or the book for an unknown source", () => {
    const b = book();
    const frame: Page = createEmptyPage();
    b.outputs = [
      {
        id: 'P1',
        name: 'Post',
        createdAt: 0,
        kind: 'social',
        network: 'instagram-story',
        frames: [frame],
        caption: '',
      },
    ];
    expect(slideshowSlides(b, slideshow(), noPicks).pages.map((p) => p.id)).toEqual(b.pages.map((p) => p.id));
    const post = slideshowSlides(b, slideshow({ source: 'P1' }), noPicks);
    expect(post.pages).toEqual([frame]);
    expect(post.template.width / post.template.height).toBeCloseTo(9 / 16);
    expect(slideshowSlides(b, slideshow({ source: 'gone' }), noPicks).pages).toHaveLength(3);
  });

  it('makes one slide per pick, the whole photo centred on black at the video size', () => {
    const b = book();
    const { pages, template } = slideshowSlides(b, slideshow({ source: 'picks' }), { isPick: (id) => id !== 'c' });
    expect(template).toEqual(videoTemplate({ size: '1080p' }));
    expect(pages.map((p) => p.elements[0]?.type === 'photo' && p.elements[0].asset)).toEqual(['a', 'b']);
    const [landscape, portrait] = pages.map((p) => p.elements[0]?.frame);
    // 3:2 on 16:9: full height, centred across.
    expect(landscape?.h).toBe(1);
    expect(landscape?.w).toBeCloseTo(1.5 / (16 / 9));
    expect(landscape?.x).toBeCloseTo((1 - 1.5 / (16 / 9)) / 2);
    // 2:3 on 16:9: full height, narrow.
    expect(portrait?.w).toBeCloseTo(2 / 3 / (16 / 9));
    expect(pages[0]?.background).toBe('#000000');
  });

  it('fills the frame for a photo of unknown size, and prefers the rendered aspect', () => {
    const t = videoTemplate({ size: 'vertical-1080p' });
    expect(pickSlide('c', null, t).elements[0]?.frame).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const b = book();
    const { pages } = slideshowSlides(b, slideshow({ source: 'picks', size: 'square-1080p' }), {
      isPick: (id) => id === 'a',
      aspectOf: () => 1,
    });
    expect(pages[0]?.elements[0]?.frame).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('orders slides as listed, reversed, or in a stable shuffle', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(orderSlides(items, 'document', 'x')).toEqual(items);
    expect(orderSlides(items, 'reverse', 'x')).toEqual([...items].reverse());
    const shuffled = orderSlides(items, 'shuffle', 'S1');
    expect(shuffled).not.toEqual(items);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(items);
    expect(orderSlides(items, 'shuffle', 'S1')).toEqual(shuffled);
    expect(orderSlides(items, 'shuffle', 'S2')).not.toEqual(shuffled);
  });
});
