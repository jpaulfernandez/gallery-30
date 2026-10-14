import {
  type Book,
  BookSchema,
  frameTemplate,
  pagesOf,
  reflowLayout,
  type SocialOutput,
  templateOf,
} from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undo, useBookStore } from './book';
import { postFull } from './outputs';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();
const actions = () => useBookStore.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const post = (id: string) => book().outputs.find((o): o is SocialOutput => o.id === id && o.kind === 'social');

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('social posts (plan 14)', () => {
  it('a new post is on the chosen network (the default one when none is given)', () => {
    const story = actions().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    const plain = actions().addOutput('social', 'Post') ?? '';
    expect(post(story)).toMatchObject({ network: 'instagram-story', caption: '' });
    expect(post(plain)?.network).toBe('instagram-carousel');
    expect(templateOf(book(), story)).toEqual({ name: 'story', width: 1080, height: 1920 });
  });

  it('send page to post keeps the element and asset ids, re-fits the layout, and undo removes the frame', () => {
    const id = actions().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    history().clear();
    const source = book().pages[2];
    if (!source) throw new Error('fixture page missing');
    const pages = book().pages;

    const frameId = actions().sendPageToOutput(source.id, id);
    expect(frameId).toBeTruthy();
    const frames = pagesOf(book(), id);
    expect(frames).toHaveLength(2);
    const frame = frames[1];
    expect(frame?.id).toBe(frameId);
    expect(frame?.id).not.toBe(source.id);
    expect(frame?.elements.map((e) => e.id)).toEqual(source.elements.map((e) => e.id));
    expect(frame?.elements.map((e) => (e.type === 'photo' ? e.asset : null))).toEqual(
      source.elements.map((e) => (e.type === 'photo' ? e.asset : null)),
    );
    expect(frame?.layout).toBe(source.layout);
    // The layout's frames for the story page size, not the 4:5 page's.
    const refit = reflowLayout(source, book().theme, frameTemplate('instagram-story'), book().customLayouts);
    expect(frame?.elements.map((e) => e.frame)).toEqual(refit.elements.map((e) => e.frame));
    expect(frame?.elements[0]?.frame).not.toEqual(source.elements[0]?.frame);
    // The book's own pages are untouched and the result is a valid project.
    expect(book().pages).toBe(pages);
    expect(() => BookSchema.parse(book())).not.toThrow();

    expect(history().pastStates).toHaveLength(1);
    undo();
    expect(pagesOf(book(), id)).toHaveLength(1);
    expect(pagesOf(book(), id).some((p) => p.id === frameId)).toBe(false);
  });

  it('caps frames at the network limit: add, send, add page and duplicate all stop', () => {
    const id = actions().addOutput('social', 'Sky', { network: 'bluesky' }) ?? '';
    expect(actions().addPostFrame(id)).toBeTruthy();
    expect(actions().addPostFrame(id)).toBeTruthy();
    expect(actions().addPostFrame(id)).toBeTruthy();
    expect(pagesOf(book(), id)).toHaveLength(4);
    expect(postFull(book(), id)).toBe(true);
    const steps = history().pastStates.length;

    expect(actions().addPostFrame(id)).toBeNull();
    expect(actions().sendPageToOutput(book().pages[0]?.id ?? '', id)).toBeNull();
    expect(actions().addPage(undefined, id)).toBeNull();
    expect(actions().duplicatePage(pagesOf(book(), id)[0]?.id ?? '')).toBeNull();
    expect(pagesOf(book(), id)).toHaveLength(4);
    expect(history().pastStates).toHaveLength(steps);
    // The book has no cap.
    expect(postFull(book(), 'book')).toBe(false);
  });

  it('addPostFrame adds a blank frame in one undo step; an unknown output gets none', () => {
    const id = actions().addOutput('social', 'Post') ?? '';
    history().clear();
    const frameId = actions().addPostFrame(id);
    expect(pagesOf(book(), id).at(-1)).toMatchObject({ id: frameId, elements: [] });
    expect(history().pastStates).toHaveLength(1);
    undo();
    expect(pagesOf(book(), id)).toHaveLength(1);
    expect(actions().addPostFrame('nope')).toBeNull();
  });

  it('setPostCaption stores the caption', () => {
    const id = actions().addOutput('social', 'Post') ?? '';
    actions().setPostCaption(id, 'Summer in Lisbon');
    expect(post(id)?.caption).toBe('Summer in Lisbon');
    expect(() => BookSchema.parse(book())).not.toThrow();
  });
});
