// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopoverButton } from './Popover';

afterEach(cleanup);

function Menu({ onWindowKey }: { onWindowKey?: (e: KeyboardEvent) => void }) {
  if (onWindowKey) window.onkeydown = onWindowKey;
  return (
    <PopoverButton label="Menu" panelLabel="Menu panel">
      {() => (
        <div>
          <button type="button" disabled>
            Off
          </button>
          <button type="button">First</button>
          <button type="button">Second</button>
        </div>
      )}
    </PopoverButton>
  );
}

describe('PopoverButton', () => {
  it('focuses the first enabled control on open', () => {
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('keeps a child that took focus itself', () => {
    render(
      <PopoverButton label="Find" panelLabel="Find panel">
        {() => (
          <div>
            <button type="button">Clear</button>
            {/* biome-ignore lint/a11y/noAutofocus: the case under test */}
            <input aria-label="Query" autoFocus />
          </div>
        )}
      </PopoverButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Query' }));
  });

  it('closes on Escape with focus on the trigger, without the key reaching the window', () => {
    const onWindowKey = vi.fn();
    render(<Menu onWindowKey={onWindowKey} />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Menu panel' })).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Menu panel' })).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    window.onkeydown = null;
  });
});
