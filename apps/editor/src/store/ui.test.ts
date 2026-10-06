// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS, loadUiPrefs, UI_PREF_KEYS, useUiStore } from './ui';

afterEach(() => {
  localStorage.clear();
  useUiStore.setState(DEFAULT_UI_PREFS);
});

describe('UI prefs', () => {
  it('persist in localStorage and survive reset()', () => {
    useUiStore.getState().setPref('showGrid', true);
    useUiStore.getState().setPref('snapEnabled', false);
    useUiStore.getState().setPref('leftTab', 'layouts');
    expect(localStorage.getItem(UI_PREF_KEYS.showGrid)).toBe('true');
    expect(localStorage.getItem(UI_PREF_KEYS.snapEnabled)).toBe('false');
    expect(localStorage.getItem(UI_PREF_KEYS.leftTab)).toBe('layouts');
    useUiStore.getState().reset();
    expect(useUiStore.getState()).toMatchObject({ showGrid: true, snapEnabled: false, leftTab: 'layouts' });
    expect(loadUiPrefs()).toEqual({ showGrid: true, showMargins: true, snapEnabled: false, leftTab: 'layouts' });
  });

  it('fall back to the defaults for missing or garbage values', () => {
    localStorage.setItem(UI_PREF_KEYS.leftTab, 'nope');
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });
});
