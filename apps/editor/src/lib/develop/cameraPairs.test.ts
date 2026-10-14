import { describe, expect, it } from 'vitest';
import type { LutInfo } from '../tauri';
import {
  defaultFitName,
  fittedPresetName,
  pairCameraFiles,
  pairOf,
  pairProblem,
  suggestedFittedLut,
} from './cameraPairs';

describe('pairCameraFiles', () => {
  it('pairs a RAW with the JPEG of the same base name in the same directory', () => {
    const pairs = pairCameraFiles([
      'DSCF0002.JPG',
      'DSCF0001.RAF',
      'DSCF0001.JPG',
      'DSCF0002.raf',
      'DSCF0003.RAF',
      'DSCF0004.JPG',
      'day2/DSCF0001.RAF',
      'day2/dscf0001.jpeg',
      'other/DSCF0002.JPG',
      'IMG_1.png',
    ]);
    expect(pairs).toEqual([
      { raw: 'DSCF0001.RAF', jpeg: 'DSCF0001.JPG' },
      { raw: 'DSCF0002.raf', jpeg: 'DSCF0002.JPG' },
      { raw: 'day2/DSCF0001.RAF', jpeg: 'day2/dscf0001.jpeg' },
    ]);
    expect(pairOf(pairs, 'DSCF0002.JPG')).toEqual({ raw: 'DSCF0002.raf', jpeg: 'DSCF0002.JPG' });
    expect(pairOf(pairs, 'DSCF0003.RAF')).toBeUndefined();
  });

  it('takes the first JPEG when two share a name', () => {
    expect(pairCameraFiles(['A.NEF', 'A.jpeg', 'A.jpg'])).toEqual([{ raw: 'A.NEF', jpeg: 'A.jpeg' }]);
    expect(pairCameraFiles([])).toEqual([]);
  });
});

describe('suggestedFittedLut', () => {
  const lut = (id: string, name: string, simulation?: string, meanDeltaE = 1, camera?: string): LutInfo => ({
    id,
    name,
    size: 33,
    ...(simulation ? { fitted: { simulation, pairs: 3, meanDeltaE, ...(camera ? { camera } : {}) } } : {}),
  });

  it('suggests the most accurate fitted LUT with the photo’s simulation', () => {
    const luts = [
      lut('a', 'Imported'),
      lut('b', 'CC old', 'Classic Chrome', 1.8),
      lut('c', 'CC', 'Classic Chrome', 1.1),
    ];
    expect(suggestedFittedLut(luts, { simulation: 'Classic Chrome' })?.id).toBe('c');
    expect(suggestedFittedLut(luts, { simulation: 'classic chrome' })?.id).toBe('c');
    expect(suggestedFittedLut(luts, { simulation: 'Velvia' })).toBeUndefined();
    expect(suggestedFittedLut(luts, null)).toBeUndefined();
  });

  it('matches the camera when both are known', () => {
    const luts = [
      lut('t5', 'CC X-T5', 'Classic Chrome', 1.4, 'Fujifilm X-T5'),
      lut('x100', 'CC X100V', 'Classic Chrome', 1.0, 'Fujifilm X100V'),
    ];
    expect(suggestedFittedLut(luts, { simulation: 'Classic Chrome', camera: 'Fujifilm X-T5' })?.id).toBe('t5');
    expect(suggestedFittedLut(luts, { simulation: 'Classic Chrome', camera: 'Fujifilm X-H2' })).toBeUndefined();
    expect(suggestedFittedLut(luts, { simulation: 'Classic Chrome' })?.id).toBe('x100');
  });

  it('flags a JPEG without the RAW’s film tag as an export', () => {
    expect(pairProblem({ simulation: 'Velvia' }, null)).toMatch(/export/);
    expect(pairProblem({ simulation: 'Velvia' }, { simulation: 'Velvia' })).toBeUndefined();
    expect(pairProblem(null, null)).toBeUndefined();
  });

  it('names a fit after the shared simulation', () => {
    expect(defaultFitName(['Velvia', 'Classic Chrome', 'Classic Chrome', null])).toBe('Classic Chrome');
    expect(defaultFitName([null, undefined])).toBe('Camera look');
    expect(fittedPresetName('Classic Chrome')).toBe('Classic Chrome (fitted)');
  });
});
