import { type BookTemplate, inchFraction, type PageGuide, type SnapAxis } from '@photobook/shared';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useUiStore } from '../../store/ui';
import { trackPointerDrag } from './gestures';
import {
  addPageGuide,
  formatInches,
  guideInches,
  movePageGuide,
  parseGuideValue,
  removePageGuide,
  roundGuideValue,
  rulerLengthIn,
  rulerTicks,
} from './pageGuides';
import { NO_GUIDES, useSnapGuides } from './snap';

/** Ruler thickness, CSS px. */
export const RULER_SIZE = 16;
/** Space between a ruler and the page edge, CSS px. */
export const RULER_GAP = 6;
/** Width of a guide's grab area, CSS px (the line itself is 1 px): narrow, so a frame edge beside it stays clickable. */
const GUIDE_HIT = 5;
/** A press must travel this far (CSS px) before it drags a guide: a click or a jittery double-click moves nothing. */
const DRAG_THRESHOLD = 3;
/** Arrow keys nudge a focused guide by this many inches (Shift: ten times as far). */
const NUDGE_IN = 0.01;

/** Which guides an arrow key moves (along their own axis) and which way. */
const ARROWS: Record<string, { axis: SnapAxis; dir: number }> = {
  ArrowLeft: { axis: 'x', dir: -1 },
  ArrowRight: { axis: 'x', dir: 1 },
  ArrowUp: { axis: 'y', dir: -1 },
  ArrowDown: { axis: 'y', dir: 1 },
};

/** A guide drag in progress: a new one (`index` null) or guide `index` of the page. */
interface GuideDrag {
  axis: SnapAxis;
  index: number | null;
  value: number;
  /** The pointer is off the page along the guide's axis: a new guide is not added, a moved one is removed. */
  off: boolean;
}

/**
 * Rulers and ruler guides of the page on the canvas (workflow plan 31). The rulers sit just outside
 * the page's top and left edges, in inches on the 8 in reference page (the unit of every canvas
 * measure). A drag from the top ruler pulls out a horizontal guide, from the left ruler a vertical
 * one; a guide drags along its axis and, dropped off the page (back onto its ruler), is removed; a
 * double-click (or Enter on a focused guide) types its position ("2.5", "2.5 in", "64 mm"), Delete
 * removes it. Each add, move and removal is one undo step (committed on release). Guides live in
 * `page.guides` (fractions of the page), snap frames while shown (`snapElementFrame`) and never
 * reach the shared renderer. "Show rulers and guides" in the View menu hides all of it.
 */
export const Rulers = memo(function Rulers({
  pageId,
  template,
  guides,
  width,
  raised,
}: {
  pageId: string;
  template: Pick<BookTemplate, 'width' | 'height'>;
  guides: readonly PageGuide[];
  /** Page width on screen, CSS px. */
  width: number;
  /** Lift the guides over the frame-drawing layer (Frame tool, blank page) so they stay grabbable. */
  raised?: boolean;
}) {
  const show = useUiStore((s) => s.showRulers);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<GuideDrag | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  /** Ends the guide drag in progress without an edit (Escape, unmount). */
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  // Snap feedback: the page guides a dragged frame sits on right now are drawn brighter and wider.
  const showSnap = useUiStore((s) => s.showGuidesWhileDragging);
  const snapped = useSnapGuides((s) => (showSnap && s.pageId === pageId ? s.guides : NO_GUIDES));
  const height = (width * template.height) / template.width;
  const pxPerIn = width / rulerLengthIn(template, 'x');
  const ticksX = useMemo(() => rulerTicks(rulerLengthIn(template, 'x'), pxPerIn), [template, pxPerIn]);
  const ticksY = useMemo(() => rulerTicks(rulerLengthIn(template, 'y'), pxPerIn), [template, pxPerIn]);

  if (!show) return null;

  /**
   * Drag a new guide out of a ruler (`index` null) or an existing one; the edit lands on release. An existing guide
   * keeps the offset between the line and the press, and nothing moves before the pointer travels DRAG_THRESHOLD px.
   * Escape cancels.
   */
  const startDrag = (axis: SnapAxis, index: number | null, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    // preventDefault keeps the press from focusing; a guide takes focus for Enter, Delete and the arrows.
    if (index !== null && e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
    setEditing(null);
    cancelDrag.current?.();
    const rect = box.getBoundingClientRect();
    const along = (p: { clientX: number; clientY: number }) =>
      axis === 'x' ? (p.clientX - rect.left) / rect.width : (p.clientY - rect.top) / rect.height;
    const start = guides[index ?? -1];
    const grab = start ? start.value - along(e) : 0;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: GuideDrag | null = null;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
    };
    const stop = trackPointerDrag(
      (ev) => {
        if (!last && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
        const v = along(ev) + grab;
        const off = !(v >= 0 && v <= 1);
        last = { axis, index, value: roundGuideValue(template, axis, Math.min(1, Math.max(0, v))), off };
        setDrag(last);
      },
      (reason) => {
        window.removeEventListener('keydown', onKey, true);
        cancelDrag.current = null;
        setDrag(null);
        const end = last;
        // A press without a move, or a drag cut off by Escape, a cancel or a lost window, changes nothing.
        if (!end || reason === 'cancel' || reason === 'blur') return;
        if (index === null) {
          if (!end.off) addPageGuide(pageId, { axis, value: end.value });
        } else if (end.off) {
          removePageGuide(pageId, index);
        } else {
          movePageGuide(pageId, index, end.value);
        }
      },
    );
    cancelDrag.current = stop;
    // Capture on the window: Escape ends the drag before the editor's Escape (clear the selection) sees it.
    window.addEventListener('keydown', onKey, true);
  };

  const onGuideKey = (index: number, e: ReactKeyboardEvent) => {
    const guide = guides[index];
    const arrow = ARROWS[e.key];
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(index);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
      removePageGuide(pageId, index);
    } else if (arrow && guide && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // The arrows never reach the canvas (page change, frame nudge) from a guide; only its own axis moves it.
      e.preventDefault();
      e.stopPropagation();
      if (arrow.axis !== guide.axis) return;
      const step = (e.shiftKey ? 10 : 1) * NUDGE_IN * inchFraction(template, guide.axis) * arrow.dir;
      const next = roundGuideValue(template, guide.axis, Math.min(1, Math.max(0, guide.value + step)));
      movePageGuide(pageId, index, next);
    }
  };

  const shown = guides.map((g, i) => (drag?.index === i ? null : g));
  const preview = drag && !drag.off ? drag : null;
  const editGuide = editing !== null ? guides[editing] : undefined;

  return (
    <div
      ref={boxRef}
      data-canvas-ui
      data-testid="rulers"
      className={`pointer-events-none absolute inset-0 ${raised ? 'z-[6]' : ''}`}
    >
      <Ruler
        side="top"
        length={width}
        pxPerIn={pxPerIn}
        ticks={ticksX}
        marks={guides.filter((g) => g.axis === 'x').map((g) => g.value * width)}
        onPointerDown={(e) => startDrag('y', null, e)}
      />
      <Ruler
        side="left"
        length={height}
        pxPerIn={pxPerIn}
        ticks={ticksY}
        marks={guides.filter((g) => g.axis === 'y').map((g) => g.value * height)}
        onPointerDown={(e) => startDrag('x', null, e)}
      />
      {shown.map((g, i) => {
        if (!g) return null;
        const inches = formatInches(guideInches(template, g.axis, g.value));
        const name = `${g.axis === 'x' ? 'Vertical' : 'Horizontal'} guide at ${inches}`;
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: guides have no id; the index is what the edits take
            key={i}
            type="button"
            data-page-guide={g.axis}
            data-guide-index={i}
            aria-label={name}
            title={`${name}: drag (or arrow keys) to move, off the page to remove; double-click to type a position`}
            onPointerDown={(e) => startDrag(g.axis, i, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(i);
            }}
            onKeyDown={(e) => onGuideKey(i, e)}
            className={`group pointer-events-auto absolute outline-none ${
              g.axis === 'x' ? 'cursor-ew-resize' : 'cursor-ns-resize'
            }`}
            style={
              g.axis === 'x'
                ? { left: g.value * width - GUIDE_HIT / 2, top: 0, width: GUIDE_HIT, height }
                : { top: g.value * height - GUIDE_HIT / 2, left: 0, height: GUIDE_HIT, width }
            }
          >
            <GuideLine
              axis={g.axis}
              focusable
              snapped={snapped.some(
                (h) => h.kind === 'guide' && h.axis === g.axis && Math.abs(h.value - g.value) < 1e-9,
              )}
            />
          </button>
        );
      })}
      {preview && (
        <div
          data-testid="guide-preview"
          className="absolute"
          style={
            preview.axis === 'x'
              ? { left: preview.value * width - GUIDE_HIT / 2, top: 0, width: GUIDE_HIT, height }
              : { top: preview.value * height - GUIDE_HIT / 2, left: 0, height: GUIDE_HIT, width }
          }
        >
          <GuideLine axis={preview.axis} />
          <span
            className="absolute whitespace-nowrap rounded-xs bg-guide px-1 py-px font-medium font-mono text-[10px] text-canvas tabular-nums leading-tight"
            style={preview.axis === 'x' ? { left: GUIDE_HIT, top: 4 } : { top: GUIDE_HIT, left: 4 }}
          >
            {formatInches(guideInches(template, preview.axis, preview.value))}
          </span>
        </div>
      )}
      {editing !== null && editGuide && (
        <GuideValueField
          key={editing}
          guide={editGuide}
          template={template}
          width={width}
          height={height}
          onDone={(value) => {
            setEditing(null);
            if (value !== null) movePageGuide(pageId, editing, value);
          }}
        />
      )}
    </div>
  );
});

/**
 * The guide line in the middle of its grab area: 1 px, brighter on hover and focus; 2 px and bright while a dragged
 * frame is snapped to it (`snapped`).
 */
function GuideLine({ axis, focusable, snapped }: { axis: SnapAxis; focusable?: boolean; snapped?: boolean }) {
  const thickness = snapped ? (axis === 'x' ? 'w-0.5' : 'h-0.5') : axis === 'x' ? 'w-px' : 'h-px';
  return (
    <span
      aria-hidden="true"
      data-snapped={snapped ? '' : undefined}
      className={`pointer-events-none absolute ${snapped ? 'bg-guide' : 'bg-guide/80'} ${
        focusable
          ? 'group-hover:bg-guide group-focus-visible:bg-guide group-focus-visible:shadow-[0_0_0_1px] group-focus-visible:shadow-guide'
          : ''
      } ${thickness} ${axis === 'x' ? 'inset-y-0 left-1/2 -translate-x-1/2' : 'inset-x-0 top-1/2 -translate-y-1/2'}`}
    />
  );
}

/**
 * One ruler outside the page edge: ticks in inches, labels on whole inches (mono), a mark at each guide. Plan 48:
 * `panel-2` with a hairline.
 */
function Ruler({
  side,
  length,
  pxPerIn,
  ticks,
  marks,
  onPointerDown,
}: {
  side: 'top' | 'left';
  /** Page width (top) or height (left), CSS px. */
  length: number;
  pxPerIn: number;
  ticks: ReturnType<typeof rulerTicks>;
  /** Guide positions along the ruler, CSS px. */
  marks: number[];
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const top = side === 'top';
  const tickLength = { major: RULER_SIZE - 4, half: 7, minor: 4 } as const;
  let d = '';
  for (const t of ticks) {
    const at = Math.round(t.inches * pxPerIn) + 0.5;
    const len = tickLength[t.size];
    d += top ? `M${at} ${RULER_SIZE}v${-len}` : `M${RULER_SIZE} ${at}h${-len}`;
  }
  const offset = -(RULER_SIZE + RULER_GAP);
  return (
    <div
      data-ruler={side}
      aria-hidden="true"
      title={top ? 'Drag down onto the page for a horizontal guide' : 'Drag onto the page for a vertical guide'}
      onPointerDown={onPointerDown}
      className={`pointer-events-auto absolute select-none overflow-hidden rounded-xs border border-hairline bg-panel-2 text-fg-muted ${
        top ? 'cursor-ns-resize' : 'cursor-ew-resize'
      }`}
      style={
        top
          ? { left: 0, top: offset, width: length, height: RULER_SIZE }
          : { top: 0, left: offset, height: length, width: RULER_SIZE }
      }
    >
      <svg
        width={top ? length : RULER_SIZE}
        height={top ? RULER_SIZE : length}
        className="absolute -inset-px overflow-visible font-mono"
        aria-hidden="true"
      >
        <path d={d} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1} />
        {ticks.map((t) =>
          t.label === undefined || t.inches === 0 ? null : (
            <text
              key={t.inches}
              x={top ? t.inches * pxPerIn + 2 : 9}
              y={top ? 8 : t.inches * pxPerIn - 2}
              fill="currentColor"
              fontSize={8}
              transform={top ? undefined : `rotate(-90 9 ${t.inches * pxPerIn - 2})`}
            >
              {t.label}
            </text>
          ),
        )}
        {marks.map((m, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: marks follow the guides' order
            key={i}
            d={top ? `M${m - 3} 0h6l-3 4z` : `M0 ${m - 3}v6l4 -3z`}
            className="fill-guide"
          />
        ))}
      </svg>
    </div>
  );
}

/**
 * The position field a double-click on a guide opens, on the guide's ruler: inches by default, mm or
 * cm with a unit. Enter or leaving the field moves the guide (a value off the page is ignored);
 * Escape cancels.
 */
function GuideValueField({
  guide,
  template,
  width,
  height,
  onDone,
}: {
  guide: PageGuide;
  template: Pick<BookTemplate, 'width' | 'height'>;
  width: number;
  height: number;
  onDone: (value: number | null) => void;
}) {
  const [text, setText] = useState(() => guideInches(template, guide.axis, guide.value).toFixed(2));
  const done = useRef(false);
  const finish = (value: number | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const offset = -(RULER_SIZE + RULER_GAP);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field appears because the user double-clicked the guide
      autoFocus
      aria-label={`${guide.axis === 'x' ? 'Vertical' : 'Horizontal'} guide position, inches (or mm, cm)`}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(parseGuideValue(text, template, guide.axis))}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(parseGuideValue(text, template, guide.axis));
        else if (e.key === 'Escape') finish(null);
      }}
      className="pointer-events-auto absolute z-20 w-16 rounded-xs border border-guide bg-panel-2 px-1 py-px font-mono text-[11px] text-fg tabular-nums outline-none"
      style={
        guide.axis === 'x'
          ? { left: Math.min(guide.value * width + 4, width - 64), top: offset - 2 }
          : { top: Math.min(guide.value * height + 4, height - 20), left: offset - 2 }
      }
    />
  );
}
