import { describe, expect, it } from 'vitest';
import { createEmptyBook, loadBook } from '../book.js';
import { BOOK_OUTPUT_ID, templateOf } from '../outputs.js';
import { BookSchema } from '../schema.js';
import {
  captionLength,
  DEFAULT_SOCIAL_NETWORK,
  frameCapMessage,
  frameCapReached,
  frameFileName,
  frameTemplate,
  postSlug,
  SOCIAL_NETWORKS,
  SOCIAL_TEMPLATES,
  showsSafeArea,
  socialTemplate,
  uniquePostSlug,
} from './templates.js';

describe('social templates', () => {
  it('has one template per network, keyed by its own network', () => {
    expect(Object.keys(SOCIAL_TEMPLATES).sort()).toEqual([...SOCIAL_NETWORKS].sort());
    for (const network of SOCIAL_NETWORKS) expect(SOCIAL_TEMPLATES[network].network).toBe(network);
  });

  it.each(SOCIAL_NETWORKS)('%s: positive max frames, a pixel size of its ratio, insets inside the page', (network) => {
    const t = SOCIAL_TEMPLATES[network];
    expect(Number.isInteger(t.maxFrames)).toBe(true);
    expect(t.maxFrames).toBeGreaterThan(0);
    expect(t.captionLimit).toBeGreaterThan(0);
    expect(Number.isInteger(t.width) && Number.isInteger(t.height)).toBe(true);
    const [rw, rh] = t.ratio.split(':').map(Number) as [number, number];
    expect(t.width / t.height).toBeCloseTo(rw / rh, 3);
    const { top, right, bottom, left } = t.safeArea;
    for (const inset of [top, right, bottom, left]) {
      expect(inset).toBeGreaterThanOrEqual(0);
      expect(inset).toBeLessThan(0.5);
    }
    // Something of the page is left inside the safe area.
    expect(left + right).toBeLessThan(1);
    expect(top + bottom).toBeLessThan(1);
    expect(t.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['jpeg', 'png']).toContain(t.format);
  });

  it('gives frames the template pixel size; an unknown network falls back to the default', () => {
    expect(frameTemplate('instagram-carousel')).toEqual({ name: 'phone-portrait', width: 1080, height: 1350 });
    expect(frameTemplate('instagram-story')).toEqual({ name: 'story', width: 1080, height: 1920 });
    expect(frameTemplate('x')).toEqual({ name: 'square', width: 1080, height: 1080 });
    expect(frameTemplate('pinterest')).toEqual({ name: 'custom', width: 1000, height: 1500 });
    expect(socialTemplate('myspace').network).toBe(DEFAULT_SOCIAL_NETWORK);
  });

  it('caps frames per network with a message', () => {
    expect(frameCapReached('bluesky', 3)).toBe(false);
    expect(frameCapReached('bluesky', 4)).toBe(true);
    expect(frameCapMessage('bluesky')).toBe('A Bluesky post holds up to 4 frames');
  });

  it('names frames 01 … NN and slugs posts', () => {
    expect(frameFileName(0, 'jpeg')).toBe('01.jpg');
    expect(frameFileName(9, 'png')).toBe('10.png');
    expect(postSlug('Instagram carousel 2')).toBe('instagram-carousel-2');
    expect(postSlug('!!!')).toBe('post');
  });

  it('gives posts whose names slug alike their own folders', () => {
    const outputs = [
      { id: 'a', kind: 'social', name: 'Trip A' },
      { id: 'p', kind: 'print', name: 'Trip A' },
      { id: 'b', kind: 'social', name: 'Trip-A' },
      { id: 'c', kind: 'social', name: 'trip a' },
      { id: 'd', kind: 'social', name: 'Other' },
    ];
    expect(['a', 'b', 'c', 'd'].map((id) => uniquePostSlug(outputs, id))).toEqual([
      'trip-a',
      'trip-a-2',
      'trip-a-3',
      'other',
    ]);
  });

  it('shows the grid crop guide on the first frame only, interface guides on every frame', () => {
    expect(showsSafeArea('instagram-carousel', 0)).toBe(true);
    expect(showsSafeArea('instagram-carousel', 1)).toBe(false);
    expect(showsSafeArea('instagram-story', 3)).toBe(true);
    expect(showsSafeArea('threads', 0)).toBe(false);
  });

  it('caps file size where the network has a small limit', () => {
    expect(SOCIAL_TEMPLATES.bluesky.maxBytes).toBe(1_000_000);
    for (const t of Object.values(SOCIAL_TEMPLATES))
      if (t.maxBytes !== undefined) expect(t.maxBytes).toBeGreaterThan(0);
  });

  it('counts captions in grapheme clusters', () => {
    expect(captionLength('hello')).toBe(5);
    expect(captionLength('👍🏽 ok')).toBe(4);
  });
});

describe('the social output schema', () => {
  it('reads a post without network or caption (plan 13) as an Instagram carousel with no caption', () => {
    const book = createEmptyBook({ title: 'Posts', folders: { f1: { path: '/photos' } } });
    const doc = JSON.parse(JSON.stringify(book));
    doc.outputs = [{ id: '01OUTPUTPOST0000000000000P1', name: 'Post', createdAt: 1, kind: 'social', frames: [] }];
    const loaded = loadBook(doc);
    const post = loaded.outputs[0];
    expect(post).toMatchObject({ kind: 'social', network: 'instagram-carousel', caption: '' });
    expect(templateOf(loaded, '01OUTPUTPOST0000000000000P1')).toEqual(frameTemplate('instagram-carousel'));
    expect(templateOf(loaded, BOOK_OUTPUT_ID)).toEqual(loaded.template);
  });

  it('rejects an unknown network', () => {
    const book = createEmptyBook({ title: 'Posts', folders: { f1: { path: '/photos' } } });
    const doc = JSON.parse(JSON.stringify(book));
    doc.outputs = [
      { id: '01OUTPUTPOST0000000000000P1', name: 'Post', createdAt: 1, kind: 'social', network: 'myspace' },
    ];
    expect(BookSchema.safeParse(doc).success).toBe(false);
  });
});
