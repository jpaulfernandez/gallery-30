import { useEffect, useRef, useState } from 'react';

/** The `slow` duration token in ms, as the stylesheet has it now (0 under reduced motion, and where none is loaded). */
export function slowDurationMs(): number {
  if (typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : n;
}

/** The last number each remembered count showed, so a count that mounts again (a route switch) does not recount. */
const lastShown = new Map<string, number>();

/**
 * Plan 45: a count that counts up (ODDHALLS_LAYOUT_PLAN 6, *Opening*): from 0 when it first shows, then from the last
 * number to the new one, over the `slow` duration token (so reduced motion shows the number at once). Mono, tabular.
 * With `memoryKey` it starts from what it last showed under that key, so it counts up once per session, not per mount.
 */
export function CountUp({
  value,
  memoryKey,
  className = '',
}: {
  value: number;
  memoryKey?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(() => {
    if (memoryKey !== undefined && lastShown.has(memoryKey)) return lastShown.get(memoryKey) ?? value;
    return slowDurationMs() > 0 ? 0 : value;
  });
  const from = useRef(shown);
  const key = useRef(memoryKey);
  key.current = memoryKey;
  const show = (n: number) => {
    from.current = n;
    if (key.current !== undefined) lastShown.set(key.current, n);
    setShown(n);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `show` only writes refs and state
  useEffect(() => {
    const ms = slowDurationMs();
    const start = from.current;
    if (ms <= 0 || start === value) {
      show(value);
      return;
    }
    const t0 = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - t0) / ms);
      // The token easing's shape, roughly: fast out, slow in.
      const eased = 1 - (1 - k) ** 3;
      show(Math.round(start + (value - start) * eased));
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className={`font-mono tabular-nums ${className}`}>{shown}</span>;
}
