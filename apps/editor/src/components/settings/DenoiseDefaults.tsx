import type { DenoiseModel } from '@photobook/shared';
import { DENOISE_MODEL_CHOICES } from '../../lib/denoise';
import { DEFAULT_NEEDS_AMOUNT, DEFAULT_NEEDS_ISO, useDenoisePrefs } from '../../store/denoisePrefs';

const ISO_STEPS = [800, 1600, 3200, 6400, 12800];
const AMOUNT_STEPS = [20, 30, 40, 50, 60, 70];

const selectClass =
  'rounded-md border border-line bg-panel-2 px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Settings → Models, Denoise (workflow plans 27 and 28): the default model, which every switch-on uses (the Denoise
 * group's switch and *Denoise selected*; a photo can override it under the group's Advanced), and the thresholds from
 * which a photo is marked as needing denoise (the thumbnail badge in Cull and the filmstrip, the *Needs denoise*
 * collection): its measured noise when it has a profile, its ISO otherwise.
 */
export function DenoiseDefaults() {
  const model = useDenoisePrefs((s) => s.model);
  const iso = useDenoisePrefs((s) => s.iso);
  const amount = useDenoisePrefs((s) => s.amount);
  const set = useDenoisePrefs((s) => s.set);
  const isoSteps = ISO_STEPS.includes(iso) ? ISO_STEPS : [...ISO_STEPS, iso].sort((a, b) => a - b);
  const amountSteps = AMOUNT_STEPS.includes(amount) ? AMOUNT_STEPS : [...AMOUNT_STEPS, amount].sort((a, b) => a - b);
  return (
    <div className="space-y-2" data-testid="denoise-defaults">
      <h3 className="font-medium text-fg text-xs">Denoise</h3>
      <label className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-fg-muted">Default model</span>
        <select
          aria-label="Default denoise model"
          value={model}
          onChange={(e) => set({ model: e.target.value as DenoiseModel })}
          className={selectClass}
        >
          {DENOISE_MODEL_CHOICES.map((m) => (
            <option key={m.id} value={m.id} title={m.hint}>
              {m.name}
              {m.recommended ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-fg-muted">Suggest denoise from ISO</span>
        <select
          aria-label="Suggest denoise from ISO"
          value={iso}
          onChange={(e) => set({ iso: Number(e.target.value) })}
          className={selectClass}
        >
          {isoSteps.map((v) => (
            <option key={v} value={v}>
              {v}
              {v === DEFAULT_NEEDS_ISO ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-fg-muted">or, once measured, when the noise suggests at least</span>
        <select
          aria-label="Suggest denoise from a measured amount"
          value={amount}
          onChange={(e) => set({ amount: Number(e.target.value) })}
          className={selectClass}
        >
          {amountSteps.map((v) => (
            <option key={v} value={v}>
              {v}
              {v === DEFAULT_NEEDS_AMOUNT ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-fg-muted">
        Switching denoise on uses the default model; a photo can use another one under Denoise &rsaquo; Advanced. Photos
        above the threshold get a small badge in Cull and the filmstrip and are listed in Needs denoise. A photo&rsquo;s
        measured noise (from its Denoise panel or a batch) replaces its ISO.
      </p>
    </div>
  );
}
