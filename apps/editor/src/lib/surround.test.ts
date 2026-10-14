// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS, loadUiPrefs, UI_PREF_KEYS, useUiStore } from '../store/ui';
import { applySurround, installSurround } from './surround';

afterEach(() => {
  localStorage.clear();
  useUiStore.setState({ surround: DEFAULT_UI_PREFS.surround });
  document.documentElement.style.removeProperty('--color-surround');
});

describe('surround', () => {
  it('sets --color-surround on the root, and black clears it', () => {
    const root = document.documentElement;
    applySurround('charcoal');
    expect(root.style.getPropertyValue('--color-surround')).toBe('oklch(0.27 0 0)');
    applySurround('mid');
    expect(root.style.getPropertyValue('--color-surround')).toBe('var(--color-stage-mid)');
    applySurround('black');
    expect(root.style.getPropertyValue('--color-surround')).toBe('');
    expect(root.style.getPropertyValue('--color-stage')).toBe('');
  });

  it('is a per-machine pref that follows the store', () => {
    expect(loadUiPrefs().surround).toBe('black');
    const stop = installSurround();
    useUiStore.getState().setPref('surround', 'mid');
    expect(localStorage.getItem(UI_PREF_KEYS.surround)).toBe('mid');
    expect(loadUiPrefs().surround).toBe('mid');
    expect(document.documentElement.style.getPropertyValue('--color-surround')).toBe('var(--color-stage-mid)');
    stop();
    localStorage.setItem(UI_PREF_KEYS.surround, 'purple');
    expect(loadUiPrefs().surround).toBe('black');
  });
});
