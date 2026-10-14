// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUiPrefs, UI_PREF_KEYS, useUiStore } from '../../store/ui';
import { AppearancePanel } from './AppearancePanel';

afterEach(() => {
  cleanup();
  useUiStore.getState().setPref('haptics', true);
  localStorage.removeItem(UI_PREF_KEYS.haptics);
});

describe('Settings → Appearance → Haptics (plan 46)', () => {
  it('is on by default and switches off per machine', () => {
    expect(loadUiPrefs().haptics).toBe(true);
    render(<AppearancePanel />);
    const toggle = screen.getByRole('switch', { name: 'Haptics' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useUiStore.getState().haptics).toBe(false);
    expect(localStorage.getItem(UI_PREF_KEYS.haptics)).toBe('false');
    expect(loadUiPrefs().haptics).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
