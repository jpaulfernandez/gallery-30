/**
 * Mask helpers for the Develop view's Masks panel and tools (step D4.1): factories for masks and their components,
 * names, brush-stroke helpers, the frame ↔ crop mapping the tools draw with, and a quick JS approximation of the
 * composited mask the overlay shows while a shape is dragged (before the Rust overlay arrives).
 *
 * Units follow `crates/develop/README.md` (Masks): points are fractions of the transformed, uncropped frame; brush
 * `size` is the diameter as a percentage of the frame's short side; distances are frame-metric (frame pixels), so
 * shapes stay round whatever the frame's aspect.
 */
import {
  type AiMaskTarget,
  type BrushStroke,
  type DevelopGeometry,
  type DevelopMask,
  type DevelopMaskComponent,
  type DevelopPoint,
  type LocalAdjustments,
  LocalAdjustmentsSchema,
  type MaskPrompt,
  newId,
} from '@photobook/shared';
import type { SourceSize } from './cropEdit';
import { andThen, applyMat, geometryPlan, invert, type Mat3, rotateAbout, scale, translate } from './geometry';
import { deepEqual } from './merge';

export type BrushComponent = Extract<DevelopMaskComponent, { kind: 'brush' }>;
export type LinearComponent = Extract<DevelopMaskComponent, { kind: 'linear' }>;
export type RadialComponent = Extract<DevelopMaskComponent, { kind: 'radial' }>;
export type LuminanceComponent = Extract<DevelopMaskComponent, { kind: 'luminance' }>;
export type ColorComponent = Extract<DevelopMaskComponent, { kind: 'color' }>;
export type AiComponent = Extract<DevelopMaskComponent, { kind: 'ai' }>;
export type ComponentMode = DevelopMaskComponent['mode'];
type ComponentPatchOf<T> = T extends unknown ? Partial<Omit<T, 'id' | 'kind'>> : never;
/** Fields of one component kind to change (`updateComponent`); `id` and `kind` never change. */
export type MaskComponentPatch = ComponentPatchOf<DevelopMaskComponent>;

/** The tools that draw or pick a component over the picture. */
export const MASK_TOOLS = ['brush', 'linear', 'radial', 'luminance', 'color'] as const;
export type MaskTool = (typeof MASK_TOOLS)[number];

export const MASK_TOOL_LABEL: Record<MaskTool, string> = {
  brush: 'Brush',
  linear: 'Linear gradient',
  radial: 'Radial gradient',
  luminance: 'Luminance range',
  color: 'Color range',
};

/** Every tool over the picture: the drawing tools plus `refine` (click / box prompts on an AI component, D4.3). */
export type MaskToolName = MaskTool | 'refine';

export const TOOL_LABEL: Record<MaskToolName, string> = { ...MASK_TOOL_LABEL, refine: 'Refine' };

/** Overlay / swatch colours, by mask index (the overlay itself is always red, Lightroom's default). */
export const MASK_SWATCHES = ['#e5484d', '#3e9bff', '#46a758', '#f5a524', '#a855f7', '#14b8a6', '#ec4899', '#eab308'];
export const maskSwatch = (index: number): string => MASK_SWATCHES[index % MASK_SWATCHES.length] ?? '#e5484d';

/** Local adjustments all at zero. */
export const DEFAULT_LOCAL_ADJUSTMENTS: LocalAdjustments = Object.freeze(LocalAdjustmentsSchema.parse({}));

export const isAdjustmentsDefault = (a: LocalAdjustments): boolean => deepEqual(a, DEFAULT_LOCAL_ADJUSTMENTS);

// ---------- factories ----------

/** A new mask holding one component, every local adjustment at zero. */
export function newMask(name: string, component: DevelopMaskComponent, id: string = newId()): DevelopMask {
  return {
    id,
    name,
    enabled: true,
    invert: false,
    opacity: 100,
    feather: 0,
    components: [component],
    adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS },
  };
}

const base = (mode: ComponentMode = 'add') => ({ id: newId(), mode, invert: false });

export function newBrushComponent(strokes: BrushStroke[] = [], mode?: ComponentMode): BrushComponent {
  return { ...base(mode), kind: 'brush', strokes };
}

export function newLinear(from: DevelopPoint, to: DevelopPoint, mode?: ComponentMode): LinearComponent {
  return { ...base(mode), kind: 'linear', from, to };
}

export function newRadial(
  center: DevelopPoint,
  radii: DevelopPoint,
  mode?: ComponentMode,
  angle = 0,
  feather = 50,
): RadialComponent {
  return { ...base(mode), kind: 'radial', center, radii, angle, feather };
}

export function newLuminance(
  range: [number, number] = [0.5, 1],
  mode?: ComponentMode,
  feather = 25,
): LuminanceComponent {
  return { ...base(mode), kind: 'luminance', range, feather };
}

export function newColor(samples: string[] = [], mode?: ComponentMode, tolerance = 50): ColorComponent {
  return { ...base(mode), kind: 'color', samples, tolerance };
}

/** The near … far bounds a new Depth range component starts with (0 near, 1 far). */
export const DEPTH_RANGE_DEFAULT: [number, number] = [0, 0.35];

/**
 * A new AI component. `model` and `modelVersion` stay empty: `generateAiMask` stamps them (or `stampAi` does, with
 * the registry, to look a cached raster up). Depth starts with `DEPTH_RANGE_DEFAULT`.
 */
export function newAi(target: AiMaskTarget, mode?: ComponentMode, prompts: MaskPrompt[] = []): AiComponent {
  const c: AiComponent = { ...base(mode), kind: 'ai', target, model: '', modelVersion: '', prompts };
  if (target === 'depth') c.depthRange = [...DEPTH_RANGE_DEFAULT];
  return c;
}

/** A fresh copy of a mask with new ids for it and its components (Duplicate). */
export function cloneMask(mask: DevelopMask, name: string): DevelopMask {
  return {
    ...structuredClone(mask),
    id: newId(),
    name,
    components: mask.components.map((c) => ({ ...structuredClone(c), id: newId() })),
  };
}

// ---------- names ----------

export const COMPONENT_LABEL: Record<DevelopMaskComponent['kind'], string> = {
  brush: 'Brush',
  linear: 'Linear gradient',
  radial: 'Radial gradient',
  luminance: 'Luminance range',
  color: 'Color range',
  ai: 'AI',
};

/** The AI targets in the menus' order, with their labels. */
export const AI_TARGETS_ORDER = ['subject', 'sky', 'background', 'people', 'depth'] as const satisfies AiMaskTarget[];
export const AI_TARGET_LABEL: Record<AiMaskTarget, string> = {
  subject: 'Subject',
  sky: 'Sky',
  background: 'Background',
  people: 'People',
  depth: 'Depth range',
};

/** What the busy row says while a target runs ("Finding the subject…"). */
export const AI_TARGET_BUSY: Record<AiMaskTarget, string> = {
  subject: 'Finding the subject',
  sky: 'Finding the sky',
  background: 'Finding the background',
  people: 'Finding people',
  depth: 'Estimating depth',
};

/** Targets SAM can refine with click and box prompts. */
export const isPromptable = (target: AiMaskTarget): boolean =>
  target === 'subject' || target === 'background' || target === 'people';

/** A People component made for one person: it carries a positive box prompt. */
export const isPersonComponent = (c: DevelopMaskComponent): boolean =>
  c.kind === 'ai' && c.target === 'people' && c.prompts.some((p) => p.kind === 'box' && p.positive);

/** The name of a component in the panel: its kind, an AI target, or "Person n" for a per-person People component. */
export function componentLabel(c: DevelopMaskComponent, mask?: DevelopMask): string {
  if (c.kind !== 'ai') return COMPONENT_LABEL[c.kind];
  if (mask && isPersonComponent(c)) {
    const people = mask.components.filter(isPersonComponent);
    return `Person ${people.findIndex((p) => p.id === c.id) + 1}`;
  }
  return AI_TARGET_LABEL[c.target];
}

/** The name shown for a mask: its own, or "Mask n" (1-based) when blank. */
export const maskDisplayName = (mask: DevelopMask, index: number): string => mask.name.trim() || `Mask ${index + 1}`;

/** "Mask n" with the first n not taken by another mask. */
export function nextMaskName(masks: readonly DevelopMask[]): string {
  const taken = new Set(masks.map((m) => m.name.trim()));
  let n = masks.length + 1;
  while (taken.has(`Mask ${n}`)) n += 1;
  return `Mask ${n}`;
}

/** True when the component selects nothing yet (no paint, no colour sample). */
export function isComponentEmpty(c: DevelopMaskComponent): boolean {
  if (c.kind === 'brush') return !c.strokes.some((s) => !s.erase && s.points.length > 0);
  if (c.kind === 'color') return c.samples.length === 0;
  return false;
}

// ---------- AI components ----------

/** What the model registry says about a model (a subset of `ModelInfo`, so this module does not import Tauri). */
export interface RegistryModel {
  name: string;
  version: string;
  task: string;
  /** On-disk state (`ModelInfo.status`); absent counts as installed. */
  status?: { state: string };
}

const isInstalled = (m: RegistryModel): boolean => !m.status || m.status.state === 'installed';

/** The registry task of the model that generates `c` (the primary one), like `ai::segment::required_models`. */
export function aiPrimaryTask(c: AiComponent): string {
  if (isPromptable(c.target) && c.prompts.length > 0) return 'sam-encoder';
  if (c.target === 'subject' || c.target === 'background') return 'subject';
  if (c.target === 'people') return 'people-detect';
  return c.target;
}

/**
 * `c` with `model` / `modelVersion` set to the model that would generate it now (`stamp_model_in` in Rust): the one
 * its `model` names when that fits the task, else the task's first model. Subject and Background use BiRefNet lite
 * (`subject`), or the `subject-fast` model (U²-Netp) when only that one is installed. Null when the registry has no
 * model for it.
 */
export function stampAi(c: AiComponent, models: readonly RegistryModel[]): AiComponent | null {
  const task = aiPrimaryTask(c);
  let m = models.find((x) => x.name === c.model && x.task === task) ?? models.find((x) => x.task === task);
  if (task === 'subject' && m && !isInstalled(m)) {
    m = models.find((x) => x.task === 'subject-fast' && isInstalled(x)) ?? m;
  }
  return m ? { ...c, model: m.name, modelVersion: m.version } : null;
}

/** True when the registry would generate `c` with another model or version than the one it was made with. */
export function isAiOutdated(c: AiComponent, models: readonly RegistryModel[]): boolean {
  const now = stampAi(c, models);
  return now !== null && (now.model !== c.model || now.modelVersion !== c.modelVersion);
}

/** A screen-space press turned into a prompt: a point, or a box when dragged (corners sorted). */
export function promptFrom(a: DevelopPoint, b: DevelopPoint | null, positive: boolean): MaskPrompt {
  if (!b) return { kind: 'point', point: a, positive };
  return {
    kind: 'box',
    box: [
      [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
    ],
    positive,
  };
}

/** True when no component of the mask selects anything. */
export const isMaskEmpty = (mask: DevelopMask): boolean => mask.components.every(isComponentEmpty);

// ---------- frame metric and strokes ----------

/** Frame width and height in units of its short side (the frame-metric the brush and the overlay measure in). */
export interface FrameMetric {
  sx: number;
  sy: number;
}

/** `ia` = frame width / height. */
export function frameMetric(ia: number): FrameMetric {
  const a = Number.isFinite(ia) && ia > 0 ? ia : 1;
  const short = Math.min(a, 1);
  return { sx: a / short, sy: 1 / short };
}

/** Distance between two frame points in short-side units. */
export function frameDistance(a: DevelopPoint, b: DevelopPoint, m: FrameMetric): number {
  return Math.hypot((b[0] - a[0]) * m.sx, (b[1] - a[1]) * m.sy);
}

/** Minimum spacing between recorded stroke points: an eighth of the brush radius, in short-side units. */
export const strokeSpacing = (size: number): number => Math.max((size / 100) * 0.5 * 0.125, 0.0005);

/**
 * `points` with `p` appended when it is at least `minSpacing` (short-side units) from the last point; the first
 * point is always taken. Returns the same array when `p` is too close.
 */
export function appendStrokePoint(
  points: readonly DevelopPoint[],
  p: DevelopPoint,
  minSpacing: number,
  m: FrameMetric,
): DevelopPoint[] {
  const last = points[points.length - 1];
  if (last && frameDistance(last, p, m) < minSpacing) return points as DevelopPoint[];
  return [...points, p];
}

function segmentDistance(p: DevelopPoint, a: DevelopPoint, b: DevelopPoint, m: FrameMetric): number {
  const ax = a[0] * m.sx;
  const ay = a[1] * m.sy;
  const dx = b[0] * m.sx - ax;
  const dy = b[1] * m.sy - ay;
  const px = p[0] * m.sx - ax;
  const py = p[1] * m.sy - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(Math.max((px * dx + py * dy) / len2, 0), 1) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

/**
 * Ramer-Douglas-Peucker: drop points that stay within `tolerance` (short-side units) of the simplified polyline.
 * Keeps the end points; strokes of up to two points come back as they are.
 */
export function simplifyStroke(points: readonly DevelopPoint[], tolerance: number, m: FrameMetric): DevelopPoint[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    const a = points[lo] as DevelopPoint;
    const b = points[hi] as DevelopPoint;
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segmentDistance(points[i] as DevelopPoint, a, b, m);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at > 0 && worst > tolerance) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** The simplification tolerance for a finished stroke: 5 % of the brush radius. */
export const strokeTolerance = (size: number): number => (size / 100) * 0.5 * 0.05;

/** A finished stroke: simplified, with the brush settings it was painted with. */
export function finishStroke(
  points: readonly DevelopPoint[],
  brush: { size: number; feather: number; flow: number; erase: boolean },
  m: FrameMetric,
): BrushStroke {
  return {
    points: simplifyStroke(points, strokeTolerance(brush.size), m),
    size: brush.size,
    feather: brush.feather,
    flow: brush.flow,
    erase: brush.erase,
  };
}

// ---------- frame ↔ crop ----------

/**
 * Where the developed (cropped) picture comes from in the transformed, uncropped frame: the frame size in pixels,
 * and the matrix from frame fractions to crop fractions (0..1 across the developed picture), i.e. the render's
 * frame-to-output similarity (`GeometryPlan::frame_to_output_matrix`, the crop actually used and the straighten
 * turn about its centre) normalised to the output. `toFrame` is its inverse.
 */
export interface CropMapping {
  fw: number;
  fh: number;
  /** Developed picture aspect (width / height). */
  aspect: number;
  /** Frame px per crop width: the crop is `cw × ch` frame px. */
  cw: number;
  ch: number;
  /** Straighten angle used, degrees clockwise: the frame turns by it on the way to the picture. */
  angle: number;
  toCrop: Mat3;
  toFrame: Mat3;
}

export function cropMapping(g: DevelopGeometry, size: SourceSize): CropMapping {
  const plan = geometryPlan(g, size.width, size.height, null);
  const [fw, fh] = g.rotate === 90 || g.rotate === 270 ? [size.height, size.width] : [size.width, size.height];
  const W = Math.max(fw, 1);
  const H = Math.max(fh, 1);
  const { crop, angle } = plan;
  const cw = crop.w * W;
  const ch = crop.h * H;
  let m = scale(W, H);
  m = andThen(m, rotateAbout((angle * Math.PI) / 180, (crop.x + crop.w / 2) * W, (crop.y + crop.h / 2) * H));
  m = andThen(m, translate(-crop.x * W, -crop.y * H));
  m = andThen(m, scale(1 / cw, 1 / ch));
  return { fw: W, fh: H, aspect: cw / ch, cw, ch, angle, toCrop: m, toFrame: invert(m) ?? m };
}

// ---------- approximation ----------

const smoothstep = (e0: number, e1: number, x: number): number => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Components the approximation can draw; luminance, colour and AI need the image (the Rust overlay draws them). */
export const canApproximate = (mask: DevelopMask): boolean =>
  mask.components.every((c) => c.kind === 'brush' || c.kind === 'linear' || c.kind === 'radial');

/**
 * A quick rasterisation of `mask` (brush, linear and radial components only) onto a `gw × gh` grid over the
 * developed picture, with the README's maths in frame pixels: linear smoothstep from → to, radial ellipse with its
 * feather band inside the edge, brush strokes as capsules (distance to the polyline) combined by max with their
 * flow, erase subtracting. Composited (add max, subtract, intersect min), the mask inverted, feathered (three box
 * passes approximating the Gaussian) and scaled by opacity. Null when a component needs the image.
 */
export function approximateMask(mask: DevelopMask, map: CropMapping, gw: number, gh: number): Float32Array | null {
  if (!canApproximate(mask) || gw <= 0 || gh <= 0) return null;
  const n = gw * gh;
  // Frame px of each grid pixel centre.
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const [u, v] = applyMat(map.toFrame, [(i + 0.5) / gw, (j + 0.5) / gh]);
      px[j * gw + i] = u * map.fw;
      py[j * gw + i] = v * map.fh;
    }
  }
  const short = Math.min(map.fw, map.fh);
  // Frame px per grid px (the mapping is a similarity).
  const gridPx = map.cw / gw;
  const acc = new Float32Array(n);
  const comp = new Float32Array(n);
  mask.components.forEach((c, ci) => {
    comp.fill(0);
    if (c.kind === 'linear') {
      const fx = c.from[0] * map.fw;
      const fy = c.from[1] * map.fh;
      const dx = c.to[0] * map.fw - fx;
      const dy = c.to[1] * map.fh - fy;
      const len2 = dx * dx + dy * dy;
      for (let k = 0; k < n; k++) {
        const t = len2 > 0 ? (((px[k] ?? 0) - fx) * dx + ((py[k] ?? 0) - fy) * dy) / len2 : 0;
        comp[k] = smoothstep(0, 1, t);
      }
    } else if (c.kind === 'radial') {
      const cx = c.center[0] * map.fw;
      const cy = c.center[1] * map.fh;
      const rx = Math.max(c.radii[0] * map.fw, 1e-6);
      const ry = Math.max(c.radii[1] * map.fh, 1e-6);
      const phi = (c.angle * Math.PI) / 180;
      const co = Math.cos(phi);
      const si = Math.sin(phi);
      const f = Math.min(Math.max(c.feather / 100, 0), 1);
      for (let k = 0; k < n; k++) {
        const ex = (px[k] ?? 0) - cx;
        const ey = (py[k] ?? 0) - cy;
        const lx = ex * co + ey * si;
        const ly = -ex * si + ey * co;
        const d = Math.hypot(lx / rx, ly / ry);
        comp[k] = d >= 1 ? 0 : f <= 0 ? 1 : 1 - smoothstep(1 - f, 1, d);
      }
    } else if (c.kind === 'brush') {
      const stroke = new Float32Array(n);
      for (const s of c.strokes) {
        if (s.points.length === 0) continue;
        stroke.fill(0);
        const r = Math.max(((s.size / 100) * short) / 2, 1e-6);
        const band = Math.min(Math.max((s.feather / 100) * r, gridPx, 1), r);
        const flow = Math.min(Math.max(s.flow / 100, 0), 1);
        const pts = s.points.map(([x, y]) => [x * map.fw, y * map.fh] as const);
        const segs = pts.length === 1 ? [[pts[0], pts[0]] as const] : pts.slice(1).map((p, i) => [pts[i], p] as const);
        for (const [a, b] of segs) {
          if (!a || !b) continue;
          // Grid pixels near the segment: bound in crop space through the four corners of its box.
          const minX = Math.min(a[0], b[0]) - r;
          const maxX = Math.max(a[0], b[0]) + r;
          const minY = Math.min(a[1], b[1]) - r;
          const maxY = Math.max(a[1], b[1]) + r;
          let i0 = gw;
          let i1 = -1;
          let j0 = gh;
          let j1 = -1;
          for (const [x, y] of [
            [minX, minY],
            [maxX, minY],
            [minX, maxY],
            [maxX, maxY],
          ] as const) {
            const [u, v] = applyMat(map.toCrop, [x / map.fw, y / map.fh]);
            i0 = Math.min(i0, Math.floor(u * gw));
            i1 = Math.max(i1, Math.ceil(u * gw));
            j0 = Math.min(j0, Math.floor(v * gh));
            j1 = Math.max(j1, Math.ceil(v * gh));
          }
          i0 = Math.max(i0, 0);
          j0 = Math.max(j0, 0);
          i1 = Math.min(i1, gw - 1);
          j1 = Math.min(j1, gh - 1);
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const k = j * gw + i;
              const qx = (px[k] ?? 0) - a[0];
              const qy = (py[k] ?? 0) - a[1];
              const t = len2 > 0 ? Math.min(Math.max((qx * dx + qy * dy) / len2, 0), 1) : 0;
              const d = Math.hypot(qx - t * dx, qy - t * dy);
              if (d >= r) continue;
              const cov = (1 - smoothstep(r - band, r, d)) * flow;
              if (cov > (stroke[k] ?? 0)) stroke[k] = cov;
            }
          }
        }
        for (let k = 0; k < n; k++) {
          const v = stroke[k] ?? 0;
          if (v <= 0) continue;
          comp[k] = s.erase ? Math.max(0, (comp[k] ?? 0) - v) : Math.max(comp[k] ?? 0, v);
        }
      }
    }
    for (let k = 0; k < n; k++) {
      const v = c.invert ? 1 - (comp[k] ?? 0) : (comp[k] ?? 0);
      const a = acc[k] ?? 0;
      if (ci === 0 || c.mode === 'add') acc[k] = ci === 0 ? v : Math.max(a, v);
      else if (c.mode === 'subtract') acc[k] = Math.max(0, a - v);
      else acc[k] = Math.min(a, v);
    }
  });
  if (mask.invert) for (let k = 0; k < n; k++) acc[k] = 1 - (acc[k] ?? 0);
  const sigma = ((mask.feather / 100) * 0.02 * short) / gridPx;
  if (sigma > 0.3) boxBlur3(acc, gw, gh, sigma);
  const opacity = Math.min(Math.max(mask.opacity / 100, 0), 1);
  if (opacity < 1) for (let k = 0; k < n; k++) acc[k] = (acc[k] ?? 0) * opacity;
  return acc;
}

/** Three box passes in each direction approximating a Gaussian of `sigma` grid px (clamped edges). */
function boxBlur3(plane: Float32Array, w: number, h: number, sigma: number): void {
  const r = Math.max(Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2), 1);
  const tmp = new Float32Array(plane.length);
  const pass = (src: Float32Array, dst: Float32Array, len: number, lines: number, stride: number, step: number) => {
    for (let l = 0; l < lines; l++) {
      const o = l * stride;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[o + Math.min(Math.max(k, 0), len - 1) * step] ?? 0;
      for (let k = 0; k < len; k++) {
        dst[o + k * step] = sum / (2 * r + 1);
        sum += (src[o + Math.min(k + r + 1, len - 1) * step] ?? 0) - (src[o + Math.max(k - r, 0) * step] ?? 0);
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(plane, tmp, w, h, w, 1);
    pass(tmp, plane, h, w, 1, w);
  }
}

// ---------- picking ----------

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** The sRGB-encoded relative luminance (Rec.2020 / CIE `Y`) of an 8-bit sRGB colour, 0..1, as the luminance mask reads it. */
export function encodedLuminance(r: number, g: number, b: number): number {
  const y = 0.2126 * linear(r / 255) + 0.7152 * linear(g / 255) + 0.0722 * linear(b / 255);
  return Math.min(Math.max(encode(y), 0), 1);
}

export const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(Math.max(v, 0), 255))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Lightroom keeps at most five colour samples. */
export const MAX_COLOR_SAMPLES = 5;

/** A luminance range around a picked value: ± 0.1, inside 0..1. */
export const rangeAround = (l: number, half = 0.1): [number, number] => [
  Math.max(0, Math.round((l - half) * 1000) / 1000),
  Math.min(1, Math.round((l + half) * 1000) / 1000),
];

/** `range` widened to include `l`. */
export const extendRange = (range: readonly [number, number], l: number): [number, number] => [
  Math.min(range[0], range[1], l),
  Math.max(range[0], range[1], l),
];
