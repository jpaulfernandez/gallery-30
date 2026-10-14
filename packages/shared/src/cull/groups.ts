/**
 * Cull groups (plan 39, CULL_PLAN 4.2 and 6): bursts and re-shot subjects, computed from the folder index (plan 38's
 * capture time, rig and perceptual hash) on the fly and never stored. Only the user's overrides are library data
 * (`photos[hash].cull.group`: `'solo'` detaches a frame, a shared ULID merges frames into one group).
 *
 * Pure: no editor import, so the publish CLI and tests can run it. Thresholds live here, so tuning never needs a
 * rescan.
 */

/** The stats `suggestedBest` ranks on (the index's `stats`, plan 38); extra fields are ignored. */
export interface GroupStats {
  sharpness: number;
  sharpnessMax: number;
  motion: number;
  clipHigh: number;
  clipLow: number;
}

/** One photo as grouping sees it: its id in the caller's list and the index fields of plan 38. */
export interface GroupEntry {
  /** The caller's photo id (a library key or a project asset id). */
  id: string;
  /** File name or relative path: the tie-break after `taken`, by the numeric collator. */
  name: string;
  /** Capture time, epoch ms. A photo without it is never grouped by the maths (a merge override still can). */
  taken?: number;
  make?: string;
  model?: string;
  lens?: string;
  /** Focal length, mm. */
  focal?: number;
  /** 16 hex chars, compared by Hamming distance. */
  phash?: string;
  stats?: GroupStats;
}

/** A manual override: `'solo'` keeps the photo out of every group; a ULID puts it in the group of that ULID. */
export type GroupOverride = 'solo' | string;

/** The grouping thresholds (CULL_PLAN 6). */
export interface GroupSettings {
  /** Longest gap between two frames of one burst, ms. */
  burstGap: number;
  /** Longest pause between two bursts of the same subject that merge (a re-shoot), ms. */
  reshootGap: number;
  /** Largest perceptual-hash distance between consecutive frames of one burst (of 64 bits). */
  burstHash: number;
  /** Largest smallest-pairwise hash distance between two bursts that merge as a re-shoot. */
  reshootHash: number;
  /** Largest relative focal length difference inside a group (0.05: 5 %). */
  focalTolerance: number;
}

export const DEFAULT_GROUP_SETTINGS: Readonly<GroupSettings> = {
  burstGap: 2000,
  reshootGap: 30_000,
  burstHash: 16,
  reshootHash: 4,
  focalTolerance: 0.05,
};

/** The Group menu's *Grouping* control: how the two gaps are scaled. */
export type GroupSpacing = 'tighter' | 'normal' | 'looser';

const SPACING_SCALE: Record<GroupSpacing, number> = { tighter: 0.5, normal: 1, looser: 2 };

/** `DEFAULT_GROUP_SETTINGS` with both gaps scaled for `spacing` (the hash distances stay). */
export function groupSettingsFor(spacing: GroupSpacing): GroupSettings {
  const scale = SPACING_SCALE[spacing];
  return {
    ...DEFAULT_GROUP_SETTINGS,
    burstGap: DEFAULT_GROUP_SETTINGS.burstGap * scale,
    reshootGap: DEFAULT_GROUP_SETTINGS.reshootGap * scale,
  };
}

/** One group: two or more frames in capture order and the suggested best of them. */
export interface PhotoGroup {
  /** The merge ULID for a group made by an override, else the id of its first frame. */
  id: string;
  /** Photo ids in capture order. */
  frames: string[];
  /** The suggested best frame (`suggestedBest`). */
  best: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Capture order: `taken`, then the name by the numeric collator; photos without `taken` last. */
function byCapture(a: GroupEntry, b: GroupEntry): number {
  const ta = a.taken ?? Number.POSITIVE_INFINITY;
  const tb = b.taken ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return collator.compare(a.name, b.name);
}

/** A 64-bit hash as two 32-bit halves, or null when it is not 16 hex chars. */
function parseHash(hex: string | undefined): [number, number] | null {
  if (!hex || !/^[0-9a-fA-F]{16}$/.test(hex)) return null;
  return [Number.parseInt(hex.slice(0, 8), 16), Number.parseInt(hex.slice(8), 16)];
}

function popcount(n: number): number {
  let v = n - ((n >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance of two parsed hashes. */
function hamming(a: [number, number], b: [number, number]): number {
  return popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);
}

/** An entry with its hash parsed once. */
interface Frame {
  entry: GroupEntry;
  hash: [number, number] | null;
}

/** Which camera and lens took the photo: frames of two rigs never share a group. */
const rigKey = (e: GroupEntry): string => `${e.make ?? ''}\n${e.model ?? ''}\n${e.lens ?? ''}`;

/** Same camera and lens, and focal lengths within the tolerance (both absent counts as the same). */
function sameRig(a: GroupEntry, b: GroupEntry, tolerance: number): boolean {
  if (a.make !== b.make || a.model !== b.model || a.lens !== b.lens) return false;
  if (a.focal === undefined || b.focal === undefined) return a.focal === b.focal;
  const larger = Math.max(Math.abs(a.focal), Math.abs(b.focal));
  return larger === 0 || Math.abs(a.focal - b.focal) <= tolerance * larger;
}

/** Smallest Hamming distance between any frame of `a` and any of `b` (Infinity when a hash is missing). */
function closest(a: Frame[], b: Frame[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const x of a) {
    if (!x.hash) continue;
    for (const y of b) {
      if (!y.hash) continue;
      const d = hamming(x.hash, y.hash);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/**
 * The groups of `entries` (CULL_PLAN 6):
 * 1. sort by `taken`, then name (photos without `taken` are not grouped by the maths);
 * 2. a frame joins its camera and lens's open burst when the focal length matches, the gap to the burst's last frame
 *    is at most `burstGap` and its hash is within `burstHash` of that frame's (each rig has its own open burst, so a
 *    second camera firing mid-burst does not break it);
 * 3. adjacent bursts of one rig merge when the pause between them is at most `reshootGap`, the rig matches and the
 *    closest pair of their hashes is within `reshootHash` (the same subject shot again);
 * 4. overrides: `'solo'` removes a frame; frames sharing a merge ULID form one group whatever the maths said;
 * 5. a group of one is not a group.
 * Groups come back in capture order of their first frame, frames in capture order, each with its suggested best.
 */
export function groupPhotos(
  entries: readonly GroupEntry[],
  overrides: ReadonlyMap<string, GroupOverride> = new Map(),
  settings: GroupSettings = DEFAULT_GROUP_SETTINGS,
): PhotoGroup[] {
  const timed = entries.filter((e) => e.taken !== undefined && Number.isFinite(e.taken)).sort(byCapture);

  // 2. Bursts. Each camera and lens keeps its own open burst, so a second camera firing in the middle of a burst
  // neither joins it nor breaks it (two cameras never share a group).
  const bursts: Frame[][] = [];
  const openByRig = new Map<string, Frame[]>();
  for (const entry of timed) {
    const frame: Frame = { entry, hash: parseHash(entry.phash) };
    const rig = rigKey(entry);
    const open = openByRig.get(rig);
    const last = open?.[open.length - 1];
    const joins =
      last !== undefined &&
      frame.hash !== null &&
      last.hash !== null &&
      (entry.taken as number) - (last.entry.taken as number) <= settings.burstGap &&
      sameRig(last.entry, entry, settings.focalTolerance) &&
      hamming(last.hash, frame.hash) <= settings.burstHash;
    if (open && joins) open.push(frame);
    else {
      const burst = [frame];
      openByRig.set(rig, burst);
      bursts.push(burst);
    }
  }

  // 3. Re-shoots, per rig: each burst is compared with the rig's burst before it (its frames, not the whole merged
  // run), so the cost stays linear in the bursts.
  const runs: Frame[][] = [];
  const lastByRig = new Map<string, { run: Frame[]; burst: Frame[] }>();
  for (const burst of bursts) {
    const head = burst[0] as Frame;
    const rig = rigKey(head.entry);
    const before = lastByRig.get(rig);
    const tail = before?.run[before.run.length - 1];
    const merges =
      before !== undefined &&
      tail !== undefined &&
      (head.entry.taken as number) - (tail.entry.taken as number) <= settings.reshootGap &&
      sameRig(tail.entry, head.entry, settings.focalTolerance) &&
      closest(before.burst, burst) <= settings.reshootHash;
    if (before && merges) {
      before.run.push(...burst);
      before.burst = burst;
    } else {
      const run = [...burst];
      runs.push(run);
      lastByRig.set(rig, { run, burst });
    }
  }

  // 4. Overrides.
  const merged = new Map<string, GroupEntry[]>();
  for (const entry of entries) {
    const override = overrides.get(entry.id);
    if (override === undefined || override === 'solo') continue;
    const list = merged.get(override);
    if (list) list.push(entry);
    else merged.set(override, [entry]);
  }
  const groups: { id: string; frames: GroupEntry[] }[] = [];
  for (const run of runs) {
    const frames = run.map((f) => f.entry).filter((e) => !overrides.has(e.id));
    const first = frames[0];
    if (first && frames.length > 1) groups.push({ id: first.id, frames });
  }
  for (const [id, frames] of merged) if (frames.length > 1) groups.push({ id, frames: frames.sort(byCapture) });

  // 5. Capture order of the groups' first frames; the suggested best of each.
  return groups
    .sort((a, b) => byCapture(a.frames[0] as GroupEntry, b.frames[0] as GroupEntry))
    .map(({ id, frames }) => ({ id, frames: frames.map((f) => f.id), best: suggestedBest(frames) }));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The suggested best of a group's frames (given in capture order): the highest score, ties to the earliest.
 *
 * ```
 * sharp  = min(1, sharpnessMax / best(sharpnessMax in group))
 * motion = (motion > 0.6 && sharpness < 0.7 * best(sharpness)) ? 0.5 : 1
 * clip   = 1 - 0.5 * clamp((clipHigh - 0.02) / 0.08) - 0.25 * clamp((clipLow - 0.05) / 0.2)
 * score  = sharp * motion * clip
 * ```
 *
 * A frame without stats scores 0, so it is the best only when no frame has stats (the first then). Empty: ''.
 */
export function suggestedBest(frames: readonly GroupEntry[]): string {
  let maxSharpness = 0;
  let maxSharpnessMax = 0;
  for (const { stats } of frames) {
    if (!stats) continue;
    maxSharpness = Math.max(maxSharpness, stats.sharpness);
    maxSharpnessMax = Math.max(maxSharpnessMax, stats.sharpnessMax);
  }
  let best = frames[0]?.id ?? '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const { id, stats } of frames) {
    let score = 0;
    if (stats) {
      const sharp = maxSharpnessMax > 0 ? Math.min(1, stats.sharpnessMax / maxSharpnessMax) : 1;
      const motion = stats.motion > 0.6 && stats.sharpness < 0.7 * maxSharpness ? 0.5 : 1;
      const clip = 1 - 0.5 * clamp01((stats.clipHigh - 0.02) / 0.08) - 0.25 * clamp01((stats.clipLow - 0.05) / 0.2);
      score = sharp * motion * clip;
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}
