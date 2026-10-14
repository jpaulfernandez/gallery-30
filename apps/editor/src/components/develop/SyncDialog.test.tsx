// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newLinear, newMask } from '../../lib/develop/masks';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ listPresets: vi.fn() }));
vi.mock('../../lib/tauri', () => mocks);

import { SyncDialog } from './SyncDialog';

const book = () => useBookStore.getState();
const develop = (id: string) => book().book?.assets[id]?.develop;

function file(id: string, mtime: number, extra: Partial<AssetFile> = {}): AssetFile {
  return {
    relPath: `fixture/${id}.jpg`,
    assetId: id,
    size: 1,
    mtime,
    kind: 'jpeg',
    status: 'ready',
    thumbUrl: `asset://thumb/${id}.jpg`,
    ...extra,
  };
}

const photo = (name: string) => screen.getByRole('button', { name: `${name}.jpg` });
const pressed = (name: string) => photo(name).getAttribute('aria-pressed') === 'true';
const section = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

function open(sourceId = 'f1') {
  act(() => useUiStore.getState().openSyncDialog(sourceId));
  return render(<SyncDialog />);
}

beforeEach(() => {
  mocks.listPresets.mockReset();
  mocks.listPresets.mockResolvedValue([]);
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({
    files: {
      'fixture/f1.jpg': file('f1', 1),
      'fixture/f2.jpg': file('f2', 2),
      'fixture/f3.jpg': file('f3', 3),
      'fixture/f4.jpg': file('f4', 4),
      'fixture/bad.jpg': file('bad', 5, { status: 'error' }),
    },
  });
  useUiStore.setState({ develop: null, syncDialog: null, filmstrip: DEFAULT_FILMSTRIP });
  book().setAssetDevelop('f1', {
    light: { exposure: 0.8 },
    color: { saturation: -25 },
    detail: { clarity: 15 },
    geometry: { transform: { vertical: 12 }, crop: { rect: { x: 0, y: 0, w: 0.6, h: 0.6 }, angle: 0, aspect: 'free' } },
  });
  book().addMask('f1', newMask('Sky', newLinear([0.5, 0], [0.5, 0.4]), 'sky'));
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  cleanup();
  useUiStore.getState().reset();
  await book().close();
  useAssetsStore.setState({ files: {} });
});

describe('SyncDialog', () => {
  it('lists the other photos of the filmstrip (not the source, not unreadable ones) and starts with none picked', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Sync settings from f1.jpg' });
    const list = within(dialog).getByRole('list', { name: 'Photos' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['f2.jpg', 'f3.jpg', 'f4.jpg']);
    expect(within(dialog).getByText('0 selected')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: /^Sync to 0 photos$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('checks the tone sections and leaves Transform and Masks off, warning when they are turned on', () => {
    open();
    expect(section(/^Basic/).checked).toBe(true);
    expect(section(/^Curve/).checked).toBe(true);
    expect(section(/^Color/).checked).toBe(true);
    expect(section(/^Detail/).checked).toBe(true);
    expect(section(/^Effects/).checked).toBe(true);
    expect(section(/^Transform/).checked).toBe(false);
    expect(section(/^Masks/).checked).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(section(/^Transform/));
    expect(screen.getByRole('note').textContent).toMatch(/crop is never synced/);
    expect(screen.getByText(/crop, rotation and flips are never synced/)).toBeTruthy();
  });

  it('syncs the default sections to the picked photos as one undo step, then closes', () => {
    open();
    fireEvent.click(photo('f2'));
    fireEvent.click(photo('f4'));
    expect(pressed('f2')).toBe(true);
    expect(pressed('f3')).toBe(false);
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sync to 2 photos' }));

    expect(develop('f2')?.light.exposure).toBe(0.8);
    expect(develop('f4')?.color.saturation).toBe(-25);
    expect(develop('f4')?.detail.clarity).toBe(15);
    expect(develop('f3')).toBeUndefined();
    // Transform, crop and masks were not asked for.
    expect(develop('f2')?.geometry.transform.vertical).toBe(0);
    expect(develop('f2')?.geometry.crop).toBeNull();
    expect(develop('f2')?.masks).toEqual([]);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    expect(useUiStore.getState().syncDialog).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('respects unchecked sections', () => {
    open();
    fireEvent.click(section(/^Color/));
    fireEvent.click(section(/^Detail/));
    fireEvent.click(photo('f2'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync to 1 photo' }));
    expect(develop('f2')?.light.exposure).toBe(0.8);
    expect(develop('f2')?.color.saturation).toBe(0);
    expect(develop('f2')?.detail.clarity).toBe(0);
  });

  it('cannot sync with no section checked', () => {
    open();
    for (const name of [/^Basic/, /^Curve/, /^Color/, /^Detail/, /^Effects/, /^Look/]) fireEvent.click(section(name));
    fireEvent.click(photo('f2'));
    expect((screen.getByRole('button', { name: 'Sync to 1 photo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Transform and Masks sync when checked, and the source crop still does not', () => {
    open();
    for (const name of [/^Basic/, /^Curve/, /^Color/, /^Detail/]) fireEvent.click(section(name));
    fireEvent.click(section(/^Transform/));
    fireEvent.click(section(/^Masks/));
    fireEvent.click(photo('f3'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync to 1 photo' }));
    expect(develop('f3')?.geometry.transform.vertical).toBe(12);
    // The source's crop (0.6 wide) is not copied; the target's own crop is only fitted inside its new warp.
    expect(develop('f3')?.geometry.crop?.rect.w).not.toBe(0.6);
    expect(develop('f3')?.light.exposure).toBe(0);
    expect(develop('f3')?.masks).toHaveLength(1);
    expect(develop('f3')?.masks[0]?.id).not.toBe('sky');
  });

  it('Select all and Select none, and Shift-click picks a range', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('3 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(screen.getByText('0 selected')).toBeTruthy();
    fireEvent.click(photo('f2'));
    fireEvent.click(photo('f4'), { shiftKey: true });
    expect([pressed('f2'), pressed('f3'), pressed('f4')]).toEqual([true, true, true]);
    fireEvent.click(photo('f3'));
    expect(pressed('f3')).toBe(false);
  });

  it('follows the photos the Develop view is stepping through when it is open', () => {
    act(() => useUiStore.getState().openDevelop(['f3', 'f1', 'f2'], 1));
    open();
    const list = screen.getByRole('list', { name: 'Photos' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['f3.jpg', 'f2.jpg']);
  });

  it('applies a preset to the picked photos, the source included', async () => {
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'What to apply' }), { target: { value: 'builtin:bw' } });
    expect(screen.queryByRole('checkbox', { name: /^Basic/ })).toBeNull();
    const list = screen.getByRole('list', { name: 'Photos' });
    expect(within(list).getAllByRole('button')).toHaveLength(4);
    fireEvent.click(photo('f1'));
    fireEvent.click(photo('f3'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset to 2 photos' }));
    expect(develop('f1')?.color.saturation).toBe(-100);
    expect(develop('f1')?.light.exposure).toBe(0.8);
    expect(develop('f3')?.color.saturation).toBe(-100);
    expect(develop('f2')).toBeUndefined();
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
  });

  it('offers saved presets too', async () => {
    mocks.listPresets.mockResolvedValue([
      {
        id: '01J9ZK3Y8M0Q4R5T6V7W8X9YAB',
        name: 'Moody',
        sections: ['light'],
        settings: { light: { exposure: -0.5 } },
        builtIn: false,
      },
    ]);
    open();
    expect(await screen.findByRole('option', { name: 'Preset: Moody' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'What to apply' }), {
      target: { value: '01J9ZK3Y8M0Q4R5T6V7W8X9YAB' },
    });
    fireEvent.click(photo('f2'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset to 1 photo' }));
    expect(develop('f2')?.light.exposure).toBe(-0.5);
  });

  it('says so when the filmstrip has no other photo', () => {
    useAssetsStore.setState({ files: { 'fixture/f1.jpg': file('f1', 1) } });
    open();
    expect(screen.getByText(/no other photos/)).toBeTruthy();
  });

  it('Cancel and Escape close it without changing anything', () => {
    open();
    fireEvent.click(photo('f2'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useUiStore.getState().syncDialog).toBeNull();
    expect(develop('f2')).toBeUndefined();

    cleanup();
    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useUiStore.getState().syncDialog).toBeNull();
  });
});
