// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const added = vi.hoisted(() => ({ calls: [] as string[][], fail: false }));

vi.mock('../store/assets', async (original) => ({
  ...(await original<typeof import('../store/assets')>()),
  addToProject: vi.fn(async (keys: readonly string[]) => {
    added.calls.push([...keys]);
    if (added.fail) throw new Error('That folder is no longer imported');
    return keys.map((_, i) => `A${i}`);
  }),
}));

const { AddSelectedButton } = await import('./library');
const { EMPTY_SELECTION, useUiStore } = await import('../store/ui');

beforeEach(() => {
  added.calls = [];
  added.fail = false;
  useUiStore.getState().setSelection(['F1/a.jpg', 'F1/c.jpg']);
});
afterEach(() => {
  cleanup();
  useUiStore.setState({ selection: EMPTY_SELECTION, saveStatus: 'saved', saveError: null });
});

describe('Add N to project', () => {
  it('adds the selected photos to the open project', async () => {
    render(<AddSelectedButton count={2} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add 2 to project' }));
    });
    expect(added.calls).toEqual([['F1/a.jpg', 'F1/c.jpg']]);
    expect(screen.getByRole('button', { name: 'Add 2 to project' })).toBeTruthy();
  });

  it('shows why when they cannot be added', async () => {
    added.fail = true;
    render(<AddSelectedButton count={2} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add 2 to project' }));
    });
    expect(useUiStore.getState()).toMatchObject({ saveStatus: 'error', saveError: expect.stringMatching(/no longer/) });
  });
});
