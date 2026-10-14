import { type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { moveSplit } from '../../lib/develop/curve';
import { beginDevelopDrag, endDevelopDrag } from '../../store/book';
import { useIdleGesture } from '../editor/gestures';

type Splits = [number, number, number];

export const DEFAULT_SPLITS: Splits = [0.25, 0.5, 0.75];

const REGIONS = ['Shadows', 'Darks', 'Lights', 'Highlights'] as const;

interface SplitHandlesProps {
  splits: Splits;
  onChange: (splits: Splits) => void;
}

/**
 * The three region boundaries of the parametric curve (shadows | darks | lights | highlights) as draggable
 * handles on a black-to-white bar. Handles stay in order and apart (`moveSplit`); double-click one to reset it;
 * arrow keys nudge the focused one. A drag is one undo step.
 */
export function SplitHandles({ splits, onChange }: SplitHandlesProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: 0 | 1 | 2; pointerId: number } | null>(null);
  const splitsRef = useRef(splits);
  splitsRef.current = splits;
  const touchKeys = useIdleGesture(500);

  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    endDevelopDrag();
  };

  const onPointerDown = (index: 0 | 1 | 2) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginDevelopDrag();
    drag.current = { index, pointerId: e.pointerId };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const rect = barRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width <= 0 || e.pointerId !== d.pointerId) return;
    const next = moveSplit(splitsRef.current, d.index, (e.clientX - rect.left) / rect.width);
    if (next[d.index] !== splitsRef.current[d.index]) onChange(next);
  };

  return (
    <div className="px-1.5 pt-1">
      <div
        ref={barRef}
        className="relative h-2 rounded-full"
        style={{ background: 'linear-gradient(to right, #000, #fff)' }}
      >
        {splits.map((x, i) => {
          const index = i as 0 | 1 | 2;
          return (
            <div
              key={REGIONS[i + 1]}
              role="slider"
              tabIndex={0}
              aria-label={`${REGIONS[i]} / ${REGIONS[i + 1]} split`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(x * 100)}
              data-no-step=""
              data-testid={`split-${i}`}
              onPointerDown={onPointerDown(index)}
              onPointerMove={onPointerMove}
              onPointerUp={finish}
              onPointerCancel={finish}
              onLostPointerCapture={finish}
              onDoubleClick={() => {
                const next = moveSplit(splits, index, DEFAULT_SPLITS[index]);
                if (next[index] !== splits[index]) onChange(next);
              }}
              onKeyDown={(e) => {
                const dir =
                  e.key === 'ArrowRight' || e.key === 'ArrowUp'
                    ? 1
                    : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
                      ? -1
                      : 0;
                if (dir === 0 || e.metaKey || e.ctrlKey || e.altKey) return;
                e.preventDefault();
                e.stopPropagation();
                const next = moveSplit(splits, index, x + dir * (e.shiftKey ? 0.05 : 0.01));
                if (next[index] === x) return;
                touchKeys();
                onChange(next);
              }}
              className="absolute top-1/2 h-4 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none outline-none focus-visible:[&>svg]:fill-accent"
              style={{ left: `${x * 100}%` }}
            >
              <svg viewBox="0 0 12 16" className="size-full fill-fg stroke-stage/50" aria-hidden="true">
                <path d="M6 1l5 5v9H1V6z" strokeWidth={1} />
              </svg>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-fg-muted">
        {REGIONS.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </div>
    </div>
  );
}
