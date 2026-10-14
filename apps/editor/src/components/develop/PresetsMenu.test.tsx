// @vitest-environment jsdom
import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePreset, type Preset } from '../../lib/develop/presets';
import { useBookStore } from '../../store/book';

const mocks = vi.hoisted(() => ({
  listPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  writeXmpSidecar: vi.fn(),
}));
vi.mock('../../lib/tauri', () => mocks);

import { PresetsMenu } from './PresetsMenu';

const book = () => useBookStore.getState();
const develop = (id: string) => book().book?.assets[id]?.develop;
const SAVED_ID = '01J9ZK3Y8M0Q4R5T6V7W8X9YAB';

const settingsOf = (id: string): DevelopSettings => develop(id) ?? createDevelop();

function renderMenu(id = 'f1') {
  return render(<PresetsMenu assetId={id} settings={settingsOf(id)} />);
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Presets' }));
  return screen.findByRole('menu', { name: 'Presets' });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.listPresets.mockResolvedValue([]);
  mocks.savePreset.mockResolvedValue(undefined);
  mocks.deletePreset.mockResolvedValue(undefined);
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  cleanup();
  await book().close();
});

describe('PresetsMenu', () => {
  it('reads nothing until it opens, then lists the built-in presets and the saved ones', async () => {
    const saved: Preset = { ...makePreset('Warm', createDevelop(), ['color'], SAVED_ID) };
    mocks.listPresets.mockResolvedValue([saved]);
    renderMenu();
    expect(mocks.listPresets).not.toHaveBeenCalled();
    const menu = await openMenu();
    expect(mocks.listPresets).toHaveBeenCalledTimes(1);
    expect(within(menu).getByRole('menuitem', { name: 'Black & white' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Faded' })).toBeTruthy();
    expect(await within(menu).findByRole('menuitem', { name: 'Warm' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete preset Warm' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Save current as preset…' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Export settings as XMP sidecar…' })).toBeTruthy();
  });

  it('says so when nothing is saved, and when the read fails', async () => {
    renderMenu();
    const menu = await openMenu();
    expect(await within(menu).findByText('None saved yet')).toBeTruthy();
    cleanup();
    mocks.listPresets.mockRejectedValue('no app data dir');
    renderMenu();
    expect(await within(await openMenu()).findByText('no app data dir')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Black & white' })).toBeTruthy();
  });

  it('applies a built-in preset to this photo and closes', async () => {
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Black & white' }));
    expect(develop('f1')?.color.saturation).toBe(-100);
    expect(develop('f1')?.light.contrast).toBe(10);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('applies a saved preset', async () => {
    const source = { ...createDevelop(), light: { ...createDevelop().light, exposure: 1.2 } };
    mocks.listPresets.mockResolvedValue([makePreset('Bright', source, ['light'], SAVED_ID)]);
    renderMenu();
    fireEvent.click(await within(await openMenu()).findByRole('menuitem', { name: 'Bright' }));
    expect(develop('f1')?.light.exposure).toBe(1.2);
  });

  it('deletes a saved preset after confirming, then refreshes the list', async () => {
    const saved = makePreset('Warm', createDevelop(), ['color'], SAVED_ID);
    mocks.listPresets.mockResolvedValueOnce([saved]).mockResolvedValue([]);
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Delete preset Warm' }));
    expect(mocks.deletePreset).not.toHaveBeenCalled();
    expect(within(menu).getByText(/Delete “Warm”\?/)).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deletePreset).toHaveBeenCalledWith(SAVED_ID));
    expect(await within(menu).findByText('None saved yet')).toBeTruthy();
  });

  it('keeping a preset cancels the delete', async () => {
    mocks.listPresets.mockResolvedValue([makePreset('Warm', createDevelop(), ['color'], SAVED_ID)]);
    renderMenu();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Delete preset Warm' }));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Keep' }));
    expect(mocks.deletePreset).not.toHaveBeenCalled();
    expect(within(menu).getByRole('menuitem', { name: 'Warm' })).toBeTruthy();
  });

  it('Escape closes the menu', async () => {
    renderMenu();
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('arrow keys move through the items', async () => {
    renderMenu();
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items.at(-1));
  });
});

describe('Save current as preset', () => {
  async function openSave() {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Save current as preset…' }));
    return screen.findByRole('dialog', { name: 'Save as preset' });
  }

  it('starts with the edited sections checked, needs a name, and saves them through the command', async () => {
    book().setAssetDevelop('f1', { light: { exposure: 0.4 }, color: { saturation: -30 } });
    renderMenu();
    const dialog = await openSave();
    const box = (name: string) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box('Light').checked).toBe(true);
    expect(box('Color').checked).toBe(true);
    expect(box('Curve').checked).toBe(false);
    expect(box('Detail').checked).toBe(false);
    expect(within(dialog).getByText(/never part of a preset/)).toBeTruthy();

    const save = within(dialog).getByRole('button', { name: 'Save preset' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Moody ' } });
    fireEvent.click(box('Color'));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(mocks.savePreset).toHaveBeenCalledTimes(1));
    const preset = mocks.savePreset.mock.calls[0]?.[0] as Preset;
    expect(preset).toMatchObject({ name: 'Moody', sections: ['light'], builtIn: false });
    expect(preset.settings.light?.exposure).toBe(0.4);
    expect(preset.settings.color).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('checks every section for an unedited photo and cannot save with none', async () => {
    renderMenu();
    const dialog = await openSave();
    const boxes = within(dialog).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(7);
    expect(boxes.every((b) => b.checked)).toBe(true);
    for (const b of boxes) fireEvent.click(b);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'x' } });
    expect((within(dialog).getByRole('button', { name: 'Save preset' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error when saving fails and keeps the dialog', async () => {
    mocks.savePreset.mockRejectedValue('Access denied');
    renderMenu();
    const dialog = await openSave();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save preset' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Access denied');
    expect(screen.getByRole('dialog', { name: 'Save as preset' })).toBeTruthy();
  });

  it('Escape closes it without saving', async () => {
    renderMenu();
    const dialog = await openSave();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.savePreset).not.toHaveBeenCalled();
  });
});

describe('Export settings as XMP sidecar', () => {
  async function openExport() {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export settings as XMP sidecar…' }));
    return screen.findByRole('dialog', { name: 'Export settings as XMP sidecar' });
  }

  it('writes a lossless Photobook sidecar by default', async () => {
    book().setAssetDevelop('f1', { light: { exposure: 0.4 } });
    mocks.writeXmpSidecar.mockResolvedValue('/photos/fixture/f1.xmp');
    renderMenu();
    const dialog = await openExport();
    expect((within(dialog).getByRole('radio', { name: /Photobook \(lossless\)/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(within(dialog).queryByRole('note')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await within(dialog).findByText('Wrote /photos/fixture/f1.xmp');
    const call = mocks.writeXmpSidecar.mock.calls[0] ?? [];
    expect(call[0]).toBe('/photos');
    expect(call[1]).toBe('fixture/f1.jpg');
    expect((call[2] as DevelopSettings).light.exposure).toBe(0.4);
    expect(call[6]).toBe('photobook');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Lightroom choice shows the lossy warning and passes the orientation and size', async () => {
    useBookStore.setState((s) => {
      const asset = s.book?.assets.f1;
      if (asset) {
        asset.orientation = 6;
        asset.width = 1000;
        asset.height = 1500;
      }
    });
    mocks.writeXmpSidecar.mockResolvedValue('/photos/fixture/f1.xmp');
    renderMenu();
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Lightroom \(crs/ }));
    expect(within(dialog).getByRole('note').textContent).toMatch(/Lightroom renders these settings with its own maths/);
    expect(within(dialog).getByRole('note').textContent).toMatch(/Masks, AI denoise/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await within(dialog).findByRole('status');
    expect(mocks.writeXmpSidecar).toHaveBeenCalledWith(
      '/photos',
      'fixture/f1.jpg',
      expect.anything(),
      6,
      1000,
      1500,
      'crs',
    );
  });

  it('shows a failure and lets the user try again', async () => {
    mocks.writeXmpSidecar.mockRejectedValueOnce('IMG.xmp: XMP is not UTF-8').mockResolvedValue('/photos/x.xmp');
    renderMenu();
    const dialog = await openExport();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/not UTF-8/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    expect(await within(dialog).findByText(/Wrote \/photos\/x\.xmp/)).toBeTruthy();
  });
});

describe('dialog keys', () => {
  it('an open dialog is marked so the Develop view leaves the keys alone', async () => {
    const { dialogOpen } = await import('../ui/DialogShell');
    renderMenu();
    expect(dialogOpen()).toBe(false);
    const menu = await openMenu();
    act(() => fireEvent.click(within(menu).getByRole('menuitem', { name: 'Save current as preset…' })));
    await screen.findByRole('dialog');
    expect(dialogOpen()).toBe(true);
  });
});
