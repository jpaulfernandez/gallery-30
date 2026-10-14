// @vitest-environment jsdom
import { emptyLibrary, type Library } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { libraryKeys } from '../../store/collections';
import { useCullStore } from '../../store/cull';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { CullViewBar } from '../shell/LibraryFilterBar';
import { CullView } from './CullView';
import { COMPARE_KEYS, compareKeyAction, SURVEY_KEYS } from './keys';
import { surveyColumns } from './surveyLayout';
import { clampCenter, INITIAL_VIEWPORT, placement, proxySize, stepZoom, zoomTo } from './viewport';

const F = 'F1';
const key = (name: string) => photoKey({ folder: F, path: name });
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.jpg'];

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

function setFolder(library: Library = emptyLibrary()) {
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
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': library } });
}

const ids = () =>
  libraryKeys({ kind: 'folder', id: F }, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    sort: 'name',
  });
const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);
const photoOf = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`];
const cull = () => useUiStore.getState().cull;
const selected = () => useUiStore.getState().selection.keys;
const panes = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-zoom]')];

/** The grid is a stage of `CullView`: open it on the name-sorted list with `focus` as the current photo. */
function open(focus = 0, library?: Library) {
  if (library) setFolder(library);
  const view = render(<CullView />);
  act(() => useUiStore.getState().openReview(ids(), focus));
  return view;
}

/** Plan 49: Compare's zoom is the filter bar's (`CullViewBar`, shown while a Cull stage is mounted). */
function openWithBar(focus = 0) {
  useCullStore.setState({ stages: 1 });
  const view = render(
    <>
      <CullViewBar />
      <CullView />
    </>,
  );
  act(() => useUiStore.getState().openReview(ids(), focus));
  return view;
}
const zoomBar = () => within(screen.getByRole('group', { name: 'Zoom' }));

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
  setFolder();
});
afterEach(() => {
  cleanup();
  useCullStore.setState({ stages: 0 });
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({
    review: null,
    selection: EMPTY_SELECTION,
    cull: { columns: 5, view: 'grid', scrollTop: 0, grouped: true, showStars: false, expanded: null, zoom: 'fit' },
  });
});

describe('viewport maths', () => {
  it('steps through Fit, 1×, 2×, 4× and stops at the ends', () => {
    expect(stepZoom('fit', 1)).toBe(1);
    expect(stepZoom(2, 1)).toBe(4);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(1, -1)).toBe('fit');
    expect(stepZoom('fit', -1)).toBe('fit');
  });

  it('zooms around a point and keeps it when none is given', () => {
    const at = zoomTo(INITIAL_VIEWPORT, 2, { x: 0.25, y: 0.75 });
    expect(at).toEqual({ zoom: 2, cx: 0.25, cy: 0.75 });
    expect(zoomTo(at, 4)).toEqual({ zoom: 4, cx: 0.25, cy: 0.75 });
    expect(zoomTo(at, 'fit')).toMatchObject({ zoom: 'fit', cx: 0.25 });
  });

  it('keeps the loupe point where the picture fills the pane, and centred where it is smaller', () => {
    const pane = { w: 800, h: 600 };
    const picture = { w: 1600, h: 1067 };
    // 1×: 1600 px wide in an 800 px pane: the point stays within a quarter of the edges; 1067 high in 600: 0.28 to 0.72.
    const edge = clampCenter({ zoom: 1, cx: 0.02, cy: 0.99 }, pane, picture);
    expect(edge.cx).toBeCloseTo(0.25, 5);
    expect(edge.cy).toBeCloseTo(1 - 600 / (2 * 1067), 5);
    expect(clampCenter({ zoom: 1, cx: 0.6, cy: 0.5 }, pane, picture)).toMatchObject({ cx: 0.6, cy: 0.5 });
    // A picture smaller than the pane on an axis is centred there.
    expect(clampCenter({ zoom: 1, cx: 0.1, cy: 0.9 }, pane, { w: 400, h: 300 })).toMatchObject({ cx: 0.5, cy: 0.5 });
    // Fit has no point; a 2× display shows the same stop at half the CSS size, so more of the point range is free.
    expect(clampCenter(INITIAL_VIEWPORT, pane, picture)).toBe(INITIAL_VIEWPORT);
    expect(clampCenter({ zoom: 1, cx: 0.02, cy: 0.5 }, pane, picture, 2).cx).toBeCloseTo(0.5, 5);
  });

  it('places the picture: contained at fit, the loupe point centred when zoomed, centred when smaller', () => {
    const picture = proxySize(6000, 4000);
    expect(picture).toEqual({ w: 1600, h: 1067 });
    expect(placement(INITIAL_VIEWPORT, { w: 800, h: 800 }, picture)).toMatchObject({ left: 0, width: 800 });
    const zoomed = placement({ zoom: 1, cx: 0.5, cy: 0.5 }, { w: 800, h: 600 }, picture);
    expect(zoomed).toMatchObject({ left: -400, top: 600 / 2 - 533.5, width: 1600 });
    // 1× is one proxy pixel per device pixel: half the CSS width on a 2× display.
    expect(placement({ zoom: 1, cx: 0.5, cy: 0.5 }, { w: 800, h: 600 }, picture, 2)).toMatchObject({ width: 800 });
    // The picture never leaves the pane: a point at the far left puts the picture's left edge at the pane's.
    expect(placement({ zoom: 1, cx: 0, cy: 0.5 }, { w: 800, h: 600 }, picture).left).toBe(0);
    expect(placement({ zoom: 2, cx: 1, cy: 0.5 }, { w: 800, h: 600 }, picture).left).toBe(800 - 3200);
    const small = placement({ zoom: 1, cx: 0.9, cy: 0.9 }, { w: 800, h: 600 }, { w: 400, h: 300 });
    expect(small).toMatchObject({ left: 200, top: 150 });
  });

  it('proxySize never scales a small photo up', () => {
    expect(proxySize(800, 600)).toEqual({ w: 800, h: 600 });
  });
});

describe('Survey layout', () => {
  it('picks columns for the biggest tiles', () => {
    expect(surveyColumns(1, 900, 600)).toBe(1);
    expect(surveyColumns(2, 1200, 600)).toBe(2);
    expect(surveyColumns(2, 400, 900)).toBe(1);
    expect(surveyColumns(6, 1200, 600)).toBeGreaterThanOrEqual(2);
    expect(surveyColumns(6, 1200, 600)).toBeLessThanOrEqual(3);
    expect(surveyColumns(5, 0, 0)).toBe(1);
  });
});

describe('Compare', () => {
  it('C opens on the focused photo and the next, or on the first two selected', () => {
    open(1);
    press({ key: 'c' });
    expect(screen.getByRole('region', { name: 'Compare: b.jpg and c.jpg' })).toBeTruthy();
    expect(cull()).toMatchObject({ view: 'compare', compare: { candidate: key('b.jpg'), select: key('c.jpg') } });
    press({ key: 'Escape' });
    expect(cull().view).toBe('grid');

    act(() => useUiStore.getState().setSelection([key('e.jpg'), key('a.jpg'), key('d.jpg')]));
    press({ key: 'c' });
    expect(cull().compare).toEqual({ candidate: key('e.jpg'), select: key('a.jpg') });
    expect(useUiStore.getState().review?.index).toBe(4);
  });

  it('on the last photo the previous one is the select', () => {
    open(5);
    press({ key: 'c' });
    expect(cull().compare).toEqual({ candidate: key('f.jpg'), select: key('e.jpg') });
  });

  it('arrows swap the candidate through the list and skip the select; the grid focus follows', () => {
    open(0);
    press({ key: 'c' });
    expect(cull().compare).toEqual({ candidate: key('a.jpg'), select: key('b.jpg') });
    press({ key: 'ArrowRight' });
    // b is the select: the candidate moves on to c.
    expect(cull().compare).toEqual({ candidate: key('c.jpg'), select: key('b.jpg') });
    expect(screen.getByRole('region', { name: 'Compare: c.jpg and b.jpg' })).toBeTruthy();
    press({ key: 'ArrowLeft' });
    expect(cull().compare?.candidate).toBe(key('a.jpg'));
    press({ key: 'End' });
    expect(cull().compare?.candidate).toBe(key('f.jpg'));
    press({ key: 'Home' });
    expect(cull().compare?.candidate).toBe(key('a.jpg'));
    press({ key: 'ArrowRight' });
    press({ key: 'ArrowRight' });
    expect(useUiStore.getState().review?.index).toBe(3);
    // Esc: the grid is focused on the candidate.
    press({ key: 'Escape' });
    expect(cull().view).toBe('grid');
    // Plan 47: the focused cell is the listbox's active descendant (the grid draws one sliding focus ring).
    expect(screen.getByRole('listbox', { name: 'Photos' }).getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'd.jpg' }).id,
    );
  });

  it('Cmd+Enter from the opening state makes the candidate the select and brings in a photo that is neither', () => {
    open(0);
    press({ key: 'c' });
    expect(cull().compare).toEqual({ candidate: key('a.jpg'), select: key('b.jpg') });
    press({ key: 'Enter', metaKey: true });
    // Not a swap: a is the select, and the next photo that is neither a nor the old select b is the candidate.
    expect(cull().compare).toEqual({ candidate: key('c.jpg'), select: key('a.jpg') });
    expect(useUiStore.getState().review?.index).toBe(2);
    press({ key: 'Enter', metaKey: true });
    expect(cull().compare).toEqual({ candidate: key('d.jpg'), select: key('c.jpg') });
    expect(useUiStore.getState().review?.index).toBe(3);
  });

  it('Cmd+Enter with nothing ahead steps back to a photo that is neither, and does nothing without one', () => {
    open(5);
    press({ key: 'c' });
    expect(cull().compare).toEqual({ candidate: key('f.jpg'), select: key('e.jpg') });
    press({ key: 'Enter', metaKey: true });
    expect(cull().compare).toEqual({ candidate: key('d.jpg'), select: key('f.jpg') });
    // Two photos only: there is no third to bring in.
    act(() => useUiStore.getState().updateSessionIds('review', [key('a.jpg'), key('b.jpg')], 0));
    act(() => useUiStore.getState().setCull({ compare: { candidate: key('a.jpg'), select: key('b.jpg') } }));
    press({ key: 'Enter', metaKey: true });
    expect(cull().compare).toEqual({ candidate: key('a.jpg'), select: key('b.jpg') });
  });

  it('links zoom and the loupe point across both panes', () => {
    const { container } = openWithBar(0);
    press({ key: 'c' });
    const [left, right] = panes(container);
    expect(left?.dataset.zoom).toBe('fit');
    expect(right?.dataset.zoom).toBe('fit');

    fireEvent.click(zoomBar().getByRole('button', { name: '2×' }));
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['2', '2']);
    press({ key: 'k' });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['4', '4']);
    press({ key: 'j' });
    press({ key: '-', metaKey: true });
    press({ key: 'j' });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);
    press({ key: '=', metaKey: true });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual([1, 1].map(String));
    // Plan 53: F is focus peak now; Shift+F fits.
    press({ key: 'F', shiftKey: true });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);
    expect(zoomBar().getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a double-click zooms to 1× at that point on both panes, a drag pans both, a double-click again fits', () => {
    const { container } = open(0);
    press({ key: 'c' });
    const [left, right] = panes(container);
    if (!left || !right) throw new Error('two panes');
    // The mocked pane is 280 × 600 and the picture 1200 × 800 fitted at the top of a 187 px band at 207 px.
    // Plan 52: a click only focuses the pane; a double-click zooms.
    fireEvent.mouseDown(left, { button: 0, clientX: 70, clientY: 300 });
    fireEvent.mouseUp(window);
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);
    fireEvent.doubleClick(left, { clientX: 70, clientY: 300 });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['1', '1']);
    expect(panes(container).map((p) => p.dataset.center)).toEqual(['0.250,0.500', '0.250,0.500']);

    fireEvent.mouseDown(right, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 100 });
    fireEvent.mouseUp(window);
    // 30 px left over a 1200 px wide picture moves the point 0.025 right, on both panes; no zoom change.
    expect(panes(container).map((p) => p.dataset.center)).toEqual(['0.275,0.500', '0.275,0.500']);
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['1', '1']);

    fireEvent.doubleClick(left, { clientX: 70, clientY: 300 });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);
  });

  it('the loupe point stays where the picture fills the pane: a click near an edge and a long drag', () => {
    const { container } = open(0);
    press({ key: 'c' });
    const [left] = panes(container);
    if (!left) throw new Error('pane');
    // 5 px from the left edge: the point is held 0.117 in (a 280 px pane over the 1200 px picture), not 0.018.
    fireEvent.doubleClick(left, { clientX: 5, clientY: 300 });
    expect(panes(container).map((p) => p.dataset.center)).toEqual(['0.117,0.500', '0.117,0.500']);

    // Dragging far to the right then back moves at once: no dead zone beyond the edge.
    fireEvent.mouseDown(left, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 5000, clientY: 100 });
    expect(left.dataset.center).toBe('0.117,0.500');
    fireEvent.mouseMove(window, { clientX: 4880, clientY: 100 });
    // 120 px left over 1200 px: 0.1 right of the held point.
    expect(left.dataset.center).toBe('0.217,0.500');
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(left, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: -9000, clientY: 100 });
    fireEvent.mouseUp(window);
    expect(left.dataset.center).toBe('0.883,0.500');
  });

  it('rating and flag keys act on the focused pane; Tab and a click move the focus', () => {
    const { container } = open(0);
    press({ key: 'c' });
    press({ key: '3', code: 'Digit3' });
    expect(photoOf('a.jpg')?.rating).toBe(3);
    expect(photoOf('b.jpg')?.rating).toBeUndefined();
    press({ key: 'Tab' });
    press({ key: '5', code: 'Digit5' });
    press({ key: 'x' });
    expect(photoOf('b.jpg')).toMatchObject({ rating: 5, flag: 'reject' });
    expect(photoOf('a.jpg')?.flag).toBeUndefined();
    // The ratings show in the pane header.
    expect(within(screen.getByRole('region', { name: /^Compare/ })).getByRole('img', { name: '5 stars' })).toBeTruthy();

    const [left] = panes(container);
    if (!left) throw new Error('pane');
    fireEvent.mouseDown(left, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window);
    press({ key: 'p' });
    expect(photoOf('a.jpg')?.flag).toBe('pick');
    // Ratings are one library write each and never undo steps.
  });

  it('auto-advance steps the candidate after rating it, and Shift inverts it', () => {
    useUiStore.setState({ reviewAutoAdvance: true });
    open(0);
    press({ key: 'c' });
    press({ key: '4', code: 'Digit4' });
    expect(photoOf('a.jpg')?.rating).toBe(4);
    expect(cull().compare?.candidate).toBe(key('c.jpg'));
    press({ key: '2', code: 'Digit2', shiftKey: true });
    expect(photoOf('c.jpg')?.rating).toBe(2);
    expect(cull().compare?.candidate).toBe(key('c.jpg'));
  });

  it('D develops the focused pane photo and Esc leaves', () => {
    const onDevelop = vi.fn();
    render(<CullView onDevelop={onDevelop} />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    press({ key: 'c' });
    press({ key: 'Tab' });
    press({ key: 'd' });
    expect(onDevelop).toHaveBeenCalledWith(key('b.jpg'));
  });

  it('without a proxy a pane shows its thumbnail at fit and nothing zooms until it arrives', () => {
    const folder = useLibraryStore.getState().folders[F];
    if (!folder) throw new Error('folder');
    const a = folder.photos['a.jpg'];
    if (!a) throw new Error('photo');
    useLibraryStore.setState({
      folders: { [F]: { ...folder, photos: { ...folder.photos, 'a.jpg': { ...a, proxyUrl: undefined } } } },
    });
    const { container } = openWithBar(0);
    press({ key: 'c' });
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'asset://c/a.jpg/thumb.jpg',
      'asset://c/b.jpg/proxy.jpg',
    ]);
    expect(screen.getByText('Preparing preview…')).toBeTruthy();
    // The bar's 2× holds both panes at fit until the proxy is there (plan 49: the header's own control is gone).
    fireEvent.click(zoomBar().getByRole('button', { name: '2×' }));
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);
    fireEvent.click(zoomBar().getByRole('button', { name: 'Fit' }));
    press({ key: 'k' });
    const [left, right] = panes(container);
    if (!left || !right) throw new Error('panes');
    fireEvent.doubleClick(right, { clientX: 70, clientY: 300 });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['fit', 'fit']);

    // The proxy arrives: zoom works.
    act(() =>
      useLibraryStore.setState({
        folders: { [F]: { ...folder, photos: { ...folder.photos } } },
      }),
    );
    press({ key: 'k' });
    expect(panes(container).map((p) => p.dataset.zoom)).toEqual(['1', '1']);
  });

  it('Tab on a button outside the panes keeps its meaning; anywhere else it switches the pane', () => {
    render(
      <>
        <button type="button">Filter</button>
        <CullView />
      </>,
    );
    act(() => useUiStore.getState().openReview(ids(), 0));
    press({ key: 'c' });
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Filter' }), { key: 'Tab' })).toBe(true);
    expect(
      screen
        .getByRole('region', { name: /^Compare/ })
        .querySelector('[data-focused]')
        ?.getAttribute('data-side'),
    ).toBe('candidate');
    expect(fireEvent.keyDown(window, { key: 'Tab' })).toBe(false);
    expect(
      screen
        .getByRole('region', { name: /^Compare/ })
        .querySelector('[data-focused]')
        ?.getAttribute('data-side'),
    ).toBe('select');
  });

  it('ends when only the select leaves the list', () => {
    open(0);
    press({ key: 'c' });
    act(() => useUiStore.getState().updateSessionIds('review', [key('a.jpg'), key('c.jpg'), key('d.jpg')], 0));
    expect(cull().view).toBe('grid');
    expect(cull().compare).toBeUndefined();
  });

  it('shows proxies and never an original', () => {
    const { container } = open(0);
    press({ key: 'c' });
    const sources = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(sources).toEqual(['asset://c/a.jpg/proxy.jpg', 'asset://c/b.jpg/proxy.jpg']);
  });

  it('ends when the photos leave the list (a filter changed under it)', () => {
    open(0);
    press({ key: 'c' });
    act(() => useUiStore.getState().updateSessionIds('review', [key('e.jpg'), key('f.jpg')], 0));
    expect(cull().view).toBe('grid');
    expect(cull().compare).toBeUndefined();
  });

  it('keeps text fields out of the keys', () => {
    render(
      <>
        <input aria-label="Search" />
        <CullView />
      </>,
    );
    act(() => useUiStore.getState().openReview(ids(), 0));
    press({ key: 'c' });
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'ArrowRight' });
    expect(cull().compare?.candidate).toBe(key('a.jpg'));
  });

  it('compare keys are in the table and parse', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '' };
    expect(compareKeyAction({ ...base, key: 'Enter', metaKey: true })).toEqual({ type: 'promote' });
    expect(compareKeyAction({ ...base, key: 'Tab' })).toEqual({ type: 'pane' });
    expect(compareKeyAction({ ...base, key: 'F', shiftKey: true })).toEqual({ type: 'fit' });
    expect(compareKeyAction({ ...base, key: 'f' })).toBeNull();
    expect(compareKeyAction({ ...base, key: 'k' })).toEqual({ type: 'zoom', dir: 1 });
    expect(COMPARE_KEYS.map((k) => k.keys)).toContain('Cmd+Enter');
    expect(SURVEY_KEYS.map((k) => k.keys)).toContain('X');
  });
});

describe('Survey', () => {
  const tiles = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));

  it('N opens on the selection in grid order', () => {
    open(0);
    act(() => useUiStore.getState().setSelection([key('e.jpg'), key('b.jpg'), key('d.jpg')]));
    press({ key: 'n' });
    expect(screen.getByRole('region', { name: 'Survey: 3 photos' })).toBeTruthy();
    expect(tiles()).toEqual(['b.jpg', 'd.jpg', 'e.jpg']);
  });

  it('N uses the picks when nothing is selected, and does nothing for fewer than two', () => {
    const library = emptyLibrary();
    library.photos['h-a.jpg'] = { flag: 'pick', versions: {} };
    open(0, library);
    press({ key: 'n' });
    expect(cull().view).toBe('grid');
    act(() => {
      useBookStore.setState({
        libraries: {
          '/trip': {
            ...library,
            photos: {
              ...library.photos,
              'h-d.jpg': { flag: 'pick', versions: {} },
              'h-b.jpg': { flag: 'pick', versions: {} },
            },
          },
        },
      });
    });
    press({ key: 'n' });
    expect(tiles()).toEqual(['a.jpg', 'b.jpg', 'd.jpg']);
  });

  it('X rejects the focused photo and removes its tile, in one library write and no undo step', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
    press({ key: 'n' });
    press({ key: 'ArrowRight' });
    const past = useBookStore.temporal.getState().pastStates.length;
    let updates = 0;
    const stop = useBookStore.subscribe((s, prev) => {
      if (s.libraries !== prev.libraries) updates += 1;
    });
    press({ key: 'x' });
    stop();
    expect(updates).toBe(1);
    expect(photoOf('b.jpg')?.flag).toBe('reject');
    expect(tiles()).toEqual(['a.jpg', 'c.jpg']);
    expect(cull().survey?.ids).toEqual(['a.jpg', 'c.jpg'].map(key));
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);
    // The focus moved on to the next survivor: stars act on it.
    press({ key: '4', code: 'Digit4' });
    expect(photoOf('c.jpg')?.rating).toBe(4);
    expect(photoOf('a.jpg')?.rating).toBeUndefined();
  });

  it('the last photo refuses X; Esc leaves with the survivors selected and the grid on them', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'c.jpg', 'e.jpg'].map(key)));
    press({ key: 'n' });
    press({ key: 'x' });
    press({ key: 'x' });
    expect(tiles()).toEqual(['e.jpg']);
    expect(screen.getByText('One photo remains')).toBeTruthy();
    press({ key: 'x' });
    expect(photoOf('e.jpg')?.flag).toBeUndefined();
    expect(tiles()).toEqual(['e.jpg']);

    press({ key: 'Escape' });
    expect(cull().view).toBe('grid');
    expect(cull().survey).toBeUndefined();
    expect(selected()).toEqual([key('e.jpg')]);
    expect(photoOf('a.jpg')?.flag).toBe('reject');
    expect(photoOf('c.jpg')?.flag).toBe('reject');
    expect(screen.getByRole('option', { name: 'e.jpg' }).getAttribute('aria-selected')).toBe('true');
    expect(useUiStore.getState().review?.index).toBe(4);
  });

  it('Esc with several left selects all of them', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(key)));
    press({ key: 'n' });
    press({ key: 'x' });
    press({ key: 'Escape' });
    expect(selected()).toEqual(['b.jpg', 'c.jpg', 'd.jpg'].map(key));
  });

  it('click focuses a tile, Shift+click marks tiles and X removes the marked ones in one write', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(key)));
    press({ key: 'n' });
    fireEvent.click(screen.getByRole('option', { name: 'c.jpg' }));
    expect(screen.getByRole('option', { name: 'c.jpg' }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('option', { name: 'a.jpg' }), { shiftKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'b.jpg' }), { shiftKey: true });
    expect(screen.getByRole('option', { name: 'a.jpg' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/2 marked/)).toBeTruthy();
    let updates = 0;
    const stop = useBookStore.subscribe((s, prev) => {
      if (s.libraries !== prev.libraries) updates += 1;
    });
    press({ key: 'x' });
    stop();
    expect(updates).toBe(1);
    expect(tiles()).toEqual(['c.jpg', 'd.jpg']);
    expect(photoOf('a.jpg')?.flag).toBe('reject');
    expect(photoOf('b.jpg')?.flag).toBe('reject');
    expect(photoOf('c.jpg')?.flag).toBeUndefined();
  });

  it('rates the marked photos together', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
    press({ key: 'n' });
    fireEvent.click(screen.getByRole('option', { name: 'a.jpg' }), { shiftKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'c.jpg' }), { shiftKey: true });
    press({ key: '2', code: 'Digit2' });
    expect(photoOf('a.jpg')?.rating).toBe(2);
    expect(photoOf('c.jpg')?.rating).toBe(2);
    expect(photoOf('b.jpg')?.rating).toBeUndefined();
    // Marked photos stay put: the focus did not advance.
    expect(screen.getByRole('option', { name: 'a.jpg' }).getAttribute('aria-current')).toBe('true');
  });

  it('with auto-advance a rating moves the focus to the next tile, and Shift inverts it', () => {
    useUiStore.setState({ reviewAutoAdvance: true });
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
    press({ key: 'n' });
    const focused = () =>
      screen
        .getAllByRole('option')
        .find((o) => o.getAttribute('aria-current') === 'true')
        ?.getAttribute('aria-label');
    expect(focused()).toBe('a.jpg');
    press({ key: '3', code: 'Digit3' });
    expect(photoOf('a.jpg')?.rating).toBe(3);
    expect(focused()).toBe('b.jpg');
    press({ key: '4', code: 'Digit4', shiftKey: true });
    expect(photoOf('b.jpg')?.rating).toBe(4);
    expect(focused()).toBe('b.jpg');
    press({ key: 'p' });
    expect(photoOf('b.jpg')?.flag).toBe('pick');
    expect(focused()).toBe('c.jpg');
  });

  it('without auto-advance the focus stays, and Shift advances', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg'].map(key)));
    press({ key: 'n' });
    press({ key: '3', code: 'Digit3' });
    expect(screen.getByRole('option', { name: 'a.jpg' }).getAttribute('aria-current')).toBe('true');
    press({ key: '2', code: 'Digit2', shiftKey: true });
    expect(screen.getByRole('option', { name: 'b.jpg' }).getAttribute('aria-current')).toBe('true');
  });

  it('X on marked photos that include the focused one removes them all and focuses the next survivor', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(key)));
    press({ key: 'n' });
    // The focus is on a: mark a and c.
    fireEvent.click(screen.getByRole('option', { name: 'a.jpg' }), { shiftKey: true });
    fireEvent.click(screen.getByRole('option', { name: 'c.jpg' }), { shiftKey: true });
    press({ key: 'x' });
    expect(tiles()).toEqual(['b.jpg', 'd.jpg']);
    expect(photoOf('a.jpg')?.flag).toBe('reject');
    expect(photoOf('c.jpg')?.flag).toBe('reject');
    expect(screen.getByRole('option', { name: 'b.jpg' }).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByText(/marked/)).toBeNull();
  });

  it('marks that cover every tile refuse X: nothing is rejected and nothing leaves', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
    press({ key: 'n' });
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) {
      fireEvent.click(screen.getByRole('option', { name }), { shiftKey: true });
    }
    press({ key: 'x' });
    expect(tiles()).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(photoOf('a.jpg')).toBeUndefined();
    expect(screen.getByText(/3 marked/)).toBeTruthy();
  });

  it('arrows move the focus and D develops it', () => {
    const onDevelop = vi.fn();
    render(<CullView onDevelop={onDevelop} />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
    press({ key: 'n' });
    press({ key: 'ArrowRight' });
    press({ key: 'End' });
    press({ key: 'd' });
    expect(onDevelop).toHaveBeenCalledWith(key('c.jpg'));
  });

  it('ends when no survey photo is left in the list', () => {
    open(0);
    act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg'].map(key)));
    press({ key: 'n' });
    act(() => useUiStore.getState().updateSessionIds('review', [key('e.jpg'), key('f.jpg')], 0));
    expect(cull().view).toBe('grid');
  });

  it('removes a tile through a view transition where the browser has one, a cut otherwise (plan 47)', () => {
    const start = vi.fn((cb: () => void) => cb());
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start });
    try {
      open(0);
      act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
      press({ key: 'n' });
      const names = screen.getAllByRole('option').map((o) => o.style.getPropertyValue('view-transition-name'));
      expect(new Set(names).size).toBe(3);
      press({ key: 'x' });
      expect(start).toHaveBeenCalledTimes(1);
      expect(tiles()).toEqual(['b.jpg', 'c.jpg']);
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
    // Without it (jsdom, an older WebKit) the tile goes at once.
    press({ key: 'x' });
    expect(tiles()).toEqual(['c.jpg']);
  });

  it('a second X before the transition has updated the DOM still removes the next photo (plan 47)', () => {
    const pending: Array<() => void> = [];
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (cb: () => void) => {
        pending.push(cb);
      },
    });
    try {
      open(0);
      act(() => useUiStore.getState().setSelection(['a.jpg', 'b.jpg', 'c.jpg'].map(key)));
      press({ key: 'n' });
      press({ key: 'x' });
      press({ key: 'x' });
      act(() => {
        for (const cb of pending) cb();
      });
      expect(tiles()).toEqual(['c.jpg']);
      expect(photoOf('a.jpg')?.flag).toBe('reject');
      expect(photoOf('b.jpg')?.flag).toBe('reject');
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });
});
