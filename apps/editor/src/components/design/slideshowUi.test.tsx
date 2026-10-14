// @vitest-environment jsdom
import { pagesOf, type SlideshowOutput, templateOf } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { slideshowExportText } from './SlideshowExportToast';
import { SlideshowPanel } from './SlideshowPanel';

/** Workflow plan 16: the slideshow output's settings in the store and the inspector. */

const slideshow = (id: string) =>
  useBookStore.getState().book?.outputs.find((o): o is SlideshowOutput => o.id === id && o.kind === 'slideshow');

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos', projectId: 'P' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('slideshow settings in the store', () => {
  it('a new slideshow shows the book with the defaults, and each change is one undo step', () => {
    const id = useBookStore.getState().addOutput('slideshow', 'Trip') ?? '';
    expect(slideshow(id)).toMatchObject({
      source: 'book',
      order: 'document',
      secondsPerSlide: 4,
      transition: 'crossfade',
      motion: 'ken-burns',
      size: '1080p',
    });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(pagesOf(book, id)).toBe(book.pages);

    useBookStore.getState().setSlideshowSettings(id, { transition: 'dip', size: 'vertical-1080p' });
    expect(slideshow(id)).toMatchObject({ transition: 'dip', size: 'vertical-1080p' });
    undo();
    expect(slideshow(id)).toMatchObject({ transition: 'crossfade', size: '1080p' });
  });

  it('clamps the seconds, refuses an unknown source, sets and removes the audio', () => {
    const id = useBookStore.getState().addOutput('slideshow', 'Trip') ?? '';
    useBookStore.getState().setSlideshowSettings(id, { secondsPerSlide: 0.2 });
    expect(slideshow(id)?.secondsPerSlide).toBe(1);
    useBookStore.getState().setSlideshowSettings(id, { secondsPerSlide: 3.3 });
    expect(slideshow(id)?.secondsPerSlide).toBe(3.5);
    useBookStore.getState().setSlideshowSettings(id, { source: 'nope' });
    expect(slideshow(id)?.source).toBe('book');
    useBookStore.getState().setSlideshowSettings(id, { source: 'picks' });
    expect(slideshow(id)?.source).toBe('picks');

    useBookStore.getState().setSlideshowSettings(id, { audio: { path: '/appdata/audio/x.m4a', name: 'Song.m4a' } });
    expect(slideshow(id)).toMatchObject({ audioPath: '/appdata/audio/x.m4a', audioName: 'Song.m4a' });
    useBookStore.getState().setSlideshowSettings(id, { audio: null });
    expect(slideshow(id)?.audioPath).toBeUndefined();
    expect(slideshow(id)?.audioName).toBeUndefined();
  });

  it("shows a post's frames at the post's size when that is the source", () => {
    const post = useBookStore.getState().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    const id = useBookStore.getState().addOutput('slideshow', 'Story video') ?? '';
    useBookStore.getState().setSlideshowSettings(id, { source: post });
    const book = useBookStore.getState().book;
    if (!book) throw new Error('no book');
    expect(pagesOf(book, id)).toBe(pagesOf(book, post));
    expect(templateOf(book, id)).toEqual(templateOf(book, post));
  });

  it('duplicates a slideshow with its settings', () => {
    const id = useBookStore.getState().addOutput('slideshow', 'Trip') ?? '';
    useBookStore.getState().setSlideshowSettings(id, { motion: 'none' });
    const copy = useBookStore.getState().duplicateOutput(id) ?? '';
    expect(slideshow(copy)).toMatchObject({ name: 'Trip copy', motion: 'none', source: 'book' });
  });
});

describe('the slideshow inspector', () => {
  it('shows the slide count and length, and changes settings', () => {
    const id = useBookStore.getState().addOutput('slideshow', 'Trip') ?? '';
    const s = slideshow(id);
    if (!s) throw new Error('no slideshow');
    const pages = useBookStore.getState().book?.pages.length ?? 0;
    const { rerender } = render(<SlideshowPanel slideshow={s} />);
    const seconds = pages * 4;
    expect(
      screen.getByText(new RegExp(`${pages} slides · 0:${String(seconds).padStart(2, '0')} · 1920 × 1080`)),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: /crossfade with Ken Burns/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Transition'), { target: { value: 'none' } });
    expect(slideshow(id)?.transition).toBe('none');
    fireEvent.change(screen.getByLabelText('Seconds per slide'), { target: { value: '6' } });
    fireEvent.blur(screen.getByLabelText('Seconds per slide'));
    expect(slideshow(id)?.secondsPerSlide).toBe(6);

    // The picks: none in the fixture's libraries.
    fireEvent.change(screen.getByLabelText('Slides'), { target: { value: 'picks' } });
    const picks = slideshow(id);
    if (!picks) throw new Error('no slideshow');
    rerender(<SlideshowPanel slideshow={picks} />);
    expect(screen.getByText(/No photo is picked yet/)).toBeTruthy();
  });

  it('says what an export did', () => {
    const base = { name: 'Trip', file: 'trip.mp4' };
    expect(slideshowExportText({ ...base, outcome: null })).toBe('Making trip.mp4 of “Trip”…');
    expect(slideshowExportText({ ...base, outcome: { state: 'done', path: '/x/trip.mp4' } })).toBe(
      'Saved trip.mp4 of “Trip”.',
    );
    expect(slideshowExportText({ ...base, outcome: { state: 'failed', error: 'FFmpeg failed' } })).toBe(
      'trip.mp4 of “Trip” failed: FFmpeg failed',
    );
  });
});
