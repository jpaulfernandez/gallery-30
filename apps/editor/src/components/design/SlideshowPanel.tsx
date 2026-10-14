import {
  formatDuration,
  SECONDS_PER_SLIDE,
  SLIDESHOW_AUDIO_EXTENSIONS,
  SLIDESHOW_FPS,
  SLIDESHOW_SIZE_IDS,
  SLIDESHOW_SIZES,
  SLIDESHOW_SOURCE_BOOK,
  SLIDESHOW_SOURCE_PICKS,
  type SlideshowMotion,
  type SlideshowOrder,
  type SlideshowOutput,
  type SlideshowSize,
  type SlideshowTransition,
  slideshowSlides,
  slideshowTiming,
} from '@photobook/shared';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { importAudio } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { assetFlag } from '../../store/library';
import { Field, inputClass, Section } from '../editor/inspectorUi';
import { buttonClass as buttonLook } from '../ui/Button';
import { TransitionPreview } from './TransitionPreview';

const ORDER_LABELS: Record<SlideshowOrder, string> = {
  document: 'As listed',
  reverse: 'Reversed',
  shuffle: 'Shuffled',
};
const TRANSITION_LABELS: Record<SlideshowTransition, string> = {
  none: 'Cut',
  crossfade: 'Crossfade',
  dip: 'Dip to black',
};
const MOTION_LABELS: Record<SlideshowMotion, string> = { none: 'Still', 'ken-burns': 'Ken Burns' };

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = buttonLook({ size: 'sm' });

/**
 * The inspector with nothing selected on a slideshow (workflow plan 16): what it shows (the book's pages, a post's
 * frames or the picks) and in which order, seconds per slide, transition and motion with a looping preview, video size
 * and the audio track, plus the slide count and length. Every change is one undo step. Export video… (top bar) makes
 * the MP4.
 */
export function SlideshowPanel({ slideshow }: { slideshow: SlideshowOutput }) {
  const set = useBookStore((s) => s.setSlideshowSettings);
  const outputs = useBookStore((s) => s.book?.outputs);
  const posts = (outputs ?? []).filter((o) => o.kind === 'social');
  // Slides follow the picks as they change in Cull, so the count reads the library too.
  const slides = useBookStore((s) =>
    s.book ? slideshowSlides(s.book, slideshow, { isPick: (id) => assetFlag(s, id) === 'pick' }).pages.length : 0,
  );
  const timing = slideshowTiming({
    slides,
    secondsPerSlide: slideshow.secondsPerSlide,
    transition: slideshow.transition,
  });
  const size = SLIDESHOW_SIZES[slideshow.size];
  const [seconds, setSeconds] = useState(String(slideshow.secondsPerSlide));
  useEffect(() => setSeconds(String(slideshow.secondsPerSlide)), [slideshow.secondsPerSlide]);
  const [audioError, setAudioError] = useState<string | null>(null);
  const id = slideshow.id;

  const commitSeconds = () => {
    const value = Number(seconds);
    if (Number.isFinite(value) && seconds.trim() !== '') set(id, { secondsPerSlide: value });
    else setSeconds(String(slideshow.secondsPerSlide));
  };

  const chooseAudio = async () => {
    setAudioError(null);
    const path = await open({
      multiple: false,
      title: 'Audio for the slideshow',
      filters: [{ name: 'Audio', extensions: [...SLIDESHOW_AUDIO_EXTENSIONS] }],
    });
    if (typeof path !== 'string') return;
    try {
      const file = await importAudio(path);
      set(id, { audio: file });
    } catch (err) {
      setAudioError(errorMessage(err));
    }
  };

  return (
    <Section title="Slideshow">
      <Field label="Slides">
        <select
          aria-label="Slides"
          className={inputClass}
          value={slideshow.source}
          onChange={(e) => set(id, { source: e.target.value })}
        >
          <option value={SLIDESHOW_SOURCE_BOOK}>The book's pages</option>
          <option value={SLIDESHOW_SOURCE_PICKS}>The picks</option>
          {posts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Order">
        <select
          aria-label="Order"
          className={inputClass}
          value={slideshow.order}
          onChange={(e) => set(id, { order: e.target.value as SlideshowOrder })}
        >
          {Object.entries(ORDER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Seconds per slide">
        <input
          aria-label="Seconds per slide"
          type="number"
          min={SECONDS_PER_SLIDE.min}
          max={SECONDS_PER_SLIDE.max}
          step={SECONDS_PER_SLIDE.step}
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
          onBlur={commitSeconds}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSeconds();
          }}
          className={`${inputClass} w-16 text-right tabular-nums`}
        />
      </Field>
      <Field label="Transition">
        <select
          aria-label="Transition"
          className={inputClass}
          value={slideshow.transition}
          onChange={(e) => set(id, { transition: e.target.value as SlideshowTransition })}
        >
          {Object.entries(TRANSITION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Motion">
        <select
          aria-label="Motion"
          className={inputClass}
          value={slideshow.motion}
          onChange={(e) => set(id, { motion: e.target.value as SlideshowMotion })}
        >
          {Object.entries(MOTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <TransitionPreview
        transition={slideshow.transition}
        motion={slideshow.motion}
        aspect={size.width / size.height}
        secondsPerSlide={slideshow.secondsPerSlide}
      />
      <Field label="Size">
        <select
          aria-label="Video size"
          className={`${inputClass} max-w-40`}
          value={slideshow.size}
          onChange={(e) => set(id, { size: e.target.value as SlideshowSize })}
        >
          {SLIDESHOW_SIZE_IDS.map((value) => (
            <option key={value} value={value}>
              {SLIDESHOW_SIZES[value].label}
            </option>
          ))}
        </select>
      </Field>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-fg-muted text-xs">Audio</span>
          <div className="flex items-center gap-1">
            <button type="button" className={buttonClass} onClick={() => void chooseAudio()}>
              {slideshow.audioPath ? 'Change…' : 'Choose…'}
            </button>
            {slideshow.audioPath && (
              <button type="button" className={buttonClass} onClick={() => set(id, { audio: null })}>
                Remove
              </button>
            )}
          </div>
        </div>
        <p className="truncate text-[11px] text-fg-muted" title={slideshow.audioName}>
          {slideshow.audioName ?? 'None: the video is silent'}
        </p>
        {audioError && (
          <p role="alert" className="text-[11px] text-danger">
            {audioError}
          </p>
        )}
      </div>
      <p className="text-[11px] text-fg-muted tabular-nums leading-relaxed">
        {slides === 1 ? '1 slide' : `${slides} slides`} · {formatDuration(timing.seconds)} · {size.width} ×{' '}
        {size.height} · {SLIDESHOW_FPS} fps. A longer track is cut and faded out at the end.
      </p>
      {slides === 0 && (
        <p className="text-[11px] text-warn">
          {slideshow.source === SLIDESHOW_SOURCE_PICKS ? 'No photo is picked yet: pick some in Cull.' : 'No slides.'}
        </p>
      )}
    </Section>
  );
}
