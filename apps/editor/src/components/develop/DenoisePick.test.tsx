// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, DENOISE_UI_INITIAL, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  status: vi.fn(),
  crop: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  developSharpenMask: vi.fn(),
  denoiseStatus: mocks.status,
  previewDenoiseCrop: mocks.crop,
}));
vi.mock('./commit', () => ({ commitDevelop: vi.fn() }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2'];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const center = () => useUiStore.getState().denoise.center;

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

function pictureBox() {
  const image = screen.getByTestId('develop-image');
  image.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 400, height: 200, right: 410, bottom: 220 }) as DOMRect;
  return image;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.status.mockReset();
  mocks.status.mockResolvedValue({
    key: 'k',
    ready: false,
    bytes: 0,
    model: {
      name: 'm',
      title: 'NAFNet (w32)',
      version: '1',
      bytes: 117_115_760,
      licence: 'MIT',
      licenceUrl: '',
      status: { state: 'installed' },
    },
  });
  mocks.crop.mockReset();
  mocks.crop.mockImplementation(async () => jpeg());
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
    denoise: DENOISE_UI_INITIAL,
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

function openDenoise() {
  act(() => useBookStore.getState().setDenoise('f1', {}));
  act(() => useUiStore.getState().openDevelop(IDS, 0));
  render(<DevelopMode />);
  fireEvent.click(screen.getByRole('button', { name: /^Sharpen & denoise/ }));
}

describe('picking the loupe point on the picture (plan 28)', () => {
  it('ignores clicks on the picture while the loupe is closed', () => {
    openDenoise();
    fireEvent.click(pictureBox(), { clientX: 110, clientY: 70 });
    expect(center()).toEqual([0.5, 0.5]);
    expect(screen.queryByTestId('denoise-loupe')).toBeNull();
  });

  it('moves the loupe to the click (fractions of the picture) while it is open', async () => {
    openDenoise();
    fireEvent.click(screen.getByRole('button', { name: 'Preview at 100 %' }));
    expect(screen.getByTestId('denoise-loupe')).toBeTruthy();
    fireEvent.click(pictureBox(), { clientX: 110, clientY: 70 });
    expect(center()).toEqual([0.25, 0.25]);
    await waitFor(() => expect(mocks.crop.mock.calls.some((c) => c[4][0] === 0.25)).toBe(true), { timeout: 2000 });
  });

  it('puts the point back in the middle when stepping to another photo, and closes the loupe with the view', () => {
    openDenoise();
    fireEvent.click(screen.getByRole('button', { name: 'Preview at 100 %' }));
    fireEvent.click(pictureBox(), { clientX: 110, clientY: 70 });
    act(() => useUiStore.getState().setDevelopIndex(1));
    expect(center()).toEqual([0.5, 0.5]);
    act(() => useUiStore.getState().closeDevelop());
    expect(useUiStore.getState().denoise.previewOpen).toBe(false);
  });

  it('Escape closes the loupe first and leaves Develop open', () => {
    openDenoise();
    fireEvent.click(screen.getByRole('button', { name: 'Preview at 100 %' }));
    expect(screen.getByTestId('denoise-loupe')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().denoise.previewOpen).toBe(false);
    expect(screen.queryByTestId('denoise-loupe')).toBeNull();
    expect(useUiStore.getState().develop).not.toBeNull();
  });
});
