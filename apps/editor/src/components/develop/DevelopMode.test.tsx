// @vitest-environment jsdom
import { type DevelopSettings, emptyLibrary } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { assetDevelop, photoKey, useLibraryStore } from '../../store/library';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { expectContextMenuKeys } from '../ui/testing';
import { CopySettingsDialog } from './CopySettingsDialog';
import { clearDevelopClipboard } from './copyPaste';
import { COMMIT_IDLE_MS, resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  renderDevelopPreview: mocks.render,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

const IDS = ['f1', 'f2', 'f3'];

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

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const dialog = () => screen.getByRole('dialog');
const book = () => useBookStore.getState();
const develop = (id = 'f1') => book().book?.assets[id]?.develop;

function open(index = 0) {
  act(() => useUiStore.getState().openDevelop(IDS, index));
  return render(<DevelopMode />);
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.commit.mockReset();
  const doc = structuredClone(fixtureBook);
  for (const id of IDS) {
    const asset = doc.assets[id];
    if (asset) asset.hash = `hash-${id}`;
  }
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: files() });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  clearDevelopClipboard();
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('DevelopMode shell', () => {
  it('renders nothing until a session opens, then shows the photo and the seven cards in order', () => {
    const { container } = render(<DevelopMode />);
    expect(container.firstChild).toBeNull();
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    expect(dialog().getAttribute('aria-label')).toBe('Develop: f1.jpg');
    expect(within(dialog()).getByText('1 / 3')).toBeTruthy();
    const img = within(screen.getByTestId('develop-image')).getByRole('img', { name: 'f1.jpg' });
    expect(img.getAttribute('src')).toBe('asset://proxy/f1.jpg');
    // Plan 54: the seven cards in the order of operations.
    const panel = screen.getByTestId('develop-panel');
    expect(
      within(panel)
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Crop', 'Light', 'Color', 'Detail', 'Sharpen & denoise', 'Effects', 'Masks']);
    // Masks (step D4.1) start collapsed.
    expect(screen.queryByRole('button', { name: 'Create new mask' })).toBeNull();
    // Light is open; its Curve is a ▸ in Basic until opened.
    expect(screen.getByRole('slider', { name: 'Exposure' })).toBeTruthy();
    expect(screen.queryByTestId('curve-editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    expect(screen.getByTestId('curve-editor')).toBeTruthy();
  });

  it('steps with the arrow keys and keeps the panel open; the slider keeps its own arrows', () => {
    open();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useUiStore.getState().develop?.index).toBe(1);
    expect(dialog().getAttribute('aria-label')).toBe('Develop: f2.jpg');
    expect(screen.getByRole('slider', { name: 'Exposure' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useUiStore.getState().develop?.index).toBe(0);
    // Arrow keys on a slider nudge it and do not step.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Contrast' }), { key: 'ArrowRight' });
    expect(useUiStore.getState().develop?.index).toBe(0);
    expect(develop()?.light.contrast).toBe(1);
    // Typing in the value field keeps its keys too.
    fireEvent.click(screen.getByRole('button', { name: '+1' }));
    const input = screen.getByRole('textbox', { name: 'Contrast value' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUiStore.getState().develop).not.toBeNull();
  });

  it('closes on Escape and the Done button, and reveals the photo in the filmstrip', () => {
    open(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().develop).toBeNull();
    expect(useUiStore.getState().filmstrip.reveal).toBe('f2');
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    fireEvent.click(screen.getByRole('button', { name: /Done/ }));
    expect(useUiStore.getState().develop).toBeNull();
  });

  it('toggles Before / After on backslash', () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    fireEvent.keyDown(window, { key: '\\' });
    expect(useUiStore.getState().developBeforeAfter).toBe(true);
    expect(screen.getByRole('button', { name: /Before \/ After/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Original')).toBeTruthy();
    fireEvent.keyDown(window, { key: '\\' });
    expect(useUiStore.getState().developBeforeAfter).toBe(false);
  });

  it('splits before and after with the handle on the picture, view only (plan 46)', () => {
    open();
    expect(screen.queryByTestId('develop-split-handle')).toBeNull();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    useBookStore.temporal.getState().clear();
    const handle = screen.getByTestId('develop-split-handle');
    expect(screen.queryByTestId('develop-split-original')).toBeNull();
    // The picture box has no size in jsdom: a drag puts the split in the middle.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 5, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40 });
    const original = screen.getByTestId('develop-split-original');
    expect(original.getAttribute('src')).toBe('asset://proxy/f1.jpg');
    expect(original.style.clipPath).toBe('inset(0 50% 0 0)');
    expect(screen.getByText('Before')).toBeTruthy();
    // The keys move it and keep their arrows (no photo step).
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().develop?.index).toBe(0);
    expect(screen.getByTestId('develop-split-original').style.clipPath).toBe('inset(0 45% 0 0)');
    // Nothing reached the book or the undo history.
    expect(develop()?.light.exposure).toBe(1);
    expect(useBookStore.temporal.getState().pastStates.length).toBe(0);
    fireEvent.doubleClick(handle);
    expect(screen.queryByTestId('develop-split-original')).toBeNull();
    // A split belongs to its photo: stepping away and back closes it.
    fireEvent.keyDown(screen.getByTestId('develop-split-handle'), { key: 'ArrowRight' });
    expect(screen.getByTestId('develop-split-original')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useUiStore.getState().develop?.index).toBe(0);
    expect(screen.queryByTestId('develop-split-original')).toBeNull();
    // With a crop or a flip the uncropped original would not line up: no split.
    act(() => {
      book().setAssetDevelop('f1', { geometry: { flipH: true } });
    });
    expect(screen.queryByTestId('develop-split-handle')).toBeNull();
  });

  it('Before | After is a split button: Flip, Split, Side by side; Y cycles them, not from a text field (plan 54)', () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    useBookStore.temporal.getState().clear();
    // Y: side by side, the original left and the developed picture right.
    fireEvent.keyDown(window, { key: 'y' });
    expect(screen.queryByTestId('develop-image')).toBeNull();
    const before = screen.getByRole('img', { name: 'f1.jpg, before' });
    expect(before.getAttribute('src')).toBe('asset://proxy/f1.jpg');
    expect(within(screen.getByRole('region', { name: 'After' })).getByRole('img', { name: 'f1.jpg' })).toBeTruthy();
    // One viewport for both: a click zooms both to 1×, another back to fit.
    const sides = screen.getByTestId('develop-side-by-side');
    expect(sides.dataset.zoom).toBe('fit');
    fireEvent.mouseDown(before.parentElement as Element, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(window);
    expect(sides.dataset.zoom).toBe('1');
    // Y again: the split, at the middle.
    fireEvent.keyDown(window, { key: 'y' });
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    expect(screen.getByTestId('develop-split-original').style.clipPath).toBe('inset(0 50% 0 0)');
    // Then the flip, then off.
    fireEvent.keyDown(window, { key: 'y' });
    expect(useUiStore.getState().developBeforeAfter).toBe(true);
    expect(screen.queryByTestId('develop-split-original')).toBeNull();
    fireEvent.keyDown(window, { key: 'y' });
    expect(useUiStore.getState().developBeforeAfter).toBe(false);
    expect(screen.getByRole('button', { name: /^Before \/ After/ }).getAttribute('aria-pressed')).toBe('false');
    // The ▾ chooses a mode; Y and \\ in the open menu do nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Before and after modes' }));
    const side = screen.getByRole('menuitemcheckbox', { name: /^Side by side/ });
    for (const key of ['y', '\\']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      side.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(useUiStore.getState().developBeforeAfter).toBe(false);
    fireEvent.click(side);
    expect(screen.getByTestId('develop-side-by-side')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Before \/ After/ }).getAttribute('aria-pressed')).toBe('true');
    // The button's click is the flip (\\) from any mode, and the flip again turns it off.
    fireEvent.click(screen.getByRole('button', { name: /^Before \/ After/ }));
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    expect(useUiStore.getState().developBeforeAfter).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Before \/ After/ }));
    expect(useUiStore.getState().developBeforeAfter).toBe(false);
    // Side by side belongs to its photo: stepping away closes it, and so does Reset all.
    fireEvent.keyDown(window, { key: 'y' });
    expect(screen.getByTestId('develop-side-by-side')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    fireEvent.keyDown(window, { key: 'y' });
    expect(screen.getByTestId('develop-side-by-side')).toBeTruthy();
    act(() => book().resetAssetDevelop('f1'));
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    useBookStore.temporal.getState().clear();
    // Y in a text field types.
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'y' });
    expect(screen.queryByTestId('develop-side-by-side')).toBeNull();
    field.remove();
    // With a crop the split is skipped (the original would not line up); side by side still shows.
    act(() => {
      book().setAssetDevelop('f1', { geometry: { flipH: true } });
    });
    fireEvent.keyDown(window, { key: 'y' });
    expect(screen.getByTestId('develop-side-by-side')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'y' });
    expect(useUiStore.getState().developBeforeAfter).toBe(true);
    // View only: nothing reached the undo history but the flip edit.
    expect(useBookStore.temporal.getState().pastStates.length).toBe(1);
  });

  it('pulses the render dot in the header only while a preview takes longer than 300 ms (plan 46)', async () => {
    vi.useFakeTimers();
    try {
      let finish: (bytes: ArrayBuffer) => void = () => {};
      mocks.render.mockImplementation(
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            finish = resolve;
          }),
      );
      open();
      act(() => {
        book().setAssetDevelop('f1', { light: { exposure: 1 } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.queryByRole('status', { name: 'Rendering the preview' })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByRole('status', { name: 'Rendering the preview' })).toBeTruthy();
      await act(async () => {
        finish(jpeg());
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.queryByRole('status', { name: 'Rendering the preview' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('undoes a whole slider drag with Cmd+Z', () => {
    open();
    const track = screen.getByRole('slider', { name: 'Contrast' });
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 16, right: 200, bottom: 16 }) as DOMRect;
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0 });
    for (const x of [120, 140, 160, 180]) fireEvent.pointerMove(track, { pointerId: 1, clientX: x });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 180 });
    expect(develop()?.light.contrast).toBe(80);
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(develop()).toBeUndefined();
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    expect(develop()?.light.contrast).toBe(80);
  });

  it('copies and pastes settings between photos with Cmd+Shift+C / V', () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 0.5 }, color: { vibrance: 40 } });
    });
    // Plan 46: Paste is in the panel header's ⋯ menu.
    const paste = () => {
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const item = screen.getByRole('menuitem', { name: 'Paste' });
      fireEvent.keyDown(item, { key: 'Escape' });
      return item;
    };
    expect(paste().getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(window, { key: 'c', metaKey: true, shiftKey: true });
    expect(paste().getAttribute('aria-disabled')).toBeNull();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(develop('f2')).toBeUndefined();
    fireEvent.keyDown(window, { key: 'v', metaKey: true, shiftKey: true });
    expect(develop('f2')?.light.exposure).toBe(0.5);
    expect(develop('f2')?.color.vibrance).toBe(40);
    expect(develop('f3')).toBeUndefined();
  });

  it('the strip has a right-click menu (plan 45): Copy settings, Paste settings, Make a version', async () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 0.5 } });
    });
    const thumb = (name: string) => screen.getByRole('button', { name: `Develop ${name}` });
    expectContextMenuKeys(() => thumb('f2.jpg'), 'f2.jpg');
    fireEvent.contextMenu(thumb('f1.jpg'), { clientX: 10, clientY: 500 });
    const menu = screen.getByRole('menu', { name: 'f1.jpg' });
    expect(
      within(menu)
        .getByRole('menuitem', { name: /Paste settings/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Copy settings/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(thumb('f3.jpg'), { clientX: 10, clientY: 500 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Paste settings/ }));
    await waitFor(() => expect(develop('f3')?.light.exposure).toBe(0.5));
    fireEvent.contextMenu(thumb('f2.jpg'), { clientX: 10, clientY: 500 });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Make a version',
      'Copy settings⇧⌘C',
      'Paste settings⇧⌘V',
    ]);
  });
});

describe('DevelopMode copy and paste (workflow plan 10)', () => {
  const key = (init: KeyboardEventInit, target: Window | Element = window) => fireEvent.keyDown(target, init);

  it('Cmd+Shift+V pastes onto the strip selection in one undo step; Cmd+Alt+V pastes from the photo before', () => {
    open(1);
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 0.25 } });
      book().setAssetDevelop('f2', { color: { vibrance: 30 }, light: { exposure: 0.5 } });
    });
    key({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true });
    act(() => useUiStore.getState().setSelection(['f3', 'f1']));
    useBookStore.temporal.getState().clear();
    key({ key: 'V', code: 'KeyV', metaKey: true, shiftKey: true });
    expect(develop('f3')?.color.vibrance).toBe(30);
    expect(develop('f1')?.color.vibrance).toBe(30);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    undo();
    expect(develop('f3')).toBeUndefined();
    expect(develop('f1')?.light.exposure).toBe(0.25);

    // Alt+V types √ on a Mac: the key is matched by its code. The photo before f2 in the strip is f1.
    act(() => useUiStore.getState().clearSelection());
    key({ key: '√', code: 'KeyV', metaKey: true, altKey: true });
    expect(develop('f2')?.light.exposure).toBe(0.25);
    expect(develop('f2')?.color.vibrance).toBe(0);
  });

  it('Shift+Cmd+Alt+C opens Copy Settings; a remembered choice is what Cmd+Shift+C copies next', () => {
    act(() => useUiStore.getState().openDevelop(IDS, 0));
    render(
      <>
        <DevelopMode />
        <CopySettingsDialog />
      </>,
    );
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 }, color: { saturation: -40 } });
    });
    key({ key: 'Ç', code: 'KeyC', metaKey: true, shiftKey: true, altKey: true });
    const copyDialog = screen.getByRole('dialog', { name: /Copy settings from/ });
    // Everything but the crop, Transform and masks is on.
    const box = (name: RegExp) => within(copyDialog).getByRole('checkbox', { name }) as HTMLInputElement;
    expect([box(/^Basic/), box(/^AI denoise/), box(/^Crop/), box(/^Masks/)].map((b) => b.checked)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    fireEvent.click(within(copyDialog).getByRole('button', { name: 'Check none' }));
    expect((within(copyDialog).getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box(/^Color/));
    fireEvent.click(box(/^Masks/));
    expect(within(copyDialog).getByRole('note').textContent).toMatch(/same positions/);
    fireEvent.click(within(copyDialog).getByRole('button', { name: 'Copy' }));
    expect(screen.queryByRole('dialog', { name: /Copy settings from/ })).toBeNull();
    expect(useUiStore.getState().copySections).toEqual(['color', 'masks']);

    key({ key: 'ArrowRight' });
    key({ key: 'v', metaKey: true, shiftKey: true });
    expect(develop('f2')?.color.saturation).toBe(-40);
    expect(develop('f2')?.light.exposure).toBe(0);
    act(() => useUiStore.getState().setCopySections(['basic', 'curve', 'color', 'detail', 'denoise']));
  });

  it('leaves the copy and paste keys to a text field or an editable element', () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 0.5 } });
    });
    key({ key: 'c', metaKey: true, shiftKey: true });
    key({ key: 'ArrowRight' });
    // The canvas text editor is a plaintext contenteditable (jsdom does not compute `isContentEditable`).
    const editor = document.createElement('div');
    editor.contentEditable = 'plaintext-only';
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    document.body.append(editor);
    expect(key({ key: 'v', metaKey: true, shiftKey: true }, editor)).toBe(true);
    expect(key({ key: '√', code: 'KeyV', metaKey: true, altKey: true }, editor)).toBe(true);
    expect(develop('f2')).toBeUndefined();
    editor.remove();
  });
});

describe('DevelopMode panel', () => {
  it('writes slider changes to the book and resets sections and the whole photo', () => {
    open();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Highlights' }), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Exposure' }), { key: 'ArrowRight' });
    expect(develop()?.light).toMatchObject({ highlights: -10, exposure: 0.01 });
    expect(screen.getByText('Edited')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Light' }));
    expect(develop()).toBeUndefined();
    // Plan 46: Reset all is in the panel header's ⋯ menu.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Reset all' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Reset all' }), { key: 'Escape' });
    act(() => {
      book().setAssetDevelop('f1', { color: { saturation: 10 }, light: { whites: 5 } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Light' }));
    expect(develop()?.color.saturation).toBe(10);
    expect(develop()?.light.whites).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset all' }));
    expect(develop()).toBeUndefined();
  });

  it('white balance: dragging a slider switches to custom, As shot resets it', () => {
    open();
    expect(screen.getByRole('radio', { name: 'As shot' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Temperature' }), { key: 'ArrowRight', shiftKey: true });
    expect(develop()?.whiteBalance).toEqual({ mode: 'incremental', temperature: 10, tint: 0 });
    expect(screen.getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'As shot' }));
    expect(develop()).toBeUndefined();
  });

  it('colour mix: tabs pick the property, one slider per band', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Color mix' }));
    expect(screen.getAllByRole('slider').filter((s) => s.hasAttribute('data-band'))).toHaveLength(8);
    fireEvent.keyDown(document.querySelector('[data-band="blue"]') as Element, { key: 'ArrowRight', shiftKey: true });
    expect(develop()?.color.mix.blue.hue).toBe(10);
    fireEvent.click(screen.getByRole('tab', { name: 'Luminance' }));
    fireEvent.keyDown(document.querySelector('[data-band="blue"]') as Element, { key: 'ArrowLeft' });
    expect(develop()?.color.mix.blue).toEqual({ hue: 10, saturation: 0, luminance: -1 });
  });

  it('point curve: add, move, and remove a point on a channel', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    const svg = screen.getByTestId('curve-editor');
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
    // Click at (50%, 50%) of the box: input 0.5, output 0.5 -> a new point.
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 100, clientY: 60 });
    expect(develop()?.curve.luma).toEqual([
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ]);
    expect(screen.getByTestId('curve-point-2')).toBeTruthy();
    // The red channel is separate: just its two end points.
    fireEvent.click(screen.getByRole('tab', { name: /^R/ }));
    expect(screen.queryByTestId('curve-point-2')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Luma/ }));
    // Double-click removes the point; the ends stay.
    fireEvent.doubleClick(svg, { clientX: 100, clientY: 60 });
    expect(develop()).toBeUndefined();
  });

  it('curve presets: a chip writes its points into the channel shown, one undo step like a drawn curve (plan 54)', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    const presets = screen.getByRole('group', { name: 'Curve presets' });
    expect(
      within(presets)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Linear', 'Soft S', 'Strong S', 'Matte', 'Faded', 'Reverse S']);
    expect(within(presets).getByRole('button', { name: 'Linear' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(presets).getByRole('button', { name: 'Strong S' }));
    expect(develop()?.curve.luma).toEqual([
      [0, 0],
      [0.25, 0.16],
      [0.75, 0.84],
      [1, 1],
    ]);
    expect(within(presets).getByRole('button', { name: 'Strong S' }).getAttribute('aria-pressed')).toBe('true');
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    // The Curve ▸ is tagged once the panel shows Basic with it closed.
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    expect(screen.getByRole('button', { name: /^Curve/ }).textContent).toContain('·edited');
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    // On the red channel a chip writes the red points only.
    fireEvent.click(screen.getByRole('tab', { name: /^R/ }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Curve presets' })).getByRole('button', { name: 'Faded' }),
    );
    expect(develop()?.curve.red).toEqual([
      [0, 0.1],
      [0.5, 0.5],
      [1, 0.9],
    ]);
    expect(develop()?.curve.luma).toHaveLength(4);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(2);
    act(() => undo());
    expect(develop()?.curve.red).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('point curve: a drag is one undo step and the end point keeps x', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /^Curve/ }));
    const svg = screen.getByTestId('curve-editor');
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
    // Grab the end point at the top right and pull it down and left.
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 199, clientY: 2, button: 0 });
    for (const [x, y] of [
      [150, 50],
      [100, 100],
    ] as const) {
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: x, clientY: y });
    }
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(develop()?.curve.luma).toEqual([
      [0, 0],
      [1, 0.5],
    ]);
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
  });
});

describe('live preview', () => {
  const previewImg = () => screen.queryByTestId('develop-preview') as HTMLImageElement | null;

  it('does not render an unedited photo, and shows the blob over the proxy once edited', async () => {
    open();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(mocks.render).not.toHaveBeenCalled();
    expect(previewImg()).toBeNull();

    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(previewImg()?.getAttribute('src')).toBe('blob:preview-1'));
    const [folder, relPath, hash, settings, job] = mocks.render.mock.calls[0] as [
      string,
      string,
      string,
      DevelopSettings,
      number,
    ];
    expect([folder, relPath, hash]).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1']);
    expect(settings.light.exposure).toBe(1);
    expect(job).toBeGreaterThan(0);
    // The cached proxy stays underneath.
    expect(within(screen.getByTestId('develop-image')).getByRole('img', { name: 'f1.jpg' })).toBeTruthy();
    // Back to the defaults: the preview goes away and its blob is freed.
    act(() => {
      book().resetAssetDevelop('f1');
    });
    await waitFor(() => expect(previewImg()).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('numbers jobs, coalesces a drag, ignores superseded results and revokes the previous blob', async () => {
    const pending: Array<(v: ArrayBuffer | null) => void> = [];
    mocks.render.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
    // More edits while job 1 is in flight: they coalesce into a single newer job.
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 2 } });
      book().setAssetDevelop('f1', { light: { exposure: 3 } });
    });
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    const jobs = mocks.render.mock.calls.map((c) => c[4] as number);
    expect(jobs[1]).toBeGreaterThan(jobs[0] as number);
    const second = mocks.render.mock.calls[1] as unknown[];
    expect((second[3] as DevelopSettings).light.exposure).toBe(3);
    // The older job finishes late: dropped. A null (superseded in Rust) is dropped too.
    await act(async () => {
      pending[0]?.(jpeg());
    });
    expect(previewImg()).toBeNull();
    await act(async () => {
      pending[1]?.(jpeg());
    });
    // Only the newest result became a blob.
    await waitFor(() => expect(previewImg()?.getAttribute('src')).toBe('blob:preview-1'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // The next render replaces it and frees the old one.
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 4 } });
    });
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(3));
    await act(async () => {
      pending[2]?.(jpeg());
    });
    await waitFor(() => expect(previewImg()?.getAttribute('src')).toBe('blob:preview-2'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
  });

  it('keeps the cached proxy and logs once when the command is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.render.mockRejectedValue('command render_develop_preview not found');
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(screen.getByText('Live preview unavailable')).toBeTruthy());
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 2 } });
    });
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('live preview unavailable'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[photobook:develop]');
    expect(previewImg()).toBeNull();
    expect(within(screen.getByTestId('develop-image')).getByRole('img', { name: 'f1.jpg' })).toBeTruthy();
    log.mockRestore();
  });

  it('logs render timings in the agreed format', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(previewImg()).not.toBeNull());
    expect(log.mock.calls.some((c) => /^\[photobook:develop\] preview \d+ms job \d+$/.test(String(c[0])))).toBe(true);
    log.mockRestore();
  });

  it('shows the preview only for the photo it was rendered for', async () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(previewImg()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(previewImg()).toBeNull();
  });
});

describe('committing edits', () => {
  it('commits 300 ms after the last change, once per burst', async () => {
    open();
    expect(mocks.commit).not.toHaveBeenCalled();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
      book().setAssetDevelop('f1', { light: { exposure: 2 } });
    });
    expect(mocks.commit).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1), { timeout: COMMIT_IDLE_MS * 4 });
    expect(mocks.commit).toHaveBeenCalledWith('f1');
    await act(async () => {
      await new Promise((r) => setTimeout(r, COMMIT_IDLE_MS + 100));
    });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it('commits right after a pointer is released', async () => {
    open();
    const track = screen.getByRole('slider', { name: 'Contrast' });
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 16, right: 200, bottom: 16 }) as DOMRect;
    fireEvent.pointerDown(track, { pointerId: 1, clientX: 100, button: 0 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 150 });
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith('f1'), { timeout: 200 });
  });

  it('commits a pending change when stepping to another photo, and never for an untouched one', async () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledWith('f1'));
    mocks.commit.mockClear();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, COMMIT_IDLE_MS + 100));
    });
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('commits an undo too', async () => {
    open();
    act(() => {
      book().setAssetDevelop('f1', { light: { exposure: 1 } });
    });
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1), { timeout: COMMIT_IDLE_MS * 4 });
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(2), { timeout: COMMIT_IDLE_MS * 4 });
  });
});

describe('DevelopMode in the Develop stage (library keys, no project)', () => {
  const key = photoKey({ folder: 'F1', path: 'a.jpg' });
  beforeEach(() => {
    useBookStore.setState({ book: null, folder: null, libraries: { '/trip': emptyLibrary() } });
    useBookStore.temporal.getState().clear();
    useLibraryStore.setState({
      folders: {
        F1: {
          id: 'F1',
          path: '/trip',
          photos: {
            'a.jpg': {
              relPath: 'a.jpg',
              size: 1,
              mtime: 1,
              kind: 'jpeg',
              hash: 'ha',
              width: 1200,
              height: 800,
              status: 'ready',
              proxyUrl: 'asset://proxy/a.jpg',
              thumbUrl: 'asset://thumb/a.jpg',
            },
          },
          progress: { hashed: 1, prepared: 1, total: 1 },
          busy: false,
          error: null,
          scanned: true,
        },
      },
    });
  });
  afterEach(() => {
    useLibraryStore.getState().reset();
  });

  it('edits the master in the folder library, undoes it, and has no Done button', () => {
    act(() => useUiStore.getState().openDevelop([key], 0));
    render(<DevelopMode inline />);
    const region = screen.getByRole('region', { name: 'Develop: a.jpg' });
    expect(within(region).queryByRole('button', { name: /Done/ })).toBeNull();
    expect(within(region).getByText('1200 × 800')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Exposure' }), { key: 'ArrowRight' });
    expect(book().libraries['/trip']?.photos.ha?.develop?.light.exposure).toBe(0.01);
    expect(assetDevelop(book(), key)?.light.exposure).toBe(0.01);
    // Escape leaves the stage open.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().develop).not.toBeNull();
    act(() => {
      undo();
    });
    expect(book().libraries['/trip']?.photos.ha).toBeUndefined();
  });
});
