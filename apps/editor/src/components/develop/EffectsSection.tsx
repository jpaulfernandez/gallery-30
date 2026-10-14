import {
  DEVELOP_DEFAULTS,
  type DevelopEffects,
  type DevelopSettings,
  GRADING_PRESETS,
  type GradingWheel as GradingWheelValue,
  matchGradingPreset,
  withGradingPreset,
} from '@photobook/shared';
import { type ReactNode, useState } from 'react';
import {
  type WheelKey as AnyWheelKey,
  alignToHarmony,
  dragWheel,
  HARMONY_CHOICES,
  type HarmonyChoice,
  harmonyOf,
  snapTargets,
  spokes,
} from '../../lib/develop/harmony';
import type { DeepPartial } from '../../lib/develop/merge';
import { deepEqual } from '../../lib/develop/merge';
import { isSectionDefault } from '../../lib/develop/sections';
import { useBookStore } from '../../store/book';
import { Button, Select } from '../ui';
import { CardMore } from './CardMore';
import { GradingWheel } from './GradingWheel';
import { PanelCard } from './PanelCard';
import { Slider } from './Slider';

type EffectsGroup = keyof DevelopEffects;
type WheelKey = 'shadows' | 'midtones' | 'highlights';

const GROUP_LABELS: Record<EffectsGroup, string> = {
  grading: 'Color grading',
  vignette: 'Vignette',
  halation: 'Halation',
  grain: 'Grain',
};
const WHEELS: Array<{ key: WheelKey; label: string }> = [
  { key: 'shadows', label: 'Shadows' },
  { key: 'midtones', label: 'Midtones' },
  { key: 'highlights', label: 'Highlights' },
];
const plain = (v: number) => String(v);

interface EffectsSectionProps {
  assetId: string;
  settings: DevelopSettings;
}

/**
 * The Effects section of the Develop panel (workflow plan 17): Color grading (Shadows, Midtones and Highlights as a
 * hue and a saturation slider each, plus Blending and Balance), Vignette, Halation and Grain, each group with its own
 * Reset. The engine renders them on the GPU like every other section (plan 19).
 *
 * Plan 54: Basic shows the grading wheels and each effect's amount; each group's ▸ (inline in Advanced) holds the
 * rest: Blending and Balance, the vignette's Midpoint, Feather and Roundness, the halation's Threshold and Radius, the
 * grain's Size and Roughness.
 *
 * Plan 55 (ODDHALLS_LAYOUT_PLAN 4.2): the grading is three wheels (`GradingWheel`) under the harmony lock ▾ and over
 * the preset chips (`GRADING_PRESETS`); a drag under a lock writes what `lib/develop/harmony.ts` says. The per-wheel
 * luminance and the smaller Global wheel are the `effects.wheels` ▸.
 */
export function EffectsSection({ assetId, settings }: EffectsSectionProps) {
  const [open, setOpen] = useState(false);
  const { grading, grain, vignette, halation } = settings.effects;
  const defaults = DEVELOP_DEFAULTS.effects;
  const set = (patch: DeepPartial<DevelopEffects>) =>
    useBookStore.getState().setAssetDevelop(assetId, { effects: patch });
  const resetGroup = (group: EffectsGroup) => set({ [group]: structuredClone(defaults[group]) });
  const isDefault = isSectionDefault(settings, 'effects');

  const harmony = harmonyOf(grading);
  const preset = matchGradingPreset(grading);
  const setHarmony = (choice: HarmonyChoice) =>
    useBookStore.getState().setAssetDevelop(assetId, (prev) => {
      const { harmony: _old, ...rest } = prev.effects.grading;
      const aligned = alignToHarmony(prev.effects.grading, choice);
      const next = { ...rest } as typeof prev.effects.grading;
      for (const [k, patch] of Object.entries(aligned)) {
        const key = k as AnyWheelKey;
        next[key] = { ...next[key], ...patch };
      }
      if (choice !== 'free') next.harmony = choice;
      return { ...prev, effects: { ...prev.effects, grading: next } };
    });

  const wheel = (key: AnyWheelKey, label: string, size?: number) => (
    <GradingWheel
      key={key}
      label={label}
      size={size}
      value={grading[key]}
      spokes={spokes(grading, harmony, key)}
      snapTargets={snapTargets(grading, harmony, key)}
      onChange={(next) => set({ grading: dragWheel(harmony, key, next) })}
    />
  );
  const luminance = (key: AnyWheelKey, label: string) => (
    <Slider
      key={key}
      label={`${label} luminance`}
      value={grading[key].luminance}
      min={-100}
      max={100}
      onChange={(value) => set({ grading: { [key]: { luminance: value } as Partial<GradingWheelValue> } })}
    />
  );

  return (
    <PanelCard
      title="Effects"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onReset={() => useBookStore.getState().resetDevelopSection(assetId, 'effects')}
      resetDisabled={isDefault}
      bodyClassName="space-y-5 px-3"
    >
      <Group
        title={GROUP_LABELS.grading}
        onReset={() => resetGroup('grading')}
        resetDisabled={deepEqual(grading, defaults.grading)}
      >
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
        <div className="flex justify-between gap-2">{WHEELS.map(({ key, label }) => wheel(key, label))}</div>
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label="Grading presets">
          {GRADING_PRESETS.map((p) => (
            <Button
              key={p.id}
              variant="toggle"
              size="sm"
              shape="pill"
              pressed={preset === p.id}
              title={p.hint}
              onClick={() => {
                if (preset !== p.id) set({ grading: withGradingPreset(grading, p.id) });
              }}
            >
              {p.label}
            </Button>
          ))}
        </fieldset>
        <CardMore id="effects.wheels" settings={settings}>
          {WHEELS.map(({ key, label }) => luminance(key, label))}
          <div className="flex items-start gap-3">
            {wheel('global', 'Global', 64)}
            <div className="min-w-0 flex-1 pt-5">{luminance('global', 'Global')}</div>
          </div>
        </CardMore>
        <CardMore id="effects.grading" settings={settings}>
          <Slider
            label="Blending"
            value={grading.blending}
            min={0}
            max={100}
            defaultValue={defaults.grading.blending}
            format={plain}
            onChange={(blending) => set({ grading: { blending } })}
          />
          <Slider
            label="Balance"
            value={grading.balance}
            min={-100}
            max={100}
            onChange={(balance) => set({ grading: { balance } })}
          />
        </CardMore>
      </Group>

      <Group
        title={GROUP_LABELS.vignette}
        onReset={() => resetGroup('vignette')}
        resetDisabled={deepEqual(vignette, defaults.vignette)}
      >
        <Slider
          label="Vignette amount"
          value={vignette.amount}
          min={-100}
          max={100}
          onChange={(amount) => set({ vignette: { amount } })}
        />
        <CardMore id="effects.vignette" settings={settings}>
          <Slider
            label="Midpoint"
            value={vignette.midpoint}
            min={0}
            max={100}
            defaultValue={defaults.vignette.midpoint}
            format={plain}
            onChange={(midpoint) => set({ vignette: { midpoint } })}
          />
          <Slider
            label="Feather"
            value={vignette.feather}
            min={0}
            max={100}
            defaultValue={defaults.vignette.feather}
            format={plain}
            onChange={(feather) => set({ vignette: { feather } })}
          />
          <Slider
            label="Roundness"
            value={vignette.roundness}
            min={-100}
            max={100}
            onChange={(roundness) => set({ vignette: { roundness } })}
          />
        </CardMore>
      </Group>

      <Group
        title={GROUP_LABELS.halation}
        onReset={() => resetGroup('halation')}
        resetDisabled={deepEqual(halation, defaults.halation)}
      >
        <Slider
          label="Halation amount"
          value={halation.amount}
          min={0}
          max={100}
          format={plain}
          onChange={(amount) => set({ halation: { amount } })}
        />
        <CardMore id="effects.halation" settings={settings}>
          <Slider
            label="Threshold"
            value={halation.threshold}
            min={0}
            max={100}
            defaultValue={defaults.halation.threshold}
            format={plain}
            onChange={(threshold) => set({ halation: { threshold } })}
          />
          <Slider
            label="Radius"
            value={halation.radius}
            min={0}
            max={100}
            defaultValue={defaults.halation.radius}
            format={plain}
            onChange={(radius) => set({ halation: { radius } })}
          />
        </CardMore>
      </Group>

      <Group
        title={GROUP_LABELS.grain}
        onReset={() => resetGroup('grain')}
        resetDisabled={deepEqual(grain, defaults.grain)}
      >
        <Slider
          label="Grain amount"
          value={grain.amount}
          min={0}
          max={100}
          format={plain}
          onChange={(amount) => set({ grain: { amount } })}
        />
        <CardMore id="effects.grain" settings={settings}>
          <Slider
            label="Size"
            value={grain.size}
            min={0}
            max={100}
            defaultValue={defaults.grain.size}
            format={plain}
            onChange={(size) => set({ grain: { size } })}
          />
          <Slider
            label="Roughness"
            value={grain.roughness}
            min={0}
            max={100}
            defaultValue={defaults.grain.roughness}
            format={plain}
            onChange={(roughness) => set({ grain: { roughness } })}
          />
        </CardMore>
      </Group>
    </PanelCard>
  );
}

function Group({
  title,
  onReset,
  resetDisabled,
  children,
}: {
  title: string;
  onReset: () => void;
  resetDisabled: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0" aria-label={title}>
      <legend className="flex w-full items-center">
        <span className="section-title mr-auto">{title}</span>
        <button
          type="button"
          onClick={onReset}
          disabled={resetDisabled}
          aria-label={`Reset ${title}`}
          title={`Reset ${title}`}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-0"
        >
          Reset
        </button>
      </legend>
      {children}
    </fieldset>
  );
}
