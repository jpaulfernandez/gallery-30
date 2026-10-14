// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PhotoElement, pagesOf } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';

vi.mock('../../store/autosave', () => ({ flush: vi.fn(async () => {}) }));

const { Canvas } = await import('./Canvas');
const { EditorDnd } = await import('./EditorDnd');
const { CanvasGuides, LAYOUT_GUIDE_COLOR, SNAP_COLOR } = await import('./CanvasGuides');
const { Rulers } = await import('./Rulers');
const { useSnapGuides } = await import('./snap');
const { SafeAreaGuides, SAFE_AREA_COLOR } = await import('../design/SafeAreaGuides');

/**
 * Plan 48's check: the snap lines are the accent, the ruler guides (and the grid and margins) the guide blue, a post's
 * safe area the `warn` orange; and on the page no accent shows except a frame's selection outline (and its handles).
 */

// The suite runs in the editor package (jsdom's `import.meta.url` is not a file URL).
const styles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const TEMPLATE = { width: 1080, height: 1350 };

const ui = () => useUiStore.getState();
const page = () => {
  const book = useBookStore.getState().book;
  const p = book ? pagesOf(book, ui().design.outputId)[0] : undefined;
  if (!p) throw new Error('no page');
  return p;
};

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
  useSnapGuides.setState({ pageId: null, guides: [], badges: [] });
});
afterEach(async () => {
  cleanup();
  useSnapGuides.setState({ pageId: null, guides: [], badges: [] });
  await useBookStore.getState().close();
});

describe('canvas colours (plan 48)', () => {
  it('the tokens exist', () => {
    for (const token of ['accent', 'guide', 'warn']) expect(styles).toMatch(new RegExp(`--color-${token}:`));
    expect(SNAP_COLOR).toBe('var(--color-accent)');
    expect(LAYOUT_GUIDE_COLOR).toBe('var(--color-guide)');
    expect(SAFE_AREA_COLOR).toBe('var(--color-warn)');
  });

  it('snap lines and their measures are the accent; the grid and the margins the guide blue', () => {
    useUiStore.setState({ showGrid: true, showMargins: true, showGuidesWhileDragging: true });
    useSnapGuides.setState({
      pageId: 'p',
      guides: [
        { axis: 'x', value: 0.5, kind: 'center' },
        { axis: 'y', value: 0.25, kind: 'frame' },
        { axis: 'x', value: 0.3, kind: 'equal', spans: [{ from: 0.1, to: 0.2, at: 0.5 }] },
      ],
      badges: [],
    });
    render(<CanvasGuides pageId="p" template={TEMPLATE} theme={fixtureBook.theme} width={400} />);
    const box = screen.getByTestId('canvas-guides');
    const lines = [...box.querySelectorAll('line')];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.getAttribute('stroke')).toBe('var(--color-accent)');
    expect(box.querySelector('[data-guide-kind="equal"]')?.getAttribute('stroke')).toBe('var(--color-accent)');
    for (const id of ['grid-lines', 'hard-margin', 'safe-margin']) {
      expect(screen.getByTestId(id).getAttribute('stroke')).toBe('var(--color-guide)');
    }
  });

  it('ruler guides are the guide blue, also while a frame is snapped to one', () => {
    useUiStore.setState({ showRulers: true, showGuidesWhileDragging: true });
    const guides = [
      { axis: 'x' as const, value: 0.5 },
      { axis: 'y' as const, value: 0.3 },
    ];
    useSnapGuides.setState({ pageId: 'p', guides: [{ axis: 'x', value: 0.5, kind: 'guide' }], badges: [] });
    render(<Rulers pageId="p" template={TEMPLATE} guides={guides} width={400} />);
    const lines = [...document.querySelectorAll('[data-page-guide] > span')];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.className).toMatch(/\bbg-guide(\/\d+)?\b/);
      expect(line.className).not.toMatch(/accent/);
    }
    expect(document.querySelector('[data-snapped]')?.className).toMatch(/\bbg-guide\b/);
    // The rulers' guide marks too.
    expect(document.querySelectorAll('[data-ruler] path.fill-guide')).toHaveLength(2);
  });

  it('a post’s safe area is the warn orange', () => {
    const story = useBookStore.getState().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    useUiStore.setState((s) => ({ showMargins: true, design: { ...s.design, outputId: story } }));
    render(<SafeAreaGuides width={270} height={480} />);
    const box = screen.getByTestId('safe-area-guides');
    expect(box.querySelector('rect')?.getAttribute('stroke')).toBe('var(--color-warn)');
    expect(box.querySelector('path')?.getAttribute('fill')).toBe('var(--color-warn)');
  });

  it('on the page, the accent marks only the selected frame’s outline and handles', () => {
    useUiStore.setState({ showGrid: true, showMargins: true, showRulers: true });
    render(
      <EditorDnd>
        <Canvas />
      </EditorDnd>,
    );
    const el = page().elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset !== null);
    if (!el) throw new Error('no filled photo');
    act(() => ui().select(el.id));
    const pageBox = document.querySelector('[data-page-box]');
    if (!pageBox) throw new Error('no page box');
    // The floating toolbars are opaque chrome over the page (their focus rings and toggles may use the accent).
    const accented = [...pageBox.querySelectorAll('*')].filter((node) => {
      if (node.closest('[role="toolbar"]')) return false;
      const cls = node.getAttribute('class') ?? '';
      const paint = `${node.getAttribute('stroke') ?? ''} ${node.getAttribute('fill') ?? ''}`;
      return /(^|[\s:-])(outline|border|bg|ring|text|fill|stroke)-accent\b/.test(cls) || paint.includes('accent');
    });
    expect(accented.length).toBeGreaterThan(0);
    for (const node of accented) {
      const outline =
        node.getAttribute('class')?.includes('outline-accent') && node.querySelector('[data-resize-handle]');
      expect(outline || node.hasAttribute('data-resize-handle')).toBeTruthy();
    }
    // The selection outline plus its eight handles.
    expect(accented).toHaveLength(9);
  });
});
