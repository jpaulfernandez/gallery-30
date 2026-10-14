import type { DevelopGeometry } from '@photobook/shared';
import { type ReactNode, useEffect, useState } from 'react';
import {
  ASPECT_PRESETS,
  type CropAspect,
  cropOrFull,
  frameOf,
  orientRatio,
  resetCropTool,
  type SourceSize,
} from '../../lib/develop/cropEdit';
import { deepEqual } from '../../lib/develop/merge';
import { useBookStore } from '../../store/book';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { type CropOverlay, nextOverlay, OVERLAY_LABEL } from './CropTool';
import { Slider } from './Slider';
import { runAutoLevelCrop } from './upright';

interface CropPanelProps {
  assetId: string;
  geometry: DevelopGeometry;
  size: SourceSize;
  overlay: CropOverlay;
  onOverlay: (overlay: CropOverlay) => void;
  ruler: boolean;
  onRuler: (on: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}

const sameRatio = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.abs(a[0] * b[1] - a[1] * b[0]) <= 1e-9 * Math.max(1, a[0] * b[1]);

/** Which preset button the aspect lights up. */
function presetOf(aspect: CropAspect): string {
  if (aspect === 'free') return 'Free';
  if (aspect === 'original') return 'Original';
  for (const p of ASPECT_PRESETS) {
    if (sameRatio(aspect, p.ratio) || sameRatio(aspect, [p.ratio[1], p.ratio[0]])) return p.label;
  }
  return 'Custom';
}

/** A whole-number `[w, h]` for a ratio, small when it can be (3:2, not 1200:800). */
function ratioTuple(r: number): [number, number] {
  for (let d = 1; d <= 20; d++) {
    const n = Math.round(r * d);
    if (n > 0 && Math.abs(n / d - r) < 1e-6) return [n, d];
  }
  return [Number(r.toFixed(4)), 1];
}

/**
 * Right panel while the crop tool is open (replaces the adjustment sections, as Lightroom's tool drawer does):
 * aspect presets with a lock, the Angle slider and the straighten ruler, rotate and flip, constrain to image,
 * the overlay, Reset, and Cancel / Done.
 */
export function CropPanel({
  assetId,
  geometry,
  size,
  overlay,
  onOverlay,
  ruler,
  onRuler,
  onApply,
  onCancel,
}: CropPanelProps) {
  const store = () => useBookStore.getState();
  const crop = cropOrFull(geometry);
  const { ia } = frameOf(geometry, size);
  const active = presetOf(crop.aspect);
  const locked = crop.aspect !== 'free';
  const [custom, setCustom] = useState<[string, string]>(['3', '2']);
  useEffect(() => {
    if (Array.isArray(crop.aspect)) setCustom([String(crop.aspect[0]), String(crop.aspect[1])]);
  }, [crop.aspect]);
  const setAspect = (aspect: CropAspect) => store().setCropAspect(assetId, aspect, size);
  /** The crop Auto (level) button: busy while analysing, then its message line. */
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMessage, setAutoMessage] = useState<{ assetId: string; text: string; ok: boolean } | null>(null);
  const autoLevel = () => {
    if (autoBusy) return;
    setAutoBusy(true);
    void runAutoLevelCrop(assetId, size)
      .then(({ ok, text }) => setAutoMessage(text ? { assetId, text, ok } : null))
      .finally(() => setAutoBusy(false));
  };

  const toggleLock = () => {
    if (locked) return setAspect('free');
    const r = (crop.rect.w * ia) / crop.rect.h;
    setAspect(Math.abs(r - ia) < 1e-6 ? 'original' : ratioTuple(r));
  };
  const applyCustom = () => {
    const [w, h] = custom.map((v) => Number(v.trim().replace(',', '.')));
    if (!w || !h || !(w > 0) || !(h > 0)) return;
    setAspect([w, h]);
  };

  // Reset keeps Upright and the Transform (Lightroom's crop Reset), so "default" is what Reset would give.
  const geometryDefault = deepEqual(resetCropTool(geometry, size), geometry);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      data-testid="crop-panel"
    >
      <div className="flex items-center gap-1.5 border-line border-b px-3 py-2">
        <h2 className="section-title mr-auto">Crop &amp; Straighten</h2>
        <SmallButton
          onClick={() => store().resetCrop(assetId, size)}
          disabled={geometryDefault}
          title="Reset crop, angle, rotation and flips (Upright and the Transform stay)"
        >
          Reset
        </SmallButton>
      </div>

      <div className="space-y-4 px-3 py-3">
        <div className="space-y-2">
          <div className="flex items-center">
            <p className="section-title mr-auto">Aspect</p>
            <button
              type="button"
              aria-pressed={locked}
              aria-label="Lock aspect"
              title={locked ? 'Unlock the aspect' : 'Lock the current aspect'}
              onClick={toggleLock}
              className={`rounded-md border px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                locked ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'
              }`}
            >
              {locked ? 'Locked' : 'Unlocked'}
            </button>
          </div>
          <div role="radiogroup" aria-label="Crop aspect" className="grid grid-cols-4 gap-1">
            <AspectButton label="Original" active={active} onClick={() => setAspect('original')} />
            <AspectButton label="Free" active={active} onClick={() => setAspect('free')} />
            {ASPECT_PRESETS.map((p) => (
              <AspectButton
                key={p.label}
                label={p.label}
                active={active}
                onClick={() => setAspect(orientRatio(p.ratio, crop.rect, ia))}
              />
            ))}
            <AspectButton label="Custom" active={active} onClick={applyCustom} />
          </div>
          <div className="flex items-center gap-1.5 text-[11px]">
            <input
              aria-label="Custom aspect width"
              inputMode="decimal"
              value={custom[0]}
              onChange={(e) => setCustom([e.target.value, custom[1]])}
              onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
              className="w-12 rounded-md border border-line bg-transparent px-1.5 py-0.5 text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <span className="text-fg-muted">:</span>
            <input
              aria-label="Custom aspect height"
              inputMode="decimal"
              value={custom[1]}
              onChange={(e) => setCustom([custom[0], e.target.value])}
              onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
              className="w-12 rounded-md border border-line bg-transparent px-1.5 py-0.5 text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <SmallButton
              onClick={() => store().swapCropOrientation(assetId, size)}
              title="Swap portrait and landscape (X)"
            >
              Swap <span className="text-fg-muted">X</span>
            </SmallButton>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <Slider
                label="Angle"
                value={crop.angle}
                min={-45}
                max={45}
                step={0.1}
                format={(v) => `${v.toFixed(1)}°`}
                onChange={(v) => store().setCropAngle(assetId, v, size)}
              />
            </div>
            <Button
              size="sm"
              onClick={autoLevel}
              disabled={autoBusy}
              aria-busy={autoBusy}
              aria-label="Auto straighten"
              title="Level the photo along its straight lines (sets the Angle)"
              className={autoBusy ? 'animate-pulse' : ''}
            >
              Auto
            </Button>
          </div>
          {autoMessage?.assetId === assetId && (
            <p
              role="status"
              data-testid="crop-auto-message"
              className={`text-[11px] ${autoMessage.ok ? 'text-fg-muted' : 'text-warn'}`}
            >
              {autoMessage.text}
            </p>
          )}
          <button
            type="button"
            aria-pressed={ruler}
            onClick={() => onRuler(!ruler)}
            title="Drag along a line that should be level or plumb (or hold Cmd while dragging)"
            className={`w-full rounded-md border px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              ruler ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'
            }`}
          >
            Straighten tool
          </button>
        </div>

        <div className="space-y-2">
          <p className="section-title">Orientation</p>
          <div className="grid grid-cols-4 gap-1">
            <IconButton label="Rotate left" onClick={() => store().rotate90(assetId, -1)}>
              <path d="M4 7a5 5 0 1 1 1.5 4.5M4 3v4h4" strokeLinecap="round" strokeLinejoin="round" />
            </IconButton>
            <IconButton label="Rotate right" onClick={() => store().rotate90(assetId, 1)}>
              <path d="M12 7a5 5 0 1 0-1.5 4.5M12 3v4H8" strokeLinecap="round" strokeLinejoin="round" />
            </IconButton>
            <IconButton label="Flip horizontal" pressed={geometry.flipH} onClick={() => store().flip(assetId, 'h')}>
              <path d="M8 2v12M6 4L2 12h4zM10 4l4 8h-4z" strokeLinejoin="round" />
            </IconButton>
            <IconButton label="Flip vertical" pressed={geometry.flipV} onClick={() => store().flip(assetId, 'v')}>
              <path d="M2 8h12M4 6l8-4v4zM4 10l8 4v-4z" strokeLinejoin="round" />
            </IconButton>
          </div>
        </div>

        <label className="flex items-center gap-2 text-[11px] text-fg">
          <input
            type="checkbox"
            checked={geometry.constrainCrop}
            onChange={(e) => store().setConstrainCrop(assetId, e.target.checked, size)}
            className="accent-accent"
          />
          Constrain to image
        </label>

        <div className="flex items-center text-[11px]">
          <span className="section-title mr-auto">Overlay</span>
          <SmallButton onClick={() => onOverlay(nextOverlay(overlay))} title="Cycle the guides (O)">
            {OVERLAY_LABEL[overlay]} <span className="text-fg-muted">O</span>
          </SmallButton>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-end gap-2 border-line border-t px-3 py-2">
        <SmallButton onClick={onCancel} title="Discard the changes made since the tool opened (Esc)">
          Cancel
        </SmallButton>
        <button
          type="button"
          onClick={onApply}
          title="Apply the crop (Return)"
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] text-accent-ink outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function AspectButton({ label, active, onClick }: { label: string; active: string; onClick: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
    <button
      type="button"
      role="radio"
      aria-checked={active === label}
      onClick={onClick}
      className={`rounded px-1 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active === label ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} className="flex [&>*]:flex-1">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={`flex items-center justify-center rounded-md border py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          pressed ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          {children}
        </svg>
      </button>
    </Tooltip>
  );
}

function SmallButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    >
      {children}
    </button>
  );
}
