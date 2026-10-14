// @vitest-environment jsdom
import type { WhiteBalance } from '@photobook/shared';
import { FIXTURE_FOLDER_ID, fixtureBook } from '@photobook/shared/fixtures';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import {
  KELVIN_MAX,
  KELVIN_MIN,
  kelvinToPosition,
  parseKelvin,
  positionToKelvin,
  WhiteBalanceControls,
} from './WhiteBalanceControls';

const ID = 'f1';

function file(raw: boolean): AssetFile {
  return {
    relPath: raw ? 'photo.CR2' : 'photo.jpg',
    assetId: ID,
    size: 1,
    mtime: 1,
    kind: raw ? 'raw' : 'jpeg',
    hash: 'h',
    status: 'ready',
    ...(raw ? { isRaw: true, asShot: [5450, 7] as [number, number] } : {}),
  };
}

function setup(raw: boolean) {
  const doc = structuredClone(fixtureBook);
  const f = file(raw);
  doc.assets[ID] = { ...(doc.assets[ID] ?? { path: f.relPath, folder: FIXTURE_FOLDER_ID }), path: f.relPath };
  useBookStore.setState({ book: doc, folder: '/photos' });
  useAssetsStore.setState({ files: { [f.relPath]: f } });
}

let last: WhiteBalance | null = null;

function Harness({ initial }: { initial: WhiteBalance }) {
  const [wb, setWb] = useState<WhiteBalance>(initial);
  return (
    <WhiteBalanceControls
      assetId={ID}
      whiteBalance={wb}
      onChange={(next) => {
        last = next;
        setWb(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole('radio', { name });
const slider = (name: string) => screen.getByRole('slider', { name });

beforeEach(() => {
  last = null;
});
afterEach(() => {
  cleanup();
  useAssetsStore.setState({ files: {} });
});

describe('Kelvin scale', () => {
  it('maps 2000..50000 K onto the track logarithmically and back', () => {
    expect(kelvinToPosition(KELVIN_MIN)).toBe(0);
    expect(kelvinToPosition(KELVIN_MAX)).toBeCloseTo(1000, 9);
    expect(kelvinToPosition(10000)).toBeCloseTo(500, 9);
    expect(positionToKelvin(kelvinToPosition(5450))).toBe(5450);
    expect(positionToKelvin(kelvinToPosition(23456))).toBe(23500);
    expect(positionToKelvin(-5)).toBe(KELVIN_MIN);
    expect(positionToKelvin(2000)).toBe(KELVIN_MAX);
    expect(parseKelvin('6500 K')).toBeCloseTo(kelvinToPosition(6500), 9);
    expect(parseKelvin('warm')).toBeUndefined();
    expect(parseKelvin('')).toBeUndefined();
  });
});

describe('WhiteBalanceControls', () => {
  it('RAW: As shot shows the as-shot Kelvin and tint; a slider switches to absolute from there', () => {
    setup(true);
    render(<Harness initial={{ mode: 'asShot' }} />);
    expect(radio('As shot').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: '5450 K' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+7' })).toBeTruthy();
    fireEvent.keyDown(slider('Tint'), { key: 'ArrowRight' });
    expect(last).toEqual({ mode: 'absolute', temperature: 5450, tint: 8 });
    expect(radio('Custom').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(slider('Temperature'), { key: 'ArrowRight', shiftKey: true });
    expect(last?.mode).toBe('absolute');
    const warmer = last?.mode === 'absolute' ? last.temperature : 0;
    expect(warmer).toBeGreaterThan(5450);
    expect(warmer).toBeLessThan(5700);
    // Type a Kelvin value into the readout.
    fireEvent.click(screen.getByRole('button', { name: `${warmer} K` }));
    const input = screen.getByRole('textbox', { name: 'Temperature value' }) as HTMLInputElement;
    expect(input.value).toBe(String(warmer));
    fireEvent.change(input, { target: { value: '3200' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(last).toEqual({ mode: 'absolute', temperature: 3200, tint: 8 });
    // As shot drops the values; Custom starts again from the as-shot ones.
    fireEvent.click(radio('As shot'));
    expect(last).toEqual({ mode: 'asShot' });
    fireEvent.click(radio('Custom'));
    expect(last).toEqual({ mode: 'absolute', temperature: 5450, tint: 7 });
    // No incremental mode for a RAW, and the tint goes to ±150.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(slider('Tint').getAttribute('aria-valuemax')).toBe('150');
  });

  it('RAW: shows an absolute setting as it is', () => {
    setup(true);
    render(<Harness initial={{ mode: 'absolute', temperature: 7500, tint: -20 }} />);
    expect(radio('Custom').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: '7500 K' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '-20' })).toBeTruthy();
  });

  it('rendered files keep the incremental Custom mode', () => {
    setup(false);
    render(<Harness initial={{ mode: 'asShot' }} />);
    fireEvent.keyDown(slider('Temperature'), { key: 'ArrowRight', shiftKey: true });
    expect(last).toEqual({ mode: 'incremental', temperature: 10, tint: 0 });
    expect(slider('Tint').getAttribute('aria-valuemax')).toBe('100');
    fireEvent.click(radio('As shot'));
    expect(last).toEqual({ mode: 'asShot' });
  });

  it('rendered files: an absolute setting shows the sliders disabled', () => {
    setup(false);
    render(<Harness initial={{ mode: 'absolute', temperature: 5000, tint: 0 }} />);
    expect(screen.getByText('This photo uses an absolute (RAW) white balance.')).toBeTruthy();
    expect((radio('Custom') as HTMLButtonElement).disabled).toBe(true);
  });
});
