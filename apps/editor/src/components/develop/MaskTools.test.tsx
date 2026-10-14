// @vitest-environment jsdom
import { DevelopGeometrySchema, type DevelopMask } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approximateMask, cropMapping, newLinear, newMask } from '../../lib/develop/masks';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_BRUSH, DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({ render: vi.fn(), overlay: vi.fn(), commit: vi.fn() }));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
  developMaskOverlay: mocks.overlay,
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

// Plan 56. f1 is 1200 × 800; the box is 648 × 448, so the picture is 600 × 400 at (24, 24) (as in MasksSection.test).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const at = (u: number, v: number): [number, number] => [24 + 600 * u, 24 + 400 * v];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

const file = (): AssetFile => ({
  relPath: 'fixture/f1.jpg',
  assetId: 'f1',
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: 'hash-f1',
  status: 'ready',
  proxyUrl: 'asset://proxy/f1.jpg',
  thumbUrl: 'asset://thumb/f1.jpg',
});

const masks = (): DevelopMask[] => useBookStore.getState().book?.assets.f1?.develop?.masks ?? [];
const steps = () => useBookStore.temporal.getState().pastStates.length;
const tools = () => screen.getByTestId('mask-tools');
const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(screen.getByRole('dialog'), { key: k, ...init });

function open() {
  act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
  render(<DevelopMode />);
  key('m');
}

function create(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Create new mask' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

function drag(points: Array<[number, number]>, init: Partial<PointerEventInit> = {}, on: Element = tools()) {
  const [first, ...rest] = points;
  if (!first) return;
  fireEvent.pointerDown(on, { pointerId: 1, button: 0, clientX: first[0], clientY: first[1], ...init });
  for (const [x, y] of rest) fireEvent.pointerMove(tools(), { pointerId: 1, clientX: x, clientY: y, ...init });
  const last = rest[rest.length - 1] ?? first;
  fireEvent.pointerUp(tools(), { pointerId: 1, clientX: last[0], clientY: last[1] });
}

/** The approximated mask (the README's maths) at `(u, v)` of the picture. */
function maskAt(mask: DevelopMask, u: number, v: number): number {
  const mapping = cropMapping(DevelopGeometrySchema.parse({}), { width: 1200, height: 800 });
  const values = approximateMask(mask, mapping, 120, 80);
  if (!values) throw new Error('no approximation');
  return values[Math.min(Math.floor(v * 80), 79) * 120 + Math.min(Math.floor(u * 120), 119)] ?? Number.NaN;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:overlay');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: 0,
    y: 0,
    right: BOX.width,
    bottom: BOX.height,
    toJSON: () => BOX,
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mocks.render.mockReset();
  mocks.render.mockImplementation(async () => jpeg());
  mocks.overlay.mockReset();
  mocks.overlay.mockImplementation(async () => jpeg());
  mocks.commit.mockReset();
  const doc = structuredClone(fixtureBook);
  const asset = doc.assets.f1;
  if (asset) asset.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file() } });
  useUiStore.setState({
    develop: null,
    developBeforeAfter: false,
    filmstrip: DEFAULT_FILMSTRIP,
    maskOverlay: true,
    maskBrush: { ...DEFAULT_BRUSH },
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('MaskTools (plan 56)', () => {
  it('a drag from bottom to top makes a linear mask full at the press, fading toward the release', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.5), at(0.5, 0.1)]);
    expect(steps()).toBe(1);
    const m = masks()[0];
    if (!m) throw new Error('mask expected');
    const c = m.components[0];
    if (c?.kind !== 'linear') throw new Error('linear expected');
    // Stored: `to` (where the rasteriser is 1) is the press, `from` the release.
    expect(c.to[1]).toBeCloseTo(0.9);
    expect(c.from[1]).toBeCloseTo(0.1);
    expect(maskAt(m, 0.5, 0.95)).toBeCloseTo(1, 2);
    expect(maskAt(m, 0.5, 0.05)).toBeCloseTo(0, 2);
    expect(maskAt(m, 0.5, 0.75)).toBeGreaterThan(maskAt(m, 0.5, 0.25));
  });

  it('an old linear mask keeps its stored points and still renders full at `to`', () => {
    open();
    const old = newMask('Old', newLinear([0.5, 0.9], [0.5, 0.1]));
    act(() => useBookStore.getState().addMask('f1', old));
    act(() =>
      useUiStore.getState().setDevelopMaskTool({ maskId: old.id, componentId: old.components[0]?.id, tool: 'linear' }),
    );
    const stored = masks()[0];
    if (!stored) throw new Error('mask expected');
    expect(stored.components[0]).toMatchObject({ from: [0.5, 0.9], to: [0.5, 0.1] });
    expect(maskAt(stored, 0.5, 0.05)).toBeCloseTo(1, 2);
    expect(maskAt(stored, 0.5, 0.95)).toBeCloseTo(0, 2);
  });

  it('the rotate handle turns a linear gradient about its middle; Shift snaps to 15°, with the angle in a badge', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    const handle = screen.getByTestId('linear-shape').querySelector('[data-mask-handle="rotate"]');
    if (!handle) throw new Error('no rotate handle');
    expect(screen.getAllByTestId('rotate-handle')).toHaveLength(1);
    const cx = Number(handle.getAttribute('cx'));
    const cy = Number(handle.getAttribute('cy'));
    const [mx, my] = at(0.5, 0.5);
    // On the 50 % line (level for a vertical gradient), past half the gradient's length.
    expect(cy).toBeCloseTo(my, 0);
    expect(Math.abs(cx - mx)).toBeGreaterThan(160);
    // Turn by about 20° with Shift: it snaps to 15°.
    const r = Math.abs(cx - mx);
    const sign = Math.sign(cx - mx);
    const turn = (20 * Math.PI) / 180;
    const to: [number, number] = [mx + sign * r * Math.cos(turn), my + sign * r * Math.sin(turn)];
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: cx, clientY: cy });
    fireEvent.pointerMove(tools(), { pointerId: 2, clientX: to[0], clientY: to[1], shiftKey: true });
    expect(screen.getByTestId('mask-angle').textContent).toBe('15°');
    fireEvent.pointerUp(tools(), { pointerId: 2, clientX: to[0], clientY: to[1] });
    expect(screen.queryByTestId('mask-angle')).toBeNull();
    const c = masks()[0]?.components[0];
    if (c?.kind !== 'linear') throw new Error('linear expected');
    // The midpoint stays; the direction (on screen, square pixels here) turned by 15°.
    expect((c.from[0] + c.to[0]) / 2).toBeCloseTo(0.5);
    expect((c.from[1] + c.to[1]) / 2).toBeCloseTo(0.5);
    const deg = (Math.atan2((c.to[1] - c.from[1]) * 400, (c.to[0] - c.from[0]) * 600) * 180) / Math.PI;
    expect(Math.abs(Math.abs(deg) - 90)).toBeCloseTo(15, 1);
    expect(steps()).toBe(2);
  });

  it('the radial gradient uses the same rotate handle, and Shift snaps it to 15°', () => {
    open();
    create('Radial gradient');
    drag([at(0.5, 0.5), [at(0.5, 0.5)[0] + 60, at(0.5, 0.5)[1] + 40]]);
    const handle = screen.getByTestId('radial-shape').querySelector('[data-mask-handle="rotate"]');
    if (!handle) throw new Error('no rotate handle');
    const cx = Number(handle.getAttribute('cx'));
    const cy = Number(handle.getAttribute('cy'));
    const [mx, my] = at(0.5, 0.5);
    // 40 px radius plus the 24 px gap above the centre.
    expect(cy).toBeCloseTo(my - 40 - 24, 0);
    const r = my - cy;
    const turn = (37 * Math.PI) / 180;
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: cx, clientY: cy });
    fireEvent.pointerMove(tools(), {
      pointerId: 2,
      clientX: mx + r * Math.sin(turn),
      clientY: my - r * Math.cos(turn),
      shiftKey: true,
    });
    expect(screen.getByTestId('mask-angle').textContent).toBe('30°');
    fireEvent.pointerUp(tools(), { pointerId: 2, clientX: cx, clientY: cy });
    const c = masks()[0]?.components[0];
    expect(c?.kind === 'radial' && c.angle).toBe(30);
  });

  it('Invert on the mask row toggles the mask', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    const row = screen.getByRole('button', { name: 'Invert Mask 1' });
    expect(row.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(row);
    expect(masks()[0]?.invert).toBe(true);
    expect(screen.getByRole('button', { name: 'Invert Mask 1' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('right-click on a mask row: Invert, Duplicate, Rename, Delete, each one undo step', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    const before = steps();
    const row = () => document.querySelector(`[data-mask-row="${masks()[0]?.id}"]`) as Element;
    const menu = () => screen.getByRole('menu', { name: 'Mask 1 actions' });

    fireEvent.contextMenu(row(), { clientX: 400, clientY: 100 });
    fireEvent.click(within(menu()).getByRole('menuitemcheckbox', { name: 'Invert' }));
    expect(masks()[0]?.invert).toBe(true);
    expect(steps()).toBe(before + 1);

    fireEvent.contextMenu(row(), { clientX: 400, clientY: 100 });
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Duplicate' }));
    expect(masks().map((m) => m.name)).toEqual(['Mask 1', 'Mask 1 copy']);
    expect(steps()).toBe(before + 2);

    fireEvent.contextMenu(row(), { clientX: 400, clientY: 100 });
    fireEvent.click(within(menu()).getByRole('menuitem', { name: 'Rename…' }));
    const field = screen.getByRole('textbox', { name: 'Mask name' });
    fireEvent.change(field, { target: { value: 'Sky' } });
    // Typing Backspace in the field never deletes the mask.
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(masks()).toHaveLength(2);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(masks()[0]?.name).toBe('Sky');

    fireEvent.contextMenu(row(), { clientX: 400, clientY: 100 });
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Sky actions' })).getByRole('menuitem', { name: /^Delete/ }),
    );
    expect(masks().map((m) => m.name)).toEqual(['Mask 1 copy']);
    undo();
    expect(masks().map((m) => m.name)).toEqual(['Sky', 'Mask 1 copy']);
  });

  it('right-click on the picture: Convert to… turns a linear gradient into a radial one, keeping its id', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    const id = masks()[0]?.components[0]?.id;
    fireEvent.contextMenu(tools(), { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Radial gradient' }));
    const c = masks()[0]?.components[0];
    expect(c?.kind).toBe('radial');
    expect(c?.id).toBe(id);
    expect(c?.kind === 'radial' && c.center[1]).toBeCloseTo(0.9);
  });

  it('Delete / Backspace on a selected mask (no component) removes it as one undo step', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Mask 1' }));
    // Selecting the row keeps the component selected from the drag; select the mask alone.
    act(() => useUiStore.getState().setDevelopMaskTool({ maskId: masks()[0]?.id ?? '', tool: null }));
    const before = steps();
    key('Backspace');
    expect(masks()).toEqual([]);
    expect(steps()).toBe(before + 1);
    undo();
    expect(masks()).toHaveLength(1);
  });

  it('Delete / Backspace leaves the mask alone while a dialog is open', () => {
    open();
    create('Linear gradient');
    drag([at(0.5, 0.9), at(0.5, 0.1)]);
    act(() => useUiStore.getState().setDevelopMaskTool({ maskId: masks()[0]?.id ?? '', tool: null }));
    const dialog = document.createElement('div');
    dialog.setAttribute('data-develop-dialog', '');
    document.body.append(dialog);
    fireEvent.keyDown(dialog, { key: 'Backspace' });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(masks()).toHaveLength(1);
    dialog.remove();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(masks()).toEqual([]);
  });
});
