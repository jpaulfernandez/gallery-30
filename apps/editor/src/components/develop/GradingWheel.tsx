import type { GradingWheel as GradingWheelValue } from '@photobook/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { normHue, snapHue } from '../../lib/develop/harmony';
import { tick } from '../../lib/haptic';
import { beginDevelopDrag, endDevelopDrag } from '../../store/book';
import { useIdleGesture } from '../editor/gestures';
import { NumberInput } from '../ui';

type HueSat = Pick<GradingWheelValue, 'hue' | 'saturation'>;

export interface GradingWheelProps {
  /** "Shadows", "Midtones", "Highlights", "Global": the wheel is "<label> wheel", its numbers "<label> hue" / "saturation". */
  label: string;
  value: HueSat;
  /** Diameter in px (88 for the tonal wheels, smaller for Global). */
  size?: number;
  /** Every change: a drag, a key, a typed number, the reset. The harmony lock is the caller's (`lib/develop/harmony`). */
  onChange: (next: HueSat) => void;
  /** Angles the harmony lock draws on the ring as thin spokes. */
  spokes?: readonly number[];
  /** Hues a drag snaps to (within `SNAP_DEGREES`), with one haptic tick per snap. */
  snapTargets?: readonly number[];
}

/** The colour field: hue around the ring (0° red at the right, counter-clockwise), saturation from the grey centre. */
const HUE_RING = `conic-gradient(from 90deg, ${Array.from({ length: 13 }, (_, i) => `hsl(${(360 - i * 30) % 360} 75% 55%) ${i * 30}deg`).join(', ')})`;
const GREY_CENTRE = 'radial-gradient(closest-side, hsl(0 0% 55%), hsl(0 0% 55% / 0))';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Plan 55 (ODDHALLS_LAYOUT_PLAN 4.2): one colour-grading wheel. A hue ring with a saturation radius: drag the dot
 * (angle = hue, distance from the centre = saturation); Shift holds the hue (only the saturation moves), Alt holds the
 * saturation; double-click resets. Arrow keys nudge (Left / Right the hue, Up / Down the saturation, Shift ten times;
 * `data-no-step` keeps Develop's photo stepping off them). The hue and saturation sit under the wheel as editable mono
 * numbers. (No Delete-to-reset: Develop's Delete removes the selected mask component unless the focus is a slider.)
 *
 * The field is colour, never chrome, so it carries no accent; the dot follows the slider's needle (46): `fg` with a
 * `stage` ring, larger on hover and while dragging, `accent` with the keyboard focus. A drag is one undo step
 * (`beginDevelopDrag` / `endDevelopDrag`), a burst of keys too.
 */
export function GradingWheel({ label, value, size = 88, onChange, spokes = [], snapTargets = [] }: GradingWheelProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const drag = useRef<{ pointerId: number; start: HueSat; snapped: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const touchKeys = useIdleGesture(500);

  /** `exactHue`: a snapped or held hue lands as is (a target need not be a whole degree); others round to 1°. */
  const emit = (next: HueSat, exactHue = false) => {
    const hue = normHue(exactHue ? next.hue : Math.round(next.hue));
    const v = { hue, saturation: clamp(Math.round(next.saturation), 0, 100) };
    if (v.hue !== valueRef.current.hue || v.saturation !== valueRef.current.saturation) onChange(v);
  };

  /** The value under the pointer, with Shift / Alt holding the hue / the saturation and the lock's snaps. */
  const fromPointer = (e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean }) => {
    const d = drag.current;
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width <= 0) return;
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = rect.top + rect.height / 2 - e.clientY;
    let hue = (Math.atan2(dy, dx) * 180) / Math.PI;
    let saturation = (Math.hypot(dx, dy) / (rect.width / 2)) * 100;
    if (e.shiftKey) hue = d.start.hue;
    if (e.altKey) saturation = d.start.saturation;
    let exact = e.shiftKey;
    if (!e.shiftKey) {
      const snap = snapHue(hue, snapTargets);
      if (snap.snapped !== null && snap.snapped !== d.snapped) tick('alignment');
      d.snapped = snap.snapped;
      hue = snap.hue;
      exact = snap.snapped !== null;
    }
    emit({ hue, saturation }, exact);
  };

  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    endDevelopDrag();
  };

  // A drag cut short by unmounting must still end its undo step.
  useEffect(
    () => () => {
      if (drag.current) {
        drag.current = null;
        endDevelopDrag();
      }
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    fieldRef.current?.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginDevelopDrag();
    drag.current = { pointerId: e.pointerId, start: valueRef.current, snapped: null };
    setDragging(true);
    // A press is a jump: the dot goes where the pointer is.
    fromPointer(e);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) fromPointer(e);
  };

  const reset = () => emit({ hue: 0, saturation: 0 });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const big = e.shiftKey ? 10 : 1;
    const { hue, saturation } = valueRef.current;
    let next: HueSat | null = null;
    if (e.key === 'ArrowLeft') next = { hue: hue - big, saturation };
    else if (e.key === 'ArrowRight') next = { hue: hue + big, saturation };
    else if (e.key === 'ArrowUp') next = { hue, saturation: saturation + big };
    else if (e.key === 'ArrowDown') next = { hue, saturation: saturation - big };
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    touchKeys();
    emit(next);
  };

  const r = (clamp(value.saturation, 0, 100) / 100) * 50;
  const rad = (value.hue * Math.PI) / 180;
  const dot = { left: `${50 + r * Math.cos(rad)}%`, top: `${50 - r * Math.sin(rad)}%` };

  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5" data-grading-wheel={label.toLowerCase()}>
      <span className="text-[11px] text-fg-muted">{label}</span>
      <div
        ref={fieldRef}
        role="application"
        aria-label={`${label} wheel`}
        aria-roledescription="colour wheel"
        aria-description={`hue ${Math.round(value.hue)}°, saturation ${Math.round(value.saturation)}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets the arrow keys nudge the hue and saturation
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        data-dragging={dragging || undefined}
        data-no-step=""
        className="group/wheel relative shrink-0 cursor-crosshair touch-none select-none rounded-pill outline-none"
        style={{ width: size, height: size, background: `${GREY_CENTRE}, ${HUE_RING}` }}
      >
        <svg
          aria-hidden="true"
          viewBox="-50 -50 100 100"
          className="pointer-events-none absolute inset-0 size-full text-stage"
          fill="none"
          stroke="currentColor"
        >
          <circle r="49.5" strokeOpacity={0.35} strokeWidth={1} />
          {spokes.map((h, i) => {
            const a = (h * Math.PI) / 180;
            return (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: two tied wheels can share a hue (monochromatic)
                key={i}
                data-spoke={h}
                x1={0}
                y1={0}
                x2={50 * Math.cos(a)}
                y2={-50 * Math.sin(a)}
                strokeOpacity={0.55}
                strokeWidth={0.75}
              />
            );
          })}
          <circle r="1.2" fill="currentColor" fillOpacity={0.5} stroke="none" />
        </svg>
        <div
          data-wheel-dot=""
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-fg ring-1 ring-stage transition-[width,height,background-color] duration-fast ease-out group-hover/wheel:size-3 group-focus-visible/wheel:bg-accent group-data-[dragging]/wheel:size-3"
          style={dot}
        />
      </div>
      <div className="grid w-full grid-cols-2 gap-1" style={{ maxWidth: Math.max(size, 80) }}>
        <NumberInput
          aria-label={`${label} hue`}
          title={`${label} hue (degrees)`}
          value={value.hue}
          min={0}
          max={360}
          className="px-1"
          onChange={(hue) => emit({ hue, saturation: valueRef.current.saturation })}
        />
        <NumberInput
          aria-label={`${label} saturation`}
          title={`${label} saturation`}
          value={value.saturation}
          min={0}
          max={100}
          className="px-1"
          onChange={(saturation) => emit({ hue: valueRef.current.hue, saturation })}
        />
      </div>
    </div>
  );
}
