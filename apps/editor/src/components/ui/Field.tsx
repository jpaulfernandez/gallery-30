import {
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { focusRing } from './Button';

/**
 * Plan 45: the form controls of ODDHALLS_UI_PLAN 4.1. Inputs are `panel-2` with a `line` border, `sm` radius (6 px),
 * 26 px tall; focus swaps the border for the focus ring. Numbers are mono and right-aligned with the unit in
 * `fg-muted`.
 */

/**
 * What a field sits on. On a panel (the default) it is `panel-2`; on a `panel-2` card (the inspector's sections, plan
 * 48) or a dialog it is `panel`, one step apart, and its focus ring's gap matches the card.
 */
export type FieldSurface = 'panel' | 'card';

/** Fields inside a provider of `'card'` take the card look (the inspector's `Section` provides it). */
export const FieldSurfaceContext = createContext<FieldSurface>('panel');

const SURFACE: Record<FieldSurface, string> = {
  panel: 'bg-panel-2 focus:ring-offset-panel focus-within:ring-offset-panel',
  card: 'bg-panel focus:ring-offset-panel-2 focus-within:ring-offset-panel-2',
};
const fieldFocus = 'outline-none focus:border-transparent focus:ring-2 focus:ring-accent focus:ring-offset-2';
const fieldSkin = (surface: FieldSurface) =>
  `rounded-sm border border-line text-fg text-xs ${fieldFocus} ${SURFACE[surface]} disabled:opacity-40`;
const fieldBox = (surface: FieldSurface) => `h-[26px] ${fieldSkin(surface)}`;

/**
 * Classes of a text field, for a field that cannot be an `Input` (a `<textarea>`). `fixedHeight: false` drops the
 * 26 px height (a textarea, a field sized by its own padding).
 */
export function textFieldClass(surface: FieldSurface = 'panel', { fixedHeight = true } = {}): string {
  return `${fixedHeight ? fieldBox(surface) : `${fieldSkin(surface)} py-1`} px-2 placeholder:text-fg-muted`;
}

/** Classes of a text field on a panel (see `textFieldClass`). */
export const inputClass = textFieldClass();

export interface FieldProps {
  /** The label above the control (sentence case, `fg-2`). */
  label: ReactNode;
  /** A line under the control. */
  hint?: ReactNode;
  /** A problem with the value, in `danger` (announced). */
  error?: ReactNode;
  className?: string;
  /** The control: the `<label>` wraps it, so it is named by `label`. */
  children: ReactNode;
}

/** A labelled control: the label, the control, then the hint or the error. */
export function Field({ label, hint, error, className = '', children }: FieldProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`, which the label wraps
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-fg-2 text-xs">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-[11px] text-danger">
          {error}
        </span>
      ) : (
        hint && <span className="text-[11px] text-fg-muted">{hint}</span>
      )}
    </label>
  );
}

/** A text field. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  const surface = useContext(FieldSurfaceContext);
  return <input ref={ref} className={`${textFieldClass(surface)} ${className}`} {...rest} />;
});

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number in `fg-muted` ("px", "%"). */
  unit?: string;
  /** Decimals shown (default: as many as `step` has). */
  precision?: number;
}

const decimals = (step: number) => (Number.isInteger(step) ? 0 : (String(step).split('.')[1]?.length ?? 0));

/**
 * A number field: mono, right-aligned, the unit after it. Typing commits on Enter or blur (Escape puts the value
 * back); ArrowUp / ArrowDown nudge by `step` (Shift × 10); Option + wheel over it nudges too, a plain wheel scrolls
 * the panel (an accidental edit otherwise).
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, min = -Infinity, max = Infinity, step = 1, unit, precision, className = '', disabled, ...rest },
  ref,
) {
  const surface = useContext(FieldSurfaceContext);
  const places = precision ?? decimals(step);
  const show = (n: number) => n.toFixed(places);
  const [draft, setDraft] = useState<string | null>(null);
  const inner = useRef<HTMLInputElement | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Number(n.toFixed(places))));
  const latest = useRef({ value, onChange, clamp, step, disabled });
  latest.current = { value, onChange, clamp, step, disabled };

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(n) && clamp(n) !== value) onChange(clamp(n));
  };

  // A native listener: React's wheel listener is passive, and Option + wheel must not scroll the panel.
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { value: v, onChange: change, clamp: bound, step: s, disabled: off } = latest.current;
      if (!e.altKey || off || e.deltaY === 0) return;
      e.preventDefault();
      const next = bound(v + (e.deltaY < 0 ? 1 : -1) * s * (e.shiftKey ? 10 : 1));
      setDraft(null);
      if (next !== v) change(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <span
      className={`inline-flex items-center gap-1 ${fieldBox(surface)} px-2 focus-within:border-transparent focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 ${className}`}
    >
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        value={draft ?? show(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation();
            setDraft(null);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            setDraft(null);
            if (next !== value) onChange(next);
          }
        }}
        className="h-full w-full min-w-0 bg-transparent text-right font-mono tabular-nums outline-none"
        {...rest}
      />
      {unit && <span className="shrink-0 font-mono text-fg-muted">{unit}</span>}
    </span>
  );
});

/** A native select (its menu is the system's), styled as a field with a chevron. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', children, ...rest },
  ref,
) {
  const surface = useContext(FieldSurfaceContext);
  return (
    <span className={`relative inline-flex min-w-0 ${className}`}>
      <select ref={ref} className={`${fieldBox(surface)} w-full min-w-0 appearance-none pr-6 pl-2`} {...rest}>
        {children}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-fg-muted">
        <svg
          aria-hidden="true"
          viewBox="0 0 10 10"
          className="size-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M2.5 4l2.5 2.5L7.5 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** A second line under the label. */
  hint?: ReactNode;
}

/** A checkbox with its label: a 14 px box, `xs` radius, the accent fill and a check when on. */
export function Checkbox({ checked, onChange, label, hint, className = '', disabled, ...rest }: CheckboxProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 text-xs ${disabled ? 'cursor-default opacity-40' : ''} ${className}`}
    >
      <span className="relative mt-px inline-flex shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className={`peer size-3.5 appearance-none rounded-xs border border-line bg-panel-2 transition-colors duration-fast checked:border-accent checked:bg-accent ${focusRing}`}
          {...rest}
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 14 14"
          className="pointer-events-none absolute inset-0 hidden text-accent-ink peer-checked:block"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M3.5 7.2l2.3 2.3 4.7-4.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-fg">{label}</span>
        {hint && <span className="text-[11px] text-fg-muted leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name, shown at the left unless `hideLabel`. */
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/** An on/off switch (`role="switch"`): a pill track, the knob slides (`base`); on is the accent. */
export function Switch({ checked, onChange, label, hideLabel, disabled, className = '' }: SwitchProps) {
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-pill transition-colors duration-base ease-out disabled:opacity-40 ${focusRing} ${
        checked ? 'bg-accent' : 'bg-fg/14'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 size-3 rounded-pill bg-fg shadow-raised transition-transform duration-base ease-out ${
          checked ? 'translate-x-3' : ''
        }`}
      />
    </button>
  );
  if (hideLabel) return <span className={className}>{button}</span>;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the switch button inside is the labelled control
    <label className={`flex cursor-pointer items-center justify-between gap-3 text-xs ${className}`}>
      <span className="text-fg">{label}</span>
      {button}
    </label>
  );
}
