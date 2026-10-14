// @vitest-environment jsdom
import { emptyLibrary, type Library, parseLibrary, serializeLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhotoStats } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { libraryKeys } from '../../store/collections';
import { cullGroups, cullUnits, detach, mergeSelected, splitGroup, useCullStore } from '../../store/cull';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { CullFilters } from './CullFilters';
import { CullGrid } from './CullGrid';
import { CullStage, CullView } from './CullView';
import { CULL_KEYS, cullKeyAction } from './keys';

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

/**
 * Two singles, a burst of five (b3 the sharpest, b4 the sharpest after it), a single after: by capture time
 * s1 s2 b1 b2 b3 b4 b5 s3. The singles are minutes apart with unrelated hashes.
 */
function folderPhotos(extra = 0): PhotoFile[] {
  // `extra` singles a minute apart before everything else (too far apart to group), to push the burst down the grid.
  const early = Array.from({ length: extra }, (_, i) =>
    photo(`a${String(i).padStart(2, '0')}.jpg`, T0 - 3_600_000 + i * 60_000, HASH),
  );
  return [
    ...early,
    photo('s1.jpg', T0 - 600_000, '0f0f0f0f0f0f0f0f'),
    photo('s2.jpg', T0 - 300_000, 'f0f0f0f0f0f0f0f0'),
    photo('b1.jpg', T0, HASH, 300),
    photo('b2.jpg', T0 + 200, HASH, 310),
    photo('b3.jpg', T0 + 400, HASH, 500),
    photo('b4.jpg', T0 + 600, HASH, 450),
    photo('b5.jpg', T0 + 800, HASH, 320),
    photo('s3.jpg', T0 + 600_000, '3333333333333333'),
  ];
}

function setFolder(library: Library = emptyLibrary(), extra = 0) {
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: Object.fromEntries(folderPhotos(extra).map((p) => [p.relPath, p])),
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': library } });
}

const keysFor = (view: Partial<typeof DEFAULT_FILMSTRIP> = {}) =>
  libraryKeys(SOURCE, useLibraryStore.getState().folders, useBookStore.getState().libraries, {
    ...DEFAULT_FILMSTRIP,
    ...view,
  });

const groupsNow = (ids: readonly string[]) =>
  cullGroups(ids, {
    folders: useLibraryStore.getState().folders,
    libraries: useBookStore.getState().libraries,
    files: {},
    spacing: useCullStore.getState().spacing,
  });

const options = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);
const selected = () => useUiStore.getState().selection.keys;
const focusedId = () => {
  const review = useUiStore.getState().review;
  return review?.ids[review.index];
};
const entry = (name: string) => useBookStore.getState().libraries['/trip']?.photos[`h-${name}`];

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
  useCullStore.setState({ spacing: 'normal', shown: {} });
  setFolder();
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('Cull groups in the grid', () => {
  it('shows a burst as one cell on its suggested best, and every photo when Group is off', () => {
    const ids = keysFor();
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    expect(options()).toEqual(['s1.jpg', 's2.jpg', 'b3.jpg, group of 5', 's3.jpg']);
    act(() => useUiStore.getState().setCull({ grouped: false }));
    expect(options()).toHaveLength(8);
  });

  it('a filter that matches two of five frames shows a group cell of two', () => {
    const library = emptyLibrary();
    for (const name of ['b2.jpg', 'b4.jpg', 's1.jpg']) library.photos[`h-${name}`] = { flag: 'pick', versions: {} };
    setFolder(library);
    const picks = keysFor({ flag: 'picks' });
    expect(picks).toEqual(['s1.jpg', 'b2.jpg', 'b4.jpg'].map(key));
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(picks, 0));
    // b3 (the best) is filtered out: the best of the two shown is b4.
    expect(options()).toEqual(['s1.jpg', 'b4.jpg, group of 2']);
    // Both shown frames are kept: the badge counts them.
    expect(screen.getByRole('button', { name: 'Open the group of 2: 2 kept, 0 rejected' })).toBeTruthy();
  });

  it('Cmd+A under a filter selects photos, not groups; Cmd+G selects the focused group', () => {
    const library = emptyLibrary();
    for (const name of ['b1.jpg', 'b2.jpg', 'b5.jpg', 's3.jpg']) {
      library.photos[`h-${name}`] = { flag: 'pick', versions: {} };
    }
    setFolder(library);
    const picks = keysFor({ flag: 'picks' });
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(picks, 0));
    expect(options()).toHaveLength(2);
    press({ key: 'a', metaKey: true });
    expect([...selected()].sort()).toEqual(['b1.jpg', 'b2.jpg', 'b5.jpg', 's3.jpg'].map(key).sort());
    press({ key: 'Escape' });
    press({ key: 'g', metaKey: true });
    expect(selected()).toEqual(['b1.jpg', 'b2.jpg', 'b5.jpg'].map(key));
  });

  it('G opens the focused group in place and closes it, keeping the focus', () => {
    const ids = keysFor();
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b4.jpg'))));
    expect(options()).toContain('b4.jpg, group of 5');
    press({ key: 'g' });
    expect(useUiStore.getState().cull.expanded).toBe(key('b1.jpg'));
    expect(options()).toEqual(['s1.jpg', 's2.jpg', 'b1.jpg', 'b2.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg', 's3.jpg']);
    expect(focusedId()).toBe(key('b4.jpg'));
    // Plan 47: the focused cell is the listbox's active descendant (the grid draws one sliding focus ring).
    expect(screen.getByRole('listbox', { name: 'Photos' }).getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'b4.jpg' }).id,
    );
    // In place: the frames start their own row (a left accent bar), so the row of s1 s2 holds only them.
    press({ key: 'ArrowUp' });
    expect(focusedId()).toBe(key('s2.jpg'));
    press({ key: 'ArrowDown' });
    expect(focusedId()).toBe(key('b2.jpg'));
    press({ key: 'g' });
    expect(useUiStore.getState().cull.expanded).toBeNull();
    expect(focusedId()).toBe(key('b2.jpg'));
    expect(options()).toContain('b2.jpg, group of 5');
    // The badge opens it too.
    fireEvent.click(screen.getByRole('button', { name: /^Open the group of 5/ }));
    expect(useUiStore.getState().cull.expanded).toBe(key('b1.jpg'));
  });

  it('opening and closing a group in place keeps the scroll offset', () => {
    // 30 singles first: the group cell is on row 6 (top 324 px: 12 px padding, 48 px cells, 4 px gaps); opened, the
    // frames take row 7 (376 to 424 px). A 200 px grid scrolled to 250 shows both, so nothing needs to move.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });
    setFolder(emptyLibrary(), 30);
    const ids = keysFor();
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b4.jpg'))));
    const grid = screen.getByRole('listbox', { name: 'Photos' });
    act(() => {
      grid.scrollTop = 250;
      fireEvent.scroll(grid);
    });
    expect(useUiStore.getState().cull.scrollTop).toBe(250);
    press({ key: 'g' });
    expect(useUiStore.getState().cull.expanded).toBe(key('b1.jpg'));
    expect(grid.scrollTop).toBe(250);
    expect(focusedId()).toBe(key('b4.jpg'));
    press({ key: 'g' });
    expect(useUiStore.getState().cull.expanded).toBeNull();
    expect(grid.scrollTop).toBe(250);
    // The focus moving out of view still scrolls: Home goes to the top.
    press({ key: 'Home' });
    expect(grid.scrollTop).toBe(0);
  });

  it(', and . step the shown frame inside a collapsed group and wrap', () => {
    const ids = keysFor();
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, 0));
    press({ key: 'ArrowRight' });
    press({ key: 'ArrowRight' });
    // The arrows land on the group through its shown frame, the suggested best.
    expect(focusedId()).toBe(key('b3.jpg'));
    press({ key: '.' });
    press({ key: '.' });
    expect(focusedId()).toBe(key('b5.jpg'));
    press({ key: '.' });
    expect(focusedId()).toBe(key('b1.jpg'));
    press({ key: ',' });
    expect(focusedId()).toBe(key('b5.jpg'));
    expect(options()).toContain('b5.jpg, group of 5');
    // Leaving and coming back shows the frame stepped to last.
    press({ key: 'ArrowRight' });
    expect(options()).toContain('b5.jpg, group of 5');
    press({ key: 'ArrowLeft' });
    expect(focusedId()).toBe(key('b5.jpg'));
  });

  it('flags the shown frame and advances to the next cell, not the next frame', () => {
    useUiStore.setState({ reviewAutoAdvance: true });
    const ids = keysFor();
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b3.jpg'))));
    press({ key: 'p' });
    expect(entry('b3.jpg')?.flag).toBe('pick');
    expect(entry('b1.jpg')).toBeUndefined();
    expect(focusedId()).toBe(key('s3.jpg'));
  });

  it('search matching a frame inside a collapsed group finds it (the Lightroom case)', () => {
    const found = keysFor({ query: 'b4' });
    expect(found).toEqual([key('b4.jpg')]);
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(found, 0));
    expect(options()).toEqual(['b4.jpg']);
  });

  it('C on a collapsed group compares the shown frame with the best; N surveys its frames', () => {
    const ids = keysFor();
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b5.jpg'))));
    press({ key: 'c' });
    expect(useUiStore.getState().cull.view).toBe('compare');
    expect(useUiStore.getState().cull.compare).toEqual({ candidate: key('b5.jpg'), select: key('b3.jpg') });
    press({ key: 'Escape' });
    expect(useUiStore.getState().cull.view).toBe('grid');
    press({ key: 'n' });
    expect(useUiStore.getState().cull.view).toBe('survey');
    expect(useUiStore.getState().cull.survey?.ids).toEqual(['b1.jpg', 'b2.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg'].map(key));
  });

  it('has a README row for each group key', () => {
    expect(CULL_KEYS.map((k) => k.keys)).toEqual(expect.arrayContaining(['G', ', / .', 'Cmd+G']));
    const k = { code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };
    expect(cullKeyAction({ ...k, key: 'g' })).toEqual({ type: 'expand' });
    expect(cullKeyAction({ ...k, key: ',' })).toEqual({ type: 'frame', dir: -1 });
    expect(cullKeyAction({ ...k, key: 'g', metaKey: true })).toEqual({ type: 'selectGroup' });
  });
});

describe('Group overrides', () => {
  it('merge, split and detach write the library outside undo, and survive a restart', () => {
    const ids = keysFor();
    const past = useBookStore.temporal.getState().pastStates.length;

    // Detach b2: a group of four remains.
    expect(detach([key('b2.jpg')], groupsNow(ids))).toBe(1);
    expect(entry('b2.jpg')?.cull).toEqual({ group: 'solo' });
    expect(cullUnits(ids, groupsNow(ids)).map((u) => (u.kind === 'group' ? u.frames.length : u.id))).toEqual([
      key('s1.jpg'),
      key('s2.jpg'),
      4,
      key('b2.jpg'),
      key('s3.jpg'),
    ]);

    // Merge s3 with the group: one group of five (b2 stays out).
    expect(mergeSelected([key('s3.jpg'), key('b1.jpg')], groupsNow(ids))).toBe(5);
    const merged = groupsNow(ids).groups;
    expect(merged).toHaveLength(1);
    expect(merged[0]?.frames).toEqual(['b1.jpg', 'b3.jpg', 'b4.jpg', 'b5.jpg', 's3.jpg'].map(key));

    // Split before b4: b1 b3 | b4 b5 s3.
    expect(splitGroup(key('b4.jpg'), groupsNow(ids))).toBe(5);
    expect(groupsNow(ids).groups.map((g) => g.frames.length)).toEqual([2, 3]);

    // Not undo steps.
    expect(useBookStore.temporal.getState().pastStates.length).toBe(past);

    // A restart: the library goes to disk and back, the groups come out the same.
    const before = groupsNow(ids).groups.map((g) => g.frames);
    const library = useBookStore.getState().libraries['/trip'] as Library;
    setFolder(parseLibrary(serializeLibrary(library)));
    expect(groupsNow(ids).groups.map((g) => g.frames)).toEqual(before);
  });

  it('a rating or a flag does not regroup; an override does', () => {
    const ids = keysFor();
    const before = groupsNow(ids);
    act(() => useBookStore.getState().reviewAssets([{ assetId: key('b2.jpg'), path: 'b2.jpg' }], { flag: 'pick' }));
    expect(entry('b2.jpg')?.flag).toBe('pick');
    expect(groupsNow(ids)).toBe(before);
    detach([key('b2.jpg')], before);
    expect(groupsNow(ids)).not.toBe(before);
  });

  it('a one-frame side of a split is a single photo', () => {
    const ids = keysFor();
    expect(splitGroup(key('b2.jpg'), groupsNow(ids))).toBe(5);
    expect(entry('b1.jpg')?.cull).toEqual({ group: 'solo' });
    expect(groupsNow(ids).groups.map((g) => g.frames.length)).toEqual([4]);
  });

  // Plan 49: the Group toggle is *Group by*'s Bursts option (one control); its ▾ menu shows while the list has groups.
  it('the Group control shows only on the Cull stage', () => {
    const ids = keysFor();
    // Develop or the Design stage's Library tab: a list (Review open in Design) but no Cull stage mounted.
    const { unmount } = render(<CullFilters />);
    act(() => useUiStore.getState().openReview(ids, 0));
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
    unmount();
    render(
      <>
        <CullFilters />
        <CullStage sourceKey="folder:F1" />
      </>,
    );
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy();
  });

  it('the Group control and menu in the filter bar', () => {
    const ids = keysFor();
    render(
      <>
        <CullFilters />
        <CullStage sourceKey="folder:F1" />
      </>,
    );
    act(() => useUiStore.getState().closeReview());
    expect(screen.queryByRole('button', { name: 'Group options' })).toBeNull();
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b2.jpg'))));
    const control = screen.getByRole('combobox', { name: 'Group by' }) as HTMLSelectElement;
    expect(control.value).toBe('bursts');
    fireEvent.change(control, { target: { value: 'off' } });
    expect(useUiStore.getState().cull.grouped).toBe(false);
    fireEvent.change(control, { target: { value: 'day' } });
    expect(useUiStore.getState().cull).toMatchObject({ grouped: true, groupBy: 'day' });
    fireEvent.change(control, { target: { value: 'bursts' } });
    expect(useUiStore.getState().cull).toMatchObject({ grouped: true, groupBy: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Group options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tighter' }));
    expect(useCullStore.getState().spacing).toBe('tighter');
    fireEvent.click(screen.getByRole('button', { name: 'Split group' }));
    expect(groupsNow(ids).groups.map((g) => g.frames.length)).toEqual([4]);
  });
});
