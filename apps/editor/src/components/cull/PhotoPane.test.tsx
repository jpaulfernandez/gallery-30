// @vitest-environment jsdom
import { DevelopSchema, emptyLibrary } from '@photobook/shared';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../lib/tauri';
import { developedKey } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { useProjectsStore } from '../../store/projects';
import { EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { apertureLabel, PhotoPane, placeLabel, renderKeyOf, shutterLabel, takenLabel } from './PhotoPane';

const calls = vi.hoisted(() => ({ histogram: [] as unknown[][], maps: [] as number[][] }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  histogram: vi.fn(async (...args: unknown[]) => {
    calls.histogram.push(args);
    const bins = Array.from({ length: 256 }, (_, i) => i);
    return { r: bins, g: bins, b: bins, l: bins };
  }),
  openMap: vi.fn(async (lat: number, lon: number) => {
    calls.maps.push([lat, lon]);
  }),
  listProjects: vi.fn(async () => []),
  readProject: vi.fn(async () =>
    JSON.stringify({ assets: { x: { path: 'a.jpg', folder: 'pf' } }, folders: { pf: { path: '/trip' } } }),
  ),
  writeLibrary: vi.fn(async () => {}),
}));

const F = 'F1';
const key = (name: string) => photoKey({ folder: F, path: name });
const stats = {
  sharpness: 100,
  sharpnessMax: 812.4,
  sharpestTile: 19,
  motion: 0.1,
  clipHigh: 0.012,
  clipLow: 0,
  medianLum: 0.45,
};

const photo = (relPath: string, extra: Partial<PhotoFile> = {}): PhotoFile => ({
  relPath,
  size: 24_000_000,
  mtime: 1,
  kind: 'raw',
  hash: 'ab'.repeat(32),
  width: 6000,
  height: 4000,
  status: 'ready',
  thumbUrl: `asset://c/${relPath}/thumb.jpg`,
  proxyUrl: `asset://c/${relPath}/proxy.jpg`,
  ...extra,
});

function renderPane() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: PhotoPane });
  const design = createRoute({ getParentRoute: () => root, path: '/project/$id/design', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([index, design]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return act(async () => {
    render(<RouterProvider router={router} />);
    await router.load();
  });
}

beforeEach(() => {
  calls.histogram = [];
  calls.maps = [];
  useLibraryStore.setState({
    folders: {
      [F]: {
        id: F,
        path: '/trip',
        photos: {
          'a.jpg': photo('DSC_0412.ARW', {
            relPath: 'a.jpg',
            make: 'Canon',
            model: 'EOS R6',
            lens: 'RF 50mm F1.2',
            focal: 50,
            shutter: 0.004,
            aperture: 2,
            iso: 800,
            taken: Date.UTC(2026, 8, 14, 18, 42),
            gps: { lat: 38.71, lon: -9.14 },
            stats,
          }),
          'b.jpg': photo('b.jpg', { kind: 'jpeg', make: 'Canon', model: 'EOS R6', taken: Date.UTC(2026, 8, 16, 9) }),
          'c.jpg': photo('c.jpg', { kind: 'jpeg', proxyUrl: undefined }),
        },
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { '/trip': emptyLibrary() } });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
  useProjectsStore.setState({ projects: [] });
});
afterEach(() => {
  cleanup();
  useLibraryStore.getState().reset();
  useBookStore.setState({ libraries: {} });
  useUiStore.setState({ review: null, selection: EMPTY_SELECTION });
});

describe('the Photo pane (plan 52)', () => {
  it('formats the camera facts', () => {
    expect(shutterLabel(0.004)).toBe('1/250 s');
    expect(shutterLabel(1 / 8000)).toBe('1/8000 s');
    expect(shutterLabel(2.5)).toBe('2.5 s');
    expect(apertureLabel(2.8)).toBe('f/2.8');
    expect(apertureLabel(8)).toBe('f/8');
    expect(takenLabel(Date.UTC(2026, 8, 14, 18, 42, 7))).toBe('2026-09-14 18:42');
    expect(placeLabel({ lat: 38.71, lon: -9.14 })).toBe('38.71000, −9.14000');
  });

  it('says "Select a photo" without one', async () => {
    await renderPane();
    expect(screen.getByText('Select a photo')).toBeTruthy();
  });

  it('shows the histogram, file, camera and signals of the focused photo; map ▸ opens Apple Maps', async () => {
    await renderPane();
    act(() => useUiStore.getState().openReview([key('a.jpg'), key('b.jpg'), key('c.jpg')], 0));
    const pane = screen.getByRole('complementary', { name: 'Photo' });
    await waitFor(() => expect(pane.querySelector('[data-histogram="ready"]')).not.toBeNull());
    // The plain proxy (no edits): no render key.
    expect(calls.histogram).toEqual([['ab'.repeat(32), undefined]]);
    const file = within(pane).getByRole('region', { name: 'File' });
    expect(file.textContent).toContain('a.jpg');
    expect(file.textContent).toContain('6000 × 4000 · 24 MB');
    expect(file.textContent).toContain('RAW (JPG)');
    const camera = within(pane).getByRole('region', { name: 'Camera' });
    expect(camera.textContent).toContain('Canon EOS R6');
    expect(camera.textContent).toContain('50 mm · 1/250 s · f/2 · ISO 800');
    expect(camera.textContent).toContain('2026-09-14 18:42');
    fireEvent.click(within(camera).getByRole('button', { name: 'map ▸' }));
    expect(calls.maps).toEqual([[38.71, -9.14]]);
    const signals = within(pane).getByRole('region', { name: 'Signals' });
    expect(signals.textContent).toContain('812');
    expect(signals.textContent).toContain('1.2 %');
    expect(signals.textContent).toContain('45 %');

    // Keep and the stars write the library (never an undo step).
    const undo = useBookStore.temporal.getState().pastStates.length;
    fireEvent.click(within(file).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(file).getByRole('button', { name: '3 stars' }));
    expect(useBookStore.getState().libraries['/trip']?.photos['ab'.repeat(32)]).toMatchObject({
      flag: 'pick',
      rating: 3,
    });
    expect(useBookStore.temporal.getState().pastStates.length).toBe(undo);

    // A photo without facts or stats: no Camera and no Signals card; without a proxy no histogram is asked for.
    act(() => useUiStore.getState().setReviewIndex(2));
    expect(within(pane).queryByRole('region', { name: 'Signals' })).toBeNull();
    expect(within(pane).queryByRole('region', { name: 'Camera' })).toBeNull();
    expect(calls.histogram).toHaveLength(1);
  });

  it('with several selected: the count, what they share and the batch actions', async () => {
    await renderPane();
    act(() => useUiStore.getState().openReview([key('a.jpg'), key('b.jpg'), key('c.jpg')], 0));
    act(() => useUiStore.getState().setSelection([key('a.jpg'), key('b.jpg')], key('a.jpg')));
    const summary = screen.getByRole('region', { name: '2 selected' });
    expect(summary.textContent).toContain('Canon EOS R6');
    expect(summary.textContent).toContain('2026-09-14 – 2026-09-16');
    fireEvent.click(within(summary).getByRole('button', { name: 'Reject' }));
    expect(summary.textContent).toContain('0 kept · 2 rejected');
    fireEvent.click(within(summary).getByRole('button', { name: 'Clear' }));
    expect(useUiStore.getState().selection.keys).toEqual([]);
  });

  it('links the projects that hold the photo', async () => {
    const project: ProjectSummary = {
      id: 'p1',
      path: '/x/project.photobook.json',
      external: false,
      title: 'Lisbon book',
      folders: [{ id: 'pf', path: '/trip', name: 'Trip', imported: true, missing: false }],
      updatedAt: 1,
      openedAt: null,
      coverHash: null,
      coverThumb: null,
      error: null,
    };
    useProjectsStore.setState({ projects: [project] });
    await renderPane();
    act(() => useUiStore.getState().openReview([key('a.jpg')], 0));
    const link = await screen.findByRole('link', { name: 'Lisbon book' }, { timeout: 2000 });
    expect(link.getAttribute('href')).toBe('/project/p1/design');
  });

  it('asks for the developed proxy of an edit (the render key, -p3 for Display P3)', () => {
    const develop = DevelopSchema.parse({ version: 1, light: { exposure: 1 } });
    const dh = 'cd'.repeat(32);
    const rendered = (profile: 'srgb' | 'display-p3') => ({
      developHash: dh,
      input: developedKey(develop, profile),
      thumbUrl: '',
      proxyUrl: '',
      width: 1,
      height: 1,
    });
    const file = {
      ...photo('a.jpg'),
      assetId: 'a',
      developed: {
        [developedKey(develop, 'srgb')]: rendered('srgb'),
        [developedKey(develop, 'display-p3')]: rendered('display-p3'),
      },
    };
    expect(renderKeyOf(file, develop, 'srgb')).toBe(dh);
    expect(renderKeyOf(file, develop, 'display-p3')).toBe(`${dh}-p3`);
    // No render for these settings yet, or no edit: the plain proxy.
    expect(renderKeyOf(file, DevelopSchema.parse({ version: 1, light: { exposure: 2 } }), 'srgb')).toBeUndefined();
    expect(renderKeyOf(file, undefined, 'srgb')).toBeUndefined();
  });
});
