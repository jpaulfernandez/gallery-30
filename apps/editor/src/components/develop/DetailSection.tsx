import { DEVELOP_DEFAULTS, type DevelopSettings } from '@photobook/shared';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { type DeepPartial, deepEqual } from '../../lib/develop/merge';
import { useBookStore } from '../../store/book';
import { CardMore } from './CardMore';
import { DenoiseGroup } from './DenoiseGroup';
import { useMaskView } from './maskView';
import { PanelCard } from './PanelCard';
import { Slider } from './Slider';

interface DetailSectionProps {
  assetId: string;
  settings: DevelopSettings;
}

/**
 * Alt-drag mask view: a press on a Sharpening slider with Alt held turns the mask view on (`useMaskView`; the image
 * area then shows `develop_sharpen_mask` instead of the render). It follows the Alt key while the pointer stays down
 * (letting go of Alt restores the render, pressing it again brings the mask back) and ends with the pointer.
 */
function useAltMaskGesture(): (e: ReactPointerEvent<HTMLElement>) => void {
  const end = useRef<(() => void) | null>(null);
  useEffect(() => () => end.current?.(), []);
  return (e) => {
    if (e.button !== 0 || !(e.target instanceof Element) || !e.target.closest('[role="slider"]')) return;
    end.current?.();
    const { setActive } = useMaskView.getState();
    setActive(e.altKey);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Alt') setActive(ev.type === 'keydown');
    };
    const onMove = (ev: PointerEvent) => setActive(ev.altKey);
    const stop = () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('blur', stop);
      end.current = null;
      setActive(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('blur', stop);
    end.current = stop;
  };
}

/**
 * Plan 54: the Detail card of the Develop panel: Texture, Clarity and Dehaze (nothing more in Advanced). Its reset puts
 * those three back; Sharpening and denoise are the next card's (`SharpenSection`).
 */
export function DetailSection({ assetId, settings }: DetailSectionProps) {
  const [open, setOpen] = useState(false);
  const { clarity, texture, dehaze } = settings.detail;
  const set = (patch: DeepPartial<DevelopSettings['detail']>) =>
    useBookStore.getState().setAssetDevelop(assetId, { detail: patch });
  const defaults = DEVELOP_DEFAULTS.detail;
  const isDefault = texture === defaults.texture && clarity === defaults.clarity && dehaze === defaults.dehaze;

  return (
    <PanelCard
      title="Detail"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onReset={() => set({ texture: defaults.texture, clarity: defaults.clarity, dehaze: defaults.dehaze })}
      resetDisabled={isDefault}
      bodyClassName="space-y-3 px-3"
    >
      <Slider label="Texture" value={texture} min={-100} max={100} onChange={(v) => set({ texture: v })} />
      <Slider label="Clarity" value={clarity} min={-100} max={100} onChange={(v) => set({ clarity: v })} />
      <Slider label="Dehaze" value={dehaze} min={-100} max={100} onChange={(v) => set({ dehaze: v })} />
    </PanelCard>
  );
}

/**
 * Plan 54: the Sharpen & denoise card (the former Detail section's second half). Basic: Sharpening Amount and the
 * Denoise group (AI denoise, an explicit Apply; plan 28, with its own Advanced disclosure); the ▸ *Radius, detail,
 * masking* (inline in Advanced) holds the rest of Sharpening. Holding Alt while dragging a Sharpening slider shows the
 * sharpening mask (white = sharpened). The reset puts Sharpening back and turns denoise off, one undo step.
 */
export function SharpenSection({ assetId, settings }: DetailSectionProps) {
  const [open, setOpen] = useState(false);
  const onMaskGesture = useAltMaskGesture();
  const { sharpen, denoise } = settings.detail;
  const set = (patch: DeepPartial<DevelopSettings['detail']>) =>
    useBookStore.getState().setAssetDevelop(assetId, { detail: patch });
  const defaults = DEVELOP_DEFAULTS.detail;
  const isDefault = deepEqual(sharpen, defaults.sharpen) && deepEqual(denoise, defaults.denoise);

  return (
    <PanelCard
      title="Sharpen & denoise"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onReset={() =>
        useBookStore.getState().setAssetDevelop(assetId, (prev) => ({
          ...prev,
          detail: { ...prev.detail, sharpen: structuredClone(defaults.sharpen), denoise: defaults.denoise },
        }))
      }
      resetDisabled={isDefault}
      bodyClassName="space-y-3 px-3"
    >
      <p className="section-title" title="Hold Alt while dragging to see the sharpening mask">
        Sharpening
      </p>
      <div className="space-y-3" onPointerDownCapture={onMaskGesture} data-testid="sharpening-group">
        <Slider
          label="Amount"
          value={sharpen.amount}
          min={0}
          max={150}
          defaultValue={40}
          onChange={(v) => set({ sharpen: { amount: v } })}
        />
        <CardMore id="sharpen.more" settings={settings}>
          <Slider
            label="Radius"
            value={sharpen.radius}
            min={0.5}
            max={3}
            step={0.1}
            defaultValue={1}
            onChange={(v) => set({ sharpen: { radius: v } })}
          />
          <Slider
            label="Detail"
            value={sharpen.detail}
            min={0}
            max={100}
            defaultValue={25}
            onChange={(v) => set({ sharpen: { detail: v } })}
          />
          <Slider
            label="Masking"
            value={sharpen.masking}
            min={0}
            max={100}
            onChange={(v) => set({ sharpen: { masking: v } })}
          />
        </CardMore>
      </div>
      <p className="text-[11px] text-fg-muted">Applied with any Detail edit</p>
      <DenoiseGroup assetId={assetId} settings={settings} />
    </PanelCard>
  );
}
