import { createDevelop, type DevelopMask } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newLinear, newMask } from '../lib/develop/masks';
import { PRESET_BW, PRESET_FADED } from '../lib/develop/presets';
import type { XmpImport } from '../lib/tauri';
import { undo, useBookStore } from './book';

const mocks = vi.hoisted(() => ({ savePreset: vi.fn() }));
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  savePreset: mocks.savePreset,
}));

const store = () => useBookStore.getState();
const develop = (id: string) => store().book?.assets[id]?.develop;
const steps = () => useBookStore.temporal.getState().pastStates.length;

function imported(patch: Record<string, unknown>): XmpImport {
  return {
    settings: { ...createDevelop(), ...patch } as XmpImport['settings'],
    processVersion: '15.4',
    dropped: [],
    alreadyApplied: false,
    orientation: 1,
    ignored: [],
  };
}

beforeEach(() => {
  mocks.savePreset.mockReset();
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  await store().close();
});

describe('applyDevelopPreset', () => {
  it('applies a built-in preset to every photo as one undo step, skipping unknown ids and no-ops', () => {
    store().setAssetDevelop('f1', { light: { exposure: 0.5 }, geometry: { rotate: 90 } });
    useBookStore.temporal.getState().clear();
    expect(store().applyDevelopPreset(['f1', 'f2', 'f3', 'missing'], PRESET_BW)).toBe(3);
    expect(steps()).toBe(1);
    expect(develop('f1')).toMatchObject({ light: { exposure: 0.5, contrast: 10 }, color: { saturation: -100 } });
    expect(develop('f1')?.geometry.rotate).toBe(90);
    expect(develop('f2')?.color.saturation).toBe(-100);
    // The same preset again changes nothing and records nothing.
    expect(store().applyDevelopPreset(['f1', 'f2'], PRESET_BW)).toBe(0);
    expect(steps()).toBe(1);
    undo();
    expect(develop('f2')).toBeUndefined();
    expect(develop('f1')?.color.saturation).toBe(0);
  });

  it('keeps masks and the crop of the photo and can stack with another preset', () => {
    const mask = newMask('Sky', newLinear([0.5, 0], [0.5, 0.4]), 'm1');
    store().addMask('f1', mask);
    store().applyDevelopPreset(['f1'], PRESET_BW);
    store().applyDevelopPreset(['f1'], PRESET_FADED);
    expect(develop('f1')?.masks.map((m) => m.id)).toEqual(['m1']);
    expect(develop('f1')?.color.saturation).toBe(-20);
    expect(develop('f1')?.curve.luma).toEqual([
      [0, 0.08],
      [1, 0.96],
    ]);
    expect(develop('f1')?.light.contrast).toBe(10);
  });

  it('removes the develop key when the result is the defaults', () => {
    store().setAssetDevelop('f1', { color: { saturation: -100 } });
    const undoPreset = { sections: ['color' as const], settings: { color: { saturation: 0 } } };
    expect(store().applyDevelopPreset(['f1'], undoPreset)).toBe(1);
    expect(develop('f1')).toBeUndefined();
  });
});

describe('syncDevelop', () => {
  beforeEach(() => {
    store().setAssetDevelop('f1', {
      light: { exposure: 0.9 },
      whiteBalance: { mode: 'incremental', temperature: 8, tint: 0 },
      curve: { parametric: { shadows: 15 } },
      color: { saturation: -12 },
      detail: { clarity: 22 },
    });
    store().setAssetDevelop('f2', { light: { exposure: -1 }, geometry: { rotate: 270 } });
    useBookStore.temporal.getState().clear();
  });

  it('copies the checked sections to the targets in one undo step and never touches rotation', () => {
    expect(store().syncDevelop('f1', ['f2', 'f3', 'f1'], ['basic', 'color'])).toBe(2);
    expect(steps()).toBe(1);
    expect(develop('f2')?.light.exposure).toBe(0.9);
    expect(develop('f2')?.whiteBalance).toEqual({ mode: 'incremental', temperature: 8, tint: 0 });
    expect(develop('f2')?.color.saturation).toBe(-12);
    expect(develop('f2')?.curve.parametric.shadows).toBe(0);
    expect(develop('f2')?.detail.clarity).toBe(0);
    expect(develop('f2')?.geometry.rotate).toBe(270);
    expect(develop('f3')?.light.exposure).toBe(0.9);
    // The source is skipped.
    expect(develop('f1')?.light.exposure).toBe(0.9);
    undo();
    expect(develop('f2')?.light.exposure).toBe(-1);
    expect(develop('f3')).toBeUndefined();
  });

  it('does nothing without sections or for an unknown source', () => {
    expect(store().syncDevelop('f1', ['f2'], [])).toBe(0);
    expect(store().syncDevelop('nope', ['f2'], ['basic'])).toBe(0);
    expect(steps()).toBe(0);
  });

  it('the default sections leave the target’s masks and geometry alone', () => {
    store().addMask('f2', newMask('Mine', newLinear([0, 0], [0, 1]), 'mine'));
    store().setAssetDevelop('f1', {
      geometry: {
        transform: { vertical: 30 },
        crop: { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' },
      },
    });
    store().syncDevelop('f1', ['f2'], ['basic', 'curve', 'color', 'detail']);
    expect(develop('f2')?.masks.map((m) => m.id)).toEqual(['mine']);
    expect(develop('f2')?.geometry.transform.vertical).toBe(0);
    expect(develop('f2')?.geometry.crop).toBeNull();
  });

  it('transform copies the Upright result and the sliders but never the crop', () => {
    const crop = { rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' as const };
    store().setAssetDevelop('f1', { geometry: { transform: { vertical: 20, rotate: 1.5 }, crop } });
    store().setAssetDevelop('f2', {
      geometry: { crop: { rect: { x: 0, y: 0, w: 0.9, h: 0.9 }, angle: 0, aspect: 'free' } },
    });
    expect(store().syncDevelop('f1', ['f2'], ['transform'])).toBe(1);
    const g = develop('f2')?.geometry;
    expect(g?.transform).toMatchObject({ vertical: 20, rotate: 1.5 });
    expect(g?.crop).not.toBeNull();
    expect(g?.crop?.rect).not.toEqual(crop.rect);
    // Rotation is never synced.
    expect(g?.rotate).toBe(270);
    // Tone untouched.
    expect(develop('f2')?.light.exposure).toBe(-1);
  });

  it('masks replace the target’s with copies that have new ids', () => {
    const mask: DevelopMask = newMask('Sky', newLinear([0.5, 0], [0.5, 0.4]), 'sky');
    store().addMask('f1', mask);
    store().addMask('f2', newMask('Old', newLinear([0, 0], [0, 1]), 'old'));
    expect(store().syncDevelop('f1', ['f2'], ['masks'])).toBe(1);
    const copied = develop('f2')?.masks ?? [];
    expect(copied).toHaveLength(1);
    expect(copied[0]?.name).toBe('Sky');
    expect(copied[0]?.id).not.toBe('sky');
    expect(copied[0]?.components[0]?.id).not.toBe(mask.components[0]?.id);
    expect(develop('f1')?.masks[0]?.id).toBe('sky');
  });
});

describe('importXmp', () => {
  it('sets the photo’s develop settings to the imported ones over the defaults', () => {
    store().setAssetDevelop('f1', { light: { shadows: 40 }, color: { vibrance: 30 } });
    useBookStore.temporal.getState().clear();
    const xmp = imported({ light: { ...createDevelop().light, exposure: 0.65, contrast: 15 } });
    expect(store().importXmp('f1', xmp, { applyOrientation: true })).toBe(true);
    expect(steps()).toBe(1);
    expect(develop('f1')?.light).toMatchObject({ exposure: 0.65, contrast: 15, shadows: 0 });
    expect(develop('f1')?.color.vibrance).toBe(0);
    undo();
    expect(develop('f1')?.light.shadows).toBe(40);
  });

  it('applies the sidecar’s rotation only when asked', () => {
    const xmp = imported({ light: { ...createDevelop().light, exposure: 1 } });
    store().setAssetDevelop('f1', { geometry: { rotate: 180 } });
    store().importXmp('f1', xmp, { applyOrientation: true, orientationChange: { rotate: 90, flipH: true } });
    expect(develop('f1')?.geometry).toMatchObject({ rotate: 90, flipH: true, flipV: false });

    store().setAssetDevelop('f2', { geometry: { rotate: 180 } });
    store().importXmp('f2', xmp, { applyOrientation: false, orientationChange: { rotate: 90, flipH: true } });
    expect(develop('f2')?.geometry).toMatchObject({ rotate: 180, flipH: false });
    expect(develop('f2')?.light.exposure).toBe(1);

    // Without a change nothing is rotated, whatever the flag.
    store().importXmp('f3', xmp, { applyOrientation: true });
    expect(develop('f3')?.geometry.rotate).toBe(0);
  });

  it('imports defaults as "no develop settings"', () => {
    store().setAssetDevelop('f1', { light: { exposure: 1 } });
    expect(store().importXmp('f1', imported({}), { applyOrientation: true })).toBe(true);
    expect(develop('f1')).toBeUndefined();
    expect(store().importXmp('f1', imported({}), { applyOrientation: true })).toBe(false);
  });

  it('rejects settings the schema does not accept', () => {
    const bad = imported({ light: { ...createDevelop().light, exposure: 99 } });
    expect(store().importXmp('f1', bad, { applyOrientation: true })).toBe(false);
    expect(develop('f1')).toBeUndefined();
  });

  it('importXmpMany is one undo step and counts the photos it changed', () => {
    const a = imported({ light: { ...createDevelop().light, exposure: 0.2 } });
    const b = imported({ light: { ...createDevelop().light, exposure: 0.4 } });
    const n = store().importXmpMany(
      [
        { assetId: 'f1', imported: a },
        { assetId: 'f2', imported: b, orientationChange: { rotate: 90, flipH: false } },
        { assetId: 'missing', imported: a },
      ],
      { applyOrientation: true },
    );
    expect(n).toBe(2);
    expect(steps()).toBe(1);
    expect(develop('f1')?.light.exposure).toBe(0.2);
    expect(develop('f2')?.light.exposure).toBe(0.4);
    expect(develop('f2')?.geometry.rotate).toBe(90);
    undo();
    expect(develop('f1')).toBeUndefined();
    expect(develop('f2')).toBeUndefined();
  });
});

describe('savePresetFromAsset', () => {
  it('saves the chosen sections of the photo’s settings through the command and returns the preset', async () => {
    store().setAssetDevelop('f1', { light: { exposure: 0.4 }, color: { saturation: -30 }, detail: { clarity: 10 } });
    mocks.savePreset.mockResolvedValue(undefined);
    const preset = await store().savePresetFromAsset('f1', ' Moody ', ['light', 'color']);
    expect(mocks.savePreset).toHaveBeenCalledTimes(1);
    expect(mocks.savePreset).toHaveBeenCalledWith(preset);
    expect(preset).toMatchObject({ name: 'Moody', sections: ['light', 'color'], builtIn: false });
    expect(preset.settings.light?.exposure).toBe(0.4);
    expect(preset.settings.detail).toBeUndefined();
    expect(preset.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    // Saving a preset is not an edit of the book.
    expect(steps()).toBeGreaterThanOrEqual(1);
  });

  it('rejects when the command fails or the photo is unknown', async () => {
    mocks.savePreset.mockRejectedValue('disk full');
    await expect(store().savePresetFromAsset('f1', 'x', ['light'])).rejects.toBe('disk full');
    await expect(store().savePresetFromAsset('nope', 'x', ['light'])).rejects.toThrow(/not in the project/);
  });
});
