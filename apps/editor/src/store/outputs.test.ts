import { BOOK_OUTPUT_ID, type Book, BookSchema, pagesOf, SOCIAL_DEFAULT_TEMPLATE } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampCrop, cropFit } from '../lib/crop';
import { redo, undo, useBookStore } from './book';
import { currentDesignBook, designBook } from './design';
import { useUiStore } from './ui';

const history = () => useBookStore.temporal.getState();
const actions = () => useBookStore.getState();
const book = (): Book => {
  const b = useBookStore.getState().book;
  if (!b) throw new Error('no book');
  return b;
};
const output = (id: string) => book().outputs.find((o) => o.id === id);
const framesOf = (id: string) => pagesOf(book(), id);

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
  useUiStore.getState().reset();
});
afterEach(() => useBookStore.getState().close());

describe('output actions', () => {
  it('addOutput adds a post with one blank frame; undo removes it, redo brings it back', () => {
    const pages = book().pages;
    const id = actions().addOutput('social', 'Carousel');
    expect(id).toBeTruthy();
    const added = output(id ?? '');
    expect(added).toMatchObject({ kind: 'social', name: 'Carousel' });
    expect(framesOf(id ?? '')).toHaveLength(1);
    expect(framesOf(id ?? '')[0]?.elements).toEqual([]);
    expect(book().pages).toBe(pages);
    expect(() => BookSchema.parse(book())).not.toThrow();
    expect(history().pastStates).toHaveLength(1);
    undo();
    expect(book().outputs).toEqual([]);
    redo();
    expect(output(id ?? '')?.name).toBe('Carousel');
  });

  it('addPhotoPost (plan 56, the Carousel) makes a 4:5 post with one photo per frame, fit inside; one undo step', () => {
    const ids = Object.keys(book().assets);
    expect(ids.length).toBeGreaterThan(1);
    const id = actions().addPhotoPost('Carousel', [...ids, 'unknown']) ?? '';
    const post = output(id);
    expect(post).toMatchObject({ kind: 'social', name: 'Carousel', network: 'instagram-carousel' });
    const frames = framesOf(id);
    expect(frames.map((f) => f.elements.map((el) => (el.type === 'photo' ? el.asset : null)))).toEqual(
      ids.map((a) => [a]),
    );
    for (const f of frames) {
      const el = f.elements[0];
      if (el?.type !== 'photo') throw new Error('photo expected');
      // Inside the page, centred, the whole photo shown.
      expect(el.frame.x).toBeGreaterThanOrEqual(0);
      expect(el.frame.x + el.frame.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(el.frame.x + el.frame.w / 2).toBeCloseTo(0.5);
      expect(el.crop).toEqual({ x: 0, y: 0, scale: 1 });
    }
    // New page and element ids; the asset ids are the book's.
    expect(new Set(frames.map((f) => f.id)).size).toBe(frames.length);
    expect(() => BookSchema.parse(book())).not.toThrow();
    expect(history().pastStates).toHaveLength(1);
    expect(actions().addPhotoPost('Empty', ['unknown'])).toBeNull();
    undo();
    expect(book().outputs).toEqual([]);
  });

  it('renameOutput renames (a blank name is ignored); undo restores the name', () => {
    const id = actions().addOutput('social', 'Post') ?? '';
    actions().renameOutput(id, '  Summer  ');
    expect(output(id)?.name).toBe('Summer');
    actions().renameOutput(id, '   ');
    expect(output(id)?.name).toBe('Summer');
    expect(history().pastStates).toHaveLength(2);
    undo();
    expect(output(id)?.name).toBe('Post');
  });

  it('duplicateOutput copies after the source with new frame and element ids; undo removes the copy', () => {
    const a = actions().addOutput('social', 'Post') ?? '';
    const b = actions().addOutput('social', 'Other') ?? '';
    const frame = framesOf(a)[0];
    if (!frame) throw new Error('no frame');
    actions().addText(frame.id);
    const copy = actions().duplicateOutput(a) ?? '';
    expect(book().outputs.map((o) => o.id)).toEqual([a, copy, b]);
    expect(output(copy)?.name).toBe('Post copy');
    const [source, copied] = [framesOf(a)[0], framesOf(copy)[0]];
    expect(copied?.id).not.toBe(source?.id);
    expect(copied?.elements).toHaveLength(1);
    expect(copied?.elements[0]?.id).not.toBe(source?.elements[0]?.id);
    expect(copied?.elements.map(({ id: _, ...rest }) => rest)).toEqual(
      source?.elements.map(({ id: _, ...rest }) => rest),
    );
    expect(() => BookSchema.parse(book())).not.toThrow();
    undo();
    expect(book().outputs.map((o) => o.id)).toEqual([a, b]);
  });

  it('deleteOutput removes the output and its frames; undo restores it in place', () => {
    const a = actions().addOutput('social', 'A') ?? '';
    const b = actions().addOutput('social', 'B') ?? '';
    actions().deleteOutput(a);
    expect(book().outputs.map((o) => o.id)).toEqual([b]);
    undo();
    expect(book().outputs.map((o) => o.id)).toEqual([a, b]);
    expect(framesOf(a)).toHaveLength(1);
  });
});

describe('page actions inside an output', () => {
  it('edit the frames of the open post and leave the book pages alone', () => {
    const post = actions().addOutput('social', 'Post') ?? '';
    const pages = book().pages;
    useUiStore.getState().setDesignOutput(post);
    // Pages added and moved with no output given go to the output on the Design stage.
    const second = actions().addPage();
    expect(second).toBeTruthy();
    expect(framesOf(post).map((p) => p.id)).toContain(second);
    const first = framesOf(post)[0];
    if (!first || !second) throw new Error('no frames');
    actions().movePage(1, 0);
    expect(framesOf(post).map((p) => p.id)).toEqual([second, first.id]);
    // Element edits find the frame by id.
    const text = actions().addText(first.id) ?? '';
    actions().updateElement(first.id, text, (el) => {
      if (el.type === 'text') el.text = 'Hello';
    });
    actions().setFrames(first.id, { [text]: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 } });
    const dup = actions().duplicatePage(first.id);
    expect(framesOf(post)).toHaveLength(3);
    actions().deletePage(dup ?? '');
    const edited = framesOf(post).find((p) => p.id === first.id);
    expect(edited?.elements[0]).toMatchObject({
      type: 'text',
      text: 'Hello',
      frame: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 },
    });
    expect(edited?.layout).toBe('custom');
    // The book's pages are the very same array as before.
    expect(book().pages).toBe(pages);
    expect(() => BookSchema.parse(book())).not.toThrow();
    // Undo walks back through the frame edits only.
    while (framesOf(post).length > 0 && history().pastStates.length > 1) undo();
    expect(framesOf(post)).toHaveLength(1);
    expect(book().pages).toBe(pages);
  });

  it('fits photos in a frame against the post template, not the book template', () => {
    const square: Book = { ...structuredClone(fixtureBook), template: { name: 'square', width: 1080, height: 1080 } };
    useBookStore.setState({ book: square });
    const post = actions().addOutput('social', 'Post') ?? '';
    const frameId = framesOf(post)[0]?.id ?? '';
    const assetId = Object.entries(book().assets).find(([, a]) => a.width && a.height)?.[0] ?? '';
    const slot = actions().addFrame(frameId, { x: 0, y: 0, w: 1, h: 0.5 }) ?? '';
    actions().setElementAsset(frameId, slot, assetId);
    actions().setCrop(frameId, slot, { x: 1, y: 1, scale: 1.5 });
    const el = framesOf(post)[0]?.elements.find((e) => e.id === slot);
    if (el?.type !== 'photo') throw new Error('no photo');
    const wanted = clampCrop(
      { x: 1, y: 1, scale: 1.5 },
      cropFit({ assets: book().assets, template: SOCIAL_DEFAULT_TEMPLATE }, el),
    );
    const asBook = clampCrop({ x: 1, y: 1, scale: 1.5 }, cropFit(book(), el));
    expect(el.crop).toEqual(wanted);
    expect(wanted).not.toEqual(asBook);
    const view = designBook(book(), post);
    expect(view.template).toEqual(SOCIAL_DEFAULT_TEMPLATE);
    expect(view.pages).toBe(framesOf(post));
    expect(designBook(book(), BOOK_OUTPUT_ID)).toBe(book());
    useUiStore.getState().setDesignOutput(post);
    expect(currentDesignBook()?.pages).toBe(framesOf(post));
    // The cached view is stable between reads of the same book.
    expect(designBook(book(), post)).toBe(view);
  });

  it('adds nothing to an output that does not exist', () => {
    expect(actions().addPage(0, 'nope')).toBeNull();
    expect(book().pages).toHaveLength(fixtureBook.pages.length);
  });
});

describe('book-wide actions reach output frames', () => {
  it('replaceAssetId rewrites photo and background references in post frames', () => {
    const post = actions().addOutput('social', 'Post') ?? '';
    const frameId = framesOf(post)[0]?.id ?? '';
    const [from, to] = Object.keys(book().assets);
    if (!from || !to) throw new Error('fixture needs two assets');
    actions().setPageBackground(frameId, { asset: from });
    const slot = actions().addFrame(frameId, { x: 0, y: 0, w: 0.5, h: 0.5 }) ?? '';
    actions().setElementAsset(frameId, slot, from);
    actions().replaceAssetId(from, to);
    const frame = framesOf(post)[0];
    expect(frame?.background).toEqual({ asset: to });
    expect(frame?.elements.find((e) => e.id === slot)).toMatchObject({ asset: to });
    expect(from in book().assets).toBe(false);
    expect(() => BookSchema.parse(book())).not.toThrow();
  });

  it('removeCustomLayout turns post frames that used it into custom pages', () => {
    const post = actions().addOutput('social', 'Post') ?? '';
    const frameId = framesOf(post)[0]?.id ?? '';
    const layoutId =
      actions().addCustomLayout(
        {
          id: 'x',
          name: 'Mine',
          photos: 1,
          group: 'custom',
          source: 'custom',
          items: [{ kind: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 0.4 }],
        },
        frameId,
      ) ?? '';
    expect(framesOf(post)[0]?.layout).toBe(layoutId);
    actions().removeCustomLayout(layoutId);
    expect(framesOf(post)[0]?.layout).toBe('custom');
  });
});

describe('Design stage document', () => {
  it('reopens each document on the page it was left on', () => {
    const post = actions().addOutput('social', 'Post') ?? '';
    actions().addPage(undefined, post);
    actions().addPage(undefined, post);
    const ui = () => useUiStore.getState();
    ui().setPageIndex(2);
    ui().setDesignOutput(post);
    expect(ui().pageIndex).toBe(0);
    ui().setPageIndex(1);
    ui().setDesignOutput(BOOK_OUTPUT_ID);
    expect(ui().pageIndex).toBe(2);
    ui().setDesignOutput(post);
    expect(ui().pageIndex).toBe(1);
    // A document that lost pages since is clamped.
    ui().setDesignOutput(BOOK_OUTPUT_ID);
    actions().deletePage(framesOf(post)[2]?.id ?? '');
    actions().deletePage(framesOf(post)[1]?.id ?? '');
    ui().setDesignOutput(post);
    expect(ui().pageIndex).toBe(0);
  });
});
