// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useLutsStore } from '../../store/luts';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const WARM = { id: 'a'.repeat(64), name: 'Warm', size: 33 };
const COOL = { id: 'b'.repeat(64), name: 'Cool', size: 17 };

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  commit: vi.fn(),
  listLuts: vi.fn(),
  importLut: vi.fn(),
  deleteLut: vi.fn(),
  lutPresent: vi.fn(),
  open: vi.fn(),
  ask: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  listLuts: mocks.listLuts,
  importLut: mocks.importLut,
  deleteLut: mocks.deleteLut,
  lutPresent: mocks.lutPresent,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open, ask: mocks.ask, save: vi.fn() }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
const book = () => useBookStore.getState();
const develop = () => book().book?.assets.f1?.develop;
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
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.listLuts.mockResolvedValue([COOL, WARM]);
  mocks.lutPresent.mockResolvedValue(true);
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
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

describe('LUT picker (LookSection, inside Looks)', () => {
  it('sits in the Looks section at the top of the panel and lists the LUTs (plan 20)', async () => {
    mount();
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections[0]).toBe('Looks');
    expect(sections).not.toContain('Look');
    expect(mocks.lutPresent).not.toHaveBeenCalled();
    fireEvent.click(button(/^LUT/));
    const select = (await screen.findByRole('combobox', { name: 'LUT' })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Cool (17³)', 'Warm (33³)']);
    expect(button('Reset Looks').disabled).toBe(true);
  });

  it('picks a LUT at full strength, sets the strength and resets', async () => {
    mount();
    fireEvent.click(button(/^LUT/));
    const select = (await screen.findByRole('combobox', { name: 'LUT' })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    fireEvent.change(select, { target: { value: WARM.id } });
    expect(develop()?.look.lut).toEqual({ id: WARM.id, name: 'Warm', strength: 100 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Strength' }), { key: 'PageDown' });
    expect(develop()?.look.lut?.strength).toBe(90);
    // Another LUT keeps the strength.
    fireEvent.change(select, { target: { value: COOL.id } });
    expect(develop()?.look.lut).toEqual({ id: COOL.id, name: 'Cool', strength: 90 });
    fireEvent.click(button('Reset Looks'));
    // Back to defaults (the photo may be unedited again, so no develop at all).
    expect(develop()?.look?.lut ?? null).toBeNull();
  });

  it('imports a picked file and applies it, and shows why an import failed', async () => {
    mocks.open.mockResolvedValueOnce('/Users/me/Looks/Film.cube');
    mocks.importLut.mockResolvedValueOnce({ id: 'c'.repeat(64), name: 'Film', size: 65 });
    mount();
    fireEvent.click(button(/^LUT/));
    fireEvent.click(await screen.findByRole('button', { name: 'Import…' }));
    await waitFor(() => expect(develop()?.look.lut?.name).toBe('Film'));
    expect(mocks.importLut).toHaveBeenCalledWith('/Users/me/Looks/Film.cube');
    expect(mocks.open.mock.calls[0]?.[0]).toMatchObject({ filters: [{ extensions: ['cube', 'png'] }] });

    mocks.open.mockResolvedValueOnce('/Users/me/Looks/curve.cube');
    mocks.importLut.mockRejectedValueOnce('This is a 1D LUT; only 3D LUTs (LUT_3D_SIZE) can be imported');
    fireEvent.click(button('Import…'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/1D LUT/);
    expect(develop()?.look.lut?.name).toBe('Film');
  });

  it('says when the LUT file is missing and Locate re-points it, keeping the strength', async () => {
    mocks.lutPresent.mockImplementation(async (id: string) => id !== 'd'.repeat(64));
    act(() => book().setAssetDevelop('f1', { look: { lut: { id: 'd'.repeat(64), name: 'Gone', strength: 40 } } }));
    mount();
    expect(await screen.findByText('LUT missing: Gone')).toBeTruthy();
    expect(mocks.lutPresent).toHaveBeenCalledWith('d'.repeat(64));
    mocks.open.mockResolvedValueOnce('/Volumes/Old/Gone.cube');
    mocks.importLut.mockResolvedValueOnce({ id: 'e'.repeat(64), name: 'Gone', size: 33 });
    fireEvent.click(button('Locate…'));
    await waitFor(() => expect(develop()?.look.lut).toEqual({ id: 'e'.repeat(64), name: 'Gone', strength: 40 }));
    await waitFor(() => expect(screen.queryByText('LUT missing: Gone')).toBeNull());
  });

  it('Locate on the same file renders the preview again (same settings, the LUT is back)', async () => {
    let present = false;
    mocks.lutPresent.mockImplementation(async () => present);
    const lut = { id: 'd'.repeat(64), name: 'Gone', strength: 40 };
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.5 }, look: { lut } }));
    mount();
    expect(await screen.findByText('LUT missing: Gone')).toBeTruthy();
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    const before = mocks.render.mock.calls.length;
    mocks.open.mockResolvedValueOnce('/Volumes/Old/Gone.cube');
    mocks.importLut.mockImplementationOnce(async () => {
      present = true;
      return { id: lut.id, name: 'Gone', size: 33 };
    });
    fireEvent.click(button('Locate…'));
    await waitFor(() => expect(mocks.render.mock.calls.length).toBeGreaterThan(before));
    expect(develop()?.look.lut).toEqual(lut);
    expect(useLutsStore.getState().epoch).toBe(1);
    expect(screen.queryByText('LUT missing: Gone')).toBeNull();
  });
});
