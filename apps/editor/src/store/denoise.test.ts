import { createEmptyBook } from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevelopRenderMeta } from '../lib/tauri';
import { currentDeveloped, refreshDeveloped, useAssetsStore } from './assets';
import { undo, useBookStore } from './book';
import { useLibraryStore } from './library';
import { seedFiles } from './testing';
import { DENOISE_UI_INITIAL, useUiStore } from './ui';

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../lib/tauri', () => ({
  renderDevelopCached: mocks.render,
  fileUrl: (path: string) => `asset://localhost${path}`,
}));

const FOLDER = '/photos';
const book = () => useBookStore.getState();
const denoise = () => book().book?.assets.N?.develop?.detail.denoise ?? null;

beforeEach(() => {
  mocks.render.mockReset();
  const doc = createEmptyBook({ title: 'Trip', folders: { F: { path: FOLDER } } });
  doc.assets = { N: { path: 'n.jpg', folder: 'F', hash: 'hn', size: 7, mtime: 1 } };
  useBookStore.setState({ book: doc, folder: FOLDER });
  useBookStore.temporal.getState().clear();
  seedFiles({
    'n.jpg': { relPath: 'n.jpg', assetId: 'N', size: 7, mtime: 1, kind: 'jpeg', hash: 'hn', status: 'ready' },
  });
  useUiStore.setState({ denoise: DENOISE_UI_INITIAL });
});
afterEach(async () => {
  await useBookStore.getState().close();
  useAssetsStore.getState().reset();
  useLibraryStore.getState().reset();
});

describe('setDenoise', () => {
  it('turns denoise on with the defaults and merges later patches over it', () => {
    book().setDenoise('N', {});
    expect(denoise()).toEqual({ model: 'nafnet-w32', luminance: 50, chroma: 75, sharpen: 25, chromaMode: 'filter' });
    book().setDenoise('N', { chroma: 10 });
    book().setDenoise('N', { model: 'scunet' });
    expect(denoise()).toEqual({ model: 'scunet', luminance: 50, chroma: 10, sharpen: 25, chromaMode: 'filter' });
  });

  it('turns denoise off with null, which restores the untouched photo when nothing else is edited', () => {
    book().setDenoise('N', {});
    book().setDenoise('N', null);
    expect(denoise()).toBeNull();
    expect(book().book?.assets.N?.develop).toBeUndefined();
  });

  it('keeps the other develop edits when denoise goes off', () => {
    book().setAssetDevelop('N', { light: { exposure: 1 } });
    book().setDenoise('N', {});
    book().setDenoise('N', null);
    expect(book().book?.assets.N?.develop?.light.exposure).toBe(1);
    expect(denoise()).toBeNull();
  });

  it('is one undo step per call', () => {
    book().setDenoise('N', {});
    book().setDenoise('N', null);
    undo();
    expect(denoise()).not.toBeNull();
    undo();
    expect(book().book?.assets.N?.develop).toBeUndefined();
  });

  it('ignores an unknown asset', () => {
    book().setDenoise('nope', {});
    expect(book().book?.assets.nope).toBeUndefined();
  });
});

describe('refreshDeveloped', () => {
  const meta = (extra: Partial<DevelopRenderMeta> = {}): DevelopRenderMeta => ({
    developHash: 'dh',
    width: 1600,
    height: 1067,
    thumbPath: '/cache/hn/thumb.jpg',
    proxyPath: '/cache/hn/proxy.jpg',
    ...extra,
  });

  it('records denoiseStale on the render made while the intermediate is missing', async () => {
    book().setDenoise('N', {});
    mocks.render.mockResolvedValue(meta({ denoiseStale: true }));
    await useAssetsStore.getState().renderDeveloped('N');
    const file = useAssetsStore.getState().files['n.jpg'];
    expect(currentDeveloped(file, book().book?.assets.N?.develop, 'srgb')?.denoiseStale).toBe(true);
  });

  it('renders again with the same settings: renderDeveloped alone would find the recorded render current', async () => {
    book().setDenoise('N', {});
    mocks.render.mockResolvedValue(meta({ denoiseStale: true }));
    await useAssetsStore.getState().renderDeveloped('N');
    await useAssetsStore.getState().renderDeveloped('N');
    expect(mocks.render).toHaveBeenCalledTimes(1);

    mocks.render.mockResolvedValue(meta());
    await refreshDeveloped('N');
    expect(mocks.render).toHaveBeenCalledTimes(2);
    const file = useAssetsStore.getState().files['n.jpg'];
    expect(currentDeveloped(file, book().book?.assets.N?.develop, 'srgb')?.denoiseStale).toBeUndefined();
  });

  it('does nothing for an unedited photo', async () => {
    await refreshDeveloped('N');
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
