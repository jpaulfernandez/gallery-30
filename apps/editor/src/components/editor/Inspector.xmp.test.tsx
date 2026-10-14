// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { Inspector } from './Inspector';

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useUiStore.setState({ xmpImportDialog: null, pageIndex: 0, selectedElementId: null, selectedElementIds: [] });
});

afterEach(async () => {
  cleanup();
  useUiStore.getState().reset();
  await useBookStore.getState().close();
});

describe('Inspector photo section', () => {
  it('Import Lightroom settings… opens the import dialog for the slot’s photo', () => {
    const page = useBookStore.getState().book?.pages[0];
    const slot = page?.elements.find((e) => e.type === 'photo' && e.asset !== null);
    if (slot?.type !== 'photo') throw new Error('fixture has no filled photo slot on page 1');
    act(() => useUiStore.getState().select(slot.id));
    render(<Inspector />);
    fireEvent.click(screen.getByRole('button', { name: 'Import Lightroom settings…' }));
    expect(useUiStore.getState().xmpImportDialog).toEqual({ assetIds: [slot.asset] });
  });

  it('has no import button for an empty slot', () => {
    let slotId = '';
    useBookStore.setState((s) => {
      const slot = s.book?.pages[0]?.elements.find((e) => e.type === 'photo');
      if (slot?.type !== 'photo') throw new Error('fixture has no photo slot on page 1');
      slot.asset = null;
      slotId = slot.id;
    });
    act(() => useUiStore.getState().select(slotId));
    render(<Inspector />);
    expect(screen.getByText(/Empty slot/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import Lightroom settings…' })).toBeNull();
  });
});
