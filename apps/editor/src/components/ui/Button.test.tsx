// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, buttonClass, IconButton } from './Button';
import { TOOLTIP_DELAY_MS } from './Tooltip';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Button', () => {
  it('draws each variant from tokens, 6 px radius, with a press and a focus ring', () => {
    expect(buttonClass({ variant: 'primary' })).toMatch(/bg-accent .*text-accent-ink/);
    expect(buttonClass({ variant: 'soft' })).toContain('bg-fg/6');
    expect(buttonClass({ variant: 'ghost' })).toContain('hover:bg-fg/6');
    expect(buttonClass({ variant: 'danger' })).toContain('text-danger');
    expect(buttonClass({ variant: 'toggle', pressed: true })).toContain('bg-accent-soft text-accent');
    for (const v of ['primary', 'soft', 'ghost', 'danger', 'toggle'] as const) {
      const c = buttonClass({ variant: v });
      expect(c).toContain('rounded-sm');
      expect(c).toContain('active:translate-y-[0.5px]');
      expect(c).toContain('focus-visible:ring-offset-2');
      expect(c).toContain('disabled:opacity-40');
      expect(c).not.toMatch(/border-line/);
    }
    expect(buttonClass({ size: 'md' })).toContain('h-7');
    expect(buttonClass({ size: 'sm' })).toContain('h-6');
    expect(buttonClass({ size: 'sm', iconOnly: true })).toContain('size-6');
  });

  it('has a 32 px lg size and a pill shape (plan 48)', () => {
    expect(buttonClass({ size: 'lg' })).toContain('h-8');
    expect(buttonClass({ size: 'lg', iconOnly: true })).toContain('size-8');
    const pill = buttonClass({ shape: 'pill' });
    expect(pill).toContain('rounded-pill');
    expect(pill).not.toContain('rounded-sm');
    render(<IconButton label="Zoom in" size="lg" shape="pill" icon={<span>+</span>} />);
    const button = screen.getByRole('button', { name: 'Zoom in' });
    expect(button.className).toContain('size-8');
    expect(button.className).toContain('rounded-pill');
  });

  it('is a type="button" by default, runs on click, and not when disabled', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button onClick={onClick}>Export</Button>
        <Button onClick={onClick} disabled>
          Off
        </Button>
        <form onSubmit={(e) => e.preventDefault()}>
          <Button type="submit">Save</Button>
        </form>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button.getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit');
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a toggle says whether it is on', () => {
    const { rerender } = render(
      <Button variant="toggle" pressed={false}>
        Crop
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Crop' }).getAttribute('aria-pressed')).toBe('false');
    rerender(
      <Button variant="toggle" pressed>
        Crop
      </Button>,
    );
    const on = screen.getByRole('button', { name: 'Crop' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.className).toContain('text-accent');
    render(<Button>Plain</Button>);
    expect(screen.getByRole('button', { name: 'Plain' }).hasAttribute('aria-pressed')).toBe(false);
  });
});

describe('IconButton and Tooltip', () => {
  it('is named by its label and shows the tooltip with the shortcut after 600 ms of hover', () => {
    vi.useFakeTimers();
    render(<IconButton icon={<svg />} label="Undo" shortcut="⌘Z" />);
    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.pointerEnter(button.parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Undo⌘Z');
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.pointerLeave(button.parentElement as HTMLElement);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows at once on keyboard focus and hides on Escape and blur', () => {
    render(<IconButton icon={<svg />} label="Redo" shortcut="⇧⌘Z" />);
    const button = screen.getByRole('button', { name: 'Redo' });
    // A key first: the focus that follows is the keyboard's (a click's focus shows nothing).
    fireEvent.pointerDown(document.body);
    act(() => button.focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => button.blur());
    fireEvent.keyDown(document.body, { key: 'Tab' });
    act(() => button.focus());
    expect(screen.getByRole('tooltip').textContent).toBe('Redo⇧⌘Z');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => button.blur());
    act(() => button.focus());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => button.blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
