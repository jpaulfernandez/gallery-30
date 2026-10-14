import type { DevelopSettings } from '@photobook/shared';
import { lutPresent } from './tauri';

/** Photo names listed in the message before "and N more". */
const LISTED = 5;

/**
 * Workflow plan 18: before a publish or an export renders, the photos whose look names a LUT file that is not on this
 * machine (the full render would refuse each one). Returns one readable message listing them, or null when every LUT
 * is there. Each LUT is asked about once.
 */
export async function missingLutMessage(
  items: readonly { label: string; settings: DevelopSettings | undefined }[],
): Promise<string | null> {
  const known = new Map<string, Promise<boolean>>();
  const missing: { label: string; lut: string }[] = [];
  for (const { label, settings } of items) {
    const lut = settings?.look?.lut;
    if (!lut) continue;
    let present = known.get(lut.id);
    if (!present) {
      present = lutPresent(lut.id).catch(() => true);
      known.set(lut.id, present);
    }
    if (!(await present)) missing.push({ label, lut: lut.name });
  }
  if (missing.length === 0) return null;
  const luts = [...new Set(missing.map((m) => m.lut))];
  const names = missing.slice(0, LISTED).map((m) => `${m.label} (${m.lut})`);
  const more = missing.length > LISTED ? ` and ${missing.length - LISTED} more` : '';
  const photos = missing.length === 1 ? '1 photo uses' : `${missing.length} photos use`;
  const which = luts.length === 1 ? `a LUT that is` : `LUTs that are`;
  return (
    `${photos} ${which} missing on this Mac: ${names.join(', ')}${more}. ` +
    'Import the LUT again (Develop → Look → Locate…) or remove it from those photos.'
  );
}
