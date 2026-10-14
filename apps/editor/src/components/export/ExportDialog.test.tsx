// @vitest-environment jsdom
import { emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { resetJobs } from '../../store/jobs';
import { type LibraryFolder, type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { EMPTY_SELECTION, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({
  exportPhoto: vi.fn(),
  exportStatus: vi.fn(),
  checkExportDest: vi.fn(async (dir: string) => dir),
  listExportPresets: vi.fn(async () => [] as unknown[]),
  saveExportPreset: vi.fn(async () => {}),
  deleteExportPreset: vi.fn(async () => {}),
  revealExport: vi.fn(async () => {}),
  cancelDevelop: vi.fn(async () => {}),
  exportCapabilities: vi.fn(async () => ({ heic: false })),
  importWatermark: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../../lib/tauri', () => ({
  ...mocks,
  onExportProgress: async () => () => {},
  onDenoiseProgress: async () => () => {},
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));

const { ExportDialog, countLine } = await import('./ExportDialog');
const { ExportToast, exportRunText } = await import('./ExportToast');
const { exportTargetNow, installExportShortcut } = await import('./entryPoints');
const { useExportsStore } = await import('../../store/exports');

const PATH = '/photos/lisbon';
const F = 'F1';
const hashOf = (name: string) => name.charCodeAt(0).toString(16).padStart(64, '0');
const photo = (relPath: string): PhotoFile => ({
  relPath,
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: hashOf(relPath),
  status: 'ready',
});
const keys = ['a.jpg', 'b.jpg', 'c.jpg'].map((n) => photoKey({ folder: F, path: n }));

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  const folder: LibraryFolder = {
    id: F,
    path: PATH,
    photos: { 'a.jpg': photo('a.jpg'), 'b.jpg': photo('b.jpg'), 'c.jpg': photo('c.jpg') },
    progress: { hashed: 0, prepared: 0, total: 0 },
    busy: false,
    error: null,
    scanned: true,
  };
  useLibraryStore.setState({ folders: { [F]: folder } });
  useBookStore.setState({ book: null, folder: null, libraries: { [PATH]: emptyLibrary() }, developVersion: null });
  useExportsStore.setState({ saved: [], loaded: false, lastPresetId: 'social', dialog: null, runs: [] });
  useUiStore.setState({ develop: null, review: null, selection: EMPTY_SELECTION });
  mocks.exportStatus.mockResolvedValue([
    { cached: true, exported: true, replaces: false },
    { cached: true, exported: false, replaces: false },
    { cached: false, exported: false, replaces: false },
  ]);
  mocks.exportPhoto.mockImplementation(async (item: { destDir: string; name: string }) => ({
    path: `${item.destDir}/${item.name}`,
    bytes: 1,
    encoded: true,
    skipped: false,
  }));
});

afterEach(cleanup);

const status = () => within(screen.getByRole('dialog')).getByRole('status');

describe('Export dialog', () => {
  it('opens on the last preset with the count of what it will do', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    expect(screen.getByRole('dialog', { name: 'Export 3 photos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Social' }).getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(status().textContent).toBe('3 photos, 1 already exported (skipped), 1 from the cache'));
    expect(screen.getByText('For example a.jpg')).toBeTruthy();
    expect(mocks.listExportPresets).toHaveBeenCalled();
    expect((screen.getByLabelText('Quality') as HTMLInputElement).value).toBe('88');
  });

  it('marks a changed preset, saves it under a name, and exports one job per photo', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'webp' } });
    expect(screen.getByRole('button', { name: 'Web (modified)' })).toBeTruthy();
    // PNG and WebP carry no Exif.
    expect(screen.queryByLabelText('Metadata')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Web WebP' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveExportPreset).toHaveBeenCalled());
    const saved = (mocks.saveExportPreset.mock.calls[0] as unknown[])[0] as { name: string; options: unknown };
    expect(saved).toMatchObject({ name: 'Web WebP', builtIn: false, options: { format: 'webp', longEdge: 1600 } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Web WebP' }).getAttribute('aria-current')).toBe('true'),
    );
    await waitFor(() => expect(status().textContent).toMatch(/^3 photos/));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(3));
    expect(useExportsStore.getState().dialog).toBeNull();
    expect(useExportsStore.getState().lastPresetId).toBe((saved as { id?: string }).id);
    const names = mocks.exportPhoto.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual(['a.webp', 'b.webp', 'c.webp']);
    await waitFor(() => expect(useExportsStore.getState().runs[0]?.over).toBe(true));
    render(<ExportToast />);
    expect(screen.getByText('Exported 3 photos with Web WebP.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(mocks.revealExport).toHaveBeenCalledWith(`${PATH}/Exports/Web WebP/a.webp`);
  });

  it('asks before replacing files that are not exports of these photos', async () => {
    mocks.exportStatus.mockResolvedValue([
      { cached: false, exported: false, replaces: true },
      { cached: false, exported: false, replaces: false },
      { cached: false, exported: false, replaces: false },
    ]);
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    await waitFor(() => expect(status().textContent).toBe('3 photos, 1 existing file will be replaced'));
    const exportButton = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Replace the existing file/ }));
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    await waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(3));
    expect(mocks.exportPhoto.mock.calls.every((c) => c[4] === true)).toBe(true);
  });

  it('gives a saved preset a name no other preset has', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as preset…' }));
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'social' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.saveExportPreset).toHaveBeenCalled());
    expect((mocks.saveExportPreset.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'social 2' });
  });

  it('asks for a custom destination again when it is no longer in scope', async () => {
    mocks.open.mockResolvedValue('/Volumes/Card/Out');
    act(() => useExportsStore.getState().openDialog(keys.slice(0, 1), 'a.jpg'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    await waitFor(() => expect(screen.getByTitle('/Volumes/Card/Out')).toBeTruthy());
    mocks.checkExportDest.mockRejectedValueOnce(new Error('out of scope'));
    await waitFor(() => expect(status().textContent).toMatch(/^1 photo/));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Choose the destination folder again/));
    expect(mocks.exportPhoto).not.toHaveBeenCalled();
  });
});

describe('Export dialog, plan 12', () => {
  it('offers HEIC only where it can be written, where Full quality becomes HEIC', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    const { unmount } = render(<ExportDialog />);
    await waitFor(() => expect(mocks.exportCapabilities).toHaveBeenCalled());
    const formats = () =>
      [...(screen.getByLabelText('Format') as HTMLSelectElement).options].map((option) => option.value);
    expect(formats()).toEqual(['jpeg', 'png', 'webp', 'avif', 'tiff', 'original']);
    unmount();
    mocks.exportCapabilities.mockResolvedValueOnce({ heic: true });
    act(() => useExportsStore.setState({ loaded: false, lastPresetId: 'full-quality' }));
    render(<ExportDialog />);
    await waitFor(() => expect(formats()).toContain('heic'));
    expect((screen.getByLabelText('Format') as HTMLSelectElement).value).toBe('heic');
    expect((screen.getByLabelText('Colour space') as HTMLSelectElement).value).toBe('display-p3');
  });

  it('sends the watermark, the border and the per-format quality to every job', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'avif' } });
    expect((screen.getByLabelText('Quality') as HTMLInputElement).value).toBe('70');
    // sRGB photos: Display P3 is not offered.
    expect(screen.queryByLabelText('Colour space')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add a watermark' }));
    fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: '© Jan' } });
    fireEvent.click(screen.getByRole('button', { name: 'top left' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add a border' }));
    fireEvent.change(screen.getByLabelText('Border unit'), { target: { value: 'px' } });
    fireEvent.change(screen.getByLabelText('Border width'), { target: { value: '24' } });
    expect(screen.getByText('Text “© Jan”, top left, 70%')).toBeTruthy();
    expect(screen.getByText('24 px white')).toBeTruthy();
    await waitFor(() => expect(status().textContent).toMatch(/^3 photos/));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(mocks.exportPhoto).toHaveBeenCalledTimes(3));
    const [item, options] = mocks.exportPhoto.mock.calls[0] as [{ name: string }, Record<string, unknown>];
    expect(item.name).toBe('a.avif');
    expect(options).toMatchObject({
      format: 'avif',
      quality: 70,
      watermark: { kind: 'text', text: '© Jan', position: 'top-left' },
      border: { width: 24, unit: 'px', colour: '#ffffff' },
    });
  });

  it('waits for an incomplete watermark and starts each format at its own quality', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    // JPEG 90 (its default) → PNG (no quality) → AVIF opens at AVIF's own default.
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'png' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'avif' } });
    expect((screen.getByLabelText('Quality') as HTMLInputElement).value).toBe('70');
    expect(screen.getByText('sRGB: AVIF is written in sRGB only.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add a watermark' }));
    fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: '  ' } });
    await waitFor(() => expect(status().textContent).toMatch(/^3 photos/));
    const exportButton = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(screen.getAllByText(/Type the watermark text/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Watermark kind'), { target: { value: 'image' } });
    expect(exportButton.disabled).toBe(true);
    expect(screen.getAllByText(/Choose the watermark image/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Watermark kind'), { target: { value: 'text' } });
    fireEvent.change(screen.getByLabelText('Watermark text'), { target: { value: '© Jan' } });
    // Enabled again once the count for the new settings is in.
    await waitFor(() => expect(exportButton.disabled).toBe(false));
  });

  it('Original + sidecar keeps the source extension and offers no develop options', async () => {
    act(() => useExportsStore.getState().openDialog(keys, '3 photos'));
    render(<ExportDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Original + sidecar' }));
    expect(screen.queryByLabelText('Quality')).toBeNull();
    expect(screen.queryByText('Resize to fit')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Add a watermark' })).toBeNull();
    await waitFor(() => expect(screen.getByText('For example a.jpg')).toBeTruthy());
    const statusItems = mocks.exportStatus.mock.calls.at(-1)?.[0] as { relPath?: string }[];
    expect(statusItems[0]?.relPath).toBe('a.jpg');
  });
});

describe('entry points and text', () => {
  it('Cmd+Shift+E exports the photo Develop shows, or the Cull selection', () => {
    installExportShortcut();
    const press = () => fireEvent.keyDown(window, { key: 'E', code: 'KeyE', metaKey: true, shiftKey: true });
    press();
    expect(useExportsStore.getState().dialog).toBeNull();
    act(() => useUiStore.setState({ develop: { ids: keys, index: 1 } }));
    expect(exportTargetNow()).toEqual([keys[1]]);
    press();
    expect(useExportsStore.getState().dialog).toEqual({ ids: [keys[1]], title: 'b.jpg' });
    act(() => {
      useExportsStore.getState().closeDialog();
      useUiStore.setState({
        develop: null,
        review: { ids: keys, index: 0 },
        selection: { keys: [keys[2] ?? ''], anchor: null },
      });
    });
    press();
    expect(useExportsStore.getState().dialog?.ids).toEqual([keys[2]]);
  });

  it('words the count and the toast', () => {
    expect(countLine(null, true)).toBe('Counting…');
    expect(countLine({ total: 12, cached: 3, exported: 3, replaces: 0, missing: 0 }, true)).toBe(
      '12 photos, 3 already exported (skipped)',
    );
    expect(countLine({ total: 12, cached: 3, exported: 3, replaces: 2, missing: 1 }, false)).toBe(
      '12 photos, 3 already exported, 3 from the cache, 1 not ready (not hashed yet), 2 existing files will be replaced',
    );
    const run = {
      id: 1,
      preset: 'Social',
      total: 12,
      encoded: 3,
      copied: 0,
      skipped: 9,
      failed: 0,
      cancelled: 0,
      missing: 0,
      paths: [],
      over: true,
    };
    expect(exportRunText(run)).toBe('Exported 12 photos with Social (3 encoded, 9 already there).');
    expect(exportRunText({ ...run, over: false, skipped: 2 })).toBe('Exporting with Social… 5/12');
    expect(exportRunText({ ...run, failed: 1, skipped: 8 })).toBe(
      'Exported 11 photos with Social (3 encoded, 8 already there); 1 failed (see Jobs).',
    );
  });
});
