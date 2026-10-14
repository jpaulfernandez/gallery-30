// @vitest-environment jsdom
import { DEVELOP_DEFAULTS } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_LOOKS } from '../../lib/develop/looks';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore, withoutHistory } from '../../store/book';
import { assetDevelop } from '../../store/library';
import { useLooksStore } from '../../store/looks';
import { useLutsStore } from '../../store/luts';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, PANES_KEY, useUiStore } from '../../store/ui';
import { clearDevelopClipboard } from './copyPaste';
import { describeDevelopChange, historyRows } from './developHistory';
import { resetPreviewWarnings } from './usePreview';

/** Plan 51: Develop's left pane (Looks, Presets, History, Versions), its Tab keys, and the keys with it hidden. */

const mocks = vi.hoisted(() => ({ render: vi.fn(), clip: '' as string }));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  listPresets: async () => [],
  savePreset: async () => {},
  deletePreset: async () => {},
  listLuts: async () => [],
  lutPresent: async () => true,
  filmSimulation: async () => null,
  renderLookThumbs: async () => [],
  onLookThumb: async () => () => {},
  fileUrl: (path: string) => `asset://${path}`,
}));
vi.mock('./commit', () => ({ commitDevelop: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async (text: string) => {
    mocks.clip = text;
  }),
  readText: vi.fn(async () => mocks.clip),
}));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2', 'f3'];
const SHOWN = { left: true, right: true, strip: true };
const book = () => useBookStore.getState();
const develop = (id = 'f1') => assetDevelop(book(), id);

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

function mount(index = 0) {
  act(() => useUiStore.getState().openDevelop(IDS, index));
  render(<DevelopMode />);
}

const leftPane = () => screen.queryByRole('complementary', { name: 'Looks and history' });
const rightPane = () => screen.queryByRole('complementary', { name: 'Adjustments' });

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.clip = '';
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
  localStorage.removeItem(PANES_KEY);
  useUiStore.setState({
    develop: null,
    filmstrip: DEFAULT_FILMSTRIP,
    selection: EMPTY_SELECTION,
    copySections: ['basic', 'curve', 'color', 'detail', 'denoise'],
    panes: { cull: { ...SHOWN }, develop: { ...SHOWN }, design: { ...SHOWN } },
  });
  clearDevelopClipboard();
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await book().close();
  useAssetsStore.setState({ files: {} });
  localStorage.removeItem(PANES_KEY);
});

describe('the left pane', () => {
  it('holds Looks, Presets and History; the adjustments are on the right without them', () => {
    mount();
    const left = leftPane();
    expect(left).toBeTruthy();
    if (!left) return;
    expect(within(left).getByRole('region', { name: 'Looks' })).toBeTruthy();
    expect(within(left).getByRole('region', { name: 'Presets' })).toBeTruthy();
    expect(within(left).getByRole('region', { name: 'History' })).toBeTruthy();
    const right = rightPane();
    expect(right && within(right).queryByRole('region', { name: 'Looks' })).toBeNull();
    expect(right && within(right).queryByRole('button', { name: /Presets/ })).toBeNull();
  });

  it('History lists this photo’s steps, newest first, and jumps back with undo', () => {
    mount();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.3 } }));
    act(() => book().setAssetDevelop('f1', { light: { contrast: -40 } }));
    const history = screen.getByRole('list', { name: 'History of this photo' });
    const rows = within(history).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['Contrast −40', 'Exposure +0.30']);
    expect(rows[0]?.getAttribute('aria-current')).toBe('step');
    fireEvent.click(within(history).getByRole('button', { name: 'History: Exposure +0.30' }));
    expect(develop()?.light.exposure).toBe(0.3);
    expect(develop()?.light.contrast).toBe(0);
  });

  it('a row behind another photo’s edit is listed only (undo is one stack)', () => {
    mount();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.3 } }));
    act(() => book().setAssetDevelop('f2', { light: { exposure: 1 } }));
    act(() => book().setAssetDevelop('f1', { light: { contrast: 10 } }));
    const history = screen.getByRole('list', { name: 'History of this photo' });
    const older = within(history).getByRole('button', { name: 'History: Exposure +0.30' });
    expect(older.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Older steps also changed other photos; use Undo.')).toBeTruthy();
    fireEvent.click(older);
    expect(develop('f2')?.light.exposure).toBe(1);
    expect(develop()?.light.contrast).toBe(10);
  });

  it('a step that wrote this photo and others (Sync…) blocks the jump past it', () => {
    mount();
    act(() => withoutHistory(() => book().setAssetDevelop('f2', { light: { contrast: 25 } })));
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.3 } }));
    act(() => {
      book().syncDevelop('f2', ['f1', 'f3'], ['basic']);
    });
    const history = screen.getByRole('list', { name: 'History of this photo' });
    const rows = within(history).getAllByRole('button');
    // The sync is this photo's newest step (shown); the exposure row behind it would undo f3's sync too.
    expect(rows[0]?.getAttribute('aria-current')).toBe('step');
    const older = within(history).getByRole('button', { name: 'History: Exposure +0.30' });
    expect(older.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(older);
    expect(develop('f3')?.light.contrast).toBe(25);
  });
});

describe('Tab and Shift+Tab', () => {
  it('Tab hides both panes, Shift+Tab the strip too; per machine', () => {
    mount();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(leftPane()).toBeNull();
    expect(rightPane()).toBeNull();
    expect(screen.getByRole('button', { name: /^Develop f2/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('button', { name: /^Develop f2/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem(PANES_KEY) ?? '{}').develop).toEqual({
      left: false,
      right: false,
      strip: false,
    });
    expect(useUiStore.getState().panes.cull).toEqual(SHOWN);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(leftPane()).toBeTruthy();
  });

  it('never from a text field or a focused control', () => {
    mount();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'Tab' });
    input.remove();
    const right = rightPane();
    const button = right ? within(right).getByRole('button', { name: 'More actions' }) : null;
    if (button) fireEvent.keyDown(button, { key: 'Tab' });
    expect(useUiStore.getState().panes.develop).toEqual(SHOWN);
  });
});

describe('with the left pane hidden', () => {
  it('[ ] still step the looks, Cmd+Shift+C / V still copy and paste', async () => {
    useUiStore.setState({
      panes: { ...useUiStore.getState().panes, develop: { left: false, right: true, strip: true } },
    });
    mount();
    expect(leftPane()).toBeNull();
    await waitFor(() => expect(useLooksStore.getState().loaded).toBe(true));
    fireEvent.keyDown(window, { key: ']', code: 'BracketRight' });
    expect(develop()?.look.applied?.presetId).toBe(BUILT_IN_LOOKS[0]?.id);
    fireEvent.keyDown(window, { key: '[', code: 'BracketLeft' });
    expect(develop()?.look.applied ?? null).toBeNull();

    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.8 } }));
    fireEvent.keyDown(window, { key: 'c', metaKey: true, shiftKey: true });
    act(() => useUiStore.getState().setDevelopIndex(1));
    fireEvent.keyDown(window, { key: 'v', metaKey: true, shiftKey: true });
    await waitFor(() => expect(develop('f2')?.light.exposure).toBe(0.8));
  });
});

describe('history labels', () => {
  const d = DEVELOP_DEFAULTS;
  const none = () => null;
  it('names one value, a look, a crop, a reset and several sections', () => {
    expect(describeDevelopChange(undefined, { ...d, light: { ...d.light, exposure: 0.3 } }, none)).toBe(
      'Exposure +0.30',
    );
    expect(
      describeDevelopChange(
        d,
        { ...d, color: { ...d.color, mix: { ...d.color.mix, red: { ...d.color.mix.red, hue: -12 } } } },
        none,
      ),
    ).toBe('Red hue −12');
    expect(
      describeDevelopChange(d, { ...d, look: { ...d.look, applied: { presetId: 'wren', amount: 100 } } }, (id) =>
        id === 'wren' ? 'Wren' : null,
      ),
    ).toBe('Look: Wren');
    expect(
      describeDevelopChange(
        d,
        { ...d, geometry: { ...d.geometry, crop: { rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, angle: 0, aspect: 'free' } } },
        none,
      ),
    ).toBe('Crop');
    expect(describeDevelopChange({ ...d, light: { ...d.light, exposure: 1 } }, d, none)).toBe('Reset all');
    expect(
      describeDevelopChange(
        d,
        { ...d, light: { ...d.light, exposure: 1 }, color: { ...d.color, saturation: 10 } },
        none,
      ),
    ).toBe('Light, Color');
  });

  it('keeps only the steps that changed the photo', () => {
    const view = { folder: null, developVersion: null };
    const states = [
      { book: null, libraries: {} },
      { book: null, libraries: {} },
    ];
    expect(historyRows(states, view, 'f1', () => null)).toEqual([]);
  });
});
