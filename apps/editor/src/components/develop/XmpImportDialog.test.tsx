// @vitest-environment jsdom
import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XmpImport, XmpImportResult } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ readXmp: vi.fn() }));
vi.mock('../../lib/tauri', () => ({ readXmp: mocks.readXmp }));

import { XmpImportDialog } from './XmpImportDialog';

const book = () => useBookStore.getState();
const develop = (id: string) => book().book?.assets[id]?.develop;

function settings(patch: Partial<DevelopSettings>): DevelopSettings {
  return { ...createDevelop(), ...patch };
}

function result(patch: Partial<XmpImport> = {}, extra: Partial<XmpImportResult> = {}): XmpImportResult {
  const light = { ...createDevelop().light, exposure: 0.65, contrast: 15 };
  return {
    import: {
      settings: settings({ light, color: { ...createDevelop().color, saturation: -5 } }),
      processVersion: '15.4',
      dropped: [
        { field: 'MaskGroupBasedCorrections', reason: '2 masks are not imported', kind: 'dropped' },
        { field: 'CropAngle', reason: 'Rotation centre assumed', kind: 'unverified' },
      ],
      alreadyApplied: false,
      orientation: 1,
      ignored: [],
      ...patch,
    },
    source: 'sidecar',
    format: 'crs',
    sidecarPath: '/photos/fixture/f1.xmp',
    orientationChange: null,
    ...extra,
  };
}

const none: XmpImportResult = { import: null, source: null, format: null, sidecarPath: null, orientationChange: null };

function open(ids: string[]) {
  act(() => useUiStore.getState().openXmpImport(ids));
  return render(<XmpImportDialog />);
}

beforeEach(() => {
  mocks.readXmp.mockReset();
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.setState({ xmpImportDialog: null });
});

afterEach(async () => {
  cleanup();
  useUiStore.getState().reset();
  await book().close();
});

describe('XmpImportDialog for one photo', () => {
  it('reads the photo’s sidecar and shows what would change, what was dropped and what is unverified', async () => {
    mocks.readXmp.mockResolvedValue(result());
    open(['f1']);
    const dialog = await screen.findByRole('dialog', { name: 'Import Lightroom settings' });
    expect(mocks.readXmp).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', undefined);

    const table = await within(dialog).findByRole('table', { name: 'Settings the import changes' });
    const row = (name: RegExp) => within(table).getByText(name).closest('tr') as HTMLElement;
    expect(within(row(/^Exposure$/)).getByText('0')).toBeTruthy();
    expect(within(row(/^Exposure$/)).getByText('0.65')).toBeTruthy();
    expect(within(row(/^Contrast$/)).getByText('15')).toBeTruthy();
    expect(within(row(/^Saturation$/)).getByText('-5')).toBeTruthy();
    expect(within(table).queryByText(/^Highlights$/)).toBeNull();

    expect(within(dialog).getByText('Not imported')).toBeTruthy();
    expect(within(dialog).getByText(/2 masks are not imported/)).toBeTruthy();
    expect(within(dialog).getByText('Imported, but unverified')).toBeTruthy();
    expect(within(dialog).getByText(/Rotation centre assumed/)).toBeTruthy();
    expect(within(dialog).getByText(/process version 15\.4/)).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('Apply writes the imported settings as one undo step and closes', async () => {
    mocks.readXmp.mockResolvedValue(result());
    book().setAssetDevelop('f1', { light: { shadows: 40 } });
    book().setAssetDevelop('f1', { light: { shadows: 41 } });
    useBookStore.temporal.getState().clear();
    open(['f1']);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(develop('f1')?.light).toMatchObject({ exposure: 0.65, contrast: 15, shadows: 0 });
    expect(develop('f1')?.color.saturation).toBe(-5);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    expect(useUiStore.getState().xmpImportDialog).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel and Escape close without changing anything', async () => {
    mocks.readXmp.mockResolvedValue(result());
    open(['f1']);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(develop('f1')).toBeUndefined();
    expect(useUiStore.getState().xmpImportDialog).toBeNull();

    cleanup();
    open(['f1']);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useUiStore.getState().xmpImportDialog).toBeNull();
    expect(develop('f1')).toBeUndefined();
  });

  it('offers the sidecar’s rotation, on by default, and previews its effect on the geometry', async () => {
    const crop = { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' as const };
    const withCrop = settings({ geometry: { ...createDevelop().geometry, crop } });
    mocks.readXmp.mockResolvedValue(
      result({ settings: withCrop, orientation: 6 }, { orientationChange: { rotate: 90, flipH: false } }),
    );
    book().setAssetDevelop('f1', { geometry: { rotate: 180 } });
    open(['f1']);
    const box = await screen.findByRole('checkbox', { name: /Also apply the sidecar’s rotation/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/turns it 90° clockwise/)).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getByText(/Rotate/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(develop('f1')?.geometry.rotate).toBe(90);
    expect(develop('f1')?.geometry.crop).toEqual(crop);
  });

  it('declining the rotation keeps the photo’s own geometry', async () => {
    mocks.readXmp.mockResolvedValue(result({ orientation: 6 }, { orientationChange: { rotate: 90, flipH: false } }));
    book().setAssetDevelop('f1', { geometry: { rotate: 180 } });
    open(['f1']);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Also apply the sidecar’s rotation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(develop('f1')?.geometry.rotate).toBe(180);
    expect(develop('f1')?.light.exposure).toBe(0.65);
  });

  it('passes the file’s EXIF orientation so the command can tell whether the photo was rotated', async () => {
    mocks.readXmp.mockResolvedValue(none);
    useBookStore.setState((s) => {
      if (s.book?.assets.f1) s.book.assets.f1.orientation = 6;
    });
    open(['f1']);
    await screen.findByText(/No Lightroom settings found/);
    expect(mocks.readXmp).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', 6);
  });

  it('says so when there is no sidecar, and offers no Apply', async () => {
    mocks.readXmp.mockResolvedValue(none);
    open(['f1']);
    expect(await screen.findByText(/No Lightroom settings found for f1\.jpg/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a read error', async () => {
    mocks.readXmp.mockRejectedValue('IMG.xmp: XMP is not UTF-8');
    open(['f1']);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not UTF-8/);
  });

  it('warns about an exported JPEG whose pixels already carry the settings', async () => {
    mocks.readXmp.mockResolvedValue(result({ alreadyApplied: true }, { source: 'embedded', sidecarPath: null }));
    open(['f1']);
    expect((await screen.findByRole('note')).textContent).toMatch(/already has these settings applied/);
    expect(screen.getByText(/embedded in the JPEG/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply anyway' })).toBeTruthy();
  });

  it('says when nothing would change', async () => {
    mocks.readXmp.mockResolvedValue(result({ settings: createDevelop() }));
    open(['f1']);
    expect(await screen.findByText(/Nothing would change/)).toBeTruthy();
  });

  it('calls our own packet exact', async () => {
    mocks.readXmp.mockResolvedValue(result({ dropped: [], processVersion: null }, { format: 'photobook' }));
    open(['f1']);
    expect(await screen.findByText(/Photobook settings, exact/)).toBeTruthy();
  });
});

describe('XmpImportDialog for several photos', () => {
  it('summarises what each photo has and imports the ones with settings, skipping applied exports', async () => {
    mocks.readXmp.mockImplementation(async (_folder: string, rel: string) => {
      if (rel.endsWith('f1.jpg')) return result();
      if (rel.endsWith('f2.jpg')) return none;
      if (rel.endsWith('f3.jpg')) return result({ alreadyApplied: true });
      throw 'unreadable';
    });
    open(['f1', 'f2', 'f3', 'f4']);
    const dialog = await screen.findByRole('dialog', { name: 'Import Lightroom settings for 4 photos' });
    await within(dialog).findByText(/1 of 4 photos have settings to import/);
    expect(within(dialog).getByText(/1 without a sidecar/)).toBeTruthy();
    expect(within(dialog).getByText(/1 already applied/)).toBeTruthy();
    expect(within(dialog).getByText(/1 could not be read/)).toBeTruthy();
    const list = within(dialog).getByRole('list', { name: 'Photos' });
    expect(within(list).getByText('No settings found')).toBeTruthy();
    expect(within(list).getAllByText(/Lightroom settings|skipped|unreadable/)).toHaveLength(3);
    expect(within(dialog).getByText('MaskGroupBasedCorrections')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Import for 1 photo' }));
    expect(develop('f1')?.light.exposure).toBe(0.65);
    expect(develop('f3')).toBeUndefined();
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    expect(await within(dialog).findByText(/Imported settings for 1 photo\./)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().xmpImportDialog).toBeNull();
  });

  it('reads with a bounded number of reads in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.readXmp.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return none;
    });
    open(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    await waitFor(() => expect(screen.getByText(/0 of 6 photos have settings/)).toBeTruthy());
    expect(mocks.readXmp).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
