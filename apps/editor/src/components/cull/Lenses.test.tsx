// @vitest-environment jsdom
import { emptyLibrary, LENS_CAVEATS, type Library, newId, parseSavedCollections } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PhotoStats, writeLibrary } from '../../lib/tauri';
import type { AssetFile } from '../../store/assets';
import { useBookStore } from '../../store/book';
import {
  availableCollections,
  collectionCount,
  collectionFilterFor,
  libraryKeys,
  matchesFilter,
} from '../../store/collections';
import { cullGroups, useCullStore } from '../../store/cull';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { visibleItems } from '../filmstrip/visible';
import { TOOLTIP_DELAY_MS } from '../ui/Tooltip';
import { CullFilters } from './CullFilters';
import { CullGrid } from './CullGrid';
import { CullMenu, softerFrames } from './CullMenu';
import { CullStage, CullView } from './CullView';

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  writeLibrary: vi.fn(async () => {}),
}));

const F = 'F1';
const SOURCE = { kind: 'folder', id: F } as const;
const key = (name: string) => photoKey({ folder: F, path: name });
const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);
const HASH = 'a5a5a5a5c3c3c3c3';

const stats = (s: Partial<PhotoStats> = {}): PhotoStats => ({
  sharpness: 100,
  sharpnessMax: 300,
  sharpestTile: 27,
  motion: 0.2,
  clipHigh: 0,
  clipLow: 0,
  medianLum: 0.4,
  ...s,
});

const photo = (relPath: string, taken: number, phash: string, s: Partial<PhotoStats> = {}, raw = false): PhotoFile => ({
  relPath,
  size: 1,
  mtime: taken,
  kind: raw ? 'raw' : 'jpeg',
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
  stats: stats(s),
});

/**
 * Eleven photos: a burst of five (b3 the sharpest), the folder's softest (its decile of one), a blown JPEG, a blown
 * RAW at "worth a look", a dark frame, a silhouette and a high-key frame, minutes apart with unrelated hashes.
 */
const PHOTOS = [
  photo('b1.jpg', T0, HASH, { sharpnessMax: 300 }),
  photo('b2.jpg', T0 + 200, HASH, { sharpnessMax: 310 }),
  photo('b3.jpg', T0 + 400, HASH, { sharpnessMax: 500 }),
  photo('b4.jpg', T0 + 600, HASH, { sharpnessMax: 450 }),
  photo('b5.jpg', T0 + 800, HASH, { sharpnessMax: 320 }),
  photo('soft.jpg', T0 + 60_000, '0f0f0f0f0f0f0f0f', { sharpnessMax: 5 }),
  photo('blown.jpg', T0 + 120_000, 'f0f0f0f0f0f0f0f0', { clipHigh: 0.08, medianLum: 0.6 }),
  photo('blown.raf', T0 + 180_000, '3333333333333333', { clipHigh: 0.03 }, true),
  photo('dark.jpg', T0 + 240_000, 'cccccccccccccccc', { medianLum: 0.05 }),
  photo('silhouette.jpg', T0 + 300_000, '5555555555555555', { medianLum: 0.03, clipHigh: 0.2, clipLow: 0.2 }),
  photo('high-key.jpg', T0 + 360_000, 'aaaaaaaaaaaaaaaa', { medianLum: 0.85, clipHigh: 0.1 }),
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
const names = (keys: readonly string[]) => keys.map((k) => k.slice(F.length + 1));
/** Hover `el` (the element a `Tooltip` wraps) past the delay: the tooltip's text; `el` is described by it. */
function tipOf(el: HTMLElement): string | null {
  const wrap = el.parentElement as HTMLElement;
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(wrap);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
    const tip = screen.getByRole('tooltip');
    expect(el.getAttribute('aria-describedby')).toBe(tip.id);
    const text = tip.textContent;
    fireEvent.pointerLeave(wrap);
    return text;
  } finally {
    vi.useRealTimers();
  }
}

const cell = (name: string) => screen.getByRole('option', { name: new RegExp(`^${name.replace('.', '\\.')}`) });

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
    filmstrip: DEFAULT_FILMSTRIP,
  });
  useCullStore.setState({ spacing: 'normal', shown: {} });
  setFolder();
  vi.mocked(writeLibrary).mockClear();
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION, libraryView: DEFAULT_FILMSTRIP });
});

describe('lenses filter the list', () => {
  it('Soft is the folder’s softest decile; Blown and Dark leave the silhouette and the high-key frame out', () => {
    expect(names(keysFor({ lens: 'soft' }))).toEqual(['soft.jpg']);
    expect(names(keysFor({ lens: 'blown' }))).toEqual(['blown.jpg', 'blown.raf']);
    expect(names(keysFor({ lens: 'dark' }))).toEqual(['dark.jpg']);
    expect(keysFor({ lens: 'none' })).toHaveLength(PHOTOS.length);
  });

  it('a lens composes with a flag filter', () => {
    setFolder(flagged({ 'blown.jpg': 'reject', 'blown.raf': 'pick', 'dark.jpg': 'reject' }));
    expect(names(keysFor({ lens: 'blown', flag: 'rejects' }))).toEqual(['blown.jpg']);
    expect(names(keysFor({ lens: 'blown', flag: 'undecided' }))).toEqual([]);
    expect(names(keysFor({ lens: 'dark', flag: 'no-rejects' }))).toEqual([]);
    expect(names(keysFor({ flag: 'rejects' }))).toEqual(['blown.jpg', 'dark.jpg']);
  });

  it('without its folder’s stats no photo is Soft', () => {
    const soft = PHOTOS[5] as PhotoFile;
    expect(matchesFilter({ query: '', flag: 'all', minRating: 0, lens: 'soft' }, soft, undefined)).toBe(false);
    expect(matchesFilter({ query: '', flag: 'all', minRating: 0, lens: 'none' }, soft, undefined)).toBe(true);
  });

  it('a collection saved with a lens reopens with it', () => {
    const filter = collectionFilterFor(SOURCE, { ...DEFAULT_FILMSTRIP, lens: 'dark' });
    expect(filter).toMatchObject({ folders: [F], lens: 'dark' });
    // As written to collections.json and read back.
    const id = newId();
    const [saved] = parseSavedCollections(JSON.parse(JSON.stringify([{ id, name: 'Dark in the trip', filter }])));
    expect(saved?.filter.lens).toBe('dark');
    if (!saved) throw new Error('not parsed');
    const reopened = libraryKeys(
      { kind: 'saved', id, filter: saved.filter },
      useLibraryStore.getState().folders,
      useBookStore.getState().libraries,
      DEFAULT_FILMSTRIP,
    );
    expect(names(reopened)).toEqual(['dark.jpg']);
    // Without a lens the collection has none (and an older collection parses without one).
    expect(collectionFilterFor(SOURCE, DEFAULT_FILMSTRIP)?.lens).toBeUndefined();
  });

  it('two different lenses are not one collection; a lens inside Worth a look or the same lens is', () => {
    const saved = {
      kind: 'saved',
      id: newId(),
      filter: { flag: 'all', minRating: 0, query: '', lens: 'soft' },
    } as const;
    expect(collectionFilterFor(saved, { ...DEFAULT_FILMSTRIP, lens: 'blown' })).toBeNull();
    expect(collectionFilterFor(saved, { ...DEFAULT_FILMSTRIP, lens: 'soft' })?.lens).toBe('soft');
    expect(collectionFilterFor(saved, DEFAULT_FILMSTRIP)?.lens).toBe('soft');
    const worth = { kind: 'collection', id: 'worth-a-look' } as const;
    expect(collectionFilterFor(worth, { ...DEFAULT_FILMSTRIP, lens: 'dark' })?.lens).toBe('dark');
  });

  it('Worth a look holds any lens, and is listed only once some photo has stats', () => {
    const { folders } = useLibraryStore.getState();
    const { libraries } = useBookStore.getState();
    expect(availableCollections(folders).map((c) => c.id)).toContain('worth-a-look');
    expect(collectionCount('worth-a-look', folders, libraries)).toBe(4);
    expect(
      names(libraryKeys({ kind: 'collection', id: 'worth-a-look' }, folders, libraries, DEFAULT_FILMSTRIP)),
    ).toEqual(['soft.jpg', 'blown.jpg', 'blown.raf', 'dark.jpg']);
    expect(collectionFilterFor({ kind: 'collection', id: 'worth-a-look' }, DEFAULT_FILMSTRIP)?.lens).toBe('any');
    setFolder(
      emptyLibrary(),
      PHOTOS.map(({ stats: _, ...rest }) => rest),
    );
    expect(availableCollections(useLibraryStore.getState().folders).map((c) => c.id)).not.toContain('worth-a-look');
  });

  it('the project’s Cull list takes the lens over the project’s files', () => {
    const files: Record<string, AssetFile> = Object.fromEntries(
      PHOTOS.map((p) => [p.relPath, { ...p, assetId: `A-${p.relPath}` }]),
    );
    const shown = (lens: 'none' | 'soft' | 'dark') =>
      visibleItems(files, {}, {}, new Set(), { ...DEFAULT_FILMSTRIP, lens }).map((item) =>
        item.kind === 'file' ? item.file.relPath : item.asset.path,
      );
    expect(shown('soft')).toEqual(['soft.jpg']);
    expect(shown('dark')).toEqual(['dark.jpg']);
    expect(shown('none')).toHaveLength(PHOTOS.length);
  });
});

describe('the Lens select', () => {
  function renderBar() {
    render(
      <>
        <CullFilters />
        <CullStage sourceKey="folder:F1" />
      </>,
    );
  }

  it('changing the lens writes no flag and nothing to the library', () => {
    setFolder(flagged({ 'soft.jpg': 'pick' }));
    renderBar();
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    const before = useBookStore.getState().libraries;
    const select = screen.getByRole('combobox', { name: 'Lens' }) as HTMLSelectElement;
    for (const lens of ['soft', 'blown', 'dark', 'none']) {
      fireEvent.change(select, { target: { value: lens } });
      expect(useUiStore.getState().libraryView.lens).toBe(lens);
    }
    expect(useBookStore.getState().libraries).toBe(before);
    expect(useBookStore.getState().libraries['/trip']?.photos['h-soft.jpg']?.flag).toBe('pick');
    expect(writeLibrary).not.toHaveBeenCalled();
  });

  it('counts each lens over the list, and shows the caveat while a lens is on', () => {
    renderBar();
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    const options = () =>
      [...(screen.getByRole('combobox', { name: 'Lens' }) as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options()).toEqual(['No lens', 'Soft · 1', 'Blown · 2', 'Dark · 1']);
    expect(screen.queryByRole('note')).toBeNull();
    act(() => useUiStore.getState().setLibraryView({ lens: 'soft' }));
    act(() => useUiStore.getState().updateSessionIds('review', keysFor({ lens: 'soft' }), 0));
    expect(screen.getByRole('note').textContent).toContain(LENS_CAVEATS.soft);
    expect(screen.getByRole('note').textContent).toContain('A lens never flags');
    expect(options()).toEqual(['No lens', 'Soft · 1', 'Blown', 'Dark']);
  });

  it('says RAW headroom on Blown when the list has a RAW in it', () => {
    renderBar();
    act(() => useUiStore.getState().setLibraryView({ lens: 'blown' }));
    act(() => useUiStore.getState().openReview(keysFor({ lens: 'blown' }), 0));
    expect(screen.getByRole('note').textContent).toContain('RAW headroom: 1 of them is a RAW');
  });

  it('stays when the lens leaves no photo, so it can be turned off', () => {
    renderBar();
    act(() => useUiStore.getState().setLibraryView({ lens: 'dark' }));
    act(() => useUiStore.getState().closeReview());
    expect(screen.getByRole('combobox', { name: 'Lens' })).toBeTruthy();
  });

  it('sets the project’s filter in the project’s Cull', () => {
    render(
      <>
        <CullFilters scope="project" />
        <CullStage sourceKey="project" />
      </>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Lens' }), { target: { value: 'blown' } });
    expect(useUiStore.getState().filmstrip.lens).toBe('blown');
    expect(useUiStore.getState().libraryView.lens).toBe('none');
  });
});

describe('lens badges and the Decide strip', () => {
  it('grid cells carry dim lens glyphs, named by the lens, with the number in a short tooltip', () => {
    act(() => useUiStore.getState().setCull({ grouped: false }));
    render(<CullGrid />);
    act(() => useUiStore.getState().openReview(keysFor(), 0));
    const lensesOf = (name: string) =>
      [...cell(name).querySelectorAll('[data-lens]')].map((el) => el.getAttribute('data-lens'));
    expect(lensesOf('soft.jpg')).toEqual(['soft']);
    expect(lensesOf('blown.jpg')).toEqual(['blown']);
    expect(lensesOf('dark.jpg')).toEqual(['dark']);
    expect(lensesOf('silhouette.jpg')).toEqual([]);
    expect(lensesOf('high-key.jpg')).toEqual([]);
    expect(lensesOf('b3.jpg')).toEqual([]);
    const soft = cell('soft.jpg').querySelector('[data-lens="soft"]') as HTMLElement;
    expect(soft.getAttribute('aria-label')).toBe('Soft');
    expect(tipOf(soft)).toBe('Soft: sharpest tile 5');
    expect(tipOf(cell('blown.raf').querySelector('[data-lens]') as HTMLElement)).toBe(
      'Blown, worth a look: 3 % clipped (RAW headroom)',
    );
    expect(tipOf(cell('blown.jpg').querySelector('[data-lens]') as HTMLElement)).toBe('Likely blown: 8 % clipped');
  });

  it('the Decide strip marks the sharpest frame and draws each frame against it', () => {
    const ids = keysFor();
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('b1.jpg'))));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(useUiStore.getState().cull.view).toBe('decide');
    const strip = screen.getByRole('group', { name: 'Frames of the group' });
    expect(strip.querySelectorAll('[aria-label="Sharpest"]')).toHaveLength(1);
    const bars = [...strip.querySelectorAll('[data-sharpness]')].map((el) => el.getAttribute('data-sharpness'));
    expect(bars).toEqual(['60', '62', '100', '90', '64']);
    expect(screen.getByTestId('frame-sharpness').textContent).toBe(' · 60 % of the sharpest ●');
    const shown = useUiStore.getState().review;
    const at = BURST.indexOf('b3.jpg');
    act(() => useUiStore.getState().setReviewIndex(shown?.ids.indexOf(key(BURST[at] as string)) ?? 0));
    expect(screen.getByTestId('frame-sharpness').textContent).toBe(' · sharpest ●');
  });

  it('the Decide header names the shown photo’s lenses', () => {
    const ids = keysFor();
    render(<CullView />);
    act(() => useUiStore.getState().openReview(ids, ids.indexOf(key('blown.raf'))));
    fireEvent.keyDown(window, { key: 'Enter' });
    const notes = screen.getByTestId('lens-notes');
    expect(notes.textContent).toBe('Blown · RAW headroom');
    expect(tipOf(notes.querySelector('.tag')?.parentElement as HTMLElement)).toBe(
      'Blown, worth a look: 3 % clipped (RAW headroom)',
    );
    expect(writeLibrary).not.toHaveBeenCalled();
  });
});

describe('Select the group’s softer frames', () => {
  it('selects every frame of the group but its suggested best, and writes nothing', () => {
    const ids = keysFor();
    act(() => useUiStore.getState().openReview(ids, 0));
    const groups = cullGroups(ids, {
      folders: useLibraryStore.getState().folders,
      libraries: useBookStore.getState().libraries,
      files: {},
      spacing: 'normal',
    });
    const softer = ['b1.jpg', 'b2.jpg', 'b4.jpg', 'b5.jpg'].map(key);
    expect(softerFrames(key('b2.jpg'), groups, ids)).toEqual(softer);
    expect(softerFrames(key('soft.jpg'), groups, ids)).toEqual([]);
    // A filter that hides a frame leaves it out.
    expect(
      softerFrames(
        key('b2.jpg'),
        groups,
        ids.filter((id) => id !== key('b5.jpg')),
      ),
    ).toEqual(softer.slice(0, 3));

    const before = useBookStore.getState().libraries;
    const onClose = vi.fn();
    render(<CullMenu menu={{ x: 10, y: 10, source: key('b2.jpg'), targets: [key('b2.jpg')] }} onClose={onClose} />);
    fireEvent.click(screen.getByRole('menuitem', { name: "Select the group's softer frames" }));
    expect(onClose).toHaveBeenCalled();
    expect(useUiStore.getState().selection.keys).toEqual(softer);
    expect(useBookStore.getState().libraries).toBe(before);
    expect(writeLibrary).not.toHaveBeenCalled();
  });

  it('is off when no frame of the group has stats', () => {
    // Groups need stats-free frames that still group: a merge override puts the burst in one group.
    const merge = newId();
    const library = emptyLibrary();
    for (const name of BURST) library.photos[`h-${name}`] = { versions: {}, cull: { group: merge } };
    setFolder(
      library,
      PHOTOS.map(({ stats: _, ...rest }) => rest),
    );
    const ids = keysFor();
    act(() => useUiStore.getState().openReview(ids, 0));
    const groups = cullGroups(ids, {
      folders: useLibraryStore.getState().folders,
      libraries: useBookStore.getState().libraries,
      files: {},
      spacing: 'normal',
    });
    expect(groups.byPhoto.get(key('b2.jpg'))?.frames).toHaveLength(5);
    expect(softerFrames(key('b2.jpg'), groups, ids)).toEqual([]);
    render(<CullMenu menu={{ x: 10, y: 10, source: key('b2.jpg'), targets: [key('b2.jpg')] }} onClose={() => {}} />);
    const item = screen.getByRole('menuitem', { name: "Select the group's softer frames" });
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });
});
