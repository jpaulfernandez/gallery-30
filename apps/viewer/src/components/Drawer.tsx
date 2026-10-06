import { useEffect, useRef } from 'preact/hooks';
import { PagePanel, type PagePanelProps } from './PagePanel';

/** Drag the sheet down this far (px) to close it. */
const CLOSE_DRAG = 80;

/**
 * Phones (< 901 px): the bottom sheet behind the handle and the photos pill, holding the current
 * page's photos, likes, Share page and the collection badge. Tap the backdrop, press Escape or drag
 * the grabber down to close. Loaded on demand (dynamic import in `Reader`).
 */
export default function Drawer({
  onClose,
  covered = false,
  ...panel
}: PagePanelProps & { onClose: () => void; covered?: boolean }) {
  const sheet = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);

  useEffect(() => {
    sheet.current?.focus();
  }, []);

  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, covered]);

  const setOffset = (dy: number, animate: boolean) => {
    const el = sheet.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (t) drag.current = { y: t.clientY, dy: 0 };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!drag.current || !t) return;
    drag.current.dy = Math.max(0, t.clientY - drag.current.y);
    setOffset(drag.current.dy, false);
  };
  const onTouchEnd = () => {
    const dy = drag.current?.dy ?? 0;
    drag.current = null;
    if (dy > CLOSE_DRAG) onClose();
    else setOffset(0, true);
  };

  return (
    <div class="pv-sheet-wrap">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes (handled on window) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a pointer shortcut */}
      <div class="pv-sheet-backdrop" onClick={onClose} />
      <section ref={sheet} class="pv-sheet" role="dialog" aria-modal="true" aria-label="This page" tabIndex={-1}>
        <div
          class="pv-sheet-grab"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <button type="button" class="pv-sheet-grip" aria-label="Close" onClick={onClose}>
            <span />
          </button>
        </div>
        <div class="pv-sheet-body">
          <PagePanel {...panel} heading />
        </div>
      </section>
    </div>
  );
}
