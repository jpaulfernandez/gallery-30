import { type DevelopGeometry, newId, type UprightGuide } from '@photobook/shared';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { frameOf, type SourceSize } from '../../lib/develop/cropEdit';
import { andThen, scale, translate } from '../../lib/develop/geometry';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from '../../store/book';
import { assetDevelop } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { isEditableTarget } from '../editor/gestures';
import { cssTransform, frameLayout, frameMatrix, useBoxSize } from './CropTool';
import { runUprightUpdate, useUprightMessage } from './upright';

/** Guides Lightroom accepts at most. */
export const MAX_GUIDES = 4;
/** A new guide shorter than this (screen px) is not created. */
const MIN_GUIDE = 8;
/** Loupe: diameter (px) and magnification. */
export const LOUPE_SIZE = 128;
export const LOUPE_ZOOM = 3;

type Point = [number, number];

type Drag =
  | { kind: 'end'; pointerId: number; id: string; end: 'from' | 'to' }
  | { kind: 'new'; pointerId: number; id: string; x0: number; y0: number; written: boolean };

/** `guide` typed by its extent on screen: wider than tall is horizontal. */
export const kindOfExtent = (dx: number, dy: number): UprightGuide['kind'] =>
  Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';

export interface GuidesOverlayProps {
  assetId: string;
  geometry: DevelopGeometry;
  /** The picture without geometry (the live render with geometry off, or the cached proxy). */
  imageUrl: string | undefined;
  /** Upright source size. */
  size: SourceSize;
  name: string;
}

/**
 * Guided Upright drawing over the Develop view: the whole transformed, uncropped picture (orientation, Upright and
 * the manual Transform previewed live as a CSS `matrix3d`, no render), with the guides drawn on it. Guides are
 * stored in fractions of that frame (like masks; the store maps them back to the oriented frame for the solver),
 * so they are drawn as they are.
 *
 * Drag on empty space to draw a guide (up to four; typed vertical or horizontal by its extent, the V / H badge
 * toggles it), drag an end to move it (a 3× loupe follows), click a line to select it, Delete removes the selected
 * one. Each edit is solved on pointer up (not per move) and is one undo step with its solve.
 */
export function GuidesOverlay({ assetId, geometry, imageUrl, size, name }: GuidesOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const box = useBoxSize(rootRef);
  const drag = useRef<Drag | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loupe, setLoupe] = useState<Point | null>(null);
  const message = useUprightMessage(assetId);

  const { ia } = frameOf(geometry, size);
  const layout = useMemo(() => frameLayout(box.width, box.height, ia), [box.width, box.height, ia]);
  const swapped = geometry.rotate === 90 || geometry.rotate === 270;
  const iw = swapped ? layout.fh : layout.fw;
  const ih = swapped ? layout.fw : layout.fh;
  // The picture is clipped to the frame, so its matrix is relative to the frame's corner.
  const inFrame = frameMatrix(geometry, iw, ih, { ox: 0, oy: 0, fw: layout.fw, fh: layout.fh });
  const guides = geometry.upright.guides;

  const toScreen = (p: readonly [number, number]): Point => [
    layout.ox + p[0] * layout.fw,
    layout.oy + p[1] * layout.fh,
  ];
  const toFrame = (x: number, y: number): Point => [(x - layout.ox) / layout.fw, (y - layout.oy) / layout.fh];
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
  };
  const currentGuides = (): UprightGuide[] =>
    assetDevelop(useBookStore.getState(), assetId)?.geometry.upright.guides ?? [];

  /** Write the guides and solve them as one undo step. */
  const commit = (next: UprightGuide[]) => {
    beginDevelopDrag();
    useBookStore.getState().setUprightGuides(assetId, next);
    void runUprightUpdate(assetId, size).finally(endDevelopDrag);
  };

  // A drag cut short by unmounting still ends its undo step.
  useEffect(
    () => () => {
      if (drag.current) endDevelopDrag();
      drag.current = null;
    },
    [],
  );

  // Delete / Backspace removes the selected guide.
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || isEditableTarget(e.target) || drag.current) return;
      const all = currentGuides();
      if (!all.some((g) => g.id === selected)) return;
      e.preventDefault();
      setSelected(null);
      commit(all.filter((g) => g.id !== selected));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current || box.width <= 0) return;
    const target = e.target as Element;
    if (target.closest('button')) return;
    e.preventDefault();
    const [x, y] = local(e);
    const endEl = target.closest('[data-guide-end]');
    const lineEl = target.closest('[data-guide-line]');
    if (endEl) {
      const id = endEl.getAttribute('data-guide') ?? '';
      const end = endEl.getAttribute('data-guide-end') === 'to' ? 'to' : 'from';
      e.currentTarget.setPointerCapture?.(e.pointerId);
      beginDevelopDrag();
      drag.current = { kind: 'end', pointerId: e.pointerId, id, end };
      setSelected(id);
      setLoupe([x, y]);
      return;
    }
    if (lineEl) {
      setSelected(lineEl.getAttribute('data-guide-line'));
      return;
    }
    setSelected(null);
    if (currentGuides().length >= MAX_GUIDES) {
      useUiStore.getState().setUprightMessage({
        assetId,
        text: 'Four guides at most: select one and press Delete to draw another.',
        error: true,
      });
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginDevelopDrag();
    drag.current = { kind: 'new', pointerId: e.pointerId, id: newId(), x0: x, y0: y, written: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const [x, y] = local(e);
    const x1 = Math.min(Math.max(x, 0), box.width);
    const y1 = Math.min(Math.max(y, 0), box.height);
    const all = currentGuides();
    const store = useBookStore.getState();
    if (d.kind === 'end') {
      const p = toFrame(x1, y1);
      store.setUprightGuides(
        assetId,
        all.map((g) => (g.id === d.id ? { ...g, [d.end]: p } : g)),
      );
      setLoupe([x1, y1]);
      return;
    }
    if (!d.written && Math.hypot(x1 - d.x0, y1 - d.y0) < MIN_GUIDE) return;
    const guide: UprightGuide = {
      id: d.id,
      kind: kindOfExtent(x1 - d.x0, y1 - d.y0),
      from: toFrame(d.x0, d.y0),
      to: toFrame(x1, y1),
    };
    store.setUprightGuides(assetId, d.written ? all.map((g) => (g.id === d.id ? guide : g)) : [...all, guide]);
    if (!d.written) setSelected(d.id);
    d.written = true;
    setLoupe([x1, y1]);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setLoupe(null);
    if (d.kind === 'new' && !d.written) {
      endDevelopDrag();
      return;
    }
    // Solve once the guide is down (not per move); the drag and its solve are one undo step.
    void runUprightUpdate(assetId, size).finally(endDevelopDrag);
  };

  const toggleKind = (id: string) =>
    commit(
      currentGuides().map((g) =>
        g.id === id ? { ...g, kind: g.kind === 'vertical' ? ('horizontal' as const) : ('vertical' as const) } : g,
      ),
    );

  const ready = box.width > 0 && box.height > 0;
  const loupeMatrix = loupe
    ? andThen(
        andThen(andThen(inFrame, translate(layout.ox - loupe[0], layout.oy - loupe[1])), scale(LOUPE_ZOOM, LOUPE_ZOOM)),
        translate(LOUPE_SIZE / 2, LOUPE_SIZE / 2),
      )
    : null;
  // Above and left of the pointer, flipped inside the box near its edges.
  const loupeLeft = loupe ? (loupe[0] - LOUPE_SIZE - 24 < 0 ? loupe[0] + 24 : loupe[0] - LOUPE_SIZE - 24) : 0;
  const loupeTop = loupe ? (loupe[1] - LOUPE_SIZE - 24 < 0 ? loupe[1] + 24 : loupe[1] - LOUPE_SIZE - 24) : 0;

  return (
    <div
      ref={rootRef}
      data-testid="guides-overlay"
      role="application"
      aria-label="Upright guides: drag on the photo to draw a guide, drag an end to move it, Delete removes the selected one"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute inset-0 touch-none select-none overflow-hidden"
      style={{ cursor: 'crosshair' }}
    >
      {ready && imageUrl && (
        <div
          className="pointer-events-none absolute overflow-hidden"
          style={{ left: layout.ox, top: layout.oy, width: layout.fw, height: layout.fh }}
        >
          <img
            src={imageUrl}
            alt={name}
            draggable={false}
            data-testid="guides-picture"
            className="absolute top-0 left-0 max-w-none"
            style={{ width: iw, height: ih, transformOrigin: '0 0', transform: cssTransform(inFrame) }}
          />
        </div>
      )}
      {ready && (
        <svg className="absolute inset-0 h-full w-full" width={box.width} height={box.height} aria-hidden="true">
          <rect
            x={layout.ox}
            y={layout.oy}
            width={layout.fw}
            height={layout.fh}
            fill="none"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
            pointerEvents="none"
          />
          {guides.map((g) => {
            const [x1, y1] = toScreen(g.from);
            const [x2, y2] = toScreen(g.to);
            const on = g.id === selected;
            const colour = on ? 'var(--color-accent, #4f8cff)' : '#ffd84a';
            return (
              <g key={g.id} data-testid={`guide-${g.id}`} data-kind={g.kind}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,0.6)" strokeWidth={3} pointerEvents="none" />
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={colour} strokeWidth={1.5} pointerEvents="none" />
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="transparent"
                  strokeWidth={12}
                  data-guide-line={g.id}
                  style={{ cursor: 'pointer' }}
                />
                {(['from', 'to'] as const).map((end) => {
                  const [cx, cy] = end === 'from' ? [x1, y1] : [x2, y2];
                  return (
                    <circle
                      key={end}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={on ? colour : 'white'}
                      stroke="rgba(0,0,0,0.6)"
                      strokeWidth={1}
                      data-guide={g.id}
                      data-guide-end={end}
                      style={{ cursor: 'move' }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {ready &&
        guides.map((g, i) => {
          const [x1, y1] = toScreen(g.from);
          const [x2, y2] = toScreen(g.to);
          const other = g.kind === 'vertical' ? 'horizontal' : 'vertical';
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => toggleKind(g.id)}
              aria-label={`Guide ${i + 1}: ${g.kind}. Make it ${other}`}
              title={`Treat this guide as ${other}`}
              className="absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-stage/50 bg-stage/70 text-[10px] text-fg outline-none hover:bg-stage focus-visible:ring-2 focus-visible:ring-accent"
              style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2 }}
            >
              {g.kind === 'vertical' ? 'V' : 'H'}
            </button>
          );
        })}
      {loupe && loupeMatrix && imageUrl && (
        <div
          data-testid="guides-loupe"
          className="pointer-events-none absolute overflow-hidden rounded-full border-2 border-fg/80 bg-stage shadow-float"
          style={{ left: loupeLeft, top: loupeTop, width: LOUPE_SIZE, height: LOUPE_SIZE }}
        >
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            className="absolute top-0 left-0 max-w-none"
            style={{ width: iw, height: ih, transformOrigin: '0 0', transform: cssTransform(loupeMatrix) }}
          />
          <span className="absolute top-1/2 left-0 h-px w-full bg-fg/70" />
          <span className="absolute top-0 left-1/2 h-full w-px bg-fg/70" />
        </div>
      )}
      <span className="pointer-events-none absolute top-2 left-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
        Guided Upright: {guides.length} / {MAX_GUIDES} guides
      </span>
      {message && (
        <span
          className={`pointer-events-none absolute bottom-2 left-2 max-w-[80%] rounded-sm bg-stage/70 px-1.5 py-0.5 text-[11px] ${
            message.error ? 'text-warn' : 'text-fg'
          }`}
        >
          {message.text}
        </span>
      )}
    </div>
  );
}
