// @vitest-environment jsdom
import { type Book, type Page, resolveTheme, spacing } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { gapBadges, SNAP_THRESHOLD_PX, snapThreshold, useSnap } from './snap';

const photo = (id: string, frame: Page['elements'][number]['frame']): Page['elements'][number] => ({
  type: 'photo',
  id,
  asset: null,
  frame,
  crop: { x: 0, y: 0, scale: 1 },
  rotate: 0,
  filter: 'none',
});

function load(elements: Page['elements']) {
  const book: Book = {
    ...structuredClone(fixtureBook),
    theme: resolveTheme({}),
    pages: [{ id: 'p1', layout: 'blank', background: '#ffffff', elements }],
  };
  useBookStore.setState({ book, folder: '/photos' });
  useUiStore.getState().reset();
  // 100%: the 1080 px template is 540 CSS px wide, so 6 px is 6 / 540 of the width.
  useUiStore.setState({ zoom: 1, snapEnabled: true });
}

beforeEach(() => load([photo('a', { x: 0.3, y: 0.3, w: 0.3, h: 0.2 })]));
afterEach(() => useBookStore.getState().close());

describe('useSnap', () => {
  it('converts the 6 px threshold to page fractions at the current zoom', () => {
    expect(snapThreshold()).toBeCloseTo(SNAP_THRESHOLD_PX / 540, 9);
    useUiStore.setState({ zoom: 2 });
    expect(snapThreshold()).toBeCloseTo(SNAP_THRESHOLD_PX / 1080, 9);
  });

  it('snaps a frame near the safe margin onto it and reports a margin guide', () => {
    const { result } = renderHook(() => useSnap());
    const margin = spacing(0.08, 0.025, 1080 / 1350).mx;
    let out: ReturnType<typeof result.current.snap> | undefined;
    act(() => {
      out = result.current.snap({
        pageId: 'p1',
        elementId: 'a',
        frame: { x: margin - 0.006, y: 0.31, w: 0.3, h: 0.2 },
        handle: 'move',
      });
    });
    expect(out?.frame.x).toBeCloseTo(margin, 9);
    expect(out?.guides).toContainEqual({ axis: 'x', value: margin, kind: 'margin' });
    // The hook publishes the guides for the overlay.
    expect(result.current.guides).toContainEqual({ axis: 'x', value: margin, kind: 'margin' });
    act(() => result.current.clear());
    expect(result.current.guides).toEqual([]);
  });

  it('does not snap when the pref is off or the drag bypasses it (Cmd)', () => {
    const { result } = renderHook(() => useSnap());
    const frame = { x: 0.075, y: 0.31, w: 0.3, h: 0.2 };
    const bypassed = result.current.snap({ pageId: 'p1', elementId: 'a', frame, handle: 'move', bypass: true });
    expect(bypassed.frame).toEqual(frame);
    expect(bypassed.guides).toEqual([]);
    useUiStore.setState({ snapEnabled: false });
    expect(result.current.snap({ pageId: 'p1', elementId: 'a', frame, handle: 'move' }).guides).toEqual([]);
  });

  it('labels a gutter snap between two photos with its distance', () => {
    load([photo('a', { x: 0.1, y: 0.3, w: 0.3, h: 0.2 }), photo('b', { x: 0.5, y: 0.3, w: 0.3, h: 0.2 })]);
    const { result } = renderHook(() => useSnap());
    // b's left edge 0.2 in (0.025 of the width) after a's right edge, give or take 2 px.
    const out = result.current.snap({
      pageId: 'p1',
      elementId: 'b',
      frame: { x: 0.4 + 0.025 + 0.003, y: 0.3, w: 0.3, h: 0.2 },
      handle: 'move',
    });
    expect(out.frame.x).toBeCloseTo(0.425, 9);
    expect(out.guides.some((g) => g.kind === 'gap' && g.axis === 'x')).toBe(true);
    expect(out.badges).toEqual([expect.objectContaining({ label: 'gutter · 0.20 in' })]);
  });

  it('gapBadges ignores neighbours outside the frame row', () => {
    const theme = resolveTheme({});
    const badges = gapBadges(
      { x: 0.425, y: 0.6, w: 0.3, h: 0.2 },
      [{ axis: 'x', value: 0.425, kind: 'gap' }],
      [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }],
      theme,
      { width: 1080, height: 1350 },
    );
    expect(badges).toEqual([]);
  });
});
