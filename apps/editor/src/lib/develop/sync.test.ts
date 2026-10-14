import { createDevelop, DevelopSchema, type DevelopSettings } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  applySections,
  copySectionsOf,
  DEFAULT_SYNC_SECTIONS,
  type DevelopSyncSection,
  SYNC_SECTIONS,
  SYNC_WARNINGS,
} from './sync';

/** What Sync applies of the tone sections. */
const syncTone = (source: DevelopSettings, target: DevelopSettings, sections: readonly DevelopSyncSection[]) =>
  applySections(source, target, copySectionsOf(sections));

const source = DevelopSchema.parse({
  ...createDevelop(),
  light: { exposure: 1, highlights: -40 },
  whiteBalance: { mode: 'incremental', temperature: 10, tint: -2 },
  curve: { parametric: { shadows: 20 } },
  color: { saturation: -15 },
  detail: { clarity: 30 },
  geometry: { rotate: 180 },
  effects: { grain: { amount: 20 }, grading: { shadows: { hue: 200, saturation: 15 } } },
  look: { lut: { id: 'f'.repeat(64), name: 'Warm', strength: 60 } },
});

describe('Sync sections through applySections', () => {
  it('basic copies light and white balance only', () => {
    const out = syncTone(source, createDevelop(), ['basic']);
    expect(out.light).toEqual(source.light);
    expect(out.whiteBalance).toEqual(source.whiteBalance);
    expect(out.curve).toEqual(createDevelop().curve);
    expect(out.color).toEqual(createDevelop().color);
    expect(out.detail).toEqual(createDevelop().detail);
    expect(out.geometry).toEqual(createDevelop().geometry);
  });

  it('copies each other section on its own and never the geometry', () => {
    for (const [section, key] of [
      ['curve', 'curve'],
      ['color', 'color'],
      ['detail', 'detail'],
      ['effects', 'effects'],
      ['look', 'look'],
    ] as const) {
      const out = syncTone(source, createDevelop(), [section]);
      expect(out[key]).toEqual(source[key]);
      expect(out.light).toEqual(createDevelop().light);
      expect(out.geometry.rotate).toBe(0);
    }
  });

  it('returns the target itself when no tone section is asked for', () => {
    const target = createDevelop();
    expect(syncTone(source, target, [])).toBe(target);
    expect(syncTone(source, target, ['transform', 'masks'])).toBe(target);
  });

  it('copies deeply: later edits to the source do not reach the target', () => {
    const copy = createDevelop();
    const out = syncTone(copy, createDevelop(), ['curve']);
    copy.curve.luma[0] = [0, 0.5];
    expect(out.curve.luma[0]).toEqual([0, 0]);
  });

  it('starts with the tone sections on and the per-photo ones off, with a warning for those', () => {
    expect(DEFAULT_SYNC_SECTIONS).toEqual(['basic', 'curve', 'color', 'detail', 'effects', 'look']);
    expect(SYNC_SECTIONS).toEqual([...DEFAULT_SYNC_SECTIONS, 'transform', 'masks']);
    expect(SYNC_WARNINGS.transform).toMatch(/crop is never synced/);
    expect(SYNC_WARNINGS.masks).toBeTruthy();
  });
});

describe('applySections', () => {
  const noisy = DevelopSchema.parse({ ...source, detail: { clarity: 30, denoise: { model: 'scunet' } } });
  const target = DevelopSchema.parse({ ...createDevelop(), detail: { texture: 5, denoise: { model: 'nafnet-w64' } } });

  it('keeps Detail and its AI denoise apart', () => {
    const detail = applySections(noisy, target, ['detail']);
    expect(detail.detail.clarity).toBe(30);
    expect(detail.detail.texture).toBe(0);
    expect(detail.detail.denoise?.model).toBe('nafnet-w64');
    const denoise = applySections(noisy, target, ['denoise']);
    expect(denoise.detail.texture).toBe(5);
    expect(denoise.detail.denoise?.model).toBe('scunet');
    expect(applySections(noisy, target, ['detail', 'denoise']).detail).toEqual(noisy.detail);
  });

  it('leaves the crop, Transform and masks to the caller', () => {
    expect(applySections(noisy, target, ['crop', 'transform', 'masks'])).toBe(target);
  });

  it('Sync’s Detail is both copy sections', () => {
    expect(copySectionsOf(['basic', 'detail', 'masks'])).toEqual(['basic', 'detail', 'denoise', 'masks']);
    expect(syncTone(noisy, target, ['detail']).detail).toEqual(noisy.detail);
  });
});
