import { suggestedAmount } from '../../lib/denoise';
import { needsDenoise } from '../../store/collections';
import { useDenoisePrefs } from '../../store/denoisePrefs';
import type { PhotoFile } from '../../store/library';

type NoiseFacts = Pick<PhotoFile, 'iso' | 'noise'> & Partial<Pick<PhotoFile, 'kind'>>;

/**
 * Workflow plan 27: whether a thumbnail shows the "needs denoise" badge: the photo needs denoise by Settings → Models'
 * thresholds (its measured σ when known, else its ISO; `needsDenoise`) and its denoise is not on yet.
 */
export function showsDenoiseBadge(
  photo: NoiseFacts | undefined,
  denoiseOn: boolean,
  thresholds: { iso: number; amount: number },
): boolean {
  return !!photo && !denoiseOn && needsDenoise(photo, thresholds);
}

/** "ISO 6400 · suggests 55" for the badge's tooltip. */
function reason(photo: NoiseFacts): string {
  if (photo.noise !== undefined && photo.noise !== null) {
    const amount = suggestedAmount({ sigma: photo.noise, source: photo.kind === 'raw' ? 'raw' : 'processed' });
    return `measured noise suggests ${amount ?? 0}`;
  }
  return `ISO ${photo.iso}`;
}

/** A small badge on a thumbnail (Filmstrip, Cull grid) of a photo that would benefit from denoise. */
export function DenoiseBadge({
  photo,
  denoiseOn,
  className = '',
}: {
  photo: NoiseFacts | undefined;
  denoiseOn: boolean;
  className?: string;
}) {
  const iso = useDenoisePrefs((s) => s.iso);
  const amount = useDenoisePrefs((s) => s.amount);
  if (!photo || !showsDenoiseBadge(photo, denoiseOn, { iso, amount })) return null;
  return (
    <span
      role="img"
      aria-label="Needs denoise"
      title={`Needs denoise (${reason(photo)})`}
      data-testid="denoise-badge-thumb"
      className={`absolute flex size-4 items-center justify-center rounded-full bg-stage/70 text-warn ${className}`}
    >
      <svg viewBox="0 0 16 16" className="size-2.5" fill="currentColor" aria-hidden="true">
        <circle cx="4" cy="4" r="1.3" />
        <circle cx="9" cy="3" r="1.1" />
        <circle cx="12.5" cy="6.5" r="1.3" />
        <circle cx="6" cy="8.5" r="1.3" />
        <circle cx="3.5" cy="12.5" r="1.1" />
        <circle cx="10" cy="11" r="1.3" />
        <circle cx="13" cy="13.5" r="0.9" />
      </svg>
    </span>
  );
}
