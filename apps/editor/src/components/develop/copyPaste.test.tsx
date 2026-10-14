// @vitest-environment jsdom

import { createDevelop } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVELOP_CLIP_TYPE, encode } from '../../lib/develop/clipboard';
import { undo, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

/** The system clipboard: text only, as the plugin offers it. */
const system = vi.hoisted(() => ({ text: '' as string | null, tauri: true }));

vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  isTauri: () => system.tauri,
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(async (text: string) => {
    system.text = text;
  }),
  readText: vi.fn(async () => {
    if (system.text === null) throw new Error('The clipboard contents were not available');
    return system.text;
  }),
}));

import { BatchBar } from './BatchBar';
import {
  clearDevelopClipboard,
  copySettings,
  developClip,
  PasteNotice,
  pastePrevious,
  pasteSettings,
  useCanPaste,
} from './copyPaste';

const book = () => useBookStore.getState();
const develop = (id: string) => book().book?.assets[id]?.develop;
const history = () => useBookStore.temporal.getState();

beforeEach(() => {
  system.text = '';
  system.tauri = true;
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  history().clear();
  useUiStore.setState({ copySections: ['basic', 'curve', 'color', 'detail', 'denoise'] });
  clearDevelopClipboard();
});
afterEach(async () => {
  cleanup();
  await book().close();
});

describe('copy and paste through the system clipboard', () => {
  it('copy writes the payload as text; after a restart (memory empty) paste reads it back', async () => {
    book().setAssetDevelop('f1', { light: { exposure: 0.8 }, geometry: { flipV: true } });
    expect(copySettings('f1')).toBe(true);
    await vi.waitFor(() => expect(system.text).toContain(DEVELOP_CLIP_TYPE));
    const written = JSON.parse(system.text ?? '');
    expect(written.sections).toEqual(['basic', 'curve', 'color', 'detail', 'denoise']);
    expect(written.settings.light.exposure).toBe(0.8);

    // Quit and start again: the memory copy is gone, the system clipboard is not.
    clearDevelopClipboard();
    expect(developClip()).toBeNull();
    history().clear();
    expect(await pasteSettings(['f2', 'f3'])).toBe(2);
    expect(develop('f2')?.light.exposure).toBe(0.8);
    expect(develop('f3')?.geometry.flipV ?? false).toBe(false);
    expect(history().pastStates).toHaveLength(1);
    expect(developClip()?.settings.light.exposure).toBe(0.8);
    undo();
    expect(develop('f2')).toBeUndefined();
    expect(develop('f3')).toBeUndefined();
  });

  it('a copy in memory pastes at once, before the promise settles', () => {
    book().setAssetDevelop('f1', { color: { vibrance: 25 } });
    copySettings('f1', ['color']);
    void pasteSettings(['f2']);
    expect(develop('f2')?.color.vibrance).toBe(25);
  });

  it('foreign text or an empty clipboard pastes nothing, and Paste turns off until the window is focused again', async () => {
    const probe: { can: boolean } = { can: false };
    function Probe() {
      probe.can = useCanPaste();
      return null;
    }
    render(<Probe />);
    expect(probe.can).toBe(true);
    for (const text of ['hello', '{"settings": {}}', null]) {
      system.text = text;
      clearDevelopClipboard();
      expect(await pasteSettings(['f2'])).toBe(0);
    }
    expect(develop('f2')).toBeUndefined();
    expect(probe.can).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(probe.can).toBe(true);
  });

  it('outside the app nothing is read and Paste waits for a copy', async () => {
    system.tauri = false;
    system.text = 'should not be read';
    let can = true;
    function Probe() {
      can = useCanPaste();
      return null;
    }
    render(<Probe />);
    expect(can).toBe(false);
    expect(await pasteSettings(['f2'])).toBe(0);
    act(() => {
      copySettings('f1');
    });
    expect(can).toBe(true);
    expect(system.text).toBe('should not be read');
  });

  it('paste from previous uses the remembered sections of the photo before, and leaves the clipboard alone', () => {
    book().setAssetDevelop('f1', { light: { exposure: 1 }, curve: { parametric: { lights: 10 } } });
    useUiStore.setState({ copySections: ['curve'] });
    history().clear();
    expect(pastePrevious(['f1', 'f2', 'f3'], 'f2', ['f2', 'f3', 'f1'])).toBe(2);
    expect(history().pastStates).toHaveLength(1);
    expect(develop('f3')?.curve.parametric.lights).toBe(10);
    expect(develop('f3')?.light.exposure).toBe(0);
    expect(developClip()).toBeNull();
    expect(pastePrevious(['f1', 'f2'], 'f1', ['f1'])).toBe(0);
  });
});

describe('paste notice', () => {
  it('says so when the clipboard holds settings this build cannot read, and clears on the next copy', async () => {
    render(<PasteNotice />);
    const payload = JSON.parse(encode(createDevelop(), ['basic']));
    system.text = JSON.stringify({ ...payload, version: 2 });
    expect(await pasteSettings(['f2'])).toBe(0);
    expect(screen.getByRole('status').textContent).toMatch(/another version of Photobook/);
    act(() => {
      copySettings('f1');
    });
    expect(screen.queryByRole('status')).toBeNull();
    // Other text says nothing.
    clearDevelopClipboard();
    system.text = 'hello';
    expect(await pasteSettings(['f2'])).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('batch bar Paste slot', () => {
  it('pastes onto the selection in one undo step, and is not offered with nothing selected', () => {
    system.tauri = false;
    book().setAssetDevelop('f1', { light: { exposure: -0.5 } });
    // Plan 54: with nothing selected the pill holds only Apply to all in the strip.
    const { rerender } = render(<BatchBar ids={[]} current="f1" all={['f1', 'f2', 'f3']} />);
    const button = () => screen.getByRole('button', { name: 'Paste to selected' }) as HTMLButtonElement;
    expect(screen.queryByRole('button', { name: 'Paste to selected' })).toBeNull();
    act(() => {
      copySettings('f1');
    });
    rerender(<BatchBar ids={['f2']} current="f1" />);
    expect(button().disabled).toBe(false);
    rerender(<BatchBar ids={['f2', 'f3']} current="f1" />);
    expect(button().disabled).toBe(false);
    history().clear();
    fireEvent.click(button());
    expect(develop('f2')?.light.exposure).toBe(-0.5);
    expect(develop('f3')?.light.exposure).toBe(-0.5);
    expect(history().pastStates).toHaveLength(1);
    // After Sync (10) and Reset (20).
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels.indexOf('Paste to selected')).toBeGreaterThan(labels.indexOf('Reset edits'));
  });
});
