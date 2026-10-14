// @vitest-environment jsdom
import { DEVELOP_DEFAULTS } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn() }));

vi.mock('../../lib/tauri', () => ({ renderDevelopPreview: mocks.render }));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
const book = () => useBookStore.getState();
const develop = () => book().book?.assets.f1?.develop;
const slider = (name: string) => screen.getByRole('slider', { name });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

function files(): Record<string, AssetFile> {
  return Object.fromEntries(
    IDS.map((id) => [
      `fixture/${id}.jpg`,
      {
        relPath: `fixture/${id}.jpg`,
        assetId: id,
        size: 1,
        mtime: 1,
        kind: 'jpeg',
        hash: `hash-${id}`,
        status: 'ready',
        proxyUrl: `asset://proxy/${id}.jpg`,
        thumbUrl: `asset://thumb/${id}.jpg`,
      } satisfies AssetFile,
    ]),
  );
}

function openEffects() {
  // Plan 54: Advanced, so every group's controls show inline.
  act(() => useUiStore.setState({ developAdvanced: true }));
  act(() => useUiStore.getState().openDevelop(IDS, 0));
  render(<DevelopMode />);
  fireEvent.click(screen.getByRole('button', { name: /^Effects/ }));
}

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.commit.mockReset();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({
    develop: null,
    developBeforeAfter: false,
    filmstrip: DEFAULT_FILMSTRIP,
    developAdvanced: false,
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('EffectsSection', () => {
  it('is collapsed until opened, then shows the four groups with their ranges and defaults', () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    const header = screen.getByRole('button', { name: /^Effects/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('slider', { name: 'Grain amount' })).toBeNull();
    fireEvent.click(header);
    // Plan 54, Basic: the wheels (plan 55) and each amount; the rest behind one ▸ per group.
    expect(slider('Grain amount')).toBeTruthy();
    for (const w of ['Shadows', 'Midtones', 'Highlights']) {
      expect(screen.getByRole('application', { name: `${w} wheel` })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: `${w} hue` }) as HTMLInputElement).value).toBe('0');
      expect((screen.getByRole('textbox', { name: `${w} saturation` }) as HTMLInputElement).value).toBe('0');
    }
    expect(screen.queryByRole('application', { name: 'Global wheel' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Roughness' })).toBeNull();
    for (const name of [
      'Luminance, global wheel',
      'Blending, balance',
      'Midpoint, feather, roundness',
      'Threshold, radius',
      'Size, roughness',
    ]) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }
    // Advanced shows them inline (the switch in the panel header, per machine).
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(useUiStore.getState().developAdvanced).toBe(true);
    expect(screen.queryByRole('button', { name: 'Size, roughness' })).toBeNull();

    for (const group of ['Color grading', 'Vignette', 'Halation', 'Grain']) {
      expect(screen.getByRole('group', { name: group })).toBeTruthy();
    }
    const expected: Array<[string, string, string, string]> = [
      ['Shadows luminance', '-100', '100', '0'],
      ['Midtones luminance', '-100', '100', '0'],
      ['Highlights luminance', '-100', '100', '0'],
      ['Global luminance', '-100', '100', '0'],
      ['Blending', '0', '100', '50'],
      ['Balance', '-100', '100', '0'],
      ['Vignette amount', '-100', '100', '0'],
      ['Midpoint', '0', '100', '50'],
      ['Feather', '0', '100', '50'],
      ['Roundness', '-100', '100', '0'],
      ['Halation amount', '0', '100', '0'],
      ['Threshold', '0', '100', '75'],
      ['Radius', '0', '100', '30'],
      ['Grain amount', '0', '100', '0'],
      ['Size', '0', '100', '25'],
      ['Roughness', '0', '100', '50'],
    ];
    for (const [name, min, max, value] of expected) {
      const el = slider(name);
      expect([name, el.getAttribute('aria-valuemin')]).toEqual([name, min]);
      expect([name, el.getAttribute('aria-valuemax')]).toEqual([name, max]);
      expect([name, el.getAttribute('aria-valuenow')]).toEqual([name, value]);
    }
    expect(button('Reset Effects').disabled).toBe(true);
    expect(button('Reset Grain').disabled).toBe(true);
  });

  it('writes each group under develop.effects, as undo steps', () => {
    openEffects();
    fireEvent.keyDown(slider('Grain amount'), { key: 'PageUp' });
    const shadows = screen.getByRole('application', { name: 'Shadows wheel' });
    fireEvent.keyDown(shadows, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(shadows, { key: 'ArrowUp', shiftKey: true });
    fireEvent.keyDown(slider('Vignette amount'), { key: 'PageDown' });
    fireEvent.keyDown(slider('Halation amount'), { key: 'ArrowRight' });
    const effects = develop()?.effects;
    expect(effects?.grain).toEqual({ amount: 10, size: 25, roughness: 50 });
    expect(effects?.grading.shadows).toMatchObject({ hue: 10, saturation: 10 });
    expect(effects?.vignette.amount).toBe(-10);
    expect(effects?.halation).toEqual({ amount: 1, threshold: 75, radius: 30 });
    expect(button('Reset Effects').disabled).toBe(false);
  });

  it('resets one group at a time, and the whole section', () => {
    openEffects();
    act(() =>
      book().setAssetDevelop('f1', {
        effects: { grain: { amount: 30, size: 60 }, vignette: { amount: -40 } },
        light: { exposure: 1 },
      }),
    );
    expect(button('Reset Halation').disabled).toBe(true);
    fireEvent.click(button('Reset Grain'));
    expect(develop()?.effects.grain).toEqual(DEVELOP_DEFAULTS.effects.grain);
    expect(develop()?.effects.vignette.amount).toBe(-40);
    expect(button('Reset Grain').disabled).toBe(true);

    fireEvent.click(button('Reset Effects'));
    expect(develop()?.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(develop()?.light.exposure).toBe(1);
  });

  it('plan 55: the harmony lock aligns the wheels, a drag turns the tied ones, and the lock is never hashed', async () => {
    openEffects();
    act(() =>
      book().setAssetDevelop('f1', {
        effects: { grading: { shadows: { hue: 200, saturation: 60 }, highlights: { hue: 40, saturation: 20 } } },
      }),
    );
    const lock = screen.getByRole('combobox', { name: 'Harmony lock' }) as HTMLSelectElement;
    expect(lock.value).toBe('free');
    fireEvent.change(lock, { target: { value: 'complementary' } });
    let grading = develop()?.effects.grading;
    expect(grading?.harmony).toBe('complementary');
    // Aligned around the most saturated wheel (the shadows): highlights = shadows - 180.
    expect(grading?.highlights.hue).toBe(20);
    // Turning the highlights turns the shadows with them; the midtones stay free.
    fireEvent.keyDown(screen.getByRole('application', { name: 'Highlights wheel' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    grading = develop()?.effects.grading;
    expect([grading?.highlights.hue, grading?.shadows.hue, grading?.midtones.hue]).toEqual([30, 210, 0]);
    // The ring shows the tied angle as a spoke.
    const ring = screen.getByRole('application', { name: 'Shadows wheel' });
    expect(ring.querySelector('[data-spoke]')?.getAttribute('data-spoke')).toBe('30');
    // Free removes the field again.
    fireEvent.change(lock, { target: { value: 'free' } });
    expect('harmony' in (develop()?.effects.grading ?? {})).toBe(false);
  });

  it('plan 55: a preset chip writes the wheels, and the luminance and Global wheel are under their own ▸', () => {
    openEffects();
    fireEvent.click(button('Teal & orange'));
    const grading = develop()?.effects.grading;
    expect(grading?.shadows).toMatchObject({ hue: 190, saturation: 35 });
    expect(grading?.blending).toBe(60);
    expect(button('Teal & orange').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(slider('Midtones luminance'), { key: 'PageUp' });
    expect(develop()?.effects.grading.midtones.luminance).toBe(10);
    fireEvent.keyDown(screen.getByRole('application', { name: 'Global wheel' }), { key: 'ArrowUp' });
    expect(develop()?.effects.grading.global).toEqual({ hue: 0, saturation: 1, luminance: 0 });
  });
});
