import { useEffect } from 'preact/hooks';
import { markGuideShown } from '../storage';

/**
 * First open on a device: three lines on how to read, over a dimmed page. Any tap, key or the
 * button dismisses it for good; it never shows again on that device. The reader keeps its
 * controls visible while this is open, so the counter the last line points at is on screen.
 */
export function Guide({
  touch,
  counter,
  onDismiss,
}: {
  touch: boolean;
  /** The page counter as shown, e.g. "8 / 13". */
  counter: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    markGuideShown();
    window.addEventListener('keydown', onDismiss, { once: true });
    return () => window.removeEventListener('keydown', onDismiss);
  }, [onDismiss]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap anywhere dismisses the overlay; keys are handled on window, the button is the keyboard path
    <div class="pv-guide" role="dialog" aria-label="How to read this book" onClick={onDismiss}>
      <div class="pv-guide-card">
        <ul class="pv-guide-list">
          <li>
            <GuideIcon kind="turn" />
            <span>
              {touch
                ? 'Swipe, or tap the left and right edges, to turn the page'
                : 'Use the arrows or your keyboard to turn the page'}
            </span>
          </li>
          <li>
            <GuideIcon kind="photo" />
            <span>Tap a photo to see it full size and download it</span>
          </li>
          <li>
            <GuideIcon kind="grid" />
            <span>
              Tap <strong>{counter}</strong> at the bottom to see every page
            </span>
          </li>
        </ul>
        <button type="button" class="pv-button" onClick={onDismiss}>
          Start reading
        </button>
      </div>
    </div>
  );
}

function GuideIcon({ kind }: { kind: 'turn' | 'photo' | 'grid' }) {
  const d =
    kind === 'turn'
      ? 'M4 12h16M14 6l6 6-6 6'
      : kind === 'photo'
        ? 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4'
        : 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z';
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
