// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { undo, useBookStore } from '../../store/book';

vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));

const { BookSettings } = await import('./BookSettings');

function Bound() {
  const book = useBookStore((s) => s.book);
  return book ? <BookSettings book={book} /> : null;
}

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

describe('BookSettings output colour', () => {
  it('shows sRGB by default and switches the book to Display P3 in one undo step', () => {
    render(<Bound />);
    const select = screen.getByRole('combobox', { name: 'Output colour profile' }) as HTMLSelectElement;
    expect(select.value).toBe('srgb');
    expect([...select.options].map((o) => o.textContent)).toEqual(['sRGB', 'Display P3']);
    expect(screen.getByText(/sRGB is the web standard/)).toBeTruthy();

    fireEvent.change(select, { target: { value: 'display-p3' } });
    expect(useBookStore.getState().book?.outputProfile).toBe('display-p3');
    expect(select.value).toBe('display-p3');
    expect(screen.getByText(/browsers on sRGB screens convert/)).toBeTruthy();

    undo();
    expect(useBookStore.getState().book?.outputProfile).toBe('srgb');
  });

  it('ignores choosing the profile the book already has', () => {
    render(<Bound />);
    const before = useBookStore.temporal.getState().pastStates.length;
    useBookStore.getState().setOutputProfile('srgb');
    expect(useBookStore.temporal.getState().pastStates.length).toBe(before);
  });
});
