import { createDevelop, emptyLibrary, type Library } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRESET_BW } from '../lib/develop/presets';
import { undo, useBookStore } from './book';
import {
  assetDevelop,
  assetVersionNames,
  editedVersion,
  type LibraryFolder,
  libraryEntryOf,
  mergeLibrariesForHistory,
  nextVersionName,
  photoKey,
  useLibraryStore,
} from './library';

const F = 'folder-1';
const PATH = '/photos';
const HASH = 'a'.repeat(64);
const key = photoKey({ folder: F, path: 'a.jpg' });
const book = () => useBookStore.getState();

function seedFolder(hash: string | null = HASH) {
  const folder: LibraryFolder = {
    id: F,
    path: PATH,
    progress: { hashed: 0, prepared: 0, total: 0 },
    busy: false,
    error: null,
    scanned: true,
    photos: {
      'a.jpg': { relPath: 'a.jpg', size: 1, mtime: 1, kind: 'jpeg', status: 'ready', hash: hash ?? undefined },
    },
  } as LibraryFolder;
  useLibraryStore.setState({ folders: { [F]: folder } });
}

beforeEach(() => {
  seedFolder();
  useBookStore.setState({ book: null, folder: null, libraries: { [PATH]: emptyLibrary() }, developVersion: null });
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  await book().close();
  useLibraryStore.getState().reset();
});

describe('versions of a library photo (no project)', () => {
  it('Develop edits the version it shows; the master stays; the choice is per photo', () => {
    book().setAssetDevelop(key, { light: { exposure: 1 } });
    const v2 = book().createVersion(key);
    expect(v2).toBeTruthy();
    const id = v2 ?? '';
    expect(libraryEntryOf(book(), key)?.versions[id]).toMatchObject({ name: 'v2' });
    // A library key shows the master until Develop picks the version.
    expect(editedVersion(book(), key)).toBeUndefined();
    book().showVersion(key, id);
    expect(editedVersion(book(), key)).toBe(id);
    book().setAssetDevelop(key, { light: { exposure: 2 } });
    expect(libraryEntryOf(book(), key)?.develop?.light.exposure).toBe(1);
    expect(libraryEntryOf(book(), key)?.versions[id]?.develop.light.exposure).toBe(2);
    // Reset puts the version at the defaults (a version always has settings) and is one step.
    expect(book().resetDevelopMany([key])).toBe(1);
    expect(libraryEntryOf(book(), key)?.versions[id]?.develop).toEqual(createDevelop());
    expect(book().resetDevelopMany([key])).toBe(0);
    undo();
    expect(assetDevelop(book(), key)?.light.exposure).toBe(2);
    // Back to the master: its own settings, the version untouched.
    book().showVersion(key, null);
    expect(book().developVersion).toBeNull();
    expect(assetDevelop(book(), key)?.light.exposure).toBe(1);
  });

  it('does not count a batch write its library refused', () => {
    useBookStore.setState({ libraries: {} });
    expect(book().applyDevelopPreset([key], PRESET_BW)).toBe(0);
    useBookStore.setState({ libraries: { [PATH]: emptyLibrary() } });
    expect(book().applyDevelopPreset([key], PRESET_BW)).toBe(1);
  });

  it('makes nothing for a photo that is not hashed yet', () => {
    seedFolder(null);
    expect(book().createVersion(key)).toBeNull();
  });

  it('names versions v2, v3, … skipping names in use, or as given', () => {
    const a = book().createVersion(key) ?? '';
    book().renameVersion(key, a, 'v3');
    book().createVersion(key);
    book().createVersion(key, '  Zine B&W ');
    const names = Object.values(libraryEntryOf(book(), key)?.versions ?? {}).map((v) => v.name);
    expect(names.sort()).toEqual(['Zine B&W', 'v2', 'v3']);
    expect(nextVersionName(libraryEntryOf(book(), key))).toBe('v4');
    // Making, renaming and deleting are not undo steps.
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });
});

describe('versions in a project', () => {
  beforeEach(() => {
    const doc = structuredClone(fixtureBook);
    for (const [id, asset] of Object.entries(doc.assets)) asset.hash = id === 'f1' || id === 'f2' ? HASH : `h-${id}`;
    useBookStore.setState({ book: doc, folder: PATH });
  });

  it('a version write never reaches the mirror or the other asset on the same bytes', () => {
    book().setAssetDevelop('f1', { light: { exposure: 1 } });
    const v2 = book().createVersion('f1') ?? '';
    book().setAssetVersion('f1', v2);
    book().setAssetDevelop('f1', { light: { exposure: 2 } });
    // f2 has the same bytes and uses the master.
    expect(assetDevelop(book(), 'f2')?.light.exposure).toBe(1);
    expect(book().book?.assets.f1?.develop?.light.exposure).toBe(1);
    expect(assetVersionNames(book())).toEqual({ f1: 'v2' });
    expect(assetVersionNames(book())).toBe(assetVersionNames(book()));
    // An unknown version is refused.
    book().setAssetVersion('f2', 'nope');
    expect(book().book?.assets.f2?.version).toBeUndefined();
  });
});

describe('mergeLibrariesForHistory', () => {
  it('restores each version’s settings, keeping the newest list and names', () => {
    const settings = (exposure: number) => ({ ...createDevelop(), light: { ...createDevelop().light, exposure } });
    const lib = (photo: Library['photos'][string]): Library => ({ ...emptyLibrary(), photos: { [HASH]: photo } });
    const restored = lib({ develop: settings(1), versions: { V1: { name: 'v2', develop: settings(2) } } });
    const newest = lib({
      develop: settings(1),
      versions: { V1: { name: 'B&W', develop: settings(3) }, V2: { name: 'v3', develop: settings(4) } },
    });
    const merged = mergeLibrariesForHistory({ [PATH]: newest }, { [PATH]: restored }, null, PATH);
    expect(merged[PATH]?.photos[HASH]?.versions).toEqual({
      V1: { name: 'B&W', develop: settings(2) },
      V2: { name: 'v3', develop: settings(4) },
    });
    // Nothing to restore: the newest entry itself.
    const same = mergeLibrariesForHistory(
      { [PATH]: newest },
      { [PATH]: lib({ ...newest.photos[HASH], versions: newest.photos[HASH]?.versions ?? {} }) },
      null,
      PATH,
    );
    expect(same[PATH]?.photos[HASH]).toBe(newest.photos[HASH]);
  });
});
