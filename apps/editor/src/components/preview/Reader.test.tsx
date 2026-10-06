// @vitest-environment jsdom
import type { Book } from '@photobook/shared';
import { fixtureBook, fixtureResolve } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reader, type ReaderProps } from './Reader';

const N = fixtureBook.pages.length;
const scrollTo = vi.fn();

beforeAll(() => {
  // jsdom does no layout and has no Element.scrollTo: give the track the phone screen's size.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 393 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 852 });
  Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
});

beforeEach(() => scrollTo.mockClear());
afterEach(cleanup);

const renderReader = (book: Book = fixtureBook, props: Partial<ReaderProps> = {}) =>
  render(<Reader book={book} resolve={fixtureResolve} {...props} />);

const counter = () => screen.getByTestId('reader-counter').textContent;

describe('Reader', () => {
  it('shows the page counter', () => {
    renderReader();
    expect(counter()).toBe(`1 / ${N}`);
  });

  it('steps with the arrow keys and scrolls smoothly', () => {
    renderReader();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(counter()).toBe(`2 / ${N}`);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 393, behavior: 'smooth' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(counter()).toBe(`1 / ${N}`);
    // Clamped at the first page.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(counter()).toBe(`1 / ${N}`);
  });

  it('steps when the edge zones are clicked', () => {
    renderReader();
    const track = screen.getByTestId('reader-track');
    track.getBoundingClientRect = () => ({ left: 0, width: 393 }) as DOMRect;
    fireEvent.click(track, { clientX: 380 });
    expect(counter()).toBe(`2 / ${N}`);
    fireEvent.click(track, { clientX: 200 });
    expect(counter()).toBe(`2 / ${N}`);
    fireEvent.click(track, { clientX: 10 });
    expect(counter()).toBe(`1 / ${N}`);
  });

  it('opens the page grid from the counter, jumps on pick, and closes on Escape', () => {
    const onExit = vi.fn();
    renderReader(fixtureBook, { onExit });
    fireEvent.click(screen.getByTestId('reader-counter'));
    expect(within(screen.getByTestId('reader-grid')).getAllByTestId('grid-cell')).toHaveLength(N);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('reader-grid')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('reader-counter'));
    const last = within(screen.getByTestId('reader-grid')).getAllByTestId('grid-cell')[N - 1];
    expect(last).toBeDefined();
    if (last) fireEvent.click(last);
    expect(screen.queryByTestId('reader-grid')).toBeNull();
    expect(counter()).toBe(`${N} / ${N}`);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: (N - 1) * 393, behavior: 'instant' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('mounts only the current page and its neighbours', () => {
    const pages = [...fixtureBook.pages, ...fixtureBook.pages.map((p) => ({ ...p, id: `${p.id}-b` }))];
    const { container } = renderReader({ ...fixtureBook, pages });
    expect(container.querySelectorAll('.pb-page')).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(container.querySelectorAll('.pb-page')).toHaveLength(3);
  });

  it('opens on initialIndex, reports changes, and clamps', () => {
    const onIndexChange = vi.fn();
    renderReader(fixtureBook, { initialIndex: 99, onIndexChange });
    expect(counter()).toBe(`${N} / ${N}`);
    expect(onIndexChange).toHaveBeenLastCalledWith(N - 1);
  });

  it('settles from the scroll position', () => {
    vi.useFakeTimers();
    renderReader();
    const track = screen.getByTestId('reader-track');
    track.scrollLeft = 393 * 2;
    fireEvent.scroll(track);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    expect(counter()).toBe(`3 / ${N}`);
  });

  it('shows "No pages yet" for an empty book', () => {
    renderReader({ ...fixtureBook, pages: [] });
    expect(screen.getByText('No pages yet')).toBeTruthy();
    expect(screen.queryByTestId('reader-counter')).toBeNull();
  });
});
