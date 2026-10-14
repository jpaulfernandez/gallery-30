import { effectiveZoom, useUiStore, zoomedByUser } from '../store/ui';
import { type HapticKind, haptic } from './tauri';

/**
 * Plan 46: the haptic tick (ODDHALLS_UI_PLAN 4.3). One call per moment that should click: the slider detent, a frame
 * snapping to a guide on the canvas, the straighten angle at 0° (the Angle slider's detent), the canvas zoom reaching
 * Fit or 100 % (installed below), and from plan 55 the harmony-lock snaps. Nothing else calls it.
 *
 * Off when Settings → Appearance → Haptics is off (`ui.haptics`, per machine) or the system asks for reduced motion;
 * at most one tick per `HAPTIC_INTERVAL_MS`; outside Tauri (Vite alone, tests) it plays nothing. The Rust command
 * is itself a no-op without a Force Touch trackpad and off macOS.
 */

export type { HapticKind } from './tauri';

/** The shortest gap between two ticks, ms. */
export const HAPTIC_INTERVAL_MS = 80;

let last = Number.NEGATIVE_INFINITY;

const inTauri = (): boolean =>
  typeof window !== 'undefined' && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

/** The system's reduced-motion setting (no ticks and no springs under it). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Whether a tick would play now (the switch and reduced motion; not the rate limit). */
export function hapticsOn(): boolean {
  return useUiStore.getState().haptics && !prefersReducedMotion();
}

/**
 * Play one tick of `kind`. Returns whether it was let through (false when switched off, under reduced motion, or
 * within `HAPTIC_INTERVAL_MS` of the last one).
 */
export function tick(kind: HapticKind = 'generic'): boolean {
  if (!hapticsOn()) return false;
  const now = performance.now();
  if (now - last < HAPTIC_INTERVAL_MS) return false;
  last = now;
  if (inTauri()) haptic(kind).catch(() => {});
  return true;
}

/** Tests: forget the last tick so the rate limit starts over. */
export function resetHapticClock(): void {
  last = Number.NEGATIVE_INFINITY;
}

/**
 * The canvas zoom reaching Fit, or reaching or passing 100 %, ticks once (`levelChange`), when a person zoomed
 * (`setZoom` / `stepZoom`; a store reset to Fit on opening or closing a book does not). Installed once when this module
 * loads (the slider and the canvas snap import it), so the zoom controls themselves need no call; a hot reload drops
 * the old subscription.
 */
const unsubscribeZoom = useUiStore.subscribe((s, prev) => {
  if (s.zoom === prev.zoom || !zoomedByUser()) return;
  if (s.zoom === 'fit') {
    tick('levelChange');
    return;
  }
  const before = effectiveZoom(prev);
  if (s.zoom === 1 || (before - 1) * (s.zoom - 1) < 0) tick('levelChange');
});
// A module-level flag would not survive a hot reload (the module runs again), so the old listener is dropped here.
import.meta.hot?.dispose(unsubscribeZoom);
