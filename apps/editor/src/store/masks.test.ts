import { createDevelop, type DevelopMask, type DevelopPoint } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invert, preCropMatrix, remapPoints } from '../lib/develop/geometry';
import { newAi, newBrushComponent, newLinear, newMask, newRadial } from '../lib/develop/masks';
import { beginDevelopDrag, endDevelopDrag, undo, useBookStore } from './book';

const store = () => useBookStore.getState();
const masks = (): DevelopMask[] => store().book?.assets.f1?.develop?.masks ?? [];
const steps = () => useBookStore.temporal.getState().pastStates.length;
const stroke = (points: DevelopPoint[]) => ({ points, size: 10, feather: 50, flow: 100, erase: false });

function seed(): DevelopMask {
  const m = newMask('Sky', newLinear([0.5, 0], [0.5, 0.4]), 'm1');
  store().addMask('f1', m);
  useBookStore.temporal.getState().clear();
  return m;
}

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
  useBookStore.temporal.getState().clear();
});

afterEach(async () => {
  await store().close();
});

describe('mask actions', () => {
  it('add, rename, toggle, invert and remove, one undo step each, keeping ids', () => {
    const m = newMask('Mask 1', newBrushComponent(), 'm1');
    store().addMask('f1', m);
    expect(masks().map((x) => x.id)).toEqual(['m1']);
    store().addMask('f1', m);
    expect(masks()).toHaveLength(1);
    store().renameMask('f1', 'm1', '  Face ');
    store().setMaskEnabled('f1', 'm1', false);
    store().setMaskInvert('f1', 'm1', true);
    expect(masks()[0]).toMatchObject({ id: 'm1', name: 'Face', enabled: false, invert: true });
    expect(steps()).toBe(4);
    store().removeMask('f1', 'm1');
    expect(store().book?.assets.f1?.develop).toBeUndefined();
    undo();
    expect(masks()[0]?.name).toBe('Face');
  });

  it('groups a slider drag of the mask or its local adjustments into one step', () => {
    seed();
    beginDevelopDrag();
    for (const v of [0.5, 1, 1.5]) store().setMaskAdjustments('f1', 'm1', { exposure: v });
    store().setMaskAdjustments('f1', 'm1', { contrast: 20 });
    endDevelopDrag();
    expect(steps()).toBe(1);
    expect(masks()[0]?.adjustments).toMatchObject({ exposure: 1.5, contrast: 20, highlights: 0 });
    store().setMaskOpacity('f1', 'm1', 60);
    store().setMaskFeather('f1', 'm1', 30);
    expect(masks()[0]).toMatchObject({ opacity: 60, feather: 30 });
    store().resetMaskAdjustments('f1', 'm1');
    expect(Object.values(masks()[0]?.adjustments ?? {}).every((v) => v === 0)).toBe(true);
    undo();
    expect(masks()[0]?.adjustments.exposure).toBe(1.5);
  });

  it('ignores values outside the schema', () => {
    seed();
    store().setMaskAdjustments('f1', 'm1', { exposure: 9 });
    store().setMaskOpacity('f1', 'm1', 150);
    expect(masks()[0]).toMatchObject({ opacity: 100, adjustments: { exposure: 0 } });
    expect(steps()).toBe(0);
  });

  it('adds, edits and removes components; removing the last removes the mask', () => {
    seed();
    const r = newRadial([0.5, 0.5], [0.1, 0.2], 'subtract');
    store().addMaskComponent('f1', 'm1', r);
    store().setComponentMode('f1', 'm1', r.id, 'intersect');
    store().setComponentInvert('f1', 'm1', r.id, true);
    beginDevelopDrag();
    store().updateComponent('f1', 'm1', r.id, { center: [0.4, 0.5] });
    store().updateComponent('f1', 'm1', r.id, { center: [0.3, 0.5], angle: 15 });
    endDevelopDrag();
    expect(steps()).toBe(4);
    expect(masks()[0]?.components[1]).toMatchObject({
      id: r.id,
      kind: 'radial',
      mode: 'intersect',
      invert: true,
      center: [0.3, 0.5],
      angle: 15,
    });
    const first = masks()[0]?.components[0]?.id ?? '';
    store().removeMaskComponent('f1', 'm1', first);
    expect(masks()[0]?.components.map((c) => c.id)).toEqual([r.id]);
    store().removeMaskComponent('f1', 'm1', r.id);
    expect(masks()).toEqual([]);
  });

  it('replaces a component with one or several in its place, one undo step', () => {
    const all = newAi('people');
    const other = newLinear([0, 0], [1, 1]);
    store().addMask('f1', { ...newMask('People', all, 'm1'), components: [all, other] });
    useBookStore.temporal.getState().clear();
    const p1 = newAi('people', 'add', [
      {
        kind: 'box',
        box: [
          [0, 0],
          [0.5, 1],
        ],
        positive: true,
      },
    ]);
    const p2 = newAi('people', 'add', [
      {
        kind: 'box',
        box: [
          [0.5, 0],
          [1, 1],
        ],
        positive: true,
      },
    ]);
    store().replaceMaskComponent('f1', 'm1', all.id, [p1, p2]);
    expect(masks()[0]?.components.map((c) => c.id)).toEqual([p1.id, p2.id, other.id]);
    expect(steps()).toBe(1);
    store().replaceMaskComponent('f1', 'm1', 'nope', [p1]);
    store().replaceMaskComponent('f1', 'm1', p1.id, []);
    expect(steps()).toBe(1);
    undo();
    expect(masks()[0]?.components.map((c) => c.id)).toEqual([all.id, other.id]);
  });

  it('duplicates a mask after the original with new ids', () => {
    seed();
    store().addMask('f1', newMask('Other', newBrushComponent(), 'm2'));
    const id = store().duplicateMask('f1', 'm1');
    expect(id).toBeTruthy();
    expect(masks().map((m) => m.name)).toEqual(['Sky', 'Sky copy', 'Other']);
    expect(masks()[1]?.id).toBe(id);
    expect(masks()[1]?.components[0]?.id).not.toBe(masks()[0]?.components[0]?.id);
    expect(store().duplicateMask('f1', 'nope')).toBeNull();
  });

  it('a painted stroke streaming its points is one undo step', () => {
    const c = newBrushComponent();
    store().addMask('f1', newMask('Paint', c, 'm1'));
    useBookStore.temporal.getState().clear();
    beginDevelopDrag();
    store().appendBrushStroke('f1', 'm1', c.id, stroke([[0.1, 0.1]]));
    store().setLastBrushStroke(
      'f1',
      'm1',
      c.id,
      stroke([
        [0.1, 0.1],
        [0.2, 0.1],
      ]),
    );
    store().setLastBrushStroke(
      'f1',
      'm1',
      c.id,
      stroke([
        [0.1, 0.1],
        [0.2, 0.1],
        [0.3, 0.2],
      ]),
    );
    endDevelopDrag();
    expect(steps()).toBe(1);
    const brush = masks()[0]?.components[0];
    expect(brush?.kind === 'brush' && brush.strokes.map((s) => s.points.length)).toEqual([3]);
    undo();
    const before = masks()[0]?.components[0];
    expect(before?.kind === 'brush' && before.strokes).toEqual([]);
  });
});

describe('masks follow a Transform change', () => {
  it('keeps a brush stroke on the same content: points move by H_new · H_old⁻¹', () => {
    const SIZE = { width: 1200, height: 800 };
    const points: DevelopPoint[] = [
      [0.3, 0.3],
      [0.45, 0.4],
      [0.6, 0.35],
    ];
    const c = newBrushComponent([stroke(points)]);
    store().addMask('f1', newMask('Paint', c, 'm1'));
    const old = store().book?.assets.f1?.develop?.geometry ?? createDevelop().geometry;
    store().setTransform('f1', { vertical: 40 }, SIZE);
    const now = store().book?.assets.f1?.develop?.geometry ?? createDevelop().geometry;
    expect(now.transform.vertical).toBe(40);
    const hOld = preCropMatrix(old, SIZE.width, SIZE.height);
    const hNew = preCropMatrix(now, SIZE.width, SIZE.height);
    expect(invert(hOld)).not.toBeNull();
    const expected = remapPoints(points, hOld, hNew);
    const moved = masks()[0]?.components[0];
    if (moved?.kind !== 'brush') throw new Error('brush expected');
    const got = moved.strokes[0]?.points ?? [];
    expect(got).toHaveLength(points.length);
    got.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(expected[i]?.[0] ?? Number.NaN, 9);
      expect(p[1]).toBeCloseTo(expected[i]?.[1] ?? Number.NaN, 9);
    });
    expect(got[0]?.[1]).not.toBeCloseTo(points[0]?.[1] ?? 0, 3);
    // One undo step puts both the transform and the stroke back.
    undo();
    const back = masks()[0]?.components[0];
    expect(back?.kind === 'brush' && back.strokes[0]?.points).toEqual(points);
  });
});
