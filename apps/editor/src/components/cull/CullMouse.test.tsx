// @vitest-environment jsdom
import { emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { useCullStore } from '../../store/cull';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { CULL_ZOOM_KEY, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { CullViewBar } from '../shell/LibraryFilterBar';
import { bestOf } from './CullContextMenu';
import { cellsInRect } from './CullGrid';
import { CullView } from './CullView';
import { openCompare } from './openViews';
import { useRejectPileStore } from './rejectPile';

const revealed = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  revealExport: vi.fn(async (path: string) => {
    revealed.paths.push(path);
  }),
  histogram: vi.fn(async () => ({ r: [], g: [], b: [], l: [] })),
  writeLibrary: vi.fn(async () => {}),
}));

const F = 'F1';
const key = (name: string) => photoKey({ folder: F, path: name });
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg', 'g.jpg'];
const ids = () => NAMES.map(key);

const photo = (relPath: string, i: number): PhotoFile => ({
  relPath,
  size: 1,
  mtime: i,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  width: 1200,
  height: 800,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
  proxyUrl: `asset://c/${relPath}/proxy.jpg`,
});

const option = (name: string) => screen.getByRole('option', { name });
const selected = () => useUiStore.getState().selection.keys;
const cull = () => useUiStore.getState().cull;
const flagOf = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`]?.flag;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: Object.fromEntries(NAMES.map((n, i) => [n, photo(n, i)])),
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': emptyLibrary() } });
  useUiStore.setState({
    review: null,
    selection: EMPTY_SELECTION,
    cull: { columns: 5, view: 'grid', scrollTop: 0, grouped: true, showStars: false, expanded: null, zoom: 'fit' },
    reviewAutoAdvance: false,
  });
  useRejectPileStore.setState({ open: false });
  revealed.paths = [];
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('the grid mouse (plan 52)', () => {
  it('a double-click opens One on the photo', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    fireEvent.doubleClick(option('c.jpg'));
    expect(cull().view).toBe('review');
    expect(useUiStore.getState().review?.index).toBe(2);
    expect(screen.getByRole('region', { name: 'One: c.jpg' })).toBeTruthy();
  });

  it('finds the cells a box touches', () => {
    const rows = [{ cells: [0, 1, 2, 3, 4] }, { cells: [5, 6] }];
    // 48 px cells from the 12 px padding, 4 px apart: columns at 12, 64, 116, 168, 220; rows at 12 and 64.
    const size = { cell: 48, cellWidth: 48 };
    expect(cellsInRect(rows, { x: 0, y: 0, w: 5, h: 5 }, size)).toEqual([]);
    expect(cellsInRect(rows, { x: 30, y: 30, w: 50, h: 10 }, size)).toEqual([0, 1]);
    expect(cellsInRect(rows, { x: 100, y: 50, w: 20, h: 20 }, size)).toEqual([1, 2, 6]);
    expect(cellsInRect(rows, { x: 113, y: 61, w: 2, h: 2 }, size)).toEqual([]);
    expect(cellsInRect(rows, { x: 0, y: 0, w: 280, h: 200 }, size)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cellsInRect(rows, { x: 0, y: 0, w: 280, h: 200 }, { cell: 0, cellWidth: 0 })).toEqual([]);
  });

  it('a drag draws a marquee that selects; Shift adds; the click that ends it selects nothing more', async () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    const grid = screen.getByRole('listbox', { name: 'Photos' });
    fireEvent.mouseDown(grid, { button: 0, clientX: 30, clientY: 30 });
    fireEvent.mouseMove(window, { clientX: 32, clientY: 31 });
    // Under the slop: still a click.
    expect(grid.querySelector('[data-marquee]')).toBeNull();
    fireEvent.mouseMove(window, { clientX: 120, clientY: 40 });
    expect(grid.querySelector('[data-marquee]')).not.toBeNull();
    expect(selected()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'].map(key));
    fireEvent.mouseUp(window);
    fireEvent.click(option('c.jpg'));
    expect(selected()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'].map(key));
    expect(grid.querySelector('[data-marquee]')).toBeNull();

    // With Shift the box adds the second row's cells to what was selected.
    fireEvent.mouseDown(grid, { button: 0, clientX: 30, clientY: 80, shiftKey: true });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 90 });
    fireEvent.mouseUp(window);
    expect(selected()).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'f.jpg', 'g.jpg'].map(key));
    // A plain click afterwards (no click came from the drag itself) still selects one photo.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(option('d.jpg'));
    expect(selected()).toEqual([key('d.jpg')]);
  });
});

describe("Cull's right-click menu (plan 52)", () => {
  const menuItems = () =>
    within(screen.getByRole('menu', { name: 'Photo actions' }))
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.truncate')?.textContent);

  it('lists the actions in order and flags through the store, not as an undo step', () => {
    const onDevelop = vi.fn();
    render(<CullView onDevelop={onDevelop} />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    const undoSteps = useBookStore.temporal.getState().pastStates.length;
    fireEvent.contextMenu(option('b.jpg'), { clientX: 40, clientY: 40 });
    expect(selected()).toEqual([key('b.jpg')]);
    expect(menuItems().slice(0, 8)).toEqual([
      'Keep',
      'Reject',
      'Undecided',
      'Develop this photo',
      'Compare with best',
      'Export…',
      'Reveal in Finder',
      'Move to Trash…',
    ]);
    // Then the settings items of the grid's menu.
    expect(menuItems()).toContain('Paste settings');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reject/ }));
    expect(flagOf('b.jpg')).toBe('reject');
    expect(useBookStore.temporal.getState().pastStates.length).toBe(undoSteps);
    expect(screen.queryByRole('menu')).toBeNull();

    // On the selection: two photos.
    fireEvent.click(option('c.jpg'), { metaKey: true });
    fireEvent.contextMenu(option('c.jpg'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Keep 2 photos/ }));
    expect([flagOf('b.jpg'), flagOf('c.jpg')]).toEqual(['pick', 'pick']);

    fireEvent.contextMenu(option('d.jpg'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Develop this photo/ }));
    expect(onDevelop).toHaveBeenCalledWith(key('d.jpg'));

    fireEvent.contextMenu(option('d.jpg'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reveal in Finder/ }));
    expect(revealed.paths).toEqual(['/trip/d.jpg']);
  });

  it('acts on the selection the list shows, never on a photo the filter hides', () => {
    render(<CullView />);
    // f.jpg and g.jpg are selected, then a filter leaves them out of the list.
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setSelection([key('b.jpg'), key('c.jpg'), key('g.jpg')], key('b.jpg')));
    act(() => useUiStore.getState().updateSessionIds('review', ids().slice(0, 5), 0));
    fireEvent.contextMenu(option('c.jpg'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Keep 2 photos/ }));
    expect([flagOf('b.jpg'), flagOf('c.jpg'), flagOf('g.jpg')]).toEqual(['pick', 'pick', undefined]);
  });

  it('Compare with best opens Compare on the group, even over a selection, and Esc goes back to Decide', () => {
    useUiStore.setState({ cull: { ...cull(), view: 'decide' } });
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setSelection([key('d.jpg'), key('e.jpg')], key('d.jpg')));
    const group = { frames: [key('a.jpg'), key('b.jpg'), key('c.jpg')], shown: key('a.jpg'), best: key('c.jpg') };
    expect(openCompare(group, { groupFirst: true, back: 'decide' })).toBe(true);
    expect(cull().compare).toEqual({ candidate: key('a.jpg'), select: key('c.jpg'), back: 'decide' });
    expect(useUiStore.getState().review?.index).toBe(0);
    // Without `groupFirst` the selection wins (C on the grid).
    expect(openCompare(group)).toBe(true);
    expect(cull().compare).toEqual({ candidate: key('d.jpg'), select: key('e.jpg') });
  });

  it('Move to Trash… only opens the reject pile; with no reject it is off', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    fireEvent.contextMenu(option('a.jpg'), { clientX: 40, clientY: 40 });
    expect(screen.getByRole('menuitem', { name: /^Move to Trash/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reject/ }));
    fireEvent.contextMenu(option('a.jpg'), { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Move to Trash/ }));
    expect(useRejectPileStore.getState().open).toBe(true);
    // Nothing left the folder.
    expect(Object.keys(useLibraryStore.getState().folders[F]?.photos ?? {})).toHaveLength(NAMES.length);
  });

  it('a text field keeps the system menu', () => {
    render(
      <>
        <input aria-label="Search photos" />
        <CullView />
      </>,
    );
    act(() => useUiStore.getState().openReview(ids(), 0));
    const event = fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Search photos' }));
    expect(event).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('One and Two have the same menu', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 1));
    act(() => useUiStore.getState().setCull({ view: 'review' }));
    const one = screen.getByRole('region', { name: 'One: b.jpg' }).querySelector('[data-zoom]');
    if (!one) throw new Error('picture');
    fireEvent.contextMenu(one, { clientX: 40, clientY: 40 });
    expect(screen.getByRole('menuitem', { name: /^Compare with best/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /^Keep/ }));
    expect(flagOf('b.jpg')).toBe('pick');

    act(() =>
      useUiStore.getState().setCull({ view: 'compare', compare: { candidate: key('a.jpg'), select: key('c.jpg') } }),
    );
    const [, right] = [...document.querySelectorAll<HTMLElement>('[data-side] [data-zoom]')];
    if (!right) throw new Error('pane');
    fireEvent.contextMenu(right, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: /^Reject/ }));
    expect(flagOf('c.jpg')).toBe('reject');
  });

  it('Compare with best pairs a photo with its group’s suggested best', () => {
    const group = { id: 'g', frames: ['x', 'y', 'z'], best: 'y' };
    const groups = { groups: [group], byPhoto: new Map(group.frames.map((f) => [f, group])), entries: new Map() };
    expect(bestOf('x', groups, ['x', 'y', 'z'])).toBe('y');
    // The best itself is compared with the next frame shown.
    expect(bestOf('y', groups, ['x', 'y', 'z'])).toBe('z');
    // The best filtered out: the next frame.
    expect(bestOf('x', groups, ['x', 'z'])).toBe('z');
    expect(bestOf('x', groups, ['x'])).toBeUndefined();
    expect(bestOf('w', groups, ['w', 'x'])).toBeUndefined();
  });
});

describe('the view switch and the one zoom (plan 52)', () => {
  const stage = () => {
    useCullStore.setState({ stages: 1 });
    render(
      <>
        <CullViewBar />
        <CullView />
      </>,
    );
    act(() => useUiStore.getState().openReview(ids(), 0));
  };
  afterEach(() => useCullStore.setState({ stages: 0 }));

  it('Grid · One · Two switch the view; One is review and Two is compare', () => {
    stage();
    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(view).getByRole('button', { name: 'One' }));
    expect(cull().view).toBe('review');
    fireEvent.click(within(view).getByRole('button', { name: 'Two' }));
    expect(cull().view).toBe('compare');
    expect(cull().compare).toMatchObject({ candidate: key('a.jpg'), select: key('b.jpg') });
    fireEvent.click(within(view).getByRole('button', { name: 'Grid' }));
    expect(cull().view).toBe('grid');
  });

  it('the zoom is the column count in Grid and Fit · 1× · 2× · 4× in One and Two, per machine', () => {
    stage();
    const slider = screen.getByRole('slider', { name: 'Zoom: grid columns' });
    // Right is bigger cells: fewer columns.
    fireEvent.change(slider, { target: { value: '7' } });
    expect(cull().columns).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    fireEvent.click(within(zoom).getByRole('button', { name: '2×' }));
    expect(cull().zoom).toBe(2);
    expect(localStorage.getItem(CULL_ZOOM_KEY)).toBe('2');
    expect(
      screen.getByRole('region', { name: 'One: a.jpg' }).querySelector('[data-zoom]')?.getAttribute('data-zoom'),
    ).toBe('2');
    // Two shares it (the linked viewport).
    fireEvent.click(screen.getByRole('button', { name: 'Two' }));
    expect([...document.querySelectorAll<HTMLElement>('[data-side] [data-zoom]')].map((p) => p.dataset.zoom)).toEqual([
      '2',
      '2',
    ]);
    fireEvent.click(within(screen.getByRole('group', { name: 'Zoom' })).getByRole('button', { name: 'Fit' }));
    expect(cull().zoom).toBe('fit');
  });
});
