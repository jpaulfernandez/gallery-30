// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_LOOKS } from '../../lib/develop/looks';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { type Job, useJobsStore } from '../../store/jobs';
import { assetDevelop } from '../../store/library';
import { applyLookTo } from '../../store/looks';
import { DEFAULT_FILMSTRIP, EMPTY_SELECTION, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn(), listPresets: vi.fn() }));

vi.mock('../../lib/tauri', () => ({ renderDevelopPreview: mocks.render, listPresets: mocks.listPresets }));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { BatchButton } from './BatchBar';
import { registerBatchSlot } from './batchSlots';
import { DevelopMode } from './DevelopMode';
import { SyncDialog } from './SyncDialog';

const IDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];

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

const book = () => useBookStore.getState();
const ui = () => useUiStore.getState();
const cell = (id: string) => screen.getByRole('button', { name: `Develop ${id}.jpg` });
const bar = () => screen.getByRole('toolbar', { name: 'Batch actions' });
const history = () => useBookStore.temporal.getState().pastStates.length;

function open(index = 0) {
  act(() => ui().openDevelop(IDS, index));
  return render(
    <>
      <DevelopMode />
      <SyncDialog />
    </>,
  );
}

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.commit.mockReset();
  mocks.listPresets.mockReset();
  mocks.listPresets.mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, syncDialog: null, filmstrip: DEFAULT_FILMSTRIP, selection: EMPTY_SELECTION });
});

afterEach(async () => {
  cleanup();
  act(() => ui().closeDevelop());
  await book().close();
  useAssetsStore.setState({ files: {} });
});

describe('Develop strip', () => {
  it('shows the selection; Cmd-click and Shift-click edit it without changing the photo shown', () => {
    open(1);
    expect(within(bar()).getByRole('status').textContent).toBe('Select photos in the strip to apply to several');
    fireEvent.click(cell('f4'), { metaKey: true });
    expect(ui().selection.keys).toEqual(['f4']);
    expect(ui().develop?.index).toBe(1);
    expect(cell('f4').dataset.selected).toBe('true');
    // Shift extends from the anchor (the last Cmd-click).
    fireEvent.click(cell('f6'), { shiftKey: true });
    expect(ui().selection.keys).toEqual(['f4', 'f5', 'f6']);
    expect(ui().develop?.index).toBe(1);
    expect(within(bar()).getByText('3 selected')).toBeTruthy();
    // Cmd-click again takes one out.
    fireEvent.click(cell('f5'), { ctrlKey: true });
    expect(ui().selection.keys).toEqual(['f4', 'f6']);
    expect(cell('f5').dataset.selected).toBeUndefined();
    // A plain click shows the photo and leaves the selection.
    fireEvent.click(cell('f3'));
    expect(ui().develop?.index).toBe(2);
    expect(ui().selection.keys).toEqual(['f4', 'f6']);
    fireEvent.click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(ui().selection.keys).toEqual([]);
  });

  it('Shift-click with no anchor selects from the photo shown', () => {
    open(2);
    fireEvent.click(cell('f1'), { shiftKey: true });
    expect(ui().selection.keys).toEqual(['f3', 'f2', 'f1']);
    expect(ui().develop?.index).toBe(2);
  });

  it('leaves out a selected photo the strip does not list', () => {
    act(() => ui().setSelection(['f2', 'elsewhere']));
    open();
    expect(within(bar()).getByText('1 selected')).toBeTruthy();
  });
});

describe('Apply to all ▾ (plan 54)', () => {
  const choose = (trigger: string, item: RegExp) => {
    fireEvent.click(within(bar()).getByRole('button', { name: trigger }));
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
  };

  it('Apply Light & Color copies the Light and Color cards to every other photo of the strip, one undo step', () => {
    open();
    act(() =>
      book().setAssetDevelop('f1', {
        light: { exposure: 0.5 },
        curve: {
          luma: [
            [0, 0.1],
            [1, 1],
          ],
        },
        whiteBalance: { mode: 'incremental', temperature: 12, tint: 0 },
        color: { vibrance: 20 },
        detail: { clarity: 40 },
      }),
    );
    useBookStore.temporal.getState().clear();
    choose('Apply to all in the strip', /^Apply Light & Color to all 7/);
    for (const id of IDS.slice(1)) {
      const d = assetDevelop(book(), id);
      expect(d?.light.exposure).toBe(0.5);
      expect(d?.curve.luma).toEqual([
        [0, 0.1],
        [1, 1],
      ]);
      expect(d?.whiteBalance).toEqual({ mode: 'incremental', temperature: 12, tint: 0 });
      expect(d?.color.vibrance).toBe(20);
      // Detail is not Light & Color.
      expect(d?.detail.clarity).toBe(0);
    }
    expect(history()).toBe(1);
    act(() => undo());
    expect(assetDevelop(book(), 'f8')).toBeUndefined();
  });

  it('acts on the selection when there is one; Apply these sections… opens the Sync dialog', async () => {
    open();
    act(() => book().setAssetDevelop('f1', { light: { exposure: 0.5 } }));
    act(() => ui().setSelection(['f1', 'f3', 'f5']));
    choose('Apply to all', /^Apply Light & Color to all 2/);
    expect(assetDevelop(book(), 'f3')?.light.exposure).toBe(0.5);
    expect(assetDevelop(book(), 'f4')).toBeUndefined();
    choose('Apply to all', /^Apply these sections…/);
    expect(ui().syncDialog).toEqual({ sourceId: 'f1', targets: ['f3', 'f5'] });
    expect(await screen.findByRole('dialog', { name: 'Sync settings from f1.jpg' })).toBeTruthy();
  });

  it("Apply look to all applies this photo's look at its Amount, and is off without a look", () => {
    open();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Apply to all in the strip' }));
    expect(screen.getByRole('menuitem', { name: /^Apply look to all/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /^Apply look to all/ }), { key: 'Escape' });
    const look = BUILT_IN_LOOKS[0];
    if (!look) throw new Error('no built-in look');
    act(() => {
      applyLookTo(['f1'], look.id, 60);
    });
    useBookStore.temporal.getState().clear();
    choose('Apply to all in the strip', /^Apply look to all 7/);
    expect(assetDevelop(book(), 'f8')?.look.applied).toEqual({ presetId: look.id, amount: 60 });
    expect(history()).toBe(1);
  });
});

describe('Batch bar pill (plan 46)', () => {
  const job = (id: string, ref: string, state: Job['state']): Job => ({
    id,
    kind: 'render',
    label: `${ref}.jpg`,
    ref,
    done: 0,
    total: 1,
    state,
    queuedAt: 1,
    startedAt: null,
  });

  it('without a selection holds only Apply to all in the strip (plan 54); with one, every action', () => {
    open();
    expect(bar().hasAttribute('inert')).toBe(false);
    expect(
      within(bar())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['Apply to all in the strip']);
    fireEvent.click(cell('f2'), { metaKey: true });
    expect(bar().dataset.shown).toBe('true');
    const names = within(bar())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    // Apply to all ▾ is the first action.
    expect(names.slice(0, 3)).toEqual(['Clear', 'Apply to all', 'Sync selected…']);
  });

  it('is out of the way when the strip holds one photo and nothing is selected', () => {
    act(() => ui().openDevelop(['f1'], 0));
    render(<DevelopMode />);
    expect(bar().hasAttribute('inert')).toBe(true);
    expect(bar().dataset.shown).toBeUndefined();
  });

  it('counts the jobs of the selected photos while they run ("1 of 3")', () => {
    act(() => ui().setSelection(['f1', 'f2', 'f3']));
    open();
    expect(within(bar()).getByRole('status').textContent).toBe('3 selected');
    act(() =>
      useJobsStore.setState({
        jobs: { a: job('a', 'f1', 'running'), b: job('b', 'f2', 'queued'), c: job('c', 'f3', 'queued') },
      }),
    );
    expect(within(bar()).getByRole('status').textContent).toBe('3 selected0 of 3');
    act(() => useJobsStore.setState((s) => ({ jobs: { ...s.jobs, a: job('a', 'f1', 'done') } })));
    expect(within(bar()).getByRole('status').textContent).toBe('3 selected1 of 3');
    act(() =>
      useJobsStore.setState((s) => ({
        jobs: { ...s.jobs, b: job('b', 'f2', 'done'), c: job('c', 'f3', 'failed') },
      })),
    );
    expect(within(bar()).getByRole('status').textContent).toBe('3 selected');
    act(() => useJobsStore.setState({ jobs: {} }));
  });
});

describe('Batch bar', () => {
  it('Reset edits resets every selected photo as one undo step', () => {
    for (const id of ['f2', 'f3', 'f4']) act(() => book().setAssetDevelop(id, { light: { exposure: 1 } }));
    open();
    act(() => ui().setSelection(['f2', 'f3']));
    const before = history();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Reset edits' }));
    expect(assetDevelop(book(), 'f2')).toBeUndefined();
    expect(assetDevelop(book(), 'f3')).toBeUndefined();
    expect(assetDevelop(book(), 'f4')?.light.exposure).toBe(1);
    expect(history()).toBe(before + 1);
    act(() => {
      undo();
    });
    expect(assetDevelop(book(), 'f2')?.light.exposure).toBe(1);
    expect(assetDevelop(book(), 'f3')?.light.exposure).toBe(1);
  });

  it('asks first when it would reset more than five photos, and is off when none is edited', () => {
    open();
    act(() => ui().setSelection(['f2', 'f3']));
    expect((within(bar()).getByRole('button', { name: 'Reset edits' }) as HTMLButtonElement).disabled).toBe(true);
    const six = ['f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    for (const id of six) act(() => book().setAssetDevelop(id, { color: { saturation: 10 } }));
    act(() => ui().setSelection(six));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Reset edits' }));
    expect(assetDevelop(book(), 'f2')).toBeDefined();
    expect(within(bar()).getByText('Reset edits of 6 photos?')).toBeTruthy();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Cancel' }));
    expect(assetDevelop(book(), 'f2')).toBeDefined();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Reset edits' }));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Reset' }));
    for (const id of six) expect(assetDevelop(book(), id)).toBeUndefined();
  });

  it('Sync selected… opens the Sync dialog from the photo shown with the selection checked', async () => {
    open();
    act(() => ui().setSelection(['f1', 'f3', 'f5']));
    fireEvent.click(within(bar()).getByRole('button', { name: 'Sync selected…' }));
    expect(ui().syncDialog).toEqual({ sourceId: 'f1', targets: ['f3', 'f5'] });
    const dialog = await screen.findByRole('dialog', { name: 'Sync settings from f1.jpg' });
    const pressed = within(dialog)
      .getAllByRole('button', { pressed: true })
      .map((b) => b.getAttribute('aria-label'));
    expect(pressed).toEqual(['f3.jpg', 'f5.jpg']);
    expect(within(dialog).getByText('2 selected')).toBeTruthy();
  });

  it('renders registered slots with the selection and the photo shown, in order', () => {
    const seen: string[][] = [];
    const off = registerBatchSlot({
      id: 'test-slot',
      order: 99,
      render: ({ ids, current }) => {
        seen.push([current, ...ids]);
        return <BatchButton disabled={ids.length === 0}>Test action</BatchButton>;
      },
    });
    try {
      open();
      act(() => ui().setSelection(['f2']));
      const names = within(bar())
        .getAllByRole('button')
        .map((b) => b.textContent);
      // Built-ins first (Sync 10, Reset 20), then other features' slots by order; this one is last.
      expect(names.indexOf('Sync selected…')).toBeLessThan(names.indexOf('Reset edits'));
      expect(names.at(-1)).toBe('Test action');
      expect(seen.at(-1)).toEqual(['f1', 'f2']);
    } finally {
      act(() => off());
    }
    expect(within(bar()).queryByRole('button', { name: 'Test action' })).toBeNull();
  });
});
