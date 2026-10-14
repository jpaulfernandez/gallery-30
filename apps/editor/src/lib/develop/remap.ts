/**
 * Re-mapping vector masks and Upright guides when the geometry changes: the TypeScript twin of
 * `crates/develop/src/geometry/remap.rs`. Masks and guides are stored in fractions of the transformed, uncropped
 * frame, so a new geometry moves them through `H_new · H_old⁻¹` (both the full pre-crop map: orientation,
 * Upright, manual Transform) and they stay on the image content they were drawn on. Pure; returns new arrays and
 * shares untouched components.
 */
import type { DevelopGeometry, DevelopMask, DevelopMaskComponent, DevelopPoint, UprightGuide } from '@photobook/shared';
import { applyMat, jacobian, orientedSize, preCropMatrix, remapMatrix } from './geometry';

export type RemapGeometry = Pick<DevelopGeometry, 'rotate' | 'flipH' | 'flipV' | 'upright' | 'transform'>;

/**
 * Re-map every vector mask component (brush points, linear from/to, radial centre with its radii and angle
 * through the local Jacobian) and every guide from the transformed frame of `oldGeometry` to that of
 * `newGeometry`, for a decoded `sourceW × sourceH` image. Inputs are returned as they are when the old map is
 * singular.
 */
export function remapGeometryVectors(
  oldGeometry: RemapGeometry,
  newGeometry: RemapGeometry,
  sourceW: number,
  sourceH: number,
  masks: readonly DevelopMask[],
  guides: readonly UprightGuide[],
): { masks: DevelopMask[]; guides: UprightGuide[] } {
  const hOld = preCropMatrix(oldGeometry, sourceW, sourceH);
  const hNew = preCropMatrix(newGeometry, sourceW, sourceH);
  const m = remapMatrix(hOld, hNew);
  if (!m) return { masks: [...masks], guides: [...guides] };
  const aspect = (g: RemapGeometry) => {
    const [w, h] = orientedSize(g.rotate, Math.max(sourceW, 1), Math.max(sourceH, 1));
    return w / h;
  };
  const aOld = aspect(oldGeometry);
  const aNew = aspect(newGeometry);
  const map = (p: DevelopPoint): DevelopPoint => applyMat(m, p);

  const component = (c: DevelopMaskComponent): DevelopMaskComponent => {
    switch (c.kind) {
      case 'brush':
        return { ...c, strokes: c.strokes.map((s) => ({ ...s, points: s.points.map(map) })) };
      case 'linear':
        return { ...c, from: map(c.from), to: map(c.to) };
      case 'radial': {
        // Jacobian in units proportional to pixels: x scaled by the frame aspect.
        const [a, b, cc, d] = jacobian(m, c.center);
        const jm = [(a * aNew) / aOld, b * aNew, cc / aOld, d] as const;
        const phi = c.angle * (Math.PI / 180);
        const s = Math.sin(phi);
        const co = Math.cos(phi);
        const e1 = [c.radii[0] * aOld * co, c.radii[0] * aOld * s] as const;
        const e2 = [-c.radii[1] * s, c.radii[1] * co] as const;
        const lin = (e: readonly [number, number]) =>
          [jm[0] * e[0] + jm[1] * e[1], jm[2] * e[0] + jm[3] * e[1]] as const;
        const f1 = lin(e1);
        const f2 = lin(e2);
        const r1 = Math.hypot(f1[0], f1[1]);
        const r2 = Math.hypot(f2[0], f2[1]);
        let { angle, radii } = c;
        if (Number.isFinite(r1) && Number.isFinite(r2) && r1 > 0 && r2 > 0) {
          angle = (Math.atan2(f1[1], f1[0]) * 180) / Math.PI;
          radii = [r1 / aNew, r2];
        }
        return { ...c, center: map(c.center), radii, angle };
      }
      default:
        return c;
    }
  };

  return {
    masks: masks.map((mask) => ({ ...mask, components: mask.components.map(component) })),
    guides: guides.map((g) => ({ ...g, from: map(g.from), to: map(g.to) })),
  };
}
