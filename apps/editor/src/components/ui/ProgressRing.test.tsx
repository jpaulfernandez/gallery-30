// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressRing } from './ProgressRing';

afterEach(cleanup);

describe('ProgressRing', () => {
  it('is a 16 px progressbar with its percentage, clamped', () => {
    render(
      <>
        <ProgressRing value={0.344} label="Denoise" />
        <ProgressRing value={1.7} label="Over" />
      </>,
    );
    const ring = screen.getByRole('progressbar', { name: 'Denoise' });
    expect(ring.getAttribute('aria-valuenow')).toBe('34');
    expect(ring.style.width).toBe('16px');
    expect(screen.getByRole('progressbar', { name: 'Over' }).getAttribute('aria-valuenow')).toBe('100');
  });

  it('is busy without a value (no number), full with a check when done, decorative without a label', () => {
    const { container } = render(
      <>
        <ProgressRing label="Busy" />
        <ProgressRing done label="Done" />
        <ProgressRing value={0.5} />
      </>,
    );
    const busy = screen.getByRole('progressbar', { name: 'Busy' });
    expect(busy.hasAttribute('aria-valuenow')).toBe(false);
    expect(busy.dataset.progress).toBe('busy');
    const done = screen.getByRole('progressbar', { name: 'Done' });
    expect(done.getAttribute('aria-valuenow')).toBe('100');
    expect(done.querySelectorAll('svg')).toHaveLength(2);
    expect(container.querySelectorAll('[aria-hidden="true"][data-progress="50"]')).toHaveLength(1);
  });
});
