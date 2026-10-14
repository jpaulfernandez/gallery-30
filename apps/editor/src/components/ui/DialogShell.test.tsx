// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogBody, DialogButton, DialogFooter, DialogShell, dialogOpen } from './DialogShell';

afterEach(cleanup);

function Sync({ onClose }: { onClose: () => void }) {
  return (
    <DialogShell title="Sync settings" onClose={onClose}>
      <DialogBody>
        <input aria-label="Name" data-autofocus />
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary>Sync 12 photos</DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

describe('DialogShell', () => {
  it('is a modal on panel-2 with a 12 px radius and the 15 px title; the primary is the accent button', () => {
    render(<Sync onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Sync settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.className).toContain('bg-panel-2');
    expect(dialog.className).toContain('rounded-lg');
    expect(screen.getByRole('heading', { name: 'Sync settings' }).className).toContain('text-[15px]');
    expect(screen.getByRole('button', { name: 'Sync 12 photos' }).className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('bg-fg/6');
    expect(dialogOpen()).toBe(true);
  });

  it('focuses the autofocus field, keeps Tab inside, closes on Escape and gives the focus back', () => {
    const onClose = vi.fn();
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { unmount } = render(<Sync onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    const last = screen.getByRole('button', { name: 'Sync 12 photos' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });
});
