/**
 * Match camera JPEG (workflow plan 22): pairing a folder's RAW files with the JPEGs the camera wrote next to them, and
 * the fitted look the Look section suggests for a photo's film simulation. Pure.
 */
import { isRawPath } from '@photobook/shared';
import type { FilmTag, FitPair, LutInfo } from '../tauri';

const JPEG = /\.(jpe?g)$/i;

/** `dir/DSCF0001.RAF` → `dir/dscf0001` (directory kept, name lower-cased, extension dropped). */
function stemKey(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  const stem = dot > slash ? relPath.slice(0, dot) : relPath;
  return `${relPath.slice(0, slash + 1)}${stem.slice(slash + 1).toLowerCase()}`;
}

/**
 * Every RAW in `relPaths` with the JPEG of the same base name in the same directory (`DSCF0001.RAF` +
 * `DSCF0001.JPG`, case-insensitive), sorted by the RAW's path. A RAW without a JPEG, or with two candidates of the same
 * name (`.jpg` and `.jpeg`), takes the first in path order.
 */
export function pairCameraFiles(relPaths: readonly string[]): FitPair[] {
  const jpegs = new Map<string, string>();
  for (const path of [...relPaths].sort()) {
    if (!JPEG.test(path)) continue;
    const key = stemKey(path);
    if (!jpegs.has(key)) jpegs.set(key, path);
  }
  const pairs: FitPair[] = [];
  for (const raw of [...relPaths].sort()) {
    if (!isRawPath(raw)) continue;
    const jpeg = jpegs.get(stemKey(raw));
    if (jpeg) pairs.push({ raw, jpeg });
  }
  return pairs;
}

/** The pair a photo belongs to (as its RAW or its JPEG), if any. */
export function pairOf(pairs: readonly FitPair[], relPath: string): FitPair | undefined {
  return pairs.find((p) => p.raw === relPath || p.jpeg === relPath);
}

/**
 * The fitted LUT to suggest for a photo with film tag `tag`: the most accurate one (lowest mean ΔE, then name) fitted
 * from pairs with the same simulation and, when both are known, the same camera. Undefined when there is none or no tag.
 */
export function suggestedFittedLut(luts: readonly LutInfo[], tag: FilmTag | null | undefined): LutInfo | undefined {
  if (!tag?.simulation) return undefined;
  const same = (a: string | undefined, b: string | undefined) => a?.toLowerCase() === b?.toLowerCase();
  return luts
    .filter((l) => same(l.fitted?.simulation, tag.simulation))
    .filter((l) => !l.fitted?.camera || !tag.camera || same(l.fitted.camera, tag.camera))
    .sort((a, b) => (a.fitted?.meanDeltaE ?? 0) - (b.fitted?.meanDeltaE ?? 0) || a.name.localeCompare(b.name))[0];
}

/**
 * Why a pair cannot be used, from its two tags: the RAW records a film simulation and the JPEG does not, so the JPEG
 * is not the camera's own (an edited export). Undefined when the pair looks fine (or neither file is tagged).
 */
export function pairProblem(raw: FilmTag | null | undefined, jpeg: FilmTag | null | undefined): string | undefined {
  if (raw && !jpeg) return 'The JPEG has no film simulation tag: an edited export?';
  return undefined;
}

/** The name a fit gets by default: the simulation tag the selected pairs share, else "Camera look". */
export function defaultFitName(simulations: readonly (string | null | undefined)[]): string {
  const tags = simulations.filter((s): s is string => !!s);
  if (tags.length === 0) return 'Camera look';
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Camera look';
}

/** The look preset saved with a fitted LUT is called after it: `Classic Chrome (fitted)`. */
export const fittedPresetName = (lutName: string): string => `${lutName} (fitted)`;
