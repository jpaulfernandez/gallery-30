import {
  CURVE_PRESETS,
  type CurvePoint,
  curvePresetPoints,
  type DevelopCurve,
  matchCurvePreset,
} from '@photobook/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';
import {
  addCurvePoint,
  curvePath,
  isIdentityCurve,
  moveCurvePoint,
  nearestPoint,
  removeCurvePoint,
} from '../../lib/develop/curve';
import { beginDevelopDrag, endDevelopDrag } from '../../store/book';
import { useIdleGesture } from '../editor/gestures';
import { Button } from '../ui/Button';

export type CurveChannel = 'luma' | 'red' | 'green' | 'blue';

export const CURVE_CHANNELS: Array<{ id: CurveChannel; label: string; color: string }> = [
  { id: 'luma', label: 'Luma', color: '#e5e5e5' },
  { id: 'red', label: 'R', color: '#ff6a60' },
  { id: 'green', label: 'G', color: '#4cd964' },
  { id: 'blue', label: 'B', color: '#5b9bff' },
];

/** The curve box in SVG units; the SVG scales to the panel width. */
const SIZE = 256;
/** Pointer distance, CSS px, within which a press grabs an existing point. */
const GRAB_PX = 10;
/** One arrow-key nudge: a single 8-bit level. */
const KEY_STEP = 1 / 255;

interface CurveEditorProps {
  curve: DevelopCurve;
  /** The channel's new point list (sorted, end points at x = 0 and x = 1). */
  onChange: (channel: CurveChannel, points: CurvePoint[]) => void;
}

/**
 * Point-curve editor: a 256 x 256 SVG with Luma / R / G / B tabs. Click empty space to add a point, drag a
 * point to move it, double-click it (or press Delete) to remove it. The end points only move vertically; inner
 * points stay between their neighbours; the curve is drawn as a monotone cubic spline (lib/develop/curve.ts).
 * A drag is one undo step.
 *
 * Plan 54: the presets as chips above the editor (Linear · Soft S · Strong S · Matte · Faded · Reverse S,
 * `curvePresets.ts` in shared). A chip writes its points into the channel shown through `onChange`, exactly as a
 * drawn curve: one undo step, hashed and rendered like any curve; the chip whose points the channel has is pressed.
 */
export function CurveEditor({ curve, onChange }: CurveEditorProps) {
  const [channel, setChannel] = useState<CurveChannel>('luma');
  const [selected, setSelected] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; pointerId: number } | null>(null);
  const touchKeys = useIdleGesture(500);

  const points = curve[channel];
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const info = CURVE_CHANNELS.find((c) => c.id === channel) ?? (CURVE_CHANNELS[0] as (typeof CURVE_CHANNELS)[number]);

  /** Pointer position as curve coordinates (0..1, y up), plus the grab radius in those units. */
  const toCurve = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: 1 - (e.clientY - rect.top) / rect.height,
      rx: GRAB_PX / rect.width,
      ry: GRAB_PX / rect.height,
    };
  };

  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    endDevelopDrag();
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || drag.current) return;
    const at = toCurve(e);
    if (!at) return;
    e.currentTarget.focus();
    let index = nearestPoint(pointsRef.current, at.x, at.y, at.rx, at.ry);
    beginDevelopDrag();
    if (index < 0) {
      const added = addCurvePoint(pointsRef.current, at.x, at.y);
      if (!added) {
        endDevelopDrag();
        return;
      }
      index = added.index;
      onChange(channel, added.points);
    }
    setSelected(index);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { index, pointerId: e.pointerId };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const at = toCurve(e);
    if (!at) return;
    onChange(channel, moveCurvePoint(pointsRef.current, d.index, at.x, at.y));
  };

  const onDoubleClick = (e: ReactPointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    const at = toCurve(e);
    if (!at) return;
    const index = nearestPoint(pointsRef.current, at.x, at.y, at.rx, at.ry);
    if (index <= 0 || index >= pointsRef.current.length - 1) return;
    onChange(channel, removeCurvePoint(pointsRef.current, index));
    setSelected(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (selected === null || selected >= points.length || e.metaKey || e.ctrlKey || e.altKey) return;
    const p = points[selected] as CurvePoint;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      if (selected > 0 && selected < points.length - 1) {
        onChange(channel, removeCurvePoint(points, selected));
        setSelected(null);
      }
      return;
    }
    const big = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dy = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    e.stopPropagation();
    touchKeys();
    onChange(channel, moveCurvePoint(points, selected, p[0] + dx * KEY_STEP * big, p[1] + dy * KEY_STEP * big));
  };

  const sel = selected !== null ? points[selected] : undefined;
  const to255 = (v: number) => Math.round(v * 255);
  const preset = matchCurvePreset(points);

  return (
    <div className="space-y-2">
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label="Curve presets">
        {CURVE_PRESETS.map((p) => (
          <Button
            key={p.id}
            variant="toggle"
            size="sm"
            shape="pill"
            pressed={preset === p.id}
            title={`${p.hint} (${info.label === 'Luma' ? 'the luma curve' : `the ${info.label} channel`})`}
            onClick={() => {
              if (preset === p.id) return;
              onChange(channel, curvePresetPoints(p.id));
              setSelected(null);
            }}
          >
            {p.label}
          </Button>
        ))}
      </fieldset>
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="Curve channel" className="flex flex-1 rounded-md border border-line p-0.5">
          {CURVE_CHANNELS.map((c) => {
            const active = c.id === channel;
            const edited = !isIdentityCurve(curve[c.id]);
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setChannel(c.id);
                  setSelected(null);
                }}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-1 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
                }`}
              >
                <span className="size-1.5 rounded-full" style={{ background: c.color }} aria-hidden="true" />
                {c.label}
                {edited && <span className="sr-only"> (edited)</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={isIdentityCurve(points)}
          onClick={() => {
            onChange(channel, [
              [0, 0],
              [1, 1],
            ]);
            setSelected(null);
          }}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:text-fg-muted"
        >
          Reset
        </button>
      </div>
      <div className="px-1.5">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="application"
          aria-label={`Tone curve, ${info.label}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets Delete and arrow keys edit the selected point
          tabIndex={0}
          data-no-step=""
          data-testid="curve-editor"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          className="aspect-square w-full touch-none overflow-visible rounded-sm bg-panel-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g} stroke="#3a3a3a" strokeWidth={1} vectorEffect="non-scaling-stroke">
              <line x1={g * SIZE} y1={0} x2={g * SIZE} y2={SIZE} />
              <line x1={0} y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
            </g>
          ))}
          <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="#555" strokeWidth={1} strokeDasharray="3 4" />
          <rect width={SIZE} height={SIZE} fill="none" stroke="#3f3f3f" />
          <path d={curvePath(points, SIZE)} fill="none" stroke={info.color} strokeWidth={1.75} strokeLinejoin="round" />
          {points.map((p, i) => (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: points have no id; a stable key keeps the dragged circle mounted
              key={i}
              data-testid={`curve-point-${i}`}
              cx={p[0] * SIZE}
              cy={(1 - p[1]) * SIZE}
              r={i === selected ? 5.5 : 4.5}
              fill={i === selected ? info.color : '#1a1a1a'}
              stroke={info.color}
              strokeWidth={1.75}
            />
          ))}
        </svg>
      </div>
      <p className="h-4 text-[11px] text-fg-muted tabular-nums">
        {sel ? `Input ${to255(sel[0])}  Output ${to255(sel[1])}` : 'Click to add a point · double-click to remove'}
      </p>
    </div>
  );
}
