import { slugify } from '../ids.js';

/**
 * Slideshow video (workflow plan 16): the settings a `slideshow` output holds and their limits. A slideshow is an MP4
 * of the book's pages, a post's frames or the project's picks, one slide each, with Ken Burns motion, a transition and
 * optional audio. The CLI renders every video frame as a still (`render-slideshow`, the same Chromium page renderer as
 * the book's page images) and the editor encodes them with FFmpeg (`commands/video.rs`). Values stored in project
 * files: append to these lists, never rename.
 */

/** Frames per second of every slideshow (30: what the phone apps record and play natively). */
export const SLIDESHOW_FPS = 30;

/** Video sizes. Landscape for YouTube, vertical for Reels, TikTok and Shorts, square for feeds. */
export const SLIDESHOW_SIZE_IDS = ['1080p', '4k', 'vertical-1080p', 'vertical-4k', 'square-1080p'] as const;
export type SlideshowSize = (typeof SLIDESHOW_SIZE_IDS)[number];

export interface SlideshowSizeInfo {
  width: number;
  height: number;
  label: string;
  /** Video bitrate in bits per second (H.264 through VideoToolbox; what YouTube recommends for 30 fps SDR uploads). */
  bitrate: number;
}

export const SLIDESHOW_SIZES: Record<SlideshowSize, SlideshowSizeInfo> = {
  '1080p': { width: 1920, height: 1080, label: '1080p landscape (YouTube)', bitrate: 12_000_000 },
  '4k': { width: 3840, height: 2160, label: '4K landscape (YouTube)', bitrate: 45_000_000 },
  'vertical-1080p': { width: 1080, height: 1920, label: '1080p vertical (Reels, TikTok)', bitrate: 12_000_000 },
  'vertical-4k': { width: 2160, height: 3840, label: '4K vertical', bitrate: 45_000_000 },
  'square-1080p': { width: 1080, height: 1080, label: 'Square 1080 (feeds)', bitrate: 8_000_000 },
};

/** Slide order: as the source lists them, reversed, or shuffled (seeded by the slideshow's id, so it is stable). */
export const SLIDESHOW_ORDERS = ['document', 'reverse', 'shuffle'] as const;
export type SlideshowOrder = (typeof SLIDESHOW_ORDERS)[number];

/** `none` cuts; `crossfade` dissolves one slide into the next; `dip` fades through black. */
export const SLIDESHOW_TRANSITIONS = ['none', 'crossfade', 'dip'] as const;
export type SlideshowTransition = (typeof SLIDESHOW_TRANSITIONS)[number];

/** `ken-burns` slowly zooms and pans each slide (`kenBurnsCrop`); `none` holds it still. */
export const SLIDESHOW_MOTIONS = ['none', 'ken-burns'] as const;
export type SlideshowMotion = (typeof SLIDESHOW_MOTIONS)[number];

/** `source` values besides a post's id: the book's pages, or the project's picked photos (one per slide). */
export const SLIDESHOW_SOURCE_BOOK = 'book';
export const SLIDESHOW_SOURCE_PICKS = 'picks';

/** Seconds each slide is on screen (a transition happens inside this time, so it never lengthens the video). */
export const SECONDS_PER_SLIDE = { min: 1, max: 30, step: 0.5, default: 4 } as const;

/** Length of a transition, capped at half a slide. */
export const TRANSITION_SECONDS = 0.8;

/** How far Ken Burns zooms in (1.15: the frame shows 87% of the slide at the tight end). */
export const KEN_BURNS_ZOOM = 1.15;

/** Seconds of audio fade-out at the end of the video. */
export const AUDIO_FADE_SECONDS = 1.5;

/** Audio files a slideshow takes (FFmpeg decodes them; AAC goes into the MP4). */
export const SLIDESHOW_AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus'] as const;

export interface SlideshowSettings {
  source: string;
  order: SlideshowOrder;
  secondsPerSlide: number;
  transition: SlideshowTransition;
  motion: SlideshowMotion;
  size: SlideshowSize;
  /** The audio track: a copy in the app data dir (`import_audio`), so it stays readable in later sessions. */
  audioPath?: string;
  /** The audio file's name as picked, for the inspector. */
  audioName?: string;
}

export const DEFAULT_SLIDESHOW_SETTINGS = {
  source: SLIDESHOW_SOURCE_BOOK,
  order: 'document',
  secondsPerSlide: SECONDS_PER_SLIDE.default,
  transition: 'crossfade',
  motion: 'ken-burns',
  size: '1080p',
} as const satisfies SlideshowSettings;

/** `secondsPerSlide` clamped to the limits and rounded to the step. */
export function clampSecondsPerSlide(seconds: number): number {
  if (!Number.isFinite(seconds)) return SECONDS_PER_SLIDE.default;
  const stepped = Math.round(seconds / SECONDS_PER_SLIDE.step) * SECONDS_PER_SLIDE.step;
  return Math.min(SECONDS_PER_SLIDE.max, Math.max(SECONDS_PER_SLIDE.min, stepped));
}

/** The video's file name: the slideshow's name as a slug, `.mp4` (`slideshow.mp4` for a name with no letters). */
export function videoFileName(name: string): string {
  // `slugify` falls back to "book" for a name with nothing to keep.
  const slug = slugify(name);
  return `${slug === 'book' && !/book/i.test(name) ? 'slideshow' : slug}.mp4`;
}

/** "1:20" for 80 seconds (minutes and seconds, rounded up to the second). */
export function formatDuration(seconds: number): string {
  const whole = Math.ceil(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
