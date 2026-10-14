import type { DevelopSettings } from '@photobook/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { usePhotoFile, usePhotoHash } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetFolder } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { Tooltip } from '../ui/Tooltip';
import { containRect, previewCenter, shownPosition, useCropPreview, useDenoise } from './useDenoise';

/** A press on the loupe held this long without moving shows the before crop until release. */
export const LOUPE_HOLD_MS = 200;
/** Pixels a press must travel before it drags the loupe (shorter presses and holds stay put). */
const DRAG_THRESHOLD = 4;
/** The crop `preview_denoise_crop` cuts, in source pixels. */
const CROP_PX = 512;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The split stays this far inside the window, so its handle can always be grabbed again. */
const SPLIT_MIN = 0.02;
const SPLIT_MAX = 0.98;
const clampSplit = (v: number) => clamp(v, SPLIT_MIN, SPLIT_MAX);

interface DenoiseLoupeProps {
  assetId: string;
  settings: DevelopSettings;
  /** Aspect (width / height) of the picture shown in the box, null while unknown (the picture fills it). */
  ar: number | null;
}

/**
 * The Denoise loupe (workflow plan 28): a 100 % window over the Develop picture, pinned to the point
 * `ui.denoise.center` (fractions of the upright source; `shownPosition` places it on the picture shown). It shows the
 * 512 px crop `preview_denoise_crop` renders there (`useCropPreview`: at once when it opens, then 600 ms after the
 * sliders settle), split in two: before on the left of the split handle, after on the right.
 *
 * - Drag the window to move the point (the crop renders again where it is dropped); arrow keys nudge it.
 * - Drag the split handle (or focus it and use the arrow keys) to move the split.
 * - Press and hold the window (`LOUPE_HOLD_MS` without moving), or turn on Before / After (`\`), for the before crop.
 * - Colour with the chroma filter shows at once on the picture around the loupe (the filter runs in the live render);
 *   inside the loupe it waits for the crop like everything else.
 * - Plan 49, the sweep (ODDHALLS_LAYOUT_PLAN 6): as a result arrives, the noisy crop covers the loupe and a line sweeps
 *   once from left to right, uncovering it (`loupe-sweep` in `styles.css`, `slow`; a cut under reduced motion).
 *
 * Mounted by `DevelopImage` (DevelopMode) while the loupe is open and the photo has denoise on.
 */
export function DenoiseLoupe({ assetId, settings, ar }: DenoiseLoupeProps) {
  const center = useUiStore((s) => s.denoise.center);
  const showBefore = useUiStore((s) => s.developBeforeAfter);
  const d = useDenoise(assetId, settings);
  const folder = useBookStore((s) => assetFolder(s, assetId));
  const recordedPath = useBookStore((s) => s.book?.assets[assetId]?.path);
  const file = usePhotoFile(assetId);
  const relPath = recordedPath ?? file?.relPath;
  const hash = usePhotoHash(assetId);
  const ready = d.view.kind !== 'loading' && d.view.kind !== 'missingModel' && d.view.kind !== 'off';
  const preview = useCropPreview({ enabled: ready, folder, relPath, hash, settings, center });

  const boxRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((b) => (b.width === r.width && b.height === r.height ? b : { width: r.width, height: r.height }));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const [split, setSplit] = useState(0.5);
  const [holding, setHolding] = useState(false);
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const splitDrag = useRef<number | null>(null);

  // A gesture cut short by unmounting must not leave its timer behind.
  useEffect(
    () => () => {
      const g = gesture.current;
      if (g?.timer) clearTimeout(g.timer);
    },
    [],
  );

  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const full = CROP_PX / dpr;
  const side = box.width > 0 && box.height > 0 ? Math.min(full, box.width, box.height) : full;
  const fit = containRect(box.width, box.height, ar);
  const [fx, fy] = shownPosition(center, settings.geometry);
  const pointX = fit.x + fx * fit.w + (offset?.dx ?? 0);
  const pointY = fit.y + fy * fit.h + (offset?.dy ?? 0);
  const left = clamp(pointX - side / 2, 0, Math.max(0, box.width - side));
  const top = clamp(pointY - side / 2, 0, Math.max(0, box.height - side));

  /** Pin the loupe at a point of the picture shown (fractions), as a centre in the source frame. */
  const pinAt = (sx: number, sy: number) => {
    const next = previewCenter(sx, sy, settings.geometry);
    const now = useUiStore.getState().denoise.center;
    if (next[0] !== now[0] || next[1] !== now[1]) useUiStore.getState().updateDenoise(() => ({ center: next }));
  };

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    if (g.timer) clearTimeout(g.timer);
    gesture.current = null;
    setHolding(false);
    setOffset(null);
    if (g.moved && fit.w > 0 && fit.h > 0) {
      pinAt(fx + (e.clientX - g.x) / fit.w, fy + (e.clientY - g.y) / fit.h);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || gesture.current) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const timer = setTimeout(() => {
      const g = gesture.current;
      if (g && !g.moved) {
        g.timer = null;
        setHolding(true);
      }
    }, LOUPE_HOLD_MS);
    gesture.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false, timer };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      if (g.timer) clearTimeout(g.timer);
      g.timer = null;
      setHolding(false);
    }
    setOffset({ dx, dy });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dir: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = dir[e.key];
    if (!step || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const by = e.shiftKey ? 0.05 : 0.01;
    pinAt(clamp(fx + step[0] * by, 0, 1), clamp(fy + step[1] * by, 0, 1));
  };

  const moveSplit = (clientX: number) => {
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setSplit(clampSplit((clientX - rect.left) / rect.width));
  };

  /** Before shown whole (held, or Before / After): the split handle is out of sight but keeps its place and focus. */
  const wholeBefore = holding || showBefore;
  const shownSplit = wholeBefore ? 1 : split;
  const message = !ready
    ? d.view.kind === 'missingModel'
      ? 'Download the model to see the loupe.'
      : 'Checking…'
    : preview.error
      ? preview.error
      : !preview.after && !preview.before
        ? 'Rendering…'
        : null;

  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 z-20" data-testid="denoise-loupe-box">
      <div
        ref={windowRef}
        role="application"
        aria-roledescription="loupe"
        aria-label="Denoise loupe at 100 %. Drag or use the arrow keys to move it, hold it for before"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the loupe takes the arrow keys to move
        tabIndex={0}
        data-no-step=""
        data-testid="denoise-loupe"
        data-holding={holding || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={`pointer-events-auto absolute touch-none overflow-hidden rounded-sm bg-panel-2 shadow-[0_0_0_1px_rgba(255,255,255,0.8),0_4px_16px_rgba(0,0,0,0.6)] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          offset ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{ left, top, width: side, height: side }}
      >
        {preview.after && (
          <img
            src={preview.after}
            alt="Denoise loupe, after"
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />
        )}
        {preview.before && (
          <img
            src={preview.before}
            alt="Denoise loupe, before"
            draggable={false}
            data-testid="denoise-loupe-before"
            className="absolute inset-0 h-full w-full"
            style={{ clipPath: `inset(0 ${(1 - shownSplit) * 100}% 0 0)` }}
          />
        )}
        {preview.after && preview.before && !wholeBefore && (
          // Keyed by the result, so each new one sweeps once; afterwards the cover is clipped to nothing.
          <span key={preview.after} aria-hidden="true" className="pointer-events-none absolute inset-0">
            <img
              src={preview.before}
              alt=""
              draggable={false}
              data-testid="denoise-loupe-sweep"
              className="loupe-sweep absolute inset-0 h-full w-full"
            />
            <span className="loupe-sweep-line absolute top-0 bottom-0 w-px bg-fg/90 shadow-raised" />
          </span>
        )}
        {message && <p className="absolute inset-0 p-3 text-[11px] text-fg-muted">{message}</p>}
        <span className="absolute top-1 left-1 rounded-sm bg-stage/60 px-1 text-[10px] text-fg">Before</span>
        {!wholeBefore && (
          <span className="absolute top-1 right-6 rounded-sm bg-stage/60 px-1 text-[10px] text-fg">After</span>
        )}
        {preview.loading && (
          <span
            role="status"
            aria-label="Rendering the loupe"
            className="absolute right-1 bottom-1 size-4 animate-spin rounded-full border-2 border-fg/30 border-t-fg"
          />
        )}
        {
          <div
            role="slider"
            tabIndex={0}
            aria-label="Before / after split"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split * 100)}
            data-no-step=""
            data-testid="denoise-loupe-split"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture?.(e.pointerId);
              splitDrag.current = e.pointerId;
            }}
            onPointerMove={(e) => {
              if (splitDrag.current !== e.pointerId) return;
              e.stopPropagation();
              moveSplit(e.clientX);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              splitDrag.current = null;
            }}
            onPointerCancel={() => {
              splitDrag.current = null;
            }}
            onKeyDown={(e) => {
              const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (dir === 0) return;
              e.preventDefault();
              e.stopPropagation();
              setSplit((s) => clampSplit(s + dir * (e.shiftKey ? 0.1 : 0.02)));
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setSplit(0.5);
            }}
            className={`absolute top-0 bottom-0 w-3 -translate-x-1/2 cursor-ew-resize outline-none focus-visible:[&>span]:bg-accent ${
              wholeBefore ? 'pointer-events-none opacity-0' : ''
            }`}
            style={{ left: `${split * 100}%` }}
          >
            <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-fg/90 shadow-[0_0_2px_black]" />
          </div>
        }
        <Tooltip label="Close the loupe" className="absolute top-0.5 right-0.5 flex">
          <button
            type="button"
            aria-label="Close the loupe"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              useUiStore.getState().updateDenoise(() => ({ previewOpen: false }));
            }}
            className="flex size-5 items-center justify-center rounded-sm bg-stage/60 text-fg outline-none hover:bg-stage/80 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg
              viewBox="0 0 16 16"
              className="size-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
