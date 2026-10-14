import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Folder } from '../lib/tauri';
import { useFoldersStore } from './folders';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  listFolders: vi.fn(),
  importFolder: vi.fn(),
  removeFolder: vi.fn(),
  renameFolder: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tauri')>()),
  listFolders: mocks.listFolders,
  importFolder: mocks.importFolder,
  removeFolder: mocks.removeFolder,
  renameFolder: mocks.renameFolder,
}));

const folder = (id: string, name: string, patch: Partial<Folder> = {}): Folder => ({
  id,
  path: `/photos/${name}`,
  name,
  addedAt: 1,
  lastSeen: 1,
  missing: false,
  ...patch,
});
const lisbon = folder('01K7AAAAAAAAAAAAAAAAAAAAAA', 'Lisbon');
const porto = folder('01K7BBBBBBBBBBBBBBBBBBBBBB', 'Porto');
const store = () => useFoldersStore.getState();

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  useFoldersStore.setState({ folders: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('folders store', () => {
  it('loads the registry', async () => {
    mocks.listFolders.mockResolvedValue([lisbon, porto]);
    await expect(store().load()).resolves.toEqual([lisbon, porto]);
    expect(store().folders).toEqual([lisbon, porto]);
  });

  it('imports the picked folder once, refreshing an existing entry in place', async () => {
    useFoldersStore.setState({ folders: [lisbon, porto] });
    mocks.open.mockResolvedValue('/photos/Lisbon');
    const seen = { ...lisbon, lastSeen: 5 };
    mocks.importFolder.mockResolvedValue(seen);
    await expect(store().import()).resolves.toEqual(seen);
    expect(mocks.importFolder).toHaveBeenCalledWith('/photos/Lisbon');
    expect(store().folders).toEqual([seen, porto]);
  });

  it('appends a new folder and does nothing when the dialog is cancelled', async () => {
    useFoldersStore.setState({ folders: [lisbon] });
    mocks.open.mockResolvedValueOnce(null);
    await expect(store().import()).resolves.toBeNull();
    expect(mocks.importFolder).not.toHaveBeenCalled();

    mocks.open.mockResolvedValueOnce('/photos/Porto');
    mocks.importFolder.mockResolvedValue(porto);
    await store().import();
    expect(store().folders).toEqual([lisbon, porto]);
  });

  it('removes and renames through the commands', async () => {
    useFoldersStore.setState({ folders: [lisbon, porto] });
    mocks.removeFolder.mockResolvedValue(undefined);
    await store().remove(lisbon.id);
    expect(mocks.removeFolder).toHaveBeenCalledWith(lisbon.id);
    expect(store().folders).toEqual([porto]);

    const renamed = { ...porto, name: 'Porto 2026' };
    mocks.renameFolder.mockResolvedValue(renamed);
    await store().rename(porto.id, 'Porto 2026');
    expect(mocks.renameFolder).toHaveBeenCalledWith(porto.id, 'Porto 2026');
    expect(store().folders).toEqual([renamed]);
  });

  it('keeps the list when a command fails', async () => {
    useFoldersStore.setState({ folders: [lisbon] });
    mocks.removeFolder.mockRejectedValue('Access denied');
    await expect(store().remove(lisbon.id)).rejects.toBe('Access denied');
    expect(store().folders).toEqual([lisbon]);
  });
});
