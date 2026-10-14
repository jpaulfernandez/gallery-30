// @vitest-environment jsdom
import { createDevelop, emptyLibrary, type Library } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoStats } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { libraryKeys, matchesFilter } from '../../store/collections';
import { useCullStore } from '../../store/cull';
import { BREAK_MS, freshDecide, PAUSE_AFTER_DECISIONS, PAUSE_AFTER_MS, targetCount } from '../../store/decide';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { LibraryFilterBar } from '../shell/LibraryFilterBar';
import { CulledMark } from './CulledMark';
import { CullFilters } from './CullFilters';
import { CullStage, CullView } from './CullView';
import { tileCentre, zoomCentre } from './DecideView';
import { CULL_KEYS, cullKeyAction, DECIDE_KEYS, decideKeyAction } from './keys';
import { closeRejectPile, useRejectPileStore } from './rejectPile';

const F = 'F1';
const SOURCE = { kind: 'folder', id: F } as const;
const key = (name: string) => photoKey({ folder: F, path: name });
const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);
const HASH = 'a5a5a5a5c3c3c3c3';

const stats = (sharpnessMax: number): PhotoStats => ({
  sharpness: 100,
  sharpnessMax,
  sharpestTile: 27,
  motion: 0.2,
  clipHigh: 0,
  clipLow: 0,
  medianLum: 0.4,
});

const photo = (relPath: string, taken: number, phash: string, sharpnessMax = 300): PhotoFile => ({
  relPath,
  size: 1,
  mtime: taken,
  kind: 'jpeg',
  hash: `h-${relPath}`,
  width: 1200,
  height: 800,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
  proxyUrl: `asset://c/${relPath}/proxy.jpg`,
  taken,
  make: 'Fujifilm',
  model: 'X-T5',
  lens: 'XF33mmF1.4',
  focal: 33,
  phash,
  stats: stats(sharpnessMax),
});

/** By capture time: s1 s2, a burst of five (b3 the sharpest), s3. Units: s1, s2, the group, s3. */
const PHOTOS = [
  photo('s1.jpg', T0 - 600_000, '0f0f0f0f0f0f0f0f'),
  photo('s2.jpg', T0 - 300_000, 'f0f0f0f0f0f0f0f0'),
  photo('b1.jpg', T0, HASH, 300),
  photo('b2.jpg', T0 + 200, HASH, 310),
  photo('b3.jpg', T0 + 400, HASH, 500),
  photo('b4.jpg', T0 + 600, HASH, 450),
  photo('b5.jpg', T0 + 800, HASH, 320),
  photo('s3.jpg', T0 + 600_000, '3333333333333333'),
];
const BURST = ['b1.jpg', 'b2.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg'];

function setFolder(library: Library = emptyLibrary(), photos: PhotoFile[] = PHOTOS) {
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: Object.fromEntries(photos.map((p) => [p.relPath, p])),
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': library } });
}

/** A library with these photos flagged. */
function flagged(flags: Record<string, 'pick' | 'reject'>): Library {
  const library = emptyLibrary();
  for (const [name, flag] of Object.entries(flags)) library.photos[`h-${name}`] = { flag, versions: {} };
  return library;
}

const keysFor = (view: Partial<typeof DEFAULT_FILMSTRIP> = {}) =>
  libraryKeys(SOURCE, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    ...view,
  });

const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);
const flagOf = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`]?.flag;
const shown = () => {
  const review = useUiStore.getState().review;
  return review?.ids[review.index];
};
const progress = () => screen.getByRole('status', { name: 'Progress' }).textContent;
const log = () => useUiStore.getState().cull.decide?.log ?? [];

/** Render the Cull stage on the list, focus `at` and press Enter (Decide opens). */
function openOn(name: string, ids = keysFor()) {
  render(<CullView />);
  act(() => useUiStore.getState().openReview(ids, ids.indexOf(key(name))));
  press({ key: 'Enter' });
  expect(useUiStore.getState().cull.view).toBe('decide');
}

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
    libraryView: DEFAULT_FILMSTRIP,
  });
  useCullStore.setState({ spacing: 'normal', shown: {} });
  setFolder();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('Decide: keys', () => {
  it('P on a group of five writes one library update (one kept, four rejected) and advances to the next unit', () => {
    openOn('s2.jpg');
    // The group opens on its suggested best.
    press({ key: 'ArrowRight' });
    expect(shown()).toBe(key('b3.jpg'));
    const past = useBookStore.temporal.getState().pastStates.length;
    let writes = 0;
    const stop = useBookStore.subscribe((s, prev) => {
      if (s.libraries !== prev.libraries) writes += 1;
    });
    press({ key: 'p' });
    stop();
    expect(writes).toBe(1);
    expect(BURST.map(flagOf)).toEqual(['reject', 'reject', 'pick', 'reject', 'reject']);
    expect(shown()).toBe(key('s3.jpg'));
    // Flags are not undo steps: the pass has its own log.
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);
    expect(log()).toHaveLength(1);
    expect(progress()).toContain('5 / 8 decided · 1 kept');
  });

  it('Shift+P keeps the shown frame only and steps to the next undecided frame', () => {
    openOn('b3.jpg');
    press({ key: 'P', shiftKey: true });
    expect(BURST.map(flagOf)).toEqual([undefined, undefined, 'pick', undefined, undefined]);
    expect(shown()).toBe(key('b4.jpg'));
    // On a single photo Shift+P stays.
    press({ key: 'ArrowRight' });
    expect(shown()).toBe(key('s3.jpg'));
    press({ key: 'P', shiftKey: true });
    expect(flagOf('s3.jpg')).toBe('pick');
    expect(shown()).toBe(key('s3.jpg'));
  });

  it('X steps inside the group, and X on its last undecided frame advances', () => {
    setFolder(flagged({ 'b1.jpg': 'reject', 'b2.jpg': 'reject', 'b5.jpg': 'pick' }));
    openOn('b3.jpg');
    expect(shown()).toBe(key('b3.jpg'));
    press({ key: 'x' });
    expect(flagOf('b3.jpg')).toBe('reject');
    expect(shown()).toBe(key('b4.jpg'));
    press({ key: 'x' });
    expect(flagOf('b4.jpg')).toBe('reject');
    // The group is decided: on to the next unit with an undecided photo.
    expect(shown()).toBe(key('s3.jpg'));
    // X on a single photo rejects it and advances (wrapping to the first undecided unit).
    press({ key: 'x' });
    expect(flagOf('s3.jpg')).toBe('reject');
    expect(shown()).toBe(key('s1.jpg'));
  });

  it('Shift+X rejects every undecided frame of the group and advances', () => {
    setFolder(flagged({ 'b2.jpg': 'pick' }));
    openOn('b3.jpg');
    press({ key: 'X', shiftKey: true });
    expect(BURST.map(flagOf)).toEqual(['reject', 'pick', 'reject', 'reject', 'reject']);
    expect(shown()).toBe(key('s3.jpg'));
  });

  it('U reverts exactly the last decision, a group decision included, and shows its photo again', () => {
    openOn('s1.jpg');
    press({ key: 'p' });
    expect(flagOf('s1.jpg')).toBe('pick');
    expect(shown()).toBe(key('s2.jpg'));
    press({ key: 'ArrowRight' });
    expect(shown()).toBe(key('b3.jpg'));
    press({ key: 'p' });
    expect(BURST.map(flagOf)).toEqual(['reject', 'reject', 'pick', 'reject', 'reject']);
    press({ key: 'u' });
    expect(BURST.map(flagOf)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(flagOf('s1.jpg')).toBe('pick');
    expect(shown()).toBe(key('b3.jpg'));
    press({ key: 'u' });
    expect(flagOf('s1.jpg')).toBeUndefined();
    expect(shown()).toBe(key('s1.jpg'));
    // An empty log: U does nothing.
    press({ key: 'u' });
    expect(log()).toHaveLength(0);
  });

  it('← → skip units without deciding: the counter does not move', () => {
    openOn('s1.jpg');
    const before = progress();
    press({ key: 'ArrowRight' });
    expect(shown()).toBe(key('s2.jpg'));
    press({ key: 'ArrowRight' });
    expect(shown()).toBe(key('b3.jpg'));
    press({ key: 'ArrowLeft' });
    expect(shown()).toBe(key('s2.jpg'));
    expect(progress()).toBe(before);
    expect(log()).toHaveLength(0);
  });

  it(', and . step the group frames, wrapping', () => {
    openOn('b3.jpg');
    press({ key: '.' });
    expect(shown()).toBe(key('b4.jpg'));
    press({ key: '.' });
    press({ key: '.' });
    expect(shown()).toBe(key('b1.jpg'));
    press({ key: ',' });
    expect(shown()).toBe(key('b5.jpg'));
    expect(screen.getByRole('group', { name: 'Frames of the group' })).toBeTruthy();
  });

  it('Space shows 100 % at the sharpest tile, a second press fits', () => {
    expect(tileCentre(27)).toEqual({ cx: 0.4375, cy: 0.4375 });
    expect(tileCentre(undefined)).toEqual({ cx: 0.5, cy: 0.5 });
    openOn('s1.jpg');
    const picture = () => screen.getByRole('img', { name: 's1.jpg' }).parentElement as HTMLElement;
    expect(picture().dataset.zoom).toBe('fit');
    press({ key: ' ' });
    expect(picture().dataset.zoom).toBe('1');
    expect(picture().dataset.center).toBe('0.438,0.438');
    press({ key: ' ' });
    expect(picture().dataset.zoom).toBe('fit');
  });

  it('Space on an edited photo (crop, rotate, flip, straighten…) zooms on the centre, not the tile', () => {
    const rotated = createDevelop();
    rotated.geometry.rotate = 90;
    const cropped = createDevelop();
    cropped.geometry.crop = { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 2, aspect: 'free' };
    const toned = createDevelop();
    toned.light.exposure = 1;
    expect(zoomCentre(rotated, 27)).toEqual({ cx: 0.5, cy: 0.5 });
    expect(zoomCentre(cropped, 27)).toEqual({ cx: 0.5, cy: 0.5 });
    // An edit that moves no pixel keeps the tile.
    expect(zoomCentre(toned, 27)).toEqual(tileCentre(27));
    expect(zoomCentre(undefined, 27)).toEqual(tileCentre(27));
    const library = emptyLibrary();
    library.photos['h-s1.jpg'] = { develop: rotated, versions: {} };
    setFolder(library);
    openOn('s1.jpg');
    const picture = screen.getByRole('img', { name: 's1.jpg' }).parentElement as HTMLElement;
    press({ key: ' ' });
    expect(picture.dataset.zoom).toBe('1');
    expect(picture.dataset.center).toBe('0.500,0.500');
  });

  it('C compares the shown frame with the best, and Esc comes back to Decide; Esc in Decide goes to the grid', () => {
    openOn('b3.jpg');
    press({ key: '.' });
    expect(shown()).toBe(key('b4.jpg'));
    press({ key: 'c' });
    expect(useUiStore.getState().cull.view).toBe('compare');
    expect(useUiStore.getState().cull.compare).toMatchObject({ candidate: key('b4.jpg'), select: key('b3.jpg') });
    press({ key: 'Escape' });
    expect(useUiStore.getState().cull.view).toBe('decide');
    press({ key: 'Escape' });
    expect(useUiStore.getState().cull.view).toBe('grid');
    // The grid is focused on the unit Decide left.
    // Plan 47: the focused cell is the listbox's active descendant (the grid draws one sliding focus ring).
    expect(screen.getByRole('listbox', { name: 'Photos' }).getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'b4.jpg, group of 5' }).id,
    );
  });

  it('D develops the photo shown', () => {
    const onDevelop = vi.fn();
    const ids = keysFor();
    render(<CullView onDevelop={onDevelop} />);
    act(() => useUiStore.getState().openReview(ids, 1));
    press({ key: 'Enter' });
    press({ key: 'd' });
    expect(onDevelop).toHaveBeenCalledWith(key('s2.jpg'));
  });
});

describe('Decide: edges', () => {
  it('U after a filter change leaves the photo shown alone when its photo left the list', () => {
    openOn('s1.jpg');
    press({ key: 'p' });
    expect(shown()).toBe(key('s2.jpg'));
    // A filter now hides s1 (the photo of the last decision).
    const narrower = keysFor().filter((id) => id !== key('s1.jpg'));
    act(() => useUiStore.getState().updateSessionIds('review', narrower, narrower.indexOf(key('s3.jpg'))));
    press({ key: 'u' });
    expect(flagOf('s1.jpg')).toBeUndefined();
    expect(shown()).toBe(key('s3.jpg'));
  });

  it('reopening a pass after a break of 15 minutes restarts the nudge clock and keeps the log', () => {
    vi.useFakeTimers({ now: T0 });
    openOn('s1.jpg');
    press({ key: 'p' });
    press({ key: 'Escape' });
    // An hour in the grid: no nudge at once on coming back.
    act(() => vi.advanceTimersByTime(60 * 60_000));
    press({ key: 'Enter' });
    expect(useUiStore.getState().cull.decide?.startedAt).toBe(T0 + 60 * 60_000);
    expect(log()).toHaveLength(1);
    expect(screen.queryByText('Good place to stop?')).toBeNull();
    // Back within the break: the clock runs on.
    press({ key: 'Escape' });
    act(() => vi.advanceTimersByTime(BREAK_MS - 1000));
    press({ key: 'Enter' });
    expect(useUiStore.getState().cull.decide?.startedAt).toBe(T0 + 60 * 60_000);
  });
});

describe('Decide: progress and the end', () => {
  it('the end state appears when no photo is undecided, stamps culledAt, and goes when U brings one back', () => {
    setFolder(
      flagged({
        's1.jpg': 'pick',
        's2.jpg': 'reject',
        'b1.jpg': 'reject',
        'b2.jpg': 'reject',
        'b3.jpg': 'pick',
        'b4.jpg': 'reject',
        'b5.jpg': 'reject',
      }),
    );
    openOn('s3.jpg');
    expect(screen.queryByText(/^Culled:/)).toBeNull();
    press({ key: 'p' });
    expect(screen.getByText('Culled: 3 kept, 5 rejected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review rejects…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rate the keepers' })).toBeTruthy();
    expect(useBookStore.getState().libraries['/trip']?.cull?.culledAt).toEqual(expect.any(String));
    press({ key: 'u' });
    expect(screen.queryByText(/^Culled:/)).toBeNull();
    expect(shown()).toBe(key('s3.jpg'));
  });

  it('Rate the keepers surveys the picks; Review rejects… opens the reject pile (plan 42)', () => {
    setFolder(flagged(Object.fromEntries(PHOTOS.map((p, i) => [p.relPath, i % 2 ? 'reject' : 'pick'] as const))));
    openOn('s1.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Rate the keepers' }));
    expect(useUiStore.getState().cull).toMatchObject({ view: 'survey', survey: { ids: expect.any(Array) } });
    expect(useUiStore.getState().cull.survey?.ids).toHaveLength(4);
    act(() => useUiStore.getState().setCull({ view: 'decide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review rejects…' }));
    expect(useRejectPileStore.getState().open).toBe(true);
    expect(screen.getByRole('region', { name: 'Rejects: 4 photos' })).toBeTruthy();
    act(() => closeRejectPile());
    expect(useUiStore.getState().cull.view).toBe('decide');
  });

  it('a target as a share computes against the list', () => {
    expect(targetCount({ share: 0.1 }, 600)).toBe(60);
    expect(targetCount(60, 10)).toBe(60);
    expect(targetCount(undefined, 10)).toBeUndefined();
    setFolder({ ...flagged({ 's1.jpg': 'pick' }), cull: { target: { share: 0.25 } } });
    openOn('s2.jpg');
    // Eight photos in the list: a quarter is two.
    expect(progress()).toBe('1 / 8 decided · 1 kept of ~2');
    // Filtered to four photos, the same share is one.
    cleanup();
    openOn('s1.jpg', keysFor({ query: 's' }));
    expect(progress()).toBe('1 / 3 decided · 1 kept of ~1');
  });

  it('the Target popover writes the folder library outside undo', () => {
    openOn('s1.jpg');
    const past = useBookStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByRole('button', { name: 'Target ▾' }));
    fireEvent.change(screen.getByLabelText('Photos to keep'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(useBookStore.getState().libraries['/trip']?.cull?.target).toBe(3);
    expect(progress()).toContain('0 kept of ~3');
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);
  });

  it('the pause nudge fires at 300 decisions in a test clock and after 45 minutes, and never takes the focus', () => {
    vi.useFakeTimers({ now: T0 });
    openOn('s1.jpg');
    const root = screen.getByRole('region', { name: /^Decide/ });
    expect(document.activeElement).toBe(root);
    act(() => useUiStore.getState().setCull({ decide: { ...freshDecide(T0), decisions: PAUSE_AFTER_DECISIONS - 1 } }));
    expect(screen.queryByText('Good place to stop?')).toBeNull();
    press({ key: 'p' });
    expect(screen.getByText('Good place to stop?')).toBeTruthy();
    expect(document.activeElement).toBe(root);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Good place to stop?')).toBeNull();
    // A new pass, timed: nothing before 45 minutes, the line after.
    act(() => useUiStore.getState().setCull({ decide: freshDecide(Date.now()) }));
    act(() => vi.advanceTimersByTime(PAUSE_AFTER_MS - 1000));
    expect(screen.queryByText('Good place to stop?')).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Good place to stop?')).toBeTruthy();
    expect(document.activeElement).toBe(root);
  });

  it('the decision log survives a stage switch and is dropped on a source change', () => {
    const ids = keysFor();
    const first = render(<CullStage sourceKey="folder:F1" />);
    act(() => useUiStore.getState().openReview(ids, 0));
    press({ key: 'Enter' });
    press({ key: 'p' });
    expect(log()).toHaveLength(1);
    // Develop and back: the route closes the session and opens it again on the photo shown.
    first.unmount();
    act(() => useUiStore.getState().closeReview());
    render(<CullStage sourceKey="folder:F1" />);
    act(() => useUiStore.getState().openReview(ids, 1));
    expect(useUiStore.getState().cull.view).toBe('decide');
    expect(log()).toHaveLength(1);
    press({ key: 'u' });
    expect(flagOf('s1.jpg')).toBeUndefined();
    press({ key: 'p' });
    cleanup();
    // Another source: the grid, no pass.
    render(<CullStage sourceKey="folder:F2" />);
    expect(useUiStore.getState().cull.view).toBe('grid');
    expect(useUiStore.getState().cull.decide).toBeUndefined();
  });
});

describe('Decide: the grid, the filter bar and the sidebar', () => {
  it('keyboard parity, extended: Enter opens Decide, Space Review; every Decide key has a README row', () => {
    const plain = { code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
    expect(cullKeyAction({ ...plain, key: 'Enter' })).toEqual({ type: 'decide' });
    expect(cullKeyAction({ ...plain, key: ' ' })).toEqual({ type: 'review' });
    expect(CULL_KEYS.map((k) => k.keys)).toEqual(expect.arrayContaining(['Enter', 'Space']));
    const pressOf: Record<string, Partial<typeof plain> & { key: string }> = {
      P: { key: 'p' },
      'Shift+P': { key: 'P', shiftKey: true },
      X: { key: 'x' },
      'Shift+X': { key: 'X', shiftKey: true },
      U: { key: 'u' },
      ', / .': { key: '.' },
      '← →': { key: 'ArrowRight' },
      Space: { key: ' ' },
      C: { key: 'c' },
      D: { key: 'd' },
      Esc: { key: 'Escape' },
    };
    expect(DECIDE_KEYS.map((k) => k.keys).sort()).toEqual(Object.keys(pressOf).sort());
    for (const row of DECIDE_KEYS) {
      const init = pressOf[row.keys];
      expect(init && decideKeyAction({ ...plain, ...init }), row.keys).not.toBeNull();
    }
    // Space in the grid keeps opening Review.
    const ids = keysFor();
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, 0));
    press({ key: ' ' });
    expect(useUiStore.getState().cull.view).toBe('review');
  });

  it('the filter bar has Decide and the progress fraction, the fragment Stars; the grid hides stars without it', () => {
    setFolder(flagged({ 's1.jpg': 'pick', 's2.jpg': 'reject' }));
    const library = useBookStore.getState().libraries['/trip'] as Library;
    library.photos['h-s3.jpg'] = { rating: 4, versions: {} };
    const ids = keysFor();
    // Plan 51 moved Decide and the fraction into the bar and the fragment into the sidebar (plan 47 took them out of it).
    render(
      <>
        <LibraryFilterBar count={ids.length} progress={null} projectOpen={false} filtersInSidebar />
        <CullFilters />
        <CullStage sourceKey="folder:F1" />
      </>,
    );
    act(() => useUiStore.getState().openReview(ids, 0));
    expect(screen.getByText('2/8 decided')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Decide' })).toHaveLength(1);
    expect(screen.queryByRole('img', { name: '4 stars' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stars' }));
    expect(screen.getByRole('img', { name: '4 stars' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(useUiStore.getState().cull.view).toBe('decide');
    // Decide opens on the focused unit's next undecided photo.
    expect(shown()).toBe(key('b3.jpg'));
  });

  it('the Undecided filter keeps the photos with no flag', () => {
    setFolder(flagged({ 's1.jpg': 'pick', 'b1.jpg': 'reject' }));
    expect(keysFor({ flag: 'undecided', sort: 'name' })).toEqual(
      ['b2.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg', 's2.jpg', 's3.jpg'].map(key),
    );
    const filter = { query: '', flag: 'undecided' as const, minRating: 0 };
    expect(matchesFilter(filter, PHOTOS[0] as PhotoFile, { flag: 'pick', versions: {} })).toBe(false);
    expect(matchesFilter(filter, PHOTOS[0] as PhotoFile, { rating: 3, versions: {} })).toBe(true);
  });

  it('the sidebar check shows when culledAt is set and no photo is undecided, and goes when a new photo arrives', () => {
    const all = Object.fromEntries(PHOTOS.map((p) => [p.relPath, 'reject'] as const));
    setFolder({ ...flagged(all), cull: { culledAt: '2026-10-13T10:00:00.000Z' } });
    render(<CulledMark folderId={F} />);
    expect(screen.getByRole('img', { name: 'Culled' })).toBeTruthy();
    act(() =>
      setFolder({ ...flagged(all), cull: { culledAt: '2026-10-13T10:00:00.000Z' } }, [
        ...PHOTOS,
        photo('new.jpg', T0 + 900_000, '1111111111111111'),
      ]),
    );
    expect(screen.queryByRole('img', { name: 'Culled' })).toBeNull();
  });
});
