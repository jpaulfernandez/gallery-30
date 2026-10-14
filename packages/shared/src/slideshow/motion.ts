import {
  KEN_BURNS_ZOOM,
  SLIDESHOW_FPS,
  type SlideshowMotion,
  type SlideshowTransition,
  TRANSITION_SECONDS,
} from './settings.js';

/**
 * The frame plan of a slideshow video (workflow plan 16): which slides every output frame shows, how opaque each is
 * and which part of it (the Ken Burns crop). Pure and deterministic, so the CLI renders exactly what the tests check:
 * no video compositor, every frame is a still the page renderer draws (`packages/publish/src/slideshow.ts`).
 *
 * Timing: each slide owns `framesPerSlide = round(secondsPerSlide × fps)` frames and the video has
 * `slides × framesPerSlide` frames, so a transition never lengthens it: the change from slide i to i + 1 takes the last
 * `transitionFrames` of slide i's time. A slide moves (Ken Burns) over every frame it is visible in, transitions
 * included, so the motion never stops while it fades.
 */

/** A part of the video frame, in fractions of it (Ken Burns keeps the frame's aspect: `w === h`). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One slide drawn into a frame: `crop` of it scaled to fill the frame, at `opacity` over what is below. */
export interface FrameLayer {
  /** 0-based slide index. */
  slide: number;
  crop: CropRect;
  opacity: number;
}

/** One output frame: its layers composited in order over black. */
export interface SlideshowFrame {
  layers: FrameLayer[];
}

export interface SlideshowTiming {
  fps: number;
  slides: number;
  framesPerSlide: number;
  transitionFrames: number;
  /** `slides × framesPerSlide`. */
  totalFrames: number;
  /** `totalFrames / fps`. */
  seconds: number;
}

export interface SlideshowPlanInput {
  slides: number;
  secondsPerSlide: number;
  transition: SlideshowTransition;
  motion: SlideshowMotion;
  fps?: number;
}

/** The whole frame. */
export const FULL_FRAME: CropRect = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

export function slideshowTiming({
  slides,
  secondsPerSlide,
  transition,
  fps = SLIDESHOW_FPS,
}: Omit<SlideshowPlanInput, 'motion'>): SlideshowTiming {
  const n = Math.max(0, Math.floor(slides));
  const framesPerSlide = Math.max(1, Math.round(secondsPerSlide * fps));
  const transitionFrames =
    transition === 'none' || n < 2 ? 0 : Math.min(Math.round(TRANSITION_SECONDS * fps), Math.floor(framesPerSlide / 2));
  const totalFrames = n * framesPerSlide;
  return { fps, slides: n, framesPerSlide, transitionFrames, totalFrames, seconds: totalFrames / fps };
}

/** A Ken Burns key: zoom (1 = the whole slide) and where the crop sits in the room left over (0..1, 0.5 centred). */
interface MotionKey {
  zoom: number;
  px: number;
  py: number;
}

const Z = KEN_BURNS_ZOOM;

/**
 * The moves, used in turn (slide i takes move i mod 4), so consecutive slides never move the same way: a slow push in
 * drifting up, a pan left to right, a pull out, a pan right to left drifting down.
 */
const KEN_BURNS_MOVES: ReadonlyArray<{ from: MotionKey; to: MotionKey }> = [
  { from: { zoom: 1, px: 0.5, py: 0.5 }, to: { zoom: Z, px: 0.5, py: 0.35 } },
  { from: { zoom: Z, px: 0.1, py: 0.5 }, to: { zoom: Z, px: 0.9, py: 0.5 } },
  { from: { zoom: Z, px: 0.5, py: 0.65 }, to: { zoom: 1, px: 0.5, py: 0.5 } },
  { from: { zoom: Z, px: 0.9, py: 0.4 }, to: { zoom: Z, px: 0.1, py: 0.6 } },
];

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * The Ken Burns crop of slide `slide` at progress `t` (0 when it first shows, 1 when it last shows). The zoom changes
 * geometrically (constant speed to the eye), the position linearly within the room the zoom leaves, so the crop never
 * leaves the slide.
 */
export function kenBurnsCrop(slide: number, t: number): CropRect {
  const move = KEN_BURNS_MOVES[((slide % KEN_BURNS_MOVES.length) + KEN_BURNS_MOVES.length) % KEN_BURNS_MOVES.length];
  if (!move) return FULL_FRAME;
  const p = Math.min(1, Math.max(0, t));
  const zoom = move.from.zoom * (move.to.zoom / move.from.zoom) ** p;
  const px = move.from.px + (move.to.px - move.from.px) * p;
  const py = move.from.py + (move.to.py - move.from.py) * p;
  const size = 1 / zoom;
  return { x: round6((1 - size) * px), y: round6((1 - size) * py), w: round6(size), h: round6(size) };
}

/** The crop of slide `slide` at progress `t` for `motion`. */
export function motionCrop(motion: SlideshowMotion, slide: number, t: number): CropRect {
  return motion === 'ken-burns' ? kenBurnsCrop(slide, t) : FULL_FRAME;
}

/** First and last frame (inclusive) slide `i` is visible in. */
export function slideSpan(timing: SlideshowTiming, transition: SlideshowTransition, i: number): [number, number] {
  const { framesPerSlide: S, transitionFrames: T, slides: n } = timing;
  const [fadeOut, fadeIn] = transitionSplit(transition, T);
  // Slide i's own time is [i S, (i + 1) S); the transition into it starts `fadeIn` frames before, the one out of it
  // ends `T - fadeOut` frames before its time does (a dip's black frames belong to neither).
  const start = i === 0 ? 0 : i * S - fadeIn;
  const end = i === n - 1 ? n * S - 1 : (i + 1) * S - T + fadeOut - 1;
  return [start, end];
}

/** Frames of a transition spent fading the old slide out and the new one in (a crossfade does both at once). */
function transitionSplit(transition: SlideshowTransition, T: number): [fadeOut: number, fadeIn: number] {
  if (transition === 'dip') {
    const out = Math.ceil(T / 2);
    return [out, T - out];
  }
  return [T, T];
}

/**
 * Every output frame of a slideshow of `slides` slides, in order (`slideshowTiming(...).totalFrames` of them). A frame's
 * layers are composited over black: a held slide is one opaque layer, a crossfade the old slide under the new one at
 * rising opacity, a dip one slide fading to black and the next fading in.
 */
export function planSlideshowFrames(input: SlideshowPlanInput): SlideshowFrame[] {
  const timing = slideshowTiming(input);
  const { framesPerSlide: S, transitionFrames: T, slides: n, totalFrames } = timing;
  const [fadeOut, fadeIn] = transitionSplit(input.transition, T);
  const spans = Array.from({ length: n }, (_, i) => slideSpan(timing, input.transition, i));
  const layer = (slide: number, f: number, opacity: number): FrameLayer => {
    const [start, end] = spans[slide] as [number, number];
    const t = end > start ? (f - start) / (end - start) : 0;
    return { slide, crop: motionCrop(input.motion, slide, t), opacity: round6(opacity) };
  };

  const frames: SlideshowFrame[] = [];
  for (let f = 0; f < totalFrames; f++) {
    const i = Math.floor(f / S);
    // Frames into the transition at the end of slide i's time (negative before it starts).
    const k = f - ((i + 1) * S - T);
    if (T === 0 || i === n - 1 || k < 0) {
      frames.push({ layers: [layer(i, f, 1)] });
    } else if (input.transition === 'dip') {
      frames.push({
        layers:
          k < fadeOut ? [layer(i, f, 1 - (k + 1) / fadeOut)] : [layer(i + 1, f, (k - fadeOut + 1) / (fadeIn + 1))],
      });
    } else {
      frames.push({ layers: [layer(i, f, 1), layer(i + 1, f, (k + 1) / (T + 1))] });
    }
  }
  return frames;
}

/**
 * A key equal for frames that look the same (same slides, crops and opacities), so the renderer can write a held
 * still once and link the rest.
 */
export function frameKey(frame: SlideshowFrame): string {
  return frame.layers.map((l) => `${l.slide}:${l.opacity}:${l.crop.x},${l.crop.y},${l.crop.w},${l.crop.h}`).join('|');
}

/** The file name of output frame `index` (0-based) in the frame folder: `000001.jpg` (FFmpeg reads `%06d.jpg`). */
export function slideshowFrameName(index: number): string {
  return `${String(index + 1).padStart(6, '0')}.jpg`;
}
