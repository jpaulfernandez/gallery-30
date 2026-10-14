import { createDevelop, DEVELOP_DEFAULTS, DevelopSchema } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { diffDevelop, formatValue, humanise, importedDevelop } from './xmpImport';

const imported = DevelopSchema.parse({
  ...createDevelop(),
  light: { exposure: 0.65, contrast: 15 },
  whiteBalance: { mode: 'incremental', temperature: 12, tint: -4 },
  color: { saturation: -5, mix: { orange: { saturation: 15 } } },
  curve: {
    luma: [
      [0, 0],
      [0.25, 0.23],
      [1, 1],
    ],
  },
  geometry: {
    rotate: 0,
    crop: { rect: { x: 0.1, y: 0.1, w: 0.7, h: 0.6 }, angle: 2.5, aspect: 'free' },
  },
});

describe('importedDevelop', () => {
  it('is the imported settings, replacing everything the photo had', () => {
    const current = DevelopSchema.parse({ ...createDevelop(), light: { exposure: -1, shadows: 40 } });
    const out = importedDevelop(current, imported, null, true);
    expect(out).toEqual(imported);
    expect(out).not.toBe(imported);
    expect(out.light.shadows).toBe(0);
  });

  it('applies the sidecar rotation to the geometry when asked', () => {
    const out = importedDevelop(undefined, imported, { rotate: 90, flipH: true }, true);
    expect(out.geometry).toMatchObject({ rotate: 90, flipH: true, flipV: false });
    // The crop that came with it is kept.
    expect(out.geometry.crop).toEqual(imported.geometry.crop);
  });

  it('keeps the photo’s own geometry when the rotation is declined', () => {
    const current = DevelopSchema.parse({ ...createDevelop(), geometry: { rotate: 270 } });
    const out = importedDevelop(current, imported, { rotate: 90, flipH: false }, false);
    expect(out.geometry).toEqual(current.geometry);
    expect(out.light.exposure).toBe(0.65);
    // No current settings: the default geometry.
    expect(importedDevelop(undefined, imported, { rotate: 90, flipH: false }, false).geometry).toEqual(
      DEVELOP_DEFAULTS.geometry,
    );
  });

  it('leaves the geometry alone when the orientation did not change', () => {
    expect(importedDevelop(undefined, imported, null, false).geometry).toEqual(imported.geometry);
    expect(importedDevelop(undefined, imported, undefined, true).geometry).toEqual(imported.geometry);
  });
});

describe('diffDevelop', () => {
  it('lists changed sliders, current to imported, in tree order', () => {
    const current = DevelopSchema.parse({ ...createDevelop(), light: { exposure: 0.1, contrast: 15 } });
    const rows = diffDevelop(current, imported);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath['light.exposure']).toMatchObject({ group: 'Light', label: 'Exposure', from: '0.1', to: '0.65' });
    // Unchanged values are not listed.
    expect(byPath['light.contrast']).toBeUndefined();
    expect(byPath['color.saturation']).toMatchObject({ group: 'Color', from: '0', to: '-5' });
    expect(byPath['color.mix.orange.saturation']).toMatchObject({ label: 'Mix › Orange › Saturation', to: '15' });
    expect(rows.findIndex((r) => r.path === 'light.exposure')).toBeLessThan(
      rows.findIndex((r) => r.path === 'color.saturation'),
    );
  });

  it('summarises lists and a crop that appears', () => {
    const rows = diffDevelop(createDevelop(), imported);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath['curve.luma']).toMatchObject({ from: '2 points', to: '3 points' });
    expect(byPath['geometry.crop']).toMatchObject({ from: 'none', to: 'set' });
    expect(byPath['whiteBalance.mode']).toMatchObject({ from: 'asShot', to: 'incremental' });
    expect(byPath['whiteBalance.temperature']).toMatchObject({ from: '–', to: '12' });
  });

  it('is empty for equal settings and ignores the version', () => {
    expect(diffDevelop(imported, structuredClone(imported))).toEqual([]);
    expect(diffDevelop(createDevelop(), createDevelop())).toEqual([]);
  });

  it('counts masks', () => {
    const withMasks = DevelopSchema.parse({
      ...createDevelop(),
      masks: [{ id: 'm1', name: 'Sky', components: [{ id: 'c1', kind: 'linear', from: [0, 0], to: [0, 1] }] }],
    });
    const rows = diffDevelop(withMasks, createDevelop());
    expect(rows).toEqual([{ path: 'masks', group: 'Masks', label: 'Masks', from: '1 mask', to: '0 masks' }]);
  });
});

describe('formatting', () => {
  it('rounds numbers and humanises names', () => {
    expect(formatValue('light.exposure', 0.123456)).toBe('0.123');
    expect(formatValue('x', null)).toBe('none');
    expect(formatValue('x', true)).toBe('on');
    expect(humanise('whiteBalance')).toBe('White balance');
    expect(humanise('mix')).toBe('Mix');
  });
});
