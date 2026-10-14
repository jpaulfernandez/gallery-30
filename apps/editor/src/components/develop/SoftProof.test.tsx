// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn() }));
vi.mock('../../lib/tauri', () => ({ renderDevelopPreview: mocks.render }));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

const file: AssetFile = {
  relPath: 'fixture/f1.jpg',
  assetId: 'f1',
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: 'hash-f1',
  status: 'ready',
  proxyUrl: 'asset://proxy/f1.jpg',
  thumbUrl: 'asset://thumb/f1.jpg',
};

/** The output profile of each preview render so far (the 7th argument). */
const profiles = () => mocks.render.mock.calls.map((c) => c[6]);
const proofButton = () => screen.getByRole('button', { name: /^Proof:/ });

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${++n}`);
  URL.revokeObjectURL = vi.fn();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  const doc = structuredClone(fixtureBook);
  const asset = doc.assets.f1;
  if (asset) asset.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useAssetsStore.setState({ files: { [file.relPath]: file } });
  useUiStore.setState({ develop: null, developBeforeAfter: false, filmstrip: DEFAULT_FILMSTRIP });
  resetPreviewWarnings();
});

afterEach(() => {
  cleanup();
});

describe('soft proof', () => {
  it("renders in the book's profile and switches to the other one with the button or S", async () => {
    act(() => useBookStore.getState().setOutputProfile('display-p3'));
    act(() => useUiStore.getState().openDevelop(['f1'], 0));
    render(<DevelopMode />);
    // Unedited: nothing to proof (the original is published as is).
    expect((proofButton() as HTMLButtonElement).disabled).toBe(true);
    act(() => useBookStore.getState().setAssetDevelop('f1', { light: { exposure: 1 } }));
    await waitFor(() => expect(profiles()).toEqual(['display-p3']));
    expect(proofButton().textContent).toContain('Display P3');
    expect(proofButton().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(proofButton());
    await waitFor(() => expect(profiles()).toEqual(['display-p3', 'srgb']));
    expect(proofButton().textContent).toContain('sRGB');
    expect(proofButton().getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(profiles()).toEqual(['display-p3', 'srgb', 'display-p3']));
    expect(proofButton().getAttribute('aria-pressed')).toBe('false');
    // Cmd+S is not the proof key.
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(profiles()).toHaveLength(3);
  });
});
