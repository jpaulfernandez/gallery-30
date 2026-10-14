// @vitest-environment jsdom
import { type DevelopSettings, serializeBook } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { assetDevelop, libraryEntryOf, resolvedAssets } from '../../store/library';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  commit: vi.fn(),
  projects: [] as { id: string; title?: string; text: string }[],
  /** Runs while a project file is being read (something the person does meanwhile). */
  onRead: null as null | (() => void),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
  listProjects: vi.fn(async () => mocks.projects.map(({ id, title }) => ({ id, title: title ?? '' }))),
  readProject: vi.fn(async (id: string) => {
    mocks.onRead?.();
    const text = mocks.projects.find((p) => p.id === id)?.text;
    if (text === undefined) throw `No project with id ${id}`;
    return text;
  }),
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2', 'f3'];
const book = () => useBookStore.getState();
const versions = () => screen.getByRole('toolbar', { name: 'Versions' });
const chip = (name: string | RegExp) => within(versions()).getByRole('button', { name });
const entry = (id = 'f1') => libraryEntryOf(book(), id);
const lastPreview = () => (mocks.render.mock.calls.at(-1)?.[3] as DevelopSettings | undefined)?.light.exposure;

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

function open(index = 0) {
  act(() => useUiStore.getState().openDevelop(IDS, index));
  return render(<DevelopMode />);
}

/** Make a version from the Versions strip and return its id. */
function makeVersion(): string {
  fireEvent.click(within(versions()).getByRole('button', { name: 'Make a version' }));
  return (
    Object.keys(entry()?.versions ?? {})
      .sort()
      .at(-1) ?? ''
  );
}

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.commit.mockReset();
  mocks.projects = [];
  mocks.onRead = null;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, projectId: 'P1', folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, filmstrip: DEFAULT_FILMSTRIP, selection: EMPTY_SELECTION });
  act(() => book().setAssetDevelop('f1', { light: { exposure: 1 } }));
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await book().close();
  useAssetsStore.setState({ files: {} });
});

describe('Versions in a project', () => {
  it('Make a version copies the settings, the project uses it, and edits go to it', () => {
    open();
    expect(chip(/^Master/).getAttribute('aria-pressed')).toBe('true');
    const v2 = makeVersion();
    expect(entry()?.versions[v2]).toMatchObject({ name: 'v2' });
    expect(entry()?.versions[v2]?.develop.light.exposure).toBe(1);
    expect(book().book?.assets.f1?.version).toBe(v2);
    expect(chip(/^v2/).getAttribute('aria-pressed')).toBe('true');
    expect(within(chip(/^v2/)).getByRole('img', { name: '(used in this project)' })).toBeTruthy();
    // The strip shows the version the project uses.
    expect(within(screen.getByRole('button', { name: 'Develop f1.jpg' })).getByText('v2')).toBeTruthy();

    act(() => book().setAssetDevelop('f1', { light: { exposure: 2 } }));
    expect(entry()?.versions[v2]?.develop.light.exposure).toBe(2);
    expect(entry()?.develop?.light.exposure).toBe(1);
    // The canvas and publishing read the version the project uses; the mirror keeps the master.
    expect(resolvedAssets(book())?.f1?.develop?.light.exposure).toBe(2);
    expect(book().book?.assets.f1?.develop?.light.exposure).toBe(1);
  });

  it('switching versions rerenders the preview; Use in this project switches what the project renders', async () => {
    open();
    const v2 = makeVersion();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 2 } }));
    await waitFor(() => expect(lastPreview()).toBe(2));
    fireEvent.click(chip(/^Master/));
    await waitFor(() => expect(lastPreview()).toBe(1));
    // The master is shown and edited, the project still uses v2.
    expect(book().developVersion).toEqual({ id: 'f1', version: null });
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.5 } }));
    expect(entry()?.develop?.light.exposure).toBe(0.5);
    expect(entry()?.versions[v2]?.develop.light.exposure).toBe(2);
    await waitFor(() => expect(lastPreview()).toBe(0.5));
    fireEvent.click(within(versions()).getByRole('button', { name: 'Use in this project' }));
    expect(book().book?.assets.f1?.version).toBeUndefined();
    expect(book().developVersion).toBeNull();
    expect(resolvedAssets(book())?.f1?.develop?.light.exposure).toBe(0.5);
    expect(within(versions()).queryByRole('button', { name: 'Use in this project' })).toBeNull();
    fireEvent.click(chip(/^v2/));
    await waitFor(() => expect(lastPreview()).toBe(2));
  });

  it('undo restores a version’s settings and keeps the version; stepping away drops the choice', () => {
    open();
    const v2 = makeVersion();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 3 } }));
    act(() => {
      undo();
    });
    expect(entry()?.versions[v2]?.develop.light.exposure).toBe(1);
    act(() => {
      undo();
    });
    // The step before it was the master's first edit: undone, while the version stays.
    expect(entry()?.develop).toBeUndefined();
    expect(entry()?.versions[v2]).toBeDefined();

    fireEvent.click(chip(/^Master/));
    expect(book().developVersion).not.toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(book().developVersion).toBeNull();
  });

  it('renames a version, and refuses to delete one a project uses', async () => {
    open();
    const v2 = makeVersion();
    fireEvent.click(within(versions()).getByRole('button', { name: 'Rename' }));
    const field = within(versions()).getByRole('textbox', { name: 'Version name' });
    fireEvent.change(field, { target: { value: 'B&W' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(entry()?.versions[v2]?.name).toBe('B&W');

    // This project uses it.
    await act(async () => {
      fireEvent.click(within(versions()).getByRole('button', { name: 'Delete' }));
    });
    expect(within(versions()).getByRole('status').textContent).toMatch(/used by Renderer fixture\.$/);
    expect(entry()?.versions[v2]).toBeDefined();

    // Another project's file uses it.
    fireEvent.click(chip(/^Master/));
    fireEvent.click(within(versions()).getByRole('button', { name: 'Use in this project' }));
    const other = structuredClone(fixtureBook);
    other.title = 'Carousel';
    if (other.assets.f1) other.assets.f1.version = v2;
    mocks.projects = [{ id: 'P2', title: 'Carousel', text: serializeBook(other) }];
    fireEvent.click(chip(/^B&W/));
    await act(async () => {
      fireEvent.click(within(versions()).getByRole('button', { name: 'Delete' }));
    });
    expect(within(versions()).getByRole('status').textContent).toBe('Not deleted: used by Carousel.');

    mocks.projects = [];
    await act(async () => {
      fireEvent.click(within(versions()).getByRole('button', { name: 'Delete' }));
    });
    expect(entry()?.versions).toEqual({});
    expect(chip(/^Master/).getAttribute('aria-pressed')).toBe('true');
    expect(assetDevelop(book(), 'f1')?.light.exposure).toBe(1);
  });

  it('refuses to delete while a project file cannot be read, and re-checks the open project after reading', async () => {
    open();
    const v2 = makeVersion();
    fireEvent.click(chip(/^Master/));
    fireEvent.click(within(versions()).getByRole('button', { name: 'Use in this project' }));
    expect(book().book?.assets.f1?.version).toBeUndefined();

    // A broken project file may use it: kept, and named.
    mocks.projects = [{ id: 'P3', title: 'Old zine', text: '{ not json' }];
    await expect(book().deleteVersion('f1', v2)).resolves.toEqual(['Old zine (could not be read)']);
    expect(entry()?.versions[v2]).toBeDefined();

    // The open project starts using it while the other files are read: kept.
    mocks.projects = [{ id: 'P2', title: 'Carousel', text: serializeBook(structuredClone(fixtureBook)) }];
    mocks.onRead = () => book().setAssetVersion('f1', v2);
    await expect(book().deleteVersion('f1', v2)).resolves.toEqual(['Renderer fixture']);
    expect(entry()?.versions[v2]).toBeDefined();
  });
});
