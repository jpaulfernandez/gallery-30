import {
  createDevelop,
  type DevelopGeometry,
  type DevelopMask,
  LocalAdjustmentsSchema,
  type UprightGuide,
} from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import { applyMat, preCropMatrix, remapPoints } from './geometry';
import { remapGeometryVectors } from './remap';

const base = createDevelop().geometry;
const UPRIGHT = [
  1.188363649281757, 0.06446848332522802, -0.060354038357723586, 0.09312103093822446, 1.2001118428071103,
  -0.08055440892689829, 0.127347455051356, 0.13690065673171983, 1,
];

const geometry = (patch: Partial<DevelopGeometry>): DevelopGeometry => ({ ...base, ...patch });

const masks: DevelopMask[] = [
  {
    id: 'm1',
    name: 'Window',
    enabled: true,
    invert: false,
    opacity: 100,
    feather: 0,
    adjustments: LocalAdjustmentsSchema.parse({}),
    components: [
      {
        id: 'c1',
        mode: 'add',
        invert: false,
        kind: 'brush',
        strokes: [
          {
            points: [
              [0.4, 0.3],
              [0.45, 0.32],
            ],
            size: 10,
            feather: 50,
            flow: 100,
            erase: false,
          },
        ],
      },
      { id: 'c2', mode: 'add', invert: false, kind: 'linear', from: [0.1, 0.9], to: [0.1, 0.6] },
      {
        id: 'c3',
        mode: 'add',
        invert: false,
        kind: 'radial',
        center: [0.6, 0.4],
        radii: [0.1, 0.2],
        angle: 15,
        feather: 50,
      },
      { id: 'c4', mode: 'add', invert: false, kind: 'luminance', range: [0.2, 0.8], feather: 10 },
    ],
  },
];
const guides: UprightGuide[] = [
  { id: 'g1', kind: 'vertical', from: [0.3, 0.1], to: [0.28, 0.9] },
  { id: 'g2', kind: 'horizontal', from: [0.1, 0.5], to: [0.9, 0.52] },
];

const flat = (v: unknown): number[] =>
  typeof v === 'number'
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(flat)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(flat)
        : [];

describe('remapGeometryVectors', () => {
  const before = geometry({});
  const after = geometry({
    upright: { mode: 'guided', guides: [], transform: UPRIGHT, focal: null },
    transform: { ...base.transform, vertical: -20, offsetX: 5 },
  });

  it('maps points exactly as remapPoints with the pre-crop maps', () => {
    const out = remapGeometryVectors(before, after, 6000, 4000, masks, guides);
    const hOld = preCropMatrix(before, 6000, 4000);
    const hNew = preCropMatrix(after, 6000, 4000);
    const [from, to] = remapPoints([guides[0]?.from ?? [0, 0], guides[0]?.to ?? [0, 0]], hOld, hNew);
    expect(out.guides[0]?.from).toEqual(from);
    expect(out.guides[0]?.to).toEqual(to);
    const brush = out.masks[0]?.components[0];
    expect(brush?.kind === 'brush' && brush.strokes[0]?.points[0]).toEqual(remapPoints([[0.4, 0.3]], hOld, hNew)[0]);
    // Non-vector components are left alone (the same object).
    expect(out.masks[0]?.components[3]).toBe(masks[0]?.components[3]);
  });

  it('round-trips old → new → old', () => {
    for (const [a, b] of [
      [before, after],
      [after, geometry({ rotate: 90, flipH: true, transform: { ...base.transform, horizontal: 30, scale: 120 } })],
    ] as const) {
      const there = remapGeometryVectors(a, b, 6000, 4000, masks, guides);
      const back = remapGeometryVectors(b, a, 6000, 4000, there.masks, there.guides);
      // Radial radii and angle follow the local Jacobian (approximate under perspective, as in the Rust): only
      // the centre is exact, so they are left out here.
      const exact = (ms: DevelopMask[]) => ms.map((m) => m.components.map((c) => (c.kind === 'radial' ? c.center : c)));
      const got = flat([exact(back.masks), back.guides]);
      const want = flat([exact(masks), guides]);
      expect(got.length).toBe(want.length);
      got.forEach((v, i) => {
        expect(v).toBeCloseTo(want[i] ?? Number.NaN, 9);
      });
    }
  });

  it('keeps content under a remapped point', () => {
    // A source point under a guide end before the change is under the remapped end after it.
    const out = remapGeometryVectors(before, after, 6000, 4000, [], guides);
    const src = guides[1]?.to ?? [0, 0];
    const [x, y] = applyMat(preCropMatrix(after, 6000, 4000), src);
    expect(out.guides[1]?.to[0]).toBeCloseTo(x, 12);
    expect(out.guides[1]?.to[1]).toBeCloseTo(y, 12);
  });
});
