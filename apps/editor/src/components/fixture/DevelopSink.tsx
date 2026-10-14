import { createDevelop, curvePresetPoints, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { useLayoutEffect, useState } from 'react';
import { newLinear, newLuminance, newMask, newRadial } from '../../lib/develop/masks';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetDevelop } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { DevelopPanel } from '../develop/DevelopPanel';
import { MaskTools } from '../develop/MaskTools';
import { Button } from '../ui/Button';

/** The fixture photo the sink edits. */
const ASSET = 'f1';
const MASK = 'sink-mask';
const COMPONENT = 'sink-luminance';
/** Plan 56: a linear gradient drawn bottom to top (full at the press, the bottom) and a turned radial one. */
const LINEAR = { mask: 'sink-linear', component: 'sink-linear-c' };
const RADIAL = { mask: 'sink-radial', component: 'sink-radial-c' };

/**
 * Synthetic settings that show every card's states: Light edited with the Strong S curve preset (Curve ·edited), a
 * colour mix band, Sharpening Radius off its default, the vignette's Midpoint, Upright guides, and a luminance mask
 * with a narrowed range (its ▸ ·edited).
 */
function sinkSettings(): DevelopSettings {
  const s = createDevelop();
  s.light.exposure = 0.3;
  s.light.highlights = -40;
  s.light.shadows = 25;
  s.curve.luma = curvePresetPoints('strongS');
  s.color.vibrance = 12;
  s.color.mix.blue.saturation = -20;
  s.detail.texture = 10;
  s.detail.sharpen.radius = 1.3;
  s.effects.vignette.amount = -18;
  s.effects.vignette.midpoint = 35;
  s.geometry.transform.vertical = 8;
  s.masks = [
    newMask('Sky', { ...newLuminance([0.6, 1]), id: COMPONENT }, MASK),
    newMask('Ground', { ...newLinear([0.5, 0.35], [0.5, 0.85]), id: LINEAR.component }, LINEAR.mask),
    newMask('Face', { ...newRadial([0.62, 0.45], [0.12, 0.16], undefined, 30), id: RADIAL.component }, RADIAL.mask),
  ];
  return s;
}

/**
 * Plan 54: the Develop panel's seven cards on synthetic settings, Basic and Advanced side by side (the real
 * `DevelopPanel`, no `invoke`): the Basic ⇄ Advanced switch, the ▸ parts with their `·edited` tags, the curve preset
 * chips. While it shows it holds the book store and its undo history (the fixture book, one photo edited) and the mask
 * selection; it puts them back on leave. Edits here are live in both panels.
 */
export function DevelopSink() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const before = {
      book: useBookStore.getState(),
      files: useAssetsStore.getState().files,
      masks: useUiStore.getState().developMasks,
      tool: useUiStore.getState().developMaskTool,
      history: {
        pastStates: useBookStore.temporal.getState().pastStates,
        futureStates: useBookStore.temporal.getState().futureStates,
      },
    };
    const book = structuredClone(fixtureBook);
    const asset = book.assets[ASSET];
    if (asset) asset.develop = sinkSettings();
    useBookStore.setState({ book, folder: '/fixture', projectId: null });
    useBookStore.temporal.getState().clear();
    useAssetsStore.setState({ files: {} });
    useUiStore.setState({ developMasks: true, developMaskTool: { maskId: MASK, componentId: COMPONENT, tool: null } });
    setReady(true);
    return () => {
      useBookStore.setState({ book: before.book.book, folder: before.book.folder, projectId: before.book.projectId });
      useBookStore.temporal.setState(before.history);
      useAssetsStore.setState({ files: before.files });
      useUiStore.setState({ developMasks: before.masks, developMaskTool: before.tool });
    };
  }, []);
  const settings = useBookStore((s) => assetDevelop(s, ASSET)) ?? createDevelop();
  if (!ready) return null;
  const pick = (ids: { mask: string; component: string }, tool: 'linear' | 'radial') =>
    useUiStore.getState().setDevelopMaskTool({ maskId: ids.mask, componentId: ids.component, tool });
  return (
    <div className="flex flex-wrap items-start gap-6" data-testid="develop-sink">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-[11px] text-fg-muted">
          Masks: linear (full at the press) · radial · rotate handle
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => pick(LINEAR, 'linear')}>
            Select the linear gradient
          </Button>
          <Button size="sm" onClick={() => pick(RADIAL, 'radial')}>
            Select the radial gradient
          </Button>
        </div>
        {/* The real tools over a stand-in picture (1200 × 800, no photo, no invoke: the source has no file). */}
        <div className="relative h-[448px] w-[648px] rounded-md bg-stage-mid" data-testid="mask-sink">
          <MaskTools
            assetId={ASSET}
            settings={settings}
            size={{ width: 1200, height: 800 }}
            sampleUrl={undefined}
            source={{ folder: null, assetId: ASSET, relPath: undefined, hash: undefined }}
          />
        </div>
      </div>
      {([false, true] as const).map((advanced) => (
        <div key={String(advanced)} className="flex flex-col gap-2">
          <p className="font-mono text-[11px] text-fg-muted">{advanced ? 'Advanced' : 'Basic'}</p>
          <div className="flex h-[760px] w-80 flex-col rounded-md border border-hairline bg-panel">
            <DevelopPanel
              assetId={ASSET}
              settings={settings}
              edited
              canPaste={false}
              onCopy={() => {}}
              onCopyDialog={() => {}}
              onPaste={() => {}}
              onCrop={() => {}}
              advanced={advanced}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
