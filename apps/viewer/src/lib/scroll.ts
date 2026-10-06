/**
 * Page turns: a horizontal scroll with a fixed ~250 ms ease-out (PRD), instead of the browser's
 * smooth scrolling whose duration varies by engine. Only one animation runs per element; a touch or
 * wheel on the track cancels it (see `cancelScroll`) so a swipe never fights the animation.
 */

export const TURN_MS = 250;

const running = new WeakMap<Element, number>();

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export function cancelScroll(el: Element): void {
  const id = running.get(el);
  if (id !== undefined) {
    cancelAnimationFrame(id);
    running.delete(el);
  }
}

export function animateScrollLeft(el: Element, target: number, duration = TURN_MS): void {
  cancelScroll(el);
  const from = el.scrollLeft;
  const delta = target - from;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (delta === 0 || reduced || duration <= 0) {
    el.scrollLeft = target;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    el.scrollLeft = t === 1 ? target : from + delta * easeOutCubic(t);
    if (t < 1) running.set(el, requestAnimationFrame(step));
    else running.delete(el);
  };
  running.set(el, requestAnimationFrame(step));
}
