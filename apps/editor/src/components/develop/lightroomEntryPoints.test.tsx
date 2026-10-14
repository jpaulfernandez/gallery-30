// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { Filmstrip } from '../filmstrip/Filmstrip';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  mask: vi.fn(),
  commit: vi.fn(),
  readXmp: vi.fn(),
  listPresets: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  developSharpenMask: mocks.mask,
  readXmp: mocks.readXmp,
  listPresets: mocks.listPresets,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { expectMenuKeys } from '../ui/testing';
import { DevelopMode } from './DevelopMode';
import { SyncDialog } from './SyncDialog';
import { XmpImportDialog } from './XmpImportDialog';

const IDS = ['f1', 'f2', 'f3'];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

function files(): Record<string, AssetFile> {
  return Object.fromEntries(
    IDS.map((id, i) => [
      `fixture/${id}.jpg`,
      {
        relPath: `fixture/${id}.jpg`,
        assetId: id,
        size: 1,
        mtime: i + 1,
        kind: 'jpeg',
        hash: `hash-${id}`,
        status: 'ready',
        proxyUrl: `asset://proxy/${id}.jpg`,
        thumbUrl: `asset://thumb/${id}.jpg`,
      } satisfies AssetFile,
    ]),
  );
}

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.mask.mockReset();
  mocks.commit.mockReset();
  mocks.readXmp.mockReset();
  mocks.readXmp.mockResolvedValue({
    import: null,
    source: null,
    format: null,
    sidecarPath: null,
    orientationChange: null,
  });
  mocks.listPresets.mockReset();
  mocks.listPresets.mockResolvedValue([]);
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, syncDialog: null, xmpImportDialog: null, filmstrip: DEFAULT_FILMSTRIP });
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  useUiStore.getState().reset();
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('Develop panel header', () => {
  it('has Presets beside a ⋯ menu with Sync…, Copy, Copy…, Paste and Reset all (plan 46)', () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    expect(screen.getByRole('button', { name: 'Presets' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    for (const name of ['Sync…', 'Copy', 'Copy…', 'Paste', 'Reset all']) {
      // The name carries the shortcut ("Copy⇧⌘C"); "Copy" must not match "Copy…".
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${name}(?!…)`) })).toBeTruthy();
    }
  });

  it('the ⋯ menu opens on Enter, Space and ArrowDown and gives the focus back on Escape', () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    expectMenuKeys(() => screen.getByRole('button', { name: 'More actions' }), 'Develop');
  });

  it('Sync… opens the Sync dialog for the current photo over the Develop view', async () => {
    act(() => useUiStore.getState().openDevelop(IDS, 1));
    render(
      <>
        <DevelopMode />
        <SyncDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync…' }));
    expect(useUiStore.getState().syncDialog).toEqual({ sourceId: 'f2' });
    expect(await screen.findByRole('dialog', { name: 'Sync settings from f2.jpg' })).toBeTruthy();
    // Escape closes the dialog only; the Develop view stays open.
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Sync settings from f2.jpg' }), { key: 'Escape' });
    expect(useUiStore.getState().syncDialog).toBeNull();
    expect(useUiStore.getState().develop).not.toBeNull();
  });

  it('applies a built-in preset to the photo from the Presets menu', async () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Faded' }));
    expect(useBookStore.getState().book?.assets.f1?.develop?.color.saturation).toBe(-20);
  });
});

describe('Cmd+Shift+I in the Develop view', () => {
  it('opens the Lightroom import dialog for the current photo, and the dialog keeps its keys', async () => {
    act(() => useUiStore.getState().openDevelop(IDS, 2));
    render(
      <>
        <DevelopMode />
        <XmpImportDialog />
      </>,
    );
    fireEvent.keyDown(window, { key: 'i', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().xmpImportDialog).toEqual({ assetIds: ['f3'] });
    const dialog = await screen.findByRole('dialog', { name: 'Import Lightroom settings' });
    await waitFor(() => expect(mocks.readXmp).toHaveBeenCalledWith('/photos', 'fixture/f3.jpg', undefined));
    await screen.findByText(/No Lightroom settings found/);

    // Arrow keys and Escape belong to the dialog while it is open.
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(useUiStore.getState().develop?.index).toBe(2);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useUiStore.getState().xmpImportDialog).toBeNull();
    expect(useUiStore.getState().develop).not.toBeNull();
  });
});

describe('Filmstrip', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Import Lightroom settings… reads every photo the grid lists', async () => {
    render(
      <>
        <Filmstrip />
        <XmpImportDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import Lightroom settings…' }));
    expect(useUiStore.getState().xmpImportDialog?.assetIds).toEqual(IDS);
    await screen.findByRole('dialog', { name: 'Import Lightroom settings for 3 photos' });
    await waitFor(() => expect(mocks.readXmp).toHaveBeenCalledTimes(3));
  });

  it('is hidden while there are no photos', () => {
    useAssetsStore.setState({ files: {} });
    render(<Filmstrip />);
    expect(screen.queryByRole('button', { name: 'Import Lightroom settings…' })).toBeNull();
  });
});
