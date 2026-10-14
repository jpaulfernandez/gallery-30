import {
  BORDER_MAX_PERCENT,
  BORDER_MAX_PX,
  type Border,
  BorderSchema,
  WATERMARK_FONT_LABELS,
  WATERMARK_FONTS,
  WATERMARK_POSITIONS,
  type Watermark,
  type WatermarkFont,
  type WatermarkPosition,
  WatermarkSchema,
} from '@photobook/shared';
import { open } from '@tauri-apps/plugin-dialog';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { importWatermark } from '../../lib/tauri';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/**
 * The Export dialog's optional groups (workflow plan 12): a collapsible group with a one-line summary, the watermark
 * (text in a shared font or an imported PNG, nine positions, size, opacity, margin) and the border (pixels or percent,
 * colour). Both are composited in Rust on the resized photo (`crates/develop/src/ops/watermark.rs`).
 */

export const fieldClass =
  'rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent disabled:opacity-40';

/** A group collapsed by default: its title and what it is set to, then its fields. */
export function Group({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-line/60">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {/* `display: flex` drops the native disclosure marker: this chevron stands in for it. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 10 10"
          className="h-2.5 w-2.5 shrink-0 text-fg-muted transition-transform group-open:rotate-90"
        >
          <path d="M3 1.5 7 5l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="w-[6.25rem] text-fg-muted">{title}</span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </summary>
      <div className="space-y-2 border-line/60 border-t px-2 py-2">{children}</div>
    </details>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-fg-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

const POSITION_LABELS: Record<WatermarkPosition, string> = {
  'top-left': 'top left',
  top: 'top',
  'top-right': 'top right',
  left: 'left',
  center: 'centre',
  right: 'right',
  'bottom-left': 'bottom left',
  bottom: 'bottom',
  'bottom-right': 'bottom right',
};

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** "Text “© Jan”, bottom right" / "Off". */
export function watermarkSummary(w: Watermark | undefined): string {
  if (!w) return 'Off';
  const what =
    w.kind === 'text' ? (w.text.trim() ? `Text “${w.text.trim()}”` : 'Text (empty)') : (w.imageName ?? 'Image (none)');
  return `${what}, ${POSITION_LABELS[w.position]}, ${percent(w.opacity)}`;
}

/** "2% white" / "12 px #000000" / "Off". */
export function borderSummary(b: Border | undefined): string {
  if (!b) return 'Off';
  return `${b.unit === 'percent' ? `${b.width}%` : `${b.width} px`} ${b.colour === '#ffffff' ? 'white' : b.colour === '#000000' ? 'black' : b.colour}`;
}

export function WatermarkGroup({
  value,
  onChange,
}: {
  value: Watermark | undefined;
  onChange: (next: Watermark | undefined) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const w = value;
  const set = (patch: Partial<Watermark>) => {
    if (w) onChange(WatermarkSchema.parse({ ...w, ...patch }));
  };
  const chooseImage = async () => {
    setError(null);
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (typeof path !== 'string') return;
    try {
      const image = await importWatermark(path);
      set({ kind: 'image', image: image.id, imageName: image.name });
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Group title="Watermark" summary={watermarkSummary(w)}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={w !== undefined}
          onChange={(e) => onChange(e.target.checked ? WatermarkSchema.parse({ text: '©' }) : undefined)}
        />
        Add a watermark
      </label>
      {w && (
        <>
          <Field label="Show">
            <select
              aria-label="Watermark kind"
              value={w.kind}
              onChange={(e) => set({ kind: e.target.value as Watermark['kind'] })}
              className={fieldClass}
            >
              <option value="text">Text</option>
              <option value="image">Image (PNG)</option>
            </select>
          </Field>
          {w.kind === 'text' ? (
            <>
              <Field label="Text">
                <input
                  aria-label="Watermark text"
                  value={w.text}
                  maxLength={200}
                  onChange={(e) => set({ text: e.target.value })}
                  className={`min-w-0 flex-1 ${fieldClass}`}
                />
                <input
                  type="color"
                  aria-label="Watermark colour"
                  value={w.colour}
                  onChange={(e) => set({ colour: e.target.value })}
                  className="h-7 w-9 rounded border border-line bg-transparent"
                />
              </Field>
              <Field label="Font">
                <select
                  aria-label="Watermark font"
                  value={w.font}
                  onChange={(e) => set({ font: e.target.value as WatermarkFont })}
                  className={fieldClass}
                >
                  {WATERMARK_FONTS.map((f) => (
                    <option key={f} value={f}>
                      {WATERMARK_FONT_LABELS[f]}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <Field label="Image">
              <span className="min-w-0 flex-1 truncate">{w.imageName ?? 'None chosen'}</span>
              <Button size="sm" onClick={() => void chooseImage()}>
                Choose PNG…
              </Button>
            </Field>
          )}
          <Field label="Size">
            <input
              type="range"
              aria-label="Watermark size"
              min={1}
              max={30}
              value={Math.round(w.size * 100)}
              onChange={(e) => set({ size: Number(e.target.value) / 100 })}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="w-28 text-right text-fg-muted tabular-nums">{percent(w.size)} of long edge</span>
          </Field>
          <Field label="Opacity">
            <input
              type="range"
              aria-label="Watermark opacity"
              min={5}
              max={100}
              value={Math.round(w.opacity * 100)}
              onChange={(e) => set({ opacity: Number(e.target.value) / 100 })}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="w-28 text-right text-fg-muted tabular-nums">{percent(w.opacity)}</span>
          </Field>
          <Field label="Position">
            <fieldset aria-label="Watermark position" className="grid grid-cols-3 gap-1">
              {WATERMARK_POSITIONS.map((p) => (
                <Tooltip key={p} label={POSITION_LABELS[p]}>
                  <button
                    type="button"
                    aria-pressed={w.position === p}
                    aria-label={POSITION_LABELS[p]}
                    onClick={() => set({ position: p })}
                    className={`h-6 w-7 rounded-sm border outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      w.position === p ? 'border-accent bg-accent' : 'border-line bg-panel-3 hover:bg-fg/10'
                    }`}
                  />
                </Tooltip>
              ))}
            </fieldset>
            <span className="text-fg-muted">Margin</span>
            <input
              type="range"
              aria-label="Watermark margin"
              min={0}
              max={10}
              value={Math.round(w.margin * 100)}
              onChange={(e) => set({ margin: Number(e.target.value) / 100 })}
              className="min-w-0 flex-1 accent-accent"
            />
            <span className="w-10 text-right text-fg-muted tabular-nums">{percent(w.margin)}</span>
          </Field>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </Group>
  );
}

export function BorderGroup({
  value,
  onChange,
}: {
  value: Border | undefined;
  onChange: (next: Border | undefined) => void;
}) {
  const b = value;
  const set = (patch: Partial<Border>) => {
    if (!b) return;
    const next = BorderSchema.safeParse({ ...b, ...patch });
    if (next.success) onChange(next.data);
  };
  const max = b?.unit === 'px' ? BORDER_MAX_PX : BORDER_MAX_PERCENT;
  return (
    <Group title="Border" summary={borderSummary(b)}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={b !== undefined}
          onChange={(e) => onChange(e.target.checked ? BorderSchema.parse({}) : undefined)}
        />
        Add a border
      </label>
      {b && (
        <Field label="Width">
          <input
            type="number"
            aria-label="Border width"
            min={0}
            max={max}
            step={b.unit === 'px' ? 1 : 0.5}
            value={b.width}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) set({ width: Math.min(max, Math.max(0, v)) });
            }}
            className={`w-20 ${fieldClass}`}
          />
          <select
            aria-label="Border unit"
            value={b.unit}
            onChange={(e) => {
              const unit = e.target.value as Border['unit'];
              set({ unit, width: unit === 'percent' ? Math.min(b.width, BORDER_MAX_PERCENT) : b.width });
            }}
            className={fieldClass}
          >
            <option value="percent">% of long edge</option>
            <option value="px">px</option>
          </select>
          <input
            type="color"
            aria-label="Border colour"
            value={b.colour}
            onChange={(e) => set({ colour: e.target.value })}
            className="h-7 w-9 rounded border border-line bg-transparent"
          />
        </Field>
      )}
      <p className="text-fg-muted">
        With a long edge set, the photo shrinks to make room, so the file keeps that long edge.
      </p>
    </Group>
  );
}
