import { describe, expect, it } from 'vitest';
import { fixtureBook } from './fixtures/fixturePage.js';
import {
  allPages,
  BOOK_OUTPUT_ID,
  type Book,
  BookSchema,
  createEmptyPage,
  DEFAULT_PRINT_SETTINGS,
  findOutput,
  hasOutput,
  locatePage,
  nextOutputName,
  pagesOf,
  SOCIAL_DEFAULT_TEMPLATE,
  templateOf,
  uniqueOutputName,
  usedAssetIdsOf,
} from './index.js';

const assetId = Object.keys(fixtureBook.assets)[0] ?? '';

function withOutputs(): Book {
  const frame = { ...createEmptyPage(), background: { asset: assetId } };
  return {
    ...fixtureBook,
    template: { name: 'square', width: 1080, height: 1080 },
    outputs: [
      {
        id: 'post',
        name: 'Post',
        createdAt: 1,
        kind: 'social',
        network: 'instagram-carousel',
        frames: [frame],
        caption: '',
      },
      { id: 'print', name: 'Print', createdAt: 2, kind: 'print', ...DEFAULT_PRINT_SETTINGS },
    ],
  };
}

describe('output documents', () => {
  it('reads the book, a post and a print through pagesOf and templateOf', () => {
    const book = withOutputs();
    expect(pagesOf(book, BOOK_OUTPUT_ID)).toBe(book.pages);
    const post = findOutput(book, 'post');
    expect(post?.kind === 'social' && pagesOf(book, 'post')).toBe(post?.kind === 'social' && post.frames);
    // A print shows the book's pages; an unknown id has none.
    expect(pagesOf(book, 'print')).toBe(book.pages);
    expect(pagesOf(book, 'nope')).toEqual([]);
    expect(templateOf(book, BOOK_OUTPUT_ID)).toBe(book.template);
    expect(templateOf(book, 'post')).toEqual(SOCIAL_DEFAULT_TEMPLATE);
    expect(templateOf(book, 'print')).toBe(book.template);
    expect(hasOutput(book, BOOK_OUTPUT_ID)).toBe(true);
    expect(hasOutput(book, 'post')).toBe(true);
    expect(hasOutput(book, 'nope')).toBe(false);
    expect(findOutput(book, BOOK_OUTPUT_ID)).toBeUndefined();
  });

  it('locates a page in the book or in an output, with its template', () => {
    const book = withOutputs();
    const first = book.pages[0];
    const frame = pagesOf(book, 'post')[0];
    expect(first && locatePage(book, first.id)).toMatchObject({ outputId: BOOK_OUTPUT_ID, index: 0 });
    expect(frame && locatePage(book, frame.id)).toMatchObject({
      outputId: 'post',
      index: 0,
      template: SOCIAL_DEFAULT_TEMPLATE,
    });
    expect(locatePage(book, 'nope')).toBeUndefined();
    expect(allPages(book)).toHaveLength(book.pages.length + 1);
  });

  it('counts assets used by output frames, which the dangling-id check covers too', () => {
    const book = withOutputs();
    expect(usedAssetIdsOf({ pages: [], outputs: book.outputs }).has(assetId)).toBe(true);
    const { [assetId]: _gone, ...assets } = book.assets;
    const result = BookSchema.safeParse({ ...book, pages: [], assets });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['outputs', 0, 'frames', 0, 'background', 'asset']);
  });

  it('rejects a page id used twice across the book and its outputs', () => {
    const book = withOutputs();
    const first = book.pages[0];
    if (!first) throw new Error('no page');
    const post = { id: 'p2', name: 'Copy', createdAt: 3, kind: 'social' as const, frames: [structuredClone(first)] };
    const result = BookSchema.safeParse({ ...book, outputs: [...book.outputs, post] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path)).toContainEqual(['outputs', 2, 'frames', 0, 'id']);
  });

  it('names new outputs after their kind without repeating a name', () => {
    const book = withOutputs();
    expect(nextOutputName(book, 'social')).toBe('Post 2');
    expect(nextOutputName({ outputs: [] }, 'social')).toBe('Post');
    expect(nextOutputName(book, 'print')).toBe('Print 2');
    expect(uniqueOutputName(book, 'Post copy')).toBe('Post copy');
    const copied = { outputs: [...book.outputs, { name: 'Post copy' }, { name: 'Post copy 2' }] };
    expect(uniqueOutputName(copied, 'Post copy')).toBe('Post copy 3');
  });
});
