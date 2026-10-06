import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

const MARGIN = 24;

/** Centers a fixed-size box (`width` x `height` CSS px) in the available space, scaling it down to fit. */
export function FitBox({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth - MARGIN * 2;
      const h = el.clientHeight - MARGIN * 2;
      if (w <= 0 || h <= 0) return;
      setScale(Math.min(1, w / width, h / height));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  return (
    <div ref={outer} className="flex min-h-0 w-full flex-1 items-center justify-center">
      <div style={{ width: width * scale, height: height * scale }}>
        <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  );
}
