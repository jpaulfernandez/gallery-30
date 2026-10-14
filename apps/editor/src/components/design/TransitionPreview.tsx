import type { SlideshowMotion, SlideshowTransition } from '@photobook/shared';

/**
 * A looping sketch of a slideshow's transition and motion (workflow plan 16): two tiles at the video's aspect, slide 1
 * then slide 2 and back, cut, crossfaded or dipped through black, zooming and panning when Ken Burns is on. Plain CSS
 * animations; still under `prefers-reduced-motion`. It shows the kind of change, not the slides themselves.
 */

const CSS = `
@keyframes pbss-b-none { 0%, 49.99% { opacity: 0 } 50%, 99.99% { opacity: 1 } 100% { opacity: 0 } }
@keyframes pbss-b-crossfade { 0%, 38% { opacity: 0 } 50%, 88% { opacity: 1 } 100% { opacity: 0 } }
@keyframes pbss-a-dip { 0%, 38% { opacity: 1 } 44%, 94% { opacity: 0 } 100% { opacity: 1 } }
@keyframes pbss-b-dip { 0%, 44% { opacity: 0 } 50%, 88% { opacity: 1 } 94%, 100% { opacity: 0 } }
@keyframes pbss-zoom { from { transform: scale(1) } to { transform: scale(1.15) } }
@keyframes pbss-pan { from { transform: scale(1.15) translateX(-5%) } to { transform: scale(1.15) translateX(5%) } }
@media (prefers-reduced-motion: reduce) { .pbss-preview * { animation: none !important } }
`;

const TILE_A = 'linear-gradient(135deg, #c2603b, #e8c27e)';
const TILE_B = 'linear-gradient(135deg, #4a6fd1, #8fd1c8)';

export function TransitionPreview({
  transition,
  motion,
  aspect,
  secondsPerSlide,
}: {
  transition: SlideshowTransition;
  motion: SlideshowMotion;
  /** Video width / height. */
  aspect: number;
  secondsPerSlide: number;
}) {
  // Two slides per loop, kept between 3 and 8 seconds so the change is easy to watch.
  const period = Math.min(8, Math.max(3, secondsPerSlide * 2));
  const loop = `${period}s linear infinite`;
  const half = `${period / 2}s linear infinite alternate`;
  const a = transition === 'dip' ? `pbss-a-dip ${loop}` : undefined;
  const b = `pbss-b-${transition} ${loop}`;
  const kb = (name: string) => (motion === 'ken-burns' ? `${name} ${half}` : undefined);
  const tile = (background: string, label: string, move?: string) => (
    <div
      className="flex size-full items-center justify-center font-medium text-lg text-fg/80"
      style={{ background, animation: move }}
    >
      {label}
    </div>
  );
  return (
    <div
      className="pbss-preview relative mx-auto max-w-full overflow-hidden rounded-md bg-stage"
      style={{ aspectRatio: String(aspect), height: 132 }}
      role="img"
      aria-label={`Preview: ${transition === 'none' ? 'cut' : transition === 'dip' ? 'dip to black' : 'crossfade'}${motion === 'ken-burns' ? ' with Ken Burns motion' : ''}`}
    >
      <style>{CSS}</style>
      <div className="absolute inset-0 overflow-hidden" style={{ animation: a }}>
        {tile(TILE_A, '1', kb('pbss-zoom'))}
      </div>
      <div className="absolute inset-0 overflow-hidden" style={{ animation: b }}>
        {tile(TILE_B, '2', kb('pbss-pan'))}
      </div>
    </div>
  );
}
