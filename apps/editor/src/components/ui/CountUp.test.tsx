// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountUp, slowDurationMs } from './CountUp';

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--dur-slow');
  vi.useRealTimers();
});

describe('CountUp', () => {
  it('reads the slow duration token (0 when reduced motion zeroes it, or none is loaded)', () => {
    expect(slowDurationMs()).toBe(0);
    document.documentElement.style.setProperty('--dur-slow', '320ms');
    expect(slowDurationMs()).toBe(320);
    document.documentElement.style.setProperty('--dur-slow', '0.5s');
    expect(slowDurationMs()).toBe(500);
  });

  it('shows the number at once without a duration', () => {
    render(<CountUp value={1284} />);
    expect(screen.getByText('1284').className).toContain('font-mono');
  });

  it('counts up from 0 over the token, then to each new number', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    document.documentElement.style.setProperty('--dur-slow', '320ms');
    const { container, rerender } = render(<CountUp value={100} />);
    expect(container.textContent).toBe('0');
    act(() => vi.advanceTimersByTime(160));
    const mid = Number(container.textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('100');
    rerender(<CountUp value={120} />);
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toBe('120');
  });

  it('with a memory key, a count that mounts again starts from what it last showed (no recount on a route switch)', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    document.documentElement.style.setProperty('--dur-slow', '320ms');
    const first = render(<CountUp value={58} memoryKey="folder:A" />);
    act(() => vi.advanceTimersByTime(400));
    expect(first.container.textContent).toBe('58');
    first.unmount();
    const again = render(<CountUp value={58} memoryKey="folder:A" />);
    expect(again.container.textContent).toBe('58');
    again.unmount();
    expect(render(<CountUp value={58} memoryKey="folder:B" />).container.textContent).toBe('0');
  });
});
