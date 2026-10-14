import { type Surround, useUiStore } from '../store/ui';

/**
 * Plan 44: the surround preference sets `--color-surround` on `:root`, the background of the photo wells
 * (`bg-surround`: Develop, the Review loupe, the Design desk, the Cull grid). `stage` itself never moves, so scrims
 * and chips over a photo stay black. Every value is achromatic. Black is the token's default (the stage,
 * `oklch(0.17 0 0)` in `styles.css`), so choosing it clears the override.
 */
export const SURROUND_COLOR: Record<Surround, string> = {
  black: 'oklch(0.17 0 0)',
  charcoal: 'oklch(0.27 0 0)',
  mid: 'var(--color-stage-mid)',
};

export const SURROUND_LABEL: Record<Surround, string> = {
  black: 'Black',
  charcoal: 'Charcoal',
  mid: 'Mid grey',
};

export function applySurround(surround: Surround, root: HTMLElement = document.documentElement): void {
  if (surround === 'black') root.style.removeProperty('--color-surround');
  else root.style.setProperty('--color-surround', SURROUND_COLOR[surround]);
}

/** Applies the stored surround now and on every change; returns the unsubscribe. */
export function installSurround(): () => void {
  applySurround(useUiStore.getState().surround);
  return useUiStore.subscribe((s, prev) => {
    if (s.surround !== prev.surround) applySurround(s.surround);
  });
}
