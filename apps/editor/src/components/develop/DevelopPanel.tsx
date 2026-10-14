import { type DevelopSettings, HUE_BANDS, type HueBand } from '@photobook/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DeepPartial } from '../../lib/develop/merge';
import { type DevelopSectionKey, isSectionDefault } from '../../lib/develop/sections';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { Segmented } from '../ui/Segmented';
import { Tag } from '../ui/Tag';
import { CardMore, CardViewProvider, type DevelopCardView } from './CardMore';
import { CurveEditor } from './CurveEditor';
import { DetailSection, SharpenSection } from './DetailSection';
import { EffectsSection } from './EffectsSection';
import { MasksSection } from './MasksSection';
import { MoreIcon, PanelCard } from './PanelCard';
import { RenderDot, useRenderSlow } from './renderProgress';
import { Slider } from './Slider';
import { SplitHandles } from './SplitHandles';
import { TransformSection } from './TransformSection';
import { WhiteBalanceControls } from './WhiteBalanceControls';

type SectionId = 'light' | 'color';
type MixProp = 'hue' | 'saturation' | 'luminance';

const BAND_HUE: Record<HueBand, number> = {
  red: 0,
  orange: 30,
  yellow: 55,
  green: 120,
  aqua: 180,
  blue: 230,
  purple: 275,
  magenta: 320,
};
const bandColor = (band: HueBand) => `hsl(${BAND_HUE[band]} 80% 55%)`;
const MIX_TABS: Array<{ id: MixProp; label: string }> = [
  { id: 'hue', label: 'Hue' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'luminance', label: 'Luminance' },
];

export function mixTrack(band: HueBand, prop: MixProp): string {
  const h = BAND_HUE[band];
  if (prop === 'hue')
    return `linear-gradient(to right, hsl(${h - 35} 80% 55%), hsl(${h} 80% 55%), hsl(${h + 35} 80% 55%))`;
  if (prop === 'saturation') return `linear-gradient(to right, hsl(${h} 0% 55%), hsl(${h} 90% 55%))`;
  return `linear-gradient(to right, hsl(${h} 70% 18%), hsl(${h} 70% 82%))`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface DevelopPanelProps {
  assetId: string;
  settings: DevelopSettings;
  /** The asset has develop settings (anything but the defaults). */
  edited: boolean;
  canPaste: boolean;
  /** Copy the remembered sections (Cmd+Shift+C). */
  onCopy: () => void;
  /** Open Copy Settings to choose the sections (Shift+Cmd+Alt+C). */
  onCopyDialog: () => void;
  /** Paste onto this photo. */
  onPaste: () => void;
  /** Open the crop tool (`R`); the Crop card's button. */
  onCrop?: () => void;
  /** Show Basic (false) or Advanced (true) whatever the switch says: the kitchen sink draws both side by side. */
  advanced?: boolean;
}

/**
 * Right panel of the Develop view (320 px): a header (Develop, the Edited tag, the render dot while a preview is late,
 * the Basic ⇄ Advanced switch and a ⋯ menu with Sync…, Copy, Copy…, Paste and Reset all; plans 46 and 54), then the
 * seven cards in the order of operations (plan 54, ODDHALLS_LAYOUT_PLAN 4.1): Crop, Light, Color, Detail, Sharpen &
 * denoise, Effects, Masks (`PanelCard`, each with its reset in the title row). Looks and Presets are in the left pane
 * (`DevelopLeftPane`, plan 51).
 *
 * Basic ⇄ Advanced is one switch for every card, per machine (`ui.developAdvanced`). Basic shows each card's basic
 * rows and its advanced parts as ▸ buttons that open in place (`CardMore`, tagged `·edited` while a control behind
 * them is off its default); Advanced shows them all inline. The cards, their rows and their ▸ parts are listed in
 * `developCards.ts`. Every control writes through `setAssetDevelop`; sliders and the curve editor group a drag into
 * one undo step themselves.
 */
export function DevelopPanel({
  assetId,
  settings,
  edited,
  canPaste,
  onCopy,
  onCopyDialog,
  onPaste,
  onCrop,
  advanced: shownAdvanced,
}: DevelopPanelProps) {
  const [open, setOpen] = useState<Record<SectionId, boolean>>({ light: true, color: true });
  const switched = useUiStore((s) => s.developAdvanced);
  const advanced = shownAdvanced ?? switched;
  // The ▸ parts opened in Basic; kept while stepping through photos.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMore = useCallback(
    (id: string) =>
      setExpanded((now) => {
        const next = new Set(now);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const cardView = useMemo<DevelopCardView>(
    () => ({ advanced, expanded, toggle: toggleMore }),
    [advanced, expanded, toggleMore],
  );
  const [mixTab, setMixTab] = useState<MixProp>('hue');
  const panelRef = useRef<HTMLDivElement>(null);
  const rendering = useRenderSlow();
  const set = (patch: DeepPartial<DevelopSettings>) => useBookStore.getState().setAssetDevelop(assetId, patch);
  const resetSections = (...keys: DevelopSectionKey[]) => useBookStore.getState().resetDevelopSection(assetId, keys);
  const toggle = (id: SectionId) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const { light, curve, color } = settings;
  const parametric = curve.parametric;
  const lightDefault = isSectionDefault(settings, 'light') && isSectionDefault(settings, 'curve');
  const colorDefault = isSectionDefault(settings, 'whiteBalance') && isSectionDefault(settings, 'color');

  const lightSlider = (key: keyof DevelopSettings['light'], label: string) => (
    <Slider
      key={key}
      label={label}
      value={light[key]}
      min={key === 'exposure' ? -5 : -100}
      max={key === 'exposure' ? 5 : 100}
      step={key === 'exposure' ? 0.01 : 1}
      onChange={(v) => set({ light: { [key]: v } })}
    />
  );

  const focusBand = (band: HueBand) => panelRef.current?.querySelector<HTMLElement>(`[data-band="${band}"]`)?.focus();
  const bandEdited = (band: HueBand) => {
    const m = color.mix[band];
    return m.hue !== 0 || m.saturation !== 0 || m.luminance !== 0;
  };

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
      data-testid="develop-panel"
    >
      {/* Plan 46: one row that never wraps: the title, Edited, the render dot and the ⋯ menu (Presets: the left pane, plan 51). */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-hairline border-b pr-1.5 pl-3">
        <h2 className="section-title flex min-w-0 items-center gap-2 text-fg">
          Develop
          {edited && <Tag tone="accent">Edited</Tag>}
        </h2>
        {rendering && <RenderDot label="Rendering the preview" />}
        <div className="ml-auto flex items-center gap-1">
          <Segmented
            label="Basic or Advanced"
            items={[
              { value: 'basic', label: 'Basic', title: 'The common rows; ▸ opens the rest in place' },
              { value: 'advanced', label: 'Advanced', title: 'Every control of every card' },
            ]}
            value={advanced ? 'advanced' : 'basic'}
            onChange={(v) => useUiStore.getState().setPref('developAdvanced', v === 'advanced')}
          />
          <Menu
            label={<MoreIcon />}
            ariaLabel="More actions"
            title="Sync, copy, paste and reset these settings"
            menuLabel="Develop"
            alignEnd
            width={240}
          >
            <MenuItem
              onSelect={() => useUiStore.getState().openSyncDialog(assetId)}
              title="Copy sections of these settings to other photos, or apply a preset to several"
            >
              Sync…
            </MenuItem>
            <MenuSeparator />
            <MenuItem shortcut="⇧⌘C" onSelect={onCopy} title="Copy these settings, the sections chosen last time">
              Copy
            </MenuItem>
            <MenuItem shortcut="⌥⇧⌘C" onSelect={onCopyDialog} title="Choose which sections to copy">
              Copy…
            </MenuItem>
            <MenuItem
              onSelect={onPaste}
              disabled={!canPaste}
              title="Paste the copied settings onto this photo (Cmd+Shift+V pastes onto the selection)"
            >
              Paste
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              onSelect={() => useBookStore.getState().resetAssetDevelop(assetId)}
              disabled={!edited}
              title="Reset every adjustment on this photo"
            >
              Reset all
            </MenuItem>
          </Menu>
        </div>
      </div>

      <CardViewProvider value={cardView}>
        <div className="flex flex-col gap-2 p-2">
          <TransformSection assetId={assetId} settings={settings} onCrop={onCrop} />

          <PanelCard
            title="Light"
            open={open.light}
            onToggle={() => toggle('light')}
            onReset={() => resetSections('light', 'curve')}
            resetDisabled={lightDefault}
          >
            {lightSlider('exposure', 'Exposure')}
            {lightSlider('contrast', 'Contrast')}
            {lightSlider('highlights', 'Highlights')}
            {lightSlider('shadows', 'Shadows')}
            {lightSlider('whites', 'Whites')}
            {lightSlider('blacks', 'Blacks')}
            <CardMore id="light.curve" settings={settings}>
              <CurveEditor curve={curve} onChange={(channel, points) => set({ curve: { [channel]: points } })} />
              <p className="section-title pt-1">Parametric</p>
              {(['highlights', 'lights', 'darks', 'shadows'] as const).map((key) => (
                <Slider
                  key={key}
                  label={cap(key)}
                  value={parametric[key]}
                  min={-100}
                  max={100}
                  onChange={(v) => set({ curve: { parametric: { [key]: v } } })}
                />
              ))}
              <SplitHandles
                splits={parametric.splits}
                onChange={(splits) => set({ curve: { parametric: { splits } } })}
              />
            </CardMore>
          </PanelCard>

          <PanelCard
            title="Color"
            open={open.color}
            onToggle={() => toggle('color')}
            onReset={() => resetSections('whiteBalance', 'color')}
            resetDisabled={colorDefault}
          >
            <WhiteBalanceControls
              assetId={assetId}
              whiteBalance={settings.whiteBalance}
              onChange={(whiteBalance) => set({ whiteBalance })}
            />
            <Slider
              label="Vibrance"
              value={color.vibrance}
              min={-100}
              max={100}
              onChange={(v) => set({ color: { vibrance: v } })}
            />
            <Slider
              label="Saturation"
              value={color.saturation}
              min={-100}
              max={100}
              onChange={(v) => set({ color: { saturation: v } })}
            />
            <CardMore id="color.mix" settings={settings}>
              <div className="flex justify-between px-0.5" role="toolbar" aria-label="Color bands">
                {HUE_BANDS.map((band) => (
                  <button
                    key={band}
                    type="button"
                    aria-label={`${cap(band)}${bandEdited(band) ? ' (edited)' : ''}`}
                    title={cap(band)}
                    onClick={() => focusBand(band)}
                    className="relative size-5 rounded-full border border-stage/40 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    style={{ background: bandColor(band) }}
                  >
                    {bandEdited(band) && (
                      <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-stage/60 bg-fg" />
                    )}
                  </button>
                ))}
              </div>
              <div
                role="tablist"
                aria-label="Color mix property"
                className="grid grid-cols-3 rounded-md border border-line p-0.5"
              >
                {MIX_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={mixTab === tab.id}
                    onClick={() => setMixTab(tab.id)}
                    className={`rounded px-1 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      mixTab === tab.id ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {HUE_BANDS.map((band) => (
                <Slider
                  key={band}
                  label={cap(band)}
                  swatch={bandColor(band)}
                  value={color.mix[band][mixTab]}
                  min={-100}
                  max={100}
                  track={mixTrack(band, mixTab)}
                  trackProps={{ 'data-band': band }}
                  onChange={(v) => set({ color: { mix: { [band]: { [mixTab]: v } } } })}
                />
              ))}
            </CardMore>
          </PanelCard>

          <DetailSection assetId={assetId} settings={settings} />

          <SharpenSection assetId={assetId} settings={settings} />

          <EffectsSection assetId={assetId} settings={settings} />

          <MasksSection assetId={assetId} masks={settings.masks} />
        </div>
      </CardViewProvider>
    </div>
  );
}
