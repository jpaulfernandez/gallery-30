import {
  type ChromaMode,
  DEFAULT_DENOISE,
  type Denoise,
  type DenoiseModel,
  type DevelopSettings,
} from '@photobook/shared';
import { useEffect, useState } from 'react';
import {
  advancedTouched,
  amountPatch,
  colourForAmount,
  DENOISE_MODEL_CHOICES,
  estimateLabel,
  isNotNeeded,
  MID_GREY,
  modelSizeLabel,
  noiseBadge,
  notNeededLabel,
  profileEvidence,
  resetAdvancedPatch,
  suggestedAmount,
  switchOnDenoise,
} from '../../lib/denoise';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { type NoiseProfile, noiseProfile } from '../../lib/tauri';
import { usePhotoFile, usePhotoHash } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useDenoisePrefs } from '../../store/denoisePrefs';
import { assetDevelop, assetFolder, recordPhotoNoise } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { formatBytes } from '../settings/ModelsPanel';
import { buttonClass as buttonLook } from '../ui/Button';
import { Switch } from '../ui/Field';
import { Slider } from './Slider';
import { type DenoisePhase, noteSwitchOn, phaseLabel, useDenoise } from './useDenoise';

interface DenoiseGroupProps {
  assetId: string;
  settings: DevelopSettings;
}

/** The models Advanced offers (shared with Settings → Models). */
const MODEL_CHOICES = DENOISE_MODEL_CHOICES;

/** Where Colour comes from (workflow plan 24). */
const CHROMA_CHOICES: Array<{ id: ChromaMode; name: string; hint: string }> = [
  {
    id: 'filter',
    name: 'Filter',
    hint: 'A colour filter guided by the denoised detail. Colour moves at once, without running the model again.',
  },
  {
    id: 'model',
    name: 'Model',
    hint: "The model's own colour. Smoother on heavy noise, but can wash out patches of colour.",
  },
];

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = buttonLook({ size: 'sm' });

const PILL_CLASS: Record<DenoisePhase['kind'], string> = {
  off: '',
  checking: '',
  needsModel: 'bg-line text-fg-muted',
  needsApply: 'bg-warn/20 text-warn',
  queued: 'bg-line text-fg-muted',
  running: 'bg-accent/25 text-fg',
  applied: 'bg-ok/20 text-ok',
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 100_000 ? 1 : 0)} s`;

/** Advanced's defaults: Sharpen and the colour mode from the schema, the model from Settings → Models. */
const advancedDefaults = (model: DenoiseModel) => ({
  model,
  sharpen: DEFAULT_DENOISE.sharpen,
  chromaMode: DEFAULT_DENOISE.chromaMode,
});

/**
 * The Denoise group of the Detail section, built around one slider (workflow plan 28, WORKFLOW_PLAN 10.3):
 *
 * - The row: the switch (`detail.denoise`, one undo step each way) and the state pill (`denoisePhase`: *Needs apply*,
 *   *Queued*, *Running 37 %*, *Applied*, *Needs model*).
 * - The camera badge (plan 23): camera, ISO, the amount the noise profile suggests (or "Not needed"), learned photos.
 *   A photo whose suggestion is under the "Not needed" line shows only "Not needed at ISO 200" while denoise is off.
 * - **Amount** sets Luminance; Colour follows it (`min(100, amount + 25)`) until Advanced sets it apart; Sharpen stays
 *   (`amountPatch`, `lib/denoise.ts`). Double-click returns Amount to the suggestion.
 * - **Preview at 100 %** toggles the loupe on the picture (`DenoiseLoupe`; switching on opens it) and **Apply** runs
 *   the full denoise now, labelled with the estimate from the model's last run. Nobody has to press it: leaving the
 *   photo while it reads *Needs apply* queues the run (`useQueueDenoiseOnLeave`), and publishing waits for it.
 * - The first-run model card: the size, the licence and one Download button.
 * - **Advanced**: Luminance (the Amount itself), Colour, Sharpen, the colour source (plan 24) and this photo's model
 *   (Settings → Models holds the default), and Reset back to the mapping.
 */
export function DenoiseGroup({ assetId, settings }: DenoiseGroupProps) {
  const denoise = settings.detail.denoise;
  const d = useDenoise(assetId, settings);
  const previewOpen = useUiStore((s) => s.denoise.previewOpen);
  const defaultModel = useDenoisePrefs((s) => s.model);
  const folder = useBookStore((s) => assetFolder(s, assetId));
  const recordedPath = useBookStore((s) => s.book?.assets[assetId]?.path);
  const file = usePhotoFile(assetId);
  const relPath = recordedPath ?? file?.relPath;
  const hash = usePhotoHash(assetId);
  const noise = useNoiseProfile(folder, relPath, hash);
  const evidence = profileEvidence(noise?.profile, file?.iso);
  const suggestion = suggestedAmount(evidence);
  const iso = noise?.profile?.iso ?? file?.iso;
  const badge = noiseBadge({
    make: noise?.profile?.make,
    model: noise?.profile?.model,
    iso,
    amount: suggestion,
    photos: noise?.profile?.photos,
  });
  // "Not needed" photos show the group folded while denoise is off; a click unfolds it for this photo.
  const [unfolded, setUnfolded] = useState<string | null>(null);
  // Decided once the measurement is in (or cannot be made), so the group does not fold on the ISO and unfold 250 ms
  // later when the measured noise disagrees; a photo measured before answers at once.
  const measured = !folder || !relPath || !hash || (noise !== null && (noise.profile !== null || noise.error !== null));
  const folded = !denoise && measured && isNotNeeded(suggestion) && unfolded !== assetId;
  const pill = phaseLabel(d.phase);
  const defaults = advancedDefaults(defaultModel);

  const setDenoise = useBookStore.getState().setDenoise;
  const set = (patch: Partial<Denoise>) => setDenoise(assetId, patch);
  /** The photo's denoise settings now (a drag can emit twice before this component renders again). */
  const current = () => assetDevelop(useBookStore.getState(), assetId)?.detail.denoise ?? denoise;
  const setAmount = (amount: number) => {
    const now = current();
    if (now) set(amountPatch(now, amount));
  };
  const toggle = () => {
    if (denoise) {
      setDenoise(assetId, null);
      return;
    }
    noteSwitchOn(hash, relPath);
    setDenoise(assetId, { model: defaultModel, ...switchOnDenoise(suggestion) });
    // Switching on opens the loupe on the picture.
    useUiStore.getState().updateDenoise(() => ({ previewOpen: true }));
  };
  const toggleLoupe = () => useUiStore.getState().updateDenoise((s) => ({ previewOpen: !s.previewOpen }));
  const amountDefault = switchOnDenoise(suggestion).luminance ?? DEFAULT_DENOISE.luminance;

  return (
    <fieldset aria-label="Denoise" className="min-w-0 space-y-3 border-line border-t pt-3" data-testid="denoise-group">
      <div className="flex items-center gap-2">
        <p className="section-title">Denoise</p>
        {pill && (
          <span
            aria-live="polite"
            data-testid="denoise-pill"
            data-phase={d.phase.kind}
            className={`rounded-full px-2 py-px text-[10px] tabular-nums ${PILL_CLASS[d.phase.kind]}`}
          >
            {pill}
          </span>
        )}
        <Switch hideLabel label="Denoise" checked={denoise !== null} onChange={toggle} className="ml-auto flex" />
      </div>

      {folded ? (
        <button
          type="button"
          data-testid="denoise-not-needed"
          aria-expanded={false}
          title={badge || undefined}
          onClick={() => setUnfolded(assetId)}
          className="text-left text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          {notNeededLabel(iso, typeof evidence.sigma === 'number')}
        </button>
      ) : (
        <p
          className="text-[11px] text-fg-muted"
          data-testid="denoise-badge"
          title={
            noise?.profile
              ? `Noise ${((noise.profile.sigma / MID_GREY) * 100).toFixed(2)} % of mid-grey, confidence ${Math.round(
                  noise.profile.confidence * 100,
                )} %`
              : undefined
          }
        >
          {noise && !noise.profile && !noise.error ? 'Measuring noise…' : badge || 'No camera data'}
        </p>
      )}

      {denoise && (
        <>
          <Slider
            label="Amount"
            value={denoise.luminance}
            min={0}
            max={100}
            defaultValue={amountDefault}
            onChange={setAmount}
          />

          {d.view.kind === 'missingModel' && (
            <div className="space-y-1.5 rounded-md border border-line p-2" data-testid="denoise-download">
              <p className="text-[11px] text-fg">
                {d.view.model.title} · {modelSizeLabel(d.view.model.bytes)} · {d.view.model.licence}
              </p>
              <p className="text-[11px] text-fg-muted">Downloaded once; denoise then runs on this computer.</p>
              {d.download ? (
                <ProgressRow
                  label={`${d.view.model.title} download`}
                  done={d.download.received}
                  total={d.download.total}
                  text={`${formatBytes(d.download.received)} / ${formatBytes(d.download.total)}`}
                  onCancel={() => void d.cancelDownload()}
                />
              ) : (
                <button type="button" onClick={() => void d.fetchModel()} className={buttonClass}>
                  {d.view.model.status.state === 'partial' ? 'Resume download' : 'Download'} ·{' '}
                  {modelSizeLabel(d.view.model.bytes)}
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={previewOpen}
              onClick={toggleLoupe}
              title="A 100 % loupe on the picture: drag it, drag its split, hold it for before"
              className={buttonLook({ size: 'sm', variant: 'toggle', pressed: previewOpen })}
            >
              Preview at 100 %
            </button>
            {!d.job && d.phase.kind !== 'running' && d.phase.kind !== 'queued' && d.view.kind !== 'missingModel' && (
              <button
                type="button"
                onClick={() => void d.apply()}
                disabled={!d.canApply}
                title={
                  d.view.kind === 'applied'
                    ? 'Already applied with these settings'
                    : 'Denoise the photo at full size now (it also runs by itself when you leave the photo)'
                }
                className={`${buttonClass} ml-auto`}
              >
                {d.estimateMs !== null && d.view.kind !== 'applied'
                  ? `Apply · ${estimateLabel(d.estimateMs)}`
                  : 'Apply'}
              </button>
            )}
          </div>

          {d.job && (
            <ProgressRow
              label="Denoise progress"
              done={d.job.done}
              total={d.job.total}
              text={
                d.job.state === 'queued'
                  ? 'Waiting…'
                  : d.job.total > 0
                    ? `tile ${d.job.done}/${d.job.total}`
                    : 'Preparing…'
              }
              onCancel={d.job.cancelling ? undefined : () => void d.cancel()}
            />
          )}

          <p className="text-[11px] text-fg-muted" data-testid="denoise-status" aria-live="polite">
            {d.phase.kind === 'needsApply' &&
              'Runs in the background when you move on to another photo; publishing waits for it.'}
            {d.phase.kind === 'applied' &&
              d.view.kind === 'applied' &&
              (d.view.elapsedMs ? `Denoised at full size in ${seconds(d.view.elapsedMs)}.` : 'Denoised at full size.')}
          </p>

          {d.error && (
            <p role="alert" className="break-words text-[11px] text-danger">
              {d.error}
            </p>
          )}

          <details className="text-xs" data-testid="denoise-advanced">
            <summary className="cursor-pointer truncate text-[11px] text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Advanced{' '}
              <span data-testid="denoise-advanced-summary">
                Luminance {denoise.luminance} · Colour {denoise.chroma} · Sharpen {denoise.sharpen} ·{' '}
                {MODEL_CHOICES.find((m) => m.id === denoise.model)?.name ?? denoise.model} · Colour:{' '}
                {denoise.chromaMode}
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              <Slider
                label="Luminance"
                value={denoise.luminance}
                min={0}
                max={100}
                defaultValue={amountDefault}
                onChange={setAmount}
              />
              <Slider
                label="Colour"
                value={denoise.chroma}
                min={0}
                max={100}
                defaultValue={colourForAmount(denoise.luminance)}
                onChange={(v) => set({ chroma: v })}
              />
              <Slider
                label="Sharpen"
                value={denoise.sharpen}
                min={0}
                max={100}
                defaultValue={DEFAULT_DENOISE.sharpen}
                onChange={(v) => set({ sharpen: v })}
              />
              <fieldset aria-label="Colour source" className="flex items-center justify-between gap-2">
                <span className="text-fg">Colour from</span>
                <span className="flex gap-1">
                  {CHROMA_CHOICES.map((c) => (
                    <label
                      key={c.id}
                      title={c.hint}
                      className={`${buttonLook({ size: 'sm', variant: 'toggle', pressed: denoise.chromaMode === c.id })} cursor-pointer focus-within:ring-2 focus-within:ring-accent`}
                    >
                      <input
                        type="radio"
                        name={`denoise-colour-${assetId}`}
                        className="sr-only"
                        checked={denoise.chromaMode === c.id}
                        onChange={() => set({ chromaMode: c.id })}
                      />
                      {c.name}
                    </label>
                  ))}
                </span>
              </fieldset>
              <p className="text-[11px] text-fg-muted">
                {CHROMA_CHOICES.find((c) => c.id === denoise.chromaMode)?.hint}
              </p>
              <label className="flex items-center justify-between gap-2">
                <span className="text-fg">Model</span>
                <select
                  aria-label="Denoise model"
                  value={denoise.model}
                  onChange={(e) => set({ model: e.target.value as DenoiseModel })}
                  className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {MODEL_CHOICES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.id === defaultModel ? ' (default)' : ''}
                    </option>
                  ))}
                  {!MODEL_CHOICES.some((m) => m.id === denoise.model) && (
                    <option value={denoise.model} disabled>
                      {denoise.model} (not available yet)
                    </option>
                  )}
                </select>
              </label>
              <p className="text-[11px] text-fg-muted">
                {MODEL_CHOICES.find((m) => m.id === denoise.model)?.hint} The default for new photos is in Settings →
                Models.
              </p>
              <button
                type="button"
                onClick={() => set(resetAdvancedPatch(denoise, defaults))}
                disabled={!advancedTouched(denoise, defaults)}
                title="Colour follows Amount again; Sharpen, the colour source and the model go back to their defaults"
                className={buttonClass}
              >
                Reset
              </button>
            </div>
          </details>
        </>
      )}
    </fieldset>
  );
}

function ProgressRow(props: { label: string; done: number; total: number; text: string; onCancel?: () => void }) {
  const { label, done, total, text, onCancel } = props;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1 flex-1 overflow-hidden rounded bg-panel-2"
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-24 text-right text-[11px] text-fg-muted tabular-nums">{text}</span>
      {onCancel && (
        <button type="button" onClick={onCancel} className={buttonClass}>
          Cancel
        </button>
      )}
    </div>
  );
}

/** Noise profiles fetched this session, by content hash (the measurement itself is cached on disk). */
const profiles = new Map<string, NoiseProfile>();
/** Requests in flight, by content hash: a photo shown twice (or in two groups) is asked for once. */
const inFlight = new Map<string, Promise<NoiseProfile>>();

/** Forget the session's noise profiles (tests). */
export const forgetNoiseProfiles = () => {
  profiles.clear();
  inFlight.clear();
};
/** A profile this confident stands for the photo in the library (the "Needs denoise" collection, the index). */
const RECORD_CONFIDENCE = 0.3;
/** A photo must stay shown this long before it is measured, so stepping through photos does not decode each one. */
export const NOISE_PROFILE_DELAY_MS = 250;

/** One `noise_profile` call per hash at a time; the result is remembered and recorded on the library file. */
function fetchNoiseProfile(folder: string, relPath: string, hash: string): Promise<NoiseProfile> {
  const known = profiles.get(hash);
  if (known) return Promise.resolve(known);
  const pending = inFlight.get(hash);
  if (pending) return pending;
  const request = noiseProfile(folder, relPath, hash)
    .then((profile) => {
      profiles.set(hash, profile);
      if (profile.measured.confidence >= RECORD_CONFIDENCE) recordPhotoNoise(folder, relPath, profile.measured.sigma);
      devLog('denoise', 'noise profile', {
        relPath,
        camera: [profile.make, profile.model].filter(Boolean).join(' '),
        iso: profile.iso,
        sigma: profile.measured.sigma,
        confidence: profile.measured.confidence,
        learn: profile.learn,
        photos: profile.photos,
      });
      return profile;
    })
    .finally(() => inFlight.delete(hash));
  inFlight.set(hash, request);
  return request;
}

/**
 * The photo's noise profile (`noise_profile`: measured once, cached, learned into its camera's profile), and its
 * measured σ recorded on the library file. Null until a photo is known; `profile` null while measuring or on error.
 * A photo is asked for only after it has been shown for `NOISE_PROFILE_DELAY_MS`, and a result for a photo no longer
 * shown is dropped (it is still remembered and recorded).
 */
function useNoiseProfile(
  folder: string | null,
  relPath: string | undefined,
  hash: string | undefined,
): { profile: NoiseProfile | null; error: string | null } | null {
  const [state, setState] = useState<{ hash: string; profile: NoiseProfile | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!folder || !relPath || !hash) return;
    const known = profiles.get(hash);
    if (known) {
      setState({ hash, profile: known, error: null });
      return;
    }
    let live = true;
    setState({ hash, profile: null, error: null });
    const timer = setTimeout(() => {
      let request: Promise<NoiseProfile>;
      try {
        request = fetchNoiseProfile(folder, relPath, hash);
      } catch (err) {
        // Only where there is no Tauri bridge at all (component tests that leave the wrapper out): no badge.
        if (live) setState({ hash, profile: null, error: errorMessage(err) });
        return;
      }
      request.then(
        (profile) => {
          if (live) setState({ hash, profile, error: null });
        },
        (err) => {
          devLog('denoise', 'noise profile failed', { relPath, error: errorMessage(err) });
          if (live) setState({ hash, profile: null, error: errorMessage(err) });
        },
      );
    }, NOISE_PROFILE_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [folder, relPath, hash]);
  if (state && state.hash === hash) return state;
  // A photo measured earlier this session answers on its first render.
  const known = hash ? profiles.get(hash) : undefined;
  return known ? { profile: known, error: null } : null;
}
