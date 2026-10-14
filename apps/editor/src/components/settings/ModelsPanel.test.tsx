// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelProgressEvent } from '../../lib/tauri';

const mocks = vi.hoisted(() => ({
  listModels: vi.fn(),
  modelsDir: vi.fn(async () => '/Users/me/Library/Application Support/com.photobook.editor/models'),
  downloadModel: vi.fn(),
  cancelModelDownload: vi.fn(async () => true),
  deleteModel: vi.fn(),
  openModelLink: vi.fn(async () => {}),
  progress: null as ((e: ModelProgressEvent) => void) | null,
}));
vi.mock('../../lib/tauri', () => ({
  listModels: mocks.listModels,
  modelsDir: mocks.modelsDir,
  downloadModel: mocks.downloadModel,
  cancelModelDownload: mocks.cancelModelDownload,
  deleteModel: mocks.deleteModel,
  openModelLink: mocks.openModelLink,
  onModelProgress: vi.fn(async (handler: (e: ModelProgressEvent) => void) => {
    mocks.progress = handler;
    return () => {
      mocks.progress = null;
    };
  }),
}));

const { ModelsPanel, formatBytes } = await import('./ModelsPanel');

function model(overrides: Partial<ModelInfo>): ModelInfo {
  return {
    name: 'skywater-seg',
    title: 'SkyWater-Seg',
    version: 'b2-fp16-dac2558',
    task: 'sky',
    bytes: 49_867_699,
    licence: 'MIT',
    licenceUrl: 'https://huggingface.co/Realcat/skywater_seg',
    homepage: 'https://huggingface.co/Realcat/skywater_seg',
    status: { state: 'missing' },
    installedBytes: 0,
    downloadable: true,
    ...overrides,
  };
}

const sky = model({});
const subject = model({
  name: 'birefnet-lite',
  title: 'BiRefNet lite',
  task: 'subject',
  bytes: 114_538_221,
  status: { state: 'installed' },
  installedBytes: 120_000_000,
});
const nafnet = model({
  name: 'nafnet-sidd-width32',
  title: 'NAFNet SIDD width32',
  task: 'denoise',
  downloadable: false,
});

async function mount(list: ModelInfo[] = [sky, subject, nafnet]) {
  mocks.listModels.mockResolvedValue(list);
  render(<ModelsPanel />);
  await act(async () => {});
}

const row = (title: string) => screen.getByRole('listitem', { name: title });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ModelsPanel', () => {
  it('lists models with task, size, licence, state, the disk total and the folder', async () => {
    await mount();
    const skyRow = within(row('SkyWater-Seg'));
    expect(skyRow.getByText('Sky')).toBeTruthy();
    expect(skyRow.getByText('49.9 MB')).toBeTruthy();
    expect(skyRow.getByText('Not downloaded')).toBeTruthy();
    expect(skyRow.getByRole('button', { name: 'Download SkyWater-Seg' })).toBeTruthy();
    expect(skyRow.queryByRole('button', { name: 'Delete SkyWater-Seg' })).toBeNull();

    const subjectRow = within(row('BiRefNet lite'));
    expect(subjectRow.getByText('Installed · 120.0 MB on disk')).toBeTruthy();
    expect(subjectRow.queryByRole('button', { name: /^Download/ })).toBeNull();

    const unpinned = within(row('NAFNet SIDD width32'));
    expect(unpinned.getByText('Not available yet (checksum not pinned)')).toBeTruthy();
    expect((unpinned.getByRole('button', { name: 'Download NAFNet SIDD width32' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    expect(screen.getByText('120.0 MB')).toBeTruthy();
    expect(screen.getByText('/Users/me/Library/Application Support/com.photobook.editor/models')).toBeTruthy();

    fireEvent.click(skyRow.getByRole('button', { name: 'SkyWater-Seg licence: MIT' }));
    expect(mocks.openModelLink).toHaveBeenCalledWith('skywater-seg', 'licence');
  });

  it('downloads with a progress bar and ends installed', async () => {
    await mount();
    let finish: (info: ModelInfo) => void = () => {};
    mocks.downloadModel.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    fireEvent.click(screen.getByRole('button', { name: 'Download SkyWater-Seg' }));
    await act(async () => {});

    const job = mocks.downloadModel.mock.calls[0]?.[1] as number;
    expect(mocks.downloadModel).toHaveBeenCalledWith('skywater-seg', job);
    act(() => mocks.progress?.({ job, name: 'skywater-seg', received: 24_933_849, total: 49_867_699 }));
    const bar = screen.getByRole('progressbar', { name: 'SkyWater-Seg download' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('24.9 MB / 49.9 MB')).toBeTruthy();
    expect(within(row('SkyWater-Seg')).getByText('Downloading…')).toBeTruthy();

    await act(async () => finish({ ...sky, status: { state: 'installed' }, installedBytes: 49_867_699 }));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(within(row('SkyWater-Seg')).getByText('Installed · 49.9 MB on disk')).toBeTruthy();
    expect(within(row('SkyWater-Seg')).getByRole('button', { name: 'Delete SkyWater-Seg' })).toBeTruthy();
  });

  it('cancels, keeps the partial file and offers to resume', async () => {
    await mount();
    let fail: (reason: string) => void = () => {};
    mocks.downloadModel.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    fireEvent.click(screen.getByRole('button', { name: 'Download SkyWater-Seg' }));
    await act(async () => {});
    const job = mocks.downloadModel.mock.calls[0]?.[1] as number;

    fireEvent.click(screen.getByRole('button', { name: 'Cancel SkyWater-Seg download' }));
    await act(async () => {});
    expect(mocks.cancelModelDownload).toHaveBeenCalledWith(job);

    mocks.listModels.mockResolvedValue([{ ...sky, status: { state: 'partial', bytes: 10_000_000 } }, subject, nafnet]);
    await act(async () => fail('cancelled'));
    const skyRow = within(row('SkyWater-Seg'));
    expect(skyRow.queryByRole('alert')).toBeNull();
    expect(skyRow.getByText('Partial · 10.0 MB of 49.9 MB')).toBeTruthy();
    expect(skyRow.getByRole('button', { name: 'Resume SkyWater-Seg' })).toBeTruthy();
  });

  it('shows an offline error on the row', async () => {
    await mount();
    mocks.downloadModel.mockRejectedValue('offline: could not reach huggingface.co (dns error)');
    fireEvent.click(screen.getByRole('button', { name: 'Download SkyWater-Seg' }));
    await act(async () => {});
    expect(within(row('SkyWater-Seg')).getByRole('alert').textContent).toBe(
      'offline: could not reach huggingface.co (dns error)',
    );
  });

  it('deletes after a confirmation', async () => {
    await mount();
    mocks.deleteModel.mockResolvedValue({ ...subject, status: { state: 'missing' }, installedBytes: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete BiRefNet lite' }));
    expect(mocks.deleteModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete BiRefNet lite' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting BiRefNet lite' }));
    await act(async () => {});
    expect(mocks.deleteModel).toHaveBeenCalledWith('birefnet-lite');
    expect(within(row('BiRefNet lite')).getByText('Not downloaded')).toBeTruthy();
    expect(screen.getByText('0 B')).toBeTruthy();
  });

  it('formats sizes in decimal units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(213_114)).toBe('213 KB');
    expect(formatBytes(49_867_699)).toBe('49.9 MB');
    expect(formatBytes(1_234_000_000)).toBe('1.23 GB');
  });
});
