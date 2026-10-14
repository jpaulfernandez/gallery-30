// @vitest-environment jsdom
import { DEVELOP_DEFAULTS } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_LOOKS } from '../../lib/develop/looks';
import type { Preset } from '../../lib/develop/presets';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { assetDevelop } from '../../store/library';
import { useLooksStore } from '../../store/looks';
import { useLutsStore } from '../../store/luts';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { LookBadge } from '../filmstrip/LookBadge';
import { resetPreviewWarnings } from './usePreview';

/** Workflow plan 20: the Looks strip, Amount, ⋯ menu, `[` / `]`, Apply look… in the batch bar, the filmstrip badge. */

const LUT = 'c'.repeat(64);
const WARM: Preset = {
  id: '01J9ZK3Y8M0Q4R5T6V7W8X9YAB',
  name: 'Warm film',
  sections: ['color', 'effects', 'look'],
  settings: { color: { saturation: -40 }, effects: { grain: { amount: 60 } }, look: { lut: null } },
  builtIn: false,
  look: true,
};
const FILM: Preset = {
  id: '01J9ZK3Y8M0Q4R5T6V7W8X9YCD',
  name: 'Film LUT',
  sections: ['look'],
  settings: { look: { lut: { id: LUT, name: 'Film', strength: 100 } } },
  builtIn: false,
  look: true,
};
const PLAIN: Preset = {
  id: '01J9ZK3Y8M0Q4R5T6V7W8X9YEF',
  name: 'Plain preset',
  sections: ['light'],
  settings: { light: { exposure: 1 } },
  builtIn: false,
};

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  commit: vi.fn(),
  listPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  renderLookThumbs: vi.fn(),
  thumbHandler: null as null | ((e: { job: number; presetId: string; path?: string; cached: boolean }) => void),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  listPresets: mocks.listPresets,
  savePreset: mocks.savePreset,
  deletePreset: mocks.deletePreset,
  listLuts: async () => [],
  lutPresent: async () => true,
  filmSimulation: async () => null,
  renderLookThumbs: mocks.renderLookThumbs,
  onLookThumb: async (handler: (e: { job: number; presetId: string; path?: string; cached: boolean }) => void) => {
    mocks.thumbHandler = handler;
    return () => {};
  },
  fileUrl: (path: string) => `asset://${path}`,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2', 'f3'];
/** Plan 21's built-in looks, listed before the saved ones. */
const BUILT = BUILT_IN_LOOKS;
const book = () => useBookStore.getState();
const develop = (id = 'f1') => assetDevelop(book(), id);
const option = (name: string) => screen.getByRole('option', { name }) as HTMLButtonElement;
const strip = () => screen.getByRole('listbox', { name: 'Looks' });

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

async function mount(index = 0) {
  act(() => useUiStore.getState().openDevelop(IDS, index));
  render(<DevelopMode />);
  await waitFor(() => expect(within(strip()).getAllByRole('option')).toHaveLength(3 + BUILT.length));
}

beforeEach(() => {
  for (const m of [mocks.render, mocks.commit, mocks.listPresets, mocks.savePreset, mocks.deletePreset]) m.mockReset();
  mocks.renderLookThumbs.mockReset();
  mocks.thumbHandler = null;
  mocks.render.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.listPresets.mockResolvedValue([PLAIN, WARM, FILM]);
  mocks.savePreset.mockResolvedValue(undefined);
  mocks.renderLookThumbs.mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useLooksStore.setState({ saved: [], loaded: false, error: null });
  useLutsStore.setState({ luts: [], loaded: false, error: null, present: {}, epoch: 0 });
  useUiStore.setState({ develop: null, filmstrip: DEFAULT_FILMSTRIP, selection: EMPTY_SELECTION });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await book().close();
  useAssetsStore.setState({ files: {} });
});

describe('Looks strip', () => {
  it('sits at the top of the panel: None first, then the looks (plain presets left out)', async () => {
    await mount();
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections[0]).toBe('Looks');
    // Plan 21's built-in looks come before the saved ones.
    expect(
      within(strip())
        .getAllByRole('option')
        .map((o) => o.dataset.lookId),
    ).toEqual(['none', ...BUILT.map((l) => l.id), FILM.id, WARM.id]);
    expect(option('None').getAttribute('aria-selected')).toBe('true');
  });

  it('applies a look at full Amount; the Amount scales it from the defaults; one undo step each', async () => {
    await mount();
    fireEvent.click(option('Warm film'));
    expect(develop()?.color.saturation).toBe(-40);
    expect(develop()?.effects.grain.amount).toBe(60);
    expect(develop()?.look.applied).toEqual({ presetId: WARM.id, amount: 100 });
    expect(option('Warm film').getAttribute('aria-selected')).toBe('true');
    const amount = screen.getByRole('slider', { name: 'Amount' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    expect(develop()?.look.applied?.amount).toBe(50);
    expect(develop()?.color.saturation).toBe(-20);
    expect(develop()?.effects.grain.amount).toBe(30);
    // None takes the look off again.
    fireEvent.click(option('None'));
    expect(develop()?.effects ?? DEVELOP_DEFAULTS.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(develop()?.look.applied ?? null).toBeNull();
    act(() => undo());
    expect(develop()?.look.applied?.presetId).toBe(WARM.id);
  });

  it('a LUT look sets the LUT, and its Amount is the strength', async () => {
    await mount();
    fireEvent.click(option('Film LUT'));
    expect(develop()?.look.lut).toEqual({ id: LUT, name: 'Film', strength: 100 });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Amount' }), { key: 'PageDown' });
    expect(develop()?.look.lut?.strength).toBe(90);
    // Switching to a parametric look drops the LUT look's LUT.
    fireEvent.click(option('Warm film'));
    expect(develop()?.look.lut).toBeNull();
  });

  it('[ and ] step through None and the looks', async () => {
    await mount();
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight' });
    expect(develop()?.look.applied?.presetId).toBe((BUILT[0] ?? FILM).id);
    fireEvent.click(option('Film LUT'));
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight' });
    expect(develop()?.look.applied?.presetId).toBe(WARM.id);
    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft' });
    expect(develop()?.look.applied?.presetId).toBe(FILM.id);
    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft' });
    expect(develop()?.look.applied?.presetId ?? 'none').toBe((BUILT[BUILT.length - 1] ?? { id: 'none' }).id);
  });

  it('asks for the thumbnails over the look-free base and shows each as it arrives', async () => {
    await mount();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.5 } }));
    fireEvent.click(option('Warm film'));
    await waitFor(() => expect(mocks.renderLookThumbs).toHaveBeenCalled(), { timeout: 2000 });
    const [folder, relPath, hash, base, items, job] = mocks.renderLookThumbs.mock.lastCall ?? [];
    expect([folder, relPath, hash]).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1']);
    expect(base.light.exposure).toBe(0.5);
    expect(base.effects).toEqual(DEVELOP_DEFAULTS.effects);
    expect(base.color.saturation).toBe(0);
    expect(items.map((i: { presetId: string }) => i.presetId)).toEqual([
      'none',
      ...BUILT.map((l) => l.id),
      FILM.id,
      WARM.id,
    ]);
    expect(items[items.length - 1].settings.effects.grain.amount).toBe(60);
    await waitFor(() => expect(mocks.thumbHandler).not.toBeNull());
    act(() => mocks.thumbHandler?.({ job, presetId: WARM.id, path: '/cache/warm.jpg', cached: false }));
    act(() => mocks.thumbHandler?.({ job: job - 1, presetId: FILM.id, path: '/cache/old.jpg', cached: false }));
    expect(option('Warm film').querySelector('img')?.getAttribute('src')).toBe('asset:///cache/warm.jpg');
    expect(option('Film LUT').querySelector('img')).toBeNull();
  });

  it('Save current as look saves a look with effects and the LUT and records it on the photo', async () => {
    await mount();
    act(() => book().setAssetDevelop('f1', { effects: { vignette: { amount: -25 } }, color: { saturation: 10 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Looks menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save current as look…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as look' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Look name' }), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save look' }));
    await waitFor(() => expect(mocks.savePreset).toHaveBeenCalledTimes(1));
    const saved = mocks.savePreset.mock.calls[0]?.[0] as Preset;
    expect(saved).toMatchObject({ name: 'Mine', look: true, sections: ['color', 'effects', 'look'] });
    expect(saved.settings.effects?.vignette?.amount).toBe(-25);
    await waitFor(() => expect(develop()?.look.applied).toEqual({ presetId: saved.id, amount: 100 }));
    expect(option('Mine').getAttribute('aria-selected')).toBe('true');
  });

  it('locks the Amount when the applied look is not on this Mac', async () => {
    act(() =>
      book().setAssetDevelop('f1', {
        effects: { grain: { amount: 20 } },
        look: { applied: { presetId: '01J9ZK3Y8M0Q4R5T6V7W8X9YZZ', amount: 40 } },
      }),
    );
    await mount();
    expect((screen.getByRole('slider', { name: 'Amount' }) as HTMLElement).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/not on this Mac/)).toBeTruthy();
  });
});

describe('Apply look… in the batch bar', () => {
  it('applies the look at the chosen Amount to the selection, one undo step', async () => {
    act(() => useUiStore.getState().setSelection(['f2', 'f3']));
    await mount();
    act(() => book().setAssetDevelop('f2', { light: { exposure: 1 } }));
    const before = useBookStore.temporal.getState().pastStates.length;
    fireEvent.click(screen.getByRole('button', { name: 'Apply look…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply look' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Look' }), { target: { value: WARM.id } });
    const amount = within(dialog).getByRole('slider', { name: 'Amount' });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(amount, { key: 'PageDown' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2 photos' }));
    for (const id of ['f2', 'f3']) {
      expect(develop(id)?.look.applied).toEqual({ presetId: WARM.id, amount: 50 });
      expect(develop(id)?.effects.grain.amount).toBe(30);
    }
    expect(develop('f2')?.light.exposure).toBe(1);
    expect(develop('f1')?.look.applied ?? null).toBeNull();
    expect(useBookStore.temporal.getState().pastStates.length).toBe(before + 1);
    act(() => undo());
    expect(develop('f3')?.look.applied ?? null).toBeNull();
    expect(develop('f2')?.look.applied ?? null).toBeNull();
    expect(develop('f2')?.light.exposure).toBe(1);
  });
});

// Plan 21 review: built-in looks start at their own Amount in the batch dialog and on the Amount slider's reset.
describe('Built-in looks: starting Amount', () => {
  const builtIn = (bird: string) => {
    const look = BUILT.find((l) => l.id === `builtin:${bird}`);
    if (!look) throw new Error(bird);
    return look;
  };
  const amountOf = (slider: HTMLElement) => Number(slider.getAttribute('aria-valuenow'));

  it('the batch dialog follows the chosen look until the slider is moved', async () => {
    act(() => useUiStore.getState().setSelection(['f2', 'f3']));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Apply look…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply look' });
    const select = within(dialog).getByRole('combobox', { name: 'Look' });
    const slider = () => within(dialog).getByRole('slider', { name: 'Amount' });
    fireEvent.change(select, { target: { value: builtIn('kingfisher').id } });
    expect(amountOf(slider())).toBe(75);
    fireEvent.change(select, { target: { value: builtIn('rook').id } });
    expect(amountOf(slider())).toBe(100);
    fireEvent.change(select, { target: { value: WARM.id } });
    expect(amountOf(slider())).toBe(100);
    fireEvent.change(select, { target: { value: builtIn('kingfisher').id } });
    fireEvent.keyDown(slider(), { key: 'PageDown' });
    expect(amountOf(slider())).toBe(65);
    // Moved by hand: switching looks keeps the user's Amount.
    fireEvent.change(select, { target: { value: builtIn('heron').id } });
    expect(amountOf(slider())).toBe(65);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 2 photos' }));
    expect(develop('f2')?.look.applied).toEqual({ presetId: builtIn('heron').id, amount: 65 });
  });

  it('a strip click applies the starting Amount, and a double-click on Amount returns to it', async () => {
    await mount();
    fireEvent.click(option(builtIn('kingfisher').name));
    expect(develop()?.look.applied).toEqual({ presetId: builtIn('kingfisher').id, amount: 75 });
    const amount = screen.getByRole('slider', { name: 'Amount' });
    fireEvent.keyDown(amount, { key: 'PageDown' });
    expect(develop()?.look.applied?.amount).toBe(65);
    fireEvent.doubleClick(amount);
    expect(develop()?.look.applied?.amount).toBe(75);
  });
});

describe('LookBadge', () => {
  it('names the applied look, else the LUT, else nothing', () => {
    useLooksStore.setState({ saved: [WARM], loaded: true });
    const { rerender } = render(<LookBadge look={{ lut: null, applied: { presetId: WARM.id, amount: 70 } }} />);
    expect(screen.getByTestId('look-badge').textContent).toBe('Warm film');
    rerender(<LookBadge look={{ lut: { id: LUT, name: 'Film', strength: 50 }, applied: null }} />);
    expect(screen.getByTestId('look-badge').textContent).toBe('Film');
    rerender(<LookBadge look={DEVELOP_DEFAULTS.look} />);
    expect(screen.queryByTestId('look-badge')).toBeNull();
  });
});

describe('Looks after the plan 20 review', () => {
  it('B: choosing a LUT, moving its strength or taking the suggestion by hand clears look.applied', async () => {
    mocks.listPresets.mockResolvedValue([FILM]);
    useLutsStore.setState({ luts: [{ id: LUT, name: 'Film', size: 17 }], loaded: true, present: { [LUT]: true } });
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    await waitFor(() => expect(within(strip()).getAllByRole('option')).toHaveLength(2 + BUILT.length));
    fireEvent.click(option('Film LUT'));
    expect(develop()?.look.applied?.presetId).toBe(FILM.id);
    fireEvent.click(screen.getByRole('button', { name: /^LUT/ }));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Strength' }), { key: 'PageDown' });
    expect(develop()?.look.lut?.strength).toBe(90);
    expect(develop()?.look.applied ?? null).toBeNull();
    fireEvent.click(option('Film LUT'));
    expect(develop()?.look.applied?.presetId).toBe(FILM.id);
    fireEvent.change(screen.getByRole('combobox', { name: 'LUT' }), { target: { value: '' } });
    expect(develop()?.look.lut ?? null).toBeNull();
    expect(develop()?.look.applied ?? null).toBeNull();
  });

  it('A: an edit after the look locks the Amount (“changed since”); choosing the look again starts over', async () => {
    await mount();
    fireEvent.click(option('Warm film'));
    act(() => book().setAssetDevelop('f1', { effects: { grain: { amount: 5 } } }));
    const amount = screen.getByRole('slider', { name: 'Amount' });
    expect(amount.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Changed since the look was applied/)).toBeTruthy();
    fireEvent.keyDown(amount, { key: 'PageDown' });
    expect(develop()?.effects.grain.amount).toBe(5);
    fireEvent.click(option('Warm film'));
    expect(develop()?.effects.grain.amount).toBe(60);
    expect(screen.getByRole('slider', { name: 'Amount' }).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('None and Reset clear hand-set effects when no look is applied', async () => {
    await mount();
    act(() => book().setAssetDevelop('f1', { effects: { grain: { amount: 25 } } }));
    expect(option('None').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(option('None'));
    expect(develop()?.effects ?? DEVELOP_DEFAULTS.effects).toEqual(DEVELOP_DEFAULTS.effects);
    act(() => book().setAssetDevelop('f1', { effects: { grain: { amount: 25 } } }));
    const reset = screen.getByRole('button', { name: 'Reset Looks' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(develop()?.effects ?? DEVELOP_DEFAULTS.effects).toEqual(DEVELOP_DEFAULTS.effects);
  });

  it('Left / Right move the choice within the strip, which is one tab stop', async () => {
    await mount();
    const tabbable = within(strip())
      .getAllByRole('option')
      .filter((o) => o.tabIndex === 0);
    expect(tabbable.map((o) => o.dataset.lookId)).toEqual(['none']);
    option('None').focus();
    fireEvent.keyDown(option('None'), { key: 'ArrowRight' });
    expect(develop()?.look.applied?.presetId).toBe((BUILT[0] ?? FILM).id);
    expect(useUiStore.getState().develop?.index).toBe(0);
    fireEvent.click(option('Film LUT'));
    option('Film LUT').focus();
    fireEvent.keyDown(option('Film LUT'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(option('Warm film'));
    expect(develop()?.look.applied?.presetId).toBe(WARM.id);
    fireEvent.keyDown(option('Warm film'), { key: 'ArrowLeft' });
    expect(develop()?.look.applied?.presetId).toBe(FILM.id);
    expect(option('Film LUT').tabIndex).toBe(0);
    expect(option('None').tabIndex).toBe(-1);
  });

  it('[ is left to a focused text field and to the brush', async () => {
    await mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: ']', code: 'BracketRight' });
    expect(develop()?.look.applied ?? null).toBeNull();
    input.remove();
    const size = useUiStore.getState().maskBrush.size;
    act(() =>
      useUiStore.setState({
        developMasks: true,
        developMaskTool: { maskId: 'm1', componentId: undefined, tool: 'brush' },
      }),
    );
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight' });
    expect(develop()?.look.applied ?? null).toBeNull();
    expect(useUiStore.getState().maskBrush.size).toBeGreaterThan(size);
    act(() => useUiStore.setState({ developMasks: false, developMaskTool: null }));
  });

  it('marks a look whose LUT is not on this Mac', async () => {
    useLutsStore.setState({ luts: [], loaded: true, present: { [LUT]: false } });
    await mount();
    expect(option('Film LUT').dataset.lutMissing).toBe('true');
    expect(option('Warm film').dataset.lutMissing).toBeUndefined();
  });

  it('Import LUT… reuses only a look that is just that LUT', async () => {
    const mixed: Preset = {
      ...WARM,
      id: '01J9ZK3Y8M0Q4R5T6V7W8X9YKM',
      name: 'Mixed',
      settings: { ...WARM.settings, look: FILM.settings.look },
    };
    mocks.listPresets.mockResolvedValue([mixed]);
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.open).mockResolvedValueOnce('/luts/film.cube');
    const importFile = vi.fn(async () => ({ id: LUT, name: 'Film', size: 17 }));
    useLutsStore.setState({ importFile });
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(<DevelopMode />);
    await waitFor(() => expect(within(strip()).getAllByRole('option')).toHaveLength(2 + BUILT.length));
    fireEvent.click(screen.getByRole('button', { name: 'Looks menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import LUT…' }));
    await waitFor(() => expect(mocks.savePreset).toHaveBeenCalledTimes(1));
    expect(mocks.savePreset.mock.calls[0]?.[0]).toMatchObject({ sections: ['look'], look: true, name: 'Film' });
  });
});
