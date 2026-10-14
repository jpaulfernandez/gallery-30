// @vitest-environment jsdom
import { BUILT_IN_LOOK_DEFS } from '@photobook/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder } from '../../lib/tauri';
import { useFoldersStore } from '../../store/folders';
import { type PhotoFile, useLibraryStore } from '../../store/library';

const mocks = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
}));

import { LooksFixture } from './LooksFixture';

const folder = (id: string, path: string): Folder => ({
  id,
  path,
  name: path.split('/').pop() ?? id,
  addedAt: 1,
  lastSeen: 1,
  missing: false,
});

const photo = (relPath: string, hash: string): PhotoFile => ({
  relPath,
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash,
  status: 'ready',
});

function seed(): void {
  const folders = [folder('lis', '/f/lisbon-demo'), folder('por', '/f/portrait')];
  useFoldersStore.setState({ folders: [], load: async () => folders });
  const empty = { progress: { hashed: 0, prepared: 0, total: 0 }, busy: false, error: null, scanned: true };
  useLibraryStore.setState({
    addFolder: () => {},
    loadIndex: async () => {},
    folders: {
      lis: {
        id: 'lis',
        path: '/f/lisbon-demo',
        photos: {
          'IMG_00.jpg': photo('IMG_00.jpg', 'h0'),
          'IMG_01.jpg': photo('IMG_01.jpg', 'h1'),
          'IMG_11.jpg': photo('IMG_11.jpg', 'h11'),
        },
        ...empty,
      },
      por: { id: 'por', path: '/f/portrait', photos: { 'portrait-01.jpg': photo('portrait-01.jpg', 'hp') }, ...empty },
    },
  });
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:look-${++n}`);
  URL.revokeObjectURL = vi.fn();
  localStorage.clear();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([1, 2, 3]).buffer);
  seed();
});

afterEach(cleanup);

const LOOK_COUNT = BUILT_IN_LOOK_DEFS.length + 1;

describe('/fixture Looks tab (plan 21)', () => {
  it('renders None and every built-in look on the three review fixtures, one at a time, through the preview render', async () => {
    render(<LooksFixture />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(3 * LOOK_COUNT), { timeout: 5000 });
    const calls = mocks.render.mock.calls;
    // The review fixtures by file name, in slot order; None first for each.
    expect(calls.map((c) => c[1]).filter((p, i, all) => all.indexOf(p) === i)).toEqual([
      'IMG_01.jpg',
      'IMG_11.jpg',
      'portrait-01.jpg',
    ]);
    expect(calls[0]?.[0]).toBe('/f/lisbon-demo');
    expect(calls[0]?.[3].look.applied).toBeNull();
    expect(calls[1]?.[3].look.applied).toEqual({
      presetId: `builtin:${BUILT_IN_LOOK_DEFS[0]?.id}`,
      amount: BUILT_IN_LOOK_DEFS[0]?.amount,
    });
    // Job ids increase (the preview command keeps only the newest).
    const jobs = calls.map((c) => c[4] as number);
    expect(jobs).toEqual([...jobs].sort((a, b) => a - b));
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3 * LOOK_COUNT));
    expect(screen.getAllByText(BUILT_IN_LOOK_DEFS[0]?.about ?? '')).toHaveLength(3);
  });

  it('Before shows each photo without its look; 100% renders the looks again at full strength', async () => {
    render(<LooksFixture />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3 * LOOK_COUNT), { timeout: 5000 });
    const cell = (id: string) => document.querySelector(`[data-look-id="${id}"] img`) as HTMLImageElement;
    const id = `builtin:${BUILT_IN_LOOK_DEFS[0]?.id}`;
    const withLook = cell(id).src;
    fireEvent.click(screen.getByLabelText('Before'));
    expect(cell(id).src).toBe(cell('none').src);
    expect(cell(id).alt).toBe(`${BUILT_IN_LOOK_DEFS[0]?.name}, before`);
    fireEvent.click(screen.getByLabelText('Before'));
    expect(cell(id).src).toBe(withLook);
    mocks.render.mockClear();
    fireEvent.change(within(screen.getByText('Amount').parentElement as HTMLElement).getByRole('combobox'), {
      target: { value: 'full' },
    });
    // None is shared; every look renders again at 100 %.
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(3 * (LOOK_COUNT - 1)), { timeout: 5000 });
    expect(mocks.render.mock.calls.every((c) => c[3].look.applied?.amount === 100)).toBe(true);
    // The starting-Amount renders no cell shows any more are revoked; None's are kept.
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3 * (LOOK_COUNT - 1));
  });

  it('a render dropped for a newer job is tried again, then marked skipped', async () => {
    mocks.render.mockImplementation(async (_folder: string, path: string, _hash: string, settings) =>
      path === 'IMG_11.jpg' && settings.look.applied === null ? null : new Uint8Array([1]).buffer,
    );
    render(<LooksFixture />);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3 * LOOK_COUNT - 1), { timeout: 5000 });
    expect(screen.getByText('Skipped: a newer render replaced it')).toBeTruthy();
    const none11 = mocks.render.mock.calls.filter((c) => c[1] === 'IMG_11.jpg' && c[3].look.applied === null);
    expect(none11).toHaveLength(3);
  });
});
