import {
  type AiMaskTarget,
  type DevelopMask,
  type DevelopMaskComponent,
  type LocalAdjustments,
  newId,
} from '@photobook/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AI_TARGET_LABEL,
  AI_TARGETS_ORDER,
  type ComponentMode,
  componentLabel,
  DEPTH_RANGE_DEFAULT,
  isAdjustmentsDefault,
  isPromptable,
  MASK_TOOL_LABEL,
  MASK_TOOLS,
  type MaskTool,
  type MaskToolName,
  maskDisplayName,
  maskSwatch,
  newColor,
  newLuminance,
  newMask,
  nextMaskName,
  TOOL_LABEL,
} from '../../lib/develop/masks';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from '../../store/book';
import { BRUSH_SIZE_MIN, useUiStore } from '../../store/ui';
import { useIdleGesture } from '../editor/gestures';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Tag';
import { Tooltip } from '../ui/Tooltip';
import { AiMaskStatusRows, AiModelDownloadDialog } from './AiMaskMenu';
import { CardMore, useCardView } from './CardMore';
import { componentAdvancedEdited } from './developCards';
import { MaskContextMenu, type MaskMenuTarget, useMaskContextMenu } from './MaskMenu';
import { PanelCard } from './PanelCard';
import { Slider } from './Slider';
import {
  type AiComponentStatus,
  cancelAiJob,
  createAiMask,
  regenerateAiComponent,
  useAiComponentStatus,
  useAiMaskStore,
} from './useAiMask';

const TEMPERATURE_TRACK = 'linear-gradient(to right, #4a90e2, #cfcfcf, #f2c14e)';
const TINT_TRACK = 'linear-gradient(to right, #4cc36b, #cfcfcf, #d65db1)';
const HUE_TRACK =
  'linear-gradient(to right, hsl(180 70% 50%), hsl(270 70% 55%), hsl(0 70% 55%), hsl(90 70% 50%), hsl(180 70% 50%))';

interface LocalSlider {
  key: keyof LocalAdjustments;
  label: string;
  min: number;
  max: number;
  step?: number;
  track?: string;
  /** Shown disabled with this reason. */
  disabled?: string;
}

/** The local sliders, in Lightroom's order. */
export const LOCAL_SLIDERS: readonly LocalSlider[] = [
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, track: TEMPERATURE_TRACK },
  { key: 'tint', label: 'Tint', min: -100, max: 100, track: TINT_TRACK },
  { key: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'whites', label: 'Whites', min: -100, max: 100 },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  { key: 'texture', label: 'Texture', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
  { key: 'hue', label: 'Hue', min: -100, max: 100, track: HUE_TRACK },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'sharpness', label: 'Sharpness', min: -100, max: 100 },
  // Workflow plan 24: a local guided filter (colour, and a weaker luminance pass), no model involved.
  { key: 'noise', label: 'Noise', min: 0, max: 100 },
];

const MODES: ReadonlyArray<{ mode: ComponentMode; label: string }> = [
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
];

const DEPTH_TRACK = 'linear-gradient(to right, #f2c14e, #4a90e2)';

const KIND_BADGE: Record<DevelopMaskComponent['kind'], string> = {
  brush: 'B',
  linear: 'L',
  radial: 'R',
  luminance: 'Y',
  color: 'C',
  ai: 'AI',
};

export interface MasksSectionProps {
  assetId: string;
  masks: readonly DevelopMask[];
}

/**
 * The Masks section of the Develop panel (step D4.1). Opening it (or `M`) turns the mask tools on: the list of masks
 * (name, overlay swatch, effect on / off), Create new mask (Brush, Linear and Radial gradient, Luminance and Color
 * range, and the AI masks Subject / Sky / Background / People / Depth range of step D4.3), and for the selected mask
 * its components (Add / Subtract / Intersect start a tool for a new one or generate an AI one; each has its mode,
 * invert and delete), Invert / Feather / Opacity, the local sliders, Reset, Duplicate and Delete. The brush settings
 * (size, feather, flow, erase) show while the brush is active.
 *
 * AI components (`useAiMask`): a pick generates the raster first (busy row with the model's stage and Cancel; the
 * first-use download prompt when a model is missing), People offers one component per person, Subject / Background /
 * People have Refine (click and box prompts over the picture), Depth range has its near / far slider (no model run),
 * and a component whose raster is missing on this computer or whose model has a newer version offers Regenerate.
 *
 * Every control writes through the mask actions of the book store; sliders group a drag into one undo step.
 */
export function MasksSection({ assetId, masks }: MasksSectionProps) {
  const open = useUiStore((s) => s.developMasks);
  const tool = useUiStore((s) => s.developMaskTool);
  const overlay = useUiStore((s) => s.maskOverlay);
  const sectionRef = useRef<HTMLElement>(null);
  const store = () => useBookStore.getState();
  const ui = () => useUiStore.getState();
  // Plan 54: a range mask is made to be adjusted, so making one opens its ▸ in Basic.
  const cardView = useCardView();
  const showRange = () => {
    if (!cardView.advanced && !cardView.expanded.has('masks.component')) cardView.toggle('masks.component');
  };

  const selectedIndex = tool ? masks.findIndex((m) => m.id === tool.maskId) : -1;
  const selected = masks[selectedIndex];
  const pendingNew = tool?.create === 'new' && !selected;

  // `M` opening the section brings it into view.
  useEffect(() => {
    if (open) sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  // Stepping to another photo abandons an AI job of the one left (its result would land out of sight).
  useEffect(() => {
    const job = useAiMaskStore.getState().job;
    if (job && job.assetId !== assetId) cancelAiJob();
  }, [assetId]);

  /** Start a new mask: brush and gradients draw it on the photo; the range masks are created at once. */
  const create = (kind: MaskTool) => {
    if (kind === 'luminance' || kind === 'color') {
      const c = kind === 'luminance' ? newLuminance() : newColor();
      const m = newMask(nextMaskName(masks), c);
      store().addMask(assetId, m);
      ui().setDevelopMaskTool({ maskId: m.id, componentId: c.id, tool: kind });
      showRange();
    } else ui().setDevelopMaskTool({ maskId: newId(), tool: kind, create: 'new' });
  };

  /** Add / Subtract / Intersect a new component to the selected mask. */
  const addComponent = (mode: ComponentMode, kind: MaskTool) => {
    if (!selected) return;
    if (kind === 'luminance' || kind === 'color') {
      const c = kind === 'luminance' ? newLuminance(undefined, mode) : newColor([], mode);
      store().addMaskComponent(assetId, selected.id, c);
      ui().setDevelopMaskTool({ maskId: selected.id, componentId: c.id, tool: kind });
      showRange();
    } else ui().setDevelopMaskTool({ maskId: selected.id, tool: kind, create: mode });
  };

  const selectMask = (m: DevelopMask) => {
    if (tool?.maskId === m.id && !tool.create) return;
    ui().setDevelopMaskTool({ maskId: m.id, tool: null });
  };

  const selectComponent = (m: DevelopMask, c: DevelopMaskComponent) =>
    ui().setDevelopMaskTool({ maskId: m.id, componentId: c.id, tool: c.kind === 'ai' ? null : c.kind });

  // Plan 56: the right-click menu of a mask row or a component row.
  const contextMenu = useMaskContextMenu();

  return (
    <PanelCard
      ref={sectionRef}
      title="Masks"
      open={open}
      onToggle={() => ui().setDevelopMasks(!open)}
      toggleTitle="Masks (M)"
      meta={
        <>
          {masks.length > 0 && <span className="text-[11px] text-fg-muted tabular-nums">{masks.length}</span>}
          <span className="ml-auto pr-2 font-mono text-[11px] text-fg-muted">M</span>
        </>
      }
      bodyClassName="space-y-3 px-3"
      data={{ 'data-masks-section': '' }}
    >
      <div className="flex items-center justify-between gap-2">
        <Menu
          label="Create new mask"
          items={[
            ...MASK_TOOLS.map((t) => ({ key: t, label: MASK_TOOL_LABEL[t], onSelect: () => create(t) })),
            ...AI_TARGETS_ORDER.map((t) => ({
              key: `ai-${t}`,
              label: AI_TARGET_LABEL[t],
              onSelect: () => void createAiMask(assetId, t),
            })),
          ]}
          separatorBefore={`ai-${AI_TARGETS_ORDER[0]}`}
          primary
        />
        <label className="flex items-center gap-1.5 text-[11px] text-fg-muted" title="Tint the selected mask (O)">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => ui().setPref('maskOverlay', e.target.checked)}
            className="accent-accent"
          />
          Show overlay <span className="text-fg-muted/70">O</span>
        </label>
      </div>

      <AiMaskStatusRows assetId={assetId} />
      <AiModelDownloadDialog />

      {masks.length === 0 && !pendingNew && (
        <p className="text-[11px] text-fg-muted">No masks yet. Create one to adjust part of the photo.</p>
      )}
      {(masks.length > 0 || pendingNew) && (
        <ul className="space-y-0.5" aria-label="Mask list">
          {masks.map((m, i) => (
            <MaskRow
              key={m.id}
              mask={m}
              index={i}
              selected={m.id === selected?.id}
              onSelect={() => selectMask(m)}
              onToggle={(enabled) => store().setMaskEnabled(assetId, m.id, enabled)}
              onInvert={() => store().setMaskInvert(assetId, m.id, !m.invert)}
              onRename={(name) => store().renameMask(assetId, m.id, name)}
              onContextMenu={contextMenu.onContextMenu}
            />
          ))}
          {pendingNew && tool?.tool && (
            <li className="rounded-sm border border-accent/60 border-dashed px-2 py-1 text-[11px] text-fg-muted">
              New mask: {tool.tool === 'brush' ? 'paint' : 'drag'} on the photo
            </li>
          )}
        </ul>
      )}

      {tool?.tool === 'brush' && <BrushControls />}

      {selected && (
        <MaskDetail
          assetId={assetId}
          mask={selected}
          index={selectedIndex}
          selectedComponent={tool?.componentId}
          pendingMode={tool?.create && tool.create !== 'new' ? tool.create : undefined}
          pendingTool={tool?.create ? tool.tool : null}
          onAdd={addComponent}
          onAddAi={(mode, target) => void createAiMask(assetId, target, { maskId: selected.id, mode })}
          onSelectComponent={(c) => selectComponent(selected, c)}
          onContextMenu={contextMenu.onContextMenu}
        />
      )}
      {contextMenu.menu && (
        <MaskContextMenu
          assetId={assetId}
          masks={masks}
          menu={contextMenu.menu}
          onClose={contextMenu.close}
          onRange={showRange}
        />
      )}
    </PanelCard>
  );
}

function MaskRow({
  mask,
  index,
  selected,
  onSelect,
  onToggle,
  onInvert,
  onRename,
  onContextMenu,
}: {
  mask: DevelopMask;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  /** Plan 56: the row's Invert toggle (`mask.invert`, the same as the detail's Invert mask). */
  onInvert: () => void;
  onRename: (name: string) => void;
  onContextMenu: RowContextMenu;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = maskDisplayName(mask, index);
  // Plan 54: in Basic a component's range or Refine is behind a ▸ shown only for the selected one; the row says so.
  const advancedEdited = !useCardView().advanced && mask.components.some(componentAdvancedEdited);
  return (
    <li
      className={`flex items-center gap-2 rounded-sm px-1.5 py-1 ${selected ? 'bg-accent/15 ring-1 ring-accent/60' : 'hover:bg-line/60'}`}
      data-mask-row={mask.id}
      onContextMenu={(e) => onContextMenu(e, { maskId: mask.id })}
    >
      <span
        className="size-2.5 shrink-0 rounded-full border border-stage/40"
        style={{ background: maskSwatch(index) }}
        aria-hidden="true"
      />
      {editing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field replaces the name the user just double-clicked
          autoFocus
          type="text"
          aria-label="Mask name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft.trim() !== mask.name) onRename(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(mask.name);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded-sm border border-accent bg-panel-2 px-1 text-fg text-xs outline-none"
        />
      ) : (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          onDoubleClick={() => {
            setDraft(name);
            setEditing(true);
          }}
          title="Click to select, double-click to rename"
          className={`min-w-0 flex-1 truncate text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            mask.enabled ? 'text-fg' : 'text-fg-muted line-through'
          }`}
        >
          {name}
        </button>
      )}
      {advancedEdited && (
        <Tag tone="accent" title="A component's range or Refine is off its default (Range & refine ▸)">
          ·edited
        </Tag>
      )}
      <Button
        variant="toggle"
        size="sm"
        pressed={mask.invert}
        onClick={onInvert}
        aria-label={`Invert ${name}`}
        title="Invert this mask (the effect goes where the mask is not)"
        className="h-5 px-1 text-[11px]"
      >
        Inv
      </Button>
      <input
        type="checkbox"
        checked={mask.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`Apply ${name}`}
        title="Apply this mask's adjustments"
        className="accent-accent"
      />
    </li>
  );
}

/** Brush size, feather, flow and erase (UI prefs, not part of the photo; `[` `]` and Shift+`[` `]` change them). */
function BrushControls() {
  const brush = useUiStore((s) => s.maskBrush);
  const set = (patch: Parameters<ReturnType<typeof useUiStore.getState>['setMaskBrush']>[0]) =>
    useUiStore.getState().setMaskBrush(patch);
  return (
    <fieldset className="m-0 min-w-0 space-y-3 rounded-md border border-line p-2" aria-label="Brush">
      <div className="flex items-center justify-between">
        <p className="section-title">Brush</p>
        <label className="flex items-center gap-1.5 text-[11px] text-fg-muted" title="Alt inverts it while painting">
          <input
            type="checkbox"
            checked={brush.erase}
            onChange={(e) => set({ erase: e.target.checked })}
            className="accent-accent"
          />
          Erase
        </label>
      </div>
      <Slider
        label="Size"
        value={brush.size}
        min={BRUSH_SIZE_MIN}
        max={100}
        step={0.5}
        defaultValue={10}
        onChange={(size) => set({ size })}
      />
      <Slider
        label="Feather"
        value={brush.feather}
        min={0}
        max={100}
        defaultValue={50}
        onChange={(feather) => set({ feather })}
      />
      <Slider label="Flow" value={brush.flow} min={0} max={100} defaultValue={100} onChange={(flow) => set({ flow })} />
    </fieldset>
  );
}

interface MaskDetailProps {
  assetId: string;
  mask: DevelopMask;
  index: number;
  selectedComponent: string | undefined;
  /** A component is about to be drawn with this mode. */
  pendingMode: ComponentMode | undefined;
  pendingTool: MaskToolName | null | undefined;
  onAdd: (mode: ComponentMode, kind: MaskTool) => void;
  onAddAi: (mode: ComponentMode, target: AiMaskTarget) => void;
  onSelectComponent: (c: DevelopMaskComponent) => void;
  onContextMenu: RowContextMenu;
}

/** Opens the mask context menu from a row. */
type RowContextMenu = (e: ReactMouseEvent<Element>, target: MaskMenuTarget) => void;

function MaskDetail({
  assetId,
  mask,
  index,
  selectedComponent,
  pendingMode,
  pendingTool,
  onAdd,
  onAddAi,
  onSelectComponent,
  onContextMenu,
}: MaskDetailProps) {
  const store = () => useBookStore.getState();
  const name = maskDisplayName(mask, index);
  const component = mask.components.find((c) => c.id === selectedComponent);
  const a = mask.adjustments;
  const status = useAiComponentStatus(assetId, mask);
  const busy = useAiMaskStore((s) => (s.job?.assetId === assetId ? s.job : null));

  return (
    <fieldset className="m-0 min-w-0 space-y-3 border-0 p-0" aria-label={`Mask ${name}`}>
      <div className="flex gap-1" role="toolbar" aria-label="Add a component">
        {MODES.map(({ mode, label }) => (
          <Menu
            key={mode}
            label={label}
            items={[
              ...MASK_TOOLS.map((t) => ({ key: t, label: MASK_TOOL_LABEL[t], onSelect: () => onAdd(mode, t) })),
              ...AI_TARGETS_ORDER.map((t) => ({
                key: `ai-${t}`,
                label: AI_TARGET_LABEL[t],
                onSelect: () => onAddAi(mode, t),
              })),
            ]}
            separatorBefore={`ai-${AI_TARGETS_ORDER[0]}`}
            title={`${label}: draw or generate a new component into this mask`}
          />
        ))}
      </div>

      <ul className="space-y-0.5" aria-label="Components">
        {mask.components.map((c, i) => (
          <ComponentRow
            key={c.id}
            component={c}
            label={componentLabel(c, mask)}
            status={status[c.id]}
            busy={busy !== null && busy.componentId === c.id}
            onRegenerate={() => void regenerateAiComponent(assetId, mask.id, c.id)}
            first={i === 0}
            selected={c.id === selectedComponent}
            onSelect={() => onSelectComponent(c)}
            onMode={(mode) => store().setComponentMode(assetId, mask.id, c.id, mode)}
            onInvert={() => store().setComponentInvert(assetId, mask.id, c.id, !c.invert)}
            onDelete={() => store().removeMaskComponent(assetId, mask.id, c.id)}
            onContextMenu={(e) => onContextMenu(e, { maskId: mask.id, componentId: c.id })}
          />
        ))}
        {pendingMode && pendingTool && (
          <li className="rounded-sm border border-accent/60 border-dashed px-2 py-1 text-[11px] text-fg-muted">
            {MODES.find((m) => m.mode === pendingMode)?.label} {TOOL_LABEL[pendingTool].toLowerCase()}:{' '}
            {pendingTool === 'brush' ? 'paint' : 'drag'} on the photo
          </li>
        )}
      </ul>

      {component &&
        (component.kind === 'radial' ? (
          <ComponentControls assetId={assetId} maskId={mask.id} component={component} />
        ) : component.kind === 'luminance' || component.kind === 'color' || component.kind === 'ai' ? (
          // Plan 54: a range, a colour's Refine, an AI mask's prompts or depth are behind the ▸ in Basic.
          <CardMore id="masks.component" edited={componentAdvancedEdited(component)}>
            <ComponentControls assetId={assetId} maskId={mask.id} component={component} />
          </CardMore>
        ) : null)}

      <div className="space-y-3 border-line border-t pt-3">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={mask.invert}
            onChange={(e) => store().setMaskInvert(assetId, mask.id, e.target.checked)}
            className="accent-accent"
          />
          Invert mask
        </label>
        <Slider
          label="Mask feather"
          value={mask.feather}
          min={0}
          max={100}
          onChange={(v) => store().setMaskFeather(assetId, mask.id, v)}
        />
        <Slider
          label="Amount"
          value={mask.opacity}
          min={0}
          max={100}
          defaultValue={100}
          format={(v) => `${Math.round(v)}%`}
          onChange={(v) => store().setMaskOpacity(assetId, mask.id, v)}
        />
      </div>

      <div className="space-y-3 border-line border-t pt-3">
        <div className="flex items-center justify-between">
          <p className="section-title">Adjustments</p>
          <button
            type="button"
            onClick={() => store().resetMaskAdjustments(assetId, mask.id)}
            disabled={isAdjustmentsDefault(a)}
            className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            Reset
          </button>
        </div>
        {LOCAL_SLIDERS.map((s) => (
          <div key={s.key} title={s.disabled}>
            <Slider
              label={s.label}
              value={a[s.key]}
              min={s.min}
              max={s.max}
              step={s.step}
              track={s.track}
              disabled={s.disabled !== undefined}
              onChange={(v) => store().setMaskAdjustments(assetId, mask.id, { [s.key]: v })}
            />
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-1 border-line border-t pt-3">
        <SmallButton onClick={() => store().duplicateMask(assetId, mask.id)}>Duplicate</SmallButton>
        <SmallButton onClick={() => store().removeMask(assetId, mask.id)}>Delete mask</SmallButton>
      </div>
    </fieldset>
  );
}

function ComponentRow({
  component: c,
  label,
  status,
  busy,
  onRegenerate,
  first,
  selected,
  onSelect,
  onMode,
  onInvert,
  onDelete,
  onContextMenu,
}: {
  component: DevelopMaskComponent;
  label: string;
  /** AI components: whether the raster is missing here or the model has moved on. */
  status: AiComponentStatus | undefined;
  /** An AI job is replacing this component. */
  busy: boolean;
  onRegenerate: () => void;
  first: boolean;
  selected: boolean;
  onSelect: () => void;
  onMode: (mode: ComponentMode) => void;
  onInvert: () => void;
  onDelete: () => void;
  onContextMenu: (e: ReactMouseEvent<Element>) => void;
}) {
  const stale = status !== undefined && (status.missing || status.outdated);
  return (
    <li data-component-row={c.id} onContextMenu={onContextMenu}>
      <div
        className={`flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs ${selected ? 'bg-accent/15' : 'hover:bg-line/60'}`}
      >
        <span
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm bg-line px-0.5 font-mono text-[9px] text-fg"
          aria-hidden="true"
        >
          {KIND_BADGE[c.kind]}
        </span>
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {label}
        </button>
        {first ? (
          <span className="text-[11px] text-fg-muted">Add</span>
        ) : (
          <select
            value={c.mode}
            aria-label={`${label} mode`}
            onChange={(e) => onMode(e.target.value as ComponentMode)}
            className="rounded-sm border border-line bg-panel px-0.5 text-[11px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {MODES.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-pressed={c.invert}
          aria-label={`Invert ${label}`}
          title="Invert this component"
          onClick={onInvert}
          className={`rounded-sm px-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            c.invert ? 'bg-accent/30 text-fg' : 'text-fg-muted hover:text-fg'
          }`}
        >
          Inv
        </button>
        <button
          type="button"
          aria-label={`Delete ${label}`}
          title="Delete this component (Delete)"
          onClick={onDelete}
          className="rounded-sm px-1 text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          ✕
        </button>
      </div>
      {stale && (
        <div className="flex items-center gap-2 py-0.5 pr-1.5 pl-7 text-[11px]">
          <span className="min-w-0 flex-1 text-fg-muted">
            {status.missing ? 'Mask not generated on this computer' : 'A newer model version is available'}
          </span>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            aria-label={`Regenerate ${label}`}
            className="rounded-sm border border-line px-1.5 py-0.5 text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            Regenerate
          </button>
        </div>
      )}
    </li>
  );
}

/** Settings of the selected component that are not drawn on the photo. */
function ComponentControls({
  assetId,
  maskId,
  component: c,
}: {
  assetId: string;
  maskId: string;
  component: DevelopMaskComponent;
}) {
  const update = (patch: Parameters<ReturnType<typeof useBookStore.getState>['updateComponent']>[3]) =>
    useBookStore.getState().updateComponent(assetId, maskId, c.id, patch);
  if (c.kind === 'radial') {
    return (
      <Slider
        label="Feather"
        value={c.feather}
        min={0}
        max={100}
        defaultValue={50}
        onChange={(feather) => update({ feather })}
      />
    );
  }
  if (c.kind === 'luminance') {
    return (
      <div className="space-y-3">
        <RangeSlider label="Luminance range" value={c.range} onChange={(range) => update({ range })} />
        <Slider label="Smoothness" value={c.feather} min={0} max={100} onChange={(feather) => update({ feather })} />
        <p className="text-[11px] text-fg-muted">Click the photo to pick a tone; Shift-click extends the range.</p>
      </div>
    );
  }
  if (c.kind === 'color') {
    return (
      <div className="space-y-3">
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0" aria-label="Colour samples">
          {c.samples.length === 0 && (
            <span className="text-[11px] text-fg-muted">Click the photo to pick a colour; Shift-click adds one.</span>
          )}
          {c.samples.map((hex, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: samples may repeat; their order is their identity
            <Tooltip key={`${hex}-${i}`} label={`${hex} (click to remove)`}>
              <button
                type="button"
                aria-label={`Remove sample ${hex}`}
                onClick={() => update({ samples: c.samples.filter((_, j) => j !== i) })}
                className="size-5 rounded-sm border border-stage/40 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{ background: hex }}
              />
            </Tooltip>
          ))}
        </fieldset>
        <Slider
          label="Refine"
          value={c.tolerance}
          min={0}
          max={100}
          defaultValue={50}
          onChange={(tolerance) => update({ tolerance })}
        />
      </div>
    );
  }
  if (c.kind === 'ai') return <AiControls assetId={assetId} maskId={maskId} component={c} />;
  return null;
}

/** Depth range (near … far, no model run) and Refine (click and box prompts) of an AI component. */
function AiControls({
  assetId,
  maskId,
  component: c,
}: {
  assetId: string;
  maskId: string;
  component: Extract<DevelopMaskComponent, { kind: 'ai' }>;
}) {
  const tool = useUiStore((s) => s.developMaskTool);
  const refining = tool?.tool === 'refine' && tool.componentId === c.id;
  // Prompts of a refine in flight count (they show over the picture already).
  const prompts = useAiMaskStore((s) =>
    s.job?.kind === 'refine' && s.job.componentId === c.id && s.job.prompts ? s.job.prompts : c.prompts,
  );
  if (c.target === 'depth') {
    return (
      <div className="space-y-1">
        <RangeSlider
          label="Depth range"
          value={c.depthRange ?? DEPTH_RANGE_DEFAULT}
          track={DEPTH_TRACK}
          onChange={(depthRange) => useBookStore.getState().updateComponent(assetId, maskId, c.id, { depthRange })}
        />
        <p className="flex justify-between text-[11px] text-fg-muted" aria-hidden="true">
          <span>Near ←</span>
          <span>→ Far</span>
        </p>
      </div>
    );
  }
  if (!isPromptable(c.target)) return null;
  const toggle = () =>
    useUiStore.getState().setDevelopMaskTool({ maskId, componentId: c.id, tool: refining ? null : 'refine' });
  const positive = prompts.filter((p) => p.positive).length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={refining}
          onClick={toggle}
          title="Click the photo to add to the mask, Alt-click to remove, drag a box around what you want"
          className={`rounded-md border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            refining ? 'border-accent bg-accent/20 text-fg' : 'border-line text-fg-muted hover:text-fg'
          }`}
        >
          Refine
        </button>
        {prompts.length > 0 && (
          <span className="text-[11px] text-fg-muted tabular-nums">
            {positive} added, {prompts.length - positive} removed
          </span>
        )}
      </div>
      {refining && (
        <p className="text-[11px] text-fg-muted">
          Click adds, Alt-click removes, drag draws a box; Delete takes the last one back.
        </p>
      )}
    </div>
  );
}

/** A 0..1 range with two thumbs (each a slider: arrows nudge, Shift by ten steps); a drag is one undo step. */
export function RangeSlider({
  label,
  value,
  onChange,
  step = 0.01,
  track = 'linear-gradient(to right, #000, #fff)',
}: {
  label: string;
  value: readonly [number, number];
  onChange: (value: [number, number]) => void;
  step?: number;
  /** Track background (CSS). */
  track?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; thumb: 0 | 1 } | null>(null);
  const touchKeys = useIdleGesture(500);
  const lo = Math.min(value[0], value[1]);
  const hi = Math.max(value[0], value[1]);
  const round = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) / step) * step;
  const set = (thumb: 0 | 1, v: number) => {
    const x = Number(round(v).toFixed(4));
    const next: [number, number] = thumb === 0 ? [Math.min(x, hi), hi] : [lo, Math.max(x, lo)];
    if (next[0] !== lo || next[1] !== hi) onChange(next);
  };
  const at = (e: { clientX: number }) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? (e.clientX - r.left) / r.width : null;
  };

  useEffect(
    () => () => {
      if (drag.current) endDevelopDrag();
      drag.current = null;
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const v = at(e);
    if (v === null) return;
    const thumb: 0 | 1 = Math.abs(v - lo) <= Math.abs(v - hi) && !(v > hi) ? 0 : 1;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginDevelopDrag();
    drag.current = { pointerId: e.pointerId, thumb };
    set(thumb, v);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const v = at(e);
    if (!d || d.pointerId !== e.pointerId || v === null) return;
    set(d.thumb, v);
  };
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    endDevelopDrag();
  };
  const onKey = (thumb: 0 | 1) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 10 : 1;
    let delta = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step * big;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step * big;
    else return;
    e.preventDefault();
    e.stopPropagation();
    touchKeys();
    set(thumb, (thumb === 0 ? lo : hi) + delta);
  };
  const pct = (v: number) => `${v * 100}%`;
  const thumb = (t: 0 | 1, v: number, name: string): ReactNode => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${label} ${name}`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={v}
      aria-valuetext={`${Math.round(v * 100)}`}
      onKeyDown={onKey(t)}
      className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-stage/40 bg-fg shadow outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ left: pct(v) }}
    />
  );
  return (
    <div className="select-none">
      <div className="mb-0.5 flex items-center justify-between text-xs">
        <span className="text-fg-muted">{label}</span>
        <span className="text-fg tabular-nums">
          {Math.round(lo * 100)} – {Math.round(hi * 100)}
        </span>
      </div>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        data-testid="range-track"
        className="relative h-4 cursor-ew-resize touch-none"
      >
        <div
          className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
          style={{ background: track }}
        />
        <div
          className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-accent/70"
          style={{ left: pct(lo), width: pct(hi - lo) }}
        />
        {thumb(0, lo, 'low')}
        {thumb(1, hi, 'high')}
      </div>
    </div>
  );
}

function SmallButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}

interface MenuItem {
  key: string;
  label: string;
  onSelect?: () => void;
  /** Shown disabled with this tooltip. */
  disabled?: string;
}

/** A button opening a small menu below it; Escape or a click outside closes it. */
function Menu({
  label,
  items,
  separatorBefore,
  primary = false,
  title,
}: {
  label: string;
  items: MenuItem[];
  separatorBefore?: string;
  primary?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={`rounded-md border px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          primary ? 'border-accent/60 text-fg hover:bg-accent/15' : 'border-line text-fg-muted hover:text-fg'
        }`}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="absolute top-full left-0 z-20 mt-1 min-w-40 rounded-md border border-line bg-panel py-1 shadow-float"
        >
          {items.map((item) => (
            <div key={item.key} title={item.disabled}>
              {item.key === separatorBefore && <hr className="my-1 border-line" />}
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled !== undefined}
                title={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className="block w-full px-3 py-1 text-left text-xs text-fg outline-none hover:bg-line focus-visible:bg-line disabled:text-fg-muted disabled:hover:bg-transparent"
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
