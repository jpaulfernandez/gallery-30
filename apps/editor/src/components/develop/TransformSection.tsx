import { DEVELOP_DEFAULTS, type DevelopSettings, type ManualTransform, type UprightMode } from '@photobook/shared';
import { type MouseEvent as ReactMouseEvent, useState } from 'react';
import { ASPECT_PRESETS, type CropAspect, cropOrFull, type SourceSize } from '../../lib/develop/cropEdit';
import { deepEqual } from '../../lib/develop/merge';
import type { AutoUprightMode } from '../../lib/tauri';
import { usePhotoFile } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { CardMore } from './CardMore';
import { PanelCard } from './PanelCard';
import { Slider } from './Slider';
import { runAutoUpright, runUprightUpdate, useUprightMessage } from './upright';

/** The seven manual sliders, in Lightroom's order. */
const SLIDERS: ReadonlyArray<{
  key: keyof ManualTransform;
  label: string;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  format?: (v: number) => string;
}> = [
  { key: 'vertical', label: 'Vertical', min: -100, max: 100 },
  { key: 'horizontal', label: 'Horizontal', min: -100, max: 100 },
  {
    key: 'rotate',
    label: 'Rotate',
    min: -10,
    max: 10,
    step: 0.1,
    format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`,
  },
  { key: 'aspect', label: 'Aspect', min: -100, max: 100 },
  { key: 'scale', label: 'Scale', min: 50, max: 150, defaultValue: 100, format: (v) => `${Math.round(v)}%` },
  { key: 'offsetX', label: 'X Offset', min: -100, max: 100 },
  { key: 'offsetY', label: 'Y Offset', min: -100, max: 100 },
];

/** The Upright buttons in Lightroom's order. Alt-click keeps the Transform sliders. */
const MODES: ReadonlyArray<{ mode: UprightMode; label: string; title: string }> = [
  { mode: 'off', label: 'Off', title: 'No Upright correction (the guides are kept)' },
  {
    mode: 'auto',
    label: 'Auto',
    title: 'A balanced correction: level, and the verticals (and horizontals) when the photo has clear lines',
  },
  { mode: 'level', label: 'Level', title: 'Level the photo along its horizontal (or vertical) lines' },
  { mode: 'vertical', label: 'Vertical', title: 'Level and make converging verticals parallel' },
  { mode: 'full', label: 'Full', title: 'Level, vertical and horizontal perspective together' },
  {
    mode: 'guided',
    label: 'Guided',
    title: 'Draw 2 to 4 guides along lines that should be level or plumb. Alt-click keeps the Transform sliders.',
  },
];

const isAutoMode = (mode: UprightMode): mode is AutoUprightMode =>
  mode === 'auto' || mode === 'level' || mode === 'vertical' || mode === 'full';

/** The photo's upright pixel size: the book's record, else the scan's (undefined while unknown). */
function useSourceSize(assetId: string): SourceSize | undefined {
  const recordedWidth = useBookStore((s) => s.book?.assets[assetId]?.width);
  const recordedHeight = useBookStore((s) => s.book?.assets[assetId]?.height);
  const file = usePhotoFile(assetId);
  const width = recordedWidth ?? file?.width;
  const height = recordedHeight ?? file?.height;
  return width && height ? { width, height } : undefined;
}

interface TransformSectionProps {
  assetId: string;
  settings: DevelopSettings;
  /** Open the crop tool (`R`): its panel holds the ratio presets, straighten, rotate and the flips. */
  onCrop?: () => void;
}

/** "4:5 · 1.2°": the crop's aspect and straighten angle, under the crop tool's button; null while uncropped. */
function cropSummary(settings: DevelopSettings): string | null {
  const g = settings.geometry;
  const crop = cropOrFull(g);
  const aspect = (a: CropAspect): string | null => {
    if (a === 'free') return g.crop ? 'Free' : null;
    if (a === 'original') return 'Original';
    const preset = ASPECT_PRESETS.find(
      (p) => (p.ratio[0] === a[0] && p.ratio[1] === a[1]) || (p.ratio[0] === a[1] && p.ratio[1] === a[0]),
    );
    return preset?.label ?? `${a[0]}:${a[1]}`;
  };
  const parts = [aspect(crop.aspect), crop.angle !== 0 ? `${crop.angle.toFixed(1)}°` : null].filter(Boolean);
  if (g.rotate) parts.push(`${g.rotate}° turn`);
  if (g.flipH || g.flipV) parts.push('flipped');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Plan 54: the Crop card, first of the Develop panel (the order of operations). Basic: the crop tool's button (`R`;
 * the tool's panel holds the ratio presets, straighten, rotate and the flips) with what the crop is now. Its ▸
 * *Upright & transform* (inline in Advanced) is the former Transform section, unchanged:
 *
 * Transform section of the Develop panel (steps D2.2, D2.3): Upright Off / Auto / Level / Vertical / Full / Guided
 * with Update, a "show structure" toggle and a guide-drawing toggle, the message line, the seven manual sliders,
 * and Constrain Crop. Auto, Level, Vertical and Full analyse the photo (`runAutoUpright`) and apply the result only
 * when it finds structure; Update re-runs the current mode (guided: re-solves the guides). Choosing an Upright mode
 * resets the sliders as Lightroom does (Alt-click keeps them). Every slider drag is one undo step; masks and guides follow
 * the picture and the crop is refitted when Constrain Crop is on (see the store's `setTransform`).
 *
 * The card's reset puts the whole geometry back (crop, angle, rotation, flips, Upright and its guides, Transform) in
 * one undo step (`resetGeometry`).
 */
export function TransformSection({ assetId, settings, onCrop }: TransformSectionProps) {
  const geometry = settings.geometry;
  const [open, setOpen] = useState(false);
  const size = useSourceSize(assetId);
  const drawing = useUiStore((s) => s.developGuides);
  const showStructure = useUiStore((s) => s.showStructure);
  const message = useUprightMessage(assetId);
  /** The automatic mode being analysed (its button shows busy). */
  const [busy, setBusy] = useState<AutoUprightMode | null>(null);
  const store = () => useBookStore.getState();
  const { upright, transform } = geometry;
  const isDefault = deepEqual(geometry, DEVELOP_DEFAULTS.geometry);
  const summary = cropSummary(settings);

  /** Analyse and apply an automatic mode (nothing is written until the analysis succeeds). */
  const runAuto = (mode: AutoUprightMode, keepTransform: boolean) => {
    if (busy) return;
    setBusy(mode);
    void runAutoUpright(assetId, mode, size, { keepTransform }).finally(() => setBusy(null));
  };

  const chooseMode = (mode: UprightMode, e: ReactMouseEvent) => {
    if (isAutoMode(mode)) {
      useUiStore.getState().setDevelopGuides(false);
      runAuto(mode, e.altKey);
      return;
    }
    store().setUprightMode(assetId, mode, { keepTransform: e.altKey }, size);
    useUiStore.getState().setDevelopGuides(mode === 'guided');
    if (mode === 'guided' && upright.transform === null && upright.guides.length > 0) {
      void runUprightUpdate(assetId, size);
    } else if (mode === 'off') useUiStore.getState().setUprightMessage(null);
  };

  return (
    <PanelCard
      title="Crop"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      meta={summary && !open ? <span className="truncate text-[11px] text-fg-muted">{summary}</span> : undefined}
      onReset={() => {
        store().resetGeometry(assetId);
        useUiStore.getState().setDevelopGuides(false);
        useUiStore.getState().setUprightMessage(null);
      }}
      resetDisabled={isDefault}
      resetTitle="Reset the crop, straighten, rotation, flips, Upright and the Transform sliders"
      bodyClassName="space-y-3 px-3"
      data={{ 'data-testid': 'transform-section' }}
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={onCrop}
          disabled={!onCrop}
          aria-keyshortcuts="R"
          title="Crop and straighten (R): ratio presets, the angle, rotate and flip"
        >
          Crop &amp; straighten
          <span aria-hidden="true" className="font-mono text-fg-muted">
            R
          </span>
        </Button>
        <span className="min-w-0 truncate text-[11px] text-fg-muted">{summary ?? 'Not cropped'}</span>
      </div>
      <CardMore id="crop.transform" settings={settings}>
        <div className="flex items-center gap-1.5">
          <p className="section-title mr-auto">Upright</p>
          <button
            type="button"
            onClick={() =>
              isAutoMode(upright.mode) ? runAuto(upright.mode, true) : void runUprightUpdate(assetId, size)
            }
            disabled={
              busy !== null || (!isAutoMode(upright.mode) && upright.guides.length === 0 && upright.transform === null)
            }
            title={
              isAutoMode(upright.mode)
                ? 'Analyse the photo again and re-apply this mode (after a rotation, a flip or a new lens state)'
                : 'Solve the correction again from the guides'
            }
            className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Update
          </button>
        </div>
        <div
          role="radiogroup"
          aria-label="Upright mode"
          aria-busy={busy !== null}
          className="grid grid-cols-3 rounded-md border border-line p-0.5"
        >
          {MODES.map(({ mode, label, title }) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={upright.mode === mode}
              aria-busy={busy === mode}
              disabled={busy !== null && busy !== mode}
              title={title}
              onClick={(e) => chooseMode(mode, e)}
              className={`rounded px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${
                upright.mode === mode ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
              } ${busy === mode ? 'animate-pulse' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={showStructure}
          onClick={() => useUiStore.getState().setPref('showStructure', !showStructure)}
          title="Draw the straight lines automatic Upright found: used ones in yellow, rejected ones in grey"
          className={`w-full rounded-md border px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            showStructure ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'
          }`}
        >
          Show structure
        </button>
        <button
          type="button"
          aria-pressed={drawing}
          onClick={() => useUiStore.getState().setDevelopGuides(!drawing)}
          title="Draw and edit the guides on the photo: drag on empty space to add one (up to 4), drag an end to move it, Delete removes the selected one"
          className={`w-full rounded-md border px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            drawing ? 'border-accent bg-accent/15 text-fg' : 'border-line text-fg-muted hover:text-fg'
          }`}
        >
          {drawing ? 'Done drawing guides' : 'Draw guides'}{' '}
          <span className="text-fg-muted tabular-nums">{upright.guides.length} / 4</span>
        </button>
        {message && (
          <p
            role="status"
            data-testid="upright-message"
            className={`text-[11px] ${message.error ? 'text-warn' : 'text-fg-muted'}`}
          >
            {message.text}
          </p>
        )}
        <p className="section-title pt-1">Transform</p>
        {SLIDERS.map(({ key, label, min, max, step, defaultValue, format }) => (
          <Slider
            key={key}
            label={label}
            value={transform[key]}
            min={min}
            max={max}
            step={step}
            defaultValue={defaultValue}
            format={format}
            onChange={(v) => store().setTransform(assetId, { [key]: v }, size)}
          />
        ))}
        <label className="flex items-center gap-2 text-[11px] text-fg">
          <input
            type="checkbox"
            checked={geometry.constrainCrop}
            onChange={(e) => store().setConstrainCrop(assetId, e.target.checked, size)}
            className="accent-accent"
          />
          Constrain Crop
        </label>
      </CardMore>
    </PanelCard>
  );
}
