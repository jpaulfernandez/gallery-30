// @vitest-environment jsdom

import { createDevelop, type LibraryPhoto } from '@photobook/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inCollection, needsDenoise, noiseSignature } from '../../store/collections';
import { DEFAULT_DENOISE_PREFS, useDenoisePrefs } from '../../store/denoisePrefs';
import type { LibraryFolder, PhotoFile } from '../../store/library';
import { DenoiseBadge, showsDenoiseBadge } from './DenoiseBadge';

const defaults = { iso: 3200, amount: 40 };
/** σ (linear, at mid-grey) of `pct` % of mid-grey. */
const sigma = (pct: number) => 0.18 * (pct / 100);

beforeEach(() => useDenoisePrefs.setState({ ...DEFAULT_DENOISE_PREFS, timing: {} }));
afterEach(cleanup);

describe('the needs-denoise badge (plan 27)', () => {
  it('shows for ISO 6400 and not for ISO 200', () => {
    expect(showsDenoiseBadge({ iso: 6400 }, false, defaults)).toBe(true);
    expect(showsDenoiseBadge({ iso: 200 }, false, defaults)).toBe(false);
    expect(showsDenoiseBadge({}, false, defaults)).toBe(false);
  });

  it('prefers the measured σ to the ISO', () => {
    // A clean ISO 6400 photo (0.5 % of mid-grey) does not need it; a noisy ISO 200 one (4 %) does.
    expect(showsDenoiseBadge({ iso: 6400, noise: sigma(0.5) }, false, defaults)).toBe(false);
    expect(showsDenoiseBadge({ iso: 200, noise: sigma(4) }, false, defaults)).toBe(true);
  });

  it('is hidden once denoise is on for the photo', () => {
    expect(showsDenoiseBadge({ iso: 6400 }, true, defaults)).toBe(false);
  });

  it('follows the thresholds from Settings → Models', () => {
    expect(showsDenoiseBadge({ iso: 1600 }, false, defaults)).toBe(false);
    expect(showsDenoiseBadge({ iso: 1600 }, false, { iso: 1600, amount: 40 })).toBe(true);
    useDenoisePrefs.getState().set({ iso: 12800 });
    expect(needsDenoise({ iso: 6400 })).toBe(false);
    expect(needsDenoise({ iso: 12800 })).toBe(true);
  });

  it('renders on a thumbnail and re-renders when the threshold moves', () => {
    render(
      <div className="relative">
        <DenoiseBadge photo={{ iso: 6400 }} denoiseOn={false} />
      </div>,
    );
    expect(screen.getByRole('img', { name: 'Needs denoise' }).getAttribute('title')).toBe('Needs denoise (ISO 6400)');
    act(() => useDenoisePrefs.getState().set({ iso: 12800 }));
    expect(screen.queryByRole('img', { name: 'Needs denoise' })).toBeNull();
  });

  it('the Needs denoise collection drops a photo once its denoise is on, as the badge does', () => {
    const photo = { relPath: 'a.jpg', size: 1, mtime: 1, kind: 'jpeg', iso: 6400, status: 'ready' } as PhotoFile;
    const on = createDevelop();
    on.detail.denoise = { model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' };
    expect(inCollection('needs-denoise', photo, undefined)).toBe(true);
    expect(inCollection('needs-denoise', photo, { develop: on } as LibraryPhoto)).toBe(false);
  });

  it('the noise signature changes when a photo crosses the threshold, not on every new σ', () => {
    const folder = (noise?: number): LibraryFolder =>
      ({
        id: 'f',
        path: '/f',
        photos: { 'a.jpg': { relPath: 'a.jpg', size: 1, mtime: 1, kind: 'jpeg', iso: 200, status: 'ready', noise } },
      }) as unknown as LibraryFolder;
    const clean = noiseSignature([folder(sigma(0.5))], defaults);
    expect(noiseSignature([folder(undefined)], defaults)).toBe(clean);
    expect(noiseSignature([folder(sigma(0.6))], defaults)).toBe(clean);
    expect(noiseSignature([folder(sigma(4))], defaults)).not.toBe(clean);
    expect(noiseSignature([folder(undefined)], { iso: 100, amount: 40 })).not.toBe(clean);
  });
});
