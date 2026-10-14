// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../store/ui';
import { SAVED_SHOWN_MS, SaveIndicator } from './SaveIndicator';

beforeEach(() => {
  vi.useFakeTimers();
  useUiStore.setState({ saveStatus: 'saved', saveError: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const status = () => screen.getByRole('status');
/** What the live region announces: its words outside the hidden visual copy. */
const announced = () => status().querySelector('.sr-only')?.textContent ?? '';
const visual = () => status().querySelector('[aria-hidden="true"]') as HTMLElement;

describe('SaveIndicator', () => {
  it('shows nothing at rest or while editing; "Saved" fades in after a write and out after 1.2 s', () => {
    render(<SaveIndicator />);
    expect(status().dataset.save).toBe('idle');
    expect(announced()).toBe('');
    expect(visual().className).toContain('opacity-0');
    act(() => useUiStore.getState().setSaveStatus('dirty'));
    act(() => useUiStore.getState().setSaveStatus('saving'));
    expect(status().dataset.save).toBe('idle');
    expect(announced()).toBe('');
    act(() => useUiStore.getState().setSaveStatus('saved'));
    expect(status().dataset.save).toBe('saved');
    expect(announced()).toBe('Saved');
    expect(visual().className).toContain('opacity-100');
    expect(visual().className).toContain('duration-slow');
    act(() => vi.advanceTimersByTime(SAVED_SHOWN_MS - 1));
    expect(status().dataset.save).toBe('saved');
    act(() => vi.advanceTimersByTime(1));
    expect(status().dataset.save).toBe('idle');
    expect(announced()).toBe('');
    expect(visual().className).toContain('opacity-0');
  });

  it('a failed save stays as a red "Not saved" with the reason on hover', () => {
    render(<SaveIndicator />);
    act(() => useUiStore.getState().setSaveStatus('error', 'Disk full'));
    expect(announced()).toBe('Not saved');
    expect(status().className).toContain('text-danger');
    expect(status().getAttribute('title')).toBe('Disk full');
    act(() => vi.advanceTimersByTime(10_000));
    expect(status().dataset.save).toBe('error');
    act(() => useUiStore.getState().setSaveStatus('saved'));
    expect(status().dataset.save).toBe('saved');
  });
});
