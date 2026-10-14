// @vitest-environment jsdom
import { DEVELOP_DEFAULTS, emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDevelopPreview, writeLibrary } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { useCullStore } from '../../store/cull';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import {
  CULL_ASSIST_KEY,
  CULL_COLLAPSED_KEY,
  CULL_GROUP_BY_KEY,
  DEFAULT_CULL_ASSIST,
  EMPTY_SELECTION,
  useUiStore,
} from '../../store/ui';
import {
  clearModeCache,
  guideLines,
  holdModeUrl,
  nextComposition,
  previewModes,
  requestModePreview,
  spiralPath,
} from './AssistOverlays';
import { cellsInRect, DIVIDER_HEIGHT, rowTops } from './CullGrid';
import { CullView } from './CullView';
import { assistKeyAction } from './keys';
import { openCompare } from './openViews';

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  histogram: vi.fn(async () => ({ r: [], g: [], b: [], l: [] })),
  writeLibrary: vi.fn(async () => {}),
  renderDevelopPreview: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer),
}));

const F = 'F1';
const key = (name: string) => photoKey({ folder: F, path: name });
const NAMES = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];
const ids = () => NAMES.map(key);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 14, 9);

/** Two photos on 14 Sep, three on 15 Sep; a.jpg and c.jpg with one camera, the rest with another. */
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
  taken: T0 + (i < 2 ? i * 60_000 : DAY + i * 60_000),
  make: 'Fujifilm',
  model: i % 2 === 0 ? 'X-T5' : 'X100V',
});

const cull = () => useUiStore.getState().cull;
const libraryNow = () => JSON.stringify(useBookStore.getState().libraries);
const press = (init: Partial<KeyboardEventInit> & { key: string }) => fireEvent.keyDown(window, init);

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mode');
  globalThis.URL.revokeObjectURL = vi.fn();
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
    cull: {
      columns: 5,
      view: 'grid',
      scrollTop: 0,
      grouped: true,
      showStars: false,
      expanded: null,
      zoom: 'fit',
      assist: { ...DEFAULT_CULL_ASSIST },
      groupBy: 'none',
    },
    reviewAutoAdvance: false,
  });
  useCullStore.setState({ spacing: 'normal', shown: {} });
  vi.mocked(writeLibrary).mockClear();
  vi.mocked(renderDevelopPreview).mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('assist keys and state', () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', target: null };

  it('parses F, Z, O and Shift+O, and leaves text fields and modifiers alone', () => {
    expect(assistKeyAction({ ...base, key: 'f' })).toEqual({ type: 'focusPeak' });
    expect(assistKeyAction({ ...base, key: 'z' })).toEqual({ type: 'zebra' });
    expect(assistKeyAction({ ...base, key: 'o' })).toEqual({ type: 'composition', dir: 1 });
    expect(assistKeyAction({ ...base, key: 'O', shiftKey: true })).toEqual({ type: 'composition', dir: -1 });
    expect(assistKeyAction({ ...base, key: 'F', shiftKey: true })).toBeNull();
    expect(assistKeyAction({ ...base, key: 'z', metaKey: true })).toBeNull();
    const input = document.createElement('input');
    expect(assistKeyAction({ ...base, key: 'o', target: input })).toBeNull();
  });

  it('cycles the composition guides through none', () => {
    const seen = [];
    let at = nextComposition(null);
    while (at !== null) {
      seen.push(at);
      at = nextComposition(at);
    }
    expect(seen).toEqual(['thirds', 'golden', 'spiral', 'centre', 'diagonals']);
    expect(nextComposition(null, -1)).toBe('diagonals');
  });

  it('orders the preview modes focus peak first', () => {
    expect(previewModes({ focusPeak: true, zebra: true, composition: null })).toEqual(['focus-peak', 'zebra']);
    expect(previewModes(DEFAULT_CULL_ASSIST)).toEqual([]);
  });

  it('draws the guides inside the picture', () => {
    expect(guideLines('thirds', 300, 200)).toHaveLength(4);
    expect(guideLines('centre', 300, 200)).toEqual([
      [150, 0, 150, 200],
      [0, 100, 300, 100],
    ]);
    for (const [w, h] of [
      [300, 200],
      [200, 300],
    ] as const) {
      const d = spiralPath(w, h);
      expect(d.startsWith('M')).toBe(true);
      const numbers = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      expect(numbers.every((n) => n >= -0.01 && n <= Math.max(w, h) + 0.01)).toBe(true);
    }
  });
});

describe('mode preview URLs', () => {
  it('are revoked only once no overlay shows them', async () => {
    const url = await requestModePreview({
      folder: '/trip',
      relPath: 'a.jpg',
      hash: 'h-a.jpg',
      settings: DEVELOP_DEFAULTS,
      profile: 'srgb',
      modes: ['zebra'],
    });
    expect(url).toBe('blob:mode');
    const release = holdModeUrl(url as string);
    clearModeCache();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mode');
  });
});

describe('the overlays in One, Two and Decide', () => {
  it('Two: the Assist menu and keys toggle the overlays, request the preview modes and write no flag', async () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => openCompare());
    const before = libraryNow();
    // F and Z: the modes are requested for both panes, in drawing order.
    await act(async () => {
      press({ key: 'f' });
      press({ key: 'z' });
    });
    expect(cull().assist).toEqual({ focusPeak: true, zebra: true, composition: null });
    expect(cull().zoom).toBe('fit');
    const calls = vi.mocked(renderDevelopPreview).mock.calls;
    expect(calls.some((c) => c[7]?.join() === 'focus-peak,zebra')).toBe(true);
    expect(calls.every((c) => c[0] === '/trip')).toBe(true);
    // O cycles six times: back to none.
    for (let i = 0; i < 6; i += 1) act(() => press({ key: 'o' }));
    expect(cull().assist?.composition).toBeNull();
    act(() => press({ key: 'o' }));
    expect(document.querySelectorAll('[data-composition="thirds"]').length).toBe(2);
    // The menu's items toggle the same state.
    fireEvent.click(screen.getByRole('button', { name: /Assist/ }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Zebra/ }));
    expect(cull().assist?.zebra).toBe(false);
    // Remembered per machine, and nothing reached the library.
    expect(JSON.parse(localStorage.getItem(CULL_ASSIST_KEY) ?? '{}')).toMatchObject({ focusPeak: true, zebra: false });
    expect(libraryNow()).toBe(before);
    expect(writeLibrary).not.toHaveBeenCalled();
    // A sharpness bar sits under each pane slot.
    expect(document.querySelectorAll('section[data-side]').length).toBe(2);
  });

  it('One and Decide take the same keys and write no flag', async () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 1));
    act(() => useUiStore.getState().setCull({ view: 'review' }));
    const before = libraryNow();
    await act(async () => press({ key: 'z' }));
    expect(cull().assist?.zebra).toBe(true);
    expect(vi.mocked(renderDevelopPreview).mock.calls.at(-1)?.[1]).toBe('b.jpg');
    act(() => useUiStore.getState().setCull({ view: 'decide' }));
    await act(async () => press({ key: 'f' }));
    act(() => press({ key: 'o' }));
    expect(cull().assist).toEqual({ focusPeak: true, zebra: true, composition: 'thirds' });
    expect(libraryNow()).toBe(before);
    expect(writeLibrary).not.toHaveBeenCalled();
  });
});

describe('Group by dividers', () => {
  it('lays out dividers by day without changing the list, the selection or the keys', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setSelection([key('b.jpg')], key('b.jpg')));
    act(() => useUiStore.getState().setCull({ groupBy: 'day' }));
    const dividers = [...document.querySelectorAll<HTMLElement>('[data-divider]')];
    expect(dividers.map((d) => d.textContent)).toEqual(['▸Mon 14 Sep 20262', '▸Tue 15 Sep 20263']);
    expect(useUiStore.getState().review?.ids).toEqual(ids());
    expect(useUiStore.getState().selection.keys).toEqual([key('b.jpg')]);
    expect(localStorage.getItem(CULL_GROUP_BY_KEY)).toBe('day');
    // Down from a.jpg skips the divider row to c.jpg (the next section's first row, same column); the selection
    // follows the focus as it always does with one photo selected.
    press({ key: 'ArrowDown' });
    expect(useUiStore.getState().review?.index).toBe(2);
    expect(useUiStore.getState().selection.keys).toEqual([key('c.jpg')]);
    // Collapsing the focused photo's section hides its cells; the focus (and a selection of just that photo) moves to
    // the next shown cell, here none after it, so the one before: b.jpg. The list stays; the keys never act on a
    // hidden photo.
    fireEvent.click(screen.getByRole('button', { name: /Tue 15 Sep/ }));
    expect(document.querySelectorAll('[role="option"]').length).toBe(2);
    expect(useUiStore.getState().review?.index).toBe(1);
    expect(useUiStore.getState().selection.keys).toEqual([key('b.jpg')]);
    expect(useUiStore.getState().review?.ids).toEqual(ids());
    act(() => press({ key: 'p' }));
    expect(useBookStore.getState().libraries['/trip']?.photos['h-c.jpg']?.flag).toBeUndefined();
    expect(useBookStore.getState().libraries['/trip']?.photos['h-b.jpg']?.flag).toBe('pick');
    // Remembered per machine, per key.
    expect(JSON.parse(localStorage.getItem(CULL_COLLAPSED_KEY) ?? '{}')).toEqual({ day: ['2026-09-15'] });
    expect(cull().collapsed).toEqual({ day: ['2026-09-15'] });
  });

  it('collapsing moves the focus to the next shown cell after the section', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setCull({ groupBy: 'day' }));
    fireEvent.click(screen.getByRole('button', { name: /Mon 14 Sep/ }));
    expect(useUiStore.getState().review?.index).toBe(2);
    expect(writeLibrary).not.toHaveBeenCalled();
  });

  it('groups by camera in runs, so the cells keep the list order and a Shift range is the span shown', () => {
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids(), 0));
    act(() => useUiStore.getState().setCull({ groupBy: 'camera' }));
    const labels = [...document.querySelectorAll<HTMLElement>('[data-divider]')].map((d) => d.textContent);
    expect(labels).toEqual([
      '▸Fujifilm X-T51',
      '▸Fujifilm X100V1',
      '▸Fujifilm X-T51',
      '▸Fujifilm X100V1',
      '▸Fujifilm X-T51',
    ]);
    const cells = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(cells().map((c) => c.getAttribute('aria-label'))).toEqual(NAMES);
    // A click on a.jpg, Shift+click on c.jpg across two dividers: exactly a, b, c, the cells between them on screen.
    fireEvent.click(cells()[0] as HTMLElement);
    fireEvent.click(cells()[2] as HTMLElement, { shiftKey: true });
    expect(useUiStore.getState().selection.keys).toEqual([key('a.jpg'), key('b.jpg'), key('c.jpg')]);
  });

  it('measures rows with dividers for the marquee and the focus ring', () => {
    const rows = [{ cells: [], divider: {} }, { cells: [0, 1] }, { cells: [], divider: {} }, { cells: [2] }];
    const tops = rowTops(rows, 50);
    expect(tops).toEqual([
      12,
      12 + DIVIDER_HEIGHT,
      12 + DIVIDER_HEIGHT + 54,
      12 + 2 * DIVIDER_HEIGHT + 54,
      12 + 2 * DIVIDER_HEIGHT + 108,
    ]);
    const size = { cell: 50, cellWidth: 50, tops };
    // A box over the second section's row only.
    expect(cellsInRect(rows, { x: 12, y: (tops[3] ?? 0) + 5, w: 10, h: 10 }, size)).toEqual([2]);
  });
});
