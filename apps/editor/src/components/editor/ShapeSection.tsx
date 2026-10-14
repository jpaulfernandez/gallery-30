import { type PhotoElement, SHAPE_KINDS, type Shape, type ShapeKind, shapeClip } from '@photobook/shared';
import type { ReactNode } from 'react';
import { useBookStore } from '../../store/book';
import { Button } from '../ui/Button';
import { Switch as UiSwitch } from '../ui/Field';
import { Tooltip } from '../ui/Tooltip';
import { usePointerGesture } from './gestures';
import { Field, Section } from './inspectorUi';

/**
 * Inspector "Shape" section for a photo slot: a segmented row of shape kinds plus the chosen
 * kind's controls. Shapes only clip the slot, so the crop is never touched (a circle also squares
 * the frame, see `setShape`).
 */

const LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  rounded: 'Rounded',
  circle: 'Circle',
  ellipse: 'Ellipse',
  arch: 'Arch',
  diamond: 'Diamond',
  polygon: 'Polygon',
  blob: 'Blob',
};

const DEFAULT_RADIUS = 0.12;
const DEFAULT_SIDES = 6;
const DEFAULT_STAR_INSET = 0.5;
const DEFAULT_BLOB_POINTS = 6;
const DEFAULT_ROUGHNESS = 0.5;

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

/** The shape a kind starts with when picked (`seed` only matters for a blob). */
function shapeFor(kind: ShapeKind, seed = 7): Shape {
  switch (kind) {
    case 'rounded':
      return { kind, radius: DEFAULT_RADIUS };
    case 'polygon':
      return { kind, sides: DEFAULT_SIDES, rotation: 0 };
    case 'blob':
      return { kind, points: DEFAULT_BLOB_POINTS, seed, roughness: DEFAULT_ROUGHNESS };
    default:
      return { kind };
  }
}

/** Icon: the kind's own outline (square frame), drawn by the shared shape code. */
function ShapeIcon({ kind }: { kind: ShapeKind }) {
  const d = shapeClip(shapeFor(kind), 1, '')?.outline ?? 'M0 0 L1 0 L1 1 L0 1 Z';
  return (
    <svg viewBox="-0.12 -0.12 1.24 1.24" className="mx-auto size-3.5" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const onPointerDown = usePointerGesture();
  return (
    <Field label={props.label}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onPointerDown={onPointerDown}
          onChange={(e) => props.onChange(Number(e.target.value))}
          aria-label={props.label}
          className="w-28 accent-accent"
        />
        <span className="w-9 text-right text-fg-muted text-xs tabular-nums">
          {props.value}
          {props.unit}
        </span>
      </div>
    </Field>
  );
}

function Stepper(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  const button = (delta: number, text: ReactNode, label: string) => (
    <button
      type="button"
      aria-label={label}
      disabled={props.value + delta < props.min || props.value + delta > props.max}
      onClick={() => props.onChange(Math.min(props.max, Math.max(props.min, props.value + delta)))}
      className="h-6 w-6 rounded text-fg-muted text-xs hover:text-fg disabled:opacity-40 disabled:hover:text-fg-muted"
    >
      {text}
    </button>
  );
  return (
    <Field label={props.label}>
      <div className="flex items-center rounded-md border border-line">
        {button(-1, '−', `Fewer ${props.label.toLowerCase()}`)}
        <span className="w-6 text-center text-xs tabular-nums" aria-live="polite">
          {props.value}
        </span>
        {button(1, '+', `More ${props.label.toLowerCase()}`)}
      </div>
    </Field>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <Field label={label}>
      <UiSwitch hideLabel label={label} checked={checked} onChange={onChange} />
    </Field>
  );
}

const percent = (fraction: number): number => Math.round(fraction * 100);

export function ShapeSection({ pageId, element }: { pageId: string; element: PhotoElement }) {
  const setShape = useBookStore((s) => s.setShape);
  const shape: Shape = element.shape ?? { kind: 'rect' };
  const apply = (next: Shape) => setShape(pageId, element.id, next);

  return (
    <Section title="Shape">
      <div role="radiogroup" aria-label="Frame shape" className="grid grid-cols-8 rounded-md border border-line p-0.5">
        {SHAPE_KINDS.map((kind) => {
          const active = shape.kind === kind;
          return (
            <Tooltip key={kind} label={LABELS[kind]} className="flex [&>*]:flex-1">
              {/* biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons */}
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={LABELS[kind]}
                onClick={() => {
                  if (!active) apply(shapeFor(kind, randomSeed()));
                }}
                className={`rounded py-1 ${active ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'}`}
              >
                <ShapeIcon kind={kind} />
              </button>
            </Tooltip>
          );
        })}
      </div>

      {shape.kind === 'rounded' && (
        <Slider
          label="Radius"
          min={0}
          max={50}
          value={percent(shape.radius)}
          unit="%"
          onChange={(v) => apply({ ...shape, radius: v / 100 })}
        />
      )}

      {shape.kind === 'circle' && (
        <p className="text-[11px] text-fg-muted leading-relaxed">The frame is kept square around its centre.</p>
      )}

      {shape.kind === 'polygon' && (
        <>
          <Stepper label="Sides" min={3} max={12} value={shape.sides} onChange={(v) => apply({ ...shape, sides: v })} />
          <Slider
            label="Rotation"
            min={0}
            max={360}
            value={Math.round(shape.rotation)}
            unit="°"
            onChange={(v) => apply({ ...shape, rotation: v })}
          />
          <Switch
            label="Star"
            checked={shape.inset !== undefined}
            onChange={(on) => {
              const { inset: _drop, ...regular } = shape;
              apply(on ? { ...regular, inset: DEFAULT_STAR_INSET } : regular);
            }}
          />
          {shape.inset !== undefined && (
            <Slider
              label="Inner radius"
              min={10}
              max={95}
              value={percent(shape.inset)}
              unit="%"
              onChange={(v) => apply({ ...shape, inset: v / 100 })}
            />
          )}
        </>
      )}

      {shape.kind === 'blob' && (
        <>
          <Stepper
            label="Points"
            min={3}
            max={12}
            value={shape.points}
            onChange={(v) => apply({ ...shape, points: v })}
          />
          <Slider
            label="Roughness"
            min={0}
            max={100}
            value={percent(shape.roughness)}
            unit="%"
            onChange={(v) => apply({ ...shape, roughness: v / 100 })}
          />
          <Field label="Variation">
            <Button size="sm" onClick={() => apply({ ...shape, seed: randomSeed() })}>
              Shuffle
            </Button>
          </Field>
        </>
      )}
    </Section>
  );
}
