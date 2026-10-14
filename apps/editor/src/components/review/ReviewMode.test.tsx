// @vitest-environment jsdom
import { DevelopSchema, emptyLibrary } from '@photobook/shared';
import { FIXTURE_FOLDER_ID, fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, developInputOf, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { ReviewMode } from './ReviewMode';

const develop = DevelopSchema.parse({ version: 1, light: { exposure: 1 } });
const stale = DevelopSchema.parse({ version: 1, light: { exposure: 2 } });

function file(id: string, extra: Partial<AssetFile> = {}): AssetFile {
  return {
    relPath: `fixture/${id}.jpg`,
    assetId: id,
    size: 1,
    mtime: 1,
    kind: 'jpeg',
    status: 'ready',
    thumbUrl: `asset://c/${id}/thumb.jpg`,
    proxyUrl: `asset://c/${id}/proxy.jpg`,
    ...extra,
  };
}

const developed = (settings: typeof develop, dh: string) => {
  const input = developInputOf(settings);
  return {
    [input]: {
      developHash: dh,
      input,
      thumbUrl: `asset://c/e/thumb-${dh}.jpg`,
      proxyUrl: `asset://c/e/proxy-${dh}.jpg`,
      width: 1600,
      height: 1067,
    },
  };
};

beforeEach(() => {
  const book = structuredClone(fixtureBook);
  book.assets = {
    edited: { path: 'fixture/edited.jpg', folder: FIXTURE_FOLDER_ID, hash: 'h1', size: 1, develop },
    stale: { path: 'fixture/stale.jpg', folder: FIXTURE_FOLDER_ID, hash: 'h2', size: 1, develop },
    plain: { path: 'fixture/plain.jpg', folder: FIXTURE_FOLDER_ID, hash: 'h3', size: 1 },
  };
  useBookStore.setState({ book, folder: '/photos' });
  useAssetsStore.setState({
    files: {
      'fixture/edited.jpg': file('edited', { developed: developed(develop, 'e1') }),
      // Rendered for other settings than the asset has now: shows the original until the new render lands.
      'fixture/stale.jpg': file('stale', { developed: developed(stale, 's1') }),
      'fixture/plain.jpg': file('plain'),
    },
  });
  useUiStore.setState({ review: null, filmstrip: DEFAULT_FILMSTRIP });
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ review: null });
});

const open = (ids: string[], index = 0) => {
  render(<ReviewMode />);
  act(() => useUiStore.getState().openReview(ids, index));
};
const stripSrcs = () =>
  screen.getAllByRole('button', { name: /^Show / }).map((b) => b.querySelector('img')?.getAttribute('src'));

describe('ReviewMode', () => {
  it('shows the developed proxy and strip thumbnails of an edited photo, the originals otherwise', () => {
    open(['edited', 'stale', 'plain']);
    const main = document.querySelector('[role="dialog"] img[alt="edited.jpg"]');
    expect(main?.getAttribute('src')).toBe('asset://c/e/proxy-e1.jpg');
    expect(stripSrcs()).toEqual(['asset://c/e/thumb-e1.jpg', 'asset://c/stale/thumb.jpg', 'asset://c/plain/thumb.jpg']);
  });

  it('falls back to the original when the render is for older settings, or the photo is unedited', () => {
    open(['edited', 'stale', 'plain'], 1);
    expect(document.querySelector('[role="dialog"] img[alt="stale.jpg"]')?.getAttribute('src')).toBe(
      'asset://c/stale/proxy.jpg',
    );
    act(() => useUiStore.getState().setReviewIndex(2));
    expect(document.querySelector('[role="dialog"] img[alt="plain.jpg"]')?.getAttribute('src')).toBe(
      'asset://c/plain/proxy.jpg',
    );
  });

  it('follows the edit when a new render lands', () => {
    open(['stale']);
    act(() =>
      useAssetsStore.setState((s) => {
        const f = s.files['fixture/stale.jpg'];
        return f ? { files: { ...s.files, [f.relPath]: { ...f, developed: developed(develop, 's2') } } } : {};
      }),
    );
    expect(document.querySelector('[role="dialog"] img[alt="stale.jpg"]')?.getAttribute('src')).toBe(
      'asset://c/e/proxy-s2.jpg',
    );
  });
});

describe('ReviewMode in the Cull stage (library keys, no project)', () => {
  const F = 'F1';
  const a = photoKey({ folder: F, path: 'a.jpg' });
  const b = photoKey({ folder: F, path: 'b.jpg' });
  beforeEach(() => {
    useBookStore.setState({ book: null, folder: null, libraries: { '/trip': emptyLibrary() } });
    const photo = (relPath: string, hash: string) => ({
      relPath,
      size: 1,
      mtime: 1,
      kind: 'jpeg' as const,
      hash,
      width: 1200,
      height: 800,
      status: 'ready' as const,
      thumbUrl: `asset://c/${hash}/thumb.jpg`,
      proxyUrl: `asset://c/${hash}/proxy.jpg`,
    });
    useLibraryStore.setState({
      folders: {
        [F]: {
          id: F,
          path: '/trip',
          photos: { 'a.jpg': photo('a.jpg', 'ha'), 'b.jpg': photo('b.jpg', 'hb') },
          progress: { hashed: 2, prepared: 2, total: 2 },
          busy: false,
          error: null,
          scanned: true,
        },
      },
    });
  });
  afterEach(() => {
    useLibraryStore.getState().reset();
    useBookStore.setState({ libraries: {} });
  });

  it('rates and flags into the folder library, and D asks for the Develop stage', () => {
    const onDevelop = vi.fn();
    render(<ReviewMode inline onDevelop={onDevelop} />);
    act(() => useUiStore.getState().openReview([a, b], 0));
    const region = screen.getByRole('region', { name: 'One: a.jpg' });
    expect(region.querySelector('img[alt="a.jpg"]')?.getAttribute('src')).toBe('asset://c/ha/proxy.jpg');
    expect(screen.queryByRole('button', { name: /Done/ })).toBeNull();
    fireEvent.keyDown(window, { key: '4', code: 'Digit4' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(useBookStore.getState().libraries['/trip']?.photos.ha).toMatchObject({ rating: 4, flag: 'pick' });
    expect(screen.getByRole('button', { name: '4 stars' }).getAttribute('aria-pressed')).toBe('true');
    // Escape does not close the stage's review; D hands the photo to the Develop stage.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().review).not.toBeNull();
    fireEvent.keyDown(window, { key: 'd' });
    expect(onDevelop).toHaveBeenCalledWith(a);
    expect(useUiStore.getState().develop).toBeNull();
  });
});
