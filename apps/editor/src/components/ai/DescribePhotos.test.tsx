// @vitest-environment jsdom
import { emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '../../store/ai';
import { useBookStore } from '../../store/book';
import { resetJobs, useJobsStore } from '../../store/jobs';
import { type LibraryFolder, type PhotoFile, photoKey, useLibraryStore } from '../../store/library';

const mocks = vi.hoisted(() => ({
  aiDescribe: vi.fn(),
  aiCancel: vi.fn(async () => true),
  readAiSettings: vi.fn(),
  readLibrary: vi.fn(async () => null),
  readLibraryBackup: vi.fn(async () => null),
}));
vi.mock('../../lib/tauri', () => ({ ...mocks }));

const { DescribeDialog, describePhotosAction, useDescribeStore } = await import('./DescribePhotos');

const PATH = '/photos/lisbon';
const F = 'F1';
const names = (n: number) => Array.from({ length: n }, (_, i) => `IMG_${i}.jpg`);
const hashOf = (name: string) =>
  [...name]
    .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(64, '0');
const photo = (relPath: string): PhotoFile => ({
  relPath,
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: hashOf(relPath),
  width: 1600,
  height: 1067,
  status: 'ready',
});

function seed(count: number): string[] {
  const list = names(count);
  const folder: LibraryFolder = {
    id: F,
    path: PATH,
    photos: Object.fromEntries(list.map((n) => [n, photo(n)])),
    progress: { hashed: 0, prepared: 0, total: 0 },
    busy: false,
    error: null,
    scanned: true,
  };
  useLibraryStore.setState({ folders: { [F]: folder } });
  return list.map((n) => photoKey({ folder: F, path: n }));
}

const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.aiDescribe.mockImplementation(async (refs: { id: string }[]) => ({
    status: 'ok',
    model: 'claude-haiku-5-5',
    servedBy: 'claude-haiku-5-5',
    fellBack: false,
    usage,
    attempts: [{ model: 'claude-haiku-5-5', usage }],
    entries: refs.map((r) => ({
      id: r.id,
      description: 'A street.',
      people: 0,
      setting: 'street',
      timeOfDay: 'midday',
      mood: 'calm',
    })),
    missing: [],
  }));
  useAiStore.setState({
    settings: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      indexModel: 'claude-haiku-5-5',
      hasKey: true,
      keyHint: '…abcd',
    },
  });
  useBookStore.setState({ book: null, folder: null, libraries: { [PATH]: emptyLibrary() }, developVersion: null });
  useDescribeStore.setState({ dialog: null, toasts: [] });
});

afterEach(cleanup);

describe('Describe photos', () => {
  it('runs at once for a few photos, without a dialog', async () => {
    await describePhotosAction(seed(12));
    expect(useDescribeStore.getState().dialog).toBeNull();
    const job = Object.values(useJobsStore.getState().jobs)[0];
    expect(job?.kind).toBe('ai');
    expect(job?.label).toBe('Describe 12 photos');
    await waitFor(() => expect(mocks.aiDescribe).toHaveBeenCalledTimes(2));
  });

  it('shows the cost first above 20 photos, then describes on confirm', async () => {
    const ids = seed(30);
    await describePhotosAction(ids);
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
    render(<DescribeDialog />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toBe('30 photos to describe.');
    expect(dialog.textContent).toMatch(
      /4 requests of up to 8 photos, about [\d,]+ tokens, roughly .+ on Claude Haiku 5\.5/,
    );
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Describe 30 photos' })));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(mocks.aiDescribe).toHaveBeenCalledTimes(4));
  });

  it('says when everything is described and offers Refresh', async () => {
    const ids = seed(3);
    await describePhotosAction(ids);
    await waitFor(() => expect(mocks.aiDescribe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(Object.values(useJobsStore.getState().jobs)[0]?.state).toBe('done'));
    await describePhotosAction(ids);
    render(<DescribeDialog />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toBe('0 photos to describe, 3 already described.');
    expect((within(dialog).getByRole('button', { name: 'Describe' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('checkbox')).toBeTruthy();
  });

  it('starts one run at a time, and a toast says what it did', async () => {
    const ids = seed(12);
    await describePhotosAction(ids);
    // A second click while the run is going does nothing (no second job, no double billing).
    await describePhotosAction(ids);
    expect(Object.values(useJobsStore.getState().jobs)).toHaveLength(1);
    await waitFor(() => expect(useDescribeStore.getState().toasts).toHaveLength(1));
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(2);
    render(<DescribeDialog />);
    expect(screen.getByRole('status').textContent).toMatch(/^Described 12 photos, under \$0\.01\./);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useDescribeStore.getState().toasts).toHaveLength(0);
  });

  it('opens the dialog when Refresh would redo entries, or when asked (Shift-click)', async () => {
    const ids = seed(3);
    await describePhotosAction(ids, { ask: true });
    expect(useDescribeStore.getState().dialog?.plan?.todo).toHaveLength(3);
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
    useDescribeStore.setState({ dialog: null });
    await describePhotosAction(ids);
    await waitFor(() => expect(useDescribeStore.getState().toasts).toHaveLength(1));
    const settings = useAiStore.getState().settings;
    if (settings) useAiStore.setState({ settings: { ...settings, indexModel: 'claude-sonnet-5-5' } });
    await describePhotosAction(ids);
    render(<DescribeDialog />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status').textContent).toBe(
      '0 photos to describe, 3 already described (3 by a cheaper model: Refresh redoes them).',
    );
    await act(async () => fireEvent.click(within(dialog).getByRole('checkbox')));
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toBe('3 photos to describe.'));
  });

  it('shows why the AI settings could not be read', async () => {
    useAiStore.setState({ settings: null, error: null });
    mocks.readAiSettings.mockRejectedValueOnce('ai.env is not readable');
    await describePhotosAction(seed(2));
    render(<DescribeDialog />);
    expect(screen.getByRole('alert').textContent).toBe('ai.env is not readable');
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
  });

  it('asks for a key first', async () => {
    const settings = useAiStore.getState().settings;
    if (settings) useAiStore.setState({ settings: { ...settings, hasKey: false } });
    await describePhotosAction(seed(2));
    render(<DescribeDialog />);
    expect(screen.getByRole('alert').textContent).toMatch(/Settings → AI/);
    expect(mocks.aiDescribe).not.toHaveBeenCalled();
  });
});
