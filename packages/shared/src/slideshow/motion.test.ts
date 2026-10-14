import { describe, expect, it } from 'vitest';
import {
  FULL_FRAME,
  frameKey,
  kenBurnsCrop,
  planSlideshowFrames,
  type SlideshowFrame,
  slideSpan,
  slideshowFrameName,
  slideshowTiming,
} from './motion.js';
import { SLIDESHOW_FPS, SLIDESHOW_TRANSITIONS } from './settings.js';

const visible = (frame: SlideshowFrame) => frame.layers.map((l) => l.slide);

describe('slideshow frame plan', () => {
  it('has slides × seconds × fps frames, whatever the transition and motion', () => {
    for (const transition of SLIDESHOW_TRANSITIONS) {
      for (const motion of ['none', 'ken-burns'] as const) {
        for (const [slides, secondsPerSlide] of [
          [1, 4],
          [2, 1],
          [5, 3.5],
          [12, 4],
        ] as const) {
          const frames = planSlideshowFrames({ slides, secondsPerSlide, transition, motion });
          expect(frames).toHaveLength(slides * secondsPerSlide * SLIDESHOW_FPS);
          expect(slideshowTiming({ slides, secondsPerSlide, transition }).totalFrames).toBe(frames.length);
        }
      }
    }
  });

  it('has no frames without slides', () => {
    expect(planSlideshowFrames({ slides: 0, secondsPerSlide: 4, transition: 'crossfade', motion: 'none' })).toEqual([]);
  });

  it('caps a transition at half a slide and has none for one slide or a cut', () => {
    expect(slideshowTiming({ slides: 3, secondsPerSlide: 4, transition: 'crossfade' }).transitionFrames).toBe(24);
    expect(slideshowTiming({ slides: 3, secondsPerSlide: 1, transition: 'crossfade' }).transitionFrames).toBe(15);
    expect(slideshowTiming({ slides: 1, secondsPerSlide: 4, transition: 'crossfade' }).transitionFrames).toBe(0);
    expect(slideshowTiming({ slides: 3, secondsPerSlide: 4, transition: 'none' }).transitionFrames).toBe(0);
  });

  it('cuts on the slide boundary without a transition', () => {
    const frames = planSlideshowFrames({ slides: 3, secondsPerSlide: 2, transition: 'none', motion: 'none' });
    expect(frames.every((f) => f.layers.length === 1 && f.layers[0]?.opacity === 1)).toBe(true);
    expect(visible(frames[59] as SlideshowFrame)).toEqual([0]);
    expect(visible(frames[60] as SlideshowFrame)).toEqual([1]);
    expect(visible(frames[179] as SlideshowFrame)).toEqual([2]);
  });

  it('crossfades in the last frames of a slide, the new slide rising over the old', () => {
    const frames = planSlideshowFrames({ slides: 2, secondsPerSlide: 2, transition: 'crossfade', motion: 'none' });
    const T = 24;
    expect(visible(frames[60 - T - 1] as SlideshowFrame)).toEqual([0]);
    const fade = frames.slice(60 - T, 60);
    expect(fade.every((f) => f.layers.length === 2 && f.layers[0]?.slide === 0 && f.layers[1]?.slide === 1)).toBe(true);
    const opacities = fade.map((f) => f.layers[1]?.opacity ?? 0);
    expect(opacities[0]).toBeCloseTo(1 / (T + 1));
    expect(opacities.at(-1)).toBeCloseTo(T / (T + 1));
    for (let i = 1; i < opacities.length; i++) expect(opacities[i]).toBeGreaterThan(opacities[i - 1] as number);
    expect(frames[60]?.layers).toEqual([{ slide: 1, crop: FULL_FRAME, opacity: 1 }]);
  });

  it('dips to black: out to nothing, then the next slide in', () => {
    const frames = planSlideshowFrames({ slides: 2, secondsPerSlide: 2, transition: 'dip', motion: 'none' });
    const dip = frames.slice(36, 60);
    expect(dip.every((f) => f.layers.length === 1)).toBe(true);
    expect(dip.slice(0, 12).every((f) => f.layers[0]?.slide === 0)).toBe(true);
    expect(dip[11]?.layers[0]?.opacity).toBe(0);
    expect(dip.slice(12).every((f) => f.layers[0]?.slide === 1)).toBe(true);
    expect(dip[12]?.layers[0]?.opacity).toBeCloseTo(1 / 13);
  });

  it('moves a slide over every frame it shows in, transitions included', () => {
    const input = { slides: 3, secondsPerSlide: 2, transition: 'crossfade', motion: 'ken-burns' } as const;
    const timing = slideshowTiming(input);
    expect(slideSpan(timing, 'crossfade', 0)).toEqual([0, 59]);
    expect(slideSpan(timing, 'crossfade', 1)).toEqual([36, 119]);
    expect(slideSpan(timing, 'crossfade', 2)).toEqual([96, 179]);
    const frames = planSlideshowFrames(input);
    // Slide 1 first shows (under the fade) at its starting crop and last shows at its end crop.
    expect(frames[36]?.layers[1]?.crop).toEqual(kenBurnsCrop(1, 0));
    expect(frames[119]?.layers[0]?.crop).toEqual(kenBurnsCrop(1, 1));
    // Every crop of a held stretch differs from the one before (it keeps moving).
    for (let f = 61; f < 96; f++)
      expect(frameKey(frames[f] as SlideshowFrame)).not.toBe(frameKey(frames[f - 1] as SlideshowFrame));
  });

  it('keeps every Ken Burns crop inside the slide at the frame aspect', () => {
    for (let slide = 0; slide < 8; slide++) {
      for (let t = 0; t <= 1; t += 0.05) {
        const c = kenBurnsCrop(slide, t);
        expect(c.w).toBe(c.h);
        expect(c.w).toBeGreaterThan(0.85);
        expect(c.w).toBeLessThanOrEqual(1);
        expect(c.x).toBeGreaterThanOrEqual(0);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.x + c.w).toBeLessThanOrEqual(1 + 1e-6);
        expect(c.y + c.h).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
    // Consecutive slides move differently.
    expect(kenBurnsCrop(0, 1)).not.toEqual(kenBurnsCrop(1, 1));
  });

  it('gives held frames equal keys, so the renderer writes them once', () => {
    const frames = planSlideshowFrames({ slides: 2, secondsPerSlide: 1, transition: 'crossfade', motion: 'none' });
    expect(new Set(frames.map(frameKey)).size).toBe(2 + 15);
  });

  it('names frames for an FFmpeg image sequence', () => {
    expect(slideshowFrameName(0)).toBe('000001.jpg');
    expect(slideshowFrameName(2399)).toBe('002400.jpg');
  });
});
