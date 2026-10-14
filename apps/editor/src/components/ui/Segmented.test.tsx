// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Segmented, SegmentedTrack } from './Segmented';

afterEach(cleanup);

function Zoom({ initial = 'fit' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Segmented
      label="Zoom"
      items={[
        { value: 'fit', label: 'Fit' },
        { value: '1', label: '1×' },
        { value: '2', label: '2×', disabled: true },
        { value: '4', label: '4×' },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

const pressed = () => screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;

describe('Segmented', () => {
  it('marks the chosen item pressed and draws the indicator under it', () => {
    const { container } = render(<Zoom />);
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeTruthy();
    expect(pressed()).toBe('Fit');
    expect(container.querySelector('[data-segment-indicator]')).not.toBeNull();
    expect(container.querySelector('[data-segment-active]')?.textContent).toBe('Fit');
    fireEvent.click(screen.getByRole('button', { name: '4×' }));
    expect(pressed()).toBe('4×');
    expect(container.querySelector('[data-segment-active]')?.textContent).toBe('4×');
  });

  it('keeps one Tab stop and moves with the arrows, Home and End, skipping disabled items', () => {
    render(<Zoom />);
    const tabbable = screen.getAllByRole('button').filter((b) => b.tabIndex === 0);
    expect(tabbable.map((b) => b.textContent)).toEqual(['Fit']);
    const fit = screen.getByRole('button', { name: 'Fit' });
    fit.focus();
    fireEvent.keyDown(fit, { key: 'ArrowRight' });
    expect(pressed()).toBe('1×');
    expect(document.activeElement?.textContent).toBe('1×');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(pressed()).toBe('4×');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(pressed()).toBe('Fit');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(pressed()).toBe('4×');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(pressed()).toBe('Fit');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(pressed()).toBe('4×');
    expect((screen.getByRole('button', { name: '2×' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a track around links marks the active one for the indicator', () => {
    const { container } = render(
      <SegmentedTrack as="nav" aria-label="Stages" activeKey="develop">
        <a href="#c">Cull</a>
        <a href="#d" data-segment-active>
          Develop
        </a>
      </SegmentedTrack>,
    );
    expect(screen.getByRole('navigation', { name: 'Stages' })).toBeTruthy();
    expect(container.querySelector('[data-segment-indicator]')).not.toBeNull();
  });
});
