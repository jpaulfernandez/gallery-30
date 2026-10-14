import { SURROUND_COLOR, SURROUND_LABEL } from '../../lib/surround';
import { SURROUNDS, useUiStore } from '../../store/ui';
import { Switch } from '../ui/Field';

/**
 * Plan 44: the surround of the photo wells (Develop, the Review loupe, the Cull grid; the Design desk stays on `canvas`), per machine. Black is the
 * screen-viewing surround, mid grey the print-matching one; all three are achromatic.
 */
export function SurroundPicker() {
  const surround = useUiStore((s) => s.surround);
  const setPref = useUiStore((s) => s.setPref);
  return (
    <div role="radiogroup" aria-label="Surround" className="inline-flex gap-0.5 rounded-sm bg-panel-2 p-0.5 text-xs">
      {SURROUNDS.map((s) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a native radio input.
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={surround === s}
          onClick={() => setPref('surround', s)}
          className={`flex items-center gap-1.5 rounded-xs px-2.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${
            surround === s ? 'bg-panel-3 text-fg' : 'text-fg-2 hover:text-fg'
          }`}
        >
          <span
            aria-hidden="true"
            className="size-2.5 rounded-pill border border-line"
            style={{ background: SURROUND_COLOR[s] }}
          />
          {SURROUND_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

/** Settings → Appearance. */
export function AppearancePanel() {
  return (
    <section className="space-y-3">
      <h2 className="section-title">Appearance</h2>
      <div className="flex items-center justify-between gap-3">
        <span className="text-fg-2 text-xs">Surround</span>
        <SurroundPicker />
      </div>
      <p className="text-[11px] text-fg-muted">
        The neutral grey around the picture in Develop, Review and the Cull grid. Black for judging on screen, mid grey
        for matching a print.
      </p>
      <HapticsSwitch />
    </section>
  );
}

/** Plan 46: the haptic ticks (`lib/haptic.ts`), on by default, per machine. */
export function HapticsSwitch() {
  const haptics = useUiStore((s) => s.haptics);
  const setPref = useUiStore((s) => s.setPref);
  return (
    <div className="space-y-1">
      <Switch label="Haptics" checked={haptics} onChange={(on) => setPref('haptics', on)} />
      <p className="text-[11px] text-fg-muted">
        A click on the trackpad when a slider passes its default, a frame snaps to a guide or the zoom reaches Fit or
        100 %. Needs a Force Touch trackpad; off while the system reduces motion.
      </p>
    </div>
  );
}
