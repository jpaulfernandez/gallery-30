// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FILMSTRIP, DEFAULT_UI_PREFS, loadUiPrefs, UI_PREF_KEYS, useUiStore } from './ui';

afterEach(() => {
  localStorage.clear();
  useUiStore.setState(DEFAULT_UI_PREFS);
  useUiStore.getState().reset();
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
    expect(loadUiPrefs()).toEqual({ ...DEFAULT_UI_PREFS, showGrid: true, snapEnabled: false, leftTab: 'layouts' });
  });

  it('persist the rulers and the drag guides prefs (workflow plan 31)', () => {
    expect(DEFAULT_UI_PREFS.showRulers).toBe(true);
    expect(DEFAULT_UI_PREFS.showGuidesWhileDragging).toBe(true);
    useUiStore.getState().setPref('showRulers', false);
    useUiStore.getState().setPref('showGuidesWhileDragging', false);
    useUiStore.getState().reset();
    expect(useUiStore.getState().showRulers).toBe(false);
    expect(localStorage.getItem(UI_PREF_KEYS.showRulers)).toBe('false');
    expect(localStorage.getItem(UI_PREF_KEYS.showGuidesWhileDragging)).toBe('false');
    expect(loadUiPrefs()).toEqual({ ...DEFAULT_UI_PREFS, showRulers: false, showGuidesWhileDragging: false });
  });

  it('fall back to the defaults for missing or garbage values', () => {
    localStorage.setItem(UI_PREF_KEYS.leftTab, 'nope');
    expect(loadUiPrefs()).toEqual(DEFAULT_UI_PREFS);
  });
});

describe('filmstrip view', () => {
  it('keeps search, filters and scroll until reset() (a new book)', () => {
    useUiStore.getState().setFilmstrip({ query: 'dscf', hideUsed: true, minRating: 3, scrollTop: 840 });
    useUiStore.getState().setPref('leftTab', 'layouts');
    useUiStore.getState().setPref('leftTab', 'photos');
    expect(useUiStore.getState().filmstrip).toMatchObject({
      query: 'dscf',
      hideUsed: true,
      minRating: 3,
      scrollTop: 840,
    });
    useUiStore.getState().reset();
    expect(useUiStore.getState().filmstrip).toEqual(DEFAULT_FILMSTRIP);
  });
});

describe('review session', () => {
  it('opens at a clamped index, steps within the list and reveals the last photo on close', () => {
    const ui = () => useUiStore.getState();
    ui().openReview([]);
    expect(ui().review).toBeNull();
    ui().openReview(['a', 'b', 'c'], 7);
    expect(ui().review).toEqual({ ids: ['a', 'b', 'c'], index: 2 });
    ui().setReviewIndex(-3);
    expect(ui().review?.index).toBe(0);
    ui().setReviewIndex(1);
    ui().closeReview();
    expect(ui().review).toBeNull();
    expect(ui().filmstrip.reveal).toBe('b');
  });
});

describe('develop session', () => {
  const ui = () => useUiStore.getState();

  it('opens at a clamped index, steps within the list and reveals the last photo on close', () => {
    ui().openDevelop([]);
    expect(ui().develop).toBeNull();
    ui().openDevelop(['a', 'b', 'c'], 7);
    expect(ui().develop).toEqual({ ids: ['a', 'b', 'c'], index: 2 });
    ui().setDevelopIndex(-3);
    expect(ui().develop?.index).toBe(0);
    ui().setDevelopIndex(1);
    ui().setDevelopIndex(1);
    expect(ui().develop?.index).toBe(1);
    ui().closeDevelop();
    expect(ui().develop).toBeNull();
    expect(ui().filmstrip.reveal).toBe('b');
    // Stepping with no session open does nothing.
    ui().setDevelopIndex(2);
    expect(ui().develop).toBeNull();
  });

  it('keeps the asset order fixed while open', () => {
    const ids = ['a', 'b', 'c'];
    ui().openDevelop(ids, 1);
    ui().setDevelopIndex(2);
    expect(ui().develop?.ids).toBe(ids);
  });

  it('replaces review, and starts every session on the edit, not the original', () => {
    ui().openReview(['a', 'b'], 1);
    ui().openDevelop(['a', 'b'], 1);
    expect(ui().review).toBeNull();
    expect(ui().develop).toEqual({ ids: ['a', 'b'], index: 1 });
    ui().setDevelopBeforeAfter(true);
    expect(ui().developBeforeAfter).toBe(true);
    ui().closeDevelop();
    expect(ui().developBeforeAfter).toBe(false);
    ui().openDevelop(['a']);
    expect(ui().developBeforeAfter).toBe(false);
  });

  it('is cleared when a new book opens', () => {
    ui().openDevelop(['a', 'b']);
    ui().setDevelopBeforeAfter(true);
    ui().reset();
    expect(ui().develop).toBeNull();
    expect(ui().developBeforeAfter).toBe(false);
  });
});
