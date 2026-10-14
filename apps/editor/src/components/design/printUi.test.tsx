// @vitest-environment jsdom
import { BOOK_OUTPUT_ID, type PrintOutput, pagesOf, templateOf } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undo, useBookStore } from '../../store/book';
import { postFull } from '../../store/outputs';
import { useUiStore } from '../../store/ui';
import { printExportText } from './PrintExportToast';
import { PrintPanel } from './PrintPanel';

/** Workflow plan 15: the print output's settings in the store and the inspector. */

const print = (id: string) =>
  useBookStore.getState().book?.outputs.find((o): o is PrintOutput => o.id === id && o.kind === 'print');

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos', projectId: 'P' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('print settings in the store', () => {
  it('a new print starts on the paper of the book’s pages, prints the book, and each change is one undo step', () => {
    const id = useBookStore.getState().addOutput('print', 'Zine') ?? '';
    expect(print(id)).toMatchObject({
      source: 'book',
      paper: '8x10',
      imposition: 'pages',
      bleedMm: 3,
      marks: true,
      dpi: 300,
    });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(pagesOf(book, id)).toBe(book.pages);

    useBookStore.getState().setPrintSettings(id, { imposition: 'spreads', marks: false });
    expect(print(id)).toMatchObject({ imposition: 'spreads', marks: false });
    undo();
    expect(print(id)).toMatchObject({ imposition: 'pages', marks: true });
  });

  it('clamps the bleed and dpi, and falls back to the book for a source that is not a post', () => {
    const id = useBookStore.getState().addOutput('print', 'Zine') ?? '';
    useBookStore.getState().setPrintSettings(id, { bleedMm: 25, dpi: 20 });
    expect(print(id)).toMatchObject({ bleedMm: 10, dpi: 72 });
    useBookStore.getState().setPrintSettings(id, { source: id });
    expect(print(id)?.source).toBe(BOOK_OUTPUT_ID);
  });

  it('prints a post’s frames at the post’s size when that is the source', () => {
    const post = useBookStore.getState().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    const id = useBookStore.getState().addOutput('print', 'Story print') ?? '';
    useBookStore.getState().setPrintSettings(id, { source: post });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(pagesOf(book, id)).toBe(pagesOf(book, post));
    expect(templateOf(book, id)).toEqual(templateOf(book, post));
  });

  it('a print of a full post cannot add pages past the post’s frame limit', () => {
    const post = useBookStore.getState().addOutput('social', 'Sky', { network: 'bluesky' }) ?? '';
    for (let i = 0; i < 3; i++) useBookStore.getState().addPostFrame(post);
    const id = useBookStore.getState().addOutput('print', 'Sky print') ?? '';
    useBookStore.getState().setPrintSettings(id, { source: post });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(postFull(book, id)).toBe(true);
    expect(postFull(book, useBookStore.getState().addOutput('print', 'Book print') ?? '')).toBe(false);
  });
});

describe('print panel', () => {
  it('shows the sheet, changes the settings and applies the zine preset', () => {
    const id = useBookStore.getState().addOutput('print', 'Zine') ?? '';
    const { rerender } = render(<PrintPanel print={print(id) as PrintOutput} />);
    expect(screen.getByText(/8 × 10 in portrait pages, 209.2 × 260 mm with bleed/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Paper size'), { target: { value: 'a5' } });
    rerender(<PrintPanel print={print(id) as PrintOutput} />);
    expect(print(id)?.paper).toBe('a5');
    // The fixture's pages are 4:5; A5 is not: the panel says so and names the paper that fits.
    expect(screen.getByRole('note').textContent).toMatch(/4:5.*8 × 10 in portrait fits/);

    fireEvent.change(screen.getByLabelText('Bleed in millimetres'), { target: { value: '5' } });
    fireEvent.blur(screen.getByLabelText('Bleed in millimetres'));
    expect(print(id)?.bleedMm).toBe(5);

    fireEvent.click(screen.getByRole('button', { name: /Zine/ }));
    expect(print(id)).toMatchObject({ paper: 'a5', imposition: 'spreads', bleedMm: 3, marks: true, dpi: 300 });
  });

  it('says when the printed post was deleted, and the zine preset keeps a landscape book landscape', () => {
    const post = useBookStore.getState().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    const id = useBookStore.getState().addOutput('print', 'Zine') ?? '';
    useBookStore.getState().setPrintSettings(id, { source: post });
    useBookStore.getState().deleteOutput(post);
    render(<PrintPanel print={print(id) as PrintOutput} />);
    expect(screen.getByText('Post deleted; printing the book.')).toBeTruthy();
    cleanup();

    useBookStore.getState().setTemplate('a4-landscape');
    const landscape = useBookStore.getState().addOutput('print', 'Wide') ?? '';
    render(<PrintPanel print={print(landscape) as PrintOutput} />);
    fireEvent.click(screen.getByRole('button', { name: /Zine/ }));
    expect(print(landscape)).toMatchObject({ paper: 'a5', orientation: 'landscape', imposition: 'spreads' });
  });

  it('the toast says what happened to a run', () => {
    const run = { name: 'Zine', file: 'zine.pdf' };
    expect(printExportText({ ...run, outcome: null })).toBe('Making zine.pdf of “Zine”…');
    expect(printExportText({ ...run, outcome: { state: 'done', path: '/d/zine.pdf' } })).toBe(
      'Saved zine.pdf of “Zine”.',
    );
    expect(printExportText({ ...run, outcome: { state: 'failed', error: 'boom' } })).toMatch(/failed: boom/);
  });
});
