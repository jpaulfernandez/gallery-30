import {
  type Book,
  clampSecondsPerSlide,
  findOutput,
  SLIDESHOW_SOURCE_BOOK,
  SLIDESHOW_SOURCE_PICKS,
  type SlideshowOutput,
  SlideshowOutputSchema,
} from '@photobook/shared';
import type { Draft } from 'immer';

/**
 * Slideshow settings (workflow plan 16): the book store's action that edits a `slideshow` output (one undo step). The
 * slideshow holds settings only; its slides are its source's pages or the picks (`slideshowSlides`).
 */

/** The fields of a slideshow that `setSlideshowSettings` changes. */
export type SlideshowPatch = Partial<
  Pick<SlideshowOutput, 'source' | 'order' | 'secondsPerSlide' | 'transition' | 'motion' | 'size'>
> & {
  /** The audio track: an imported file (`importAudio`), or null to remove it. */
  audio?: { path: string; name: string } | null;
};

export interface SlideshowSlice {
  /** Change slideshow `outputId`'s settings; values the schema refuses are ignored, the seconds are clamped. */
  setSlideshowSettings: (outputId: string, patch: SlideshowPatch) => void;
}

/** Whether `source` is a slideshow source of `book`: the book, the picks or one of its posts. */
export function validSlideshowSource(book: Pick<Book, 'outputs'>, source: string): boolean {
  return (
    source === SLIDESHOW_SOURCE_BOOK ||
    source === SLIDESHOW_SOURCE_PICKS ||
    book.outputs.some((o) => o.id === source && o.kind === 'social')
  );
}

/** `output` with `patch` applied, or null when the result is not a valid slideshow. */
export function patchedSlideshow(
  book: Pick<Book, 'outputs'>,
  output: SlideshowOutput,
  patch: SlideshowPatch,
): SlideshowOutput | null {
  const { audio, ...fields } = patch;
  const next: SlideshowOutput = { ...output, ...fields };
  if (fields.secondsPerSlide !== undefined) next.secondsPerSlide = clampSecondsPerSlide(fields.secondsPerSlide);
  if (!validSlideshowSource(book, next.source)) return null;
  if (audio === null) {
    delete next.audioPath;
    delete next.audioName;
  } else if (audio) {
    next.audioPath = audio.path;
    next.audioName = audio.name;
  }
  const parsed = SlideshowOutputSchema.safeParse(next);
  return parsed.success ? parsed.data : null;
}

type SliceState = { book: Book | null };
type SliceSet = (recipe: (draft: Draft<SliceState>) => void) => void;

export function createSlideshowSlice(
  set: SliceSet,
  get: () => SliceState,
  discrete: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R,
): SlideshowSlice {
  return {
    setSlideshowSettings: discrete((outputId: string, patch: SlideshowPatch) => {
      const book = get().book;
      const output = book ? findOutput(book, outputId) : undefined;
      if (!book || output?.kind !== 'slideshow') return;
      const next = patchedSlideshow(book, output, patch);
      if (!next || JSON.stringify(next) === JSON.stringify(output)) return;
      set((s) => {
        const index = s.book?.outputs.findIndex((o) => o.id === outputId) ?? -1;
        if (s.book && index >= 0) s.book.outputs[index] = next;
      });
    }),
  };
}
