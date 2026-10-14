import { type Book, createEmptyBook, createEmptyPage } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redo, undo, useBookStore } from './book';

const history = () => useBookStore.temporal.getState();
const book = () => useBookStore.getState().book as Book;
const frameOf = () => {
  const output = book().outputs[0];
  if (output?.kind !== 'social') throw new Error('no post');
  return output.frames[0] as Book['pages'][number];
};
const brief = {
  about: 'Lisbon',
  photographer: '',
  placeTime: '',
  people: ['Ana'],
  voice: 'diary' as const,
  avoid: '',
  examples: [],
  useExisting: false,
};

beforeEach(() => {
  const b = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: '/photos' } } });
  const frame = createEmptyPage();
  frame.elements = [
    { type: 'text', id: 't9', text: 'Post text', style: 'caption', frame: { x: 0, y: 0, w: 1, h: 0.1 }, align: 'left' },
  ];
  b.outputs = [
    { kind: 'social', id: 'o1', name: 'Carousel', createdAt: 1, frames: [frame] } as Book['outputs'][number],
  ];
  useBookStore.setState({ book: b, folder: '/photos', libraries: {} });
  history().clear();
});
afterEach(() => useBookStore.getState().close());

describe('setBrief', () => {
  it('is one undo step; the same brief again records nothing; null removes it', () => {
    useBookStore.getState().setBrief(brief);
    expect(book().captions.brief).toEqual(brief);
    expect(history().pastStates).toHaveLength(1);
    useBookStore.getState().setBrief({ ...brief, people: ['Ana'] });
    expect(history().pastStates).toHaveLength(1);
    undo();
    expect(book().captions.brief).toBeUndefined();
    redo();
    expect(book().captions.brief?.voice).toBe('diary');
    useBookStore.getState().setBrief(null);
    expect(book().captions.brief).toBeUndefined();
  });
});

describe('writeCaption', () => {
  it('writes the text of an output frame in one step', () => {
    const frameId = frameOf().id;
    useBookStore.getState().writeCaption(frameId, 't9', 'A new caption.');
    const el = frameOf().elements[0];
    expect(el?.type === 'text' && el.text).toBe('A new caption.');
    expect(history().pastStates).toHaveLength(1);
    // Unknown elements and unchanged text do nothing.
    useBookStore.getState().writeCaption(frameId, 'nope', 'x');
    useBookStore.getState().writeCaption(frameId, 't9', 'A new caption.');
    expect(history().pastStates).toHaveLength(1);
  });
});
