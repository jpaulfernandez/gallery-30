import type { DevelopMask, DevelopSettings } from '@photobook/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { approximateMask, type CropMapping } from '../../lib/develop/masks';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { developMaskOverlay } from '../../lib/tauri';
import { nextPreviewJob, PREVIEW_COALESCE_MS, type PreviewSource } from './usePreview';

/** The overlay tint (Lightroom's red) and its strength at full mask. */
const TINT: readonly [number, number, number] = [235, 40, 40];
const TINT_ALPHA = 0.5;
/** Long edge of the approximation grid, px. */
const APPROX_EDGE = 192;

/** Wait until the browser has decoded `url`. */
async function decodeImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  if (typeof img.decode === 'function') {
    try {
      await img.decode();
    } catch {
      // Drawing a broken image draws nothing.
    }
  }
  return img;
}

/** What identifies an overlay: the mask and the geometry (the only inputs of `develop_mask_overlay`). */
export const overlayKey = (mask: DevelopMask | undefined, settings: DevelopSettings): string | null =>
  mask ? JSON.stringify([mask, settings.geometry]) : null;

export interface MaskOverlayResult {
  /** Blob URL of the greyscale JPEG. */
  url: string;
  /** `overlayKey` it was rendered for. */
  key: string;
}

/**
 * The composited plane of mask `maskId` from `develop_mask_overlay`, as a blob URL with the key it was rendered for
 * (null until the first one arrives, and while `active` is false). Same pattern as `useMaskPreview`: numbered
 * requests coalesced to one per `PREVIEW_COALESCE_MS` carrying the newest settings, superseded results dropped, the
 * blob freed on leaving. Only the mask and the geometry trigger a request (tone sliders do not change the plane).
 */
export function useMaskOverlay(
  source: PreviewSource,
  settings: DevelopSettings,
  maskId: string | null,
  active: boolean,
): MaskOverlayResult | null {
  const { folder, assetId, relPath, hash } = source;
  const sourceKey =
    folder && relPath && hash && maskId ? `${folder}\n${assetId}\n${relPath}\n${hash}\n${maskId}` : null;
  const mask = maskId ? settings.masks.find((m) => m.id === maskId) : undefined;
  const key = useMemo(() => overlayKey(mask, settings), [mask, settings]);

  const [shown, setShown] = useState<(MaskOverlayResult & { sourceKey: string }) | null>(null);
  const urlRef = useRef<string | null>(null);
  const latestJob = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ folder, relPath, hash, settings, sourceKey, maskId, key });
  live.current = { folder, relPath, hash, settings, sourceKey, maskId, key };

  useEffect(() => {
    if (!active || !sourceKey) return;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      latestJob.current = nextPreviewJob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      setShown(null);
    };
  }, [active, sourceKey]);

  useEffect(() => {
    if (!active || !sourceKey || !key) return;
    if (timer.current) return;
    timer.current = setTimeout(async () => {
      timer.current = null;
      const now = live.current;
      if (!now.folder || !now.relPath || !now.hash || !now.maskId || !now.key) return;
      const job = nextPreviewJob();
      latestJob.current = job;
      try {
        const bytes = await developMaskOverlay(now.folder, now.relPath, now.hash, now.settings, now.maskId);
        if (job !== latestJob.current || bytes.byteLength === 0) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setShown({ url, key: now.key, sourceKey: now.sourceKey ?? '' });
      } catch (err) {
        if (job === latestJob.current) devLog('develop', 'mask overlay unavailable', { error: errorMessage(err) });
      }
    }, PREVIEW_COALESCE_MS);
  }, [active, sourceKey, key]);

  return active && shown && shown.sourceKey === sourceKey ? { url: shown.url, key: shown.key } : null;
}

/** A 2-D context, or null where canvas is unavailable (tests). */
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** Paint `values` (0..1, `w × h`) into the canvas as the red tint. */
export function paintTint(canvas: HTMLCanvasElement, values: ArrayLike<number>, w: number, h: number): boolean {
  canvas.width = w;
  canvas.height = h;
  const ctx = context(canvas);
  if (!ctx) return false;
  const data = ctx.createImageData(w, h);
  for (let k = 0; k < w * h; k++) {
    const v = Math.min(Math.max(values[k] ?? 0, 0), 1);
    data.data[k * 4] = TINT[0];
    data.data[k * 4 + 1] = TINT[1];
    data.data[k * 4 + 2] = TINT[2];
    data.data[k * 4 + 3] = Math.round(v * TINT_ALPHA * 255);
  }
  ctx.putImageData(data, 0, 0);
  return true;
}

/** Read a decoded greyscale image's values (0..1) through a scratch canvas. */
function greyValues(img: HTMLImageElement): { values: Float32Array; w: number; h: number } | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = context(scratch);
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const values = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) values[k] = (px[k * 4] ?? 0) / 255;
  return { values, w, h };
}

export interface MaskOverlayProps {
  mask: DevelopMask;
  mapping: CropMapping;
  /** The developed picture on screen. */
  rect: { left: number; top: number; width: number; height: number };
  /** The Rust overlay, when one has arrived. */
  rendered: MaskOverlayResult | null;
  /** `overlayKey` of the current mask: a rendered overlay with another key is stale. */
  currentKey: string | null;
  /**
   * An AI job is rewriting this mask (D4.3): AI components have no JS approximation, so the stale tint is hidden
   * until the new raster's overlay arrives.
   */
  generating?: boolean;
}

/**
 * The red mask overlay over the developed picture. Shows the Rust plane (`develop_mask_overlay`) when it matches the
 * current mask; while it is stale (a handle or the brush is moving) and the mask has only brush, linear and radial
 * components, a JS approximation (`approximateMask`) follows the pointer instead; otherwise the last plane stays,
 * except while an AI job is generating the mask (`generating`), when nothing is tinted.
 */
export function MaskOverlay({ mask, mapping, rect, rendered, currentKey, generating = false }: MaskOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fresh = rendered !== null && rendered.key === currentKey;
  const approx = useMemo(() => {
    if (fresh) return null;
    const long = Math.max(rect.width, rect.height, 1);
    const s = Math.min(APPROX_EDGE / long, 1);
    const gw = Math.max(Math.round(rect.width * s), 1);
    const gh = Math.max(Math.round(rect.height * s), 1);
    const values = approximateMask(mask, mapping, gw, gh);
    return values ? { values, gw, gh } : null;
  }, [fresh, mask, mapping, rect.width, rect.height]);
  const source: 'rendered' | 'approx' | 'none' = generating
    ? 'none'
    : fresh
      ? 'rendered'
      : approx
        ? 'approx'
        : rendered
          ? 'rendered'
          : 'none';
  const renderedUrl = rendered?.url ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (source === 'approx' && approx) {
      paintTint(canvas, approx.values, approx.gw, approx.gh);
      return;
    }
    if (source !== 'rendered' || !renderedUrl) return;
    let cancelled = false;
    void decodeImage(renderedUrl).then((img) => {
      if (cancelled) return;
      const grey = greyValues(img);
      if (grey) paintTint(canvas, grey.values, grey.w, grey.h);
    });
    return () => {
      cancelled = true;
    };
  }, [source, approx, renderedUrl]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="mask-overlay"
      data-source={source}
      data-generating={generating ? '' : undefined}
      className={`pointer-events-none absolute ${source === 'none' ? 'invisible' : ''}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />
  );
}

/** Plan 56: distance of the rotate handle past the shape it turns (the radial's edge, the linear's 50 % line), px. */
export const ROTATE_GAP = 24;
/** Radius of the mask handles, px. */
export const HANDLE_R = 5;

/**
 * Plan 56 (ODDHALLS_LAYOUT_PLAN 4.4): the rotate handle both gradient tools share, so they match: a stem from `from`
 * (the shape's edge) to `at`, and a round handle with a turning arrow in it. `data-mask-handle="rotate"` is what the
 * tools' pointer-down looks for.
 */
export function RotateHandle({ from, at }: { from: readonly [number, number]; at: readonly [number, number] }) {
  const [x, y] = at;
  const r = HANDLE_R + 1;
  return (
    <g data-testid="rotate-handle">
      <line x1={from[0]} y1={from[1]} x2={x} y2={y} stroke="white" strokeWidth={1} pointerEvents="none" />
      <circle
        cx={x}
        cy={y}
        r={r}
        fill="white"
        stroke="rgba(0,0,0,0.6)"
        data-mask-handle="rotate"
        style={{ cursor: 'grab' }}
      />
      {/* Three quarters of a turn with an arrowhead: the glyph, drawn in the handle and left to the handle's events. */}
      <path
        d={`M ${x + r * 0.55} ${y} A ${r * 0.55} ${r * 0.55} 0 1 1 ${x} ${y - r * 0.55}`}
        fill="none"
        stroke="rgba(0,0,0,0.75)"
        strokeWidth={1}
        pointerEvents="none"
      />
      <path
        d={`M ${x - 1.5} ${y - r * 0.55 - 1.5} L ${x + 0.5} ${y - r * 0.55} L ${x - 1.5} ${y - r * 0.55 + 1.5}`}
        fill="none"
        stroke="rgba(0,0,0,0.75)"
        strokeWidth={1}
        pointerEvents="none"
      />
    </g>
  );
}

/** Plan 56: the angle while a gradient rotates, in mono beside the rotate handle. */
export function AngleBadge({ at, deg }: { at: readonly [number, number]; deg: number }) {
  return (
    <span
      data-testid="mask-angle"
      className="pointer-events-none absolute rounded-xs bg-stage/70 px-1 py-px font-mono text-[11px] text-fg tabular-nums"
      style={{ left: at[0] + 12, top: at[1] - 22 }}
    >
      {Math.round(deg)}°
    </span>
  );
}
