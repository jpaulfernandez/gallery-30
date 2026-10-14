import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { tick } from '../../lib/haptic';
import { beginDevelopDrag, endDevelopDrag } from '../../store/book';
import { useIdleGesture } from '../editor/gestures';
import { focusRing } from '../ui/Button';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Granularity of dragging, arrow keys and typed values. Default 1. */
  step?: number;
  /** Where double-click resets to. Default 0. */
  defaultValue?: number;
  onChange: (value: number) => void;
  /** Readout text; defaults to the value with the decimals `step` implies and a + sign on positives. */
  format?: (value: number) => string;
  /**
   * For a slider whose position is not the number shown (a log scale): the text the readout field starts with,
   * and the typed text back to a slider value (undefined rejects it). Default: the value itself.
   */
  editText?: (value: number) => string;
  parse?: (text: string) => number | undefined;
  /** CSS `background` for the track (a gradient for temperature, tint, hue). */
  track?: string;
  disabled?: boolean;
  /** Extra data attributes for the focusable track (e.g. `{ 'data-band': 'red' }`). */
  trackProps?: Record<`data-${string}`, string>;
  /** Small colour dot before the label. */
  swatch?: string;
}

/** Pixels the pointer must travel before a press on the row becomes a drag (a plain click only focuses). */
const DRAG_THRESHOLD = 3;
/** The detent around the default value, as a share of the range: inside it a drag holds the default. */
export const DETENT = 0.015;

/**
 * A soft spring for the reset (UI 4.2), as a `linear()` easing where the webview has it, else the `ease-out` token.
 * The duration is `--dur-slow`, zero under reduced motion, so the spring is off there too.
 */
const SPRING =
  'linear(0, 0.062, 0.233 7.6%, 0.665 17.4%, 0.875 23.8%, 1.004 31.2%, 1.052 37.1%, 1.064 42.2%, 1.056 47.9%, 1.008 64.4%, 0.996 76.2%, 1)';
const springEasing = (): string =>
  typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', SPRING) ? SPRING : 'var(--ease-out)';

/** A motion token in ms (`--dur-fast|base|slow`); 0 under reduced motion, or where styles are not computed (tests). */
function motionMs(token: 'fast' | 'base' | 'slow'): number {
  if (typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${token}`).trim();
  const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : 0;
  return Number.isFinite(ms) ? ms : 0;
}

const decimalsOf = (step: number): number => {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * A Develop slider (ODDHALLS_UI_PLAN 4.2): label and readout above a 4 px track with a needle. The whole row is the
 * drag surface: a press on the track jumps to the pointer once it moves, a press on the label or the readout drags
 * from the current value; hold Shift for fine, ten times slower control. Double-click resets (the needle springs
 * back), arrow keys nudge by `step` (Shift: ten steps), Option + wheel over the row nudges too (a plain wheel scrolls
 * the panel), click the readout to type a value (Enter commits, Escape cancels).
 *
 * The detent: within `DETENT` of the range from the default a drag holds the default (Shift skips it), with a scale
 * bump and one haptic tick per crossing; a nudge that lands on or passes the default ticks too. A row off its
 * default carries the accent dot before its label.
 *
 * A pointer drag is one undo step: pointer down calls `beginDevelopDrag`, pointer up `endDevelopDrag`.
 * A burst of key or wheel nudges is one step too (an idle gesture that ends half a second after the last one).
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue = 0,
  onChange,
  format,
  editText,
  parse,
  track,
  disabled = false,
  trackProps,
  swatch,
}: SliderProps) {
  const decimals = decimalsOf(step);
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    started: boolean;
    /** The press was on the track: the value jumps to the pointer when the drag starts. */
    jump: boolean;
    anchorX: number;
    anchorValue: number;
    shift: boolean;
    last: number;
    /** Inside the detent, and the side of the default the raw value was on (for a crossing). */
    inDetent: boolean;
    side: number;
  } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const touchKeys = useIdleGesture(500);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState(false);
  /** The reset in flight: the needle springs, the readout shows two intermediate values. */
  const [resetting, setResetting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const resetTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelled = useRef(false);
  const def = clamp(defaultValue, min, max);

  const snap = (v: number): number => {
    const stepped = Math.round((v - min) / step) * step + min;
    const rounded = Number(clamp(stepped, min, max).toFixed(Math.max(decimals, 6)));
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const emit = (v: number) => {
    const next = snap(v);
    if (next !== valueRef.current) onChange(next);
  };

  /** The detent's click: a haptic tick and the needle's 1.15× bump (half of `fast`, none under reduced motion). */
  const detent = () => {
    tick('alignment');
    const ms = motionMs('fast') / 2;
    if (ms > 0) needleRef.current?.animate?.([{ scale: '1' }, { scale: '1.15' }, { scale: '1' }], { duration: ms });
  };

  const clearReset = () => {
    for (const t of resetTimers.current) clearTimeout(t);
    resetTimers.current = [];
  };

  // A drag cut short by unmounting (the view closed mid-drag) must still end its undo step.
  useEffect(
    () => () => {
      for (const t of resetTimers.current) clearTimeout(t);
      if (drag.current) {
        drag.current = null;
        endDevelopDrag();
      }
    },
    [],
  );

  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    endDevelopDrag();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0 || drag.current || editing) return;
    const onTrack = trackRef.current?.contains(e.target as Node | null) ?? false;
    if (onTrack) trackRef.current?.focus();
    beginDevelopDrag();
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      started: false,
      jump: onTrack,
      anchorX: e.clientX,
      anchorValue: valueRef.current,
      shift: e.shiftKey,
      last: valueRef.current,
      inDetent: false,
      side: Math.sign(valueRef.current - def),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width <= 0 || e.pointerId !== d.pointerId) return;
    const range = max - min;
    const zone = DETENT * range;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
      d.started = true;
      setDragging(true);
      // Only now: a press on the readout that never moves stays a click on it.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      trackRef.current?.focus();
      // A press on the track jumps to the pointer; then (and from the label) the drag follows it relatively, so
      // Shift can slow it down.
      d.anchorX = e.clientX;
      if (d.jump) d.anchorValue = min + clamp((e.clientX - rect.left) / rect.width, 0, 1) * range;
      d.shift = e.shiftKey;
      d.inDetent = !d.shift && Math.abs(d.anchorValue - def) <= zone;
      d.side = Math.sign(d.anchorValue - def);
    } else if (e.shiftKey !== d.shift) {
      d.shift = e.shiftKey;
      d.anchorX = e.clientX;
      d.anchorValue = d.last;
    }
    const raw = clamp(d.anchorValue + ((e.clientX - d.anchorX) / rect.width) * range * (d.shift ? 0.1 : 1), min, max);
    const side = Math.sign(raw - def);
    if (!d.shift && Math.abs(raw - def) <= zone) {
      if (!d.inDetent) detent();
      d.inDetent = true;
      d.last = def;
      // The default exactly, not snapped to the step: an off-grid default (raw Temperature's as-shot) must land on it.
      if (def !== valueRef.current) onChange(def);
    } else {
      // Entering the detent clicked already; passing the default without stopping in it (Shift, a fast flick) clicks.
      if (!d.inDetent && d.side !== 0 && side !== 0 && side !== d.side) detent();
      d.inDetent = false;
      d.last = raw;
      emit(raw);
    }
    if (side !== 0) d.side = side;
  };

  /** A key or wheel nudge by `delta`; landing on or passing the default clicks. */
  const nudge = (delta: number) => {
    const from = valueRef.current;
    const next = snap(from + delta);
    if (next === from) return;
    // Nudges move on the step grid, so they compare with the default snapped to it.
    const target = snap(def);
    if (next === target || Math.sign(from - target) * Math.sign(next - target) < 0) detent();
    touchKeys();
    onChange(next);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.metaKey || e.ctrlKey || e.altKey) return;
    let delta = 0;
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step * big;
    else if (e.key === 'PageUp') delta = step * 10;
    else if (e.key === 'PageDown') delta = -step * 10;
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      reset();
      return;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      startEditing();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    nudge(delta);
  };

  // Option + wheel nudges; a plain wheel is left to the panel, which scrolls. A native listener: React's is passive,
  // and Option + wheel must not scroll the panel.
  const latest = useRef({ nudge, disabled, step });
  latest.current = { nudge, disabled, step };
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const onWheel = (e: WheelEvent) => {
      const { nudge: by, disabled: off, step: s } = latest.current;
      // Shift + wheel turns vertical scrolling horizontal on a Mac, so either axis counts.
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (!e.altKey || off || delta === 0) return;
      e.preventDefault();
      by((delta < 0 ? 1 : -1) * s * (e.shiftKey ? 10 : 1));
    };
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, []);

  function reset() {
    if (disabled) return;
    const from = valueRef.current;
    if (defaultValue === from) return;
    const slow = motionMs('slow');
    clearReset();
    if (slow > 0) {
      // The readout counts back through two intermediate values while the needle springs home.
      const third = (from - defaultValue) / 3;
      setResetting(true);
      setCountdown(defaultValue + 2 * third);
      resetTimers.current = [
        setTimeout(() => setCountdown(defaultValue + third), slow / 3),
        setTimeout(() => setCountdown(null), (2 * slow) / 3),
        setTimeout(() => setResetting(false), slow),
      ];
    }
    onChange(defaultValue);
  }

  function startEditing() {
    if (disabled) return;
    cancelled.current = false;
    setDraft(editText ? editText(value) : String(Number(value.toFixed(Math.max(decimals, 2)))));
    setEditing(true);
  }

  const commitDraft = () => {
    setEditing(false);
    if (cancelled.current) return;
    const text = draft.trim().replace(',', '.');
    const parsed = parse ? parse(text) : Number(text);
    if (text === '' || parsed === undefined || !Number.isFinite(parsed)) return;
    const next = Number(clamp(parsed, min, max).toFixed(Math.max(decimals, 2)));
    if (next !== valueRef.current) onChange(next);
  };

  const formatValue = (v: number) =>
    format
      ? format(v)
      : `${v > 0 && min < 0 ? '+' : ''}${(Object.is(Number(v.toFixed(decimals)), -0) ? 0 : v).toFixed(decimals)}`;
  const readout = formatValue(value);
  const shownReadout = countdown === null ? readout : formatValue(snap(countdown));
  const pct = (v: number) => ((clamp(v, min, max) - min) / (max - min)) * 100;
  const from = pct(def);
  const at = pct(value);
  const motion: CSSProperties | undefined = resetting
    ? {
        transitionProperty: 'left, width',
        transitionDuration: 'var(--dur-slow)',
        transitionTimingFunction: springEasing(),
      }
    : undefined;
  const fillStyle: CSSProperties = { left: `${Math.min(from, at)}%`, width: `${Math.abs(at - from)}%`, ...motion };
  // Tick marks: the default, halfway from it to each end, and the ends.
  const ticks = [...new Set([0, from / 2, from, (from + 100) / 2, 100].map((t) => Number(t.toFixed(3))))];
  const edited = value !== defaultValue;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row is the drag surface; the track inside is the slider
    <div
      ref={rowRef}
      className={`group/row select-none ${disabled ? 'opacity-40' : 'cursor-ew-resize'}`}
      onDoubleClick={reset}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      data-slider-row=""
      data-dragging={dragging || undefined}
      data-edited={edited || undefined}
    >
      <div className="flex h-4 items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-fg-2">
          {edited && <span data-edited-dot="" className="size-1 shrink-0 rounded-pill bg-accent" aria-hidden="true" />}
          {swatch && (
            <span className="size-2 shrink-0 rounded-pill" style={{ background: swatch }} aria-hidden="true" />
          )}
          {label}
        </span>
        {editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the field replaces the readout the user just clicked
            autoFocus
            type="text"
            inputMode="decimal"
            aria-label={`${label} value`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitDraft}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commitDraft();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelled.current = true;
                setEditing(false);
              }
            }}
            className="w-14 rounded-xs border border-accent bg-panel-2 px-1 text-right font-mono text-fg tabular-nums outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={startEditing}
            onDoubleClick={(e) => e.stopPropagation()}
            title="Click to type a value"
            className={`cursor-text rounded-xs px-1 font-mono text-fg tabular-nums transition-colors duration-fast hover:bg-fg/6 ${focusRing}`}
          >
            {shownReadout}
          </button>
        )}
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={readout}
        aria-disabled={disabled}
        onKeyDown={onKeyDown}
        {...trackProps}
        className="group/track relative h-4 touch-none rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <div
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-pill bg-fg/14"
          style={track ? { background: track, filter: 'saturate(0.7)' } : undefined}
        >
          {!track && <div className="absolute inset-y-0 bg-fg/70" style={fillStyle} />}
        </div>
        {ticks.map((t) => (
          <span
            key={t}
            data-slider-tick=""
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-fg/25 opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 group-data-[dragging]/row:opacity-100"
            style={{ left: `${t}%` }}
          />
        ))}
        <div
          ref={needleRef}
          data-slider-needle=""
          className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-fg ring-1 ring-stage transition-[width,height,background-color] duration-fast ease-out group-hover/row:h-[18px] group-hover/row:w-1.5 group-focus-visible/track:bg-accent group-data-[dragging]/row:h-[18px] group-data-[dragging]/row:w-1.5"
          style={{ left: `${at}%`, ...motion }}
        />
      </div>
    </div>
  );
}
