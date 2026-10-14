import { createDevelop, GRADING_PRESETS, type Grading, matchGradingPreset, withGradingPreset } from '@photobook/shared';
import { useState } from 'react';
import {
  alignToHarmony,
  dragWheel,
  type GradingPatch,
  HARMONY_CHOICES,
  type HarmonyChoice,
  harmonyOf,
  snapTargets,
  spokes,
  type WheelKey,
} from '../../lib/develop/harmony';
import { GradingWheel } from '../develop/GradingWheel';
import { PanelCard } from '../develop/PanelCard';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';

const WHEELS = [
  ['shadows', 'Shadows'],
  ['midtones', 'Midtones'],
  ['highlights', 'Highlights'],
] as const;

/** Teal & orange under a Complementary lock, the Global wheel with a slight tint: spokes on every ring. */
function start(): Grading {
  const g = withGradingPreset(createDevelop().effects.grading, 'tealOrange');
  g.highlights.hue = 10;
  g.global = { hue: 45, saturation: 12, luminance: 0 };
  g.harmony = 'complementary';
  return g;
}

/**
 * Plan 55: the grading wheels in a card as the Effects card draws them (`GradingWheel`, the harmony lock of
 * `lib/develop/harmony.ts`, the preset chips), on local state (no book, no `invoke`). Drag a wheel under a lock to see
 * the tied wheels turn and the spokes follow; drag the Midtones (free under Complementary) onto a spoke to snap.
 */
export function GradingSink() {
  const [grading, setGrading] = useState<Grading>(start);
  const harmony = harmonyOf(grading);
  const apply = (patch: GradingPatch, next: Partial<Grading> = {}) =>
    setGrading((g) => {
      const out: Grading = { ...g, ...next };
      for (const [k, p] of Object.entries(patch)) out[k as WheelKey] = { ...out[k as WheelKey], ...p };
      return out;
    });
  const setHarmony = (choice: HarmonyChoice) =>
    setGrading((g) => {
      const { harmony: _old, ...rest } = g;
      const out: Grading = { ...rest };
      for (const [k, p] of Object.entries(alignToHarmony(g, choice)))
        out[k as WheelKey] = { ...out[k as WheelKey], ...p };
      if (choice !== 'free') out.harmony = choice;
      return out;
    });
  const preset = matchGradingPreset(grading);
  const wheel = (key: WheelKey, label: string, size?: number) => (
    <GradingWheel
      key={key}
      label={label}
      size={size}
      value={grading[key]}
      spokes={spokes(grading, harmony, key)}
      snapTargets={snapTargets(grading, harmony, key)}
      onChange={(next) => apply(dragWheel(harmony, key, next))}
    />
  );
  return (
    <div className="w-80 rounded-md bg-panel p-2" data-testid="grading-sink">
      <PanelCard title="Color grading" open onToggle={() => {}} bodyClassName="space-y-3 px-3">
        <div className="flex items-center justify-between gap-2 text-fg-2 text-xs">
          <span aria-hidden="true">Harmony lock</span>
          <Select
            aria-label="Harmony lock"
            value={harmony}
            onChange={(e) => setHarmony(e.target.value as HarmonyChoice)}
            className="w-40"
          >
            {HARMONY_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-between gap-2">{WHEELS.map(([key, label]) => wheel(key, label))}</div>
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label="Grading presets">
          {GRADING_PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="toggle"
              size="sm"
              shape="pill"
              pressed={preset === p.id}
              title={p.hint}
              onClick={() => setGrading((g) => withGradingPreset(g, p.id))}
            >
              {p.label}
            </Button>
          ))}
        </fieldset>
        <div className="flex items-start gap-3">{wheel('global', 'Global', 64)}</div>
      </PanelCard>
    </div>
  );
}
