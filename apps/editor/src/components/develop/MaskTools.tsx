import {
  type DevelopMaskComponent,
  type DevelopPoint,
  type DevelopSettings,
  type MaskPrompt,
  newId,
} from '@photobook/shared';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceSize } from '../../lib/develop/cropEdit';
import { applyMat } from '../../lib/develop/geometry';
import {
  appendStrokePoint,
  type CropMapping,
  cropMapping,
  encodedLuminance,
  extendRange,
  finishStroke,
  frameMetric,
  isPromptable,
  type LinearComponent,
  MAX_COLOR_SAMPLES,
  newBrushComponent,
  newLinear,
  newMask,
  newRadial,
  nextMaskName,
  promptFrom,
  type RadialComponent,
  rangeAround,
  strokeSpacing,
  TOOL_LABEL,
  toHex,
} from '../../lib/develop/masks';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from '../../store/book';
import { assetDevelop } from '../../store/library';
import { type DevelopMaskTool, useUiStore } from '../../store/ui';
import { isEditableTarget } from '../editor/gestures';
import { dialogOpen } from '../ui/DialogShell';
import { frameLayout, useBoxSize } from './CropTool';
import { MaskContextMenu, useMaskContextMenu } from './MaskMenu';
import { AngleBadge, HANDLE_R, MaskOverlay, overlayKey, ROTATE_GAP, RotateHandle, useMaskOverlay } from './MaskOverlay';
import { addRefinePrompt, useAiMaskStore } from './useAiMask';
import type { PreviewSource } from './usePreview';

type Pt = [number, number];

/** Screen px a press must travel before a gradient drag creates or redraws a shape. */
const MIN_DRAG = 4;
/** While painting, the stroke reaches the store (and so the live render) at most this often. */
const STROKE_FLUSH_MS = 40;
/** Plan 56: Shift snaps a rotation to this step, degrees. */
const ROTATE_SNAP = 15;

/** `rad` to the nearest `ROTATE_SNAP` step, radians. */
function snapAngle(rad: number): number {
  const step = (ROTATE_SNAP * Math.PI) / 180;
  return Math.round(rad / step) * step;
}

/** A line's angle in (-90°, 90°] (a line at 180° is the same line at 0°). */
function lineAngle(deg: number): number {
  let a = ((deg % 180) + 180) % 180;
  if (a > 90) a -= 180;
  return Math.round(a * 10) / 10;
}

type Drag =
  | {
      kind: 'brush';
      pointerId: number;
      maskId: string;
      componentId: string;
      points: DevelopPoint[];
      brush: { size: number; feather: number; flow: number; erase: boolean };
      timer: ReturnType<typeof setTimeout> | null;
    }
  | { kind: 'new'; tool: 'linear' | 'radial'; pointerId: number; x0: number; y0: number; target: string | null }
  | { kind: 'prompt'; pointerId: number; x0: number; y0: number; positive: boolean }
  | {
      kind: 'linear';
      pointerId: number;
      handle: 'from' | 'to' | 'mid' | 'rotate';
      start: LinearComponent;
      p0: DevelopPoint;
      s0: Pt;
    }
  | {
      kind: 'radial';
      pointerId: number;
      handle: 'move' | 'rx' | 'ry' | 'rotate';
      start: RadialComponent;
      p0: DevelopPoint;
      s0: Pt;
    };

/** Screen-space mapping of the developed picture: frame fractions ↔ px inside the overlay box. */
export interface MaskScreen {
  mapping: CropMapping;
  /** The developed picture on screen. */
  rect: { left: number; top: number; width: number; height: number };
  /** Screen px per frame px. */
  k: number;
  toScreen: (p: readonly [number, number]) => Pt;
  toFrame: (x: number, y: number) => DevelopPoint;
}

/**
 * The frame ↔ screen mapping the mask tools use: the transformed, uncropped frame (where masks live) → the developed
 * picture through the crop and straighten (`cropMapping`, the render's frame-to-output map) → the picture as the
 * Develop image shows it (`object-contain` inside the `CROP_MARGIN`, i.e. `frameLayout` with the crop's aspect).
 */
export function maskScreen(mapping: CropMapping, width: number, height: number): MaskScreen {
  const l = frameLayout(width, height, mapping.aspect);
  return {
    mapping,
    rect: { left: l.ox, top: l.oy, width: l.fw, height: l.fh },
    k: l.fw / mapping.cw,
    toScreen: (p) => {
      const [u, v] = applyMat(mapping.toCrop, p);
      return [l.ox + u * l.fw, l.oy + v * l.fh];
    },
    toFrame: (x, y) => applyMat(mapping.toFrame, [(x - l.ox) / l.fw, (y - l.oy) / l.fh]),
  };
}

/** A radial component on screen: centre, the two semi-axis vectors (px) and the rotation of the first, degrees. */
export function radialOnScreen(
  c: RadialComponent,
  s: MaskScreen,
): { centre: Pt; a: Pt; b: Pt; rx: number; ry: number; deg: number } {
  const { fw, fh } = s.mapping;
  const phi = (c.angle * Math.PI) / 180;
  const co = Math.cos(phi);
  const si = Math.sin(phi);
  const centre = s.toScreen(c.center);
  const p1 = s.toScreen([c.center[0] + c.radii[0] * co, c.center[1] + (c.radii[0] * fw * si) / fh]);
  const p2 = s.toScreen([c.center[0] - (c.radii[1] * fh * si) / fw, c.center[1] + c.radii[1] * co]);
  const a: Pt = [p1[0] - centre[0], p1[1] - centre[1]];
  const b: Pt = [p2[0] - centre[0], p2[1] - centre[1]];
  return { centre, a, b, rx: Math.hypot(...a), ry: Math.hypot(...b), deg: (Math.atan2(a[1], a[0]) * 180) / Math.PI };
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      if (!url.startsWith('blob:') && !url.startsWith('data:')) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imageCache.set(url, p);
    if (imageCache.size > 8) imageCache.delete(imageCache.keys().next().value ?? '');
  }
  return p;
}

/**
 * The mean 8-bit sRGB colour of a 5×5 patch of the picture at `(u, v)` (fractions of the shown, developed image),
 * read through a canvas; null when the image cannot be read (not loaded, or a cross-origin proxy taints the canvas).
 */
export async function samplePicture(url: string, u: number, v: number): Promise<[number, number, number] | null> {
  const img = await loadImage(url);
  if (!img?.naturalWidth || !img.naturalHeight) return null;
  const x = Math.min(Math.max(Math.floor(u * img.naturalWidth), 0), img.naturalWidth - 1);
  const y = Math.min(Math.max(Math.floor(v * img.naturalHeight), 0), img.naturalHeight - 1);
  const x0 = Math.max(x - 2, 0);
  const y0 = Math.max(y - 2, 0);
  const w = Math.min(5, img.naturalWidth - x0);
  const h = Math.min(5, img.naturalHeight - y0);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const sum = [0, 0, 0];
    for (let k = 0; k < w * h; k++) for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (px[k * 4 + c] ?? 0);
    return [(sum[0] ?? 0) / (w * h), (sum[1] ?? 0) / (w * h), (sum[2] ?? 0) / (w * h)];
  } catch (err) {
    devLog('develop', 'mask picker could not read the picture', { error: errorMessage(err) });
    return null;
  }
}

export interface MaskToolsProps {
  assetId: string;
  settings: DevelopSettings;
  /** Upright source size. */
  size: SourceSize;
  /** The picture shown (live render, else the cached proxy): what the luminance and colour pickers sample. */
  sampleUrl: string | undefined;
  /** For the Rust overlay request. */
  source: PreviewSource;
}

/**
 * The Masks section's tools over the developed picture (step D4.1), and the red overlay of the selected mask.
 *
 * Shapes are stored in fractions of the transformed, uncropped frame (`maskScreen` maps them through the crop and
 * straighten to the screen). Brush: drag to paint (Alt or the Erase toggle erases), points recorded at an eighth of
 * the radius and simplified on release; the stroke streams into the store during the drag, which is one undo step.
 * Linear gradient (plan 56, the Lightroom convention): the effect is full where the drag presses and fades toward
 * where it is released, so a new one stores `from` = the release and `to` = the press (the rasteriser is 1 at `to`);
 * then drag the end handles, the centre one to move it, or the rotate handle on its 50 % line (Shift: 15° steps).
 * Masks drawn before keep their stored points and render unchanged. Radial gradient: drag out from the centre
 * (Shift: a circle), then drag the axis handles, the rotation handle above it (Shift: 15° steps), or inside to move
 * it; both rotate handles share `RotateHandle` and show the angle in a mono badge while turning. Right-click opens
 * the mask's menu (`MaskContextMenu`); Delete / Backspace with a mask selected and no component removes the mask
 * (`DevelopMode` removes a selected component), one undo step, never while a text field has the focus. Dragging on empty space with a shape selected starts a new mask, as in
 * Lightroom. Luminance and colour range: click to sample the picture (Shift-click extends the range or adds a
 * sample). Refine (an AI component selected, D4.3): click adds a positive point prompt, Alt-click a negative one,
 * a drag draws a box; each runs SAM (`addRefinePrompt`) and the prompts show as dots and boxes. While an AI job
 * rewrites the shown mask its tint is hidden and a "Generating…" chip shows instead. Each drag or click is one undo
 * step; Escape (in `DevelopMode`) ends the tool.
 */
export function MaskTools({ assetId, settings, size, sampleUrl, source }: MaskToolsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(rootRef);
  const tool = useUiStore((s) => s.developMaskTool);
  const overlayOn = useUiStore((s) => s.maskOverlay);
  const brush = useUiStore((s) => s.maskBrush);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [altDown, setAltDown] = useState(false);
  /** The box being dragged by Refine, screen px. */
  const [promptBox, setPromptBox] = useState<[Pt, Pt] | null>(null);
  /** Plan 56: while a gradient rotates, where the pointer is and the angle shown in the badge. */
  const [rotating, setRotating] = useState<{ at: Pt; deg: number } | null>(null);
  const contextMenu = useMaskContextMenu();
  const aiJob = useAiMaskStore((s) => (s.job?.assetId === assetId ? s.job : null));

  const { geometry } = settings;
  const mapping = useMemo(() => cropMapping(geometry, size), [geometry, size]);
  const screen = useMemo(() => maskScreen(mapping, box.width, box.height), [mapping, box.width, box.height]);
  const mask = tool ? settings.masks.find((m) => m.id === tool.maskId) : undefined;
  const component = tool?.componentId ? mask?.components.find((c) => c.id === tool.componentId) : undefined;
  const active = tool?.tool ?? null;
  const ready = box.width > 0 && box.height > 0;
  const aiComponent = component?.kind === 'ai' && isPromptable(component.target) ? component : undefined;
  // Prompts of a refine in flight for the selected component, else its stored ones.
  const prompts =
    aiComponent && mask
      ? aiJob?.kind === 'refine' && aiJob.componentId === aiComponent.id && aiJob.prompts
        ? aiJob.prompts
        : aiComponent.prompts
      : [];
  /** An AI job is rewriting the mask shown: its tint is stale. */
  const generating = aiJob !== null && mask !== undefined && aiJob.maskId === mask.id;

  const rendered = useMaskOverlay(source, settings, mask?.id ?? null, overlayOn && mask !== undefined);
  const currentKey = useMemo(() => overlayKey(mask, settings), [mask, settings]);

  // A drag cut short by unmounting (stepping, closing) still ends its undo step.
  useEffect(
    () => () => {
      const d = drag.current;
      if (d?.kind === 'brush' && d.timer) clearTimeout(d.timer);
      if (d) endDevelopDrag();
      drag.current = null;
    },
    [],
  );

  // Alt shows the erase cursor while painting is possible.
  useEffect(() => {
    if (active !== 'brush') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltDown(e.type === 'keydown');
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [active]);

  // Plan 56: Delete / Backspace with a mask selected and no component removes the mask (one undo step). A selected
  // component is `DevelopMode`'s (its capture listener stops the key first); a text field or a slider keeps its keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      // A dialog (Sync, Import, Presets, the AI model download) owns every key while it is open.
      if (dialogOpen()) return;
      if (e.target instanceof Element && e.target.closest('[role="slider"], [role="menu"]')) return;
      const t = useUiStore.getState().developMaskTool;
      if (!useUiStore.getState().developMasks || !t || t.componentId || t.create) return;
      if (!assetDevelop(useBookStore.getState(), assetId)?.masks.some((m) => m.id === t.maskId)) return;
      e.preventDefault();
      useBookStore.getState().removeMask(assetId, t.maskId);
      useUiStore.getState().setDevelopMaskTool(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assetId]);

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
  };
  const store = () => useBookStore.getState();
  const ui = () => useUiStore.getState();

  /**
   * Put a newly drawn component where the tool says: a new mask (`create: 'new'`, keeping the tool's mask id), a
   * new component of the selected mask with the tool's mode, or a new mask when the tool is editing a shape already.
   */
  const place = (c: DevelopMaskComponent, t: DevelopMaskTool): { maskId: string; componentId: string } => {
    const masks = assetDevelop(store(), assetId)?.masks ?? [];
    let maskId = t.maskId;
    if (t.create && t.create !== 'new' && masks.some((m) => m.id === t.maskId)) {
      store().addMaskComponent(assetId, t.maskId, { ...c, mode: t.create });
    } else {
      const m = newMask(nextMaskName(masks), c, t.create === 'new' ? t.maskId : undefined);
      store().addMask(assetId, m);
      maskId = m.id;
    }
    ui().setDevelopMaskTool({ maskId, componentId: c.id, tool: t.tool });
    return { maskId, componentId: c.id };
  };

  const flushStroke = (d: Extract<Drag, { kind: 'brush' }>) => {
    d.timer = null;
    store().setLastBrushStroke(assetId, d.maskId, d.componentId, { ...d.brush, points: d.points });
  };

  const pick = async (t: DevelopMaskTool, x: number, y: number, extend: boolean) => {
    if (!sampleUrl || !component || (component.kind !== 'luminance' && component.kind !== 'color')) return;
    const u = (x - screen.rect.left) / screen.rect.width;
    const v = (y - screen.rect.top) / screen.rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const rgb = await samplePicture(sampleUrl, u, v);
    if (!rgb) return;
    const now = assetDevelop(store(), assetId)?.masks.find((m) => m.id === t.maskId);
    const c = now?.components.find((cc) => cc.id === component.id);
    if (!c) return;
    if (c.kind === 'luminance') {
      const l = encodedLuminance(...rgb);
      const range = extend ? extendRange(c.range, l) : rangeAround(l);
      store().updateComponent(assetId, t.maskId, c.id, { range });
    } else if (c.kind === 'color') {
      const hex = toHex(...rgb);
      const samples = extend ? [...c.samples, hex].slice(-MAX_COLOR_SAMPLES) : [hex];
      store().updateComponent(assetId, t.maskId, c.id, { samples });
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = ui().developMaskTool;
    if (e.button !== 0 || drag.current || !ready || !t?.tool) return;
    const target = e.target as Element;
    if (target.closest('button')) return;
    e.preventDefault();
    const [x, y] = local(e);
    const p = screen.toFrame(x, y);

    if (t.tool === 'refine') {
      if (!aiComponent || !insidePicture(x, y)) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { kind: 'prompt', pointerId: e.pointerId, x0: x, y0: y, positive: !e.altKey };
      return;
    }
    if (t.tool === 'luminance' || t.tool === 'color') {
      void pick(t, x, y, e.shiftKey);
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (t.tool === 'brush') {
      const b = { ...ui().maskBrush };
      b.erase = b.erase !== e.altKey;
      const stroke = { ...b, points: [p] };
      beginDevelopDrag();
      let ids: { maskId: string; componentId: string };
      if (!t.create && component?.kind === 'brush' && mask) {
        store().appendBrushStroke(assetId, mask.id, component.id, stroke);
        ids = { maskId: mask.id, componentId: component.id };
      } else ids = place(newBrushComponent([stroke]), t);
      drag.current = { kind: 'brush', pointerId: e.pointerId, ...ids, points: [p], brush: b, timer: null };
      return;
    }

    const handle = target.closest('[data-mask-handle]')?.getAttribute('data-mask-handle');
    if (
      handle &&
      component?.kind === 'linear' &&
      (handle === 'from' || handle === 'to' || handle === 'mid' || handle === 'rotate')
    ) {
      beginDevelopDrag();
      drag.current = { kind: 'linear', pointerId: e.pointerId, handle, start: component, p0: p, s0: [x, y] };
      return;
    }
    if (
      handle &&
      component?.kind === 'radial' &&
      (handle === 'move' || handle === 'rx' || handle === 'ry' || handle === 'rotate')
    ) {
      beginDevelopDrag();
      drag.current = { kind: 'radial', pointerId: e.pointerId, handle, start: component, p0: p, s0: [x, y] };
      return;
    }
    beginDevelopDrag();
    drag.current = { kind: 'new', tool: t.tool, pointerId: e.pointerId, x0: x, y0: y, target: null };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const [x, y] = local(e);
    if (active === 'brush') setHover([x, y]);
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.kind === 'prompt') {
      if (Math.hypot(x - d.x0, y - d.y0) >= MIN_DRAG) setPromptBox([[d.x0, d.y0], clampToPicture(x, y)]);
      return;
    }
    const p = screen.toFrame(x, y);
    const s = store();

    if (d.kind === 'brush') {
      const metric = frameMetric(mapping.fw / mapping.fh);
      const next = appendStrokePoint(d.points, p, strokeSpacing(d.brush.size), metric);
      if (next === d.points) return;
      d.points = next;
      if (!d.timer) d.timer = setTimeout(() => flushStroke(d), STROKE_FLUSH_MS);
      return;
    }
    if (d.kind === 'linear' && d.handle === 'rotate') {
      // Turn both ends about their midpoint on screen (the frame ↔ screen map is affine), then back to the frame.
      const a = screen.toScreen(d.start.from);
      const b = screen.toScreen(d.start.to);
      const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let turn = Math.atan2(y - mid[1], x - mid[0]) - Math.atan2(d.s0[1] - mid[1], d.s0[0] - mid[0]);
      const dir0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (e.shiftKey) turn = snapAngle(dir0 + turn) - dir0;
      const co = Math.cos(turn);
      const si = Math.sin(turn);
      const spin = (q: Pt): DevelopPoint =>
        screen.toFrame(
          mid[0] + (q[0] - mid[0]) * co - (q[1] - mid[1]) * si,
          mid[1] + (q[0] - mid[0]) * si + (q[1] - mid[1]) * co,
        );
      s.updateComponent(assetId, ui().developMaskTool?.maskId ?? '', d.start.id, { from: spin(a), to: spin(b) });
      // The badge shows the 50 % line's angle on screen, 0° level, in (-90°, 90°].
      setRotating({ at: [x, y], deg: lineAngle(((dir0 + turn) * 180) / Math.PI + 90) });
      return;
    }
    if (d.kind === 'linear') {
      const delta: Pt = [p[0] - d.p0[0], p[1] - d.p0[1]];
      const patch: Partial<Pick<LinearComponent, 'from' | 'to'>> =
        d.handle === 'mid'
          ? {
              from: [d.start.from[0] + delta[0], d.start.from[1] + delta[1]],
              to: [d.start.to[0] + delta[0], d.start.to[1] + delta[1]],
            }
          : d.handle === 'from'
            ? { from: p }
            : { to: p };
      s.updateComponent(assetId, ui().developMaskTool?.maskId ?? '', d.start.id, patch);
      return;
    }
    if (d.kind === 'radial') {
      const maskId = ui().developMaskTool?.maskId ?? '';
      const st = d.start;
      if (d.handle === 'move') {
        s.updateComponent(assetId, maskId, st.id, {
          center: [st.center[0] + p[0] - d.p0[0], st.center[1] + p[1] - d.p0[1]],
        });
        return;
      }
      const on = radialOnScreen(st, screen);
      const vx = x - on.centre[0];
      const vy = y - on.centre[1];
      if (d.handle === 'rotate') {
        const a0 = Math.atan2(d.s0[1] - on.centre[1], d.s0[0] - on.centre[0]);
        const a1 = Math.atan2(vy, vx);
        let angle = st.angle + ((a1 - a0) * 180) / Math.PI;
        // Shift snaps the angle seen on screen (the stored one plus the straighten turn), stored back in frame terms.
        if (e.shiftKey) angle = (snapAngle(((angle + mapping.angle) * Math.PI) / 180) * 180) / Math.PI - mapping.angle;
        angle = ((((angle + 180) % 360) + 360) % 360) - 180;
        angle = Math.round(angle * 100) / 100;
        s.updateComponent(assetId, maskId, st.id, { angle });
        const shown = ((((angle + mapping.angle + 180) % 360) + 360) % 360) - 180;
        setRotating({ at: [x, y], deg: Math.round(shown * 10) / 10 });
        return;
      }
      const axis = d.handle === 'rx' ? on.a : on.b;
      const len = Math.hypot(axis[0], axis[1]) || 1;
      const proj = Math.max(Math.abs((vx * axis[0] + vy * axis[1]) / len), 2);
      const frac = proj / screen.k / (d.handle === 'rx' ? mapping.fw : mapping.fh);
      s.updateComponent(assetId, maskId, st.id, {
        radii: d.handle === 'rx' ? [frac, st.radii[1]] : [st.radii[0], frac],
      });
      return;
    }
    // A new linear or radial shape.
    let dx = x - d.x0;
    let dy = y - d.y0;
    if (!d.target && Math.hypot(dx, dy) < MIN_DRAG) return;
    const t = ui().developMaskTool;
    if (!t) return;
    const from = screen.toFrame(d.x0, d.y0);
    if (d.tool === 'linear') {
      if (e.shiftKey) {
        // Snap to the nearest 45° on screen.
        const len = Math.hypot(dx, dy);
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        dx = len * Math.cos(a);
        dy = len * Math.sin(a);
      }
      const end = screen.toFrame(d.x0 + dx, d.y0 + dy);
      // Plan 56: full at the press (`to`, where the rasteriser is 1), fading toward the release (`from`).
      if (!d.target) {
        const created = place(newLinear(end, from), { ...t, create: t.create ?? 'new', ...newMaskIfEditing(t) });
        d.target = created.componentId;
      } else s.updateComponent(assetId, ui().developMaskTool?.maskId ?? '', d.target, { from: end });
      return;
    }
    if (e.shiftKey) {
      const r = Math.max(Math.abs(dx), Math.abs(dy));
      dx = r;
      dy = r;
    }
    const radii: DevelopPoint = [
      Math.max(Math.abs(dx), 2) / screen.k / mapping.fw,
      Math.max(Math.abs(dy), 2) / screen.k / mapping.fh,
    ];
    if (!d.target) {
      // Axis-aligned on screen: undo the straighten turn (never store -0).
      const c = newRadial(from, radii, undefined, -mapping.angle || 0);
      const created = place(c, { ...t, create: t.create ?? 'new', ...newMaskIfEditing(t) });
      d.target = created.componentId;
    } else s.updateComponent(assetId, ui().developMaskTool?.maskId ?? '', d.target, { radii });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setRotating(null);
    if (d.kind === 'prompt') {
      setPromptBox(null);
      const t = ui().developMaskTool;
      if (!t?.componentId || e.type === 'pointercancel') return;
      const [x, y] = local(e);
      const moved = Math.hypot(x - d.x0, y - d.y0) >= MIN_DRAG;
      const a = screen.toFrame(d.x0, d.y0);
      const b = moved ? screen.toFrame(...clampToPicture(x, y)) : null;
      // A box always selects (SAM ignores negative boxes); Alt makes a click exclude.
      addRefinePrompt(assetId, t.maskId, t.componentId, promptFrom(a, b, b ? true : d.positive));
      return;
    }
    if (d.kind === 'brush') {
      if (d.timer) clearTimeout(d.timer);
      const metric = frameMetric(mapping.fw / mapping.fh);
      store().setLastBrushStroke(assetId, d.maskId, d.componentId, finishStroke(d.points, d.brush, metric));
    }
    endDevelopDrag();
  };

  function insidePicture(x: number, y: number): boolean {
    const u = (x - screen.rect.left) / screen.rect.width;
    const v = (y - screen.rect.top) / screen.rect.height;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }
  function clampToPicture(x: number, y: number): Pt {
    const { left, top, width, height } = screen.rect;
    return [Math.min(Math.max(x, left), left + width), Math.min(Math.max(y, top), top + height)];
  }

  const brushRadius = ((brush.size / 100) * Math.min(mapping.fw, mapping.fh) * screen.k) / 2;
  const erasing = brush.erase !== altDown;
  // Plan 49: the drawing tools take the draw cursor (`styles.css`); the brush draws its own ring.
  const cursor = !active ? 'cursor-default' : active === 'brush' ? 'cursor-none' : 'cursor-draw';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: an active tool gives it the application role; idle it takes no events
    <div
      ref={rootRef}
      data-testid="mask-tools"
      data-tool={active ?? ''}
      {...(active ? { role: 'application', 'aria-label': `${TOOL_LABEL[active]} tool: ${HINT[active]}` } : {})}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => {
        // Plan 56: the mask under the tools (the selected one, its selected component) gets its menu.
        const t = ui().developMaskTool;
        if (!t || !mask) return;
        contextMenu.onContextMenu(e, { maskId: mask.id, componentId: t.componentId });
      }}
      className={`absolute inset-0 touch-none select-none overflow-hidden ${cursor} ${active ? '' : 'pointer-events-none'}`}
    >
      {ready && overlayOn && mask && (
        <MaskOverlay
          mask={mask}
          mapping={mapping}
          rect={screen.rect}
          rendered={rendered}
          currentKey={currentKey}
          generating={generating}
        />
      )}
      {ready && active === 'refine' && aiComponent && (
        <PromptMarks prompts={prompts} s={screen} box={promptBox} width={box.width} height={box.height} />
      )}
      {aiJob && (
        <span
          className="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg"
          data-testid="ai-generating"
        >
          <span
            className="size-2.5 animate-spin rounded-full border-2 border-fg/80 border-t-transparent"
            aria-hidden="true"
          />
          Generating…
        </span>
      )}
      {ready && (active === 'linear' || active === 'radial') && component && (
        <svg className="absolute inset-0 h-full w-full" width={box.width} height={box.height} aria-hidden="true">
          <defs>
            <clipPath id="mask-picture">
              <rect x={screen.rect.left} y={screen.rect.top} width={screen.rect.width} height={screen.rect.height} />
            </clipPath>
          </defs>
          {component.kind === 'linear' && (
            <LinearShape c={component} s={screen} span={box.width + box.height} box={box} />
          )}
          {component.kind === 'radial' && <RadialShape c={component} s={screen} />}
        </svg>
      )}
      {active === 'brush' && hover && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          width={box.width}
          height={box.height}
          aria-hidden="true"
          data-testid="brush-cursor"
        >
          <circle cx={hover[0]} cy={hover[1]} r={brushRadius} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
          <circle cx={hover[0]} cy={hover[1]} r={brushRadius} fill="none" stroke="white" strokeWidth={1} />
          <circle
            cx={hover[0]}
            cy={hover[1]}
            r={brushRadius * (1 - brush.feather / 100)}
            fill="none"
            stroke="white"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            x={hover[0]}
            y={hover[1]}
            dy="0.35em"
            textAnchor="middle"
            fontSize={12}
            fill="white"
            stroke="rgba(0,0,0,0.6)"
            strokeWidth={0.5}
          >
            {erasing ? '−' : '+'}
          </text>
        </svg>
      )}
      {rotating && <AngleBadge at={rotating.at} deg={rotating.deg} />}
      {contextMenu.menu && (
        <MaskContextMenu assetId={assetId} masks={settings.masks} menu={contextMenu.menu} onClose={contextMenu.close} />
      )}
      {active && (
        <span className="pointer-events-none absolute top-2 left-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
          {TOOL_LABEL[active]}: {HINT[active]}
        </span>
      )}
    </div>
  );

  /** With a shape already being edited, a drag on empty space starts a new mask (Lightroom's behaviour). */
  function newMaskIfEditing(t: DevelopMaskTool): Partial<DevelopMaskTool> {
    if (t.create) return {};
    return { create: 'new', maskId: newId() };
  }
}

const HINT: Record<NonNullable<DevelopMaskTool['tool']>, string> = {
  brush: 'drag to paint, Alt erases, [ ] size, Shift+[ ] feather, Esc ends',
  linear: 'drag to draw, drag the handles to adjust, Esc ends',
  radial: 'drag out from the centre (Shift: circle), drag the handles to adjust, Esc ends',
  luminance: 'click the photo to pick a tone (Shift-click extends the range), Esc ends',
  color: 'click the photo to pick a colour (Shift-click adds one), Esc ends',
  refine: 'click adds, Alt-click removes, drag draws a box, Delete takes the last back, Esc ends',
};

/** Refine's prompts over the picture: points (green adds, red removes), boxes, and the box being dragged. */
function PromptMarks({
  prompts,
  s,
  box,
  width,
  height,
}: {
  prompts: readonly MaskPrompt[];
  s: MaskScreen;
  box: [Pt, Pt] | null;
  width: number;
  height: number;
}) {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      width={width}
      height={height}
      aria-hidden="true"
      data-testid="refine-prompts"
    >
      {prompts.map((p, i) => {
        if (p.kind === 'point' && p.point) {
          const [x, y] = s.toScreen(p.point);
          return (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: prompts are only appended and removed from the end
              key={i}
              cx={x}
              cy={y}
              r={5}
              fill={p.positive ? '#46a758' : '#e5484d'}
              stroke="white"
              strokeWidth={1.5}
              data-prompt={p.positive ? 'positive' : 'negative'}
            />
          );
        }
        if (p.kind === 'box' && p.box) {
          const [[x0, y0], [x1, y1]] = p.box;
          const corners = [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ] as const;
          const points = corners.map((c) => s.toScreen(c).join(',')).join(' ');
          return (
            <g
              // biome-ignore lint/suspicious/noArrayIndexKey: prompts are only appended and removed from the end
              key={i}
              data-prompt="box"
            >
              <polygon points={points} fill="none" stroke="rgba(0,0,0,0.6)" strokeWidth={3} />
              <polygon points={points} fill="none" stroke="#46a758" strokeWidth={1.5} strokeDasharray="5 3" />
            </g>
          );
        }
        return null;
      })}
      {box && (
        <rect
          x={Math.min(box[0][0], box[1][0])}
          y={Math.min(box[0][1], box[1][1])}
          width={Math.abs(box[1][0] - box[0][0])}
          height={Math.abs(box[1][1] - box[0][1])}
          fill="rgba(70,167,88,0.12)"
          stroke="white"
          strokeWidth={1}
          strokeDasharray="4 3"
          data-testid="refine-box"
        />
      )}
    </svg>
  );
}

/**
 * The linear gradient's 0 %, 50 % and 100 % lines across the picture, with the end and centre handles and the
 * rotate handle (plan 56) on the 50 % line, `ROTATE_GAP` past half the gradient's length, kept inside the box.
 */
function LinearShape({
  c,
  s,
  span,
  box,
}: {
  c: LinearComponent;
  s: MaskScreen;
  span: number;
  box: { width: number; height: number };
}) {
  const a = s.toScreen(c.from);
  const b = s.toScreen(c.to);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * span;
  const ny = (dx / len) * span;
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const n: Pt = [-dy / len, dx / len];
  const half = len / 2;
  const reach = Math.min(half + ROTATE_GAP, inBox(mid, n, box, HANDLE_R + 2));
  const stem: Pt = [mid[0] + n[0] * Math.min(half, reach), mid[1] + n[1] * Math.min(half, reach)];
  const rot: Pt = [mid[0] + n[0] * reach, mid[1] + n[1] * reach];
  const line = (p: Pt, key: string, dash?: string) => (
    <g key={key} clipPath="url(#mask-picture)">
      <line x1={p[0] - nx} y1={p[1] - ny} x2={p[0] + nx} y2={p[1] + ny} stroke="rgba(0,0,0,0.5)" strokeWidth={3} />
      <line
        x1={p[0] - nx}
        y1={p[1] - ny}
        x2={p[0] + nx}
        y2={p[1] + ny}
        stroke="white"
        strokeWidth={1}
        strokeDasharray={dash}
        data-testid={`linear-line-${key}`}
      />
    </g>
  );
  return (
    <g data-testid="linear-shape">
      {line(a, '0')}
      {line(mid, '50', '4 4')}
      {line(b, '100')}
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="rgba(255,255,255,0.5)" strokeWidth={1} />
      {(
        [
          ['from', a, 'Where the effect fades out'],
          ['to', b, 'Where the effect is full'],
        ] as const
      ).map(([h, p, title]) => (
        <circle
          key={h}
          cx={p[0]}
          cy={p[1]}
          r={HANDLE_R}
          fill="white"
          stroke="rgba(0,0,0,0.6)"
          data-mask-handle={h}
          style={{ cursor: 'move' }}
        >
          <title>{title}</title>
        </circle>
      ))}
      <RotateHandle from={stem} at={rot} />
      <rect
        x={mid[0] - HANDLE_R}
        y={mid[1] - HANDLE_R}
        width={HANDLE_R * 2}
        height={HANDLE_R * 2}
        fill="var(--color-accent, #4f8cff)"
        stroke="white"
        data-mask-handle="mid"
        style={{ cursor: 'grab' }}
      />
    </g>
  );
}

/** The radial gradient's outer edge and feather edge, the axis handles, the rotation handle and the centre. */
function RadialShape({ c, s }: { c: RadialComponent; s: MaskScreen }) {
  const { centre, a, b, rx, ry, deg } = radialOnScreen(c, s);
  const inner = 1 - c.feather / 100;
  const ub: Pt = [b[0] / (ry || 1), b[1] / (ry || 1)];
  const edge: Pt = [centre[0] - b[0], centre[1] - b[1]];
  const rot: Pt = [edge[0] - ub[0] * ROTATE_GAP, edge[1] - ub[1] * ROTATE_GAP];
  const transform = `rotate(${deg} ${centre[0]} ${centre[1]})`;
  const handle = (key: string, p: Pt, h: string, cursor: string) => (
    <circle
      key={key}
      cx={p[0]}
      cy={p[1]}
      r={HANDLE_R}
      fill="white"
      stroke="rgba(0,0,0,0.6)"
      data-mask-handle={h}
      style={{ cursor }}
    />
  );
  return (
    <g data-testid="radial-shape">
      <ellipse
        cx={centre[0]}
        cy={centre[1]}
        rx={rx}
        ry={ry}
        transform={transform}
        fill="rgba(255,255,255,0.001)"
        stroke="white"
        strokeWidth={1}
        data-mask-handle="move"
        style={{ cursor: 'move' }}
      />
      {inner > 0 && inner < 1 && (
        <ellipse
          cx={centre[0]}
          cy={centre[1]}
          rx={rx * inner}
          ry={ry * inner}
          transform={transform}
          fill="none"
          stroke="white"
          strokeWidth={1}
          strokeDasharray="3 3"
          pointerEvents="none"
        />
      )}
      {handle('r+', [centre[0] + a[0], centre[1] + a[1]], 'rx', 'ew-resize')}
      {handle('r-', [centre[0] - a[0], centre[1] - a[1]], 'rx', 'ew-resize')}
      {handle('s+', [centre[0] + b[0], centre[1] + b[1]], 'ry', 'ns-resize')}
      {handle('s-', [centre[0] - b[0], centre[1] - b[1]], 'ry', 'ns-resize')}
      <RotateHandle from={edge} at={rot} />
      <circle cx={centre[0]} cy={centre[1]} r={3} fill="var(--color-accent, #4f8cff)" pointerEvents="none" />
    </g>
  );
}

/** How far from `p` along the unit vector `n` a point stays `pad` px inside the box (∞ along a box edge). */
function inBox(p: Pt, n: Pt, box: { width: number; height: number }, pad: number): number {
  let t = Number.POSITIVE_INFINITY;
  const limit = (pos: number, dir: number, size: number) => {
    if (dir > 1e-9) t = Math.min(t, (size - pad - pos) / dir);
    else if (dir < -1e-9) t = Math.min(t, (pos - pad) / -dir);
  };
  limit(p[0], n[0], box.width);
  limit(p[1], n[1], box.height);
  return Math.max(t, 0);
}
