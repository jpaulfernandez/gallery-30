// @vitest-environment jsdom
import { emptyLibrary, type Library } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { libraryKeys } from '../../store/collections';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { ReviewMode } from '../review/ReviewMode';
import { PILL_CLEARANCE } from '../ui/Pill';
import { CullGrid } from './CullGrid';
import { CullStage, CullView, keepSelectionWithin } from './CullView';
import { assistKeyAction, CULL_KEYS, cullKeyAction } from './keys';

const ALT_OFF = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '' };

/**
 * Plan 47: a render counter for the grid's cells. Every `CullCell` render calls `useChanged` twice (its stars and its
 * flag) and nothing else in a mounted grid does, so the calls count the cell renders.
 */
const cellHooks = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./marks', async (original) => {
  const actual = await original<typeof import('./marks')>();
  return {
    ...actual,
    useChanged: <T,>(value: T, reset?: unknown) => {
      cellHooks.calls += 1;
      return actual.useChanged(value, reset);
    },
  };
});

const F = 'F1';
const SOURCE = { kind: 'folder', id: F } as const;
const key = (name: string) => photoKey({ folder: F, path: name });

const photo = (relPath: string, mtime: number): PhotoFile => ({
  relPath,
  size: 1,
  mtime,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  width: 1200,
  height: 800,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
  proxyUrl: `asset://c/${relPath}/proxy.jpg`,
});

/** Capture order differs from name order: by time b, d, a, e, c, f. */
const MTIMES: Record<string, number> = { 'a.jpg': 3, 'b.jpg': 1, 'c.jpg': 5, 'd.jpg': 2, 'e.jpg': 4, 'f.jpg': 6 };

function setFolder(photos: Record<string, number>, library: Library = emptyLibrary()) {
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: Object.fromEntries(Object.entries(photos).map(([name, mtime]) => [name, photo(name, mtime)])),
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': library } });
}

/** The keys the Cull stage would show for these filters. */
const keysFor = (view: Partial<typeof DEFAULT_FILMSTRIP> = {}) =>
  libraryKeys(SOURCE, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    ...view,
  });

const option = (name: string) => screen.getByRole('option', { name });
const selected = () => useUiStore.getState().selection.keys;
const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);
const ratingOf = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`]?.rating;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  useUiStore.setState({
    review: null,
    selection: EMPTY_SELECTION,
    cull: { columns: 5, view: 'grid', scrollTop: 0, grouped: true, showStars: false, expanded: null, zoom: 'fit' },
    reviewAutoAdvance: false,
  });
  setFolder(MTIMES);
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('Cull grid selection', () => {
  it('selects a Shift range from the anchor in the order shown, also after the sort changed', () => {
    const byTime = keysFor({ sort: 'time' });
    expect(byTime).toEqual(['b.jpg', 'd.jpg', 'a.jpg', 'e.jpg', 'c.jpg', 'f.jpg'].map(key));
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(byTime, 0));

    fireEvent.click(option('d.jpg'));
    expect(selected()).toEqual([key('d.jpg')]);
    fireEvent.click(option('e.jpg'), { shiftKey: true });
    expect(selected()).toEqual(['d.jpg', 'a.jpg', 'e.jpg'].map(key));

    // Sort by name: the anchor (d) stays; a Shift+click now spans the name order.
    const byName = keysFor({ sort: 'name' });
    act(() => useUiStore.getState().updateSessionIds('review', byName, byName.indexOf(key('e.jpg'))));
    fireEvent.click(option('f.jpg'), { shiftKey: true });
    expect(selected()).toEqual(['d.jpg', 'e.jpg', 'f.jpg'].map(key));
    expect(option('f.jpg').getAttribute('aria-selected')).toBe('true');
    expect(option('a.jpg').getAttribute('aria-selected')).toBe('false');

    // Cmd+click adds and removes one photo; Escape clears.
    fireEvent.click(option('a.jpg'), { metaKey: true });
    expect(selected()).toContain(key('a.jpg'));
    fireEvent.click(option('e.jpg'), { metaKey: true });
    expect(selected()).not.toContain(key('e.jpg'));
    press({ key: 'Escape' });
    expect(selected()).toEqual([]);
  });

  it('Cmd+A selects only what the filter shows', () => {
    const library = emptyLibrary();
    for (const name of ['a.jpg', 'c.jpg', 'e.jpg']) library.photos[`h-${name}`] = { flag: 'pick', versions: {} };
    setFolder(MTIMES, library);
    const picks = keysFor({ flag: 'picks' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(picks, 0));
    expect(screen.getAllByRole('option')).toHaveLength(3);
    press({ key: 'a', metaKey: true });
    expect([...selected()].sort()).toEqual(['a.jpg', 'c.jpg', 'e.jpg'].map(key));
  });

  it('arrows move the focus, Shift+arrows extend from the anchor, plain arrows collapse', () => {
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    press({ key: 'ArrowRight' });
    expect(useUiStore.getState().review?.index).toBe(1);
    expect(selected()).toEqual([]);
    press({ key: 'ArrowRight', shiftKey: true });
    press({ key: 'ArrowRight', shiftKey: true });
    expect(selected()).toEqual(['b.jpg', 'c.jpg', 'd.jpg'].map(key));
    // Down moves a row (5 columns), clamped to the last photo.
    press({ key: 'ArrowDown' });
    expect(useUiStore.getState().review?.index).toBe(5);
    expect(selected()).toEqual([key('f.jpg')]);
    press({ key: 'Home', shiftKey: true });
    expect(selected()).toHaveLength(6);
  });
});

describe('Cull grid batch rating and flags', () => {
  it('rates the whole selection in one library update, and nothing new to undo', () => {
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    fireEvent.click(option('a.jpg'));
    fireEvent.click(option('c.jpg'), { shiftKey: true });
    const past = useBookStore.temporal.getState().pastStates.length;
    let updates = 0;
    const stop = useBookStore.subscribe((s, prev) => {
      if (s.libraries !== prev.libraries) updates += 1;
    });
    press({ key: '3', code: 'Digit3' });
    press({ key: 'p' });
    stop();
    expect(updates).toBe(2);
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      expect(useBookStore.getState().libraries['/trip']?.photos[`h-${name}`]).toMatchObject({
        rating: 3,
        flag: 'pick',
      });
    }
    expect(ratingOf('d.jpg')).toBeUndefined();
    // Ratings and flags are never undo steps in this code base (`reviewAssets`): the batch adds none.
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);
    // A batch does not advance; the focus stays on the photo clicked last.
    expect(useUiStore.getState().review?.index).toBe(2);
  });

  it('rates the focused photo when nothing is selected, and auto-advances like Review', () => {
    useUiStore.setState({ reviewAutoAdvance: true });
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 1));
    press({ key: '5', code: 'Digit5' });
    expect(ratingOf('b.jpg')).toBe(5);
    expect(useUiStore.getState().review?.index).toBe(2);
    press({ key: '0', code: 'Digit0', shiftKey: true });
    expect(ratingOf('c.jpg')).toBeUndefined();
    expect(useUiStore.getState().review?.index).toBe(2);
  });

  it('J and K change the columns within 3 to 8', () => {
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    press({ key: 'k' });
    expect(useUiStore.getState().cull.columns).toBe(4);
    for (let i = 0; i < 6; i += 1) press({ key: 'j' });
    expect(useUiStore.getState().cull.columns).toBe(8);
    press({ key: '=', metaKey: true });
    expect(useUiStore.getState().cull.columns).toBe(7);
  });
});

describe('Cull grid and Review', () => {
  it('Space opens Review at the focused photo and Escape comes back at the same scroll', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) many[`p${String(i).padStart(2, '0')}.jpg`] = i;
    setFolder(many);
    const ids = keysFor();
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, 0));
    const grid = screen.getByRole('listbox', { name: 'Photos' });
    fireEvent.click(option('p16.jpg'));
    act(() => {
      grid.scrollTop = 120;
      fireEvent.scroll(grid);
    });
    expect(useUiStore.getState().cull.scrollTop).toBe(120);

    press({ key: ' ' });
    expect(screen.getByRole('region', { name: 'One: p16.jpg' })).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    // Review keys work there; Escape is back to the grid.
    press({ key: 'p' });
    expect(useBookStore.getState().libraries['/trip']?.photos['h-p16.jpg']?.flag).toBe('pick');
    press({ key: 'Escape' });
    const back = screen.getByRole('listbox', { name: 'Photos' });
    expect(back.scrollTop).toBe(120);
    // Plan 47: the focused cell is the listbox's active descendant (the grid draws one sliding focus ring).
    expect(screen.getByRole('listbox', { name: 'Photos' }).getAttribute('aria-activedescendant')).toBe(
      option('p16.jpg').id,
    );
    expect(useUiStore.getState().review?.index).toBe(16);
  });

  it('handles every key Review handles (keyboard parity)', () => {
    const ids = keysFor({ sort: 'name' });
    const candidates: Array<{ key: string; code?: string; shiftKey?: boolean }> = [
      ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Enter', ' '].map((k) => ({
        key: k,
      })),
      ...[0, 1, 2, 3, 4, 5].map((n) => ({ key: String(n), code: `Digit${n}` })),
      ...[0, 1, 2, 3, 4, 5].map((n) => ({ key: String(n), code: `Numpad${n}` })),
      ...'abcdefghijklmnopqrstuvwxyz'.split('').map((k) => ({ key: k })),
      ...'pxu'.split('').map((k) => ({ key: k.toUpperCase(), shiftKey: true })),
    ];
    const handled = (init: (typeof candidates)[number]) => !fireEvent.keyDown(window, init);

    const onClose = vi.fn();
    const onDevelop = vi.fn();
    render(<ReviewMode inline onDevelop={onDevelop} onClose={onClose} />);
    act(() => useUiStore.getState().openReview(ids, 2));
    const byReview = candidates.filter(handled);
    cleanup();
    expect(byReview.map((c) => c.code ?? c.key)).toEqual(
      expect.arrayContaining(['ArrowLeft', 'Home', 'Escape', 'Digit0', 'Numpad5', 'p', 'x', 'u', 'd', 'P']),
    );

    const gridDevelop = vi.fn();
    render(<CullGrid onDevelop={gridDevelop} />);
    act(() => useUiStore.getState().setCull({ view: 'grid' }));
    act(() => useUiStore.getState().openReview(ids, 2));
    // Escape clears a selection (with none it is left to others, below).
    act(() => useUiStore.getState().setSelection([ids[2] ?? '']));
    // Plan 53's assist keys (F, Z, O) act on a picture (One, Two, Decide); the grid has none to draw on.
    expect(byReview.map((c) => c.key)).toEqual(expect.arrayContaining(['f', 'z', 'o']));
    for (const init of byReview.filter((c) => assistKeyAction({ ...ALT_OFF, ...c, target: null }) === null)) {
      expect(handled(init), `grid handles ${init.code ?? init.key}`).toBe(true);
      expect(
        cullKeyAction({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', ...init }),
      ).not.toBeNull();
    }
    expect(gridDevelop).toHaveBeenCalled();
    // The README table lists every action kind.
    expect(CULL_KEYS.map((k) => k.keys)).toEqual(expect.arrayContaining(['1 to 5, 0', 'P / X / U', 'D', 'Esc']));
  });

  it('keyboard parity, extended: C and N are grid keys, with a README row each, and Review leaves them alone', () => {
    const ids = keysFor({ sort: 'name' });
    const handled = (k: string) => !fireEvent.keyDown(window, { key: k });
    render(<ReviewMode inline onClose={vi.fn()} />);
    act(() => useUiStore.getState().openReview(ids, 0));
    expect(['c', 'n'].map(handled)).toEqual([false, false]);
    cleanup();

    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, 0));
    // N with nothing to survey is swallowed but changes nothing; C opens Compare.
    expect(handled('n')).toBe(true);
    expect(useUiStore.getState().cull.view).toBe('grid');
    expect(handled('c')).toBe(true);
    expect(useUiStore.getState().cull.view).toBe('compare');
    expect(CULL_KEYS.map((k) => k.keys)).toEqual(expect.arrayContaining(['C', 'N']));
    expect(
      cullKeyAction({ key: 'N', code: '', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false }),
    ).toBeNull();
  });

  it('ignores keys typed in a text field', () => {
    render(
      <>
        <input aria-label="Search" />
        <CullGrid />
      </>,
    );
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'p' });
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'ArrowRight' });
    expect(useUiStore.getState().review?.index).toBe(0);
    expect(useBookStore.getState().libraries['/trip']?.photos).toEqual({});
  });
});

/** A scroll container that clamps `scrollTop` like a browser: to its content height minus its own. */
function clampScrolling() {
  const stored = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return stored.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const content = Number.parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? '') || 0;
      stored.set(this, Math.max(0, Math.min(value, content - this.clientHeight)));
    },
  });
  return () => {
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
  };
}

describe('Cull grid scroll', () => {
  const forty = () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) many[`p${String(i).padStart(2, '0')}.jpg`] = i;
    setFolder(many);
    return keysFor();
  };

  it('restores an offset the list is now too short for as far as it goes, and saves the scroll again', () => {
    const unclamp = clampScrolling();
    try {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });
      const ids = forty();
      // Saved on a longer list: 8 rows of 52 px (436 px of content) can scroll 236 px in a 200 px grid.
      useUiStore.setState({
        cull: {
          columns: 5,
          view: 'grid',
          scrollTop: 1000,
          grouped: true,
          showStars: false,
          expanded: null,
          zoom: 'fit',
        },
      });
      render(<CullGrid />);
      act(() => useUiStore.getState().openReview(ids, 35));
      const grid = screen.getByRole('listbox', { name: 'Photos' });
      expect(grid.scrollTop).toBe(236);
      act(() => {
        grid.scrollTop = 100;
        fireEvent.scroll(grid);
      });
      expect(useUiStore.getState().cull.scrollTop).toBe(100);
      // Focus moves keep scrolling the grid to the focused photo.
      press({ key: 'Home' });
      expect(grid.scrollTop).toBe(0);
    } finally {
      unclamp();
    }
  });

  it('another source starts at the top, coming back to the same one keeps the scroll', () => {
    const ids = forty();
    const { rerender } = render(<CullStage sourceKey="folder:A" />);
    act(() => useUiStore.getState().openReview(ids, 16));
    act(() => {
      const grid = screen.getByRole('listbox', { name: 'Photos' });
      grid.scrollTop = 120;
      fireEvent.scroll(grid);
    });
    rerender(<CullStage sourceKey="folder:A" />);
    expect(screen.getByRole('listbox', { name: 'Photos' }).scrollTop).toBe(120);
    rerender(<CullStage sourceKey="folder:B" />);
    expect(screen.getByRole('listbox', { name: 'Photos' }).scrollTop).toBe(0);
    expect(useUiStore.getState().cull.scrollTop).toBe(0);
  });
});

describe('Cull grid keys, more', () => {
  it('leaves Escape alone with nothing selected, and Cmd+Shift+= zooms in', () => {
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true);
    act(() => useUiStore.getState().setSelection([key('a.jpg')]));
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(false);
    press({ key: '+', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().cull.columns).toBe(4);
  });

  it('a narrower filter trims the selection and its anchor to what is shown', () => {
    const library = emptyLibrary();
    library.photos['h-a.jpg'] = { flag: 'pick', versions: {} };
    setFolder(MTIMES, library);
    act(() => useUiStore.getState().setSelection([key('a.jpg'), key('b.jpg'), key('c.jpg')], key('c.jpg')));
    keepSelectionWithin(keysFor());
    expect(selected()).toHaveLength(3);
    keepSelectionWithin(keysFor({ flag: 'picks' }));
    expect(useUiStore.getState().selection).toEqual({ keys: [key('a.jpg')], anchor: null });
  });
});

describe('Cull grid skin (plan 47)', () => {
  it('arrowing through 500 cells re-renders no cell: the focus ring is one element that moves', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 500; i++) many[`p${String(i).padStart(3, '0')}.jpg`] = i;
    setFolder(many);
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    const ring = () => document.querySelector<HTMLElement>('[data-focus-ring]');
    const cells = screen.getAllByRole('option').length;
    expect(cells).toBeGreaterThan(20);
    expect(ring()).toBeTruthy();
    const before = ring()?.style.transform;
    cellHooks.calls = 0;
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight']) press({ key });
    expect(useUiStore.getState().review?.index).toBe(12);
    expect(cellHooks.calls).toBe(0);
    expect(screen.getAllByRole('option')).toHaveLength(cells);
    // One ring, moved to the focused cell.
    expect(document.querySelectorAll('[data-focus-ring]')).toHaveLength(1);
    expect(ring()?.style.transform).not.toBe(before);
    expect(screen.getByRole('listbox', { name: 'Photos' }).getAttribute('aria-activedescendant')).toBe(
      option('p012.jpg').id,
    );
    // The counter does count: selecting a cell re-renders that cell.
    fireEvent.click(option('p012.jpg'), { metaKey: true });
    expect(cellHooks.calls).toBeGreaterThan(0);
  });

  it('the batch pill slides up with a selection and the grid pads its end so the last row clears it', () => {
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    const pill = screen.getByRole('toolbar', { name: 'Batch actions' });
    const content = () => screen.getByRole('listbox', { name: 'Photos' }).firstElementChild as HTMLElement;
    expect(pill.hasAttribute('inert')).toBe(true);
    const bare = Number.parseFloat(content().style.height);
    fireEvent.click(option('c.jpg'));
    expect(pill.hasAttribute('inert')).toBe(false);
    expect(pill.querySelector('[role="status"]')?.textContent).toBe('1 selected');
    expect(Number.parseFloat(content().style.height)).toBe(bare + PILL_CLEARANCE);
    // The pill holds what the plan names: Export, Denoise, ⋯ (the grid's menu on the selection) and Clear; no flags.
    expect(within(pill).getByRole('button', { name: 'Export…' })).toBeTruthy();
    expect(within(pill).getByRole('button', { name: 'Denoise…' })).toBeTruthy();
    expect(within(pill).queryByRole('button', { name: 'Keep' })).toBeNull();
    fireEvent.click(within(pill).getByRole('button', { name: 'More actions' }));
    expect(
      within(screen.getByRole('menu', { name: 'Photo actions' })).getByRole('menuitem', {
        name: /^Copy settings\s*⇧⌘C/,
      }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Photo actions' }), { key: 'Escape' });
    press({ key: 'Escape' });
    expect(pill.hasAttribute('inert')).toBe(true);
    expect(Number.parseFloat(content().style.height)).toBe(bare);
  });

  it('staggers a list that opens at the top, from its first cell drawn, and not one that opens scrolled down', () => {
    const ids = keysFor({ sort: 'name' });
    const { unmount } = render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    const grid = () => screen.getByRole('listbox', { name: 'Photos' });
    expect(grid().hasAttribute('data-opening')).toBe(true);
    expect(grid().style.getPropertyValue('--first')).toBe('0');
    expect(option('c.jpg').style.getPropertyValue('--i')).toBe('2');
    unmount();
    // Another list, opened scrolled down (back from One on a long list): no stagger, no blank cells.
    const other = keysFor({ sort: 'time' });
    act(() => {
      useUiStore.getState().closeReview();
      useUiStore.getState().setCull({ scrollTop: 400 });
    });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(other, 0));
    expect(grid().hasAttribute('data-opening')).toBe(false);
  });

  it('turning Stars on does not pop every star; rating a photo pops its stars', () => {
    const library = emptyLibrary();
    library.photos['h-a.jpg'] = { rating: 4, versions: {} };
    setFolder(MTIMES, library);
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 1));
    act(() => useUiStore.getState().setCull({ showStars: true }));
    expect(screen.getByRole('img', { name: '4 stars' }).classList.contains('star-pop')).toBe(false);
    press({ key: '3', code: 'Digit3' });
    expect(screen.getByRole('img', { name: '3 stars' }).classList.contains('star-pop')).toBe(true);
  });

  it('marks a selected cell with the check, apart from the focus', () => {
    const ids = keysFor({ sort: 'name' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    fireEvent.click(option('b.jpg'), { metaKey: true });
    expect(option('b.jpg').querySelector('[aria-label="Selected"]')).toBeTruthy();
    expect(option('a.jpg').querySelector('[aria-label="Selected"]')).toBeNull();
  });
});
