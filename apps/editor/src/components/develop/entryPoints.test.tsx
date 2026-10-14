// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { useEditorShortcuts } from '../editor/useEditorShortcuts';
import { openDevelop } from '../filmstrip/visible';
import { ReviewMode } from '../review/ReviewMode';

function file(id: string, mtime: number, extra: Partial<AssetFile> = {}): AssetFile {
  return { relPath: `fixture/${id}.jpg`, assetId: id, size: 1, mtime, kind: 'jpeg', status: 'ready', ...extra };
}

function Shell() {
  useEditorShortcuts();
  return (
    <>
      <div data-asset-id="f2" data-status="ready" data-testid="cell-f2" />
      <div data-asset-id="f9" data-status="missing" data-testid="cell-missing" />
      <input data-testid="field" />
      <ReviewMode />
    </>
  );
}

const ui = () => useUiStore.getState();

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useAssetsStore.setState({
    files: {
      'fixture/f1.jpg': file('f1', 1),
      'fixture/f2.jpg': file('f2', 2),
      'fixture/f3.jpg': file('f3', 3),
      'fixture/bad.jpg': file('bad', 4, { status: 'error' }),
    },
  });
  useUiStore.setState({ develop: null, review: null, filmstrip: DEFAULT_FILMSTRIP, selectedElementId: null });
});

afterEach(async () => {
  cleanup();
  useUiStore.getState().reset();
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('openDevelop', () => {
  it('steps through the filmstrip order, starting at the photo', () => {
    expect(openDevelop('f2')).toBe(true);
    expect(ui().develop).toEqual({ ids: ['f1', 'f2', 'f3'], index: 1 });
  });

  it('follows the filmstrip sort and filters, like review', () => {
    useUiStore.setState({ filmstrip: { ...DEFAULT_FILMSTRIP, sort: 'name', query: 'f' } });
    openDevelop('f3');
    expect(ui().develop).toEqual({ ids: ['f1', 'f2', 'f3'], index: 2 });
  });

  it('leaves rejects out at All flags, except the photo it opens on (plan 08)', () => {
    useBookStore.setState((s) => {
      const f2 = s.book?.assets.f2;
      if (f2) f2.flag = 'reject';
    });
    openDevelop('f1');
    expect(ui().develop).toEqual({ ids: ['f1', 'f3'], index: 0 });
    openDevelop('f2');
    expect(ui().develop).toEqual({ ids: ['f1', 'f2', 'f3'], index: 1 });
    useUiStore.setState({ filmstrip: { ...DEFAULT_FILMSTRIP, flag: 'rejects' } });
    openDevelop('f2');
    expect(ui().develop).toEqual({ ids: ['f2'], index: 0 });
  });

  it('opens a photo the filmstrip filtered out on its own, and refuses missing or unreadable ones', () => {
    useUiStore.setState({ filmstrip: { ...DEFAULT_FILMSTRIP, query: 'f1' } });
    expect(openDevelop('f3')).toBe(true);
    expect(ui().develop).toEqual({ ids: ['f3'], index: 0 });
    expect(openDevelop('bad')).toBe(false);
    expect(openDevelop('nope')).toBe(false);
    expect(ui().develop?.ids).toEqual(['f3']);
  });
});

describe('D shortcut', () => {
  it('opens Develop on the focused filmstrip photo', () => {
    render(<Shell />);
    const cell = screen.getByTestId('cell-f2');
    cell.focus();
    fireEvent.keyDown(cell, { key: 'd' });
    expect(ui().develop).toEqual({ ids: ['f1', 'f2', 'f3'], index: 1 });
  });

  it('opens Develop on the photo of the selected slot', () => {
    render(<Shell />);
    const slot = fixtureBook.pages[0]?.elements.find((e) => e.type === 'photo' && e.asset !== null);
    if (slot?.type !== 'photo') throw new Error('fixture has no photo');
    act(() => ui().select(slot.id));
    fireEvent.keyDown(window, { key: 'D' });
    expect(ui().develop?.ids[ui().develop?.index ?? 0]).toBe(slot.asset);
  });

  it('does nothing with no target, in a text field, with modifiers, or on a missing photo', () => {
    render(<Shell />);
    fireEvent.keyDown(window, { key: 'd' });
    expect(ui().develop).toBeNull();
    const field = screen.getByTestId('field');
    fireEvent.keyDown(field, { key: 'd' });
    const cell = screen.getByTestId('cell-f2');
    fireEvent.keyDown(cell, { key: 'd', shiftKey: true });
    fireEvent.keyDown(cell, { key: 'd', altKey: true });
    fireEvent.keyDown(screen.getByTestId('cell-missing'), { key: 'd' });
    expect(ui().develop).toBeNull();
  });

  it('leaves the keys to the Develop view while it is open', () => {
    render(<Shell />);
    act(() => ui().openDevelop(['f1', 'f2'], 0));
    fireEvent.keyDown(screen.getByTestId('cell-f2'), { key: 'd' });
    expect(ui().develop).toEqual({ ids: ['f1', 'f2'], index: 0 });
  });
});

describe('Review', () => {
  it('D closes review and opens Develop on the same list and index', () => {
    render(<Shell />);
    act(() => ui().openReview(['f3', 'f1', 'f2'], 1));
    fireEvent.keyDown(window, { key: 'd' });
    expect(ui().review).toBeNull();
    expect(ui().develop).toEqual({ ids: ['f3', 'f1', 'f2'], index: 1 });
  });
});
