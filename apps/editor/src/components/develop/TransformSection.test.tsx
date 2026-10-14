// @vitest-environment jsdom
import { createDevelop, type UprightGuide } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_FILMSTRIP, DEFAULT_UI_PREFS, useUiStore } from '../../store/ui';

const mocks = vi.hoisted(() => ({ render: vi.fn(), commit: vi.fn(), solve: vi.fn(), analyse: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
  solveUprightGuides: mocks.solve,
  analyseGeometry: mocks.analyse,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';
import { resetPreviewWarnings } from './usePreview';

const UPRIGHT = [1.05, 0.02, -0.03, 0.01, 1.1, -0.04, 0.02, 0.09, 1];
const GUIDES: UprightGuide[] = [
  { id: 'g1', kind: 'vertical', from: [0.3, 0.1], to: [0.26, 0.9] },
  { id: 'g2', kind: 'vertical', from: [0.7, 0.1], to: [0.74, 0.9] },
];
const geometry = () => useBookStore.getState().book?.assets.f1?.develop?.geometry ?? createDevelop().geometry;

function openSection() {
  act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
  render(<DevelopMode />);
  // Plan 54: the Crop card, then its ▸ Upright & transform (Basic is the default).
  fireEvent.click(screen.getByRole('button', { name: 'Crop' }));
  fireEvent.click(screen.getByRole('button', { name: /^Upright & transform/ }));
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
  mocks.commit.mockReset();
  mocks.solve.mockReset();
  mocks.analyse.mockReset();
  const doc = structuredClone(fixtureBook);
  const f1 = doc.assets.f1;
  if (f1) f1.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: {} });
  useUiStore.setState({
    develop: null,
    developBeforeAfter: false,
    filmstrip: DEFAULT_FILMSTRIP,
    showStructure: DEFAULT_UI_PREFS.showStructure,
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
});

describe('Transform section', () => {
  it('is the Crop card, first, with the Upright buttons, the seven sliders and Constrain Crop behind its ▸', () => {
    openSection();
    const sections = within(screen.getByTestId('develop-panel'))
      .getAllByRole('region')
      .map((s) => s.getAttribute('aria-label'));
    expect(sections[0]).toBe('Crop');
    const group = screen.getByRole('radiogroup', { name: 'Upright mode' });
    const modes = [...group.querySelectorAll('[role="radio"]')].map((r) => r.textContent);
    expect(modes).toEqual(['Off', 'Auto', 'Level', 'Vertical', 'Full', 'Guided']);
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    for (const name of ['Vertical', 'Horizontal', 'Rotate', 'Aspect', 'Scale', 'X Offset', 'Y Offset']) {
      expect(screen.getByRole('slider', { name })).toBeTruthy();
    }
    expect(screen.getByRole('slider', { name: 'Scale' }).getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByRole('slider', { name: 'Rotate' }).getAttribute('aria-valuemin')).toBe('-10');
    expect((screen.getByRole('checkbox', { name: 'Constrain Crop' }) as HTMLInputElement).checked).toBe(true);
  });

  it('a slider writes the manual Transform, refits the crop, and undoes in one step', () => {
    openSection();
    const vertical = screen.getByRole('slider', { name: 'Vertical' });
    fireEvent.keyDown(vertical, { key: 'ArrowLeft', shiftKey: true });
    expect(geometry().transform.vertical).toBe(-10);
    expect(geometry().crop?.rect.w).toBeLessThan(1);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Rotate' }), { key: 'ArrowRight' });
    expect(geometry().transform.rotate).toBeCloseTo(0.1, 12);
    act(() => {
      // Nudge bursts are idle gestures; undo ends them first.
      undo();
    });
    expect(geometry().transform.rotate).toBe(0);
  });

  it('Guided selects the mode, resets the sliders (Alt keeps them) and starts drawing guides', () => {
    openSection();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Horizontal' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }), { altKey: true });
    expect(geometry().upright.mode).toBe('guided');
    expect(geometry().transform.horizontal).toBe(1);
    expect(useUiStore.getState().developGuides).toBe(true);
    expect(screen.getByTestId('guides-overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(geometry().upright.mode).toBe('off');
    expect(geometry().transform.horizontal).toBe(0);
    expect(useUiStore.getState().developGuides).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Draw guides/ }));
    expect(useUiStore.getState().developGuides).toBe(true);
  });

  it('Update solves the guides and shows what was corrected; an invalid set shows the message only', async () => {
    useBookStore.getState().setUprightGuides('f1', GUIDES);
    openSection();
    mocks.solve.mockResolvedValue({ transform: UPRIGHT, focal: 0.78, residual: 0, correction: 'vertical' });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(screen.getByTestId('upright-message').textContent).toMatch(/^Vertical/));
    expect(geometry().upright).toMatchObject({ mode: 'guided', transform: UPRIGHT, focal: 0.78 });

    act(() => useBookStore.getState().setUprightGuides('f1', GUIDES.slice(0, 1)));
    mocks.solve.mockRejectedValue(
      'InvalidGuides: 0 horizontal and 1 vertical guides; use 2H, 2V, 2H+2V, 2H+1V, 2V+1H or 1V+1H',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(screen.getByTestId('upright-message').textContent).toMatch(/2 horizontal or 2 vertical/),
    );
    expect(geometry().upright.transform).toEqual(UPRIGHT);
  });

  it('a guided solve that comes back after stepping to another photo writes nothing', async () => {
    useBookStore.getState().setUprightGuides('f1', GUIDES);
    openSection();
    let resolve: (v: unknown) => void = () => {};
    mocks.solve.mockReturnValue(new Promise((r) => (resolve = r)));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    act(() => useUiStore.getState().setDevelopIndex(1));
    await act(async () => resolve({ transform: UPRIGHT, focal: 0.78, residual: 0, correction: 'vertical' }));
    expect(geometry().upright).toMatchObject({ mode: 'off', transform: null });
  });

  it('Constrain Crop and Reset', () => {
    openSection();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Constrain Crop' }));
    expect(geometry().constrainCrop).toBe(false);
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Vertical' }), { key: 'ArrowLeft', shiftKey: true });
    expect(geometry().crop).toBeNull();
    // Plan 54: the card's reset puts the whole geometry back, Constrain Crop too, in one step.
    fireEvent.click(screen.getByRole('button', { name: 'Reset Crop' }));
    expect(geometry()).toEqual(createDevelop().geometry);
  });

  it('the Crop card opens the crop tool, says what the crop is, and tags its ▸ edited in Basic (plan 54)', () => {
    act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
    render(<DevelopMode />);
    fireEvent.click(screen.getByRole('button', { name: 'Crop' }));
    expect(screen.getByText('Not cropped')).toBeTruthy();
    const more = screen.getByRole('button', { name: /^Upright & transform/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(within(more).queryByText('·edited')).toBeNull();
    act(() => useBookStore.getState().setTransform('f1', { vertical: 12 }));
    expect(within(screen.getByRole('button', { name: /^Upright & transform/ })).getByText('·edited')).toBeTruthy();
    expect(screen.queryByRole('slider', { name: 'Vertical' })).toBeNull();
    act(() => useBookStore.getState().flip('f1', 'h'));
    expect(screen.getByText(/flipped/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Crop & straighten' }));
    expect(screen.getByTestId('crop-panel')).toBeTruthy();
  });

  describe('automatic Upright', () => {
    const AUTO = [1.02, 0.01, -0.015, 0, 1.04, -0.02, 0, 0.05, 1];
    const LINES = [
      { x0: 0.2, y0: 0.1, x1: 0.22, y1: 0.9, used: true },
      { x0: 0.8, y0: 0.1, x1: 0.78, y1: 0.9, used: true },
      { x0: 0.1, y0: 0.5, x1: 0.4, y1: 0.55, used: false },
    ];
    const result = (patch: Record<string, unknown> = {}) => ({
      transform: AUTO,
      focal: 0.9,
      angle: 1.23,
      confidence: 0.84,
      correction: 'vertical',
      message: null,
      lines: LINES,
      elapsedMs: 120,
      ...patch,
    });

    it('Auto analyses the photo, applies the result in one undo step and shows what it did', async () => {
      openSection();
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Horizontal' }), { key: 'ArrowRight' });
      let resolve: (v: unknown) => void = () => {};
      mocks.analyse.mockReturnValue(new Promise((r) => (resolve = r)));
      const auto = screen.getByRole('radio', { name: 'Auto' });
      fireEvent.click(auto);
      expect(mocks.analyse).toHaveBeenCalledWith('/photos', 'fixture/f1.jpg', 'hash-f1', 'auto', 0, false, false);
      // Busy: the button says so and the other automatic modes wait; nothing is written yet.
      expect(auto.getAttribute('aria-busy')).toBe('true');
      expect((screen.getByRole('radio', { name: 'Level' }) as HTMLButtonElement).disabled).toBe(true);
      expect(geometry().upright.mode).toBe('off');
      await act(async () => resolve(result()));
      expect(geometry().upright).toMatchObject({ mode: 'auto', transform: AUTO, focal: 0.9 });
      expect(geometry().transform.horizontal).toBe(0);
      expect(screen.getByTestId('upright-message').textContent).toBe('Auto: Vertical +1.2° · confidence 0.8');
      expect(useUiStore.getState().uprightLines).toEqual({ assetId: 'f1', orientation: '0|', lines: LINES });
      expect(auto.getAttribute('aria-checked')).toBe('true');
      act(() => {
        undo();
      });
      expect(geometry().upright.mode).toBe('off');
      expect(geometry().upright.transform).toBeNull();
      expect(geometry().transform.horizontal).toBe(1);
    });

    it('a result that arrives after stepping to another photo writes nothing', async () => {
      openSection();
      let resolve: (v: unknown) => void = () => {};
      mocks.analyse.mockReturnValue(new Promise((r) => (resolve = r)));
      fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
      act(() => useUiStore.getState().setDevelopIndex(1));
      await act(async () => resolve(result()));
      expect(geometry().upright).toMatchObject({ mode: 'off', transform: null });
      expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
    });

    it('Alt-click keeps the sliders; Level labels the angle with a minus sign', async () => {
      openSection();
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Horizontal' }), { key: 'ArrowRight' });
      mocks.analyse.mockResolvedValue(result({ correction: 'level', angle: -2, confidence: 0.91 }));
      fireEvent.click(screen.getByRole('radio', { name: 'Level' }), { altKey: true });
      await waitFor(() => expect(geometry().upright.mode).toBe('level'));
      expect(mocks.analyse.mock.calls[0]?.[3]).toBe('level');
      expect(geometry().transform.horizontal).toBe(1);
      expect(screen.getByTestId('upright-message').textContent).toBe('Level \u22122.0° · confidence 0.9');
    });

    it('no structure shows the message, keeps the lines for the overlay and writes nothing', async () => {
      openSection();
      mocks.analyse.mockResolvedValue(
        result({ transform: null, focal: null, angle: null, correction: null, message: 'no straight lines found' }),
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Full' }));
      await waitFor(() => expect(screen.getByTestId('upright-message').textContent).toBe('No straight lines found'));
      expect(geometry()).toEqual(createDevelop().geometry);
      expect(useBookStore.getState().book?.assets.f1?.develop).toBeUndefined();
      expect(useUiStore.getState().uprightLines?.lines).toHaveLength(3);

      mocks.analyse.mockResolvedValue(
        result({ transform: null, angle: null, correction: null, message: 'already level; nothing to correct' }),
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
      await waitFor(() => expect(screen.getByTestId('upright-message').textContent).toBe('Already level'));
      expect(useBookStore.getState().book?.assets.f1?.develop).toBeUndefined();
    });

    it('a rejected warp shows a message and writes nothing', async () => {
      openSection();
      mocks.analyse.mockRejectedValue('Unstable: the corrected frame would fold');
      fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
      await waitFor(() => expect(screen.getByTestId('upright-message').textContent).toMatch(/distort/));
      expect(useBookStore.getState().book?.assets.f1?.develop).toBeUndefined();
    });

    it('Update re-runs the current automatic mode, keeping the sliders', async () => {
      openSection();
      mocks.analyse.mockResolvedValue(result());
      fireEvent.click(screen.getByRole('radio', { name: 'Vertical' }));
      await waitFor(() => expect(geometry().upright.mode).toBe('vertical'));
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Aspect' }), { key: 'ArrowRight' });
      const next = [1, 0, 0.01, 0, 1, 0, 0, 0.02, 1];
      mocks.analyse.mockResolvedValue(result({ transform: next }));
      const update = screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement;
      expect(update.disabled).toBe(false);
      fireEvent.click(update);
      await waitFor(() => expect(geometry().upright.transform).toEqual(next));
      expect(mocks.analyse).toHaveBeenCalledTimes(2);
      expect(mocks.analyse.mock.calls[1]?.[3]).toBe('vertical');
      expect(geometry().transform.aspect).toBe(1);
      expect(mocks.solve).not.toHaveBeenCalled();
    });

    it('Show structure is a persisted toggle', () => {
      openSection();
      const toggle = screen.getByRole('button', { name: 'Show structure' });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(toggle);
      expect(useUiStore.getState().showStructure).toBe(true);
      expect(localStorage.getItem('photobook.ui.showStructure')).toBe('true');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(toggle);
      expect(useUiStore.getState().showStructure).toBe(false);
    });
  });
});
