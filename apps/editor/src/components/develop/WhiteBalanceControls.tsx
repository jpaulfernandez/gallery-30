import type { WhiteBalance } from '@photobook/shared';
import { usePhotoFile } from '../../store/assets';
import { Slider } from './Slider';

export const TEMPERATURE_TRACK = 'linear-gradient(to right, #4a90e2, #cfcfcf, #f2c14e)';
export const TINT_TRACK = 'linear-gradient(to right, #4cc36b, #cfcfcf, #d65db1)';

/** Absolute white balance range (the schema's `absolute` mode). */
export const KELVIN_MIN = 2000;
export const KELVIN_MAX = 50000;
const TINT_ABS = 150;
/** Steps of the log-scaled Kelvin track: one step is about 0.3 % (16 K at 5000 K). */
const KELVIN_STEPS = 1000;
/** Used when a RAW's as-shot white balance is not known yet (`prepare_asset` has not answered). */
const FALLBACK_AS_SHOT: [number, number] = [5500, 0];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Track position (0..KELVIN_STEPS) of `kelvin` on a log scale. */
export function kelvinToPosition(kelvin: number): number {
  const k = clamp(kelvin, KELVIN_MIN, KELVIN_MAX);
  return (Math.log(k / KELVIN_MIN) / Math.log(KELVIN_MAX / KELVIN_MIN)) * KELVIN_STEPS;
}

/** Kelvin at track position `position`, rounded to 10 K below 10 000 K and 100 K above. */
export function positionToKelvin(position: number): number {
  const k = KELVIN_MIN * (KELVIN_MAX / KELVIN_MIN) ** (clamp(position, 0, KELVIN_STEPS) / KELVIN_STEPS);
  const unit = k < 10000 ? 10 : 100;
  return clamp(Math.round(k / unit) * unit, KELVIN_MIN, KELVIN_MAX);
}

/** Parse typed Kelvin ("5450", "5450K", "5450 k") to a track position; undefined when it is not a number. */
export function parseKelvin(text: string): number | undefined {
  const k = Number(text.replace(/\s*k$/i, ''));
  return Number.isFinite(k) && text.trim() !== '' ? kelvinToPosition(k) : undefined;
}

interface WhiteBalanceControlsProps {
  assetId: string;
  whiteBalance: WhiteBalance;
  onChange: (whiteBalance: WhiteBalance) => void;
}

/**
 * The white balance part of the Basic section.
 *
 * Rendered files (JPEG, PNG, HEIC): As shot / Custom, where Custom is the `incremental` mode (−100..100 shifts).
 * Camera RAW (the assets store's `isRaw`): As shot / Custom, where Custom is the `absolute` mode: Kelvin 2000..50000
 * on a log track (click the readout to type a value) and tint −150..150, both starting from the file's as-shot values
 * (`asShot`, which the sliders show while As shot is on; moving one switches to Custom). `incremental` is never
 * offered for a RAW (a pasted one shows as Custom at the as-shot values until a slider moves).
 */
export function WhiteBalanceControls({ assetId, whiteBalance: wb, onChange }: WhiteBalanceControlsProps) {
  const file = usePhotoFile(assetId);
  const isRaw = file?.isRaw === true;
  const shotKelvin = file?.asShot?.[0];
  const shotTint = file?.asShot?.[1];

  if (isRaw) {
    const asShot: [number, number] = [
      clamp(shotKelvin ?? FALLBACK_AS_SHOT[0], KELVIN_MIN, KELVIN_MAX),
      clamp(shotTint ?? FALLBACK_AS_SHOT[1], -TINT_ABS, TINT_ABS),
    ];
    const [kelvin, tint] = wb.mode === 'absolute' ? [wb.temperature, wb.tint] : asShot;
    const setAbsolute = (patch: { temperature?: number; tint?: number }) =>
      onChange({ mode: 'absolute', temperature: kelvin, tint, ...patch });
    return (
      <>
        <ModeControl
          options={[
            ['asShot', 'As shot'],
            ['absolute', 'Custom'],
          ]}
          active={wb.mode === 'asShot' ? 'asShot' : 'absolute'}
          onSelect={(mode) =>
            onChange(mode === 'asShot' ? { mode } : { mode, temperature: asShot[0], tint: asShot[1] })
          }
        />
        <Slider
          label="Temperature"
          value={kelvinToPosition(kelvin)}
          min={0}
          max={KELVIN_STEPS}
          defaultValue={kelvinToPosition(asShot[0])}
          format={() => `${Math.round(kelvin)} K`}
          editText={() => String(Math.round(kelvin))}
          parse={parseKelvin}
          track={TEMPERATURE_TRACK}
          onChange={(position) => {
            const temperature = positionToKelvin(position);
            if (temperature !== kelvin || wb.mode !== 'absolute') setAbsolute({ temperature });
          }}
        />
        <Slider
          label="Tint"
          value={tint}
          min={-TINT_ABS}
          max={TINT_ABS}
          step={1}
          defaultValue={asShot[1]}
          format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
          track={TINT_TRACK}
          onChange={(value) => setAbsolute({ tint: value })}
        />
      </>
    );
  }

  const editable = wb.mode !== 'absolute';
  const values = wb.mode === 'incremental' ? wb : { temperature: 0, tint: 0 };
  const setIncremental = (patch: { temperature?: number; tint?: number }) =>
    onChange({ mode: 'incremental', temperature: values.temperature, tint: values.tint, ...patch });
  return (
    <>
      <ModeControl
        options={[
          ['asShot', 'As shot'],
          ['incremental', 'Custom'],
        ]}
        active={wb.mode}
        disabled={!editable}
        onSelect={(mode) => onChange(mode === 'asShot' ? { mode } : { mode, temperature: 0, tint: 0 })}
      />
      {!editable && <p className="text-[11px] text-fg-muted">This photo uses an absolute (RAW) white balance.</p>}
      <Slider
        label="Temperature"
        value={values.temperature}
        min={-100}
        max={100}
        track={TEMPERATURE_TRACK}
        disabled={!editable}
        onChange={(temperature) => setIncremental({ temperature })}
      />
      <Slider
        label="Tint"
        value={values.tint}
        min={-100}
        max={100}
        track={TINT_TRACK}
        disabled={!editable}
        onChange={(tint) => setIncremental({ tint })}
      />
    </>
  );
}

function ModeControl<M extends WhiteBalance['mode']>({
  options,
  active,
  disabled = false,
  onSelect,
}: {
  options: ReadonlyArray<readonly [M, string]>;
  active: WhiteBalance['mode'];
  disabled?: boolean;
  onSelect: (mode: M) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="White balance mode"
      className="grid grid-cols-2 rounded-md border border-line p-0.5"
    >
      {options.map(([mode, text]) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={active === mode}
          disabled={disabled}
          onClick={() => {
            if (active !== mode) onSelect(mode);
          }}
          className={`rounded px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            active === mode ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
