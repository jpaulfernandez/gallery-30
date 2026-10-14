import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { focusRing } from './Button';

/**
 * Plan 45: the segmented control of ODDHALLS_UI_PLAN 4.1. A `panel` track (`md` radius, 2 px padding) and a `panel-3`
 * indicator with the top highlight that slides (`base`) under the active item; items 12 px medium, the active one
 * `fg`, the others `fg-2`.
 */

/** Where each remembered track's indicator was last, so a track that mounts anew (a route change) slides from it. */
const lastBox = new Map<string, { left: number; width: number }>();

/** Classes of an item of a track (a `<button>`, a `<Link>` or a disabled `<span>`). */
export function segmentClass(active: boolean, disabled = false): string {
  if (disabled) return 'relative z-10 cursor-default rounded-sm px-3 py-1 font-medium text-fg-muted text-xs opacity-40';
  return `relative z-10 rounded-sm px-3 py-1 font-medium text-xs transition-colors duration-base ease-out ${focusRing} ${
    active ? 'text-fg' : 'text-fg-2 hover:text-fg'
  }`;
}

export interface SegmentedTrackProps {
  /** The items; the active one carries `data-segment-active`. */
  children: ReactNode;
  /** Changes when the active item does (the indicator moves then). */
  activeKey: string | number | null;
  /** Remember the indicator under this name across mounts (the stage tabs live in each stage's own bar). */
  memoryKey?: string;
  className?: string;
  role?: string;
  'aria-label'?: string;
  as?: 'div' | 'nav';
  onKeyDown?: (e: ReactKeyboardEvent<HTMLElement>) => void;
}

/**
 * The track and its sliding indicator around any items (buttons, links). The indicator is measured from the item
 * marked `data-segment-active` after layout, on resize, and when `activeKey` changes.
 */
export function SegmentedTrack({
  children,
  activeKey,
  memoryKey,
  className = '',
  as: Tag = 'div',
  ...rest
}: SegmentedTrackProps) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback((): { left: number; width: number } | null => {
    const el = ref.current?.querySelector<HTMLElement>('[data-segment-active]');
    return el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `activeKey` stands for the marked item, read from the DOM
  useLayoutEffect(() => {
    const next = measure();
    const remembered = memoryKey ? lastBox.get(memoryKey) : undefined;
    if (memoryKey && next) lastBox.set(memoryKey, next);
    // A fresh track starts where the last one with its name left off, then slides: two frames, so the start is
    // painted before the move and the transition runs.
    if (box === null && remembered && next && remembered.left !== next.left) {
      setBox(remembered);
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setBox(next));
      });
      return () => cancelAnimationFrame(frame);
    }
    setBox(next);
  }, [activeKey, measure, memoryKey]);

  // Re-measure when the track's size changes (a late webfont, a label change, the window).
  useEffect(() => {
    const onResize = () => setBox(measure());
    const el = ref.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(onResize);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  return (
    <Tag
      ref={ref as never}
      className={`relative inline-flex items-center rounded-md bg-panel p-0.5 ${className}`}
      {...rest}
    >
      {box && (
        <span
          aria-hidden="true"
          data-segment-indicator
          className="absolute top-0.5 bottom-0.5 rounded-sm bg-panel-3 shadow-raised transition-[left,width] duration-base ease-out"
          style={{ left: box.left, width: box.width }}
        />
      )}
      {children}
    </Tag>
  );
}

export interface SegmentedItem<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedProps<T extends string | number> {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label: string;
  memoryKey?: string;
  className?: string;
}

/**
 * A segmented choice of buttons (`aria-pressed`). Only the active item is in the Tab order; Left / Right (and Home /
 * End) move to the next enabled item and choose it.
 */
export function Segmented<T extends string | number>({
  items,
  value,
  onChange,
  label,
  memoryKey,
  className,
}: SegmentedProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  const activeIndex = items.findIndex((item) => item.value === value);
  const tabStop = activeIndex >= 0 && !items[activeIndex]?.disabled ? activeIndex : (enabled[0] ?? -1);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number | undefined;
    const at = enabled.indexOf(tabStop);
    if (e.key in keys) next = enabled[(at + (keys[e.key] ?? 0) + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const item = items[next];
    if (!item) return;
    buttons.current[next]?.focus();
    if (item.value !== value) onChange(item.value);
  };

  return (
    <SegmentedTrack
      role="group"
      aria-label={label}
      activeKey={value}
      memoryKey={memoryKey}
      className={className}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => (
        <button
          key={String(item.value)}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          aria-pressed={item.value === value}
          data-segment-active={item.value === value || undefined}
          disabled={item.disabled}
          title={item.title}
          tabIndex={i === tabStop ? 0 : -1}
          onClick={() => item.value !== value && onChange(item.value)}
          className={segmentClass(item.value === value, item.disabled)}
        >
          {item.label}
        </button>
      ))}
    </SegmentedTrack>
  );
}
