// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast, ToastHost, toast, useToasts } from './Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  vi.useRealTimers();
});

describe('toast and ToastHost', () => {
  it('stacks bottom-left, closes after 6 s, and calls onClose once', () => {
    const onClose = vi.fn();
    render(<ToastHost />);
    act(() => {
      toast.show({ text: 'Saved to the Desktop.', onClose });
      toast.show({ text: 'Second' });
    });
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual([
      expect.stringContaining('Saved to the Desktop.'),
      expect.stringContaining('Second'),
    ]);
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.getAllByRole('status')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('pauses while hovered and resumes with the time it had left (at least 1.5 s)', () => {
    render(<ToastHost />);
    act(() => void toast.show({ text: 'Hover me' }));
    act(() => vi.advanceTimersByTime(5800));
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(1499));
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an action closes it and runs; a job toast stays, shows its ring and updates in place', () => {
    const undo = vi.fn();
    render(<ToastHost />);
    let id = 0;
    act(() => {
      toast.show({ text: 'Page is custom', actions: [{ label: 'Undo', run: undo }] });
      id = toast.show({ text: 'Exporting… 1/4', progress: 0.25, durationMs: null });
    });
    expect(document.querySelector('[data-progress="25"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Page is custom')).toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('Exporting… 1/4')).toBeTruthy();
    act(() => toast.update(id, { text: 'Exported 4 photos.', progress: undefined, done: true }));
    expect(screen.getByText('Exported 4 photos.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('draws its feeds (the export toasts) in the same stack', () => {
    render(
      <ToastHost>
        <Toast onDismiss={() => {}}>Exported 3 photos.</Toast>
      </ToastHost>,
    );
    act(() => void toast.show({ text: 'Another' }));
    const host = document.querySelector('[data-toast-host]');
    expect(host?.textContent).toContain('Exported 3 photos.');
    expect(host?.textContent).toContain('Another');
    expect(host?.className).toContain('bottom-3 left-3');
  });
});
