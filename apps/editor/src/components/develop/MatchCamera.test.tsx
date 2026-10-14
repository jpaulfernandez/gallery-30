// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { resetJobs, useJobsStore } from '../../store/jobs';
import { useLibraryStore } from '../../store/library';
import { enqueueLutFit, resetFilmSimulations, useLutsStore } from '../../store/luts';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

/** Workflow plan 22: the fit job, the Match camera JPEG dialog and the "Suggested: … (fitted)" row. */

const FITTED = {
  id: 'f'.repeat(64),
  name: 'Classic Chrome',
  size: 33,
  fitted: { simulation: 'Classic Chrome', camera: 'Fujifilm X-T5', pairs: 2, meanDeltaE: 1.3 },
};
const PLAIN = { id: 'a'.repeat(64), name: 'Warm', size: 33 };

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  commit: vi.fn(),
  listLuts: vi.fn(),
  lutPresent: vi.fn(),
  fitLut: vi.fn(),
  filmSimulation: vi.fn(),
  savePreset: vi.fn(),
  listPresets: vi.fn(),
  cancelDevelop: vi.fn(async () => {}),
  scanFolder: vi.fn(),
  progress: null as null | ((e: { job: number; done: number; total: number; detail: string }) => void),
  unlisten: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  listLuts: mocks.listLuts,
  lutPresent: mocks.lutPresent,
  importLut: vi.fn(),
  deleteLut: vi.fn(),
  fitLut: mocks.fitLut,
  filmSimulation: mocks.filmSimulation,
  savePreset: mocks.savePreset,
  // Plan 20's Looks section lists the saved looks too.
  listPresets: mocks.listPresets,
  cancelDevelop: mocks.cancelDevelop,
  scanFolder: mocks.scanFolder,
  onFitLutProgress: async (handler: (e: { job: number; done: number; total: number; detail: string }) => void) => {
    mocks.progress = handler;
    return mocks.unlisten;
  },
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
const develop = () => useBookStore.getState().book?.assets.f1?.develop;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

function files(): Record<string, AssetFile> {
  return Object.fromEntries(
    IDS.map((id) => [
      `fixture/${id}.jpg`,
      {
        relPath: `fixture/${id}.jpg`,
        assetId: id,
        size: 1,
        mtime: 1,
        kind: 'jpeg',
        hash: `hash-${id}`,
        status: 'ready',
        proxyUrl: `asset://proxy/${id}.jpg`,
        thumbUrl: `asset://thumb/${id}.jpg`,
      } satisfies AssetFile,
    ]),
  );
}

function mount() {
  act(() => useUiStore.getState().openDevelop(IDS, 0));
  render(<DevelopMode />);
  // Plan 20: the Looks section (with the suggestion row) is open at the top of the panel.
}

/** Plan 20: Match camera JPEG… is in the Looks section's ⋯ menu. */
async function openMatchCamera() {
  fireEvent.click(await screen.findByRole('button', { name: 'Looks menu' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Match camera JPEG…' }));
}

const result = () => ({
  lut: FITTED,
  pairs: [
    { raw: 'DSCF0001.RAF', jpeg: 'DSCF0001.JPG', samples: 1000, score: 0.9, meanDeltaE: 1.2 },
    { raw: 'DSCF0002.RAF', jpeg: 'DSCF0002.JPG', samples: 0, error: 'The JPEG does not line up with the RAW' },
  ],
  meanDeltaE: 1.2,
  coverage: 0.1,
  residual: 1e-8,
  converged: true,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function' && 'mockReset' in m) m.mockReset();
  mocks.cancelDevelop.mockImplementation(async () => {});
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.listLuts.mockResolvedValue([PLAIN, FITTED]);
  mocks.lutPresent.mockResolvedValue(true);
  mocks.filmSimulation.mockResolvedValue({ simulation: 'Classic Chrome', camera: 'Fujifilm X-T5' });
  mocks.listPresets.mockResolvedValue([]);
  mocks.savePreset.mockResolvedValue(undefined);
  mocks.scanFolder.mockResolvedValue(
    ['DSCF0001.RAF', 'DSCF0001.JPG', 'DSCF0002.RAF', 'DSCF0002.JPG', 'DSCF0003.RAF'].map((relPath) => ({ relPath })),
  );
  resetJobs();
  resetFilmSimulations();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useLibraryStore.setState({ folders: {} });
  useLutsStore.setState({ luts: [], loaded: false, error: null, present: {}, epoch: 0 });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('enqueueLutFit', () => {
  it('reports progress, adds the LUT and saves its look preset', async () => {
    let finish: (v: ReturnType<typeof result>) => void = () => {};
    mocks.fitLut.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const pairs = [{ raw: 'DSCF0001.RAF', jpeg: 'DSCF0001.JPG' }];
    const handle = enqueueLutFit({ folder: '/photos', pairs, name: 'Classic Chrome' });
    await waitFor(() => expect(mocks.fitLut).toHaveBeenCalled());
    const job = mocks.fitLut.mock.calls[0]?.[3] as number;
    expect(mocks.fitLut).toHaveBeenCalledWith('/photos', pairs, 'Classic Chrome', job);
    mocks.progress?.({ job, done: 3, total: 22, detail: 'Fitting the LUT' });
    mocks.progress?.({ job: job + 1, done: 9, total: 9, detail: 'another job' });
    expect(useJobsStore.getState().jobs[handle.id]).toMatchObject({ kind: 'render', done: 3, total: 22 });
    finish(result());
    expect(await handle.result).toMatchObject({ state: 'done' });
    expect(useLutsStore.getState().luts.map((l) => l.id)).toEqual([FITTED.id]);
    expect(mocks.savePreset).toHaveBeenCalledTimes(1);
    expect(mocks.savePreset.mock.calls[0]?.[0]).toMatchObject({
      name: 'Classic Chrome (fitted)',
      look: true,
      settings: { look: { lut: { id: FITTED.id, name: 'Classic Chrome', strength: 100 } } },
    });
    expect(mocks.unlisten).toHaveBeenCalled();
  });

  it('replaces a preset of the same name and adds none when a look already uses the LUT', async () => {
    mocks.fitLut.mockResolvedValue(result());
    const old = {
      id: 'P1',
      name: 'Classic Chrome (fitted)',
      sections: ['look'],
      settings: {},
      builtIn: false,
      look: true,
    };
    mocks.listPresets.mockResolvedValueOnce([old]);
    await enqueueLutFit({ folder: '/photos', pairs: [{ raw: 'a.RAF', jpeg: 'a.JPG' }], name: 'x' }).result;
    expect(mocks.savePreset.mock.calls[0]?.[0]).toMatchObject({ id: 'P1', name: 'Classic Chrome (fitted)' });
    mocks.savePreset.mockClear();
    const using = { ...old, name: 'Mine', settings: { look: { lut: { id: FITTED.id, name: 'x', strength: 80 } } } };
    mocks.listPresets.mockResolvedValueOnce([using]);
    await enqueueLutFit({ folder: '/photos', pairs: [{ raw: 'a.RAF', jpeg: 'a.JPG' }], name: 'x' }).result;
    expect(mocks.savePreset).not.toHaveBeenCalled();
  });

  it('Cancel goes to cancelDevelop and a Cancelled error ends the job cancelled', async () => {
    let fail: (e: unknown) => void = () => {};
    mocks.fitLut.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    const handle = enqueueLutFit({ folder: '/photos', pairs: [{ raw: 'a.RAF', jpeg: 'a.JPG' }], name: '' });
    await waitFor(() => expect(mocks.fitLut).toHaveBeenCalled());
    useJobsStore.getState().cancel(handle.id);
    expect(mocks.cancelDevelop).toHaveBeenCalledWith(mocks.fitLut.mock.calls[0]?.[3]);
    fail('Cancelled');
    expect(await handle.result).toEqual({ state: 'cancelled' });
    expect(mocks.savePreset).not.toHaveBeenCalled();
  });
});

describe('Look section: Match camera JPEG', () => {
  it('suggests the fitted look for the photo’s film simulation and applies it', async () => {
    mount();
    expect(await screen.findByText('Suggested: Classic Chrome (fitted)')).toBeTruthy();
    expect(mocks.filmSimulation).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('f1.jpg'));
    fireEvent.click(button('Apply'));
    expect(develop()?.look.lut).toEqual({ id: FITTED.id, name: 'Classic Chrome', strength: 100 });
    // Applied: no longer suggested.
    await waitFor(() => expect(screen.queryByText('Suggested: Classic Chrome (fitted)')).toBeNull());
  });

  it('does not suggest a LUT fitted on another camera', async () => {
    mocks.filmSimulation.mockResolvedValue({ simulation: 'Classic Chrome', camera: 'Fujifilm X100V' });
    mount();
    await screen.findByRole('listbox', { name: 'Looks' });
    await waitFor(() => expect(mocks.filmSimulation).toHaveBeenCalled());
    expect(screen.queryByText(/Suggested:/)).toBeNull();
  });

  it('shows nothing for a photo without a simulation', async () => {
    mocks.filmSimulation.mockResolvedValue(null);
    mount();
    await screen.findByRole('listbox', { name: 'Looks' });
    await waitFor(() => expect(mocks.filmSimulation).toHaveBeenCalled());
    expect(screen.queryByText(/Suggested:/)).toBeNull();
  });

  it('pairs the folder, fits the chosen pairs and applies the result', async () => {
    mocks.fitLut.mockResolvedValue(result());
    mount();
    await openMatchCamera();
    const dialog = await screen.findByRole('dialog', { name: 'Match camera JPEG' });
    await waitFor(() => expect(dialog.querySelectorAll('input[type=checkbox]')).toHaveLength(2));
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    await waitFor(() => expect(boxes.every((b) => b.checked)).toBe(true));
    expect((screen.getByRole('textbox', { name: 'Look name' }) as HTMLInputElement).value).toBe('Classic Chrome');
    fireEvent.click(button('Fit look'));
    await screen.findByText(/mean ΔE 1\.2 over 1 pair/);
    expect(screen.getByText(/cover 10 %/)).toBeTruthy();
    expect(mocks.fitLut.mock.calls[0]?.slice(0, 3)).toEqual([
      expect.any(String),
      [
        { raw: 'DSCF0001.RAF', jpeg: 'DSCF0001.JPG' },
        { raw: 'DSCF0002.RAF', jpeg: 'DSCF0002.JPG' },
      ],
      'Classic Chrome',
    ]);
    expect(screen.getByText(/DSCF0002.RAF: The JPEG does not line up/)).toBeTruthy();
    fireEvent.click(button('Apply to this photo'));
    expect(develop()?.look.lut).toEqual({ id: FITTED.id, name: 'Classic Chrome', strength: 100 });
    expect(screen.queryByRole('dialog', { name: 'Match camera JPEG' })).toBeNull();
  });
});
